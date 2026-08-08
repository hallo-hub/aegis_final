import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder, Colors } from "discord.js";
import { Command } from "../../types/Command";

/**
 * Verwaltet, welche ROLLEN (zusätzlich zu echten Discord-"Administrator"-
 * Berechtigten und dem Server-Owner) die Bot-Verwaltungs-Commands
 * (AutoMod, Anti-Nuke, Config, Dashboard) nutzen dürfen.
 *
 * Dieser Command selbst bleibt BEWUSST hart an die echte Discord
 * "Administrator"-Berechtigung gebunden (sowohl über
 * setDefaultMemberPermissions als auch serverseitig über
 * requiredPermissions) - sonst könnte sich das Bot-Admin-Rollensystem
 * theoretisch selbst erweitern.
 *
 * Lockdown ist von diesem System bewusst NICHT betroffen und bleibt
 * IMMER exklusiv für echte Server-Administratoren nutzbar.
 */
export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("permissions")
    .setDescription("Verwaltet, welche Rollen die Bot-Commands nutzen dürfen (nur echte Administratoren)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("add-role")
        .setDescription("Erlaubt einer Rolle die Nutzung der Bot-Verwaltungs-Commands (AutoMod/Anti-Nuke/Config/Dashboard)")
        .addRoleOption((opt) => opt.setName("rolle").setDescription("Rolle").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove-role")
        .setDescription("Entzieht einer Rolle die Bot-Verwaltungs-Berechtigung")
        .addRoleOption((opt) => opt.setName("rolle").setDescription("Rolle").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("Zeigt alle konfigurierten Bot-Admin-Rollen")) as SlashCommandBuilder,

  requiredPermissions: [PermissionFlagsBits.Administrator],

  execute: async (interaction, client) => {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Nur auf einem Server nutzbar.", flags: MessageFlags.Ephemeral });
      return;
    }
    const guildId = interaction.guildId!;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === "add-role") {
      const role = interaction.options.getRole("rolle", true);
      await client.guildConfig.addAdminRole(guildId, role.id);
      await interaction.reply({
        content: `✅ Mitglieder mit <@&${role.id}> dürfen jetzt AutoMod, Anti-Nuke, Config und /dashboard nutzen. (Lockdown bleibt exklusiv für echte Administratoren.)`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === "remove-role") {
      const role = interaction.options.getRole("rolle", true);
      await client.guildConfig.removeAdminRole(guildId, role.id);
      await interaction.reply({ content: `✅ <@&${role.id}> wurde die Bot-Verwaltungs-Berechtigung entzogen.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "list") {
      const roleIds = await client.guildConfig.getAdminRoleIds(guildId);
      const embed = new EmbedBuilder()
        .setTitle("🔐 Bot-Admin-Rollen")
        .setColor(Colors.Purple)
        .setDescription(
          (roleIds.length === 0
            ? "_Keine Rolle konfiguriert - nur echte Server-Administratoren und der Server-Owner dürfen die Bot-Commands nutzen._"
            : roleIds.map((id) => `• <@&${id}>`).join("\n")) +
            "\n\nGilt für: `/automod`, `/antinuke`, `/config`, `/dashboard`.\n**Nicht** für `/lockdown` (immer nur echte Administratoren)."
        );
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
