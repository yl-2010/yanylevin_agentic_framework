/**
 * Append every chat turn (user prompt + LLM output) to data/chat-log.md
 * locally on the Mac Studio. Not committed to git.
 *
 * Append-only: never rewrite existing history.
 */

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFullAccessEmail } from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(ROOT, "data", "chat-log.md");
const PACIFIC_TZ = "America/Los_Angeles";

/** @param {string|null|undefined} email */
export function isChatLogViewer(email) {
  return isFullAccessEmail(email);
}

function lastUserContent(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return messages[i].content;
  }
  return "";
}

function fence(text) {
  const body = String(text ?? "");
  const ticks = body.includes("```") ? "````" : "```";
  return `${ticks}\n${body}\n${ticks}`;
}

/** Soft visitor fingerprint from request signals (not a cookie). */
export function visitorApproxHash({
  ip = "",
  userAgent = "",
  acceptLanguage = "",
  country = "",
} = {}) {
  const raw = [ip, userAgent, acceptLanguage, country]
    .map((s) => String(s ?? "").trim().toLowerCase())
    .join("|");
  if (!raw.replace(/\|/g, "")) return "(unknown)";
  return createHash("sha256").update(raw).digest("hex").slice(0, 12);
}

/** Count user turns in the conversation (1-based for the current prompt). */
export function turnIndex(messages) {
  return (messages || []).filter((m) => m?.role === "user").length;
}

/**
 * Normalize a client session id. Accepts UUID / hex / url-safe tokens.
 * @returns {string} short display id, or "(none)"
 */
export function normalizeSessionId(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "(none)";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(s)) return "(none)";
  // Prefer a short scannable form when given a full UUID.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return s.slice(0, 8).toLowerCase();
  }
  return s.length > 12 ? s.slice(0, 12) : s;
}

/**
 * Human-readable Pacific time, e.g. "Wed, Jul 29, 2026 · 9:05:12 PM PDT"
 * @param {Date|string|number} [when]
 */
export function formatPacificTime(when = new Date()) {
  const date = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(date.getTime())) return "(invalid time)";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  const weekday = get("weekday");
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const hour = get("hour");
  const minute = get("minute");
  const second = get("second");
  const dayPeriod = get("dayPeriod");
  const tz = get("timeZoneName");

  return `${weekday}, ${month} ${day}, ${year} · ${hour}:${minute}:${second} ${dayPeriod} ${tz}`;
}

/**
 * Build the markdown block for one chat turn (does not write to disk).
 * @param {object} opts
 */
export function formatChatLogBlock({
  messages,
  assistantContent,
  model = "",
  ip = "",
  userAgent = "",
  acceptLanguage = "",
  country = "",
  referer = "",
  sessionId = "",
  at = new Date(),
} = {}) {
  const userPrompt = lastUserContent(messages || []);
  const session = normalizeSessionId(sessionId);
  const turn = turnIndex(messages);
  const visitor = visitorApproxHash({ ip, userAgent, acceptLanguage, country });
  const when = formatPacificTime(at);
  const iso = (at instanceof Date ? at : new Date(at)).toISOString();

  const meta = [
    `- session: \`${session}\``,
    `- turn: ${turn}`,
    `- visitorApprox: \`${visitor}\``,
    `- ip: ${ip || "(unknown)"}`,
    `- country: ${country || "(unknown)"}`,
    `- language: ${acceptLanguage || "(unknown)"}`,
    `- user-agent: ${userAgent || "(unknown)"}`,
    `- referer: ${referer || "(none)"}`,
    `- model: ${model || "(unknown)"}`,
    `- utc: ${iso}`,
  ];

  return [
    "",
    `## Session \`${session}\` · Turn ${turn}`,
    "",
    `**${when}**`,
    "",
    ...meta,
    "",
    "### User",
    "",
    fence(userPrompt),
    "",
    "### Assistant",
    "",
    fence(assistantContent),
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages conversation (no system)
 * @param {string} opts.assistantContent
 * @param {string} [opts.model]
 * @param {string} [opts.ip]
 * @param {string} [opts.userAgent]
 * @param {string} [opts.acceptLanguage]
 * @param {string} [opts.country]
 * @param {string} [opts.referer]
 * @param {string} [opts.sessionId]
 */
export async function appendChatTurn(opts = {}) {
  const block = formatChatLogBlock(opts);
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, block, "utf8");
}

export function getChatLogPath() {
  return LOG_PATH;
}

/**
 * Unfence a ``` / ```` markdown code block body.
 * @param {string} text
 */
function unfence(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/^`{3,4}[^\n]*\n([\s\S]*?)\n`{3,4}$/);
  return match ? match[1] : raw;
}

/**
 * Parse one chat-log turn block (content between ## headings / --- separators).
 * @param {string} block
 * @returns {object|null}
 */
export function parseChatLogBlock(block) {
  const text = String(block ?? "").trim();
  if (!text) return null;

  const headingMatch = text.match(/^##\s+(.+)$/m);
  const heading = headingMatch ? headingMatch[1].trim() : "";

  let session = "";
  let turn = null;
  const sessionTurn = heading.match(
    /^Session\s+`([^`]+)`\s*·\s*Turn\s+(\d+)/i
  );
  if (sessionTurn) {
    session = sessionTurn[1];
    turn = Number(sessionTurn[2]);
  }

  const whenMatch = text.match(/\*\*([^*]+)\*\*/);
  const when = whenMatch ? whenMatch[1].trim() : "";

  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^- ([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    let val = m[2].trim();
    const tick = val.match(/^`([^`]*)`$/);
    if (tick) val = tick[1];
    meta[key] = val;
  }

  if (!session && meta.session) session = meta.session;
  if (turn == null && meta.turn && /^\d+$/.test(meta.turn)) {
    turn = Number(meta.turn);
  }

  const userMatch = text.match(
    /###\s*User\s*\n+([\s\S]*?)(?=\n###\s*Assistant\b|\n---\s*$|$)/i
  );
  const assistantMatch = text.match(
    /###\s*Assistant\s*\n+([\s\S]*?)(?=\n---\s*$|$)/i
  );

  const user = userMatch ? unfence(userMatch[1]) : "";
  const assistant = assistantMatch ? unfence(assistantMatch[1]) : "";

  if (!user && !assistant && !when && !heading) return null;

  return {
    heading: heading || when || "(entry)",
    when: when || heading || "",
    session: session || "(none)",
    turn: turn ?? null,
    utc: meta.utc || null,
    model: meta.model || null,
    ip: meta.ip || null,
    country: meta.country || null,
    language: meta.language || null,
    userAgent: meta["user-agent"] || null,
    referer: meta.referer || null,
    visitorApprox: meta.visitorapprox || null,
    user,
    assistant,
  };
}

/**
 * Parse the full chat-log.md into structured entries (oldest → newest).
 * @param {string} markdown
 * @returns {object[]}
 */
export function parseChatLog(markdown) {
  const raw = String(markdown ?? "");
  if (!raw.trim()) return [];

  // Split on markdown H2 boundaries; keep each ##… block.
  const parts = raw.split(/\n(?=##\s)/);
  const entries = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("##")) continue;
    // Drop trailing --- separators inside the block
    const cleaned = trimmed.replace(/\n---\s*$/, "").trim();
    const entry = parseChatLogBlock(cleaned);
    if (entry) entries.push(entry);
  }
  return entries;
}

/**
 * Read + parse chat-log.md from disk.
 * @returns {Promise<{ entries: object[], mtimeMs: number|null, size: number }>}
 */
export async function readChatLog() {
  try {
    const [text, info] = await Promise.all([
      readFile(LOG_PATH, "utf8"),
      stat(LOG_PATH),
    ]);
    return {
      entries: parseChatLog(text),
      mtimeMs: info.mtimeMs,
      size: info.size,
    };
  } catch (err) {
    if (err && err.code === "ENOENT") {
      return { entries: [], mtimeMs: null, size: 0 };
    }
    throw err;
  }
}
