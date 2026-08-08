import fs from "node:fs";
import path from "node:path";
import logger from "../../../utils/logger";

/**
 * Wortlisten für INSULTS / DISCRIMINATION / PROFANITY werden bewusst NICHT
 * hartkodiert im Code gepflegt, sondern aus externen JSON-Dateien geladen:
 *
 *   config/wordlists/insults.json
 *   config/wordlists/discrimination.json
 *   config/wordlists/profanity.json
 *
 * Format jeweils: string[] (Kleinschreibung, ein Begriff/Ausdruck pro Eintrag).
 * Diese Trennung hat mehrere Vorteile:
 *  - Der Betreiber kann Listen für seine Community/Sprache(n) selbst pflegen
 *    und aktualisieren, ohne den Bot neu zu deployen (Hot-Reload via
 *    reloadWordlists()).
 *  - Sensible Wortlisten landen nicht unkontrolliert im Git-Repository /
 *    Quellcode.
 *  - Unterschiedliche Server können (perspektivisch) eigene Zusatzlisten
 *    bekommen, ohne den Kern-Code anzufassen.
 *
 * Lege die drei Dateien vor dem ersten Start an (siehe
 * config/wordlists/README.md für das erwartete Format).
 */

const WORDLIST_DIR = path.resolve(process.cwd(), "config", "wordlists");

type WordlistName = "insults" | "discrimination" | "profanity";

let cache: Record<WordlistName, Set<string>> | null = null;

function loadListFile(name: WordlistName): Set<string> {
  const filePath = path.join(WORDLIST_DIR, `${name}.json`);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("Wordlist-Datei muss ein JSON-Array sein");
    return new Set(parsed.map((entry) => String(entry).toLowerCase().trim()).filter(Boolean));
  } catch (err) {
    logger.warn(
      { err, filePath },
      `Wordlist "${name}" konnte nicht geladen werden - Regel wird bis zur Bereitstellung der Datei effektiv leer ausgeführt.`
    );
    return new Set();
  }
}

function ensureLoaded(): Record<WordlistName, Set<string>> {
  if (!cache) {
    cache = {
      insults: loadListFile("insults"),
      discrimination: loadListFile("discrimination"),
      profanity: loadListFile("profanity"),
    };
  }
  return cache;
}

/** Erzwingt ein Neuladen aller Wortlisten von der Festplatte (z.B. per Admin-Command). */
export function reloadWordlists(): void {
  cache = null;
  ensureLoaded();
}

/**
 * Prüft einen (bereits kleingeschriebenen) Text auf Treffer aus der
 * angegebenen Liste. Nutzt Wortgrenzen, um Falsch-Positive bei
 * Teilstring-Treffern in unverwandten Wörtern zu reduzieren.
 */
export function containsListedTerm(name: WordlistName, normalizedText: string): { hit: boolean; term?: string } {
  const list = ensureLoaded()[name];
  if (list.size === 0) return { hit: false };

  for (const term of list) {
    if (!term) continue;
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
    if (pattern.test(normalizedText)) {
      return { hit: true, term };
    }
  }
  return { hit: false };
}
