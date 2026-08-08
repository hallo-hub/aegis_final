import "dotenv/config";
import { SecurityClient } from "./structures/SecurityClient";
import { loadCommands } from "./handlers/commandHandler";
import { loadEvents } from "./handlers/eventHandler";
import logger from "./utils/logger";

async function main(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    throw new Error("DISCORD_TOKEN fehlt in der .env Datei.");
  }

  const client = new SecurityClient();

  // Manager (AntiNuke/AutoMod) registrieren ihre Listener bereits im
  // Konstruktor der SecurityClient. Hier laden wir zusätzlich Commands
  // und die generischen Event-Handler (interactionCreate, ready, ...).
  await loadCommands(client);
  await loadEvents(client);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Fahre Bot sauber herunter...");
    client.destroy();
    const { default: PrismaService } = await import("./structures/PrismaService");
    await PrismaService.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await client.start(token);
}

main().catch((err) => {
  logger.error({ err }, "Bot konnte nicht gestartet werden");
  process.exit(1);
});
