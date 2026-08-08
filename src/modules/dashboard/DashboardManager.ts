import {
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  RoleSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonInteraction,
  StringSelectMenuInteraction,
  RoleSelectMenuInteraction,
  ModalSubmitInteraction,
  MessageFlags,
  InteractionReplyOptions,
} from "discord.js";
import { AutoModActionType, AutoModRuleType, NukeActionType, PunishmentAction } from "@prisma/client";
import { SecurityClient } from "../../structures/SecurityClient";
import logger from "../../utils/logger";

/**
 * Zentrales /dashboard.
 *
 * Alle Interaktions-IDs sind mit dem Präfix "dash:" versehen und werden in
 * interactionCreate.ts hierher geroutet. Jede Panel-Methode gibt fertige
 * { embeds, components } zurück, die sowohl für die initiale Reply als auch
 * für spätere `update()`-Aufrufe (Button-Klicks) wiederverwendet werden.
 *
 * WICHTIG: Jede Aktion hier geht durch dieselbe `botAdminOnly`-Prüfung wie
 * die entsprechenden Slash Commands (siehe interactionCreate.ts) - das
 * Dashboard ist kein Weg, um Berechtigungen zu umgehen.
 */
const RULE_LABELS: Record<AutoModRuleType, string> = {
  SPAM: "Spam",
  DUPLICATE_SPAM: "Duplicate Spam",
  CAPS_SPAM: "Caps Spam",
  EMOJI_SPAM: "Emoji Spam",
  MENTION_SPAM: "Mention Spam",
  INVITE_LINKS: "Invite Links",
  SCAM_LINKS: "Scam Links",
  ADVERTISING: "Werbung",
  NSFW: "NSFW",
  INSULTS: "Beleidigungen",
  DISCRIMINATION: "Diskriminierende Begriffe",
  PROFANITY: "Schimpfwörter",
  UNAUTHORIZED_LINKS: "Unerlaubte Links",
  TOKEN_LEAK: "Token Leaks",
};

const NUKE_ACTION_LABELS: Record<NukeActionType, string> = {
  CHANNEL_DELETE: "Channel löschen",
  CHANNEL_CREATE: "Channel erstellen",
  CHANNEL_UPDATE: "Channel bearbeiten",
  ROLE_DELETE: "Rolle löschen",
  ROLE_CREATE: "Rolle erstellen",
  ROLE_UPDATE: "Rolle bearbeiten",
  PERMISSION_UPDATE: "Berechtigungen ändern",
  WEBHOOK_CREATE: "Webhook erstellen",
  EMOJI_DELETE: "Emoji löschen",
  STICKER_DELETE: "Sticker löschen",
  MEMBER_BAN: "Mitglied bannen",
  MEMBER_KICK: "Mitglied kicken",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Panel = { embeds: EmbedBuilder[]; components: any[] };

export class DashboardManager {
  public constructor(private readonly client: SecurityClient) {}

  // ------------------------------------------------------------------
  // HOME
  // ------------------------------------------------------------------

  public async buildHome(guildId: string): Promise<Panel> {
    const [antiNuke, autoModRules, lockdown, adminRoleIds, recentLogs] = await Promise.all([
      this.client.guildConfig.getAntiNukeConfig(guildId),
      this.client.guildConfig.getAutoModRules(guildId),
      this.client.lockdown.getStatus(guildId),
      this.client.guildConfig.getAdminRoleIds(guildId),
      this.client.securityLog.getRecent(guildId, 5),
    ]);

    const enabledRules = autoModRules.filter((r) => r.enabled).length;

    const logLines =
      recentLogs.length === 0
        ? "_Noch keine Ereignisse._"
        : recentLogs
            .map((l) => `<t:${Math.floor(l.createdAt.getTime() / 1000)}:R> — ${this.client.securityLog.titleForType(l.type)}`)
            .join("\n");

    const embed = new EmbedBuilder()
      .setTitle("📊 Security-Dashboard")
      .setColor(Colors.Blurple)
      .setDescription("Zentrale Übersicht und Verwaltung aller Sicherheitsmodule.")
      .addFields(
        {
          name: "🛡️ Anti-Nuke",
          value: `${antiNuke.enabled ? "🟢 aktiv" : "🔴 inaktiv"}\nStandard-Gegenmaßnahme: **${antiNuke.defaultPunishment}**`,
          inline: true,
        },
        {
          name: "🤖 AutoMod",
          value: `${enabledRules}/${autoModRules.length} Regeln aktiv`,
          inline: true,
        },
        {
          name: "🔒 Lockdown",
          value: lockdown?.active
            ? `🔴 aktiv (${lockdown.level}) seit <t:${Math.floor((lockdown.activatedAt?.getTime() ?? 0) / 1000)}:R>`
            : "🟢 inaktiv",
          inline: true,
        },
        {
          name: "🔐 Bot-Admin-Rollen",
          value: adminRoleIds.length === 0 ? "_Nur Server-Administratoren_" : adminRoleIds.map((id) => `<@&${id}>`).join(", "),
          inline: false,
        },
        { name: "📜 Letzte Ereignisse", value: logLines, inline: false }
      )
      .setFooter({ text: "Buttons unten führen zu den jeweiligen Verwaltungs-Panels." })
      .setTimestamp(new Date());

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("dash:antinuke").setLabel("Anti-Nuke").setEmoji("🛡️").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dash:automod").setLabel("AutoMod").setEmoji("🤖").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dash:lockdown").setLabel("Lockdown").setEmoji("🔒").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dash:logs:0").setLabel("Logs").setEmoji("📜").setStyle(ButtonStyle.Secondary)
    );
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("dash:roles").setLabel("Admin-Rollen").setEmoji("🔐").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("dash:home").setLabel("Aktualisieren").setEmoji("🔄").setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row1, row2] };
  }

  private backRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("dash:home").setLabel("⬅️ Zurück zum Dashboard").setStyle(ButtonStyle.Secondary)
    );
  }

  // ------------------------------------------------------------------
  // ANTI-NUKE PANEL
  // ------------------------------------------------------------------

  public async buildAntiNuke(guildId: string): Promise<Panel> {
    const [all, config] = await Promise.all([
      this.client.guildConfig.getAllEffectiveAntiNukeThresholds(guildId),
      this.client.guildConfig.getAntiNukeConfig(guildId),
    ]);

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Anti-Nuke – Verwaltung")
      .setColor(Colors.DarkRed)
      .setDescription(
        `Anti-Nuke ist **${config.enabled ? "aktiviert" : "deaktiviert"}**. ` +
          `Globale Standard-Gegenmaßnahme (ohne eigene Einstellung je Aktion): **${config.defaultPunishment}**.\n\n` +
          `Wähle unten einen Aktionstyp aus, um Schwellenwert & Gegenmaßnahme direkt zu bearbeiten.`
      )
      .addFields(
        all.map((t) => ({
          name: NUKE_ACTION_LABELS[t.actionType],
          value: `${t.enabled ? "🟢" : "🔴"} ${t.maxCount} Aktionen / ${t.windowSeconds}s${t.isCustom ? " ⚙️" : ""}`,
          inline: true,
        }))
      );

    const select = new StringSelectMenuBuilder()
      .setCustomId("dash:antinuke:select")
      .setPlaceholder("Aktionstyp zum Bearbeiten wählen…")
      .addOptions(
        (Object.keys(NUKE_ACTION_LABELS) as NukeActionType[]).map((type) => ({
          label: NUKE_ACTION_LABELS[type],
          value: type,
        }))
      );

    const punishmentSelect = new StringSelectMenuBuilder()
      .setCustomId("dash:antinuke:punishment")
      .setPlaceholder("Globale Standard-Gegenmaßnahme ändern…")
      .addOptions(
        { label: "Kick", value: "KICK" },
        { label: "Bann", value: "BAN" },
        { label: "Keine Aktion", value: "NONE" }
      );

    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(punishmentSelect),
        this.backRow(),
      ],
    };
  }

  public buildAntiNukeModal(actionType: NukeActionType, current: { maxCount: number; windowSeconds: number }): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`dash:antinuke:modal:${actionType}`)
      .setTitle(`Schwelle: ${NUKE_ACTION_LABELS[actionType]}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("max")
            .setLabel("Max. Aktionen im Zeitfenster")
            .setStyle(TextInputStyle.Short)
            .setValue(String(current.maxCount))
            .setRequired(true)
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("seconds")
            .setLabel("Zeitfenster in Sekunden")
            .setStyle(TextInputStyle.Short)
            .setValue(String(current.windowSeconds))
            .setRequired(true)
        )
      );
  }

  // ------------------------------------------------------------------
  // AUTOMOD PANEL
  // ------------------------------------------------------------------

  public async buildAutoMod(guildId: string): Promise<Panel> {
    const rules = await this.client.guildConfig.getAutoModRules(guildId);

    const embed = new EmbedBuilder()
      .setTitle("🤖 AutoMod – Verwaltung")
      .setColor(Colors.Orange)
      .setDescription("Wähle eine Regel, um sie zu (de)aktivieren oder ihre Eskalationsleiter (ab wie vielen Verwarnungen welche Aktion) zu bearbeiten.")
      .addFields(
        rules.map((r) => ({
          name: RULE_LABELS[r.type],
          value: r.enabled ? "🟢 aktiv" : "🔴 deaktiviert",
          inline: true,
        }))
      );

    const select = new StringSelectMenuBuilder()
      .setCustomId("dash:automod:select")
      .setPlaceholder("Regel wählen…")
      .addOptions(
        rules.map((r) => ({
          label: RULE_LABELS[r.type],
          value: r.type,
          emoji: r.enabled ? "🟢" : "🔴",
        }))
      );

    return {
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), this.backRow()],
    };
  }

  public async buildAutoModRuleDetail(guildId: string, type: AutoModRuleType): Promise<Panel> {
    const rule = await this.client.guildConfig.getAutoModRule(guildId, type);
    const escalation = this.parseEscalationForDisplay(rule?.escalation);

    const embed = new EmbedBuilder()
      .setTitle(`🤖 AutoMod – ${RULE_LABELS[type]}`)
      .setColor(Colors.Orange)
      .setDescription(
        `Status: ${rule?.enabled ? "🟢 aktiv" : "🔴 deaktiviert"}\n\n` +
          `**Eskalationsleiter** (ab welcher Verwarnung welche Aktion greift):\n${escalation || "_Standard-Eskalation_"}`
      );

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`dash:automod:toggle:${type}`)
        .setLabel(rule?.enabled ? "Deaktivieren" : "Aktivieren")
        .setStyle(rule?.enabled ? ButtonStyle.Danger : ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`dash:automod:edit:${type}`).setLabel("Eskalation bearbeiten").setEmoji("✏️").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("dash:automod").setLabel("⬅️ Zurück").setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1] };
  }

  public buildAutoModEscalationModal(type: AutoModRuleType, rawCurrent: string): ModalBuilder {
    return new ModalBuilder()
      .setCustomId(`dash:automod:modal:${type}`)
      .setTitle(`Eskalation: ${RULE_LABELS[type]}`.slice(0, 45))
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("escalation")
            .setLabel("Eine Zeile pro Stufe: Verwarnung:Aktion:Dauer(s)")
            .setPlaceholder("1:DELETE_MESSAGE\n2:WARN\n3:TIMEOUT:600\n7:KICK\n10:BAN")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(rawCurrent)
            .setRequired(true)
        )
      );
  }

  private parseEscalationForDisplay(escalation: unknown): string {
    if (!Array.isArray(escalation) || escalation.length === 0) return "";
    return escalation
      .map((e) => {
        if (typeof e !== "object" || e === null || !("violationNumber" in e) || !("action" in e)) return null;
        const step = e as { violationNumber: number; action: string; durationSeconds?: number };
        return `**${step.violationNumber}.** Verwarnung → \`${step.action}\`${step.durationSeconds ? ` (${step.durationSeconds}s)` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Serialisiert die aktuelle Eskalation ins editierbare "1:AKTION:DAUER"-Zeilenformat für das Modal. */
  public escalationToRawLines(escalation: unknown): string {
    if (!Array.isArray(escalation) || escalation.length === 0) {
      return "1:DELETE_MESSAGE\n2:WARN\n3:TIMEOUT:600\n7:KICK\n10:BAN";
    }
    return escalation
      .map((e) => {
        if (typeof e !== "object" || e === null || !("violationNumber" in e) || !("action" in e)) return null;
        const step = e as { violationNumber: number; action: string; durationSeconds?: number };
        return `${step.violationNumber}:${step.action}${step.durationSeconds ? `:${step.durationSeconds}` : ""}`;
      })
      .filter(Boolean)
      .join("\n");
  }

  /** Parst das "1:AKTION:DAUER"-Zeilenformat aus dem Modal zurück in die DB-JSON-Struktur. Wirft bei ungültiger Eingabe. */
  public parseRawEscalationLines(raw: string): Array<{ violationNumber: number; action: AutoModActionType; durationSeconds?: number }> {
    const validActions = new Set<string>(["DELETE_MESSAGE", "WARN", "TIMEOUT", "PERMANENT_TIMEOUT", "KICK", "BAN"]);
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const steps = lines.map((line) => {
      const parts = line.split(":").map((p) => p.trim());
      const violationNumber = Number(parts[0]);
      const action = parts[1]?.toUpperCase();
      const durationSeconds = parts[2] ? Number(parts[2]) : undefined;

      if (!Number.isInteger(violationNumber) || violationNumber < 1) {
        throw new Error(`Ungültige Verwarnungs-Nummer in Zeile: "${line}"`);
      }
      if (!action || !validActions.has(action)) {
        throw new Error(`Ungültige Aktion in Zeile: "${line}". Erlaubt: ${[...validActions].join(", ")}`);
      }
      if (durationSeconds !== undefined && (!Number.isInteger(durationSeconds) || durationSeconds < 1)) {
        throw new Error(`Ungültige Dauer in Zeile: "${line}"`);
      }
      return { violationNumber, action: action as AutoModActionType, durationSeconds };
    });

    return steps.sort((a, b) => a.violationNumber - b.violationNumber);
  }

  // ------------------------------------------------------------------
  // LOCKDOWN PANEL (nur Anzeige - Aktivierung bleibt exklusiv über
  // /lockdown, siehe Spezifikation: "Nur Administratoren dürfen /lockdown
  // nutzen", ohne Ausweich-Weg über das Dashboard-Bot-Admin-Rollensystem)
  // ------------------------------------------------------------------

  public async buildLockdown(guildId: string): Promise<Panel> {
    const status = await this.client.lockdown.getStatus(guildId);

    const embed = new EmbedBuilder()
      .setTitle("🔒 Lockdown – Status")
      .setColor(status?.active ? Colors.Red : Colors.Green)
      .setDescription(
        status?.active
          ? `🔴 **Aktiv** – Level **${status.level}**\n` +
              `Grund: ${status.reason ?? "-"}\n` +
              `Aktiviert von: <@${status.activatedById}>\n` +
              `Seit: <t:${Math.floor((status.activatedAt?.getTime() ?? 0) / 1000)}:F>\n` +
              (status.incidentChannelId ? `Incident-Channel: <#${status.incidentChannelId}>` : "")
          : "🟢 Kein aktiver Lockdown."
      )
      .setFooter({
        text: "Aktivierung/Aufhebung ausschließlich über /lockdown level1|level2|remove durch echte Server-Administratoren.",
      });

    return { embeds: [embed], components: [this.backRow()] };
  }

  // ------------------------------------------------------------------
  // LOGS PANEL (paginiert)
  // ------------------------------------------------------------------

  public async buildLogs(guildId: string, offset: number): Promise<Panel> {
    const pageSize = 8;
    const [entries, total] = await Promise.all([
      this.client.securityLog.getRecent(guildId, pageSize, offset),
      this.client.securityLog.countTotal(guildId),
    ]);

    const embed = new EmbedBuilder()
      .setTitle("📜 Security-Logs")
      .setColor(Colors.Greyple)
      .setDescription(
        entries.length === 0
          ? "_Keine Einträge._"
          : entries
              .map((e) => {
                const parts = [`<t:${Math.floor(e.createdAt.getTime() / 1000)}:f>`, `**${this.client.securityLog.titleForType(e.type)}**`];
                if (e.actorId) parts.push(`von <@${e.actorId}>`);
                if (e.targetId) parts.push(`→ <@${e.targetId}>`);
                return parts.join(" ");
              })
              .join("\n")
      )
      .setFooter({ text: `Einträge ${offset + 1}-${offset + entries.length} von ${total}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`dash:logs:${Math.max(0, offset - pageSize)}`)
        .setLabel("⬅️ Neuer")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset === 0),
      new ButtonBuilder()
        .setCustomId(`dash:logs:${offset + pageSize}`)
        .setLabel("Älter ➡️")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(offset + pageSize >= total),
      new ButtonBuilder().setCustomId("dash:home").setLabel("⬅️ Zurück zum Dashboard").setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [row] };
  }

  // ------------------------------------------------------------------
  // ADMIN-ROLLEN PANEL
  // ------------------------------------------------------------------

  public async buildRoles(guildId: string): Promise<Panel> {
    const roleIds = await this.client.guildConfig.getAdminRoleIds(guildId);

    const embed = new EmbedBuilder()
      .setTitle("🔐 Bot-Admin-Rollen")
      .setColor(Colors.Purple)
      .setDescription(
        "Mitglieder mit einer dieser Rollen (oder echte Discord-„Administrator“-Berechtigte / der Server-Owner) " +
          "dürfen AutoMod, Anti-Nuke, Config und dieses Dashboard nutzen.\n\n" +
          "**Lockdown ist davon ausgenommen** und bleibt immer nur für echte Server-Administratoren nutzbar.\n\n" +
          (roleIds.length === 0 ? "_Aktuell keine Rolle konfiguriert - nur Server-Administratoren._" : roleIds.map((id) => `• <@&${id}>`).join("\n"))
      );

    const addSelect = new RoleSelectMenuBuilder().setCustomId("dash:roles:add").setPlaceholder("➕ Rolle hinzufügen…").setMaxValues(1);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const components: any[] = [
      new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(addSelect),
    ];

    if (roleIds.length > 0) {
      const removeSelect = new StringSelectMenuBuilder()
        .setCustomId("dash:roles:remove")
        .setPlaceholder("➖ Rolle entfernen…")
        .addOptions(roleIds.slice(0, 25).map((id) => ({ label: `Rolle ${id}`, value: id })));
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeSelect));
    }

    components.push(this.backRow());

    return { embeds: [embed], components };
  }

  // ------------------------------------------------------------------
  // ZENTRALES ROUTING
  // ------------------------------------------------------------------

  public async handleButton(interaction: ButtonInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const id = interaction.customId;

    if (id === "dash:home") return void interaction.update(await this.buildHome(guildId));
    if (id === "dash:antinuke") return void interaction.update(await this.buildAntiNuke(guildId));
    if (id === "dash:automod") return void interaction.update(await this.buildAutoMod(guildId));
    if (id === "dash:lockdown") return void interaction.update(await this.buildLockdown(guildId));
    if (id === "dash:roles") return void interaction.update(await this.buildRoles(guildId));
    if (id.startsWith("dash:logs:")) {
      const offset = Number(id.split(":")[2]) || 0;
      return void interaction.update(await this.buildLogs(guildId, offset));
    }
    if (id.startsWith("dash:automod:toggle:")) {
      const type = id.split(":")[3] as AutoModRuleType;
      const rule = await this.client.guildConfig.getAutoModRule(guildId, type);
      await this.client.guildConfig.setAutoModRuleEnabled(guildId, type, !(rule?.enabled ?? true));
      return void interaction.update(await this.buildAutoModRuleDetail(guildId, type));
    }
    if (id.startsWith("dash:automod:edit:")) {
      const type = id.split(":")[3] as AutoModRuleType;
      const rule = await this.client.guildConfig.getAutoModRule(guildId, type);
      const raw = this.escalationToRawLines(rule?.escalation);
      await interaction.showModal(this.buildAutoModEscalationModal(type, raw));
      return;
    }
  }

  public async handleStringSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const id = interaction.customId;
    const value = interaction.values[0];

    if (id === "dash:antinuke:select") {
      const type = value as NukeActionType;
      const threshold = await this.client.guildConfig.getAntiNukeThreshold(guildId, type);
      await interaction.showModal(this.buildAntiNukeModal(type, threshold));
      return;
    }
    if (id === "dash:antinuke:punishment") {
      await this.client.guildConfig.setAntiNukeDefaultPunishment(guildId, value as PunishmentAction);
      return void interaction.update(await this.buildAntiNuke(guildId));
    }
    if (id === "dash:automod:select") {
      return void interaction.update(await this.buildAutoModRuleDetail(guildId, value as AutoModRuleType));
    }
    if (id === "dash:roles:remove") {
      await this.client.guildConfig.removeAdminRole(guildId, value);
      return void interaction.update(await this.buildRoles(guildId));
    }
  }

  public async handleRoleSelect(interaction: RoleSelectMenuInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    if (interaction.customId === "dash:roles:add") {
      const roleId = interaction.values[0];
      if (roleId) await this.client.guildConfig.addAdminRole(guildId, roleId);
      return void interaction.update(await this.buildRoles(guildId));
    }
  }

  public async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const guildId = interaction.guildId!;
    const id = interaction.customId;

    if (id.startsWith("dash:antinuke:modal:")) {
      const type = id.split(":")[3] as NukeActionType;
      const max = Number(interaction.fields.getTextInputValue("max"));
      const seconds = Number(interaction.fields.getTextInputValue("seconds"));

      if (!Number.isInteger(max) || max < 1 || !Number.isInteger(seconds) || seconds < 1) {
        await interaction.reply({ content: "❌ Bitte gültige positive Ganzzahlen eingeben.", flags: MessageFlags.Ephemeral } as InteractionReplyOptions);
        return;
      }

      await this.client.guildConfig.setAntiNukeThreshold(guildId, type, { maxCount: max, windowSeconds: seconds });
      const panel = await this.buildAntiNuke(guildId);
      await interaction.update(panel);
      return;
    }

    if (id.startsWith("dash:automod:modal:")) {
      const type = id.split(":")[3] as AutoModRuleType;
      const raw = interaction.fields.getTextInputValue("escalation");

      try {
        const steps = this.parseRawEscalationLines(raw);
        await this.client.prisma.autoModRule.updateMany({
          where: { guildId, type },
          data: { escalation: steps as never },
        });
        this.client.guildConfig.invalidate(guildId);
      } catch (err) {
        await interaction.reply({
          content: `❌ ${err instanceof Error ? err.message : "Ungültiges Format."}`,
          flags: MessageFlags.Ephemeral,
        } as InteractionReplyOptions);
        return;
      }

      const panel = await this.buildAutoModRuleDetail(guildId, type);
      await interaction.update(panel);
      return;
    }
  }

  /** Zentraler Einstiegspunkt, den interactionCreate.ts für ALLE dash:-Interaktionen aufruft. */
  public async handleComponent(
    interaction: ButtonInteraction | StringSelectMenuInteraction | RoleSelectMenuInteraction | ModalSubmitInteraction
  ): Promise<void> {
    try {
      if (interaction.isButton()) return await this.handleButton(interaction);
      if (interaction.isStringSelectMenu()) return await this.handleStringSelect(interaction);
      if (interaction.isRoleSelectMenu()) return await this.handleRoleSelect(interaction);
      if (interaction.isModalSubmit()) return await this.handleModalSubmit(interaction);
    } catch (err) {
      logger.error({ err, customId: interaction.customId }, "Fehler im Dashboard-Handler");
      const payload = { content: "❌ Bei der Ausführung ist ein Fehler aufgetreten.", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload as InteractionReplyOptions).catch(() => undefined);
      } else {
        await interaction.reply(payload as InteractionReplyOptions).catch(() => undefined);
      }
    }
  }
}
