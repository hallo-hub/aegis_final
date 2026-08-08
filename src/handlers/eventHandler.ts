import fs from "node:fs";
import path from "node:path";
import { SecurityClient } from "../structures/SecurityClient";
import logger from "../utils/logger";

interface EventModule {
  name: string;
  once?: boolean;
  execute: (...args: unknown[]) => Promise<void> | void;
}

export async function loadEvents(client: SecurityClient): Promise<void> {
  const eventsDir = path.join(__dirname, "..", "events");
  const files = fs
    .readdirSync(eventsDir)
    .filter((f) => (f.endsWith(".ts") || f.endsWith(".js")) && !f.endsWith(".d.ts"));

  for (const file of files) {
    try {
      const imported = (await import(path.join(eventsDir, file))) as EventModule;
      if (!imported.name || typeof imported.execute !== "function") {
        logger.warn({ file }, "Datei im events-Ordner exportiert kein gültiges Event - übersprungen");
        continue;
      }

      const handler = (...args: unknown[]) => {
        // Discord.js übergibt bei den meisten Events KEIN client-Argument -
        // wir hängen es hier konsistent selbst an, damit jeder Event-Handler
        // dieselbe Signatur (payload..., client) nutzen kann.
        Promise.resolve(imported.execute(...args, client)).catch((err) =>
          logger.error({ err, event: imported.name }, "Fehler bei Event-Ausführung")
        );
      };

      if (imported.once) {
        client.once(imported.name, handler);
      } else {
        client.on(imported.name, handler);
      }
      logger.info({ event: imported.name }, "Event geladen");
    } catch (err) {
      logger.error({ err, file }, "Fehler beim Laden eines Events");
    }
  }
}
