/**
 * Indefinite text transcripts for Personal Agent chats.
 * Stored under education/<email>/.chat-history/. Unsaved uploads still
 * expire with the in-memory session; these markdown files do not.
 */

import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail } from "./identity.js";
import { formatWidgetsAsFences, parseAgentReply } from "./chat-widgets.js";
import { stripAgentSentFooter } from "./imessage-mention.js";
import {
  JYPE_ROOT_REL,
  jypeGivenName,
  normalizeJypeWorkspace,
} from "./jype.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CHAT_HISTORY_DIRNAME = ".chat-history";
export const CHAT_HISTORY_READ_FILENAME = ".read.json";
export const TITLE_MAX = 40;
/** History titles for future agents. The prefix sits outside TITLE_MAX. */
export const SCHEDULED_TITLE_PREFIX = "Scheduled: ";
const PREVIEW_MAX = 80;
const RECENT_LIMIT = 12;
const LIST_MAX = 500;
const CHAT_HISTORY_TZ = "America/Los_Angeles";
/** iMessage/Teams @agent threads drop from the UI list this long after the last persist. */
export const EPHEMERAL_HIDE_MS = 10 * 60 * 1000;

/**
 * @param {string} email
 * @returns {string}
 */
export function chatHistoryDirRel(email, workspace) {
  if (normalizeJypeWorkspace(workspace) === "jype") {
    return `${JYPE_ROOT_REL}/${CHAT_HISTORY_DIRNAME}`;
  }
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
export function chatHistoryFileRel(email, sessionId, workspace) {
  const sid = sanitizeSessionId(sessionId);
  if (!sid) return "";
  return `${chatHistoryDirRel(email, workspace)}/${sid}.md`;
}

/**
 * @param {string} email
 * @returns {string}
 */
export function chatHistoryReadFileRel(email, workspace) {
  return `${chatHistoryDirRel(email, workspace)}/${CHAT_HISTORY_READ_FILENAME}`;
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
function normalizeChatTitle(raw) {
  let s = String(raw || "")
    .trim()
    .split(/\r?\n/)[0]
    .trim();
  s = s.replace(/^["'`“”]+|["'`“”]+$/g, "");
  s = s.replace(/[—–]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[.!?]+$/g, "").trim();
  return s;
}

function clampChatTitle(s, max) {
  if (s.length > max) {
    s = s.slice(0, max).replace(/\s+\S*$/, "").trim();
  }
  return s;
}

export function sanitizeChatTitle(raw) {
  const s = normalizeChatTitle(raw);
  const lead = `${SCHEDULED_TITLE_PREFIX.toLowerCase()}`;
  if (s.toLowerCase().startsWith(lead)) {
    const rest = s.slice(SCHEDULED_TITLE_PREFIX.length).trim();
    const bare = clampChatTitle(rest, TITLE_MAX);
    return bare ? `${SCHEDULED_TITLE_PREFIX}${bare}` : "";
  }
  return clampChatTitle(s, TITLE_MAX);
}

/**
 * Force the Scheduled: prefix. The name after it still uses TITLE_MAX.
 * @param {unknown} title
 */
export function withScheduledTitlePrefix(title) {
  const s = sanitizeChatTitle(title);
  if (s.startsWith(SCHEDULED_TITLE_PREFIX)) return s;
  const bare = clampChatTitle(s, TITLE_MAX) || "Agent";
  return `${SCHEDULED_TITLE_PREFIX}${bare}`;
}

/**
 * First user bubble written when a future agent is scheduled.
 * Returns the task under the date line, or "".
 * @param {unknown} raw
 */
export function scheduledTaskFromUserMessage(raw) {
  const text = String(raw || "").trim();
  const match = text.match(/^Agent scheduled for .+:\s*\n+([\s\S]+)$/);
  return match ? String(match[1] || "").trim() : "";
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function fallbackChatTitle(raw) {
  return sanitizeChatTitle(raw) || String(raw || "").replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
}

export const CHAT_GUEST_WRAP_RE = /^From\s+(.+?)\s+on\s+(Teams|iMessage):\s*/i;

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * First given name from a guest @agent caller object.
 * @param {{ displayName?: string }|null|undefined} guest
 */
export function chatStarterFromGuest(guest) {
  return String(guest?.displayName || "")
    .trim()
    .split(/\s+/)[0] || "";
}

/**
 * Guest @agent first bubbles start with "From Name on Teams/iMessage:".
 * @param {unknown} raw
 */
export function starterFromGuestUserMessage(raw) {
  const s = String(raw || "").trim();
  const wrap = s.match(CHAT_GUEST_WRAP_RE);
  if (!wrap) return "";
  return String(wrap[1] || "")
    .trim()
    .split(/\s+/)[0] || "";
}

/**
 * Who the title should be attributed to.
 * JYPE always prefixes the person who started the thread.
 * Personal Agent only prefixes someone other than the folder owner
 * (guest @agent in a non-JYPE chat that lands in Yan's history).
 * @param {{
 *   workspace?: string,
 *   email?: string,
 *   starter?: string,
 *   guest?: { displayName?: string }|null,
 *   firstUserMessage?: string,
 * }} [opts]
 */
export function resolveChatStarter(opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const email = canonicalizeEmail(opts.email);
  const fromGuest = chatStarterFromGuest(opts.guest);
  const fromMessage = starterFromGuestUserMessage(opts.firstUserMessage);
  const named = String(fromGuest || fromMessage || opts.starter || "").trim();
  if (workspace === "jype") {
    return named || jypeGivenName(email) || "";
  }
  const owner = jypeGivenName(email);
  if (!named) return "";
  if (owner && named.toLowerCase() === owner.toLowerCase()) return "";
  return named;
}

export function stripChatTitlePrefix(title, starter) {
  const t = sanitizeChatTitle(title);
  const s = String(starter || "").trim();
  if (!s || !t) return t;
  const escaped = escapeRegExp(s);
  const colon = new RegExp(`^${escaped}:\\s*`, "i");
  let next = t.replace(colon, "").trim();
  if (next !== t) {
    next = next.replace(colon, "").trim();
    next = next.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }
  return next;
}

export function prefixChatTitle(title, starter) {
  const t = sanitizeChatTitle(title);
  const s = String(starter || "").trim();
  if (!s || !t) return t;
  const prefix = `${s}: `;
  if (t.toLowerCase().startsWith(prefix.toLowerCase())) return t;
  return sanitizeChatTitle(`${prefix}${t}`);
}

/**
 * Final list title: JYPE always `Name: …`. Personal Agent never `Yan:`.
 * Guest @agent in Yan's personal history keeps `Name:`.
 * @param {unknown} title
 * @param {{
 *   workspace?: string,
 *   email?: string,
 *   starter?: string,
 *   guest?: { displayName?: string }|null,
 *   firstUserMessage?: string,
 * }} [opts]
 */
export function applyChatTitleStarter(title, opts = {}) {
  const resolved = resolveChatStarter(opts);
  let t = sanitizeChatTitle(title);
  if (t.startsWith(SCHEDULED_TITLE_PREFIX)) return t;
  if (resolved) {
    return prefixChatTitle(stripChatTitlePrefix(t, resolved), resolved);
  }
  const owner = jypeGivenName(opts.email);
  if (owner) t = stripChatTitlePrefix(t, owner);
  return t;
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
 * iMessage/Teams @agent threads. Missing or unknown values are permanent.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function sanitizeChatEphemeral(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase();
  return s === "true" || s === "yes" || s === "1";
}

/**
 * Hide an @agent thread from the UI list once the reply has sat idle.
 * Working sessions stay listed. Talking from web/iOS clears ephemeral.
 * @param {{ sessionId?: string, ephemeral?: boolean, updated?: string }|null|undefined} row
 * @param {Date} [now]
 * @param {Iterable<string>|Set<string>|undefined} workingIds
 */
export function chatHistoryIsEphemeralHidden(row, now = new Date(), workingIds) {
  if (!row?.ephemeral) return false;
  const sid = String(row.sessionId || "");
  const working =
    workingIds instanceof Set ? workingIds : new Set(workingIds || []);
  if (sid && working.has(sid)) return false;
  const updated = Date.parse(String(row.updated || ""));
  if (!Number.isFinite(updated)) return false;
  const t = now instanceof Date ? now.getTime() : Date.now();
  return t - updated >= EPHEMERAL_HIDE_MS;
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
 *   ephemeral?: boolean,
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
  const ephemeral = sanitizeChatEphemeral(opts?.ephemeral);
  /** @type {string[]} */
  const lines = [
    "# Personal Agent chat",
    `session: ${sessionId}`,
    `email: ${email}`,
    `started: ${startedAt}`,
    `updated: ${updatedAt}`,
  ];
  if (title) lines.push(`title: ${title}`);
  const workspace = normalizeJypeWorkspace(opts?.workspace);
  if (workspace) lines.push(`workspace: ${workspace}`);
  const starter = String(opts?.starter || "").trim();
  if (starter) lines.push(`starter: ${starter}`);
  lines.push(`visibility: ${visibility}`);
  if (ephemeral) lines.push("ephemeral: true");
  if (opts?.scheduled) {
    lines.push("scheduled: true");
    const runAt = String(opts.scheduledRunAt || "").trim();
    if (runAt) lines.push(`scheduledRunAt: ${runAt}`);
    const status = String(opts.scheduledStatus || "").trim();
    if (status) lines.push(`scheduledStatus: ${status}`);
  }
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
 *   ephemeral: boolean,
 *   preview: string,
 *   workspace: string,
 *   starter: string,
 *   scheduled: boolean,
 *   scheduledRunAt: string,
 *   scheduledStatus: string,
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
    ephemeral: sanitizeChatEphemeral(field("ephemeral")),
    workspace: normalizeJypeWorkspace(field("workspace")),
    starter: field("starter"),
    scheduled: field("scheduled") === "true",
    scheduledRunAt: field("scheduledRunAt"),
    scheduledStatus: field("scheduledStatus"),
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
        content: stripAgentSentFooter(
          parsed.content || (parsed.widgets.length ? "" : body || "(empty)")
        ),
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
  const dir = chatHistoryDirRel(email, opts?.workspace);
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

const CHAT_TITLE_HEAD_BYTES = 2048;

/**
 * Title line from the top of a chat file. Messages stay unread.
 * @param {string} abs
 */
async function readChatTitleHead(abs) {
  const fh = await open(abs, "r");
  try {
    const buf = Buffer.alloc(CHAT_TITLE_HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, CHAT_TITLE_HEAD_BYTES, 0);
    return parseChatHistoryMeta(buf.slice(0, bytesRead).toString("utf8")).title;
  } finally {
    await fh.close();
  }
}

/**
 * Stored chat titles for session ids that already have one.
 * Personal Agent, @agent, and JYPE files. Empty titles are left out.
 * @param {Iterable<string>} sessionIds
 * @param {string} [root]
 * @returns {Promise<Record<string, string>>}
 */
export async function chatTitlesForSessions(sessionIds, root = ROOT) {
  /** @type {Set<string>} */
  const wanted = new Set();
  for (const id of sessionIds || []) {
    const sid = sanitizeSessionId(id);
    if (sid) wanted.add(sid);
  }
  /** @type {Record<string, string>} */
  const titles = {};
  if (!wanted.size) return titles;
  const edu = join(resolveRoot(root), "education");
  /** @type {string[]} */
  const dirs = [];
  let entries = [];
  try {
    entries = await readdir(edu, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !ent.name.includes("@")) continue;
    dirs.push(join(edu, ent.name, CHAT_HISTORY_DIRNAME));
  }
  dirs.push(join(edu, "projects", "jype", CHAT_HISTORY_DIRNAME));
  for (const dir of dirs) {
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const sessionId = sanitizeSessionId(name.slice(0, -3));
      if (!sessionId || !wanted.has(sessionId) || titles[sessionId]) continue;
      try {
        const title = await readChatTitleHead(join(dir, name));
        if (title) titles[sessionId] = title;
      } catch {
        /* unreadable chat */
      }
    }
  }
  return titles;
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
  const abs = join(resolveRoot(opts?.root), chatHistoryReadFileRel(email, opts?.workspace));
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
  const rel = chatHistoryReadFileRel(email, opts?.workspace);
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
  const prev = Date.parse(String(map[sessionId] || ""));
  const next = Date.parse(at);
  if (Number.isFinite(prev) && Number.isFinite(next) && prev >= next) {
    return map[sessionId];
  }
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
 *   ephemeral?: boolean,
 *   markRead?: boolean,
 * }} opts
 */
export async function persistChatHistory(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const messages = Array.isArray(opts?.messages) ? opts.messages : [];
  if (!email || !sessionId || !messages.length) return null;

  const rel = chatHistoryFileRel(email, sessionId, opts?.workspace);
  const abs = join(resolveRoot(opts?.root), rel);
  await mkdir(dirname(abs), { recursive: true });

  let startedAt = "";
  let title = sanitizeChatTitle(opts?.title);
  const requestedVisibility = String(opts?.visibility || "").trim();
  let visibility = requestedVisibility
    ? sanitizeChatVisibility(requestedVisibility)
    : "";
  let ephemeral = null;
  if (
    opts &&
    Object.prototype.hasOwnProperty.call(opts, "ephemeral") &&
    opts.ephemeral != null
  ) {
    ephemeral = sanitizeChatEphemeral(opts.ephemeral);
  }
  let previousUpdated = "";
  let isNew = false;
  let starter = String(opts?.starter || "").trim();
  let scheduled = opts?.scheduled === true ? true : opts?.scheduled === false ? false : null;
  let scheduledRunAt = String(opts?.scheduledRunAt || "").trim();
  let scheduledStatus = String(opts?.scheduledStatus || "").trim();
  try {
    const existing = await readFile(abs, "utf8");
    const meta = parseChatHistoryMeta(existing);
    startedAt = meta.started;
    previousUpdated = meta.updated;
    if (!title) title = meta.title;
    if (!visibility) visibility = meta.visibility;
    if (ephemeral == null) ephemeral = meta.ephemeral;
    if (!starter) starter = meta.starter;
    if (scheduled == null) scheduled = meta.scheduled;
    if (!scheduledRunAt) scheduledRunAt = meta.scheduledRunAt;
    if (!scheduledStatus) scheduledStatus = meta.scheduledStatus;
  } catch {
    isNew = true;
  }
  const firstUser =
    messages.find((m) => m.role === "user")?.content || "";
  starter = resolveChatStarter({
    email,
    workspace: opts?.workspace,
    starter,
    firstUserMessage: firstUser,
  });
  if (title) {
    title = applyChatTitleStarter(title, {
      email,
      workspace: opts?.workspace,
      starter,
      firstUserMessage: firstUser,
    });
  }

  const updatedAtRaw = new Date();
  let updatedAt = updatedAtRaw.toISOString();
  if (previousUpdated) {
    const prev = Date.parse(previousUpdated);
    if (Number.isFinite(prev) && updatedAtRaw.getTime() <= prev) {
      updatedAt = new Date(prev + 1).toISOString();
    }
  }
  if (opts?.markRead) {
    await markChatHistoryRead({
      email,
      sessionId,
      at: updatedAt,
      root: opts?.root,
      workspace: opts?.workspace,
    });
  } else {
    await rememberChatHistoryReadOnPersist({
      email,
      sessionId,
      isNew,
      previousUpdated,
      updatedAt,
      root: opts?.root,
      workspace: opts?.workspace,
    });
  }

  const markdown = formatChatHistoryMarkdown({
    email,
    sessionId,
    messages,
    startedAt,
    updatedAt,
    title,
    visibility: visibility || "showing",
    ephemeral: Boolean(ephemeral),
    workspace: opts?.workspace,
    starter,
    scheduled: Boolean(scheduled),
    scheduledRunAt,
    scheduledStatus,
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
  const rel = chatHistoryFileRel(email, sessionId, opts?.workspace);
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
  let next = text;
  if (/^title:\s+/m.test(next)) {
    next = next.replace(/^title:\s+.*$/m, `title: ${title}`);
  } else {
    next = next.replace(/^(updated:\s+\S+)\s*$/m, `$1\ntitle: ${title}`);
  }
  if (Object.prototype.hasOwnProperty.call(opts, "starter")) {
    const starter = String(opts.starter || "").trim();
    if (starter) {
      if (/^starter:\s+/m.test(next)) {
        next = next.replace(/^starter:\s+.*$/m, `starter: ${starter}`);
      } else if (/^workspace:\s+/m.test(next)) {
        next = next.replace(/^(workspace:\s+\S+)\s*$/m, `$1\nstarter: ${starter}`);
      } else if (/^title:\s+/m.test(next)) {
        next = next.replace(/^(title:\s+.*)$/m, `$1\nstarter: ${starter}`);
      } else {
        next = next.replace(/^(updated:\s+\S+)\s*$/m, `$1\nstarter: ${starter}`);
      }
    } else {
      next = next.replace(/^starter:\s+.*\r?\n/m, "");
    }
  }
  if (next === text) return title;
  await writeFile(abs, next, "utf8");
  return title;
}

/**
 * After a title rewrite, put `Name:` back (or strip `Yan:` on personal chats).
 * @param {{
 *   email?: string,
 *   sessionId?: string,
 *   workspace?: string,
 *   starter?: string,
 * }[]} rows
 * @param {string} [root]
 */
export async function reapplyChatTitleStarters(rows, root) {
  let changed = 0;
  for (const row of rows || []) {
    const email = canonicalizeEmail(row.email);
    const sessionId = sanitizeSessionId(row.sessionId);
    const workspace = normalizeJypeWorkspace(row.workspace);
    if (!email || !sessionId) continue;
    const loaded = await loadChatHistory({
      email,
      sessionId,
      workspace,
      root,
    });
    if (!loaded) continue;
    const firstUser =
      loaded.messages.find((m) => m.role === "user")?.content ||
      loaded.preview ||
      "";
    const starter = resolveChatStarter({
      email,
      workspace,
      starter: loaded.starter || row.starter,
      firstUserMessage: firstUser,
    });
    const title = applyChatTitleStarter(loaded.title, {
      email,
      workspace,
      starter,
      firstUserMessage: firstUser,
    });
    if (!title) continue;
    if (title === loaded.title && starter === (loaded.starter || "")) {
      continue;
    }
    const patched = await patchChatHistoryTitle({
      email,
      sessionId,
      title,
      starter,
      root,
      workspace,
    });
    if (patched) changed += 1;
  }
  return changed;
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
  const rel = chatHistoryFileRel(email, sessionId, opts?.workspace);
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
 * Update scheduledStatus on an existing future-agent thread.
 * @param {{
 *   email: string,
 *   sessionId: string,
 *   status: string,
 *   root?: string,
 *   workspace?: string,
 * }} opts
 */
export async function patchChatHistoryScheduled(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const status = String(opts?.status || "").trim();
  const rel = chatHistoryFileRel(email, sessionId, opts?.workspace);
  if (!email || !sessionId || !status || !rel) return null;
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
  if (!/^scheduled:\s+true\s*$/m.test(text)) return null;
  let next;
  if (/^scheduledStatus:\s+/m.test(text)) {
    next = text.replace(/^scheduledStatus:\s+.*$/m, `scheduledStatus: ${status}`);
  } else if (/^scheduledRunAt:\s+/m.test(text)) {
    next = text.replace(/^(scheduledRunAt:\s+\S+)\s*$/m, `$1\nscheduledStatus: ${status}`);
  } else {
    next = text.replace(/^(scheduled:\s+true)\s*$/m, `$1\nscheduledStatus: ${status}`);
  }
  if (next === text) return status;
  await writeFile(abs, next, "utf8");
  return status;
}

/**
 * @param {{ email: string, sessionId: string, root?: string }} opts
 * @returns {Promise<{
 *   sessionId: string,
 *   title: string,
 *   visibility: 'showing'|'hidden',
 *   ephemeral: boolean,
 *   started: string,
 *   updated: string,
 *   preview: string,
 *   messages: { role: 'user'|'assistant', content: string, at: string, widgets?: object[] }[],
 * }|null>}
 */
export async function loadChatHistory(opts) {
  const email = canonicalizeEmail(opts?.email);
  const sessionId = sanitizeSessionId(opts?.sessionId);
  const rel = chatHistoryFileRel(email, sessionId, opts?.workspace);
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
    ephemeral: meta.ephemeral,
    started: meta.started,
    updated: meta.updated,
    preview: meta.preview,
    workspace: meta.workspace || normalizeJypeWorkspace(opts?.workspace),
    starter: meta.starter,
    scheduled: meta.scheduled,
    scheduledRunAt: meta.scheduledRunAt,
    scheduledStatus: meta.scheduledStatus,
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
  const dir = join(resolveRoot(opts?.root), chatHistoryDirRel(email, opts?.workspace));
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
   *   ephemeral: boolean,
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
        ephemeral: meta.ephemeral,
        updated: meta.updated || new Date(st.mtimeMs).toISOString(),
        preview: meta.preview,
        started: meta.started,
        starter: meta.starter,
        workspace: meta.workspace || normalizeJypeWorkspace(opts?.workspace),
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
  const workspace = normalizeJypeWorkspace(opts?.workspace);
  const rows = await readChatHistoryRows(opts);
  const dir = chatHistoryDirRel(email, workspace);
  return rows.map((row) => ({
    ...row,
    email,
    workspace: row.workspace || workspace,
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
 *   now?: Date,
 *   workingIds?: Iterable<string>|Set<string>,
 * }} opts
 */
export async function listChatHistory(opts) {
  const limit = Math.max(1, Math.min(LIST_MAX, Number(opts?.limit) || LIST_MAX));
  const rows = await readChatHistoryRows(opts);
  const lastRead = await loadChatLastReadMap(opts);
  const now = opts?.now instanceof Date ? opts.now : new Date();
  const workingIds =
    opts?.workingIds instanceof Set
      ? opts.workingIds
      : new Set(opts?.workingIds || []);
  return rows
    .filter((row) => row.visibility !== "hidden")
    .filter((row) => !chatHistoryIsEphemeralHidden(row, now, workingIds))
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
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const pick = (type) => {
    const raw = parts.find((p) => p.type === type)?.value || "";
    const digits = raw.replace(/\D/g, "");
    return digits.padStart(type === "year" ? 4 : 2, "0");
  };
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/**
 * Today / Yesterday / weekday buckets on Seattle calendar days.
 * Device and UTC midnight must not move a morning chat into Yesterday.
 *
 * @param {string} iso
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{ key: string, label: string, showAge: boolean }}
 */
export function chatHistoryGroup(
  iso,
  now = new Date(),
  timeZone = CHAT_HISTORY_TZ
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
  timeZone = CHAT_HISTORY_TZ
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
