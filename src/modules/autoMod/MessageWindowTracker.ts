/**
 * Generischer Sliding-Window-Tracker für nachrichtenbasierte AutoMod-Regeln
 * (Spam, Mention-Spam, Emoji-Spam, Duplicate-Spam).
 *
 * MULTI-TENANCY: Der State ist als
 * Map<"guildId:ruleType", Map<"userId[:channelId]", number[] | string[]>>
 * aufgebaut, sodass jede Guild/jeder Nutzer/jede Regel komplett isoliert
 * gezählt wird.
 */
export class SlidingWindowTracker {
  private numericWindows = new Map<string, Map<string, number[]>>();
  private contentWindows = new Map<string, Map<string, { content: string; ts: number }[]>>();

  private key(guildId: string, ruleType: string): string {
    return `${guildId}:${ruleType}`;
  }

  /** Zählt Ereignisse (z.B. Nachrichten) pro Nutzer in einem Zeitfenster und gibt die aktuelle Anzahl zurück. */
  public recordAndCount(
    guildId: string,
    ruleType: string,
    userId: string,
    windowSeconds: number
  ): number {
    const mapKey = this.key(guildId, ruleType);
    let userMap = this.numericWindows.get(mapKey);
    if (!userMap) {
      userMap = new Map();
      this.numericWindows.set(mapKey, userMap);
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const timestamps = (userMap.get(userId) ?? []).filter((t) => now - t <= windowMs);
    timestamps.push(now);
    userMap.set(userId, timestamps);
    return timestamps.length;
  }

  /** Zählt, wie oft derselbe Nachrichteninhalt innerhalb des Zeitfensters vom selben Nutzer gesendet wurde. */
  public recordAndCountDuplicates(
    guildId: string,
    userId: string,
    content: string,
    windowSeconds: number
  ): number {
    const mapKey = this.key(guildId, "DUPLICATE_SPAM");
    let userMap = this.contentWindows.get(mapKey);
    if (!userMap) {
      userMap = new Map();
      this.contentWindows.set(mapKey, userMap);
    }

    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const normalized = content.trim().toLowerCase();
    const entries = (userMap.get(userId) ?? []).filter((e) => now - e.ts <= windowMs);
    entries.push({ content: normalized, ts: now });
    userMap.set(userId, entries);

    return entries.filter((e) => e.content === normalized && normalized.length > 0).length;
  }

  /** Räumt periodisch veraltete Einträge auf, um Memory-Wachstum auf großen, aktiven Bots zu vermeiden. */
  public prune(maxAgeMs: number): void {
    const now = Date.now();
    for (const userMap of this.numericWindows.values()) {
      for (const [userId, timestamps] of userMap) {
        const fresh = timestamps.filter((t) => now - t <= maxAgeMs);
        if (fresh.length === 0) userMap.delete(userId);
        else userMap.set(userId, fresh);
      }
    }
    for (const userMap of this.contentWindows.values()) {
      for (const [userId, entries] of userMap) {
        const fresh = entries.filter((e) => now - e.ts <= maxAgeMs);
        if (fresh.length === 0) userMap.delete(userId);
        else userMap.set(userId, fresh);
      }
    }
  }
}
