import "dotenv/config";
import { REST, Routes } from "discord.js";
import { SecurityClient } from "./structures/SecurityClient";
import { loadCommands, getCommandJSONData } from "./handlers/commandHandler";
import logger from "./utils/logger";

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const devGuildId = process.env.DEV_GUILD_ID;

  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN und DISCORD_CLIENT_ID müssen in der .env gesetzt sein.");
  }

  // Wir nutzen den vollen Client nur, um denselben Command-Loader
  // wiederzuverwenden - es wird KEIN Login durchgeführt.
  const client = new SecurityClient();
  await loadCommands(client);
  const body = getCommandJSONData(client);

  const rest = new REST().setToken(token);

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    logger.info({ count: body.length, guildId: devGuildId }, "Commands für Dev-Guild registriert (sofort verfügbar)");
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    logger.info({ count: body.length }, "Commands global registriert (Propagation kann bis zu 1h dauern)");
  }

  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, "Command-Deployment fehlgeschlagen");
  process.exit(1);
});
