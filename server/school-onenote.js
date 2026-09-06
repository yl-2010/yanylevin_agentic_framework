/**
 * School Microsoft 365 OneNote (owner@school.example). No Graph app
 * registration. Reuses the school-mail Chrome profile cookies, captures a
 * Graph token with Notes scopes, then reads notebooks / sections / pages.
 *
 * On demand only. No history fill. Not a nightly default source.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRAPH_BASE,
  SCHOOL_EMAIL,
  isSessionFresh,
  jwtEmail,
  jwtExp,
  jwtClaims,
  redactSecrets,
  schoolMailDir,
  stripHtml,
  tokenAudience,
} from "./school-mail.js";

export { SCHOOL_EMAIL, GRAPH_BASE };

const LOGIN_WAIT_MS = 10 * 60_000;
const REFRESH_WAIT_MS = 45_000;
const PAGE_TEXT_MAX = 8000;
export const OUTLOOK_WEB_CLIENT_ID = "9199bf20-a13f-4107-85dc-02114787ef48";
export const EPS_TENANT_ID = "b2681e8b-dd20-46cf-b163-371a2d7c6014";
export const GRAPH_EXPLORER_URL =
  "https://developer.microsoft.com/en-us/graph/graph-explorer?request=me%2Fonenote%2Fnotebooks&method=GET&version=v1.0";
export const OWA_URL = "https://outlook.office.com/mail/";

export function schoolOnenoteDir() {
  return (
    String(process.env.SCHOOL_ONENOTE_DIR || "").trim() ||
    join(homedir(), ".yanylevin", "school-onenote")
  );
}

export function chromeProfileDir() {
  return (
    String(process.env.SCHOOL_ONENOTE_PROFILE || "").trim() ||
    join(schoolMailDir(), "chrome-profile")
  );
}

export function sessionPath(root = schoolOnenoteDir()) {
  return join(root, "session.json");
}

export function parseArgs(argv) {
  const args = [...argv];
  const cmd = String(args.shift() || "").trim();
  const out = {
    cmd,
    force: false,
    headed: false,
    html: false,
    limit: 20,
    query: "",
    id: "",
    notebook: "",
    section: "",
  };
  while (args.length) {
    const a = args.shift();
    if (a === "--force") out.force = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--html") out.html = true;
    else if (a === "--notebook") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.notebook = rest.join(" ").trim();
    } else if (a === "--section") {
      const rest = [];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.section = rest.join(" ").trim();
    }
    else if (a === "--limit") {
      const n = Number(args.shift());
      out.limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.trunc(n))) : 20;
    } else if (cmd === "search" && !out.query) {
      const rest = [a];
      while (args.length && !String(args[0]).startsWith("--")) rest.push(args.shift());
      out.query = rest.join(" ").trim();
    } else if ((cmd === "page" || cmd === "pages") && !out.id && !String(a).startsWith("--")) {
      out.id = String(a || "").trim();
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  return out;
}

export function notesScopes(token) {
  const scp = String(jwtClaims(token).scp || "");
  return scp.split(/\s+/).filter((s) => /^Notes(\.|-Internal)/i.test(s));
}

export function isNotesToken(token) {
  const aud = tokenAudience(token).toLowerCase();
  if (!aud) return false;
  const graphAud =
    aud.includes("graph.microsoft.com") ||
    aud.includes("00000003-0000-0000-c000-000000000000");
  if (!graphAud) return false;
  return /Notes\.(Read|ReadWrite|Create)/i.test(String(jwtClaims(token).scp || ""));
}

export function tokenFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const hash = new URLSearchParams(u.hash.replace(/^#/, ""));
    const q = u.searchParams;
    const token = String(hash.get("access_token") || q.get("access_token") || "").trim();
    return token && isNotesToken(token) ? token : "";
  } catch {
    return "";
  }
}

export function graphNotesAuthorizeUrl() {
  const params = new URLSearchParams({
    client_id: OUTLOOK_WEB_CLIENT_ID,
    response_type: "token",
    redirect_uri: OWA_URL,
    scope: [
      "https://graph.microsoft.com/Notes.Read",
      "https://graph.microsoft.com/Notes.Read.All",
      "https://graph.microsoft.com/Notes.ReadWrite",
      "openid",
      "profile",
    ].join(" "),
    nonce: "onenote",
    login_hint: SCHOOL_EMAIL,
  });
  return `https://login.microsoftonline.com/${EPS_TENANT_ID}/oauth2/v2.0/authorize?${params}`;
}

export function buildNotebooksUrl() {
  return `${GRAPH_BASE}/me/onenote/notebooks?$select=id,displayName,userRole,isShared,lastModifiedDateTime,links&$top=100`;
}

export function buildRecentNotebooksUrl() {
  return `${GRAPH_BASE}/me/onenote/notebooks/getRecentNotebooks(includePersonalNotebooks=true)`;
}

export function buildNotebookExpandUrl(id) {
  const safe = encodeURIComponent(String(id || "").trim());
  return `${GRAPH_BASE}/me/onenote/notebooks/${safe}?$expand=sections,sectionGroups($expand=sections)`;
}

export function buildPagesUrl(sectionId, { limit = 20 } = {}) {
  const safe = encodeURIComponent(String(sectionId || "").trim());
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  return `${GRAPH_BASE}/me/onenote/sections/${safe}/pages?$select=id,title,createdDateTime,lastModifiedDateTime,level,order,links&$top=${top}`;
}

export function buildPageContentUrl(pageId) {
  const safe = encodeURIComponent(String(pageId || "").trim());
  return `${GRAPH_BASE}/me/onenote/pages/${safe}/content`;
}

export function buildSearchUrl(query, { limit = 20 } = {}) {
  const q = `"${String(query || "").replace(/"/g, "")}"`;
  const top = Math.min(50, Math.max(1, Number(limit) || 20));
  return `${GRAPH_BASE}/me/onenote/pages?$search=${encodeURIComponent(q)}&$select=id,title,createdDateTime,lastModifiedDateTime,parentSection,links&$top=${top}`;
}

export function normalizeNotebook(raw) {
  const links = raw?.links || {};
  return {
    id: String(raw?.id || raw?.id || "").trim(),
    name: String(raw?.displayName || raw?.name || "").trim(),
    role: String(raw?.userRole || "").trim(),
    shared: Boolean(raw?.isShared),
    modified: String(raw?.lastModifiedDateTime || "").trim(),
    webUrl: String(links.oneNoteWebUrl?.href || raw?.sourceUrl || raw?.links?.oneNoteWebUrl || "").trim(),
  };
}

export function normalizeSection(raw, group = "") {
  return {
    id: String(raw?.id || "").trim(),
    name: String(raw?.displayName || "").trim(),
    group: String(group || "").trim(),
  };
}

export function flattenNotebookSections(notebook) {
  const out = [];
  for (const s of notebook?.sections || []) out.push(normalizeSection(s, ""));
  for (const g of notebook?.sectionGroups || []) {
    const gname = String(g.displayName || "");
    for (const s of g.sections || []) out.push(normalizeSection(s, gname));
  }
  return out;
}

export function normalizePage(raw) {
  const parent = raw?.parentSection || {};
  return {
    id: String(raw?.id || "").trim(),
    title: String(raw?.title || "(untitled)").trim(),
    modified: String(raw?.lastModifiedDateTime || raw?.createdDateTime || "").trim(),
    section: String(parent.displayName || "").trim(),
    webUrl: String(raw?.links?.oneNoteWebUrl?.href || "").trim(),
  };
}

export function pickByName(rows, needle, nameKey = "name") {
  const n = String(needle || "").trim().toLowerCase();
  if (!n) return { match: null, ambiguous: [] };
  const list = Array.isArray(rows) ? rows : [];
  const exact = list.filter((r) => String(r[nameKey] || "").trim().toLowerCase() === n);
  if (exact.length === 1) return { match: exact[0], ambiguous: [] };
  const hits = list.filter((r) => String(r[nameKey] || "").trim().toLowerCase().includes(n));
  if (hits.length === 1) return { match: hits[0], ambiguous: [] };
  return { match: null, ambiguous: hits };
}

function needsLoginPayload(detail) {
  return {
    ok: false,
    error: "not signed in",
    hint: "On the Mac Studio, run: node server/school-onenote.js login",
    detail: detail || "",
    account: SCHOOL_EMAIL,
  };
}

async function loadSession(root = schoolOnenoteDir()) {
  try {
    const raw = await readFile(sessionPath(root), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(session, root = schoolOnenoteDir()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dest = sessionPath(root);
  const tmp = `${dest}.${process.pid}.tmp`;
  await writeFile(
    tmp,
    JSON.stringify(
      {
        token: session.token,
        exp: jwtExp(session.token),
        aud: tokenAudience(session.token),
        email: jwtEmail(session.token),
        capturedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    { mode: 0o600 }
  );
  await rename(tmp, dest);
}

async function launchChrome(opts) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed (cd server && npm install)");
  }
  const headed = Boolean(opts.headed);
  const dir = opts.profile || chromeProfileDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: headed ? [] : ["--window-position=-2400,-2400"],
  });
}

function waitForNotesToken(context, timeoutMs, page) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for OneNote Graph sign-in"));
    }, timeoutMs);
    function consider(token) {
      if (done || !token || !isNotesToken(token)) return;
      done = true;
      cleanup();
      resolve(token);
    }
    function onReq(req) {
      const headers = req.headers();
      const h = headers.authorization || headers.Authorization || "";
      if (!/^Bearer\s+/i.test(h)) return;
      consider(h.replace(/^Bearer\s+/i, "").trim());
    }
    function onNav(frame) {
      consider(tokenFromUrl(frame.url()));
    }
    function cleanup() {
      clearTimeout(timer);
      context.off("request", onReq);
      page?.off("framenavigated", onNav);
    }
    context.on("request", onReq);
    page?.on("framenavigated", onNav);
    consider(tokenFromUrl(page?.url?.() || ""));
  });
}

async function clickIfVisible(page, name, timeoutMs = 4000) {
  try {
    const btn = page.getByRole("button", { name, exact: false });
    await btn.first().waitFor({ state: "visible", timeout: timeoutMs });
    await btn.first().click({ timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function captureToken(opts) {
  const headed = Boolean(opts.headed);
  const waitMs = headed ? LOGIN_WAIT_MS : REFRESH_WAIT_MS;
  const context = await launchChrome(opts);
  try {
    const page = context.pages()[0] || (await context.newPage());
    const pending = waitForNotesToken(context, waitMs, page);
    try {
      await page.goto(GRAPH_EXPLORER_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch {
      // token listener still runs
    }
    await sleep(2500);
    await clickIfVisible(page, "Sign in");
    await sleep(2000);
    await clickIfVisible(page, "Run query");
    await clickIfVisible(page, "Accept");
    await clickIfVisible(page, "Consent");
    const hashed = tokenFromUrl(page.url());
    if (hashed) {
      await saveSession({ token: hashed }, opts.root);
      return hashed;
    }
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

async function apiGet(url, token, { html = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: html ? "text/html" : "application/json",
      },
    });
    const text = await res.text();
    if (res.status === 429 || res.status === 503) {
      lastErr = new Error(`OneNote API ${res.status}`);
      lastErr.status = res.status;
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const snippet = redactSecrets(text).replace(/\s+/g, " ").slice(0, 220);
      const err = new Error(`OneNote API ${res.status}: ${snippet}`);
      err.status = res.status;
      throw err;
    }
    if (html) return { html: text };
    if (!text.trim()) return {};
    return JSON.parse(text);
  }
  throw lastErr || new Error("OneNote API retry exhausted");
}

async function resolveToken(opts) {
  const root = opts.root || schoolOnenoteDir();
  const session = await loadSession(root);
  if (isSessionFresh(session) && !opts.force && isNotesToken(session.token)) {
    return session.token;
  }
  if (!session) {
    throw new Error("no saved school OneNote session");
  }
  try {
    return await captureToken({
      headed: Boolean(opts.headed),
      root,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (session.token && isNotesToken(session.token) && !opts.force) return session.token;
    throw new Error(msg);
  }
}

function mergeNotebooks(owned, recent) {
  const map = new Map();
  for (const raw of [...(owned || []), ...(recent || [])]) {
    const row = normalizeNotebook(raw);
    if (!row.id && !row.name) continue;
    const key = row.id || row.webUrl || row.name;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function listNotebooks(token) {
  const owned = await apiGet(buildNotebooksUrl(), token).catch(() => ({ value: [] }));
  const recent = await apiGet(buildRecentNotebooksUrl(), token).catch(() => ({ value: [] }));
  return mergeNotebooks(owned.value, recent.value);
}

async function withToken(parsed, root, fn) {
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
  try {
    return await fn(token);
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

export async function runSchoolOnenote(argv, opts = {}) {
  const parsed = parseArgs(argv);
  const root = opts.root || schoolOnenoteDir();
  const cmd = parsed.cmd;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      usage:
        "node server/school-onenote.js login|status|notebooks|sections --notebook <name>|pages --section <name>|page <id>|search <q>",
      account: SCHOOL_EMAIL,
    };
  }

  if (cmd === "status") {
    const session = await loadSession(root);
    const fresh = isSessionFresh(session) && isNotesToken(session?.token || "");
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
      `Chrome opens Graph Explorer as ${SCHOOL_EMAIL}. Sign in if asked. If you see GET /me/onenote/notebooks, click Run query (and Accept if a permissions prompt appears). The window closes once a OneNote token is captured.\n`
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

  if (cmd === "notebooks") {
    return withToken(parsed, root, async (token) => ({
      ok: true,
      account: SCHOOL_EMAIL,
      notebooks: await listNotebooks(token),
    }));
  }

  if (cmd === "sections") {
    if (!parsed.notebook) return { ok: false, error: "sections needs --notebook" };
    return withToken(parsed, root, async (token) => {
      const notebooks = await listNotebooks(token);
      const picked = pickByName(notebooks, parsed.notebook);
      if (!picked.match) {
        return {
          ok: false,
          error: picked.ambiguous.length
            ? "ambiguous notebook name"
            : "notebook not found",
          notebooks: (picked.ambiguous.length ? picked.ambiguous : notebooks).map(
            (n) => n.name
          ),
          account: SCHOOL_EMAIL,
        };
      }
      const full = await apiGet(buildNotebookExpandUrl(picked.match.id), token);
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        notebook: picked.match.name,
        sections: flattenNotebookSections(full),
      };
    });
  }

  if (cmd === "pages") {
    if (!parsed.section && !parsed.id) {
      return { ok: false, error: "pages needs --section" };
    }
    return withToken(parsed, root, async (token) => {
      let sectionId = parsed.id;
      let sectionName = parsed.section;
      if (!sectionId) {
        if (!parsed.notebook) {
          return { ok: false, error: "pages needs --notebook with --section" };
        }
        const notebooks = await listNotebooks(token);
        const nb = pickByName(notebooks, parsed.notebook);
        if (!nb.match) {
          return { ok: false, error: "notebook not found", account: SCHOOL_EMAIL };
        }
        const full = await apiGet(buildNotebookExpandUrl(nb.match.id), token);
        const sections = flattenNotebookSections(full);
        const sec = pickByName(sections, parsed.section);
        if (!sec.match) {
          return {
            ok: false,
            error: sec.ambiguous.length ? "ambiguous section name" : "section not found",
            sections: (sec.ambiguous.length ? sec.ambiguous : sections).map((s) =>
              s.group ? `${s.group}/${s.name}` : s.name
            ),
            account: SCHOOL_EMAIL,
          };
        }
        sectionId = sec.match.id;
        sectionName = sec.match.name;
      }
      const data = await apiGet(buildPagesUrl(sectionId, { limit: parsed.limit }), token);
      const rows = Array.isArray(data.value) ? data.value : [];
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        section: sectionName,
        pages: rows.map((row) => normalizePage(row)),
      };
    });
  }

  if (cmd === "page") {
    if (!parsed.id) return { ok: false, error: "page needs an id" };
    return withToken(parsed, root, async (token) => {
      const data = await apiGet(buildPageContentUrl(parsed.id), token, { html: true });
      const html = String(data.html || "");
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        id: parsed.id,
        text: stripHtml(html, PAGE_TEXT_MAX),
        ...(parsed.html ? { html: html.slice(0, PAGE_TEXT_MAX) } : {}),
      };
    });
  }

  if (cmd === "search") {
    if (!parsed.query) return { ok: false, error: "search needs a query" };
    return withToken(parsed, root, async (token) => {
      const data = await apiGet(buildSearchUrl(parsed.query, { limit: parsed.limit }), token);
      const rows = Array.isArray(data.value) ? data.value : [];
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        query: parsed.query,
        pages: rows.map((row) => normalizePage(row)),
      };
    });
  }

  return { ok: false, error: `unknown command: ${cmd}` };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runSchoolOnenote(process.argv.slice(2))
    .then((payload) => {
      console.log(JSON.stringify(payload, null, 2));
      if (!payload?.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    });
}
