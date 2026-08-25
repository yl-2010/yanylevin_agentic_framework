/**
 * Mail.app local store dump (Envelope Index + .emlx MIME).
 * Never uses AppleScript `content of message` (often blank for HTML-only).
 *
 *   node apple-mail.js dump --out /tmp/yanylevin-apple-mail-export
 */

import { execFile } from "node:child_process";
import { access, copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultMailEnvelopeDb } from "./mail-people-read.js";
import { stripHtml } from "./school-mail.js";

const execFileAsync = promisify(execFile);

export const DUMP_BODY_MAX = 20_000;
export const EMPTY_BODY_MAX_RATE = 0.05;
export const IMAGE_OMITTED = "[image omitted]";

const SKIP_FOLDER_RE =
  /\bjunk\b|\btrash\b|deleted messages|\bdrafts\b|\boutbox\b|junk e-mail|\bspam\b|sendlater|local:\/\//i;

const ACCOUNT_UUID_RE =
  /[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}/;

const APPLE_EPOCH = 978_307_200;

export function defaultMailRoot() {
  return (
    String(process.env.MAIL_ROOT || "").trim() || join(homedir(), "Library/Mail/V10")
  );
}

export function defaultDumpDir() {
  return "/tmp/yanylevin-apple-mail-export";
}

export function wrapEmlx(rfc822) {
  const body = String(rfc822);
  return `${Buffer.byteLength(body)}\n${body}`;
}

export function appleTimeToIso(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return "";
  if (n > 1e12) return new Date(n).toISOString();
  if (n > 1e9) return new Date(n * 1000).toISOString();
  return new Date((n + APPLE_EPOCH) * 1000).toISOString();
}

export function monthKeyFromIso(iso) {
  const key = String(iso || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : "unknown";
}

export function shouldSkipMailbox(url, name) {
  return SKIP_FOLDER_RE.test(`${url || ""} ${name || ""}`);
}

export function accountFromMailbox(url) {
  const u = decodeURIComponent(String(url || "")).toLowerCase();
  if (u.startsWith("ews://") || u.includes("ews://")) return "Exchange";
  if (u.includes("[gmail]")) return "Google";
  if (u.includes("gmail.com") || u.includes("googlemail.com") || u.includes("you@example.com")) {
    return "Google";
  }
  if (
    u.includes("icloud.com") ||
    u.includes("me.com") ||
    u.includes("mac.com") ||
    u.includes("you@icloud.com")
  ) {
    return "iCloud";
  }
  if (
    u.includes("outlook") ||
    u.includes("office365") ||
    u.includes("hotmail") ||
    u.includes("live.com") ||
    u.includes("exchange") ||
    u.includes("you@example.com")
  ) {
    return "Exchange";
  }
  return "Unknown";
}

export function folderFromMailbox(url, name) {
  const named = String(name || "").trim();
  const source =
    named && !/^[a-z][a-z0-9+.-]*:/i.test(named) ? named : String(url || named || "");
  const u = source.replace(/\/+$/, "");
  const parts = u.split("/");
  return decodeURIComponent(parts[parts.length - 1] || "Inbox") || "Inbox";
}

/**
 * Mail.app stores accounts as UUID directories. Envelope URLs look like
 * `imap://UUID/INBOX` or `ews://UUID/Inbox`, with no gmail/outlook host.
 */
export async function accountMapFromMailRoot(mailRoot) {
  /** @type {Map<string, string>} */
  const map = new Map();
  let entries = [];
  try {
    entries = await readdir(mailRoot, { withFileTypes: true });
  } catch {
    return map;
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === "MailData") continue;
    const names = await readdir(join(mailRoot, ent.name)).catch(() => []);
    const joined = names.join(" ").toLowerCase();
    let account = "Unknown";
    if (names.some((n) => String(n).includes("[Gmail]"))) account = "Google";
    else if (joined.includes("junk email") || names.includes("Inbox.mbox")) account = "Exchange";
    else if (names.includes("INBOX.mbox") || names.includes("Sent Messages.mbox")) {
      account = "iCloud";
    }
    map.set(ent.name.toUpperCase(), account);
    map.set(ent.name, account);
  }
  return map;
}

export function resolveAccount(url, uuidMap) {
  const labeled = accountFromMailbox(url);
  if (labeled !== "Unknown") return labeled;
  const m = String(url || "").match(ACCOUNT_UUID_RE);
  if (!m || !uuidMap) return "Unknown";
  return uuidMap.get(m[0].toUpperCase()) || uuidMap.get(m[0]) || "Unknown";
}

export function decodeQuotedPrintable(raw) {
  const src = String(raw || "").replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "=" && /[0-9A-Fa-f]{2}/.test(src.slice(i + 1, i + 3))) {
      bytes.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(src.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function decodeBase64(raw) {
  try {
    return Buffer.from(String(raw || "").replace(/\s+/g, ""), "base64").toString("utf8");
  } catch {
    return "";
  }
}

export function decodeMimeWord(raw) {
  return String(raw || "").replace(
    /=\?([^?]+)\?([bqBQ])\?([^?]*)\?=/g,
    (_m, _cs, enc, data) => {
      if (String(enc).toUpperCase() === "B") return decodeBase64(data);
      return decodeQuotedPrintable(data.replace(/_/g, " "));
    }
  );
}

function unfoldHeaders(headerText) {
  return String(headerText || "").replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
}

export function parseHeaderBlock(headerText) {
  /** @type {Record<string, string>} */
  const headers = {};
  for (const line of unfoldHeaders(headerText).split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = decodeMimeWord(line.slice(i + 1).trim());
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value;
  }
  return headers;
}

function parseContentType(raw) {
  const parts = String(raw || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  const type = (parts.shift() || "text/plain").toLowerCase();
  /** @type {Record<string, string>} */
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toLowerCase();
    let v = p.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    params[k] = v;
  }
  return { type, params };
}

function decodeBody(body, encoding) {
  const enc = String(encoding || "7bit").toLowerCase();
  if (enc.includes("quoted-printable")) return decodeQuotedPrintable(body);
  if (enc.includes("base64")) return decodeBase64(body);
  return String(body || "");
}

function splitMultipart(body, boundary) {
  if (!boundary) return [];
  const token = `--${boundary}`;
  const chunks = String(body || "").split(token);
  /** @type {string[]} */
  const parts = [];
  for (const chunk of chunks) {
    const trimmed = chunk.replace(/^\r?\n/, "");
    if (!trimmed || trimmed.startsWith("--")) continue;
    parts.push(trimmed.replace(/\r?\n--\s*$/, ""));
  }
  return parts;
}

/**
 * @param {string} rfc822
 * @returns {{ text: string, imageOnly: boolean }}
 */
export function extractPlaintext(rfc822) {
  return extractPart(String(rfc822 || "").replace(/\r\n/g, "\n"));
}

function extractPart(raw) {
  const text = String(raw || "");
  const split = text.search(/\n\n/);
  const headerText = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? "" : text.slice(split + 2);
  const headers = parseHeaderBlock(headerText);
  const { type, params } = parseContentType(headers["content-type"] || "text/plain");
  const decoded = decodeBody(body, headers["content-transfer-encoding"]);

  if (type.startsWith("multipart/")) {
    const parts = splitMultipart(decoded || body, params.boundary);
    /** @type {string[]} */
    const plains = [];
    /** @type {string[]} */
    const htmls = [];
    let sawImage = false;
    for (const part of parts) {
      const got = extractPart(part);
      if (got.imageOnly) sawImage = true;
      else if (got.text) {
        if (/content-type:\s*text\/html/i.test(part.slice(0, 500))) htmls.push(got.text);
        else plains.push(got.text);
      }
    }
    if (plains.length) return { text: plains.join("\n"), imageOnly: false };
    if (htmls.length) return { text: htmls.join("\n"), imageOnly: false };
    if (sawImage) return { text: IMAGE_OMITTED, imageOnly: true };
    return { text: "", imageOnly: false };
  }

  if (type.startsWith("image/")) return { text: IMAGE_OMITTED, imageOnly: true };
  if (type === "text/html" || type.endsWith("/html")) {
    return { text: stripHtml(decoded, DUMP_BODY_MAX), imageOnly: false };
  }
  if (type.startsWith("text/")) {
    return { text: decoded.trim().slice(0, DUMP_BODY_MAX), imageOnly: false };
  }
  return { text: "", imageOnly: false };
}

export function parseEmlx(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw || "");
  const nl = text.indexOf("\n");
  const rest = nl === -1 ? text : text.slice(nl + 1);
  const plist = rest.lastIndexOf("<?xml");
  return plist > 0 ? rest.slice(0, plist) : rest;
}

export function addressFromHeader(raw) {
  const s = decodeMimeWord(String(raw || ""));
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim();
  const bare = s.match(/[^\s<>,;]+@[^\s<>,;]+/);
  return bare ? bare[0] : s.trim();
}

export function formatDumpMessage(msg) {
  const body = String(msg.body || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, DUMP_BODY_MAX);
  return [
    `${msg.received} | account=${msg.account} | folder=${msg.folder} | from=${msg.from} | to=${msg.to || ""} | ${msg.subject}`,
    body,
    "",
  ].join("\n");
}

export function emptyBodyRate(stats) {
  const denom = Number(stats?.withEmlx) || 0;
  if (!denom) return 1;
  return (Number(stats.emptyBody) || 0) / denom;
}

export function assertDumpQuality(stats) {
  const withEmlx = Number(stats?.withEmlx) || 0;
  if (!withEmlx) {
    throw new Error("apple-mail dump: no .emlx bodies found");
  }
  const rate = emptyBodyRate(stats);
  if (rate > EMPTY_BODY_MAX_RATE) {
    const sample = (stats.emptySamples || []).slice(0, 8).join(", ");
    throw new Error(
      `apple-mail dump: empty-body rate ${(rate * 100).toFixed(1)}% exceeds 5%` +
        (sample ? ` (ids ${sample})` : "")
    );
  }
  return rate;
}

async function sqliteJson(db, sql) {
  try {
    const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", db, sql], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = String(stdout || "").trim();
    if (!text) return [];
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  } catch (err) {
    const { stdout } = await execFileAsync("sqlite3", ["-json", db, sql], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const text = String(stdout || "").trim();
    if (!text) return [];
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows : [];
  }
}

async function tableNames(db) {
  const rows = await sqliteJson(
    db,
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
  );
  return rows.map((r) => String(r.name || ""));
}

async function columnNames(db, table) {
  const rows = await sqliteJson(db, `PRAGMA table_info(${table});`);
  return rows.map((r) => String(r.name || ""));
}

export async function listEnvelopeMessages(db) {
  const tables = await tableNames(db);
  if (!tables.includes("messages")) {
    throw new Error("Envelope Index has no messages table");
  }
  const msgCols = await columnNames(db, "messages");
  const mailboxCols = tables.includes("mailboxes") ? await columnNames(db, "mailboxes") : [];
  const hasSubjects = tables.includes("subjects");
  const hasAddresses = tables.includes("addresses");

  const senderJoin =
    hasAddresses && msgCols.includes("sender")
      ? "LEFT JOIN addresses a ON a.ROWID = m.sender"
      : "";
  const subjectJoin =
    hasSubjects && msgCols.includes("subject")
      ? "LEFT JOIN subjects s ON s.ROWID = m.subject"
      : "";
  const mailboxJoin =
    mailboxCols.length && msgCols.includes("mailbox")
      ? "LEFT JOIN mailboxes mb ON mb.ROWID = m.mailbox"
      : "";

  const senderExpr = senderJoin ? "a.address" : "''";
  const subjectExpr = subjectJoin
    ? "s.subject"
    : msgCols.includes("subject")
      ? "m.subject"
      : "''";
  const mailboxUrlExpr = mailboxCols.includes("url") ? "mb.url" : "''";
  const mailboxNameExpr = mailboxCols.includes("name")
    ? "mb.name"
    : mailboxCols.includes("url")
      ? "mb.url"
      : "''";
  const dateExpr = msgCols.includes("date_received")
    ? "m.date_received"
    : msgCols.includes("date_sent")
      ? "m.date_sent"
      : "0";
  const deletedWhere = msgCols.includes("deleted") ? "WHERE COALESCE(m.deleted, 0) = 0" : "";

  const sql = `
    SELECT
      m.ROWID as id,
      ${dateExpr} as date_received,
      ${subjectExpr} as subject,
      ${senderExpr} as sender,
      ${mailboxUrlExpr} as mailbox_url,
      ${mailboxNameExpr} as mailbox_name
    FROM messages m
    ${subjectJoin}
    ${senderJoin}
    ${mailboxJoin}
    ${deletedWhere};
  `;
  const rows = await sqliteJson(db, sql);

  /** @type {Map<number, string[]>} */
  const toById = new Map();
  if (tables.includes("recipients") && hasAddresses) {
    const recCols = await columnNames(db, "recipients");
    const msgCol = recCols.includes("message")
      ? "message"
      : recCols.includes("message_id")
        ? "message_id"
        : "";
    const addrCol = recCols.includes("address")
      ? "address"
      : recCols.includes("address_id")
        ? "address_id"
        : "";
    const typeFilter = recCols.includes("type") ? "WHERE COALESCE(r.type, 0) = 0" : "";
    if (msgCol && addrCol) {
      const recs = await sqliteJson(
        db,
        `SELECT r.${msgCol} as id, a.address as address
         FROM recipients r
         JOIN addresses a ON a.ROWID = r.${addrCol}
         ${typeFilter};`
      );
      for (const rec of recs) {
        const id = Number(rec.id);
        const addr = String(rec.address || "").trim();
        if (!id || !addr) continue;
        const list = toById.get(id) || [];
        list.push(addr);
        toById.set(id, list);
      }
    }
  }

  return rows.map((row) => {
    const id = Number(row.id);
    return {
      id,
      received: appleTimeToIso(row.date_received),
      subject: decodeMimeWord(row.subject || "(no subject)"),
      from: String(row.sender || "").trim(),
      to: (toById.get(id) || []).join(", "),
      mailboxUrl: String(row.mailbox_url || ""),
      mailboxName: String(row.mailbox_name || ""),
    };
  });
}

export async function indexEmlxFiles(mailRoot) {
  /** @type {Map<number, string>} */
  const map = new Map();
  async function walk(dir) {
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === "Attachments" || ent.name === "MailData") continue;
        await walk(full);
        continue;
      }
      if (!ent.isFile()) continue;
      if (ent.name.endsWith(".partial.emlx")) continue;
      if (extname(ent.name) !== ".emlx") continue;
      const id = Number(basename(ent.name, ".emlx"));
      if (!Number.isFinite(id) || id <= 0) continue;
      if (!map.has(id)) map.set(id, full);
    }
  }
  await walk(mailRoot);
  return map;
}

async function snapshotEnvelopeDb(src) {
  const dest = join(tmpdir(), `yanylevin-envelope-${process.pid}-${Date.now()}.db`);
  await rm(dest, { force: true });
  const escaped = dest.replace(/'/g, "''");
  try {
    await execFileAsync("sqlite3", [src, `VACUUM INTO '${escaped}'`], { timeout: 60_000 });
    await access(dest);
    return dest;
  } catch {
    /* live Mail DB is often busy; try .backup then a raw copy */
  }
  try {
    await execFileAsync("sqlite3", [src, `.backup ${dest}`], { timeout: 60_000 });
    await access(dest);
    return dest;
  } catch {
    /* fall through to copy */
  }
  await copyFile(src, dest);
  for (const suffix of ["-wal", "-shm"]) {
    try {
      await copyFile(`${src}${suffix}`, `${dest}${suffix}`);
    } catch {
      /* no sidecar */
    }
  }
  await access(dest);
  return dest;
}

/**
 * @param {{ mailRoot?: string, envelopeDb?: string, outDir?: string, since?: string }} [opts]
 */
export async function dumpAppleMail(opts = {}) {
  const mailRoot = String(opts.mailRoot || opts.mailRoot || "").trim() || defaultMailRoot();
  const envelopeDb =
    String(opts.envelopeDb || opts.envelopeDb || "").trim() || defaultMailEnvelopeDb();
  const outDir = String(opts.outDir || "").trim() || defaultDumpDir();
  const since = String(opts.since || "").trim();

  const snapshot = await snapshotEnvelopeDb(envelopeDb);
  let messages;
  try {
    messages = await listEnvelopeMessages(snapshot);
  } finally {
    await rm(snapshot, { force: true }).catch(() => {});
    await rm(`${snapshot}-wal`, { force: true }).catch(() => {});
    await rm(`${snapshot}-shm`, { force: true }).catch(() => {});
  }

  const emlxMap = await indexEmlxFiles(mailRoot);
  const uuidMap = await accountMapFromMailRoot(mailRoot);
  /** @type {Map<string, object[]>} */
  const byMonth = new Map();
  const stats = {
    messages: 0,
    skippedFolder: 0,
    withEmlx: 0,
    missingEmlx: 0,
    withBody: 0,
    emptyBody: 0,
    imageOnly: 0,
    emptySamples: /** @type {number[]} */ ([]),
    byAccount: /** @type {Record<string, number>} */ ({}),
    minDate: "",
    maxDate: "",
  };

  for (const row of messages) {
    if (shouldSkipMailbox(row.mailboxUrl, row.mailboxName)) {
      stats.skippedFolder += 1;
      continue;
    }
    if (since && row.received && row.received < since) continue;
    const account = resolveAccount(row.mailboxUrl, uuidMap);
    const folder = folderFromMailbox(row.mailboxUrl, row.mailboxName);
    const emlxPath = emlxMap.get(row.id);
    let body = "";
    let imageOnly = false;
    if (emlxPath) {
      stats.withEmlx += 1;
      try {
        const raw = await readFile(emlxPath);
        const extracted = extractPlaintext(parseEmlx(raw));
        body = extracted.text;
        imageOnly = extracted.imageOnly;
      } catch {
        body = "";
      }
    } else {
      stats.missingEmlx += 1;
    }

    if (imageOnly) stats.imageOnly += 1;
    else if (body.trim()) stats.withBody += 1;
    else if (emlxPath) {
      stats.emptyBody += 1;
      if (stats.emptySamples.length < 12) stats.emptySamples.push(row.id);
    }

    const received = row.received || new Date().toISOString();
    if (!stats.minDate || received < stats.minDate) stats.minDate = received;
    if (!stats.maxDate || received > stats.maxDate) stats.maxDate = received;
    stats.byAccount[account] = (stats.byAccount[account] || 0) + 1;
    stats.messages += 1;

    const month = monthKeyFromIso(received);
    const list = byMonth.get(month) || [];
    list.push({
      received,
      account,
      folder,
      from: row.from,
      to: row.to,
      subject: row.subject || "(no subject)",
      body: imageOnly ? IMAGE_OMITTED : body,
    });
    byMonth.set(month, list);
  }

  assertDumpQuality(stats);

  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  /** @type {{ month: string, file: string, count: number, bytes: number }[]} */
  const files = [];
  for (const [month, rows] of months) {
    const file = `${month}.txt`;
    const text = rows.map((m) => formatDumpMessage(m)).join("\n");
    await writeFile(join(outDir, file), text, { mode: 0o600 });
    files.push({ month, file, count: rows.length, bytes: Buffer.byteLength(text) });
  }

  const manifest = {
    ok: true,
    at: new Date().toISOString(),
    messages: stats.messages,
    withBody: stats.withBody,
    emptyBody: stats.emptyBody,
    imageOnly: stats.imageOnly,
    missingEmlx: stats.missingEmlx,
    withEmlx: stats.withEmlx,
    skippedFolder: stats.skippedFolder,
    byAccount: stats.byAccount,
    minDate: stats.minDate,
    maxDate: stats.maxDate,
    files,
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...manifest, outDir };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "dump";
  function flag(name, fallback = "") {
    const i = argv.indexOf(name);
    return i !== -1 ? String(argv[i + 1] || "").trim() : fallback;
  }
  if (cmd !== "dump") {
    console.error(
      "usage: node apple-mail.js dump [--out dir] [--since ISO] [--mail-root path] [--db path]"
    );
    process.exitCode = 1;
  } else {
    dumpAppleMail({
      outDir: flag("--out"),
      since: flag("--since"),
      mailRoot: flag("--mail-root"),
      envelopeDb: flag("--db"),
    })
      .then((manifest) => {
        console.log(
          `[apple-mail] ${manifest.messages} msgs, ${manifest.files.length} months, empty=${manifest.emptyBody} ${manifest.outDir}`
        );
      })
      .catch((err) => {
        console.error("[apple-mail] dump failed", err);
        process.exitCode = 1;
      });
  }
}
