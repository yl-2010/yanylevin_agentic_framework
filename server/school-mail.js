/**
 * School Microsoft 365 Outlook (owner@school.example) via Outlook on the
 * web. No Graph app registration. One headed Chrome login on the Studio,
 * then headless reuse of that profile's cookies / Bearer token.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const SCHOOL_EMAIL = "owner@school.example";
export const DEFAULT_DUMP_SINCE = "2024-06-01T00:00:00Z";
export const DUMP_PAGE_SIZE = 50;
export const DUMP_BODY_MAX = 4000;
export const OWA_URL = "https://outlook.office.com/mail/";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
export const OUTLOOK_REST_BASE = "https://outlook.office.com/api/v2.0";
const LOGIN_WAIT_MS = 10 * 60_000;
const REFRESH_WAIT_MS = 45_000;
const TOKEN_SKEW_S = 90;

export function schoolMailDir() {
  return (
    String(process.env.SCHOOL_MAIL_DIR || "").trim() ||
    join(homedir(), ".yanylevin", "school-mail")
  );
}

export function profileDir(root = schoolMailDir()) {
  return join(root, "chrome-profile");
}

export function sessionPath(root = schoolMailDir()) {
  return join(root, "session.json");
}

export function parseArgs(argv) {
  const args = [...argv];
  const cmd = String(args.shift() || "").trim();
  const out = {
    cmd,
    force: false,
    headed: false,
    limit: 20,
    query: "",
    id: "",
    since: "",
    out: "",
    includeBody: false,
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--force") out.force = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--body") out.includeBody = true;
    else if (a === "--since") out.since = String(args.shift() || "").trim();
    else if (a === "--out") out.out = String(args.shift() || "").trim();
    else if (a === "--limit") {
      const n = Number(args.shift());
      out.limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 20;
    } else if (cmd === "search" && !out.query) {
      const rest = [a];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.query = rest.join(" ").trim();
    } else if (cmd === "read" && !out.id) {
      out.id = String(a || "").trim();
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

export function redactSecrets(raw) {
  return String(raw || "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [redacted]")
    .replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, "[jwt]");
}

function b64urlJson(part) {
  try {
    const padded = part.replace(/-/g, "+").replace(/_/g, "/");
    const buf = Buffer.from(padded, "base64");
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}

export function jwtClaims(token) {
  const part = String(token || "").split(".")[1];
  if (!part) return {};
  const claims = b64urlJson(part);
  return claims && typeof claims === "object" ? claims : {};
}

export function tokenAudience(token) {
  const aud = jwtClaims(token).aud;
  if (Array.isArray(aud)) return aud.map(String).join(" ");
  return String(aud || "");
}

export function jwtExp(token) {
  const exp = Number(jwtClaims(token).exp);
  return Number.isFinite(exp) ? exp : 0;
}

export function jwtEmail(token) {
  const c = jwtClaims(token);
  return String(
    c.preferred_username || c.upn || c.unique_name || c.email || ""
  ).trim();
}

export function isMailToken(token) {
  const aud = tokenAudience(token).toLowerCase();
  if (!aud) return false;
  return (
    aud.includes("graph.microsoft.com") ||
    aud.includes("outlook.office.com") ||
    aud.includes("outlook.office365.com") ||
    aud.includes("00000003-0000-0000-c000-000000000000")
  );
}

export function apiBaseForAudience(aud) {
  const a = String(aud || "").toLowerCase();
  if (a.includes("graph.microsoft.com") || a.includes("00000003-0000-0000-c000-000000000000")) {
    return GRAPH_BASE;
  }
  return OUTLOOK_REST_BASE;
}

export function isSessionFresh(session, nowMs = Date.now()) {
  const exp = Number(session?.exp || 0);
  if (!exp || !session?.token) return false;
  return exp * 1000 > nowMs + TOKEN_SKEW_S * 1000;
}

function emailAddress(raw) {
  if (!raw || typeof raw !== "object") return { name: "", address: "" };
  const inner = raw.emailAddress || raw.EmailAddress || raw;
  return {
    name: String(inner.name || inner.Name || "").trim(),
    address: String(inner.address || inner.Address || "").trim(),
  };
}

export function stripHtml(html, max = 8000) {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function normalizeMessage(raw, { includeBody = false } = {}) {
  const from = emailAddress(raw.from || raw.From);
  const body = raw.body || raw.Body || {};
  const html = String(body.content || body.Content || "");
  const type = String(body.contentType || body.ContentType || "").toLowerCase();
  const preview = String(raw.bodyPreview || raw.BodyPreview || "").trim();
  const toList = Array.isArray(raw.toRecipients || raw.ToRecipients)
    ? (raw.toRecipients || raw.ToRecipients).map((r) => emailAddress(r).address).filter(Boolean)
    : [];
  const out = {
    id: String(raw.id || raw.Id || ""),
    subject: String(raw.subject || raw.Subject || "(no subject)").trim(),
    from: from.address ? `${from.name} <${from.address}>`.trim() : from.name,
    fromAddress: from.address,
    to: toList.join(", "),
    received: String(raw.receivedDateTime || raw.ReceivedDateTime || ""),
    unread: !(raw.isRead ?? raw.IsRead ?? true),
    preview: preview.slice(0, 400),
  };
  if (includeBody) {
    out.body = type.includes("text") ? html.trim().slice(0, 8000) : stripHtml(html);
  }
  return out;
}

export function buildListUrl(base, { search = "", limit = 20 } = {}) {
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  if (base === GRAPH_BASE) {
    const select =
      "$select=id,subject,from,receivedDateTime,bodyPreview,isRead,webLink";
    if (search) {
      const q = `"${String(search).replace(/"/g, "")}"`;
      return `${base}/me/messages?$search=${encodeURIComponent(q)}&$top=${top}&${select}`;
    }
    return `${base}/me/mailFolders/Inbox/messages?$top=${top}&$orderby=receivedDateTime desc&${select}`;
  }
  const select =
    "$select=Id,Subject,From,ReceivedDateTime,BodyPreview,IsRead,WebLink";
  if (search) {
    const q = `"${String(search).replace(/"/g, "")}"`;
    return `${base}/me/messages?$search=${encodeURIComponent(q)}&$top=${top}&${select}`;
  }
  return `${base}/me/mailFolders/Inbox/messages?$top=${top}&$orderby=ReceivedDateTime desc&${select}`;
}

export function buildReadUrl(base, id) {
  const safe = encodeURIComponent(String(id || "").trim());
  if (base === GRAPH_BASE) {
    return `${base}/me/messages/${safe}?$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,webLink`;
  }
  return `${base}/me/messages/${safe}?$select=Id,Subject,From,ToRecipients,ReceivedDateTime,BodyPreview,Body,IsRead,WebLink`;
}

export function sinceIsoOrDefault(raw) {
  const s = String(raw || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  if (s) return s;
  return DEFAULT_DUMP_SINCE;
}

export function buildDumpUrl(base, { since, limit = DUMP_PAGE_SIZE, includeBody = false } = {}) {
  const top = Math.min(DUMP_PAGE_SIZE, Math.max(1, Number(limit) || DUMP_PAGE_SIZE));
  const iso = sinceIsoOrDefault(since);
  if (base === GRAPH_BASE) {
    const select = includeBody
      ? "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,isRead,isDraft"
      : "$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,isDraft";
    const filter = `receivedDateTime ge ${iso} and isDraft eq false`;
    return `${base}/me/messages?$filter=${encodeURIComponent(filter)}&$orderby=receivedDateTime asc&$top=${top}&${select}`;
  }
  const select = includeBody
    ? "$select=Id,Subject,From,ToRecipients,ReceivedDateTime,BodyPreview,Body,IsRead"
    : "$select=Id,Subject,From,ToRecipients,ReceivedDateTime,BodyPreview,IsRead";
  const filter = `ReceivedDateTime ge ${iso}`;
  return `${base}/me/messages?$filter=${encodeURIComponent(filter)}&$orderby=ReceivedDateTime asc&$top=${top}&${select}`;
}

export function monthKeyFromIso(iso) {
  const key = String(iso || "").slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : "unknown";
}

export function formatDumpMessage(msg) {
  const body = String(msg.body || msg.preview || "")
    .replace(/\r\n/g, "\n")
    .trim()
    .slice(0, DUMP_BODY_MAX);
  return [
    `${msg.received} | from=${msg.fromAddress || msg.from} | to=${msg.to || ""} | ${msg.subject}`,
    body,
    "",
  ].join("\n");
}

export function groupMessagesByMonth(messages) {
  /** @type {Map<string, object[]>} */
  const map = new Map();
  for (const msg of messages || []) {
    const key = monthKeyFromIso(msg.received);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(msg);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function loadSession(root = schoolMailDir()) {
  try {
    const raw = await readFile(sessionPath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(session, root = schoolMailDir()) {
  const dir = root;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dest = sessionPath(root);
  const tmp = `${dest}.${process.pid}.tmp`;
  const body = JSON.stringify(
    {
      token: session.token,
      exp: jwtExp(session.token),
      aud: tokenAudience(session.token),
      email: jwtEmail(session.token),
      capturedAt: new Date().toISOString(),
    },
    null,
    2
  );
  await writeFile(tmp, body, { mode: 0o600 });
  await rename(tmp, dest);
}

function needsLoginPayload(detail) {
  return {
    ok: false,
    error: "not signed in",
    hint: "On the Mac Studio, run: node server/school-mail.js login",
    detail: detail || "",
    account: SCHOOL_EMAIL,
  };
}

/**
 * @param {import("playwright-core").BrowserContext} context
 * @param {number} timeoutMs
 */
function waitForMailToken(context, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      context.off("request", onReq);
      reject(new Error("timed out waiting for Outlook sign-in"));
    }, timeoutMs);
    function onReq(req) {
      const headers = req.headers();
      const h = headers.authorization || headers.Authorization || "";
      if (!/^Bearer\s+/i.test(h)) return;
      const token = h.replace(/^Bearer\s+/i, "").trim();
      if (!isMailToken(token)) return;
      clearTimeout(timer);
      context.off("request", onReq);
      resolve(token);
    }
    context.on("request", onReq);
  });
}

async function launchChrome(opts) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed (cd server && npm install)");
  }
  const headed = Boolean(opts.headed);
  const dir = profileDir(opts.root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: headed ? [] : ["--window-position=-2400,-2400"],
  });
}

async function captureToken(opts) {
  const headed = Boolean(opts.headed);
  const waitMs = headed ? LOGIN_WAIT_MS : REFRESH_WAIT_MS;
  const context = await launchChrome(opts);
  try {
    const pending = waitForMailToken(context, waitMs);
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(OWA_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const token = await pending;
    await saveSession({ token }, opts.root);
    return token;
  } finally {
    await context.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiGet(url, token) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Prefer: 'outlook.body-content-type="text"',
      },
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`Outlook API ${res.status}`);
      lastErr.status = res.status;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const snippet = redactSecrets(text).replace(/\s+/g, " ").slice(0, 220);
      const err = new Error(`Outlook API ${res.status}: ${snippet}`);
      err.status = res.status;
      throw err;
    }
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
  throw lastErr || new Error("Outlook API retry exhausted");
}

/**
 * @param {{ since?: string, includeBody?: boolean, max?: number, pageSize?: number, root?: string, headed?: boolean, force?: boolean }} [opts]
 */
export async function fetchSchoolMessages(opts = {}) {
  const token = await resolveToken({
    root: opts.root,
    headed: Boolean(opts.headed),
    force: Boolean(opts.force),
  });
  const base = apiBaseForAudience(tokenAudience(token));
  let url = buildDumpUrl(base, {
    since: opts.since,
    limit: opts.pageSize || DUMP_PAGE_SIZE,
    includeBody: Boolean(opts.includeBody),
  });
  const max = Number(opts.max) || 0;
  /** @type {object[]} */
  const all = [];
  while (url) {
    const data = await apiGet(url, token);
    const rows = Array.isArray(data.value) ? data.value : [];
    for (const row of rows) {
      all.push(normalizeMessage(row, { includeBody: Boolean(opts.includeBody) }));
      if (max && all.length >= max) return all;
    }
    url = String(data["@odata.nextLink"] || "").trim();
    if (url) await sleep(80);
  }
  return all;
}

export function defaultDumpDir() {
  return join(tmpdir(), "yanylevin-school-mail-export");
}

/**
 * @param {{ since?: string, outDir?: string, root?: string, includeBody?: boolean }} [opts]
 */
export async function dumpSchoolMail(opts = {}) {
  const since = sinceIsoOrDefault(opts.since);
  const outDir = String(opts.outDir || "").trim() || defaultDumpDir();
  const messages = await fetchSchoolMessages({
    since,
    includeBody: opts.includeBody !== false,
    root: opts.root,
  });
  await mkdir(outDir, { recursive: true, mode: 0o700 });
  const months = groupMessagesByMonth(messages);
  /** @type {{ month: string, file: string, count: number, bytes: number }[]} */
  const files = [];
  for (const [month, rows] of months) {
    const file = `${month}.txt`;
    const body = rows.map((m) => formatDumpMessage(m)).join("\n");
    const path = join(outDir, file);
    await writeFile(path, body, { mode: 0o600 });
    files.push({ month, file, count: rows.length, bytes: Buffer.byteLength(body) });
  }
  const manifest = {
    ok: true,
    account: SCHOOL_EMAIL,
    since,
    at: new Date().toISOString(),
    messages: messages.length,
    files,
  };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...manifest, outDir };
}

async function resolveToken(opts) {
  const root = opts.root || schoolMailDir();
  const session = await loadSession(root);
  if (isSessionFresh(session) && !opts.force) return session.token;
  if (!session) {
    throw new Error("no saved school Outlook session");
  }
  try {
    return await captureToken({
      headed: Boolean(opts.headed),
      root,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session.token && !opts.force) return session.token;
    throw new Error(msg);
  }
}

export async function runSchoolMail(argv, opts = {}) {
  const parsed = parseArgs(argv);
  const root = opts.root || schoolMailDir();
  const cmd = parsed.cmd;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      usage:
        "node server/school-mail.js login|status|inbox|search <q>|read <id>|dump [--since YYYY-MM-DD] [--out dir]",
      account: SCHOOL_EMAIL,
    };
  }

  if (cmd === "status") {
    const session = await loadSession(root);
    const fresh = isSessionFresh(session);
    return {
      ok: true,
      signedIn: fresh,
      account: SCHOOL_EMAIL,
      email: session?.email || "",
      exp: session?.exp || 0,
    };
  }

  if (cmd === "login") {
    process.stderr.write(
      `Sign in as ${SCHOOL_EMAIL} in the Chrome window. It closes once Outlook mail loads.\n`
    );
    try {
      const token = await captureToken({ headed: true, root });
      return {
        ok: true,
        signedIn: true,
        account: SCHOOL_EMAIL,
        email: jwtEmail(token),
      };
    } catch (err) {
      return needsLoginPayload(err instanceof Error ? err.message : String(err));
    }
  }

  if (cmd === "dump") {
    try {
      const result = await dumpSchoolMail({
        since: parsed.since || DEFAULT_DUMP_SINCE,
        outDir: parsed.out,
        root,
        includeBody: true,
      });
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        since: result.since,
        messages: result.messages,
        files: result.files,
        outDir: result.outDir,
      };
    } catch (err) {
      return needsLoginPayload(err instanceof Error ? err.message : String(err));
    }
  }

  if (!["inbox", "search", "read"].includes(cmd)) {
    return { ok: false, error: `unknown command: ${cmd}` };
  }
  if (cmd === "search" && !parsed.query) {
    return { ok: false, error: "search needs a query" };
  }
  if (cmd === "read" && !parsed.id) {
    return { ok: false, error: "read needs a message id" };
  }

  let token;
  try {
    token = await resolveToken({
      root,
      headed: parsed.headed,
      force: parsed.force,
    });
  } catch (err) {
    return needsLoginPayload(err instanceof Error ? err.message : String(err));
  }

  const base = apiBaseForAudience(tokenAudience(token));
  try {
    if (cmd === "read") {
      const data = await apiGet(buildReadUrl(base, parsed.id), token);
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        message: normalizeMessage(data, { includeBody: true }),
      };
    }
    const url = buildListUrl(base, {
      search: cmd === "search" ? parsed.query : "",
      limit: parsed.limit,
    });
    const data = await apiGet(url, token);
    const rows = Array.isArray(data.value) ? data.value : [];
    return {
      ok: true,
      account: SCHOOL_EMAIL,
      query: cmd === "search" ? parsed.query : "",
      messages: rows.map((row) => normalizeMessage(row)),
    };
  } catch (err) {
    const status = Number(err?.status || 0);
    if (status === 401 || status === 403) {
      return needsLoginPayload(err instanceof Error ? err.message : String(err));
    }
    return {
      ok: false,
      error: redactSecrets(err instanceof Error ? err.message : String(err)),
      account: SCHOOL_EMAIL,
    };
  }
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runSchoolMail(process.argv.slice(2))
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
      if (!payload?.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
