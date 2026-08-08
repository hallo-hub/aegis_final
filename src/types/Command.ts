import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  PermissionResolvable,
} from "discord.js";
import { SecurityClient } from "../structures/SecurityClient";

export interface Command {
  data: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  /** Zusätzliche, serverseitige Berechtigungsprüfung (defensiv, unabhängig von Discords eigener Permission-UI) */
  requiredPermissions?: PermissionResolvable[];
  /**
   * Statt einer harten Discord-Berechtigung: erlaubt Ausführung für
   * Server-Owner, echte "Administrator"-Berechtigte UND Mitglieder mit einer
   * über /permissions konfigurierten Bot-Admin-Rolle (siehe
   * GuildConfigService#isBotAdmin). Wird von Lockdown bewusst NICHT genutzt.
   */
  botAdminOnly?: boolean;
  /** Nur für Bot-Owner (siehe BOT_OWNER_IDS) nutzbar, z.B. Notfall-Commands */
  ownerOnly?: boolean;
  execute: (
    interaction: ChatInputCommandInteraction,
    client: SecurityClient
  ) => Promise<void>;
}
