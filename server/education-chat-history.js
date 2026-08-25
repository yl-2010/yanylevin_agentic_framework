/**
 * Indefinite text transcripts for Personal Agent chats.
 * Stored under education/<email>/.chat-history/. Unsaved uploads still
 * expire with the in-memory session; these markdown files do not.
 */

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail } from "./identity.js";
import { formatWidgetsAsFences, parseAgentReply } from "./chat-widgets.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHAT_HISTORY_DIRNAME = ".chat-history";
export const CHAT_HISTORY_READ_FILENAME = ".read.json";
export const TITLE_MAX = 40;
const PREVIEW_MAX = 80;
const RECENT_LIMIT = 12;
const LIST_MAX = 500;

/**
 * @param {string} email
 * @returns {string}
 */
export function chatHistoryDirRel(email) {
  return `education/${canonicalizeEmail(email)}/${CHAT_HISTORY_DIRNAME}`;
}

/**
 * @param {unknown} sessionId
 * @returns {string}
 */
export function sanitizeSessionId(sessionId) {
  const s = String(sessionId || "").trim();
  if (!/^[a-zA-Z0-9._-]{8,80}$/.test(s)) return "";
  return s;
}

/**
 * @param {string} email
 * @param {unknown} sessionId
 * @returns {string}
 */
export function chatHistoryFileRel(email, sessionId) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return "";
  return `${chatHistoryDirRel(email)}/${sid}.md`;
}

/**
 * @param {string} email
 * @returns {string}
 */
export function chatHistoryReadFileRel(email) {
  return `${chatHistoryDirRel(email)}/${CHAT_HISTORY_READ_FILENAME}`;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function isoOrNow(raw) {
  const s = String(raw || "").trim();
  if (s && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  return new Date().toISOString();
}

/**
 * @param {unknown} content
 * @returns {string}
 */
function messageBody(content) {
  const text = String(content || "").trim();
  return text || "(empty)";
}

/**
 * One-line thread title for the history list.
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeChatTitle(raw) {
  let s = String(raw || "")
    .trim()
    .split(/\r?\n/)[0]
    .trim();
  s = s.replace(/^["'`“”]+|["'`“”]+$/g, "");
  s = s.replace(/[—–]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.!?]+$/g, "").trim();
  if (s.length > TITLE_MAX) {
    s = s.slice(0, TITLE_MAX).replace(/\s+\S*$/, "").trim();
  }
  return s;
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function fallbackChatTitle(raw) {
  return sanitizeChatTitle(raw) || String(raw || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

/**
 * UI list visibility. Missing or unknown values are showing.
 * Hidden threads stay on disk; listChatHistory omits them.
 * @param {unknown} raw
 * @returns {'showing'|'hidden'}
 */
export function sanitizeChatVisibility(raw) {
  const s = String(raw || "")
    .trim()
    .toLowerCase();
  return s === "hidden" ? "hidden" : "showing";
}

/**
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   messages?: { role?: string, content?: string, at?: string, widgets?: object[] }[],
 *   startedAt?: string,
 *   updatedAt?: string,
 *   title?: string,
 *   visibility?: string,
 * }} opts
 */
export function formatChatHistoryMarkdown(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const messages = Array.isArray(opts?.messages) ? opts.messages : [];
  const updatedAt = isoOrNow(opts?.updatedAt);
  const startedAt = isoOrNow(
    opts?.startedAt || messages.find((m) => m?.at)?.at || updatedAt
  );
  const title = sanitizeChatTitle(opts?.title);
  const visibility = sanitizeChatVisibility(opts?.visibility);
  /** @type {string[]} */
  const lines = [
    "# Personal Agent chat",
    `session: ${sessionId}`,
    `email: ${email}`,
    `started: ${startedAt}`,
    `updated: ${updatedAt}`,
  ];
  if (title) lines.push(`title: ${title}`);
  lines.push(`visibility: ${visibility}`);
  lines.push("");
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const who = m.role === "assistant" ? "Assistant" : "User";
    const at = m.at ? isoOrNow(m.at) : updatedAt;
    lines.push(`## ${who} — ${at}`);
    lines.push(messageBody(m.content));
    const fences = formatWidgetsAsFences(m.widgets);
    if (fences) {
      lines.push("");
      lines.push(fences);
    }
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * @param {string} markdown
 * @returns {{
 *   session: string,
 *   email: string,
 *   started: string,
 *   updated: string,
 *   title: string,
 *   visibility: 'showing'|'hidden',
 *   preview: string,
 * }}
 */
export function parseChatHistoryMeta(markdown) {
  const text = String(markdown || "");
  const field = (key) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\S+)`, "m"));
    return m ? m[1] : "";
  };
  const titleMatch = text.match(/^title:\s+(.+)$/m);
  let preview = "";
  const userIdx = text.search(/^## User\b/m);
  if (userIdx >= 0) {
    const after = text.slice(userIdx);
    const body = after.split("\n").slice(1).join("\n");
    const nextHeading = body.search(/^## /m);
    const chunk = (nextHeading >= 0 ? body.slice(0, nextHeading) : body).trim();
    preview = chunk.replace(/\s+/g, " ").slice(0, PREVIEW_MAX);
  }
  return {
    session: field("session"),
    email: field("email"),
    started: field("started"),
    updated: field("updated"),
    title: sanitizeChatTitle(titleMatch ? titleMatch[1] : ""),
    visibility: sanitizeChatVisibility(field("visibility")),
    preview,
  };
}

const MESSAGE_HEADING_RE = /^## (User|Assistant) — (.+)$/gm;

/**
 * @param {string} markdown
 * @returns {{ role: 'user'|'assistant', content: string, at: string, widgets?: object[] }[]}
 */
export function parseChatHistoryMessages(markdown) {
  const text = String(markdown || "");
  /** @type {{ role: 'user'|'assistant', content: string, at: string, widgets?: object[] }[]} */
  const messages = [];
  const matches = [...text.matchAll(MESSAGE_HEADING_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const who = m[1];
    const at = isoOrNow(m[2]);
    const start = (m.index || 0) + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end).replace(/^\r?\n/, "").trim();
    const role = who === "Assistant" ? "assistant" : "user";
    if (role === "assistant") {
      const parsed = parseAgentReply(body);
      /** @type {{ role: 'user'|'assistant', content: string, at: string, widgets?: object[] }} */
      const row = {
        role,
        content: parsed.content || (parsed.widgets.length ? "" : body || "(empty)"),
        at,
      };
      if (parsed.widgets.length) row.widgets = parsed.widgets;
      messages.push(row);
    } else {
      messages.push({ role, content: body || "(empty)", at });
    }
  }
  return messages;
}

/**
 * @param {{
 *   email: string,
 *   currentSessionId?: string,
 *   recent?: { sessionId: string, updated: string, preview: string, title?: string, visibility?: string }[],
 * }} opts
 */
export function formatChatHistoryHint(opts) {
  const email = canonicalizeEmail(opts?.email);
  const dir = chatHistoryDirRel(email);
  const current = sanitizeSessionId(opts?.currentSessionId);
  const recent = Array.isArray(opts?.recent) ? opts.recent : [];
  /** @type {string[]} */
  const lines = [
    "Past Personal Agent chats (text kept forever; the UI lists showing threads and can reopen them):",
    `Folder: ${dir}/  — Grep/Read when earlier chats could matter (callbacks, last time, decisions, unfinished work). Do not recap unprompted. Do not read another user's .chat-history/. Unsaved chat uploads still expire with the session.`,
    "To hide a thread from the iOS/web chat history list, set visibility: hidden in that file header (add the line after title: or updated: if missing). Do not delete the file. Default is showing.",
  ];
  if (current) {
    lines.push(`This thread file: ${dir}/${current}.md`);
  }
  const others = recent.filter(
    (row) => row && sanitizeSessionId(row.sessionId) && row.sessionId !== current
  );
  if (!others.length) {
    lines.push("Older threads: none yet.");
    return lines.join("\n");
  }
  lines.push("Older threads:");
  for (const row of others.slice(0, RECENT_LIMIT)) {
    const sid = sanitizeSessionId(row.sessionId);
    const when = String(row.updated || "").trim() || "unknown";
    const label =
      sanitizeChatTitle(row.title) ||
      String(row.preview || "").trim() ||
      "(no preview)";
    const hidden =
      sanitizeChatVisibility(row.visibility) === "hidden" ? "  (hidden)" : "";
    lines.push(`- ${when}  ${sid}.md  ${label}${hidden}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} [root]
 */
function resolveRoot(root) {
  const explicit = String(root || "").trim();
  return explicit || ROOT;
}

/**
 * @param {unknown} updated
 * @param {unknown} lastRead
 * @returns {boolean}
 */
export function chatHistoryIsUnread(updated, lastRead) {
  const u = Date.parse(String(updated || ""));
  const r = Date.parse(String(lastRead || ""));
  if (!Number.isFinite(u) || !Number.isFinite(r)) return false;
  return u > r;
}

/**
 * @param {{ email: string, root?: string }} opts
 * @returns {Promise<Record<string, string>>}
 */
export async function loadChatLastReadMap(opts) {
  const email = canonicalizeEmail(opts?.email);
  if (!email) return {};
  const abs = join(resolveRoot(opts?.root), chatHistoryReadFileRel(email));
  let text;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return {};
    }
    throw err;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const sid = sanitizeSessionId(key);
    const iso = String(value || "").trim();
    if (!sid || !iso || Number.isNaN(Date.parse(iso))) continue;
    out[sid] = new Date(iso).toISOString();
  }
  return out;
}

/**
 * @param {{ email: string, root?: string, map: Record<string, string> }} opts
 */
async function writeChatLastReadMap(opts) {
  const email = canonicalizeEmail(opts?.email);
  if (!email) return;
  const rel = chatHistoryReadFileRel(email);
  const abs = join(resolveRoot(opts?.root), rel);
  await mkdir(dirname(abs), { recursive: true });
  const map = opts?.map && typeof opts.map === "object" ? opts.map : {};
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [key, value] of Object.entries(map)) {
    const sid = sanitizeSessionId(key);
    const iso = String(value || "").trim();
    if (!sid || !iso || Number.isNaN(Date.parse(iso))) continue;
    clean[sid] = new Date(iso).toISOString();
  }
  await writeFile(abs, `${JSON.stringify(clean, null, 2)}\n`, "utf8");
}

/**
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   at?: string,
 *   root?: string,
 * }} opts
 * @returns {Promise<string|null>}
 */
export async function markChatHistoryRead(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  if (!email || !sessionId) return null;
  const at = isoOrNow(opts?.at);
  const map = await loadChatLastReadMap(opts);
  map[sessionId] = at;
  await writeChatLastReadMap({ ...opts, email, map });
  return at;
}

/**
 * First persist: lastRead matches this write so the new thread is not unread.
 * Later persist with no lastRead yet: snapshot the previous updated so the
 * new bubbles become unread without backfilling every old thread.
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   isNew: boolean,
 *   previousUpdated?: string,
 *   updatedAt: string,
 *   root?: string,
 * }} opts
 */
async function rememberChatHistoryReadOnPersist(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  if (!email || !sessionId) return;
  const map = await loadChatLastReadMap(opts);
  if (map[sessionId]) return;
  if (opts?.isNew) {
    map[sessionId] = isoOrNow(opts?.updatedAt);
  } else {
    map[sessionId] = isoOrNow(opts?.previousUpdated || opts?.updatedAt);
  }
  await writeChatLastReadMap({ ...opts, email, map });
}

/**
 * Overlay live working ids onto list rows. Working wins over unread.
 * @param {{ sessionId?: string, unread?: boolean }[]} chats
 * @param {Iterable<string>|Set<string>} workingIds
 */
export function applyChatWorkingStatus(chats, workingIds) {
  const working = workingIds instanceof Set ? workingIds : new Set(workingIds || []);
  return (chats || []).map((row) => {
    const sid = String(row?.sessionId || "");
    const isWorking = Boolean(sid && working.has(sid));
    return {
      ...row,
      working: isWorking,
      unread: isWorking ? false : Boolean(row?.unread),
    };
  });
}

/**
 * Rewrite the session markdown from the committed transcript.
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   messages: { role?: string, content?: string, at?: string, widgets?: object[] }[],
 *   root?: string,
 *   title?: string,
 *   visibility?: string,
 * }} opts
 */
export async function persistChatHistory(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const messages = Array.isArray(opts?.messages) ? opts.messages : [];
  if (!email || !sessionId || !messages.length) return null;

  const rel = chatHistoryFileRel(email, sessionId);
  const abs = join(resolveRoot(opts?.root), rel);
  await mkdir(dirname(abs), { recursive: true });

  let startedAt = "";
  let title = sanitizeChatTitle(opts?.title);
  const requestedVisibility = String(opts?.visibility || "").trim();
  let visibility = requestedVisibility
    ? sanitizeChatVisibility(requestedVisibility)
    : "";
  let previousUpdated = "";
  let isNew = false;
  try {
    const existing = await readFile(abs, "utf8");
    const meta = parseChatHistoryMeta(existing);
    startedAt = meta.started;
    previousUpdated = meta.updated;
    if (!title) title = meta.title;
    if (!visibility) visibility = meta.visibility;
  } catch {
    isNew = true;
  }

  const updatedAt = new Date().toISOString();
  await rememberChatHistoryReadOnPersist({
    email,
    sessionId,
    isNew,
    previousUpdated,
    updatedAt,
    root: opts?.root,
  });

  const markdown = formatChatHistoryMarkdown({
    email,
    sessionId,
    messages,
    startedAt,
    updatedAt,
    title,
    visibility: visibility || "showing",
  });
  await writeFile(abs, markdown, "utf8");
  return rel;
}

/**
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   title: string,
 *   root?: string,
 * }} opts
 * @returns {Promise<string|null>}
 */
export async function patchChatHistoryTitle(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const title = sanitizeChatTitle(opts?.title);
  const rel = chatHistoryFileRel(email, sessionId);
  if (!email || !sessionId || !title || !rel) return null;
  const abs = join(resolveRoot(opts?.root), rel);
  let text;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let next;
  if (/^title:\s+/m.test(text)) {
    next = text.replace(/^title:\s+.*$/m, `title: ${title}`);
  } else {
    next = text.replace(/^(updated:\s+\S+)\s*$/m, `$1\ntitle: ${title}`);
  }
  if (next === text) return title;
  await writeFile(abs, next, "utf8");
  return title;
}

/**
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   visibility: string,
 *   root?: string,
 * }} opts
 * @returns {Promise<'showing'|'hidden'|null>}
 */
export async function patchChatHistoryVisibility(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const requested = String(opts?.visibility || "")
    .trim()
    .toLowerCase();
  if (requested !== "hidden" && requested !== "showing") return null;
  const visibility = sanitizeChatVisibility(requested);
  const rel = chatHistoryFileRel(email, sessionId);
  if (!email || !sessionId || !rel) return null;
  const abs = join(resolveRoot(opts?.root), rel);
  let text;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  let next;
  if (/^visibility:\s+/m.test(text)) {
    next = text.replace(/^visibility:\s+.*$/m, `visibility: ${visibility}`);
  } else if (/^title:\s+/m.test(text)) {
    next = text.replace(/^(title:\s+.+)$/m, `$1\nvisibility: ${visibility}`);
  } else {
    next = text.replace(/^(updated:\s+\S+)\s*$/m, `$1\nvisibility: ${visibility}`);
  }
  if (next === text) return visibility;
  await writeFile(abs, next, "utf8");
  return visibility;
}

/**
 * @param {{ email: string, sessionId: string, root?: string }} opts
 * @returns {Promise<{
 *   sessionId: string,
 *   title: string,
 *   visibility: 'showing'|'hidden',
 *   started: string,
 *   updated: string,
 *   preview: string,
 *   messages: { role: 'user'|'assistant', content: string, at: string, widgets?: object[] }[],
 * }|null>}
 */
export async function loadChatHistory(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const rel = chatHistoryFileRel(email, sessionId);
  if (!email || !sessionId || !rel) return null;
  const abs = join(resolveRoot(opts?.root), rel);
  let text;
  try {
    text = await readFile(abs, "utf8");
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return null;
    }
    throw err;
  }
  const meta = parseChatHistoryMeta(text);
  return {
    sessionId,
    title: meta.title,
    visibility: meta.visibility,
    started: meta.started,
    updated: meta.updated,
    preview: meta.preview,
    messages: parseChatHistoryMessages(text),
  };
}

/**
 * @param {{
 *   email: string,
 *   excludeSessionId?: string,
 *   limit?: number,
 *   root?: string,
 * }} opts
 */
async function readChatHistoryRows(opts) {
  const email = canonicalizeEmail(opts?.email);
  const exclude = sanitizeSessionId(opts?.excludeSessionId);
  const dir = join(resolveRoot(opts?.root), chatHistoryDirRel(email));
  let names;
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  /** @type {{
   *   sessionId: string,
   *   title: string,
   *   visibility: 'showing'|'hidden',
   *   updated: string,
   *   preview: string,
   *   started: string,
   *   mtimeMs: number,
   * }[]} */
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const sessionId = sanitizeSessionId(name.slice(0, -3));
    if (!sessionId || sessionId === exclude) continue;
    const abs = join(dir, name);
    try {
      const [st, text] = await Promise.all([stat(abs), readFile(abs, "utf8")]);
      const meta = parseChatHistoryMeta(text);
      rows.push({
        sessionId,
        title: meta.title,
        visibility: meta.visibility,
        updated: meta.updated || new Date(st.mtimeMs).toISOString(),
        preview: meta.preview,
        started: meta.started,
        mtimeMs: st.mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  rows.sort(
    (a, b) =>
      Date.parse(b.updated) - Date.parse(a.updated) ||
      b.mtimeMs - a.mtimeMs ||
      a.sessionId.localeCompare(b.sessionId)
  );
  return rows;
}

/**
 * @param {{ updated?: string, started?: string, mtimeMs?: number }} row
 * @returns {number}
 */
export function chatHistoryTouchMs(row) {
  const updated = Date.parse(String(row?.updated || ""));
  if (Number.isFinite(updated)) return updated;
  const started = Date.parse(String(row?.started || ""));
  if (Number.isFinite(started)) return started;
  const mtime = Number(row?.mtimeMs);
  return Number.isFinite(mtime) ? mtime : 0;
}

/**
 * Full file rows for title refresh (path included).
 * @param {{
 *   email: string,
 *   excludeSessionId?: string,
 *   root?: string,
 * }} opts
 */
export async function listChatHistoryFiles(opts) {
  const email = canonicalizeEmail(opts?.email);
  const rows = await readChatHistoryRows(opts);
  const dir = chatHistoryDirRel(email);
  return rows.map((row) => ({
    ...row,
    email,
    path: `${dir}/${row.sessionId}.md`,
  }));
}

/**
 * @param {{
 *   email: string,
 *   excludeSessionId?: string,
 *   limit?: number,
 *   root?: string,
 * }} opts
 */
export async function listRecentChatHistory(opts) {
  const limit = Math.max(1, Math.min(40, Number(opts?.limit) || RECENT_LIMIT));
  const rows = await readChatHistoryRows(opts);
  return rows.slice(0, limit).map(
    ({ sessionId, updated, preview, title, visibility }) => ({
      sessionId,
      updated,
      preview,
      title,
      visibility,
    })
  );
}

/**
 * Full list for the past-chats UI (newest first).
 * @param {{
 *   email: string,
 *   excludeSessionId?: string,
 *   limit?: number,
 *   root?: string,
 * }} opts
 */
export async function listChatHistory(opts) {
  const limit = Math.max(1, Math.min(LIST_MAX, Number(opts?.limit) || LIST_MAX));
  const rows = await readChatHistoryRows(opts);
  const lastRead = await loadChatLastReadMap(opts);
  return rows
    .filter((row) => row.visibility !== "hidden")
    .slice(0, limit)
    .map(({ sessionId, title, updated, preview, started }) => ({
      sessionId,
      title,
      updated,
      preview,
      started,
      unread: chatHistoryIsUnread(updated, lastRead[sessionId]),
    }));
}

/**
 * @param {string} iso
 * @param {Date} [now]
 * @returns {string}
 */
export function relativeChatAge(iso, now = new Date()) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const ms = now.getTime() - d.getTime();
  if (ms < 60 * 1000) return "now";
  const mins = Math.floor(ms / (60 * 1000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return "";
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
function zonedDateKey(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/**
 * @param {string} iso
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ key: string, label: string, showAge: boolean }}
 */
export function chatHistoryGroup(
  iso,
  now = new Date(),
  timeZone = "America/Los_Angeles"
) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return { key: "older", label: "Older", showAge: false };
  }
  const that = zonedDateKey(d, timeZone);
  const today = zonedDateKey(now, timeZone);
  if (that === today) {
    return { key: "today", label: "Today", showAge: true };
  }
  const thatNoon = Date.parse(`${that}T12:00:00.000Z`);
  const todayNoon = Date.parse(`${today}T12:00:00.000Z`);
  const diffDays = Math.round((todayNoon - thatNoon) / 86400000);
  if (diffDays === 1) {
    return { key: that, label: "Yesterday", showAge: false };
  }
  if (diffDays > 1 && diffDays < 7) {
    const label = d.toLocaleDateString("en-US", {
      timeZone,
      weekday: "long",
    });
    return { key: that, label, showAge: false };
  }
  return { key: "older", label: "Older", showAge: false };
}

/**
 * @param {{ sessionId: string, updated: string }[]} chats
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ key: string, label: string, showAge: boolean, chats: typeof chats }[]}
 */
export function groupChatHistory(
  chats,
  now = new Date(),
  timeZone = "America/Los_Angeles"
) {
  const list = Array.isArray(chats) ? chats : [];
  /** @type {Map<string, { key: string, label: string, showAge: boolean, chats: typeof list }>} */
  const byKey = new Map();
  /** @type {{ key: string, label: string, showAge: boolean, chats: typeof list }[]} */
  const sections = [];
  for (const chat of list) {
    const g = chatHistoryGroup(chat?.updated, now, timeZone);
    let sec = byKey.get(g.key);
    if (!sec) {
      sec = { key: g.key, label: g.label, showAge: g.showAge, chats: [] };
      byKey.set(g.key, sec);
      sections.push(sec);
    }
    sec.chats.push(chat);
  }
  return sections;
}

/**
 * @param {{ email: string, currentSessionId?: string, root?: string }} opts
 */
export async function loadChatHistoryHint(opts) {
  const email = canonicalizeEmail(opts?.email);
  const currentSessionId = sanitizeSessionId(opts?.currentSessionId);
  const recent = await listRecentChatHistory({
    email,
    excludeSessionId: currentSessionId,
    root: opts?.root,
  });
  return formatChatHistoryHint({ email, currentSessionId, recent });
}
