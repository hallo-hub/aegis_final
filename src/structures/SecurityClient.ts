import {
  Client,
  ClientOptions,
  Collection,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { PrismaClient } from "@prisma/client";
import { prisma } from "./PrismaService";
import { AntiNukeManager } from "../modules/antiNuke/AntiNukeManager";
import { AutoModManager } from "../modules/autoMod/AutoModManager";
import { LockdownManager } from "../modules/lockdown/LockdownManager";
import { SecurityLogger } from "../modules/logging/SecurityLogger";
import { GuildConfigService } from "../modules/config/GuildConfigService";
import { DashboardManager } from "../modules/dashboard/DashboardManager";
import { Command } from "../types/Command";
import logger from "../utils/logger";

/**
 * SecurityClient erweitert den Standard discord.js Client um:
 *  - eine Command-Collection (Slash Commands)
 *  - Zugriff auf Prisma
 *  - die zentralen Modul-Manager (AntiNuke, AutoMod, Lockdown, Logging)
 *
 * Der Bot ist bewusst als EIN Prozess für ALLE Guilds gebaut (Standard bei
 * öffentlichen Discord-Bots). Multi-Tenancy wird nicht über mehrere
 * Prozesse/Instanzen gelöst, sondern dadurch, dass jeder Manager intern
 * strikt nach guildId partitioniert (siehe jeweilige Manager-Klassen).
 */
export class SecurityClient extends Client {
  public readonly prisma: PrismaClient = prisma;
  public readonly commands = new Collection<string, Command>();

  public readonly guildConfig: GuildConfigService;
  public readonly antiNuke: AntiNukeManager;
  public readonly autoMod: AutoModManager;
  public readonly lockdown: LockdownManager;
  public readonly securityLog: SecurityLogger;
  public readonly dashboard: DashboardManager;

  public constructor(options?: Partial<ClientOptions>) {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildWebhooks,
        GatewayIntentBits.GuildEmojisAndStickers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.Message, Partials.Channel, Partials.GuildMember],
      ...options,
    });

    this.guildConfig = new GuildConfigService(this.prisma);
    this.securityLog = new SecurityLogger(this);
    this.antiNuke = new AntiNukeManager(this);
    this.autoMod = new AutoModManager(this);
    this.lockdown = new LockdownManager(this);
    this.dashboard = new DashboardManager(this);
  }

  public async start(token: string): Promise<void> {
    process.on("unhandledRejection", (reason) => {
      logger.error({ reason }, "Unhandled promise rejection");
    });
    process.on("uncaughtException", (err) => {
      // Wir loggen, beenden den Prozess aber bewusst NICHT hart - ein
      // öffentlicher Security-Bot darf nicht wegen eines einzelnen Fehlers
      // auf allen Servern gleichzeitig offline gehen. Ein Process-Manager
      // (pm2/systemd) sollte dennoch als zusätzliches Sicherheitsnetz laufen.
      logger.error({ err }, "Uncaught exception");
    });

    await this.login(token);
  }
}
