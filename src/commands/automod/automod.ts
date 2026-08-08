import { SlashCommandBuilder, MessageFlags, Role } from "discord.js";
import { AutoModRuleType } from "@prisma/client";
import { Command } from "../../types/Command";
import { reloadWordlists } from "../../modules/autoMod/wordlists";

const RULE_CHOICES: { name: string; value: AutoModRuleType }[] = [
  { name: "Spam", value: "SPAM" },
  { name: "Duplicate Spam", value: "DUPLICATE_SPAM" },
  { name: "Caps Spam", value: "CAPS_SPAM" },
  { name: "Emoji Spam", value: "EMOJI_SPAM" },
  { name: "Mention Spam", value: "MENTION_SPAM" },
  { name: "Invite Links", value: "INVITE_LINKS" },
  { name: "Scam Links", value: "SCAM_LINKS" },
  { name: "Werbung", value: "ADVERTISING" },
  { name: "NSFW", value: "NSFW" },
  { name: "Beleidigungen", value: "INSULTS" },
  { name: "Diskriminierende Begriffe", value: "DISCRIMINATION" },
  { name: "Schimpfwörter", value: "PROFANITY" },
  { name: "Unerlaubte Links", value: "UNAUTHORIZED_LINKS" },
  { name: "Token Leaks", value: "TOKEN_LEAK" },
];

export const command: Command = {
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("AutoMod Konfiguration (Bot-Administratoren)")
    .setDMPermission(false)
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Eine AutoMod-Regel aktivieren/deaktivieren")
        .addStringOption((opt) => opt.setName("regel").setDescription("Regeltyp").setRequired(true).addChoices(...RULE_CHOICES))
        .addBooleanOption((opt) => opt.setName("aktiviert").setDescription("Aktivieren?").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("whitelist-add")
        .setDescription("Nutzer oder Rolle zur AutoMod-Whitelist hinzufügen")
        .addMentionableOption((opt) => opt.setName("ziel").setDescription("Nutzer oder Rolle").setRequired(true))
    )
    .addSubcommand((sub) =>
      sub
        .setName("whitelist-remove")
        .setDescription("Nutzer oder Rolle von der AutoMod-Whitelist entfernen")
        .addMentionableOption((opt) => opt.setName("ziel").setDescription("Nutzer oder Rolle").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("reload-wordlists").setDescription("Wortlisten (Beleidigungen/Diskriminierung/Schimpfwörter) neu laden")) as SlashCommandBuilder,

  botAdminOnly: true,

  execute: async (interaction, client) => {
    if (!interaction.inGuild()) {
      await interaction.reply({ content: "Nur auf einem Server nutzbar.", flags: MessageFlags.Ephemeral });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    const guildId = interaction.guildId!;

    if (subcommand === "toggle") {
      const rule = interaction.options.getString("regel", true) as AutoModRuleType;
      const enabled = interaction.options.getBoolean("aktiviert", true);
      await client.guildConfig.setAutoModRuleEnabled(guildId, rule, enabled);
      await interaction.reply({ content: `✅ Regel **${rule}** ist jetzt ${enabled ? "aktiviert" : "deaktiviert"}.`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === "whitelist-add" || subcommand === "whitelist-remove") {
      const mentionable = interaction.options.getMentionable("ziel", true);
      const isRole = mentionable instanceof Role;
      const targetType = isRole ? "ROLE" : "USER";
      const targetId = mentionable.id;

      if (subcommand === "whitelist-add") {
        await client.guildConfig.addWhitelistEntry(guildId, targetId, targetType);
        await interaction.reply({ content: `✅ <@${isRole ? "&" : ""}${targetId}> zur AutoMod-Whitelist hinzugefügt.`, flags: MessageFlags.Ephemeral });
      } else {
        await client.guildConfig.removeWhitelistEntry(guildId, targetId, targetType);
        await interaction.reply({ content: `✅ <@${isRole ? "&" : ""}${targetId}> von der AutoMod-Whitelist entfernt.`, flags: MessageFlags.Ephemeral });
      }
      return;
    }

    if (subcommand === "reload-wordlists") {
      reloadWordlists();
      await interaction.reply({ content: "✅ Wortlisten wurden neu geladen.", flags: MessageFlags.Ephemeral });
      return;
    }
  },
};
