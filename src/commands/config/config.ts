import { SlashCommandBuilder, ChannelType, MessageFlags } from "discord.js";
import { Command } from "../../types/Command";

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("config")
    .setDescription("Basis-Konfiguration des Security-Bots (Bot-Administratoren)")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("logchannel")
        .setDescription("Setzt den zentralen Security-Log-Channel für diesen Server")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Ziel-Channel").addChannelTypes(ChannelType.GuildText).setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("incident-category")
        .setDescription("Setzt die Kategorie, in der Lockdown-Incident-Kanäle erstellt werden")
        .addChannelOption((opt) =>
          opt.setName("category").setDescription("Ziel-Kategorie").addChannelTypes(ChannelType.GuildCategory).setRequired(true)
        )
    ) as SlashCommandBuilder,

  botAdminOnly: true,

  execute: async (interaction, client) => {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Nur auf einem Server nutzbar.", flags: MessageFlags.Ephemeral });
      return;
    }
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "logchannel") {
      const channel = interaction.options.getChannel("channel", true);
      await client.guildConfig.setLogChannel(interaction.guildId!, channel.id);
      await interaction.reply({ content: `✅ Security-Log-Channel gesetzt auf <#${channel.id}>.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "incident-category") {
      const category = interaction.options.getChannel("category", true);
      await client.guildConfig.setIncidentCategory(interaction.guildId!, category.id);
      await interaction.reply({ content: `✅ Incident-Kategorie gesetzt auf **${category.name}**.`, flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
