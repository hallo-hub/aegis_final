import { PrismaClient } from "@prisma/client";

/**
 * Singleton für den Prisma-Client.
 *
 * Wir halten genau eine Instanz für den gesamten Prozess, da Prisma intern
 * bereits ein Connection-Pooling betreibt. Mehrere Instanzen würden nur
 * unnötig zusätzliche DB-Connections aufbauen - bei einem Multi-Tenant-Bot
 * mit vielen Guilds ist das besonders relevant.
 */
class PrismaService {
  private static instance: PrismaClient;

  public static getInstance(): PrismaClient {
    if (!PrismaService.instance) {
      PrismaService.instance = new PrismaClient({
        log:
          process.env.NODE_ENV === "development"
            ? ["warn", "error"]
            : ["error"],
      });
    }
    return PrismaService.instance;
  }

  public static async disconnect(): Promise<void> {
    if (PrismaService.instance) {
      await PrismaService.instance.$disconnect();
    }
  }
}

export const prisma = PrismaService.getInstance();
export default PrismaService;
