import {
  Guild,
  ChannelType,
  PermissionOverwriteOptions,
  OverwriteType,
  EmbedBuilder,
  Colors,
  TextChannel,
  GuildChannel,
  PermissionsBitField,
  CategoryChannel,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { LockdownLevel, Prisma } from "@prisma/client";
import { SecurityClient } from "../../structures/SecurityClient";
import logger from "../../utils/logger";

interface SerializedOverwrite {
  id: string;
  type: OverwriteType;
  allow: string;
  deny: string;
}

/**
 * Lockdown-Modul.
 *
 * WICHTIG: Es gibt HIER keinerlei automatische Aktivierung - dieses Modul
 * wird ausschließlich durch die /lockdown Slash Commands (siehe
 * src/commands/lockdown) angesteuert, die ihrerseits eine
 * Administrator-Berechtigung voraussetzen.
 *
 * Kernprinzip der Wiederherstellung: Wir sichern für JEDEN betroffenen
 * Channel die VOLLSTÄNDIGE Liste aller PermissionOverwrites (nicht nur ein
 * einzelnes Flag) als JSON-Snapshot in der DB. Beim Aufheben wird die
 * komplette Overwrite-Liste eines Channels per `permissionOverwrites.set()`
 * atomar durch den gespeicherten Ursprungszustand ersetzt - damit gehen
 * garantiert keine individuellen Überschreibungen verloren und es bleiben
 * auch keine während des Lockdowns hinzugefügten Overwrites zurück.
 */
export class LockdownManager {
  public constructor(private readonly client: SecurityClient) {}

  public async isActive(guildId: string): Promise<boolean> {
    const state = await this.client.prisma.lockdownState.findUnique({ where: { guildId } });
    return state?.active ?? false;
  }

  /** Voller Lockdown-Status für das Dashboard (aktiv/inaktiv, Level, Grund, wer/wann). */
  public async getStatus(guildId: string) {
    return this.client.prisma.lockdownState.findUnique({ where: { guildId } });
  }

  public async activate(
    guild: Guild,
    level: LockdownLevel,
    reason: string,
    activatedById: string
  ): Promise<{ success: boolean; message: string }> {
    const current = await this.client.prisma.lockdownState.findUnique({ where: { guildId: guild.id } });
    if (current?.active) {
      return { success: false, message: "Es läuft bereits ein Lockdown auf diesem Server. Bitte zuerst `/lockdown remove` ausführen." };
    }

    const channels = await guild.channels.fetch();
    const targetChannels: GuildChannel[] = [];

    for (const channel of channels.values()) {
      if (!channel) continue;
      if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement || channel.type === ChannelType.GuildForum) {
        targetChannels.push(channel);
      } else if (level === "LEVEL2" && (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)) {
        targetChannels.push(channel);
      }
    }

    const lockdownRunId = randomUUID();

    try {
      // 1) ALLE betroffenen Channels snapshotten, BEVOR irgendetwas verändert wird.
      //    Läuft als eine DB-Transaktion, damit entweder der komplette
      //    Snapshot besteht oder gar keiner (kein halbfertiger, inkonsistenter Zustand).
      const snapshotData = targetChannels.map((channel) => ({
        guildId: guild.id,
        lockdownRunId,
        channelId: channel.id,
        channelType: channel.type,
        overwrites: this.serializeOverwrites(channel) as unknown as Prisma.InputJsonValue,
      }));

      await this.client.prisma.$transaction([
        this.client.prisma.lockdownSnapshot.createMany({ data: snapshotData }),
        this.client.prisma.lockdownState.upsert({
          where: { guildId: guild.id },
          update: {
            active: true,
            level,
            reason,
            activatedById,
            activatedAt: new Date(),
          },
          create: {
            guildId: guild.id,
            active: true,
            level,
            reason,
            activatedById,
            activatedAt: new Date(),
          },
        }),
      ]);

      // 2) Erst NACH erfolgreichem Snapshot die eigentlichen Sperren setzen.
      await this.applyLocks(guild, targetChannels, level);

      // 3) Incident-Channel erstellen
      const incidentChannel = await this.createIncidentChannel(guild, level, reason, activatedById);
      if (incidentChannel) {
        await this.client.prisma.lockdownState.update({
          where: { guildId: guild.id },
          data: { incidentChannelId: incidentChannel.id },
        });
      }

      const embed = new EmbedBuilder()
        .setTitle("🔒 Lockdown aktiviert")
        .setColor(Colors.Red)
        .setTimestamp(new Date())
        .addFields(
          { name: "Was", value: level === "LEVEL1" ? "Level 1 (nur Textkanäle)" : "Level 2 (Text- & Sprachkanäle)", inline: true },
          { name: "Wer", value: `<@${activatedById}>`, inline: true },
          { name: "Warum", value: reason, inline: false }
        );

      await this.client.securityLog.log({
        guildId: guild.id,
        type: "LOCKDOWN_ACTIVATED",
        actorId: activatedById,
        data: { Level: level, Grund: reason, "Betroffene Kanäle": targetChannels.length },
        embed,
      });

      return { success: true, message: `Lockdown (${level}) für ${targetChannels.length} Kanäle aktiviert.` };
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Lockdown-Aktivierung fehlgeschlagen");
      // Bei einem Fehler versuchen wir, einen bereits gespeicherten,
      // aber nicht angewendeten Zustand nicht inkonsistent stehen zu lassen.
      await this.client.prisma.lockdownState
        .updateMany({ where: { guildId: guild.id }, data: { active: false } })
        .catch(() => undefined);
      return { success: false, message: "Lockdown konnte nicht vollständig aktiviert werden. Details siehe Bot-Logs." };
    }
  }

  public async deactivate(guild: Guild, deactivatedById: string): Promise<{ success: boolean; message: string }> {
    const state = await this.client.prisma.lockdownState.findUnique({ where: { guildId: guild.id } });
    if (!state?.active) {
      return { success: false, message: "Es läuft aktuell kein Lockdown auf diesem Server." };
    }

    const runSnapshots = await this.client.prisma.lockdownSnapshot.findMany({
      where: { guildId: guild.id },
      orderBy: { createdAt: "desc" },
    });

    // Nur die Snapshots der zuletzt aktivierten Lockdown-Runde verwenden.
    const latestRunId = runSnapshots[0]?.lockdownRunId;
    const relevantSnapshots = runSnapshots.filter((s) => s.lockdownRunId === latestRunId);

    let restoredCount = 0;
    let failedCount = 0;

    for (const snapshot of relevantSnapshots) {
      try {
        const channel = await guild.channels.fetch(snapshot.channelId).catch(() => null);
        if (!channel) {
          failedCount++;
          continue;
        }
        const overwrites = (snapshot.overwrites as unknown as SerializedOverwrite[]).map((o) => ({
          id: o.id,
          type: o.type,
          allow: BigInt(o.allow),
          deny: BigInt(o.deny),
        }));
        // .set() ersetzt ALLE Overwrites des Channels atomar - garantiert
        // exakte 1:1-Wiederherstellung des Ursprungszustands.
        await (channel as GuildChannel).permissionOverwrites.set(overwrites, "Lockdown aufgehoben - Wiederherstellung der ursprünglichen Berechtigungen");
        restoredCount++;
      } catch (err) {
        logger.error({ err, channelId: snapshot.channelId }, "Konnte Permissions für Channel nicht wiederherstellen");
        failedCount++;
      }
    }

    // Incident-Channel schließen/archivieren statt löschen, damit die
    // Historie (was/wann/warum/wer) nachvollziehbar bleibt.
    if (state.incidentChannelId) {
      const incidentChannel = await guild.channels.fetch(state.incidentChannelId).catch(() => null);
      if (incidentChannel && incidentChannel instanceof TextChannel) {
        await incidentChannel
          .send({ embeds: [new EmbedBuilder().setTitle("🔓 Lockdown aufgehoben").setColor(Colors.Green).setTimestamp(new Date()).setDescription(`Aufgehoben von <@${deactivatedById}>`)] })
          .catch(() => undefined);
        await incidentChannel.permissionOverwrites
          .edit(guild.roles.everyone, { SendMessages: false, ViewChannel: false })
          .catch(() => undefined);
      }
    }

    await this.client.prisma.$transaction([
      this.client.prisma.lockdownState.update({
        where: { guildId: guild.id },
        data: { active: false, level: null, reason: null, activatedById: null, activatedAt: null, incidentChannelId: null },
      }),
      this.client.prisma.lockdownSnapshot.deleteMany({ where: { guildId: guild.id, lockdownRunId: latestRunId } }),
    ]);

    const embed = new EmbedBuilder()
      .setTitle("🔓 Lockdown aufgehoben")
      .setColor(Colors.Green)
      .setTimestamp(new Date())
      .addFields(
        { name: "Wer", value: `<@${deactivatedById}>`, inline: true },
        { name: "Wiederhergestellt", value: `${restoredCount} Kanäle`, inline: true },
        ...(failedCount > 0 ? [{ name: "⚠️ Fehlgeschlagen", value: `${failedCount} Kanäle - bitte manuell prüfen`, inline: true }] : [])
      );

    await this.client.securityLog.log({
      guildId: guild.id,
      type: "LOCKDOWN_DEACTIVATED",
      actorId: deactivatedById,
      data: { "Wiederhergestellte Kanäle": restoredCount, "Fehlgeschlagen": failedCount },
      embed,
    });

    return {
      success: true,
      message:
        failedCount > 0
          ? `Lockdown aufgehoben. ${restoredCount} Kanäle wiederhergestellt, ${failedCount} fehlgeschlagen - bitte Bot-Logs prüfen.`
          : `Lockdown aufgehoben. Alle ${restoredCount} Kanäle wurden exakt wiederhergestellt.`,
    };
  }

  private serializeOverwrites(channel: GuildChannel): SerializedOverwrite[] {
    return channel.permissionOverwrites.cache.map((ow) => ({
      id: ow.id,
      type: ow.type,
      allow: ow.allow.bitfield.toString(),
      deny: ow.deny.bitfield.toString(),
    }));
  }

  private async applyLocks(guild: Guild, channels: GuildChannel[], level: LockdownLevel): Promise<void> {
    const everyone = guild.roles.everyone;

    for (const channel of channels) {
      try {
        const isVoice = channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice;
        const overwrite: PermissionOverwriteOptions = isVoice
          ? { Connect: false, Speak: false }
          : { SendMessages: false, SendMessagesInThreads: false, AddReactions: false };

        // .edit() MERGED nur die angegebenen Flags in die bestehende
        // @everyone-Overwrite (bzw. legt eine neue an, falls keine
        // existiert) - der vollständige Ursprungszustand wurde zuvor
        // bereits separat gesichert und wird beim Aufheben 1:1 restauriert.
        await channel.permissionOverwrites.edit(everyone, overwrite, { reason: `Lockdown ${level}` });
      } catch (err) {
        logger.error({ err, channelId: channel.id }, "Konnte Channel nicht sperren");
      }
    }
  }

  private async createIncidentChannel(
    guild: Guild,
    level: LockdownLevel,
    reason: string,
    activatedById: string
  ): Promise<TextChannel | null> {
    try {
      const categoryId = await this.client.guildConfig.getIncidentCategoryId(guild.id);
      let parent: CategoryChannel | null = null;
      if (categoryId) {
        const fetched = await guild.channels.fetch(categoryId).catch(() => null);
        if (fetched && fetched.type === ChannelType.GuildCategory) parent = fetched;
      }

      const channel = await guild.channels.create({
        name: `inc-${Date.now().toString().slice(-6)}`,
        type: ChannelType.GuildText,
        parent: parent ?? undefined,
        topic: "Lockdown Incident-Kanal - automatisch erstellt",
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            allow: [PermissionsBitField.Flags.ViewChannel],
            deny: [PermissionsBitField.Flags.SendMessages],
          },
        ],
        reason: "Lockdown aktiviert",
      });

      const embed = new EmbedBuilder()
        .setTitle("🔒 Server-Lockdown aktiv")
        .setColor(Colors.Red)
        .setTimestamp(new Date())
        .addFields(
          { name: "Was", value: level === "LEVEL1" ? "Level 1 - Textkanäle gesperrt" : "Level 2 - Text- & Sprachkanäle gesperrt", inline: false },
          { name: "Wann", value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
          { name: "Warum", value: reason, inline: false },
          { name: "Wer", value: `<@${activatedById}>`, inline: false }
        )
        .setFooter({ text: "Dieser Kanal ist für alle sichtbar, aber schreibgeschützt." });

      await channel.send({ embeds: [embed] });
      return channel;
    } catch (err) {
      logger.error({ err, guildId: guild.id }, "Konnte Incident-Channel nicht erstellen");
      return null;
    }
  }
}
