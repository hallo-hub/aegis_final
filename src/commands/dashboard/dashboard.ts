import { SlashCommandBuilder, MessageFlags } from "discord.js";
import { Command } from "../../types/Command";

/**
 * Zentrales Dashboard: eine Übersicht über Anti-Nuke, AutoMod, Lockdown,
 * Admin-Rollen und die letzten Sicherheits-Logs, mit Buttons/Selects/Modals
 * zum direkten Verwalten - ohne dass man sich alle Slash-Command-Optionen
 * merken muss. Die eigentliche Logik lebt im DashboardManager, siehe dort.
 *
 * Bewusst `botAdminOnly` statt harter Discord-Berechtigung, damit auch über
 * /permissions freigegebene Rollen das Dashboard nutzen können.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("dashboard")
    .setDescription("Zentrales Security-Dashboard: Übersicht & Verwaltung aller Module")
    .setDMPermission(false) as SlashCommandBuilder,

  botAdminOnly: true,

  execute: async (interaction, client) => {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Nur auf einem Server nutzbar.", flags: MessageFlags.Ephemeral });
      return;
    }
    const panel = await client.dashboard.buildHome(interaction.guildId!);
    await interaction.reply({ ...panel, flags: MessageFlags.Ephemeral });
  },
};
