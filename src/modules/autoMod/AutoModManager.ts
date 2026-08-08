import { Message, EmbedBuilder, Colors, GuildMember } from "discord.js";
import { AutoModActionType, AutoModRule, Prisma } from "@prisma/client";
import { SecurityClient } from "../../structures/SecurityClient";
import { SlidingWindowTracker } from "./MessageWindowTracker";
import { runRuleCheck } from "./ruleCheckers";
import logger from "../../utils/logger";

interface EscalationStep {
  violationNumber: number;
  action: AutoModActionType;
  durationSeconds?: number;
}

const DEFAULT_ESCALATION: EscalationStep[] = [
  { violationNumber: 1, action: "DELETE_MESSAGE" },
  { violationNumber: 2, action: "WARN" },
  { violationNumber: 3, action: "TIMEOUT", durationSeconds: 600 },
  { violationNumber: 5, action: "TIMEOUT", durationSeconds: 3600 },
  { violationNumber: 7, action: "KICK" },
  { violationNumber: 10, action: "BAN" },
];

const MAX_DISCORD_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000; // Discord-Limit: 28 Tage

/**
 * AutoMod-Orchestrierung. Ablauf pro Nachricht:
 *  1. Ignoriere Bots, DMs, Nachrichten ohne Guild.
 *  2. Prüfe AutoMod-Whitelist (gilt NUR hier, nie bei Anti-Nuke).
 *  3. Für jede aktivierte Regel: Exceptions (Rollen/Channels) prüfen, dann
 *     die eigentliche Erkennung (ruleCheckers) ausführen.
 *  4. Bei Verstoß: Nachricht löschen, Verstoßzähler transaktionssicher
 *     erhöhen, passende Eskalationsstufe ermitteln, Strafe ausführen, loggen.
 *
 * MULTI-TENANCY: Alle Konfiguration kommt aus GuildConfigService (bereits
 * strikt pro guildId partitioniert); der In-Memory-Tracker ist ebenfalls
 * durchgehend mit guildId als Teil des Schlüssels aufgebaut.
 */
export class AutoModManager {
  private tracker = new SlidingWindowTracker();

  public constructor(private readonly client: SecurityClient) {
    this.client.on("messageCreate", (message) => {
      this.handleMessage(message).catch((err) =>
        logger.error({ err }, "Fehler in AutoModManager#handleMessage")
      );
    });

    // Periodisches Aufräumen alter Sliding-Window-Einträge, damit der
    // Speicherverbrauch auf einem Bot mit vielen aktiven Guilds nicht
    // unbegrenzt wächst.
    setInterval(() => this.tracker.prune(10 * 60 * 1000), 5 * 60 * 1000).unref();
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!message.guild || !message.guildId) return;
    if (!message.member) return;

    const roleIds = message.member.roles.cache.map((r) => r.id);
    const whitelisted = await this.client.guildConfig.isAutoModWhitelisted(
      message.guildId,
      message.author.id,
      roleIds
    );
    if (whitelisted) return;

    const rules = await this.client.guildConfig.getAutoModRules(message.guildId);
    const enabledRules = rules.filter((r) => r.enabled);

    for (const rule of enabledRules) {
      if (rule.exemptChannelIds.includes(message.channelId)) continue;
      if (rule.exemptRoleIds.some((id) => roleIds.includes(id))) continue;

      const result = runRuleCheck({ message, rule, tracker: this.tracker });
      if (result.violated) {
        await this.handleViolation(message, rule, result.reason);
        // Nur die erste zutreffende Regel pro Nachricht anwenden, um
        // Mehrfachbestrafung für ein und dieselbe Nachricht zu vermeiden.
        break;
      }
    }
  }

  private async handleViolation(message: Message, rule: AutoModRule, reason: string): Promise<void> {
    const guildId = message.guildId!;
    const userId = message.author.id;

    // Nachricht löschen (best effort - kann bereits gelöscht/fehlend sein)
    await message.delete().catch(() => undefined);

    const violationCount = await this.incrementViolationCount(guildId, userId, rule.type);
    const step = this.resolveEscalationStep(rule, violationCount);

    const member = message.member as GuildMember;
    const executed = await this.executeAction(member, step, reason);

    const embed = new EmbedBuilder()
      .setTitle("🛡️ AutoMod-Aktion")
      .setColor(Colors.Orange)
      .setTimestamp(new Date())
      .addFields(
        { name: "Nutzer", value: `<@${userId}> (\`${userId}\`)`, inline: true },
        { name: "Regel", value: rule.type, inline: true },
        { name: "Verstoß Nr.", value: String(violationCount), inline: true },
        { name: "Grund", value: reason, inline: false },
        { name: "Kanal", value: `<#${message.channelId}>`, inline: true },
        { name: "Aktion", value: executed, inline: true }
      );

    await this.client.securityLog.log({
      guildId,
      type: "AUTOMOD_ACTION",
      actorId: userId,
      data: { Regel: rule.type, Grund: reason, Aktion: executed, "Verstoß Nr.": violationCount },
      embed,
    });
  }

  /**
   * Transaktionssicheres Erhöhen des Verstoßzählers. `upsert` mit
   * atomarem `increment` verhindert Race Conditions, wenn ein Nutzer sehr
   * schnell hintereinander mehrere Verstöße auslöst (z.B. Spam-Burst).
   */
  private async incrementViolationCount(
    guildId: string,
    userId: string,
    ruleType: AutoModRule["type"]
  ): Promise<number> {
    try {
      const result = await this.client.prisma.autoModViolation.upsert({
        where: { guildId_userId_ruleType: { guildId, userId, ruleType } },
        update: { count: { increment: 1 } },
        create: { guildId, userId, ruleType, count: 1 },
      });
      return result.count;
    } catch (err) {
      logger.error({ err, guildId, userId, ruleType }, "Konnte Verstoßzähler nicht erhöhen");
      return 1; // Fail-safe: mildeste Eskalationsstufe annehmen statt hart zu scheitern
    }
  }

  private resolveEscalationStep(rule: AutoModRule, violationCount: number): EscalationStep {
    const custom = this.parseEscalation(rule.escalation);
    const steps = custom.length > 0 ? custom : DEFAULT_ESCALATION;
    const sorted = [...steps].sort((a, b) => a.violationNumber - b.violationNumber);

    let applicable = sorted[0];
    for (const step of sorted) {
      if (violationCount >= step.violationNumber) applicable = step;
    }
    return applicable;
  }

  private parseEscalation(raw: Prisma.JsonValue): EscalationStep[] {
    if (!Array.isArray(raw)) return [];
    const steps: EscalationStep[] = [];
    for (const entry of raw) {
      if (
        entry &&
        typeof entry === "object" &&
        "violationNumber" in entry &&
        "action" in entry
      ) {
        const e = entry as Record<string, unknown>;
        steps.push({
          violationNumber: Number(e.violationNumber),
          action: e.action as AutoModActionType,
          durationSeconds: e.durationSeconds ? Number(e.durationSeconds) : undefined,
        });
      }
    }
    return steps;
  }

  private async executeAction(member: GuildMember, step: EscalationStep, reason: string): Promise<string> {
    const fullReason = `AutoMod: ${reason}`;
    try {
      switch (step.action) {
        case "DELETE_MESSAGE":
          return "Nachricht gelöscht";

        case "WARN":
          await member.send({ content: `⚠️ Verwarnung auf **${member.guild.name}**: ${reason}` }).catch(() => undefined);
          return "Verwarnung gesendet";

        case "TIMEOUT": {
          const durationMs = Math.min((step.durationSeconds ?? 600) * 1000, MAX_DISCORD_TIMEOUT_MS);
          await member.timeout(durationMs, fullReason);
          return `Timeout (${Math.round(durationMs / 1000)}s)`;
        }

        case "PERMANENT_TIMEOUT":
          // Discord erlaubt technisch max. 28 Tage - "permanent" wird daher
          // als maximaler Timeout umgesetzt und muss danach ggf. erneuert
          // werden, bis ein Moderator ihn manuell entfernt
          // (siehe /automod remove-timeout Command).
          await member.timeout(MAX_DISCORD_TIMEOUT_MS, fullReason);
          return "Permanenter Timeout gesetzt (max. Discord-Limit, gilt bis manuelle Entfernung)";

        case "KICK":
          if (member.kickable) {
            await member.kick(fullReason);
            return "Kick";
          }
          return "Kick fehlgeschlagen (nicht kickbar)";

        case "BAN":
          await member.ban({ reason: fullReason });
          return "Bann";

        default:
          return "Keine Aktion";
      }
    } catch (err) {
      logger.error({ err, action: step.action, userId: member.id }, "AutoMod-Aktion fehlgeschlagen");
      return `Fehlgeschlagen (${step.action})`;
    } finally {
      await this.client.prisma.punishmentLog
        .create({
          data: {
            guildId: member.guild.id,
            userId: member.id,
            moderatorId: this.client.user?.id ?? "SYSTEM",
            action: step.action,
            reason: fullReason,
            source: "AUTOMOD",
            durationSeconds: step.durationSeconds ?? null,
          },
        })
        .catch((err) => logger.error({ err }, "Konnte PunishmentLog nicht schreiben"));
    }
  }
}
