# Discord Security Bot

Öffentlicher, **multi-tenanter** Discord-Security-Bot (Anti-Nuke, AutoMod,
Lockdown, Logging) mit Discord.js v14, TypeScript, PostgreSQL und Prisma.

Der Bot läuft als **ein** Prozess für **alle** Server gleichzeitig. Multi-
Tenancy wird nicht über mehrere Instanzen gelöst, sondern dadurch, dass
**jede** Konfiguration, jeder In-Memory-Zähler und jeder Datenbank-Eintrag
strikt nach `guildId` partitioniert ist – siehe `GuildConfigService`,
`AntiNukeManager` und `AutoModManager`.

## Architektur

```
src/
  structures/        Discord-Client-Erweiterung, Prisma-Singleton
  modules/
    antiNuke/         Sliding-Window-Erkennung via Audit-Log-Events
    autoMod/           Regel-Engine, Wortlisten, Eskalationsleiter
    lockdown/          Permission-Snapshot & 1:1-Wiederherstellung
    logging/           Zentrales Security-Logging (DB + Discord-Embed)
    config/            Gecachte, guild-partitionierte Konfigurationsschicht
    dashboard/         Zentrales /dashboard (Buttons/Selects/Modals)
  commands/            Slash Commands
  events/              discord.js Event-Handler (inkl. Dashboard-Routing)
  handlers/            Command-/Event-Loader
prisma/schema.prisma   Vollständig guild-partitioniertes Datenmodell
config/wordlists/      Externe, vom Betreiber zu pflegende Wortlisten
```

## Wer darf welchen Command nutzen?

| Command | Berechtigung |
|---|---|
| `/lockdown` | **Immer nur** echte Discord-„Administrator“-Berechtigte. Bewusst NICHT über `/permissions` erweiterbar. |
| `/permissions` | **Immer nur** echte Discord-„Administrator“-Berechtigte (verwaltet ja das Berechtigungssystem selbst). |
| `/antinuke`, `/automod`, `/config`, `/dashboard` | Server-Owner, echte Administrator-Berechtigte, **oder** jede über `/permissions add-role` freigegebene Rolle. |

`/permissions add-role @Moderator` gibt der Rolle `@Moderator` also Zugriff auf
AutoMod/Anti-Nuke/Config/Dashboard, aber **nicht** auf Lockdown. Das ist
Absicht: Lockdown greift serverweit in alle Channel-Berechtigungen ein und
soll ausschließlich echten Administratoren vorbehalten bleiben.

## /dashboard

`/dashboard` zeigt eine zentrale, ephemere Übersicht (nur für den Aufrufer
sichtbar) mit Status aller Module und Buttons zur Verwaltung:

- **Anti-Nuke-Panel**: Auswahl eines Aktionstyps öffnet ein Modal zum
  direkten Ändern von Schwellenwert/Zeitfenster; eigenes Menü für die
  globale Standard-Gegenmaßnahme.
- **AutoMod-Panel**: Regel auswählen → an/aus togglen oder die
  Eskalationsleiter bearbeiten (Modal, ein Eintrag pro Zeile im Format
  `Verwarnung:Aktion:Dauer(s)`, z.B. `3:TIMEOUT:600`).
- **Lockdown-Panel**: reine Statusanzeige – Aktivierung/Aufhebung bleibt
  exklusiv `/lockdown` vorbehalten (siehe oben).
- **Logs-Panel**: paginierte Liste der letzten Security-Ereignisse.
- **Admin-Rollen-Panel**: Rollen per Auswahlmenü hinzufügen/entfernen.

Jede Dashboard-Aktion durchläuft dieselbe Berechtigungsprüfung wie die
entsprechenden Slash Commands – das Dashboard ist kein Weg, Berechtigungen
zu umgehen.

## Setup

1. **Abhängigkeiten installieren**
   ```bash
   npm install
   ```

2. **Umgebungsvariablen**
   ```bash
   cp .env.example .env
   # DISCORD_TOKEN, DISCORD_CLIENT_ID, DATABASE_URL ausfüllen
   ```

3. **Datenbank einrichten** (PostgreSQL muss laufen)
   ```bash
   npm run prisma:migrate
   ```

4. **Wortlisten befüllen** (optional, aber empfohlen)
   Siehe `config/wordlists/README.md`. Ohne befüllte Listen laufen die
   Regeln `INSULTS`, `DISCRIMINATION` und `PROFANITY` einfach leer.

5. **Slash Commands registrieren**
   ```bash
   npm run deploy-commands
   ```
   Mit gesetztem `DEV_GUILD_ID` in der `.env` werden die Commands sofort
   (nur) auf diesem Server verfügbar – praktisch für Entwicklung. Ohne
   `DEV_GUILD_ID` erfolgt eine globale Registrierung (Propagation kann bis
   zu 1h dauern), wie es für einen öffentlichen Bot auf vielen Servern
   nötig ist.

6. **Bot starten**
   ```bash
   npm run build && npm start
   # oder für Entwicklung mit Auto-Reload:
   npm run dev
   ```

## Wichtige Design-Entscheidungen

- **Anti-Nuke** hört auf das discord.js-Event `guildAuditLogEntryCreate`
  (Rohereignis `AUDIT_LOG_ENTRY_CREATE`). Das liefert den Verursacher
  direkt und zuverlässig, ohne zusätzliche, rate-limit-anfällige
  Audit-Log-Abfragen bei jedem einzelnen Channel-/Rollen-Event.
- Anti-Nuke **ignoriert die AutoMod-Whitelist bewusst und vollständig** –
  es gibt keinen Code-Pfad, der das umgeht.
- **Lockdown** wird ausschließlich über `/lockdown level1|level2|remove`
  ausgelöst, niemals automatisch. Vor dem Sperren wird für jeden
  betroffenen Channel die **komplette** Liste aller Permission-Overwrites
  in der DB gesichert; beim Aufheben wird sie per
  `permissionOverwrites.set()` atomar 1:1 zurückgeschrieben – kein
  simples Toggle von `SEND_MESSAGES`.
- **Race Conditions**: AntiNuke nutzt einen Lock (`Set<"guildId:userId">`)
  während der Bestrafung, AutoMod erhöht Verstoßzähler über einen
  atomaren `upsert`/`increment` in der Datenbank, Lockdown-Snapshot +
  State-Update laufen in einer Prisma-`$transaction`.
- **Fehlertoleranz**: DB-Fehler beim Konfigurations-Laden fallen auf den
  letzten bekannten Cache-Stand bzw. sichere Defaults zurück, statt den
  Bot für eine ganze Guild lahmzulegen. Logging-Fehler unterbrechen nie
  die eigentliche Sicherheitsaktion (Punishment wird immer zuerst
  ausgeführt).

## Bekannte Grenzen / Erweiterungspunkte

- `NSFW`-Erkennung ist aktuell eine reine Text-Heuristik. Für Bild-/Video-
  Analyse sollte ein dedizierter Moderations-Dienst per API angebunden
  werden (Anhänge sind über `message.attachments` verfügbar).
- `SCAM_LINKS` nutzt statische Muster; für aktuelle Bedrohungen empfiehlt
  sich die Anbindung einer extern gepflegten, regelmäßig aktualisierten
  Blockliste.
- `PERMANENT_TIMEOUT` nutzt das technische Discord-Maximum von 28 Tagen
  (Discord erlaubt keine unbegrenzten Timeouts) und müsste durch einen
  periodischen Job verlängert werden, um wirklich dauerhaft zu sein.
