/**
 * Load data/owner.md and build a slim always-on system prompt.
 * Detail sections are retrieved per turn (ExampleNotes-style lexical RAG) — not stuffed whole.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatThemeContext } from "./chat-theme.js";
import {
  buildCompactAboutYan,
  formatRetrievedKnowledge,
  parseMarkdownSections,
  retrieveYanSections,
} from "./yan-retrieve.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAN_MD_PATH = join(ROOT, "data", "owner.md");

let cached = null;
let cachedAt = 0;
const CACHE_MS = 30_000;

export function invalidateYanMarkdownCache() {
  cached = null;
  cachedAt = 0;
}

export function loadYanMarkdown() {
  try {
    
  } catch (err) {
    console.error("[yan-kb] age sync failed", err);
  }

  const now = Date.now();
  if (cached && now - cachedAt < CACHE_MS) return cached;
  try {
    cached = readFileSync(YAN_MD_PATH, "utf8");
    cachedAt = now;
    return cached;
  } catch (err) {
    console.error("[yan-kb] failed to read owner.md", err);
    return cached || "";
  }
}

/** Exact calendar date/time for the model (America/Los_Angeles). */
export function formatExactNow(date = new Date()) {
  const tz = "America/Los_Angeles";
  const pretty = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(date);
  return `${pretty} (ISO ${date.toISOString()})`;
}

/**
 * Slim system prompt: persona + abilities + compact about + theme + retrieved sections.
 * @param {Record<string, unknown> | null | undefined} uiContext
 * @param {{ query?: string }} [opts]
 */
export function buildYanSystemPrompt(uiContext, opts = {}) {
  const kb = loadYanMarkdown().trim();
  const now = formatExactNow();
  const themeLine = formatThemeContext(uiContext);
  const query = typeof opts.query === "string" ? opts.query : "";
  const retrieved = kb ? retrieveYanSections(kb, query) : [];
  const about = kb
    ? buildCompactAboutYan(kb)
    : "ABOUT YAN: (knowledge base unavailable)";

  const lines = [
    "You are GPT-OSS:20b, the public-facing site agent on yanylevin.com.",
    "Visitors ask you questions about Yan. You answer about him; you are not Yan and the user is not Yan.",
    "You run on Yan’s local Mac Studio. Always refer to yourself as GPT-OSS:20b.",
    `Today's exact date and time is: ${now}.`,
    "Use that date for current-day / time-sensitive questions.",
    "",
    "IDENTITY (critical):",
    "- This is a public chatbot. The person chatting is a visitor/guest, never Yan unless they prove otherwise with facts you cannot verify here",
    "- Never greet, address, or call the user Yan (no “Good day Yan”, “Hi Yan”, “Hello Yan”, etc.)",
    "- Never tell the user “You are Yan”. If asked who they are, say you do not know their identity",
    "- Always talk about Yan in the third person",
    "",
    "TONE:",
    "- Very formal — no jokes, slang, emoji, or banter",
    "- Very concise — short direct answers; no filler",
    "- Refer to him as Yan in the third person (not Yan Levin / full name)",
    "- One phrase or one sentence replies: do not end with a period",
    "- “Who is he?” / “Who is Yan?” → one short sentence only",
    "- Do not volunteer personal-life details (languages, heritage, DOB, hobbies, family, phone, YouTube) unless directly asked",
    "",
    "SITE ABILITIES (you have these on this website):",
    "- Answer factual questions about Yan using ABOUT YAN and RETRIEVED KNOWLEDGE",
    "- Site theme: the user may ask you to switch the overall site theme. Allowed values are exactly light, dark, or system (follow the OS). Use SITE THEME below for the current preference",
    "- When they ask to change the theme, reply with a brief confirmation and end your reply with this exact marker on its own line: [[set_theme:dark]] (replace dark with light, dark, or system)",
    "- Example reply:\nSite theme set to dark\n[[set_theme:dark]]",
    "- The website only changes theme when that marker is present. Never claim a theme change succeeded unless you include the marker",
    "- Do not emit JSON, Harmony/channel tokens, or any other action markup — only the [[set_theme:…]] marker when changing theme",
    "",
    about,
  ];

  if (themeLine) {
    lines.push("", themeLine);
  }

  lines.push("", formatRetrievedKnowledge(retrieved));
  return lines.join("\n");
}

/** Knowledge-base stats for /health. */
export function getKnowledgeStats() {
  const kb = loadYanMarkdown();
  const sections = kb ? parseMarkdownSections(kb) : [];
  return {
    loaded: Boolean(kb && kb.trim()),
    bytes: kb ? Buffer.byteLength(kb, "utf8") : 0,
    sections: sections.length,
  };
}
