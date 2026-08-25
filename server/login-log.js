/**
 * Append every successful Google login to data/login-log.md
 * locally on the Mac Studio. Not committed to git.
 *
 * Append-only: never rewrite existing history.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPacificTime, isChatLogViewer } from "./chat-log.js";
import { canonicalizeEmail } from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PATH = join(ROOT, "data", "login-log.md");
const PLACEHOLDER_EMAILS = new Set(["visitor@yanylevin.com"]);

export { isChatLogViewer as isLoginLogViewer };

export function isPlaceholderLoginEmail(email) {
  return PLACEHOLDER_EMAILS.has(String(email ?? "").trim().toLowerCase());
}

/**
 * Build the markdown block for one login (does not write to disk).
 * @param {{ email: string, at?: Date|string|number }} opts
 */
export function formatLoginLogBlock({ email, at = new Date() } = {}) {
  const normalized = canonicalizeEmail(email);
  if (!normalized || !normalized.includes("@")) {
    throw new Error("email required");
  }
  if (isPlaceholderLoginEmail(normalized)) {
    throw new Error("placeholder email not logged");
  }
  const when = formatPacificTime(at);
  const iso = (at instanceof Date ? at : new Date(at)).toISOString();

  return [
    "",
    "## Login",
    "",
    `**${when}**`,
    "",
    `- email: \`${normalized}\``,
    `- utc: ${iso}`,
    "",
    "---",
    "",
  ].join("\n");
}

/**
 * @param {{ email: string, at?: Date|string|number }} opts
 * @returns {Promise<{ appended: boolean, email: string }>}
 */
export async function appendLogin(opts = {}) {
  const email = canonicalizeEmail(opts.email);
  const at = opts.at ?? new Date();

  if (!email || !email.includes("@")) {
    throw new Error("email required");
  }

  if (isPlaceholderLoginEmail(email)) {
    return { appended: false, email };
  }

  // Dedupe rapid repeats (OAuth + dashboard one-shot, double-loads).
  try {
    const { entries } = await readLoginLog();
    const last = entries[entries.length - 1];
    if (last?.email === email && last.utc) {
      const prev = Date.parse(last.utc);
      const now = (at instanceof Date ? at : new Date(at)).getTime();
      if (Number.isFinite(prev) && now - prev < 5 * 60 * 1000) {
        return { appended: false, email };
      }
    }
  } catch {
    /* proceed to append */
  }

  const block = formatLoginLogBlock({ email, at });
  await mkdir(dirname(LOG_PATH), { recursive: true });
  await appendFile(LOG_PATH, block, "utf8");
  return { appended: true, email };
}

export function getLoginLogPath() {
  return LOG_PATH;
}

/**
 * Parse one login-log block.
 * @param {string} block
 * @returns {{ email: string, when: string, utc: string|null }|null}
 */
export function parseLoginLogBlock(block) {
  const text = String(block ?? "").trim();
  if (!text) return null;

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

  const email = String(meta.email || "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) return null;

  return {
    email,
    when: when || "",
    utc: meta.utc || null,
  };
}

/**
 * Parse the full login-log.md into structured entries (oldest → newest).
 * @param {string} markdown
 * @returns {object[]}
 */
export function parseLoginLog(markdown) {
  const raw = String(markdown ?? "");
  if (!raw.trim()) return [];

  const parts = raw.split(/\n(?=##\s)/);
  const entries = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed.startsWith("##")) continue;
    const cleaned = trimmed.replace(/\n---\s*$/, "").trim();
    const entry = parseLoginLogBlock(cleaned);
    if (entry && !isPlaceholderLoginEmail(entry.email)) entries.push(entry);
  }
  return entries;
}

/**
 * Read + parse login-log.md from disk.
 * @returns {Promise<{ entries: object[], mtimeMs: number|null, size: number }>}
 */
export async function readLoginLog() {
  try {
    const [text, info] = await Promise.all([
      readFile(LOG_PATH, "utf8"),
      stat(LOG_PATH),
    ]);
    return {
      entries: parseLoginLog(text),
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
