import { AuditLogEvent, EmbedBuilder, Colors, GuildAuditLogsEntry, Guild } from "discord.js";
import { NukeActionType, PunishmentAction } from "@prisma/client";
import { SecurityClient } from "../../structures/SecurityClient";
import logger from "../../utils/logger";

/**
 * Ordnet Discord Audit-Log-Aktionen unseren internen NukeActionType-Kategorien zu.
 * Alles, was hier nicht gelistet ist, wird vom Anti-Nuke ignoriert.
 */
const AUDIT_ACTION_MAP: Partial<Record<AuditLogEvent, NukeActionType>> = {
  [AuditLogEvent.ChannelDelete]: NukeActionType.CHANNEL_DELETE,
  [AuditLogEvent.ChannelCreate]: NukeActionType.CHANNEL_CREATE,
  [AuditLogEvent.ChannelUpdate]: NukeActionType.CHANNEL_UPDATE,
  [AuditLogEvent.ChannelOverwriteCreate]: NukeActionType.PERMISSION_UPDATE,
  [AuditLogEvent.ChannelOverwriteUpdate]: NukeActionType.PERMISSION_UPDATE,
  [AuditLogEvent.ChannelOverwriteDelete]: NukeActionType.PERMISSION_UPDATE,
  [AuditLogEvent.RoleCreate]: NukeActionType.ROLE_CREATE,
  [AuditLogEvent.RoleUpdate]: NukeActionType.ROLE_UPDATE,
  [AuditLogEvent.RoleDelete]: NukeActionType.ROLE_DELETE,
  [AuditLogEvent.WebhookCreate]: NukeActionType.WEBHOOK_CREATE,
  [AuditLogEvent.EmojiDelete]: NukeActionType.EMOJI_DELETE,
  [AuditLogEvent.StickerDelete]: NukeActionType.STICKER_DELETE,
  [AuditLogEvent.MemberBanAdd]: NukeActionType.MEMBER_BAN,
  [AuditLogEvent.MemberKick]: NukeActionType.MEMBER_KICK,
};

interface ActionRecord {
  timestamps: number[];
}

type UserActionMap = Map<NukeActionType, ActionRecord>;

/**
 * Anti-Nuke Erkennung auf Basis des `guildAuditLogEntryCreate`-Events.
 *
 * Warum dieses Event statt "reaktivem" Nachfragen der Audit-Logs bei jedem
 * channelDelete/roleDelete/... Event?
 *  - Es liefert den Executor DIREKT und zuverlässig (keine Race-Conditions
 *    durch verzögerte Audit-Log-Einträge, kein zusätzlicher API-Call, kein
 *    Rate-Limit-Risiko bei Burst-Aktionen).
 *  - Ein einzelner Handler deckt alle Aktionstypen ab.
 *
 * MULTI-TENANCY: Der komplette State (`windows`) ist als
 * Map<guildId, Map<userId, Map<actionType, ActionRecord>>> aufgebaut - jede
 * Guild hat ihren eigenen, komplett isolierten Zähler-Baum.
 *
 * RACE CONDITIONS: `punishing` ist ein Lock-Set (`guildId:userId`), das
 * verhindert, dass zwei praktisch gleichzeitig eintreffende Audit-Log-
 * Einträge (z.B. 5 Channel-Löschungen innerhalb von Millisekunden) zu
 * doppelten Kicks/Bans bzw. doppelten Alarmen führen.
 */
export class AntiNukeManager {
  private windows = new Map<string, Map<string, UserActionMap>>();
  private punishing = new Set<string>();

  public constructor(private readonly client: SecurityClient) {
    this.client.on("guildAuditLogEntryCreate", (entry, guild) => {
      this.handleAuditLogEntry(entry, guild).catch((err) =>
        logger.error({ err }, "Fehler in AntiNukeManager#handleAuditLogEntry")
      );
    });
  }

  private async handleAuditLogEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    const actionType = AUDIT_ACTION_MAP[entry.action];
    if (!actionType) return;

    const actorId = entry.executorId;
    if (!actorId) return;

    // Der Bot selbst (z.B. eigene Kicks/Bans als Gegenmaßnahme) darf sich
    // niemals selbst triggern.
    if (actorId === this.client.user?.id) return;

    await this.recordAction(guild, actorId, actionType);
  }

  private async recordAction(guild: Guild, actorId: string, actionType: NukeActionType): Promise<void> {
    const guildId = guild.id;

    const config = await this.client.guildConfig.getAntiNukeConfig(guildId);
    if (!config.enabled) return;

    const threshold = await this.client.guildConfig.getAntiNukeThreshold(guildId, actionType);
    if (!threshold.enabled) return;

    let guildWindows = this.windows.get(guildId);
    if (!guildWindows) {
      guildWindows = new Map();
      this.windows.set(guildId, guildWindows);
    }

    let userActions = guildWindows.get(actorId);
    if (!userActions) {
      userActions = new Map();
      guildWindows.set(actorId, userActions);
    }

    let record = userActions.get(actionType);
    if (!record) {
      record = { timestamps: [] };
      userActions.set(actionType, record);
    }

    const now = Date.now();
    const windowMs = threshold.windowSeconds * 1000;

    record.timestamps.push(now);
    record.timestamps = record.timestamps.filter((t) => now - t <= windowMs);

    if (record.timestamps.length >= threshold.maxCount) {
      const count = record.timestamps.length;
      // Zähler sofort zurücksetzen, damit dieselbe Aktion nicht erneut
      // (mit denselben Timestamps) sofort wieder auslöst.
      record.timestamps = [];

      const punishment = threshold.punishment ?? config.defaultPunishment;
      await this.triggerNuke(guild, actorId, actionType, count, punishment, config.alertChannelId);
    }
  }

  /**
   * Führt bei einem bestätigten Nuke ZUERST die Gegenmaßnahme aus und
   * DANACH erst den Alarm. Es gibt bewusst KEINE Whitelist-Prüfung hier -
   * Anti-Nuke ignoriert Whitelists vollständig, ausnahmslos.
   */
  private async triggerNuke(
    guild: Guild,
    actorId: string,
    actionType: NukeActionType,
    actionCount: number,
    punishment: PunishmentAction,
    alertChannelId: string | null
  ): Promise<void> {
    const lockKey = `${guild.id}:${actorId}`;
    if (this.punishing.has(lockKey)) {
      // Es läuft bereits eine Bestrafung für diesen Nutzer in dieser Guild -
      // keine doppelte Aktion, kein doppelter Alarm.
      return;
    }
    this.punishing.add(lockKey);

    try {
      const executedPunishment = await this.executePunishment(guild, actorId, punishment, actionType);

      const embed = new EmbedBuilder()
        .setTitle("🚨 Nuke-Versuch erkannt")
        .setColor(Colors.DarkRed)
        .setTimestamp(new Date())
        .addFields(
          { name: "Täter", value: `<@${actorId}>`, inline: true },
          { name: "ID", value: `\`${actorId}\``, inline: true },
          { name: "Zeitpunkt", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
          { name: "Erkannte Aktion", value: actionType, inline: true },
          { name: "Anzahl der Aktionen", value: String(actionCount), inline: true },
          { name: "Gegenmaßnahme", value: executedPunishment, inline: false }
        );

      await this.client.securityLog.log({
        guildId: guild.id,
        type: "NUKE_DETECTED",
        actorId,
        data: {
          Aktionstyp: actionType,
          Anzahl: actionCount,
          Gegenmaßnahme: executedPunishment,
        },
        overrideChannelId: alertChannelId ?? undefined,
        embed,
      });
    } finally {
      // Lock für eine Cooldown-Phase halten, damit unmittelbar folgende
      // Audit-Log-Einträge (z.B. während der Kick/Ban-API-Call noch läuft)
      // keinen zweiten Trigger erzeugen.
      setTimeout(() => this.punishing.delete(lockKey), 15_000);
    }
  }

  private async executePunishment(
    guild: Guild,
    actorId: string,
    punishment: PunishmentAction,
    actionType: NukeActionType
  ): Promise<string> {
    const reason = `Anti-Nuke: Massenhafte Aktion (${actionType}) erkannt`;

    try {
      if (punishment === "BAN") {
        await guild.members.ban(actorId, { reason, deleteMessageSeconds: 0 });
        await this.client.prisma.punishmentLog.create({
          data: { guildId: guild.id, userId: actorId, moderatorId: this.client.user?.id ?? "SYSTEM", action: "BAN", reason, source: "ANTI_NUKE" },
        }).catch((err) => logger.error({ err }, "Konnte PunishmentLog nicht schreiben"));
        return "Bann";
      }

      if (punishment === "KICK") {
        const member = await guild.members.fetch(actorId).catch(() => null);
        if (member && member.kickable) {
          await member.kick(reason);
          await this.client.prisma.punishmentLog.create({
            data: { guildId: guild.id, userId: actorId, moderatorId: this.client.user?.id ?? "SYSTEM", action: "KICK", reason, source: "ANTI_NUKE" },
          }).catch((err) => logger.error({ err }, "Konnte PunishmentLog nicht schreiben"));
          return "Kick";
        }
        // Nicht kickbar (z.B. höhere Rolle als der Bot) -> als Fallback bannen wir NICHT
        // automatisch (das wäre ein impliziter Eskalationsschritt ohne Konfiguration),
        // sondern melden es klar im Alarm.
        return "Kick fehlgeschlagen (Mitglied nicht kickbar / nicht mehr im Server)";
      }

      return "Keine Aktion (konfiguriert)";
    } catch (err) {
      logger.error({ err, actorId, guildId: guild.id }, "Anti-Nuke Gegenmaßnahme fehlgeschlagen");
      return `Fehlgeschlagen (${punishment})`;
    }
  }
}
