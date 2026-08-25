/**
 * Read-only iMessage lookup on the Mac Studio via Messages chat.db.
 * Requires Full Disk Access for node. Never copies the DB into the repo.
 */

import { execFile } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_DB = join(homedir(), "Library/Messages/chat.db");
const APPLE_EPOCH_S = 978_307_200;

export const IMESSAGE_FETCH_MAX = 1024;
export const IMESSAGE_TEXT_MAX = 10_000;
export const PREVIEW_STILL_LIMIT = 10;
export const PREVIEW_DIR = "/tmp/yanylevin-imessage-att";
export const EXPORT_DIR_PREFIX = "/tmp/yanylevin-imessage-export";
export const EXPORT_PAGE_SIZE = IMESSAGE_FETCH_MAX;

const TAPBACK_ACTIONS = {
  2000: "loved",
  2001: "liked",
  2002: "disliked",
  2003: "laughed",
  2004: "emphasized",
  2005: "questioned",
  2006: "reacted",
  2007: "reacted",
};

const STILL_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);
const STILL_EXT = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".heic",
  ".heif",
]);
const HEIC_EXT = new Set([".heic", ".heif"]);

export function defaultMessagesDb() {
  return String(process.env.IMESSAGE_DB_PATH || "").trim() || DEFAULT_DB;
}

function clip(raw, max = 400) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function clipText(raw, max = IMESSAGE_TEXT_MAX) {
  return String(raw || "").trim().slice(0, max);
}

const TYPEDSTREAM_STRING = Buffer.from([0x84, 0x01, 0x2b]);

function coerceBlob(raw) {
  if (!raw) return null;
  if (Buffer.isBuffer(raw)) return raw.length ? raw : null;
  if (raw instanceof Uint8Array) {
    return raw.length ? Buffer.from(raw) : null;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length % 2 === 0 && /^[0-9A-Fa-f]+$/.test(s)) {
    try {
      const buf = Buffer.from(s, "hex");
      return buf.length ? buf : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Plain text from Messages `attributedBody` (NSArchiver typedstream).
 * `m.text` is empty for most iMessages before ~2026; the body lives here.
 */
export function textFromAttributedBody(raw) {
  const buf = coerceBlob(raw);
  if (!buf || buf.length < 8) return "";
  let from = 0;
  while (from < buf.length) {
    const i = buf.indexOf(TYPEDSTREAM_STRING, from);
    if (i < 0) break;
    let p = i + 3;
    if (p >= buf.length) break;
    const b = buf[p];
    let len = 0;
    if (b === 0x81 && p + 2 < buf.length) {
      len = buf[p + 1] | (buf[p + 2] << 8);
      p += 3;
    } else if (b === 0x82 && p + 4 < buf.length) {
      len = buf.readUInt32LE(p + 1);
      p += 5;
    } else if (b < 0x80) {
      len = b;
      p += 1;
    } else {
      from = i + 3;
      continue;
    }
    if (len < 1 || p + len > buf.length) {
      from = i + 3;
      continue;
    }
    const s = buf
      .toString("utf8", p, p + len)
      .replace(/\uFFFC/g, "")
      .replace(/\0/g, "")
      .trim();
    if (s && !s.startsWith("__k") && !(s.startsWith("NS") && !s.includes(" "))) {
      return s;
    }
    from = p + len;
  }
  return "";
}

function resolvedMessageText(row, max = IMESSAGE_TEXT_MAX) {
  const fromCol = clipText(row?.text || "", max);
  if (fromCol) return fromCol;
  return clipText(
    textFromAttributedBody(row?.attributed_body_hex || row?.attributedBody || ""),
    max
  );
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function parseSqliteAt(raw) {
  const s = String(raw || "").trim();
  if (!s) return NaN;
  if (s.includes("T")) return Date.parse(s);
  return Date.parse(`${s.replace(" ", "T")}Z`);
}

export function isoFromSqliteAt(raw) {
  const ms = parseSqliteAt(raw);
  if (!Number.isFinite(ms)) return clip(raw, 40);
  return new Date(ms).toISOString();
}

export function monthKeyFromAt(raw) {
  const iso = isoFromSqliteAt(raw);
  const m = String(iso).match(/^(\d{4}-\d{2})/);
  return m ? m[1] : "unknown";
}

export function dateBoundsSql({ since, until, untilId } = {}) {
  const sinceMs = since ? Date.parse(String(since)) : NaN;
  const untilMs = until ? Date.parse(String(until)) : NaN;
  const id = Number(untilId);
  let sql = "";
  if (Number.isFinite(sinceMs)) {
    const sinceAppleS = Math.floor(sinceMs / 1000) - APPLE_EPOCH_S;
    sql += ` AND m.date/1000000000 >= ${sinceAppleS}`;
  }
  if (Number.isFinite(untilMs)) {
    const untilAppleS = Math.floor(untilMs / 1000) - APPLE_EPOCH_S;
    if (Number.isFinite(id) && id > 0) {
      sql += ` AND (m.date/1000000000 < ${untilAppleS} OR (m.date/1000000000 = ${untilAppleS} AND m.ROWID < ${Math.floor(id)}))`;
    } else {
      sql += ` AND m.date/1000000000 < ${untilAppleS}`;
    }
  }
  return sql;
}

export function normalizeExportHandles(raw) {
  const out = [];
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const s = String(item || "").trim();
    if (s.length < 3) continue;
    out.push(s);
    if (/^\+\d{8,16}$/.test(s)) out.push(s.slice(1));
  }
  return [...new Set(out)];
}

function handleMatchSql(alias, handles) {
  const list = normalizeExportHandles(handles);
  if (!list.length) {
    const err = new Error("export needs at least one handle");
    err.status = 400;
    throw err;
  }
  return list
    .map((h) => {
      const lit = sqlLiteral(h);
      const like = sqlLiteral(`%${h}%`);
      return `${alias}.id = ${lit} OR ${alias}.id LIKE ${like}`;
    })
    .join(" OR ");
}

export function personHandleSql(handles) {
  const list = normalizeExportHandles(handles);
  if (!list.length) {
    const err = new Error("export needs at least one handle");
    err.status = 400;
    throw err;
  }
  const parts = list.map((h) => {
    const lit = sqlLiteral(h);
    const like = sqlLiteral(`%${h}%`);
    return `(h.id = ${lit} OR c.chat_identifier = ${lit} OR h.id LIKE ${like} OR c.chat_identifier LIKE ${like})`;
  });
  return `AND (${parts.join(" OR ")})`;
}

/** Every message in chats where this person is a participant (1:1 and groups). */
export function sharedChatsSql(handles) {
  const match = handleMatchSql("h2", handles);
  return `AND c.ROWID IN (
    SELECT chj.chat_id
    FROM chat_handle_join chj
    JOIN handle h2 ON h2.ROWID = chj.handle_id
    WHERE ${match}
  )`;
}

export function resolveExportDir(slug) {
  const safe = String(slug || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!safe) {
    const err = new Error("export slug required");
    err.status = 400;
    throw err;
  }
  return join(EXPORT_DIR_PREFIX, safe);
}

export function assertExportDir(dir) {
  const resolved = resolvePath(String(dir || ""));
  if (resolved !== EXPORT_DIR_PREFIX && !resolved.startsWith(`${EXPORT_DIR_PREFIX}/`)) {
    const err = new Error("outDir must be under /tmp/yanylevin-imessage-export");
    err.status = 400;
    throw err;
  }
  return resolved;
}

function handleSetOf(handles) {
  return new Set(normalizeExportHandles(handles).map((h) => h.toLowerCase()));
}

function isDirectChatId(chatId, handle) {
  const id = String(chatId || "").trim();
  const h = String(handle || "").trim();
  if (!id) return Boolean(h);
  if (h && id.toLowerCase() === h.toLowerCase()) return true;
  if (id.startsWith("+")) return true;
  if (id.includes("@")) return true;
  return false;
}

/**
 * Speaker label for JSON rows and export dumps.
 * In a 1:1, `handle` is the other person even on Yan's texts.
 * @param {{ fromMe?: boolean, handle?: string, chatId?: string }} message
 * @param {string[]} [handles] export person handles; empty for JSON APIs
 */
export function speakerWho(message, handles = []) {
  if (message.fromMe) return "yan";
  const handleRaw = String(message.handle || "");
  const chatIdRaw = String(message.chatId || "");
  if (handles.length) {
    const set = handleSetOf(handles);
    const handle = handleRaw.toLowerCase();
    const chatId = chatIdRaw.toLowerCase();
    if (handle && !set.has(handle) && !set.has(chatId)) {
      return clip(handleRaw, 40);
    }
    return "them";
  }
  if (isDirectChatId(chatIdRaw, handleRaw)) return "them";
  return clip(handleRaw || "them", 40);
}

export function formatExportLine(message, handles = []) {
  const set = handleSetOf(handles);
  const chatId = String(message.chatId || "").toLowerCase();
  const direct = set.has(chatId);
  const chat = direct ? "1:1" : clip(message.chat || "group", 40);
  const who = speakerWho(message, handles);
  const bits = [];
  if (message.tapback?.action) {
    bits.push(`[${message.tapback.action}] ${clip(message.tapback.on || "", 160)}`.trim());
  }
  if (message.replyTo?.text) bits.push(`(re: ${clip(message.replyTo.text, 80)})`);
  const body = clipText(message.text || "", IMESSAGE_TEXT_MAX).replace(/\s+/g, " ").trim();
  if (body) bits.push(body);
  const atts = Array.isArray(message.attachments) ? message.attachments : [];
  if (atts.length) {
    bits.push(
      `[${atts
        .map((a) => clip(a.mime || a.transferName || "attachment", 40))
        .join(",")}]`
    );
  }
  if (message.audio) bits.push("[audio]");
  const text = bits.join(" ").trim() || "(empty)";
  return `${isoFromSqliteAt(message.at)} | ${chat} | ${who} | ${text}`;
}

export function clampLimit(raw, fallback, max = IMESSAGE_FETCH_MAX) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), max);
}

/**
 * Strip p:0/ / re:chat:guid prefixes so we can join message.guid.
 * @param {string} raw
 */
export function normalizeMessageGuid(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const afterSlash = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
  const parts = afterSlash.split(":");
  return String(parts[parts.length - 1] || "").trim();
}

export function tapbackAction(type) {
  const n = Number(type) || 0;
  if (TAPBACK_ACTIONS[n]) return TAPBACK_ACTIONS[n];
  if (n >= 3000 && n < 4000) return "sticker";
  if (n === 1000) return "sticker";
  return "";
}

export function expandAttachmentPath(filename) {
  const p = String(filename || "").trim();
  if (!p) return "";
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function isPreviewableStill(att) {
  if (!att || Number(att.sticker) === 1 || att.sticker === true) return false;
  const mime = String(att.mime || att.mime_type || "")
    .trim()
    .toLowerCase();
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return false;
  if (mime.includes("zip") || mime.includes("iwork") || mime.includes("officedocument")) {
    return false;
  }
  if (STILL_MIME.has(mime)) return true;
  const ext = extname(String(att.filename || att.transferName || "")).toLowerCase();
  return STILL_EXT.has(ext);
}

function parseAttachments(raw) {
  if (!raw) return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((a) => ({
      filename: clip(a?.filename || "", 300),
      mime: clip(a?.mime || "", 80),
      uti: clip(a?.uti || "", 80),
      bytes: Number(a?.bytes) || 0,
      sticker: Number(a?.sticker) === 1,
      transferName: clip(a?.transferName || "", 160),
      emoji: clip(a?.emoji || "", 80),
    }))
    .filter((a) => a.filename || a.transferName || a.mime);
}

/**
 * @param {string} sql
 * @param {{ db?: string, timeout?: number, maxBuffer?: number }} [opts]
 */
export async function queryMessages(sql, opts = {}) {
  const db = opts.db || defaultMessagesDb();
  const timeout = Math.max(1000, Number(opts.timeout) || 20_000);
  const maxBuffer = Math.max(64 * 1024, Number(opts.maxBuffer) || 16 * 1024 * 1024);
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", db, sql],
      { timeout, maxBuffer }
    );
    const text = String(stdout || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      /unable to open|authorization|permission|not a database/i.test(msg)
        ? "Messages DB unreadable. Grant Full Disk Access to Terminal/node (System Settings > Privacy & Security > Full Disk Access)."
        : msg
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

function appleDateExpr(alias = "m") {
  return `datetime(${alias}.date/1000000000 + ${APPLE_EPOCH_S}, 'unixepoch')`;
}

const ATTACHMENTS_JSON_SQL = `(
  SELECT json_group_array(json_object(
    'filename', a.filename,
    'mime', a.mime_type,
    'uti', a.uti,
    'bytes', a.total_bytes,
    'sticker', a.is_sticker,
    'transferName', a.transfer_name,
    'emoji', a.emoji_image_short_description
  ))
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  WHERE maj.message_id = m.ROWID
)`;

const ATTRIBUTED_HEX_SQL = `CASE
  WHEN m.text IS NOT NULL AND m.text != '' THEN NULL
  ELSE hex(substr(m.attributedBody, 1, 32000))
END`;

const VISIBLE_SQL = `(
  (m.text IS NOT NULL AND m.text != '')
  OR (m.attributedBody IS NOT NULL AND length(m.attributedBody) > 0)
  OR IFNULL(m.cache_has_attachments, 0) = 1
  OR IFNULL(m.associated_message_type, 0) BETWEEN 2000 AND 3007
  OR IFNULL(m.associated_message_type, 0) = 1000
  OR (m.thread_originator_guid IS NOT NULL AND m.thread_originator_guid != '')
)`;

function messageSelectSql({ extraWhere = "", limit }) {
  return `
    SELECT
      m.ROWID as id,
      m.guid as guid,
      m.is_from_me,
      m.text,
      ${ATTRIBUTED_HEX_SQL} as attributed_body_hex,
      ${appleDateExpr("m")} as at,
      h.id as handle_id,
      c.chat_identifier as chat_identifier,
      COALESCE(c.display_name, c.chat_identifier) as chat_name,
      m.associated_message_guid as associated_guid,
      m.associated_message_type as associated_type,
      m.thread_originator_guid as thread_guid,
      IFNULL(m.cache_has_attachments, 0) as has_attachments,
      IFNULL(m.is_audio_message, 0) as is_audio,
      ${ATTACHMENTS_JSON_SQL} as attachments_json
    FROM message m
    LEFT JOIN handle h ON h.ROWID = m.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    LEFT JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE ${VISIBLE_SQL}
      ${extraWhere}
    ORDER BY m.date DESC, m.ROWID DESC
    LIMIT ${limit};
  `;
}

export function rowToMessage(row) {
  const attachments = parseAttachments(row.attachments_json);
  const associatedType = Number(row.associated_type) || 0;
  const action = tapbackAction(associatedType);
  const text = action ? clipText(row.text || "", IMESSAGE_TEXT_MAX) : resolvedMessageText(row);
  /** @type {Record<string, unknown>} */
  const out = {
    id: row.ROWID ?? row.id ?? null,
    guid: clip(row.guid || "", 80),
    chat: clip(row.chat_name || row.chat_identifier || "", 80),
    chatId: clip(row.chat_identifier || "", 80),
    handle: clip(row.handle_id || "", 80),
    fromMe: Number(row.is_from_me) === 1,
    text,
    at: clip(row.at || "", 40),
    attachments,
    attachmentName: attachments[0]?.filename || "",
  };
  out.who = speakerWho(out);
  if (Number(row.is_audio) === 1) out.audio = true;
  if (associatedType) {
    out.associatedType = associatedType;
    out.associatedGuid = normalizeMessageGuid(row.associated_guid);
    if (action) out.tapback = { type: associatedType, action };
  }
  const threadGuid = normalizeMessageGuid(row.thread_guid);
  if (threadGuid) out.replyToGuid = threadGuid;
  return out;
}

async function hydrateReferences(messages, opts = {}) {
  const guids = [
    ...new Set(
      messages.flatMap((m) =>
        [m.associatedGuid, m.replyToGuid].filter((g) => g && String(g).length >= 8)
      )
    ),
  ];
  if (!guids.length) return messages;
  const query = opts.queryMessages || queryMessages;
  const lit = guids.map(sqlLiteral).join(", ");
  let rows = [];
  try {
    rows = await query(
      `SELECT guid, text, hex(substr(attributedBody, 1, 32000)) as attributed_body_hex,
              IFNULL(cache_has_attachments, 0) as has_attachments
       FROM message WHERE guid IN (${lit})`,
      { db: opts.db }
    );
  } catch {
    return messages;
  }
  /** @type {Map<string, { text: string, hasAtt: boolean }>} */
  const byGuid = new Map();
  for (const row of rows) {
    byGuid.set(String(row.guid || ""), {
      text: resolvedMessageText(row, 400),
      hasAtt: Number(row.has_attachments) === 1,
    });
  }
  for (const m of messages) {
    if (m.tapback && m.associatedGuid) {
      const orig = byGuid.get(m.associatedGuid);
      const on = orig?.text || (orig?.hasAtt ? "(attachment)" : "");
      m.tapback = { ...m.tapback, on };
    }
    if (m.replyToGuid) {
      const orig = byGuid.get(m.replyToGuid);
      const text = orig?.text || (orig?.hasAtt ? "(attachment)" : "");
      if (text) m.replyTo = { guid: m.replyToGuid, text };
    }
  }
  return messages;
}

/**
 * Copy/convert recent stills into /tmp so Cursor can Read them.
 * HEIC becomes jpeg via sips. Video/zip/Keynote are skipped. Stickers stay metadata-only.
 * @param {object[]} messages
 * @param {{
 *   limit?: number,
 *   dir?: string,
 *   copyFile?: typeof copyFile,
 *   execFile?: typeof execFileAsync,
 *   mkdir?: typeof mkdir,
 * }} [opts]
 */
export async function stageStillPreviews(messages, opts = {}) {
  const limit = clampLimit(opts.limit ?? PREVIEW_STILL_LIMIT, PREVIEW_STILL_LIMIT, 20);
  const dir = opts.dir || PREVIEW_DIR;
  const copy = opts.copyFile || copyFile;
  const exec = opts.execFile || execFileAsync;
  const makeDir = opts.mkdir || mkdir;
  await makeDir(dir, { recursive: true });

  /** @type {{ msg: object, att: object, index: number }[]} */
  const candidates = [];
  for (const msg of messages) {
    const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
    atts.forEach((att, index) => {
      if (isPreviewableStill(att)) candidates.push({ msg, att, index });
    });
  }
  candidates.sort((a, b) => String(b.msg.at || "").localeCompare(String(a.msg.at || "")));
  const picked = candidates.slice(0, limit);

  for (const { msg, att, index } of picked) {
    const src = expandAttachmentPath(att.filename);
    if (!src) continue;
    const ext = extname(src).toLowerCase();
    const heic = HEIC_EXT.has(ext) || /heic|heif/i.test(String(att.mime || ""));
    const outExt = heic ? ".jpg" : ext || ".jpg";
    const dest = join(dir, `${msg.id || "m"}-${index}${outExt}`);
    try {
      if (heic) {
        await exec("sips", ["-s", "format", "jpeg", src, "--out", dest], {
          timeout: 20_000,
        });
      } else {
        await copy(src, dest);
      }
      att.previewPath = dest;
    } catch {
      /* missing file or sips failed; metadata still present */
    }
  }
  return messages;
}

async function fetchMessages({ extraWhere, limit, db, previewStills, timeout, maxBuffer }) {
  const sql = messageSelectSql({ extraWhere, limit });
  const rows = await queryMessages(sql, { db, timeout, maxBuffer });
  const messages = await hydrateReferences(rows.map(rowToMessage), { db });
  if (previewStills) {
    await stageStillPreviews(messages, {
      limit: previewStills === true ? PREVIEW_STILL_LIMIT : previewStills,
    });
  }
  return messages;
}

/**
 * @param {{ limit?: number, since?: string, db?: string, previewStills?: number|boolean }} [opts]
 */
export async function recentMessages(opts = {}) {
  const limit = clampLimit(opts.limit, IMESSAGE_FETCH_MAX);
  const sinceMs = opts.since ? Date.parse(String(opts.since)) : NaN;
  const sinceAppleS = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000) - APPLE_EPOCH_S
    : null;
  const sinceSql =
    sinceAppleS == null ? "" : `AND m.date/1000000000 >= ${sinceAppleS}`;
  const preview =
    opts.previewStills == null ? PREVIEW_STILL_LIMIT : opts.previewStills;
  return fetchMessages({
    extraWhere: sinceSql,
    limit,
    db: opts.db,
    previewStills: preview,
  });
}

/**
 * @param {string} query
 * @param {{ limit?: number, db?: string, previewStills?: number|boolean }} [opts]
 */
export async function searchMessages(query, opts = {}) {
  const q = clip(query, 80);
  if (q.length < 2) {
    const err = new Error("search needs at least 2 characters");
    err.status = 400;
    throw err;
  }
  const limit = clampLimit(opts.limit, 50, 200);
  const like = sqlLiteral(`%${q}%`);
  return fetchMessages({
    extraWhere: `AND (m.text LIKE ${like}
       OR CAST(m.attributedBody AS TEXT) LIKE ${like}
       OR h.id LIKE ${like}
       OR c.display_name LIKE ${like}
       OR c.chat_identifier LIKE ${like}
       OR EXISTS (
         SELECT 1 FROM message_attachment_join maj2
         JOIN attachment a2 ON a2.ROWID = maj2.attachment_id
         WHERE maj2.message_id = m.ROWID
           AND (IFNULL(a2.filename,'') LIKE ${like} OR IFNULL(a2.transfer_name,'') LIKE ${like})
       ))`,
    limit,
    db: opts.db,
    previewStills: opts.previewStills ?? 0,
  });
}

/**
 * @param {string} person
 * @param {{ limit?: number, db?: string, previewStills?: number|boolean, since?: string, until?: string }} [opts]
 */
export async function recentThread(person, opts = {}) {
  const q = clip(person, 80);
  if (q.length < 2) {
    const err = new Error("person needs at least 2 characters");
    err.status = 400;
    throw err;
  }
  const limit = clampLimit(opts.limit, IMESSAGE_FETCH_MAX);
  const like = sqlLiteral(`%${q}%`);
  const preview =
    opts.previewStills == null ? PREVIEW_STILL_LIMIT : opts.previewStills;
  const rows = await fetchMessages({
    extraWhere: `AND (h.id LIKE ${like}
       OR c.display_name LIKE ${like}
       OR c.chat_identifier LIKE ${like})${dateBoundsSql({
         since: opts.since,
         until: opts.until,
       })}`,
    limit,
    db: opts.db,
    previewStills: preview,
  });
  return rows.reverse();
}

/**
 * Dump a person's iMessage history to monthly text files under /tmp.
 * Returns counts and paths only. Never returns message bodies.
 * Default: 1:1 both sides, plus this handle's group rows.
 * `sharedChats: true`: every message in chats they participate in.
 *
 * @param {{
 *   slug: string,
 *   handles: string[],
 *   since: string,
 *   db?: string,
 *   outDir?: string,
 *   pageSize?: number,
 *   sharedChats?: boolean,
 * }} opts
 */
export async function exportPersonThread(opts) {
  const handles = normalizeExportHandles(opts.handles);
  const since = String(opts.since || "").trim();
  if (!since || !Number.isFinite(Date.parse(since))) {
    const err = new Error("export since must be an ISO date");
    err.status = 400;
    throw err;
  }
  const sharedChats = opts.sharedChats === true;
  const matchSql = sharedChats ? sharedChatsSql(handles) : personHandleSql(handles);
  const outDir = assertExportDir(opts.outDir || resolveExportDir(opts.slug));
  const pageSize = clampLimit(opts.pageSize, EXPORT_PAGE_SIZE);
  const queryOpts = {
    db: opts.db,
    previewStills: 0,
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  };

  /** @type {Map<string, { at: string, line: string, id: number }[]>} */
  const byMonth = new Map();
  const seen = new Set();
  let until;
  let untilId;
  let pages = 0;
  let newest = "";
  let oldest = "";

  for (;;) {
    const page = await fetchMessages({
      extraWhere: `${matchSql}${dateBoundsSql({
        since,
        until,
        untilId,
      })}`,
      limit: pageSize,
      ...queryOpts,
    });
    pages += 1;
    if (!page.length) break;
    if (!newest) newest = isoFromSqliteAt(page[0].at);
    for (const msg of page) {
      const key = String(msg.guid || msg.id || "");
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      const month = monthKeyFromAt(msg.at);
      if (!byMonth.has(month)) byMonth.set(month, []);
      byMonth.get(month).push({
        at: isoFromSqliteAt(msg.at),
        id: Number(msg.id) || 0,
        line: formatExportLine(msg, handles),
      });
    }
    const last = page[page.length - 1];
    oldest = isoFromSqliteAt(last.at);
    until = oldest;
    untilId = last.id;
    if (page.length < pageSize) break;
    if (pages > 10_000) {
      const err = new Error("export pagination safety stop");
      err.status = 500;
      throw err;
    }
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const months = [...byMonth.keys()].sort();
  /** @type {{ month: string, file: string, lines: number, bytes: number }[]} */
  const files = [];
  let messages = 0;
  for (const month of months) {
    const rows = byMonth.get(month) || [];
    rows.sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
    const body = rows.map((r) => r.line).join("\n") + (rows.length ? "\n" : "");
    const file = `${month}.txt`;
    await writeFile(join(outDir, file), body, "utf8");
    files.push({
      month,
      file,
      lines: rows.length,
      bytes: Buffer.byteLength(body),
    });
    messages += rows.length;
  }

  const manifest = {
    ok: true,
    slug: String(opts.slug || "").trim(),
    handles,
    since,
    sharedChats,
    outDir,
    pages,
    messages,
    newest: newest || null,
    oldest: oldest || null,
    files,
  };
  await writeFile(
    join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );
  return manifest;
}

/**
 * Unique chats + handles (people Yan actually texts).
 * @param {{ db?: string, limit?: number }} [opts]
 */
export async function listIMessagePeople(opts = {}) {
  const limit = clampLimit(opts.limit, 400, 800);
  const sql = `
    SELECT
      COALESCE(NULLIF(c.display_name, ''), c.chat_identifier) as chat,
      h.id as handle,
      datetime(MAX(m.date)/1000000000 + ${APPLE_EPOCH_S}, 'unixepoch') as lastAt,
      COUNT(m.ROWID) as messages
    FROM chat c
    JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
    JOIN handle h ON h.ROWID = chj.handle_id
    LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
    LEFT JOIN message m ON m.ROWID = cmj.message_id
    GROUP BY c.ROWID, h.ROWID
    ORDER BY MAX(m.date) DESC
    LIMIT ${limit};
  `;
  const rows = await queryMessages(sql, {
    db: opts.db,
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return rows.map((row) => ({
    chat: clip(row.chat, 80),
    handle: clip(row.handle, 80),
    lastAt: clip(row.lastAt, 40),
    messages: Number(row.messages) || 0,
  }));
}

/**
 * Count case-insensitive mentions of candidate names in message bodies.
 * @param {string[]} names
 * @param {{ db?: string, since?: string, minCount?: number }} [opts]
 */
export async function countNameMentions(names, opts = {}) {
  const minCount = Math.max(1, Number(opts.minCount) || 2);
  const unique = [
    ...new Set(
      (names || [])
        .map((n) => clip(n, 40))
        .filter((n) => n.length >= 3)
    ),
  ];
  const sinceMs = opts.since ? Date.parse(String(opts.since)) : NaN;
  const sinceAppleS = Number.isFinite(sinceMs)
    ? Math.floor(sinceMs / 1000) - APPLE_EPOCH_S
    : null;
  const sinceSql =
    sinceAppleS == null ? "" : `AND m.date/1000000000 >= ${sinceAppleS}`;
  const batchSize = 20;
  /** @type {{ name: string, count: number }[]} */
  const out = [];
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const selects = batch.map((name, idx) => {
      const like = sqlLiteral(`%${name}%`);
      return `SUM(CASE WHEN m.text LIKE ${like} COLLATE NOCASE THEN 1 ELSE 0 END) as c${idx}`;
    });
    const sql = `
      SELECT ${selects.join(", ")}
      FROM message m
      WHERE m.text IS NOT NULL AND m.text != ''
      ${sinceSql};
    `;
    const rows = await queryMessages(sql, {
      db: opts.db,
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const row = rows[0] || {};
    for (let idx = 0; idx < batch.length; idx++) {
      const count = Number(row[`c${idx}`] || 0);
      if (count >= minCount) out.push({ name: batch[idx], count });
    }
  }
  out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return out;
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "help";
  const rest = args.slice(1).join(" ");
  const run = async () => {
    if (cmd === "recent") return recentMessages({ since: rest, previewStills: 0 });
    if (cmd === "search") return searchMessages(rest);
    if (cmd === "thread") return recentThread(rest, { previewStills: 0 });
    if (cmd === "people") return listIMessagePeople();
    return {
      ok: false,
      usage:
        "node imessage-read.js recent [since-iso] | search <text> | thread <person> | people",
    };
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
