/**
 * School Microsoft 365 OneNote (owner@school.example). No Graph app
 * registration. Reuses the school-mail Chrome profile cookies, captures a
 * Graph token with Notes scopes, then reads notebooks / sections / pages.
 *
 * On demand only. No history fill. Not a nightly default source.
 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listClassEntriesForRoot } from "./education-data.js";
import {
  CLASS_NOTEBOOKS,
  CONTENT_LIBRARY_GROUP,
  PERSONAL_GROUP,
  mergeOneNoteSites,
  pickOneNoteLinks,
} from "./onenote-todo-links.js";
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
const REFRESH_WAIT_MS = 75_000;
const PAGE_TEXT_MAX = 8000;
const LOGIN_CLICK_MS = 700;
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
    dryRun: false,
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
    else if (a === "--dry-run") out.dryRun = true;
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

export function isMicrosoftLoginUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    return (
      host === "login.microsoftonline.com" ||
      host === "login.microsoft.com" ||
      host === "login.live.com" ||
      host === "login.windows.net" ||
      host.endsWith(".microsoftonline.com") ||
      host.endsWith(".login.microsoftonline.com")
    );
  } catch {
    return false;
  }
}

export function isGraphExplorerUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const host = u.hostname.toLowerCase();
    return (
      host === "developer.microsoft.com" &&
      u.pathname.toLowerCase().includes("/graph/graph-explorer")
    );
  } catch {
    return false;
  }
}

export function looksLikeSchoolAccountLabel(text, email = SCHOOL_EMAIL) {
  const t = String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!t || !e) return false;
  return t.includes(e);
}

export function schoolAccountSelectors(email = SCHOOL_EMAIL) {
  const e = String(email || "").trim();
  return [
    `[data-test-id="${e}"]`,
    `[data-tid="${e}"]`,
    `[aria-label="${e}"]`,
    `[aria-label*="${e}" i]`,
  ];
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

function pageLimit(limit) {
  return Math.min(50, Math.max(1, Number(limit) || 20));
}

export function buildPagesUrl(sectionId, { limit = 20 } = {}) {
  const safe = encodeURIComponent(String(sectionId || "").trim());
  return `${GRAPH_BASE}/me/onenote/sections/${safe}/pages?$select=id,title,createdDateTime,lastModifiedDateTime,level,order,links&$top=${pageLimit(limit)}`;
}

export function buildPageContentUrl(pageId) {
  const safe = encodeURIComponent(String(pageId || "").trim());
  return `${GRAPH_BASE}/me/onenote/pages/${safe}/content`;
}

export function buildSearchUrl(query, { limit = 20 } = {}) {
  const q = `"${String(query || "").replace(/"/g, "")}"`;
  // $select is rejected with $search on OneNote (Graph 20108).
  return `${GRAPH_BASE}/me/onenote/pages?$search=${encodeURIComponent(q)}&$top=${pageLimit(limit)}`;
}

export function sharePointSitePathFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    if (!/\.sharepoint\.com$/i.test(u.hostname)) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    const kind = parts[0].toLowerCase();
    if (kind !== "sites" && kind !== "teams") return null;
    return {
      hostname: u.hostname,
      path: `/${parts[0]}/${decodeURIComponent(parts[1])}`,
    };
  } catch {
    return null;
  }
}

export function buildSiteByPathUrl(hostname, path) {
  return `${GRAPH_BASE}/sites/${String(hostname || "").trim()}:${String(path || "").trim()}`;
}

export function buildSiteNotebooksExpandUrl(siteId) {
  const safe = encodeURIComponent(String(siteId || "").trim());
  return `${GRAPH_BASE}/sites/${safe}/onenote/notebooks?$select=id,displayName,userRole,isShared,lastModifiedDateTime,links&$expand=sections,sectionGroups($expand=sections)`;
}

export function buildSitePagesUrl(siteId, sectionId, { limit = 20 } = {}) {
  const site = encodeURIComponent(String(siteId || "").trim());
  const sec = encodeURIComponent(String(sectionId || "").trim());
  return `${GRAPH_BASE}/sites/${site}/onenote/sections/${sec}/pages?$select=id,title,createdDateTime,lastModifiedDateTime,level,order,links&$top=${pageLimit(limit)}`;
}

export function buildSitePageContentUrl(siteId, pageId) {
  const site = encodeURIComponent(String(siteId || "").trim());
  const page = encodeURIComponent(String(pageId || "").trim());
  return `${GRAPH_BASE}/sites/${site}/onenote/pages/${page}/content`;
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

/**
 * Desktop / OneNote app URL. Graph's oneNoteClientUrl, or `onenote:` plus the https page.
 * @param {string} webUrl
 * @param {object|undefined} links
 */
export function oneNoteClientUrl(webUrl, links) {
  const fromGraph = String(links?.oneNoteClientUrl?.href || "").trim();
  if (/^onenote:/i.test(fromGraph)) return fromGraph;
  const web = String(webUrl || "").trim();
  if (/^https:\/\//i.test(web)) return `onenote:${web}`;
  return "";
}

export function normalizePage(raw) {
  const parent = raw?.parentSection || {};
  const links = raw?.links || {};
  const webUrl = String(links.oneNoteWebUrl?.href || "").trim();
  const page = {
    id: String(raw?.id || "").trim(),
    title: String(raw?.title || "(untitled)").trim(),
    modified: String(raw?.lastModifiedDateTime || raw?.createdDateTime || "").trim(),
    section: String(parent.displayName || "").trim(),
    webUrl,
    clientUrl: oneNoteClientUrl(webUrl, links),
  };
  const level = Number(raw?.level);
  if (Number.isInteger(level) && level >= 0) page.level = level;
  return page;
}

export function sectionPath(section) {
  const name = String(section?.name || "").trim();
  const group = String(section?.group || "").trim();
  return group ? `${group}/${name}` : name;
}

export function pickSection(sections, needle) {
  const n = String(needle || "").trim().toLowerCase();
  const list = (Array.isArray(sections) ? sections : []).map((s) => ({
    ...s,
    path: sectionPath(s),
  }));
  const exactPath = list.filter((s) => s.path.toLowerCase() === n);
  if (exactPath.length === 1) return { match: exactPath[0], ambiguous: [] };
  return pickByName(list, needle, "name");
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
    // Real Chrome, even when hidden. True headless never gets past Microsoft's
    // account picker, so Graph Explorer sat there until Yan clicked the school
    // account by hand.
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: headed ? [] : ["--window-position=-2400,-2400"],
  });
}

function waitForNotesToken(context, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const pages = new Set();
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
    function attachPage(page) {
      if (!page || pages.has(page)) return;
      pages.add(page);
      page.on("framenavigated", onNav);
      consider(tokenFromUrl(page.url()));
    }
    function cleanup() {
      clearTimeout(timer);
      context.off("request", onReq);
      context.off("page", attachPage);
      for (const p of pages) {
        p.off("framenavigated", onNav);
      }
    }
    context.on("request", onReq);
    context.on("page", attachPage);
    for (const p of context.pages()) attachPage(p);
  });
}

async function clickLocator(loc, timeoutMs = LOGIN_CLICK_MS) {
  try {
    const el = loc.first();
    await el.waitFor({ state: "visible", timeout: timeoutMs });
    await el.click({ timeout: 2500 });
    return true;
  } catch {
    return false;
  }
}

async function clickNamedControl(root, name, timeoutMs = LOGIN_CLICK_MS) {
  const locators = [
    root.getByRole("button", { name, exact: true }),
    root.getByRole("link", { name, exact: true }),
    root.getByRole("button", { name, exact: false }),
    root.getByRole("link", { name, exact: false }),
  ];
  for (const loc of locators) {
    if (await clickLocator(loc, timeoutMs)) return true;
  }
  return false;
}

async function clickSchoolAccountOn(root, email = SCHOOL_EMAIL) {
  const e = String(email || "").trim();
  if (!e) return false;
  const locators = [
    ...schoolAccountSelectors(e).map((sel) => root.locator(sel)),
    root.getByRole("button", { name: e }),
    root.getByRole("link", { name: e }),
    root.getByRole("menuitem", { name: e }),
    root.getByRole("option", { name: e }),
    root.locator("[role='button']").filter({ hasText: e }),
    root.locator(".tile, .table").filter({ hasText: e }),
    root.getByText(e, { exact: false }),
  ];
  for (const loc of locators) {
    if (await clickLocator(loc, LOGIN_CLICK_MS)) return true;
  }
  return false;
}

function loginRoots(page) {
  try {
    return [page, ...page.frames()];
  } catch {
    return [page];
  }
}

function contextHasMicrosoftLogin(context) {
  try {
    return context.pages().some((p) => !p.isClosed() && isMicrosoftLoginUrl(p.url()));
  } catch {
    return false;
  }
}

async function advanceLoginPage(page, context, signInPages) {
  if (!page || page.isClosed()) return;
  const url = page.url();
  const roots = loginRoots(page);
  for (const root of roots) {
    try {
      if (isMicrosoftLoginUrl(root.url()) && (await clickSchoolAccountOn(root))) return;
    } catch {
      // frame navigated
    }
  }
  if (isMicrosoftLoginUrl(url)) {
    for (const root of roots) {
      if (await clickNamedControl(root, /^Yes$/i)) return;
      if (await clickNamedControl(root, /^Accept$/i)) return;
      if (await clickNamedControl(root, /^Consent$/i)) return;
    }
    return;
  }
  if (isGraphExplorerUrl(url)) {
    if (!contextHasMicrosoftLogin(context) && !signInPages.has(page)) {
      for (const root of roots) {
        if (await clickNamedControl(root, /^Sign in$/i)) {
          signInPages.add(page);
          return;
        }
      }
    }
    for (const root of roots) {
      if (await clickNamedControl(root, /Run query/i)) return;
      if (await clickNamedControl(root, /^Accept$/i)) return;
      if (await clickNamedControl(root, /^Consent$/i)) return;
    }
    return;
  }
  for (const root of roots) {
    if (await clickNamedControl(root, /^Accept$/i)) return;
    if (await clickNamedControl(root, /^Consent$/i)) return;
  }
}

async function driveLogin(context, signal) {
  const signInPages = new WeakSet();
  while (!signal.aborted) {
    for (const page of context.pages()) {
      if (signal.aborted) return;
      try {
        await advanceLoginPage(page, context, signInPages);
      } catch {
        // navigation mid-click
      }
    }
    await sleep(900);
  }
}

async function captureToken(opts) {
  const headed = Boolean(opts.headed);
  const waitMs = headed ? LOGIN_WAIT_MS : REFRESH_WAIT_MS;
  const context = await launchChrome(opts);
  const ac = new AbortController();
  try {
    const page = context.pages()[0] || (await context.newPage());
    const pending = waitForNotesToken(context, waitMs);
    // Navigation can outlast this timer. A handler has to be attached now,
    // or the timeout rejects with nobody listening and Node exits.
    pending.catch(() => {});
    void driveLogin(context, ac.signal);
    try {
      await page.goto(GRAPH_EXPLORER_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch {
      // token listener still runs
    }
    const hashed = tokenFromUrl(page.url());
    if (hashed) {
      await saveSession({ token: hashed }, opts.root);
      return hashed;
    }
    const token = await pending;
    await saveSession({ token }, opts.root);
    return token;
  } finally {
    ac.abort();
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
    if (res.status === 429 || res.status === 502 || res.status === 503) {
      lastErr = new Error(`OneNote API ${res.status}`);
      lastErr.status = res.status;
      console.error(`[onenote] ${res.status}, retry ${attempt + 1}`);
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

async function loadNotebookFromSite(token, picked) {
  const site = sharePointSitePathFromUrl(picked.webUrl);
  if (!site) return null;
  const siteMeta = await apiGet(buildSiteByPathUrl(site.hostname, site.path), token);
  const siteId = String(siteMeta?.id || "").trim();
  if (!siteId) return null;
  const list = await apiGet(buildSiteNotebooksExpandUrl(siteId), token);
  const rows = (list.value || []).map((raw) => ({
    ...normalizeNotebook(raw),
    raw,
  }));
  const hit = pickByName(rows, picked.name);
  const match = hit.match || (rows.length === 1 ? rows[0] : null);
  if (!match) return null;
  return {
    notebook: { ...picked, id: match.id, name: match.name },
    sections: flattenNotebookSections(match.raw),
    siteId,
  };
}

async function loadNotebookTree(token, picked) {
  if (picked.id) {
    try {
      const full = await apiGet(buildNotebookExpandUrl(picked.id), token);
      return {
        notebook: picked,
        sections: flattenNotebookSections(full),
        siteId: "",
      };
    } catch {
      // Class Notebooks 404 on /me/onenote/notebooks/{id}.
    }
  }
  const fromSite = await loadNotebookFromSite(token, picked);
  if (fromSite) return fromSite;
  const err = new Error("notebook not readable via /me or SharePoint site");
  err.status = 404;
  throw err;
}

async function listAllSectionPages(token, { siteId, sectionId }) {
  let url = siteId
    ? buildSitePagesUrl(siteId, sectionId, { limit: 50 })
    : buildPagesUrl(sectionId, { limit: 50 });
  /** @type {object[]} */
  const pages = [];
  for (let i = 0; i < 20 && url; i++) {
    const data = await apiGet(url, token);
    const rows = Array.isArray(data?.value) ? data.value : [];
    for (const raw of rows) pages.push(normalizePage(raw));
    url = String(data?.["@odata.nextLink"] || "").trim();
  }
  return pages;
}

async function readPageHtml(token, pageId) {
  try {
    return await apiGet(buildPageContentUrl(pageId), token, { html: true });
  } catch (err) {
    if (Number(err?.status) !== 404) throw err;
  }
  const notebooks = await listNotebooks(token);
  const seen = new Set();
  for (const nb of notebooks) {
    const site = sharePointSitePathFromUrl(nb.webUrl);
    if (!site) continue;
    const key = `${site.hostname}${site.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      const siteMeta = await apiGet(buildSiteByPathUrl(site.hostname, site.path), token);
      const siteId = String(siteMeta?.id || "").trim();
      if (!siteId) continue;
      return await apiGet(buildSitePageContentUrl(siteId, pageId), token, { html: true });
    } catch {
      continue;
    }
  }
  const err = new Error("page not found");
  err.status = 404;
  throw err;
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

const YAN_EDUCATION_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "education",
  "you@example.com"
);

/**
 * @param {string} classFolder
 */
async function listClassTodoFiles(classFolder) {
  /** @type {string[]} */
  const out = [];
  let entries = [];
  try {
    entries = await readdir(classFolder, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".education") continue;
    for (const name of [".todo.json", "todo.json"]) {
      const path = join(classFolder, entry.name, name);
      try {
        const st = await stat(path);
        if (st.isFile()) {
          out.push(path);
          break;
        }
      } catch {
        /* missing */
      }
    }
  }
  return out;
}

/**
 * Attach Content Library and personal OneNote sites onto existing class todos.
 * Safe to re-run. A signed-out session does not wipe links already stored.
 * @param {{ dryRun?: boolean, headed?: boolean, force?: boolean, root?: string }} [opts]
 */
export async function linkClassTodos(opts = {}) {
  return withToken(
    { headed: Boolean(opts.headed), force: Boolean(opts.force) },
    opts.root || schoolOnenoteDir(),
    (token) => linkClassTodosWithToken(token, opts)
  );
}

/**
 * @param {string} token
 * @param {{ dryRun?: boolean }} opts
 */
async function linkClassTodosWithToken(token, opts) {
  const classes = await listClassEntriesForRoot(YAN_EDUCATION_ROOT);
  const notebooks = await listNotebooks(token);
  /** @type {object[]} */
  const updates = [];
  /** @type {object[]} */
  const classReports = [];
  for (const [classId, notebookName] of Object.entries(CLASS_NOTEBOOKS)) {
    const entry = classes.find((row) => row.id === classId);
    if (!entry?.classFolder) {
      classReports.push({ id: classId, skipped: "no-class-folder" });
      continue;
    }
    let tree;
    try {
      const picked = pickByName(notebooks, notebookName);
      if (!picked.match) {
        classReports.push({ id: classId, skipped: "notebook-not-found", notebook: notebookName });
        continue;
      }
      tree = await loadNotebookTree(token, picked.match);
    } catch (err) {
      classReports.push({
        id: classId,
        skipped: "notebook-unreadable",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const wanted = (tree.sections || []).filter(
      (section) =>
        section.group === CONTENT_LIBRARY_GROUP || section.group === PERSONAL_GROUP
    );
    /** @type {object[]} */
    const pages = [];
    let sectionErrors = 0;
    for (const section of wanted) {
      try {
        const rows = await listAllSectionPages(token, {
          siteId: tree.siteId,
          sectionId: section.id,
        });
        for (const row of rows) {
          pages.push({ ...row, group: section.group, sectionName: section.name });
        }
      } catch (err) {
        sectionErrors += 1;
        console.error(
          `[onenote-links] ${classId} section ${section.group}/${section.name}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    console.error(
      `[onenote-links] ${classId} pages=${pages.length} sections=${wanted.length} errors=${sectionErrors}`
    );
    if (!pages.length) {
      classReports.push({
        id: classId,
        notebook: tree.notebook?.name || notebookName,
        skipped: sectionErrors ? "sections-failed" : "no-pages",
      });
      continue;
    }
    const todoPaths = await listClassTodoFiles(entry.classFolder);
    /** @type {{ path: string, props: object }[]} */
    const todos = [];
    for (const path of todoPaths) {
      try {
        const props = JSON.parse(await readFile(path, "utf8"));
        if (!props || typeof props !== "object" || !String(props.name || "").trim()) continue;
        todos.push({ path, props });
      } catch {
        /* leave a broken todo alone */
      }
    }
    const picks = pickOneNoteLinks(
      todos.map((row) => row.props),
      pages
    );
    let wrote = 0;
    for (let i = 0; i < todos.length; i++) {
      const row = todos[i];
      const pick = picks[i];
      const next = [pick?.personal, pick?.content].filter(Boolean).map((site) => {
        const stored = {
          name: site.name,
          url: site.url,
          oneNote: site.oneNote,
          pageId: site.pageId,
        };
        if (site.clientUrl) stored.clientUrl = site.clientUrl;
        return stored;
      });
      const sites = mergeOneNoteSites(row.props.sites, next);
      const before = JSON.stringify(row.props.sites || []);
      if (before === JSON.stringify(sites)) continue;
      const update = {
        classId,
        todo: row.props.name,
        personal: pick?.personal?.pageTitle || "",
        content: pick?.content?.pageTitle || "",
        client: Boolean(pick?.personal?.clientUrl || pick?.content?.clientUrl),
      };
      updates.push(update);
      if (opts.dryRun) continue;
      if (sites.length) row.props.sites = sites;
      else delete row.props.sites;
      await writeFile(row.path, `${JSON.stringify(row.props, null, 2)}\n`);
      wrote += 1;
    }
    classReports.push({
      id: classId,
      notebook: tree.notebook?.name || notebookName,
      pages: pages.length,
      todos: todos.length,
      wrote: opts.dryRun ? updates.filter((u) => u.classId === classId).length : wrote,
    });
  }
  return {
    ok: true,
    dryRun: Boolean(opts.dryRun),
    account: SCHOOL_EMAIL,
    classes: classReports,
    updates,
  };
}

export async function runSchoolOnenote(argv, opts = {}) {
  const parsed = parseArgs(argv);
  const root = opts.root || schoolOnenoteDir();
  const cmd = parsed.cmd;

  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      usage:
        "node server/school-onenote.js login|status|notebooks|sections --notebook <name>|pages --section <name>|page <id>|search <q>|link-todos",
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
      `Signing in to Graph Explorer as ${SCHOOL_EMAIL}. The script clicks the school account and Run query.\n`
    );
    try {
      const token = await captureToken({ headed: false, root });
      return {
        ok: true,
        signedIn: true,
        account: SCHOOL_EMAIL,
        email: jwtEmail(token),
      };
    } catch {
      process.stderr.write(
        `Hidden Chrome did not finish. Opening a window. Complete 2FA if Microsoft asks.\n`
      );
    }
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
      const tree = await loadNotebookTree(token, picked.match);
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        notebook: tree.notebook.name,
        siteId: tree.siteId || undefined,
        sections: tree.sections,
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
      let siteId = "";
      if (!sectionId) {
        if (!parsed.notebook) {
          return { ok: false, error: "pages needs --notebook with --section" };
        }
        const notebooks = await listNotebooks(token);
        const nb = pickByName(notebooks, parsed.notebook);
        if (!nb.match) {
          return { ok: false, error: "notebook not found", account: SCHOOL_EMAIL };
        }
        const tree = await loadNotebookTree(token, nb.match);
        const sec = pickSection(tree.sections, parsed.section);
        if (!sec.match) {
          return {
            ok: false,
            error: sec.ambiguous.length ? "ambiguous section name" : "section not found",
            sections: (sec.ambiguous.length ? sec.ambiguous : tree.sections).map(sectionPath),
            account: SCHOOL_EMAIL,
          };
        }
        sectionId = sec.match.id;
        sectionName = sec.match.name;
        siteId = tree.siteId;
      }
      const pages = await listAllSectionPages(token, { siteId, sectionId });
      return {
        ok: true,
        account: SCHOOL_EMAIL,
        section: sectionName,
        pages,
      };
    });
  }

  if (cmd === "page") {
    if (!parsed.id) return { ok: false, error: "page needs an id" };
    return withToken(parsed, root, async (token) => {
      const data = await readPageHtml(token, parsed.id);
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

  if (cmd === "link-todos") {
    return linkClassTodos({
      dryRun: parsed.dryRun,
      headed: parsed.headed,
      force: parsed.force,
      root,
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
