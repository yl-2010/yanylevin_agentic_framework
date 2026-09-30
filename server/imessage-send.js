/**
 * Send an iMessage via Messages.app (osascript). LaunchAgent node has
 * Automation access; Cursor shells often hang on TCC. Prefer local IPC.
 */

import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { applyAgentSentFooter } from "./imessage-mention.js";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)));
export const IMESSAGE_SEND_SCRIPT = join(ROOT, "imessage-send.applescript");
const MAX_TEXT_CHARS = 24_000;
export const MAX_SEND_FILES = 16;
export const MAX_SEND_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_SEND_FILES_TOTAL = 200 * 1024 * 1024;

/** @type {Map<string, string[]>} */
const replyFilesByKey = new Map();

function statusError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function expandUserPath(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s === "~") return homedir();
  if (s.startsWith("~/")) return join(homedir(), s.slice(2));
  return s;
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeSendFiles(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  /** @type {string[]} */
  const out = [];
  for (const item of list) {
    const s = String(item || "").trim();
    if (s) out.push(s);
  }
  return out;
}

/**
 * @param {object|null|undefined} origin
 * @returns {string[]}
 */
export function iMessageReplyFileKeys(origin) {
  /** @type {string[]} */
  const keys = [];
  const guid = String(origin?.chatGuid || "").trim();
  if (guid) keys.push(`guid:${guid}`);
  for (const raw of [origin?.to, origin?.chatId, origin?.handle, origin?.chat]) {
    const s = String(raw || "").trim().toLowerCase();
    if (s) keys.push(`to:${s}`);
  }
  return [...new Set(keys)];
}

/**
 * Hold files for the @agent final bubble. Server sends each file, then text.
 * @param {object|null|undefined} origin
 * @param {string[]} files
 */
export function queueIMessageReplyFiles(origin, files) {
  const paths = Array.isArray(files) ? files.filter(Boolean) : [];
  const keys = iMessageReplyFileKeys(origin);
  if (!keys.length || !paths.length) return keys;
  for (const key of keys) replyFilesByKey.set(key, [...paths]);
  return keys;
}

/**
 * @param {object|null|undefined} origin
 * @returns {string[]}
 */
export function takeIMessageReplyFiles(origin) {
  const keys = iMessageReplyFileKeys(origin);
  /** @type {string[]} */
  let files = [];
  for (const key of keys) {
    if (replyFilesByKey.has(key)) {
      files = replyFilesByKey.get(key) || [];
      break;
    }
  }
  for (const key of keys) replyFilesByKey.delete(key);
  return files;
}

export function resetIMessageReplyFiles() {
  replyFilesByKey.clear();
}

/**
 * @param {unknown} raw
 * @param {{
 *   stat?: typeof stat,
 *   realpath?: typeof realpath,
 * }} [deps]
 * @returns {Promise<string[]>}
 */
export async function resolveSendFiles(raw, deps = {}) {
  const list = normalizeSendFiles(raw);
  if (!list.length) return [];
  if (list.length > MAX_SEND_FILES) {
    throw statusError(`at most ${MAX_SEND_FILES} files`, 400);
  }
  const statFn = deps.stat || stat;
  const realpathFn = deps.realpath || realpath;
  /** @type {string[]} */
  const out = [];
  let total = 0;
  for (const item of list) {
    const expanded = expandUserPath(item);
    const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
    let resolved = abs;
    try {
      resolved = await realpathFn(abs);
    } catch {
      throw statusError(`file not found: ${abs}`, 400);
    }
    let st;
    try {
      st = await statFn(resolved);
    } catch {
      throw statusError(`file not found: ${resolved}`, 400);
    }
    if (!st?.isFile?.()) {
      throw statusError(`not a file: ${resolved}`, 400);
    }
    const bytes = Number(st.size) || 0;
    if (bytes <= 0) {
      throw statusError(`file is empty: ${resolved}`, 400);
    }
    if (bytes > MAX_SEND_FILE_BYTES) {
      throw statusError(
        `file exceeds ${Math.round(MAX_SEND_FILE_BYTES / (1024 * 1024))}MB: ${resolved}`,
        400
      );
    }
    total += bytes;
    if (total > MAX_SEND_FILES_TOTAL) {
      throw statusError(
        `files total size exceeds ${Math.round(MAX_SEND_FILES_TOTAL / (1024 * 1024))}MB`,
        400
      );
    }
    out.push(resolved);
  }
  return out;
}

export function normalizeHandle(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = s.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (s.startsWith("+") && digits.length >= 8) return `+${digits}`;
  return s;
}

function phonesFromContact(row) {
  const raw = String(row?.phones || "");
  const out = [];
  for (const part of raw.split(/[,;|/]/)) {
    const handle = normalizeHandle(part);
    if (handle.startsWith("+") && handle.length >= 12) out.push(handle);
  }
  return out;
}

/**
 * @param {string} to
 * @param {{
 *   listContacts?: () => Promise<unknown>,
 *   contactMatchesQuery?: (row: object, q: string) => boolean,
 * }} [deps]
 */
export async function resolveHandle(to, deps = {}) {
  const trimmed = String(to || "").trim();
  if (!trimmed) throw statusError("to is required", 400);
  const asHandle = normalizeHandle(trimmed);
  if (asHandle.startsWith("+") || asHandle.includes("@")) return asHandle;

  const { listContacts, contactMatchesQuery } = await import(
    "./contacts-read.js"
  );
  const listFn = deps.listContacts || listContacts;
  const matchFn = deps.contactMatchesQuery || contactMatchesQuery;
  let rows = [];
  try {
    rows = await listFn();
  } catch (err) {
    throw statusError(
      `no iMessage handle for ${trimmed} (Contacts unreadable: ${
        err instanceof Error ? err.message : String(err)
      }). Pass a phone or email.`,
      400
    );
  }
  const list = Array.isArray(rows) ? rows : [];
  const matches = list.filter((row) => matchFn(row, trimmed));
  const withPhones = matches.flatMap((row) =>
    phonesFromContact(row).map((handle) => ({
      handle,
      name: String(row.name || "").trim(),
      first: String(row.first || "").trim(),
    }))
  );
  const unique = [...new Map(withPhones.map((p) => [p.handle, p])).values()];
  if (unique.length === 1) return unique[0].handle;
  if (unique.length > 1) {
    const q = trimmed.toLowerCase();
    const exact = unique.filter(
      (p) => p.first.toLowerCase() === q || p.name.toLowerCase() === q
    );
    const exactUnique = [...new Map(exact.map((p) => [p.handle, p])).values()];
    if (exactUnique.length === 1) return exactUnique[0].handle;
    throw statusError(
      `ambiguous iMessage handle for ${trimmed}: ${unique
        .map((u) => `${u.name} ${u.handle}`.trim())
        .join("; ")}`,
      400
    );
  }
  throw statusError(
    `no iMessage handle for ${trimmed}. Pass a phone or email.`,
    400
  );
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * @param {string} handle
 * @param {{ queryMessages?: (sql: string) => Promise<object[]>, db?: string }} [deps]
 */
export async function findChatGuid(handle, deps = {}) {
  const h = String(handle || "").trim();
  if (!h) return "";
  const query =
    deps.queryMessages ||
    (await import("./imessage-read.js")).queryMessages;
  const lit = sqlLiteral(h);
  try {
    const rows = await query(
      `
      SELECT c.guid as guid
      FROM chat c
      LEFT JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
      LEFT JOIN handle h ON h.ROWID = chj.handle_id
      WHERE h.id = ${lit} OR c.chat_identifier = ${lit}
      ORDER BY (CASE WHEN c.chat_identifier = ${lit} THEN 0 ELSE 1 END), c.ROWID DESC
      LIMIT 1;
    `,
      { db: deps.db }
    );
    return String(rows?.[0]?.guid || "").trim();
  } catch {
    return "";
  }
}

/**
 * Existing group (or named 1:1) by Messages display name. Exact, case-insensitive.
 * Does not create chats.
 * @param {string} name
 * @param {{ queryMessages?: (sql: string) => Promise<object[]>, db?: string }} [deps]
 * @returns {Promise<{ guid: string, name: string, ident: string }|null>}
 */
export async function findNamedChat(name, deps = {}) {
  const q = String(name || "").trim();
  if (!q) return null;
  const query =
    deps.queryMessages ||
    (await import("./imessage-read.js")).queryMessages;
  const lit = sqlLiteral(q.toLowerCase());
  try {
    const rows = await query(
      `
      SELECT c.guid as guid,
             c.display_name as name,
             c.chat_identifier as ident
      FROM chat c
      WHERE lower(trim(c.display_name)) = ${lit}
        AND c.display_name IS NOT NULL
        AND trim(c.display_name) != ''
      LIMIT 8;
      `,
      { db: deps.db }
    );
    const unique = [
      ...new Map(
        (Array.isArray(rows) ? rows : [])
          .map((r) => ({
            guid: String(r?.guid || "").trim(),
            name: String(r?.name || "").trim(),
            ident: String(r?.ident || "").trim(),
          }))
          .filter((r) => r.guid)
          .map((r) => [r.guid, r])
      ).values(),
    ];
    if (unique.length === 1) return unique[0];
    if (unique.length > 1) {
      throw statusError(
        `ambiguous iMessage chat name ${q}: ${unique
          .map((u) => u.ident || u.guid)
          .join("; ")}`,
        400
      );
    }
    return null;
  } catch (err) {
    if (err && /** @type {{ status?: number }} */ (err).status === 400) throw err;
    return null;
  }
}

/**
 * @param {{
 *   to?: string,
 *   text?: string,
 *   chatGuid?: string,
 *   files?: unknown,
 *   attachments?: unknown,
 * }} opts
 * @param {{
 *   execFile?: typeof execFileAsync,
 *   resolveHandle?: typeof resolveHandle,
 *   findChatGuid?: typeof findChatGuid,
 *   findNamedChat?: typeof findNamedChat,
 *   listContacts?: () => Promise<unknown>,
 *   queryMessages?: (sql: string) => Promise<object[]>,
 *   resolveSendFiles?: typeof resolveSendFiles,
 * }} [deps]
 */
export async function sendIMessage(opts = {}, deps = {}) {
  const text = String(opts.text || "");
  if (!String(opts.to || "").trim()) throw statusError("to is required", 400);
  const resolveFiles = deps.resolveSendFiles || resolveSendFiles;
  const files = await resolveFiles(opts.files ?? opts.attachments);
  if (!text.trim() && !files.length) {
    throw statusError("text or files required", 400);
  }
  if (text.length > MAX_TEXT_CHARS) {
    throw statusError(`text exceeds ${MAX_TEXT_CHARS} characters`, 400);
  }

  const resolve = deps.resolveHandle || resolveHandle;
  const findNamed = deps.findNamedChat || findNamedChat;
  const findGuid = deps.findChatGuid || findChatGuid;
  let handle = "";
  let chatGuid = String(opts.chatGuid || "").trim();
  const to = String(opts.to || "").trim();
  if (chatGuid && to) {
    handle = to;
  } else {
    try {
      handle = await resolve(to, {
        listContacts: deps.listContacts,
      });
    } catch (err) {
      const named = await findNamed(to, {
        queryMessages: deps.queryMessages,
      });
      if (named?.guid) {
        handle = named.name || named.ident || to;
        if (!chatGuid) chatGuid = named.guid;
      } else {
        const identGuid = chatGuid || (await findGuid(to, {
          queryMessages: deps.queryMessages,
        }));
        if (!identGuid) throw err;
        handle = to;
        chatGuid = identGuid;
      }
    }
  }
  if (!chatGuid) {
    chatGuid = await findGuid(handle, {
      queryMessages: deps.queryMessages,
    });
  }

  const dir = await mkdtemp(join(tmpdir(), "yanylevin-imessage-send-"));
  const bodyPath = join(dir, "body.txt");
  await writeFile(bodyPath, text.trim() ? text : "", "utf8");
  const exec = deps.execFile || execFileAsync;
  const args = [IMESSAGE_SEND_SCRIPT, handle, bodyPath, chatGuid || "", ...files];
  try {
    const { stdout, stderr } = await exec("osascript", args, {
      timeout: files.length ? 120_000 : 45_000,
      maxBuffer: 1024 * 1024,
    });
    const how = String(stdout || "")
      .trim()
      .split(/\s+/)[0];
    return {
      ok: true,
      to: handle,
      via: how || "osascript",
      chatGuid: chatGuid || undefined,
      files,
      warning: String(stderr || "").trim() || undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const friendly = /not authorized|(-1743)|osascript is not allowed/i.test(msg)
      ? "Messages Automation denied. Grant node control of Messages (System Settings > Privacy & Security > Automation)."
      : /timed out/i.test(msg)
        ? "Messages send timed out. If a permission prompt is on the Studio, click Allow."
        : msg;
    throw statusError(friendly, 500);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseCliArgs(argv) {
  /** @type {{ to: string, text: string, textFile: string, files: string[], actionAgent: string }} */
  const out = { to: "", text: "", textFile: "", files: [], actionAgent: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--to" && next != null) {
      out.to = next;
      i += 1;
    } else if (a === "--text" && next != null) {
      out.text = next;
      i += 1;
    } else if ((a === "--text-file" || a === "--file") && next != null) {
      out.textFile = next;
      i += 1;
    } else if ((a === "--attach" || a === "--attachment") && next != null) {
      out.files.push(next);
      i += 1;
    } else if (a === "--via" && next != null && !String(next).startsWith("--")) {
      out.actionAgent = next;
      i += 1;
    }
  }
  return out;
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const parsed = parseCliArgs(process.argv.slice(2));
  const run = async () => {
    let text = parsed.text;
    if (parsed.textFile) {
      const { readFile } = await import("node:fs/promises");
      text = await readFile(parsed.textFile, "utf8");
    }
    const sent = await sendIMessage({
      to: parsed.to,
      text: applyAgentSentFooter(text, { chat: parsed.to, handle: parsed.to }),
      files: parsed.files,
    });
    return sent;
  };
  run()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
