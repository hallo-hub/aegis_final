import { EmbedBuilder, Colors, TextChannel } from "discord.js";
import { SecurityLogType, Prisma } from "@prisma/client";
import { SecurityClient } from "../../structures/SecurityClient";
import logger from "../../utils/logger";

export interface LogEntryInput {
  guildId: string;
  type: SecurityLogType;
  actorId?: string | null;
  targetId?: string | null;
  data?: Record<string, unknown>;
  /** Falls gesetzt, wird ein Embed direkt in diesen Channel statt in den Standard-Log-Channel gesendet. */
  overrideChannelId?: string;
  embed?: EmbedBuilder;
}

const COLOR_BY_TYPE: Record<SecurityLogType, number> = {
  NUKE_DETECTED: Colors.DarkRed,
  AUTOMOD_ACTION: Colors.Orange,
  LOCKDOWN_ACTIVATED: Colors.Red,
  LOCKDOWN_DEACTIVATED: Colors.Green,
  MEMBER_BANNED: Colors.DarkRed,
  MEMBER_KICKED: Colors.DarkOrange,
  MEMBER_TIMEOUT: Colors.Yellow,
  MESSAGE_DELETED: Colors.Greyple,
};

/**
 * Zentrales Security-Logging: Jedes sicherheitsrelevante Ereignis wird
 * (a) transaktionssicher in der DB persistiert (Audit-Trail, überlebt
 *     Neustarts und Discord-Message-Löschungen) und
 * (b) - sofern vorhanden - als Embed in den konfigurierten Log-Channel
 *     der jeweiligen Guild gepostet.
 *
 * DB-Schreibfehler dürfen niemals den auslösenden Vorgang (z.B. eine
 * Anti-Nuke-Gegenmaßnahme) verhindern - daher wird hier bewusst nie
 * geworfen, sondern nur geloggt.
 */
export class SecurityLogger {
  public constructor(private readonly client: SecurityClient) {}

  public async log(entry: LogEntryInput): Promise<void> {
    await this.persist(entry);
    await this.postToChannel(entry);
  }

  /**
   * Liefert die letzten Log-Einträge einer Guild (neueste zuerst), für das
   * `/dashboard` Logs-Panel. Rein lesend, kein Cache nötig - Logs müssen
   * immer aktuell sein.
   */
  public async getRecent(guildId: string, limit = 5, offset = 0) {
    return this.client.prisma.securityLog.findMany({
      where: { guildId },
      orderBy: { createdAt: "desc" },
      take: limit,
      skip: offset,
    });
  }

  public async countTotal(guildId: string): Promise<number> {
    return this.client.prisma.securityLog.count({ where: { guildId } });
  }

  public titleForType(type: SecurityLogType): string {
    return this.titleFor(type);
  }

  private async persist(entry: LogEntryInput): Promise<void> {
    try {
      await this.client.prisma.securityLog.create({
        data: {
          guildId: entry.guildId,
          type: entry.type,
          actorId: entry.actorId ?? null,
          targetId: entry.targetId ?? null,
          data: (entry.data ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      logger.error({ err, entry }, "Konnte SecurityLog nicht persistieren");
    }
  }

  private async postToChannel(entry: LogEntryInput): Promise<void> {
    try {
      const channelId =
        entry.overrideChannelId ?? (await this.client.guildConfig.getLogChannelId(entry.guildId));
      if (!channelId) return;

      const channel = await this.client.channels.fetch(channelId).catch(() => null);
      if (!channel || !(channel instanceof TextChannel)) return;

      const embed =
        entry.embed ??
        new EmbedBuilder()
          .setTitle(this.titleFor(entry.type))
          .setColor(COLOR_BY_TYPE[entry.type])
          .setTimestamp(new Date())
          .setDescription(this.describe(entry));

      await channel.send({ embeds: [embed] });
    } catch (err) {
      logger.error({ err, entry }, "Konnte Security-Log nicht in Channel posten");
    }
  }

  private titleFor(type: SecurityLogType): string {
    const map: Record<SecurityLogType, string> = {
      NUKE_DETECTED: "🚨 Nuke-Versuch erkannt",
      AUTOMOD_ACTION: "🛡️ AutoMod-Aktion",
      LOCKDOWN_ACTIVATED: "🔒 Lockdown aktiviert",
      LOCKDOWN_DEACTIVATED: "🔓 Lockdown aufgehoben",
      MEMBER_BANNED: "🔨 Mitglied gebannt",
      MEMBER_KICKED: "👢 Mitglied gekickt",
      MEMBER_TIMEOUT: "⏱️ Mitglied stummgeschaltet",
      MESSAGE_DELETED: "🗑️ Nachricht gelöscht",
    };
    return map[type];
  }

  private describe(entry: LogEntryInput): string {
    const lines: string[] = [];
    if (entry.actorId) lines.push(`**Nutzer:** <@${entry.actorId}> (\`${entry.actorId}\`)`);
    if (entry.targetId) lines.push(`**Ziel:** <@${entry.targetId}> (\`${entry.targetId}\`)`);
    if (entry.data) {
      for (const [key, value] of Object.entries(entry.data)) {
        lines.push(`**${key}:** ${String(value)}`);
      }
    }
    return lines.join("\n") || "Keine weiteren Details.";
  }
}
