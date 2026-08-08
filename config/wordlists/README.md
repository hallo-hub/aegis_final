# Wortlisten

Diese drei Dateien werden bewusst LEER ausgeliefert und müssen vom
Server-Betreiber selbst befüllt werden:

- `insults.json`        – Beleidigungen
- `discrimination.json` – diskriminierende Begriffe
- `profanity.json`      – Schimpfwörter

## Format

Jede Datei ist ein einfaches JSON-Array aus Strings (Kleinschreibung
empfohlen, Groß-/Kleinschreibung wird beim Prüfen ohnehin ignoriert):

```json
["beispielwort1", "beispielwort2", "mehrwortausdruck"]
```

## Hinweise

- Änderungen an diesen Dateien werden erst nach einem Neustart bzw.
  nach Aufruf des `/automod reload-wordlists` Admin-Commands aktiv
  (siehe `reloadWordlists()` in `src/modules/autoMod/wordlists/index.ts`).
- Die Erkennung nutzt Wortgrenzen (kein Treffer bei reinen Teilstrings
  innerhalb anderer, unverwandter Wörter), ist aber bewusst simpel
  gehalten. Für höhere Genauigkeit (Unicode-Obfuskation, Leetspeak,
  Kontext) empfiehlt sich die spätere Anbindung eines dedizierten
  Text-Moderation-Dienstes.
