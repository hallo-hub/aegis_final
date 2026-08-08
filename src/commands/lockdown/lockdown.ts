import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from "discord.js";
import { Command } from "../../types/Command";

/**
 * /lockdown - ausschließlich für Administratoren nutzbar (sowohl über
 * Discords eigenes Permission-System auf dem Command als auch defensiv
 * nochmal serverseitig geprüft, siehe requiredPermissions).
 *
 * Aktiviert NIEMALS automatisch - dies ist der einzige Einstiegspunkt in
 * das Lockdown-Modul.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Server-Lockdown verwalten (nur Administratoren)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("level1")
        .setDescription("Lockdown Level 1 aktivieren (nur Textkanäle sperren)")
        .addStringOption((opt) => opt.setName("grund").setDescription("Grund für den Lockdown").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("level2")
        .setDescription("Lockdown Level 2 aktivieren (Text- & Sprachkanäle sperren)")
        .addStringOption((opt) => opt.setName("grund").setDescription("Grund für den Lockdown").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("remove").setDescription("Aktiven Lockdown aufheben und alle Berechtigungen wiederherstellen")) as SlashCommandBuilder,

  requiredPermissions: [PermissionFlagsBits.Administrator],

  execute: async (interaction, client) => {
    if (!interaction.inGuild() || !interaction.guild) {
      await interaction.reply({ content: "Dieser Command funktioniert nur auf einem Server.", flags: MessageFlags.Ephemeral });
      return;
    }

    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ Nur Administratoren dürfen den Lockdown steuern.", flags: MessageFlags.Ephemeral });
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (subcommand === "level1" || subcommand === "level2") {
      const reason = interaction.options.getString("grund", true);
      const level = subcommand === "level1" ? "LEVEL1" : "LEVEL2";
      const result = await client.lockdown.activate(interaction.guild, level, reason, interaction.user.id);
      await interaction.editReply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      return;
    }

    if (subcommand === "remove") {
      const result = await client.lockdown.deactivate(interaction.guild, interaction.user.id);
      await interaction.editReply(result.success ? `✅ ${result.message}` : `❌ ${result.message}`);
      return;
    }
  },
};
