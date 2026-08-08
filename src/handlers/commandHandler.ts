import fs from "node:fs";
import path from "node:path";
import { SecurityClient } from "../structures/SecurityClient";
import { Command } from "../types/Command";
import logger from "../utils/logger";

function findCommandFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files = files.concat(findCommandFiles(fullPath));
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) && !entry.name.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function loadCommands(client: SecurityClient): Promise<void> {
  const commandsDir = path.join(__dirname, "..", "commands");
  const files = findCommandFiles(commandsDir);

  for (const file of files) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const imported = await import(file);
      const command: Command | undefined = imported.command;
      if (!command?.data?.name) {
        logger.warn({ file }, "Datei im commands-Ordner exportiert kein gültiges Command - übersprungen");
        continue;
      }
      client.commands.set(command.data.name, command);
      logger.info({ command: command.data.name }, "Command geladen");
    } catch (err) {
      logger.error({ err, file }, "Fehler beim Laden eines Commands");
    }
  }
}

/** Sammelt alle geladenen Commands als JSON für die Registrierung bei Discord. */
export function getCommandJSONData(client: SecurityClient) {
  return [...client.commands.values()].map((c) => c.data.toJSON());
}
