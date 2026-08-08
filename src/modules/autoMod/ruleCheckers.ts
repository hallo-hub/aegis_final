import { Message } from "discord.js";
import { AutoModRule, AutoModRuleType } from "@prisma/client";
import { SlidingWindowTracker } from "./MessageWindowTracker";
import { containsListedTerm } from "./wordlists";

export interface RuleViolation {
  violated: boolean;
  reason: string;
}

const NO_VIOLATION: RuleViolation = { violated: false, reason: "" };

// Bekannte Invite-Domains
const INVITE_REGEX = /(discord\.gg|discord(?:app)?\.com\/invite|dsc\.gg)\/[a-z0-9-]+/i;

// Sehr generische Link-Erkennung (http/https + Domain)
const LINK_REGEX = /https?:\/\/[^\s]+/gi;

// Typische, bereits öffentlich bekannte Scam-/Phishing-Domain-Muster
// (z.B. Steam-/Nitro-Grabber-Kampagnen). Bewusst als Muster statt fester
// Domainliste, da Scammer Domains täglich wechseln - echte Erkennung
// sollte perspektivisch eine extern gepflegte Blockliste/API nutzen
// (z.B. über einen konfigurierbaren Webhook/Service).
const SCAM_PATTERNS = [
  /discorcl\.com/i,
  /discordapp\.(net|xyz|gift|click)/i,
  /steamcommunlty\.com/i,
  /discord-nitro\.[a-z]{2,}/i,
  /free-?nitro\.[a-z]{2,}/i,
];

// Discord Bot-/User-Token-Muster (grobe Heuristik, keine Garantie)
const TOKEN_REGEX = /[MNO][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,40}/g;

const MENTION_REGEX = /<@!?\d+>/g;
const EMOJI_REGEX = /<a?:\w+:\d+>|\p{Extended_Pictographic}/gu;

function stripCodeBlocks(content: string): string {
  return content.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
}

export interface CheckContext {
  message: Message;
  rule: AutoModRule;
  tracker: SlidingWindowTracker;
}

type Checker = (ctx: CheckContext) => RuleViolation;

const checkers: Record<AutoModRuleType, Checker> = {
  SPAM: ({ message, rule, tracker }) => {
    const windowSeconds = rule.windowSeconds ?? 8;
    const maxCount = rule.maxCount ?? 5;
    const count = tracker.recordAndCount(message.guildId!, "SPAM", message.author.id, windowSeconds);
    if (count >= maxCount) {
      return { violated: true, reason: `${count} Nachrichten in ${windowSeconds}s (Limit: ${maxCount})` };
    }
    return NO_VIOLATION;
  },

  DUPLICATE_SPAM: ({ message, rule, tracker }) => {
    const windowSeconds = rule.windowSeconds ?? 30;
    const maxCount = rule.maxCount ?? 3;
    if (!message.content.trim()) return NO_VIOLATION;
    const count = tracker.recordAndCountDuplicates(message.guildId!, message.author.id, message.content, windowSeconds);
    if (count >= maxCount) {
      return { violated: true, reason: `${count}x identische Nachricht in ${windowSeconds}s (Limit: ${maxCount})` };
    }
    return NO_VIOLATION;
  },

  CAPS_SPAM: ({ message, rule }) => {
    const content = stripCodeBlocks(message.content);
    const letters = content.replace(/[^A-Za-zÀ-ÖØ-öø-ÿ]/g, "");
    if (letters.length < 10) return NO_VIOLATION; // zu kurz für sinnvolle Prozent-Bewertung
    const upper = letters.replace(/[^A-ZÀ-Ö Ø-Þ]/g, "");
    const percentage = Math.round((upper.length / letters.length) * 100);
    const maxPercentage = rule.maxPercentage ?? 70;
    if (percentage >= maxPercentage) {
      return { violated: true, reason: `${percentage}% Großbuchstaben (Limit: ${maxPercentage}%)` };
    }
    return NO_VIOLATION;
  },

  EMOJI_SPAM: ({ message, rule }) => {
    const matches = message.content.match(EMOJI_REGEX) ?? [];
    const maxCount = rule.maxCount ?? 10;
    if (matches.length >= maxCount) {
      return { violated: true, reason: `${matches.length} Emojis in einer Nachricht (Limit: ${maxCount})` };
    }
    return NO_VIOLATION;
  },

  MENTION_SPAM: ({ message, rule }) => {
    const matches = message.content.match(MENTION_REGEX) ?? [];
    const uniqueTargets = new Set(matches);
    const maxCount = rule.maxCount ?? 5;
    if (uniqueTargets.size >= maxCount) {
      return { violated: true, reason: `${uniqueTargets.size} Erwähnungen in einer Nachricht (Limit: ${maxCount})` };
    }
    return NO_VIOLATION;
  },

  INVITE_LINKS: ({ message }) => {
    if (INVITE_REGEX.test(message.content)) {
      return { violated: true, reason: "Discord-Invite-Link erkannt" };
    }
    return NO_VIOLATION;
  },

  SCAM_LINKS: ({ message }) => {
    const hit = SCAM_PATTERNS.find((p) => p.test(message.content));
    if (hit) {
      return { violated: true, reason: "Bekanntes Scam-/Phishing-Linkmuster erkannt" };
    }
    return NO_VIOLATION;
  },

  ADVERTISING: ({ message }) => {
    const hasInvite = INVITE_REGEX.test(message.content);
    const hasOtherServerAd = /\b(join|joint?)\s+(my|our)\s+(server|discord)\b/i.test(message.content);
    if (hasInvite || hasOtherServerAd) {
      return { violated: true, reason: "Werbung für externen Server erkannt" };
    }
    return NO_VIOLATION;
  },

  NSFW: ({ message }) => {
    // Reine Text-Heuristik als Grundschutz. Für echte Bild-/Video-Analyse
    // sollte ein dedizierter NSFW-Bilderkennungsdienst per API angebunden
    // werden (Anhänge über message.attachments verfügbar) - bewusst als
    // Erweiterungspunkt ausgelagert, um keine unzuverlässige Bilderkennung
    // vorzutäuschen.
    const nsfwKeywords = /\b(nsfw|porn|xxx)\b/i;
    if (nsfwKeywords.test(message.content)) {
      return { violated: true, reason: "Potenziell NSFW-Inhalt (Text-Heuristik) erkannt" };
    }
    return NO_VIOLATION;
  },

  INSULTS: ({ message }) => {
    const result = containsListedTerm("insults", message.content.toLowerCase());
    if (result.hit) return { violated: true, reason: "Beleidigung erkannt" };
    return NO_VIOLATION;
  },

  DISCRIMINATION: ({ message }) => {
    const result = containsListedTerm("discrimination", message.content.toLowerCase());
    if (result.hit) return { violated: true, reason: "Diskriminierender Begriff erkannt" };
    return NO_VIOLATION;
  },

  PROFANITY: ({ message }) => {
    const result = containsListedTerm("profanity", message.content.toLowerCase());
    if (result.hit) return { violated: true, reason: "Schimpfwort erkannt" };
    return NO_VIOLATION;
  },

  UNAUTHORIZED_LINKS: ({ message, rule }) => {
    const links = message.content.match(LINK_REGEX) ?? [];
    if (links.length === 0) return NO_VIOLATION;
    // exemptChannelIds wird bereits vorher (Manager) geprüft; hier zusätzlich
    // eine einfache Allowlist über die Regel-Exceptions denkbar (Erweiterung).
    void rule;
    return { violated: true, reason: `Nicht erlaubter Link erkannt (${links.length})` };
  },

  TOKEN_LEAK: ({ message }) => {
    TOKEN_REGEX.lastIndex = 0;
    if (TOKEN_REGEX.test(message.content)) {
      return { violated: true, reason: "Mögliches Discord-Token in Nachricht erkannt" };
    }
    return NO_VIOLATION;
  },
};

export function runRuleCheck(ctx: CheckContext): RuleViolation {
  const checker = checkers[ctx.rule.type];
  if (!checker) return NO_VIOLATION;
  return checker(ctx);
}
