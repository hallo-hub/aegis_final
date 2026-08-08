import pino from "pino";

/**
 * Prozess-Logger (Konsole/Datei), NICHT zu verwechseln mit dem
 * Discord-Security-Logging-Modul (src/modules/logging), das
 * sicherheitsrelevante Ereignisse in Discord-Channels und die DB schreibt.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
      : undefined,
});

export default logger;
