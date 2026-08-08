import { Events, MessageFlags, PermissionsBitField, Interaction } from "discord.js";
import { SecurityClient } from "../structures/SecurityClient";
import logger from "../utils/logger";

const OWNER_IDS = (process.env.BOT_OWNER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const name = Events.InteractionCreate;

export async function execute(interaction: Interaction, client: SecurityClient): Promise<void> {
  // Alle Dashboard-Interaktionen (Buttons/Select-Menüs/Modals mit dem
  // "dash:"-Präfix) werden zentral an den DashboardManager geroutet - aber
  // NUR nachdem dieselbe botAdminOnly-Prüfung wie bei den Slash Commands
  // bestanden wurde. Das Dashboard ist kein Weg, Berechtigungen zu umgehen.
  if (
    (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isRoleSelectMenu() || interaction.isModalSubmit()) &&
    interaction.customId.startsWith("dash:")
  ) {
    if (!interaction.inGuild()) return;
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const authorized = member ? await client.guildConfig.isBotAdmin(interaction.guildId!, member, interaction.guild?.ownerId) : false;
    if (!authorized) {
      await interaction
        .reply({ content: "❌ Du hast keine Berechtigung, das Dashboard zu verwalten.", flags: MessageFlags.Ephemeral })
        .catch(() => undefined);
      return;
    }
    await client.dashboard.handleComponent(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) {
    logger.warn({ command: interaction.commandName }, "Unbekannter Command aufgerufen");
    return;
  }

  if (command.ownerOnly && !OWNER_IDS.includes(interaction.user.id)) {
    await interaction.reply({ content: "❌ Dieser Command ist nur für Bot-Owner verfügbar.", flags: MessageFlags.Ephemeral });
    return;
  }

  // Zusätzliche, serverseitige Permission-Prüfung UNABHÄNGIG von Discords
  // eigener Command-Permission-UI (die ein Server-Admin theoretisch lockern
  // könnte). Sicherheitsrelevante Commands verlassen sich nie nur auf
  // Discord-seitige Defaults.
  if (command.requiredPermissions && interaction.inGuild()) {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const missing = command.requiredPermissions.filter(
      (perm) => !member?.permissions.has(perm as import("discord.js").PermissionResolvable)
    );
    if (missing.length > 0) {
      await interaction.reply({
        content: `❌ Dir fehlen die nötigen Berechtigungen: ${missing
          .map((p) => new PermissionsBitField(p as never).toArray().join(", "))
          .join(", ")}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  // Flexible Bot-Admin-Prüfung (Server-Owner / echte Administrator-Rechte /
  // konfigurierte Bot-Admin-Rolle via /permissions). Wird von Commands mit
  // `botAdminOnly: true` genutzt statt einer harten Discord-Berechtigung,
  // damit Server auch NICHT-Administrator-Rollen für die Bot-Verwaltung
  // freigeben können (siehe /permissions). Lockdown nutzt das bewusst NICHT.
  if (command.botAdminOnly && interaction.inGuild()) {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    const authorized = member
      ? await client.guildConfig.isBotAdmin(interaction.guildId!, member, interaction.guild?.ownerId)
      : false;
    if (!authorized) {
      await interaction.reply({
        content: "❌ Du hast keine Berechtigung, diesen Command zu nutzen. Ein Server-Administrator kann dir über `/permissions add-role` Zugriff geben.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
  }

  try {
    await command.execute(interaction, client);
  } catch (err) {
    logger.error({ err, command: interaction.commandName }, "Fehler bei Command-Ausführung");
    const payload = { content: "❌ Bei der Ausführung ist ein Fehler aufgetreten.", flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => undefined);
    } else {
      await interaction.reply(payload).catch(() => undefined);
    }
  }
}
