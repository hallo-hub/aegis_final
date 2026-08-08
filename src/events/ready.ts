import { Events } from "discord.js";
import { SecurityClient } from "../structures/SecurityClient";
import logger from "../utils/logger";

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: SecurityClient): Promise<void> {
  logger.info(
    { user: client.user?.tag, guilds: client.guilds.cache.size },
    "Bot ist online und bereit"
  );

  // Stellt sicher, dass für ALLE Server, auf denen der Bot bereits ist
  // (z.B. nach einem Neustart), eine Konfiguration existiert.
  for (const guild of client.guilds.cache.values()) {
    await client.guildConfig.ensureGuild(guild.id).catch((err) =>
      logger.error({ err, guildId: guild.id }, "Konnte Guild-Konfiguration beim Start nicht sicherstellen")
    );
  }
}
