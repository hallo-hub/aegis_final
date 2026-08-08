import { SlashCommandBuilder, ChannelType, MessageFlags, EmbedBuilder, Colors } from "discord.js";
import { NukeActionType, PunishmentAction } from "@prisma/client";
import { Command } from "../../types/Command";

const ACTION_CHOICES: { name: string; value: NukeActionType }[] = [
  { name: "Channel löschen", value: "CHANNEL_DELETE" },
  { name: "Channel erstellen", value: "CHANNEL_CREATE" },
  { name: "Channel bearbeiten", value: "CHANNEL_UPDATE" },
  { name: "Rolle löschen", value: "ROLE_DELETE" },
  { name: "Rolle erstellen", value: "ROLE_CREATE" },
  { name: "Rolle bearbeiten", value: "ROLE_UPDATE" },
  { name: "Berechtigungen ändern", value: "PERMISSION_UPDATE" },
  { name: "Webhook erstellen", value: "WEBHOOK_CREATE" },
  { name: "Emoji löschen", value: "EMOJI_DELETE" },
  { name: "Sticker löschen", value: "STICKER_DELETE" },
  { name: "Mitglied bannen", value: "MEMBER_BAN" },
  { name: "Mitglied kicken", value: "MEMBER_KICK" },
];

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Anti-Nuke Konfiguration (Bot-Administratoren)")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("threshold")
        .setDescription("Schwellenwert für einen Aktionstyp setzen")
        .addStringOption((opt) => opt.setName("aktion").setDescription("Aktionstyp").setRequired(true).addChoices(...ACTION_CHOICES))
        .addIntegerOption((opt) => opt.setName("max").setDescription("Maximale Anzahl im Zeitfenster").setRequired(true).setMinValue(1))
        .addIntegerOption((opt) => opt.setName("sekunden").setDescription("Zeitfenster in Sekunden").setRequired(true).setMinValue(1))
        .addStringOption((opt) =>
          opt
            .setName("aktiviert")
            .setDescription("Regel aktiviert?")
            .addChoices({ name: "Ja", value: "true" }, { name: "Nein", value: "false" })
        )
        .addStringOption((opt) =>
          opt
            .setName("gegenmassnahme")
            .setDescription("Gegenmaßnahme NUR für diesen Aktionstyp (überschreibt den globalen Standard)")
            .addChoices({ name: "Kick", value: "KICK" }, { name: "Bann", value: "BAN" }, { name: "Keine Aktion", value: "NONE" })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("reset")
        .setDescription("Schwellenwert für einen Aktionstyp zurück auf Standard (3 Aktionen/5s, Rolle bearbeiten: 5/5s) setzen")
        .addStringOption((opt) => opt.setName("aktion").setDescription("Aktionstyp").setRequired(true).addChoices(...ACTION_CHOICES))
    )
    .addSubcommand((sub) =>
      sub
        .setName("thresholds")
        .setDescription("Zeigt die AKTUELL WIRKSAMEN Schwellenwerte für alle Aktionstypen (zur Kontrolle)")
    )
    .addSubcommand((sub) =>
      sub
        .setName("punishment")
        .setDescription("GLOBALEN Standard für die Gegenmaßnahme setzen (gilt für alle Aktionstypen ohne eigene Gegenmaßnahme)")
        .addStringOption((opt) =>
          opt
            .setName("aktion")
            .setDescription("Gegenmaßnahme")
            .setRequired(true)
            .addChoices({ name: "Kick", value: "KICK" }, { name: "Bann", value: "BAN" }, { name: "Keine Aktion", value: "NONE" })
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("alertchannel")
        .setDescription("Channel für Anti-Nuke Alarme setzen")
        .addChannelOption((opt) => opt.setName("channel").setDescription("Ziel-Channel").addChannelTypes(ChannelType.GuildText).setRequired(true))
    ) as SlashCommandBuilder,

  botAdminOnly: true,

  execute: async (interaction, client) => {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Nur auf einem Server nutzbar.", flags: MessageFlags.Ephemeral });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (subcommand === "threshold") {
      const action = interaction.options.getString("aktion", true) as NukeActionType;
      const max = interaction.options.getInteger("max", true);
      const seconds = interaction.options.getInteger("sekunden", true);
      const enabledStr = interaction.options.getString("aktiviert");
      const punishmentStr = interaction.options.getString("gegenmassnahme") as PunishmentAction | null;

      await client.guildConfig.setAntiNukeThreshold(guildId, action, {
        maxCount: max,
        windowSeconds: seconds,
        ...(enabledStr ? { enabled: enabledStr === "true" } : {}),
        ...(punishmentStr ? { punishment: punishmentStr } : {}),
      });

      const punishmentInfo = punishmentStr
        ? `Gegenmaßnahme für diese Aktion: **${punishmentStr}**.`
        : `Gegenmaßnahme: folgt dem globalen Standard aus \`/antinuke punishment\`.`;

      await interaction.reply({
        content: `✅ Schwellenwert für **${action}** gesetzt: ${max} Aktionen / ${seconds}s. ${punishmentInfo}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "reset") {
      const action = interaction.options.getString("aktion", true) as NukeActionType;
      await client.guildConfig.resetAntiNukeThreshold(guildId, action);
      await interaction.reply({
        content: `✅ Schwellenwert für **${action}** auf Standard zurückgesetzt.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "thresholds") {
      const all = await client.guildConfig.getAllEffectiveAntiNukeThresholds(guildId);
      const config = await client.guildConfig.getAntiNukeConfig(guildId);

      const embed = new EmbedBuilder()
        .setTitle("🛡️ Anti-Nuke – aktuell wirksame Schwellenwerte")
        .setColor(Colors.Blurple)
        .setDescription(
          `Anti-Nuke ist **${config.enabled ? "aktiviert" : "deaktiviert"}**. ` +
            `Globaler Standard ohne eigene Gegenmaßnahme: **${config.defaultPunishment}**.`
        )
        .addFields(
          all.map((t) => ({
            name: t.actionType,
            value:
              `${t.enabled ? "🟢" : "🔴"} ${t.maxCount} Aktionen / ${t.windowSeconds}s\n` +
              `Gegenmaßnahme: ${t.punishment ?? `(Standard: ${config.defaultPunishment})`}\n` +
              `${t.isCustom ? "⚙️ individuell gesetzt" : "· Standardwert"}`,
            inline: true,
          }))
        );

      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "punishment") {
      const action = interaction.options.getString("aktion", true) as PunishmentAction;
      await client.guildConfig.setAntiNukeDefaultPunishment(guildId, action);
      await interaction.reply({ content: `✅ Standard-Gegenmaßnahme gesetzt auf **${action}**.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "alertchannel") {
      const channel = interaction.options.getChannel("channel", true);
      await client.guildConfig.setAntiNukeAlertChannel(guildId, channel.id);
      await interaction.reply({ content: `✅ Anti-Nuke Alarm-Channel gesetzt auf <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
