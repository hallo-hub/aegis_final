import {
  PrismaClient,
  AntiNukeConfig,
  AntiNukeThreshold,
  AutoModRule,
  AutoModWhitelist,
  NukeActionType,
  PunishmentAction,
} from "@prisma/client";
import logger from "../../utils/logger";

/**
 * Default-Schwellenwerte für Anti-Nuke, falls eine Guild noch keine eigene
 * Konfiguration angelegt hat.
 *
 * Verbindlicher Standard: 3 Aktionen in 5 Sekunden für ALLES, mit genau EINER
 * Ausnahme: ROLE_UPDATE (Rollen bearbeiten/umbenennen) erlaubt 5 Aktionen in
 * 5 Sekunden, da einzelne Rollen-Umbenennungen im normalen Admin-Alltag
 * (z.B. Sortierung/Farbe/Name mehrerer Rollen nacheinander pflegen) deutlich
 * häufiger vorkommen als z.B. Massen-Löschungen.
 */
export const DEFAULT_ANTI_NUKE_THRESHOLDS: Record<
  NukeActionType,
  { maxCount: number; windowSeconds: number }
> = {
  CHANNEL_DELETE: { maxCount: 3, windowSeconds: 5 },
  CHANNEL_CREATE: { maxCount: 3, windowSeconds: 5 },
  ROLE_DELETE: { maxCount: 3, windowSeconds: 5 },
  ROLE_CREATE: { maxCount: 3, windowSeconds: 5 },
  ROLE_UPDATE: { maxCount: 5, windowSeconds: 5 }, // Ausnahme lt. Vorgabe
  CHANNEL_UPDATE: { maxCount: 3, windowSeconds: 5 },
  PERMISSION_UPDATE: { maxCount: 3, windowSeconds: 5 },
  WEBHOOK_CREATE: { maxCount: 3, windowSeconds: 5 },
  EMOJI_DELETE: { maxCount: 3, windowSeconds: 5 },
  STICKER_DELETE: { maxCount: 3, windowSeconds: 5 },
  MEMBER_BAN: { maxCount: 3, windowSeconds: 5 },
  MEMBER_KICK: { maxCount: 3, windowSeconds: 5 },
};

interface CachedGuildData {
  antiNukeConfig: AntiNukeConfig | null;
  antiNukeThresholds: AntiNukeThreshold[];
  autoModRules: AutoModRule[];
  whitelist: AutoModWhitelist[];
  adminRoleIds: string[];
  logChannelId: string | null;
  incidentCategoryId: string | null;
  fetchedAt: number;
}

/**
 * Default-Werte für AutoMod-Regeln, mit denen eine neue Guild sofort einen
 * sinnvollen Grundschutz hat, statt dass AutoMod bis zur manuellen
 * Konfiguration komplett wirkungslos bleibt.
 */
const DEFAULT_AUTOMOD_RULES: { type: AutoModRule["type"]; maxCount?: number; windowSeconds?: number; maxPercentage?: number }[] = [
  { type: "SPAM", maxCount: 5, windowSeconds: 8 },
  { type: "DUPLICATE_SPAM", maxCount: 3, windowSeconds: 30 },
  { type: "CAPS_SPAM", maxPercentage: 70 },
  { type: "EMOJI_SPAM", maxCount: 10 },
  { type: "MENTION_SPAM", maxCount: 5 },
  { type: "INVITE_LINKS" },
  { type: "SCAM_LINKS" },
  { type: "ADVERTISING" },
  { type: "NSFW" },
  { type: "INSULTS" },
  { type: "DISCRIMINATION" },
  { type: "PROFANITY" },
  { type: "UNAUTHORIZED_LINKS" },
  { type: "TOKEN_LEAK" },
];

const CACHE_TTL_MS = 60_000; // 60s - kurz genug um Config-Änderungen zeitnah zu übernehmen,
// lang genug um bei Bots mit vielen Guilds/Events nicht ständig die DB zu treffen.

/**
 * Alle Lese-/Schreibzugriffe auf guild-spezifische Konfiguration laufen über
 * diesen Service. Er cached pro Guild, damit z.B. der AutoMod bei jeder
 * einzelnen Nachricht NICHT jedes Mal die Datenbank anfragen muss.
 *
 * Wichtig für Multi-Tenancy: Der Cache ist strikt per guildId partitioniert
 * (Map<guildId, CachedGuildData>) - es gibt keinerlei globalen/geteilten State.
 */
export class GuildConfigService {
  private cache = new Map<string, CachedGuildData>();

  public constructor(private readonly prisma: PrismaClient) {}

  public invalidate(guildId: string): void {
    this.cache.delete(guildId);
  }

  /**
   * Stellt sicher, dass für eine Guild ein GuildConfig-Datensatz existiert.
   * Beim allerersten Anlegen (neuer Server) werden zusätzlich sinnvolle
   * AutoMod-Default-Regeln gesät, damit der Schutz sofort aktiv ist statt
   * bis zur manuellen Konfiguration wirkungslos zu bleiben.
   */
  public async ensureGuild(guildId: string): Promise<void> {
    const existing = await this.prisma.guildConfig.findUnique({ where: { guildId }, select: { guildId: true } });
    if (existing) return;

    await this.prisma.$transaction([
      this.prisma.guildConfig.create({ data: { guildId } }),
      this.prisma.autoModRule.createMany({
        data: DEFAULT_AUTOMOD_RULES.map((r) => ({ guildId, enabled: true, ...r })),
        skipDuplicates: true,
      }),
    ]);
  }

  private async loadGuildData(guildId: string): Promise<CachedGuildData> {
    await this.ensureGuild(guildId);

    const [guildConfig, antiNukeConfig, antiNukeThresholds, autoModRules, whitelist, adminRoles] =
      await this.prisma.$transaction([
        this.prisma.guildConfig.findUniqueOrThrow({ where: { guildId } }),
        this.prisma.antiNukeConfig.findUnique({ where: { guildId } }),
        this.prisma.antiNukeThreshold.findMany({ where: { guildId } }),
        this.prisma.autoModRule.findMany({ where: { guildId } }),
        this.prisma.autoModWhitelist.findMany({ where: { guildId } }),
        this.prisma.guildAdminRole.findMany({ where: { guildId } }),
      ]);

    const data: CachedGuildData = {
      antiNukeConfig,
      antiNukeThresholds,
      autoModRules,
      whitelist,
      adminRoleIds: adminRoles.map((r) => r.roleId),
      logChannelId: guildConfig.logChannelId,
      incidentCategoryId: guildConfig.incidentCategoryId,
      fetchedAt: Date.now(),
    };

    this.cache.set(guildId, data);
    return data;
  }

  private async getGuildData(guildId: string): Promise<CachedGuildData> {
    const cached = this.cache.get(guildId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached;
    }
    try {
      return await this.loadGuildData(guildId);
    } catch (err) {
      logger.error({ err, guildId }, "Fehler beim Laden der Guild-Konfiguration");
      // Fail-safe: falls DB kurzzeitig nicht erreichbar ist, lieber alte
      // (potenziell leicht veraltete) Daten weiterverwenden als komplett
      // auszufallen. Existiert kein Cache, geben wir sichere Defaults zurück.
      if (cached) return cached;
      return {
        antiNukeConfig: null,
        antiNukeThresholds: [],
        autoModRules: [],
        whitelist: [],
        adminRoleIds: [],
        logChannelId: null,
        incidentCategoryId: null,
        fetchedAt: Date.now(),
      };
    }
  }

  public async getLogChannelId(guildId: string): Promise<string | null> {
    return (await this.getGuildData(guildId)).logChannelId;
  }

  public async getIncidentCategoryId(guildId: string): Promise<string | null> {
    return (await this.getGuildData(guildId)).incidentCategoryId;
  }

  public async getAntiNukeConfig(guildId: string): Promise<{
    enabled: boolean;
    alertChannelId: string | null;
    defaultPunishment: PunishmentAction;
  }> {
    const data = await this.getGuildData(guildId);
    return {
      enabled: data.antiNukeConfig?.enabled ?? true,
      alertChannelId: data.antiNukeConfig?.alertChannelId ?? data.logChannelId,
      defaultPunishment: data.antiNukeConfig?.defaultPunishment ?? "KICK",
    };
  }

  public async getAntiNukeThreshold(
    guildId: string,
    actionType: NukeActionType
  ): Promise<{ enabled: boolean; maxCount: number; windowSeconds: number; punishment: PunishmentAction | null }> {
    const data = await this.getGuildData(guildId);
    const custom = data.antiNukeThresholds.find((t) => t.actionType === actionType);
    if (custom) {
      return {
        enabled: custom.enabled,
        maxCount: custom.maxCount,
        windowSeconds: custom.windowSeconds,
        punishment: custom.punishment,
      };
    }
    const fallback = DEFAULT_ANTI_NUKE_THRESHOLDS[actionType];
    return { enabled: true, maxCount: fallback.maxCount, windowSeconds: fallback.windowSeconds, punishment: null };
  }

  public async getAutoModRules(guildId: string): Promise<AutoModRule[]> {
    return (await this.getGuildData(guildId)).autoModRules;
  }

  public async getAutoModRule(guildId: string, type: AutoModRule["type"]): Promise<AutoModRule | null> {
    const data = await this.getGuildData(guildId);
    return data.autoModRules.find((r) => r.type === type) ?? null;
  }

  public async isAutoModWhitelisted(
    guildId: string,
    userId: string,
    roleIds: string[]
  ): Promise<boolean> {
    const data = await this.getGuildData(guildId);
    if (data.whitelist.length === 0) return false;
    return data.whitelist.some(
      (w) =>
        (w.targetType === "USER" && w.targetId === userId) ||
        (w.targetType === "ROLE" && roleIds.includes(w.targetId))
    );
  }

  public async setLogChannel(guildId: string, channelId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.guildConfig.update({
      where: { guildId },
      data: { logChannelId: channelId },
    });
    this.invalidate(guildId);
  }

  public async setIncidentCategory(guildId: string, categoryId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.guildConfig.update({
      where: { guildId },
      data: { incidentCategoryId: categoryId },
    });
    this.invalidate(guildId);
  }

  public async setAntiNukeThreshold(
    guildId: string,
    actionType: NukeActionType,
    input: Partial<{ enabled: boolean; maxCount: number; windowSeconds: number; punishment: PunishmentAction | null }>
  ): Promise<void> {
    await this.ensureGuild(guildId);
    const defaults = DEFAULT_ANTI_NUKE_THRESHOLDS[actionType];
    await this.prisma.antiNukeThreshold.upsert({
      where: { guildId_actionType: { guildId, actionType } },
      update: input,
      create: {
        guildId,
        actionType,
        enabled: input.enabled ?? true,
        maxCount: input.maxCount ?? defaults.maxCount,
        windowSeconds: input.windowSeconds ?? defaults.windowSeconds,
        punishment: input.punishment ?? null,
      },
    });
    this.invalidate(guildId);
  }

  /**
   * Setzt einen zuvor individuell gesetzten Schwellenwert wieder auf den
   * Standard zurück (löscht die Override-Zeile in der DB).
   */
  public async resetAntiNukeThreshold(guildId: string, actionType: NukeActionType): Promise<void> {
    await this.prisma.antiNukeThreshold
      .delete({ where: { guildId_actionType: { guildId, actionType } } })
      .catch(() => undefined); // idempotent
    this.invalidate(guildId);
  }

  /**
   * Liefert für JEDEN Aktionstyp den tatsächlich aktiv genutzten (effektiven)
   * Schwellenwert - egal ob custom oder Default. Dient dem
   * `/antinuke thresholds`-Command, damit Admins verifizieren können, was der
   * Bot *wirklich* verwendet, statt sich auf die eigene Erinnerung an frühere
   * `/antinuke threshold`-Aufrufe verlassen zu müssen.
   */
  public async getAllEffectiveAntiNukeThresholds(
    guildId: string
  ): Promise<
    Array<{
      actionType: NukeActionType;
      enabled: boolean;
      maxCount: number;
      windowSeconds: number;
      punishment: PunishmentAction | null;
      isCustom: boolean;
    }>
  > {
    const data = await this.getGuildData(guildId);
    return (Object.keys(DEFAULT_ANTI_NUKE_THRESHOLDS) as NukeActionType[]).map((actionType) => {
      const custom = data.antiNukeThresholds.find((t) => t.actionType === actionType);
      if (custom) {
        return {
          actionType,
          enabled: custom.enabled,
          maxCount: custom.maxCount,
          windowSeconds: custom.windowSeconds,
          punishment: custom.punishment,
          isCustom: true,
        };
      }
      const fallback = DEFAULT_ANTI_NUKE_THRESHOLDS[actionType];
      return {
        actionType,
        enabled: true,
        maxCount: fallback.maxCount,
        windowSeconds: fallback.windowSeconds,
        punishment: null,
        isCustom: false,
      };
    });
  }

  public async setAntiNukeDefaultPunishment(guildId: string, punishment: PunishmentAction): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.antiNukeConfig.upsert({
      where: { guildId },
      update: { defaultPunishment: punishment },
      create: { guildId, defaultPunishment: punishment },
    });
    this.invalidate(guildId);
  }

  public async setAntiNukeAlertChannel(guildId: string, channelId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.antiNukeConfig.upsert({
      where: { guildId },
      update: { alertChannelId: channelId },
      create: { guildId, alertChannelId: channelId },
    });
    this.invalidate(guildId);
  }

  public async setAutoModRuleEnabled(
    guildId: string,
    type: AutoModRule["type"],
    enabled: boolean
  ): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.autoModRule.upsert({
      where: { guildId_type: { guildId, type } },
      update: { enabled },
      create: { guildId, type, enabled },
    });
    this.invalidate(guildId);
  }

  public async addWhitelistEntry(
    guildId: string,
    targetId: string,
    targetType: AutoModWhitelist["targetType"],
    reason?: string
  ): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.autoModWhitelist.upsert({
      where: { guildId_targetId_targetType: { guildId, targetId, targetType } },
      update: { reason },
      create: { guildId, targetId, targetType, reason },
    });
    this.invalidate(guildId);
  }

  public async removeWhitelistEntry(
    guildId: string,
    targetId: string,
    targetType: AutoModWhitelist["targetType"]
  ): Promise<void> {
    await this.prisma.autoModWhitelist
      .delete({ where: { guildId_targetId_targetType: { guildId, targetId, targetType } } })
      .catch(() => undefined); // idempotent - existiert der Eintrag nicht, ist das kein Fehler
    this.invalidate(guildId);
  }

  // --------------------------------------------------------------------
  // Bot-Admin-Rollen
  //
  // Steuert, wer (zusätzlich zu echten Discord-"Administrator"-Berechtigten
  // und dem Server-Owner) die Bot-Verwaltungs-Commands (AutoMod, Anti-Nuke,
  // Config, Dashboard) nutzen darf. Lockdown ist davon bewusst AUSGENOMMEN
  // und bleibt hart an echte Discord-Administrator-Rechte gebunden.
  // --------------------------------------------------------------------

  public async getAdminRoleIds(guildId: string): Promise<string[]> {
    return (await this.getGuildData(guildId)).adminRoleIds;
  }

  public async addAdminRole(guildId: string, roleId: string): Promise<void> {
    await this.ensureGuild(guildId);
    await this.prisma.guildAdminRole.upsert({
      where: { guildId_roleId: { guildId, roleId } },
      update: {},
      create: { guildId, roleId },
    });
    this.invalidate(guildId);
  }

  public async removeAdminRole(guildId: string, roleId: string): Promise<void> {
    await this.prisma.guildAdminRole
      .delete({ where: { guildId_roleId: { guildId, roleId } } })
      .catch(() => undefined); // idempotent
    this.invalidate(guildId);
  }

  /**
   * Zentrale Autorisierungsprüfung für alle mit `botAdminOnly: true`
   * markierten Commands/Dashboard-Aktionen (siehe interactionCreate.ts).
   * Erlaubt sind: der Server-Owner, jeder mit der echten Discord
   * "Administrator"-Berechtigung, sowie Mitglieder mit einer der über
   * /permissions konfigurierten Rollen.
   */
  public async isBotAdmin(
    guildId: string,
    member: { id: string; permissions: { has: (perm: bigint) => boolean }; roles: { cache: { has: (id: string) => boolean } } },
    ownerId?: string
  ): Promise<boolean> {
    if (ownerId && member.id === ownerId) return true;
    // Administrator-Bit (0x8) - direkt geprüft statt PermissionFlagsBits zu importieren,
    // um diese Methode unabhängig vom discord.js-Interaction-Typ zu halten.
    if (member.permissions.has(1n << 3n)) return true;
    const adminRoleIds = await this.getAdminRoleIds(guildId);
    return adminRoleIds.some((roleId) => member.roles.cache.has(roleId));
  }
}
