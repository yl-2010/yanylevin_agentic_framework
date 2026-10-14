/**
 * Read WhatsApp Desktop's local ChatStorage.sqlite.
 * Text is plaintext. Sender ids are often LID, mapped to a phone when the
 * app has that pair. The LaunchAgent node can read the group container.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { textHasAgentSentFooter } from "./imessage-mention.js";
import { formatAtLocal } from "./local-clock.js";

const execFileAsync = promisify(execFile);

export const APPLE_EPOCH_S = 978307200;
export const WHATSAPP_GROUP = join(
  homedir(),
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
);
export const DEFAULT_CHAT_DB = join(WHATSAPP_GROUP, "ChatStorage.sqlite");
export const DEFAULT_LID_DB = join(WHATSAPP_GROUP, "LID.sqlite");

/** Last-10 digits to people slug. Yan is fromMe, not in this map. */
export const WHATSAPP_JYPE_PHONES = Object.freeze({
  "4253625785": { slug: "alex-rivera", name: "Alex" },
  "4253260143": { slug: "example-friend", name: "Example Friend" },
  "4253705509": { slug: "example-neighbor", name: "Example Neighbor" },
});

const YAN_NAME = "Yan";

/**
 * @param {string} sql
 * @param {{ chatDb?: string, lidDb?: string, timeout?: number }} [opts]
 */
export async function queryWhatsApp(sql, opts = {}) {
  const chatDb = opts.chatDb || DEFAULT_CHAT_DB;
  const lidDb = opts.lidDb || DEFAULT_LID_DB;
  const timeout = Math.max(1000, Number(opts.timeout) || 20_000);
  const script = `ATTACH ${sqlQuote(lidDb)} AS lid;\n${sql}`;
  try {
    const { stdout } = await execFileAsync(
      "sqlite3",
      ["-readonly", "-json", chatDb, script],
      { timeout, maxBuffer: 8 * 1024 * 1024 }
    );
    const text = String(stdout || "").trim();
    if (!text) return [];
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(
      /unable to open|authorization|permission|not a database/i.test(msg)
        ? "WhatsApp DB unreadable. WhatsApp.app has to be installed and signed in on this Mac."
        : msg
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

function sqlQuote(raw) {
  return `'${String(raw || "").replaceAll("'", "''")}'`;
}

export function phoneDigits(raw) {
  return String(raw || "").replace(/\D/g, "");
}

export function last10(raw) {
  const d = phoneDigits(raw);
  return d.length >= 10 ? d.slice(-10) : "";
}

export function formatPhone(raw) {
  const d = phoneDigits(raw);
  if (!d) return "";
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith("1")) return `+${d}`;
  if (d.length >= 8) return `+${d}`;
  return "";
}

/**
 * @param {unknown} raw
 */
export function usableDisplayName(raw) {
  const s = String(raw || "")
    .replace(/[\u200e\u200f\u202a-\u202e]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (letters < 2) return "";
  if (/^(missing value|null)$/i.test(s)) return "";
  return s.slice(0, 80);
}

export function jypeByPhone(raw) {
  const key = last10(raw);
  return key ? WHATSAPP_JYPE_PHONES[key] || null : null;
}

/**
 * @param {string} [iso]
 */
export function sinceToApple(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return null;
  return ms / 1000 - APPLE_EPOCH_S;
}

function appleToIso(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date((n + APPLE_EPOCH_S) * 1000).toISOString();
}

function jidUser(jid) {
  const s = String(jid || "");
  const at = s.indexOf("@");
  return at > 0 ? s.slice(0, at) : "";
}

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function isDirectSession(sessionType, chatJid) {
  if (isGroupJid(chatJid)) return false;
  return Number(sessionType) === 0;
}

/**
 * @param {object} row
 * @param {string} ownPhone
 */
export function mapWhatsAppRow(row, ownPhone = "") {
  const chatJid = String(row?.chatJid || "").trim();
  const sessionType = Number(row?.sessionType) || 0;
  const direct = isDirectSession(sessionType, chatJid);
  const fromMe = Number(row?.fromMe) === 1;
  const text = String(row?.text || "");
  const memberJid = String(row?.memberJid || "").trim();
  const chat = usableDisplayName(row?.chat) || chatJid;
  let phone = "";
  if (fromMe) {
    phone = formatPhone(ownPhone);
  } else if (direct && chatJid.endsWith("@s.whatsapp.net")) {
    phone = formatPhone(jidUser(chatJid));
  } else {
    phone = formatPhone(row?.senderPhone || "");
    if (!phone && direct) phone = formatPhone(jidUser(chatJid));
  }
  const jype = fromMe ? null : jypeByPhone(phone);
  const push = usableDisplayName(row?.pushName);
  const lidName = usableDisplayName(row?.lidName);
  let senderName = "";
  if (fromMe) senderName = YAN_NAME;
  else if (jype?.name) senderName = jype.name;
  else senderName = push || lidName || (direct ? chat : "") || formatPhone(phone);
  const handle = phone || memberJid || (direct ? chatJid : "");
  const at = appleToIso(row?.atApple);
  const id = row?.id;
  const stanza = String(row?.stanzaId || "").trim();
  const footer = textHasAgentSentFooter(text);
  /** @type {string} */
  let speaker = senderName || "someone";
  /** @type {string} */
  let who = "them";
  if (fromMe && footer) {
    speaker = "Agent";
    who = "agent";
  } else if (fromMe) {
    speaker = YAN_NAME;
    who = "yan";
  }
  return {
    id,
    guid: stanza || (id != null ? `wa:${id}` : ""),
    chat,
    chatId: chatJid,
    chatJid,
    handle,
    from: senderName,
    senderName,
    senderJid: fromMe ? "" : memberJid || (direct ? chatJid : ""),
    phone,
    fromMe,
    direct,
    jypeSlug: jype?.slug || "",
    jypeMember: Boolean(jype),
    text,
    at,
    atLocal: at ? formatAtLocal(at) : "",
    speaker,
    who,
    messageType: Number(row?.messageType) || 0,
  };
}

const SELECT_SQL = `
SELECT
  m.Z_PK AS id,
  m.ZSTANZAID AS stanzaId,
  m.ZISFROMME AS fromMe,
  m.ZMESSAGETYPE AS messageType,
  m.ZTEXT AS text,
  m.ZMESSAGEDATE AS atApple,
  c.ZPARTNERNAME AS chat,
  c.ZCONTACTJID AS chatJid,
  c.ZSESSIONTYPE AS sessionType,
  gm.ZMEMBERJID AS memberJid,
  COALESCE(
    (SELECT p.ZPHONENUMBER FROM lid.ZWAPHONENUMBERLIDPAIR p WHERE p.ZLID = gm.ZMEMBERJID LIMIT 1),
    (SELECT p.ZPHONENUMBER FROM lid.ZWAPHONENUMBERLIDPAIR p WHERE p.ZLID = c.ZCONTACTJID LIMIT 1)
  ) AS senderPhone,
  COALESCE(
    (SELECT n.ZPUSHNAME FROM ZWAPROFILEPUSHNAME n WHERE n.ZJID = gm.ZMEMBERJID LIMIT 1),
    (SELECT n.ZPUSHNAME FROM ZWAPROFILEPUSHNAME n WHERE n.ZJID = c.ZCONTACTJID LIMIT 1)
  ) AS pushName,
  (SELECT d.ZDISPLAYNAME FROM lid.ZWALIDPROPERTIES d WHERE d.ZLID = gm.ZMEMBERJID LIMIT 1) AS lidName
FROM ZWAMESSAGE m
JOIN ZWACHATSESSION c ON c.Z_PK = m.ZCHATSESSION
LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
`;

function visibleWhere() {
  return `(
    m.ZTEXT IS NOT NULL AND length(trim(m.ZTEXT)) > 0
    AND IFNULL(m.ZMESSAGETYPE, 0) = 0
    AND IFNULL(c.ZCONTACTJID, '') NOT IN ('status@broadcast', '0@s.whatsapp.net')
  )`;
}

let ownPhoneCache = { at: 0, phone: "" };

export async function ownWhatsAppPhone(opts = {}) {
  const now = Date.now();
  if (!opts.chatDb && ownPhoneCache.phone && now - ownPhoneCache.at < 60_000) {
    return ownPhoneCache.phone;
  }
  const rows = await queryWhatsApp(
    `SELECT ZPHONENUMBER AS phone FROM lid.ZWAZACCOUNT
     WHERE ZUSERNAME = 'yanylevin' AND length(IFNULL(ZPHONENUMBER, '')) >= 10
     LIMIT 1;`,
    opts
  );
  const phone = formatPhone(rows[0]?.phone || "");
  if (!opts.chatDb) ownPhoneCache = { at: now, phone };
  return phone;
}

async function mapRows(rows, opts) {
  const own = await ownWhatsAppPhone(opts);
  return (Array.isArray(rows) ? rows : []).map((row) => mapWhatsAppRow(row, own));
}

/**
 * Newest first.
 * @param {{ since?: string, limit?: number, chatDb?: string, lidDb?: string }} [opts]
 */
export async function recentMessages(opts = {}) {
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 40));
  const sinceApple = sinceToApple(opts.since || "");
  const sinceSql =
    sinceApple == null ? "" : `AND m.ZMESSAGEDATE >= ${Number(sinceApple)}`;
  const sql = `${SELECT_SQL}
WHERE ${visibleWhere()}
${sinceSql}
ORDER BY m.ZMESSAGEDATE DESC, m.Z_PK DESC
LIMIT ${limit};`;
  return mapRows(await queryWhatsApp(sql, opts), opts);
}

function likeTerm(raw) {
  return String(raw || "")
    .replaceAll("'", "''")
    .replaceAll("%", "")
    .replaceAll("_", "")
    .trim();
}

/**
 * Oldest of the batch first, like iMessage thread.
 * @param {string} person chat name, phone, or jid
 * @param {{ limit?: number, chatDb?: string, lidDb?: string }} [opts]
 */
export async function recentThread(person, opts = {}) {
  const q = likeTerm(person);
  if (!q) return [];
  const limit = Math.min(200, Math.max(1, Number(opts.limit) || 40));
  const digits = phoneDigits(q);
  const phoneSql =
    digits.length >= 10
      ? `OR c.ZCONTACTJID LIKE ${sqlQuote(`%${digits.slice(-10)}%`)}`
      : "";
  const sql = `${SELECT_SQL}
WHERE ${visibleWhere()}
AND (
  c.ZPARTNERNAME = ${sqlQuote(String(person || "").trim())}
  OR c.ZCONTACTJID = ${sqlQuote(String(person || "").trim())}
  OR c.ZPARTNERNAME LIKE ${sqlQuote(`%${q}%`)}
  ${phoneSql}
)
ORDER BY m.ZMESSAGEDATE DESC, m.Z_PK DESC
LIMIT ${limit};`;
  const rows = await mapRows(await queryWhatsApp(sql, opts), opts);
  return rows.reverse();
}

/**
 * @param {string} query
 * @param {{ limit?: number, chatDb?: string, lidDb?: string }} [opts]
 */
export async function searchMessages(query, opts = {}) {
  const q = likeTerm(query);
  if (!q) return [];
  const limit = Math.min(80, Math.max(1, Number(opts.limit) || 20));
  const sql = `${SELECT_SQL}
WHERE ${visibleWhere()}
AND (
  m.ZTEXT LIKE ${sqlQuote(`%${q}%`)}
  OR c.ZPARTNERNAME LIKE ${sqlQuote(`%${q}%`)}
  OR IFNULL(gm.ZMEMBERJID, '') LIKE ${sqlQuote(`%${q}%`)}
)
ORDER BY m.ZMESSAGEDATE DESC, m.Z_PK DESC
LIMIT ${limit};`;
  return mapRows(await queryWhatsApp(sql, opts), opts);
}

/**
 * Resolve a send target to one chat session.
 * @param {string} to name, phone, or jid
 * @param {{ chatDb?: string, lidDb?: string }} [opts]
 */
export async function findWhatsAppChat(to, opts = {}) {
  const raw = String(to || "").trim();
  if (!raw) return null;
  const q = likeTerm(raw);
  const digits = phoneDigits(raw);
  const phoneSql =
    digits.length >= 10
      ? `OR c.ZCONTACTJID LIKE ${sqlQuote(`%${digits.slice(-10)}%`)}
         OR EXISTS (
           SELECT 1 FROM lid.ZWAPHONENUMBERLIDPAIR p
           WHERE p.ZLID = c.ZCONTACTJID AND p.ZPHONENUMBER LIKE ${sqlQuote(`%${digits.slice(-10)}`)}
         )`
      : "";
  const sql = `
SELECT c.Z_PK AS id, c.ZPARTNERNAME AS chat, c.ZCONTACTJID AS chatJid, c.ZSESSIONTYPE AS sessionType
FROM ZWACHATSESSION c
WHERE IFNULL(c.ZREMOVED, 0) = 0
AND IFNULL(c.ZCONTACTJID, '') NOT IN ('status@broadcast', '0@s.whatsapp.net')
AND (
  c.ZPARTNERNAME = ${sqlQuote(raw)}
  OR c.ZCONTACTJID = ${sqlQuote(raw)}
  OR c.ZPARTNERNAME LIKE ${sqlQuote(`%${q}%`)}
  ${phoneSql}
)
ORDER BY
  CASE WHEN c.ZPARTNERNAME = ${sqlQuote(raw)} OR c.ZCONTACTJID = ${sqlQuote(raw)} THEN 0 ELSE 1 END,
  c.ZLASTMESSAGEDATE DESC
LIMIT 5;`;
  const rows = await queryWhatsApp(sql, opts);
  if (!rows.length) return null;
  const exact = rows.filter(
    (r) =>
      String(r.chat || "") === raw ||
      String(r.chatJid || "") === raw ||
      (digits.length >= 10 &&
        String(r.chatJid || "").replace(/\D/g, "").endsWith(digits.slice(-10)))
  );
  const pick = exact[0] || rows[0];
  const name = usableDisplayName(pick.chat) || String(pick.chatJid || "");
  if (!name) return null;
  return {
    id: pick.id,
    chat: name,
    chatJid: String(pick.chatJid || ""),
    direct: isDirectSession(pick.sessionType, pick.chatJid),
  };
}
