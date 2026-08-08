import { Events, Guild } from "discord.js";
import { SecurityClient } from "../structures/SecurityClient";
import logger from "../utils/logger";

export const name = Events.GuildCreate;

/**
 * Wird ausgelöst, sobald der Bot zu einem NEUEN Server eingeladen wird.
 * Legt sofort einen leeren, isolierten Konfigurationsdatensatz für diese
 * Guild an, damit alle Module (die auf einen existierenden GuildConfig-
 * Datensatz vertrauen) von Anfang an korrekt funktionieren.
 */
export async function execute(guild: Guild, client: SecurityClient): Promise<void> {
  try {
    await client.guildConfig.ensureGuild(guild.id);
    logger.info({ guildId: guild.id, name: guild.name }, "Neuer Server - Konfiguration initialisiert");
  } catch (err) {
    logger.error({ err, guildId: guild.id }, "Konnte Konfiguration für neuen Server nicht initialisieren");
  }
}
