/**
 * Dedicated Google Chrome for the Personal / JYPE agent. Playwright is the
 * remote control. Profile is ~/.yanylevin/agent-browser/, not Arc, not the
 * school-mail cookie jar, not Yan's daily Chrome. Chrome quits when close()
 * runs (end of turn, idle, or CLI close). Cookies stay on disk.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";
import { jypeEmailForSlug, isJypeMember, normalizeJypeWorkspace } from "./jype.js";

export const LOGIN_WAIT_MS = 10 * 60_000;
export const IDLE_MS = 2 * 60_000;
export const SNAPSHOT_MAX = 300;
const VIEWPORT = { width: 1280, height: 900 };

const SENSITIVE_HOST_RE =
  /(^|\.)(fidelity|vanguard|schwab|chase|wellsfargo|bankofamerica|capitalone|americanexpress|discover|paypal|venmo|coinbase|binance|kraken|appleid\.apple|iforgot\.apple|1password|lastpass|bitwarden)(\.|$)/i;

const LOGIN_HOST_RE =
  /login\.microsoftonline\.com|login\.microsoft\.com|accounts\.google\.com|okta\.com/i;

/** @type {import("playwright-core").BrowserContext|null} */
let context = null;
/** @type {import("playwright-core").Page|null} */
let page = null;
let headed = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let idleTimer = null;
let chain = Promise.resolve();

export function agentBrowserDir() {
  return (
    String(process.env.AGENT_BROWSER_DIR || "").trim() ||
    join(homedir(), ".yanylevin", "agent-browser")
  );
}

export function profileDir(root = agentBrowserDir()) {
  return join(root, "chrome-profile");
}

export function isSensitiveUrl(url) {
  let host = "";
  try {
    host = new URL(String(url || "")).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;
  return SENSITIVE_HOST_RE.test(host);
}

export function isLoginUrl(url) {
  const raw = String(url || "");
  try {
    const u = new URL(raw);
    if (LOGIN_HOST_RE.test(u.hostname)) return true;
    return /\/(login|signin|sign-in|sso)\b/i.test(u.pathname);
  } catch {
    return LOGIN_HOST_RE.test(raw);
  }
}

/**
 * Chrome tools are for Yan and JYPE, including JYPE @agent. Other guests no.
 * @param {object|null|undefined} session
 */
export function sessionMayUseBrowser(session) {
  if (!session || typeof session !== "object") return false;
  const guest = session.guestCaller;
  if (guest && typeof guest === "object") {
    if (jypeEmailForSlug(guest.slug)) return true;
    if (isJypeMember(guest.email)) return true;
    return false;
  }
  if (normalizeJypeWorkspace(session.workspace) === "jype") {
    return isJypeMember(session.email);
  }
  return isJypeMember(session.email);
}

/**
 * Only Yan's own turn (not a JYPE @agent on his session) may open banking.
 * @param {object|null|undefined} session
 */
export function browserActorIsYan(session) {
  if (!session || typeof session !== "object") return false;
  if (session.guestCaller) return false;
  return canonicalizeEmail(session.email) === YAN_EMAIL;
}

export function formatSnapshotLines(rows, meta = {}) {
  const url = String(meta.url || "").trim();
  const title = String(meta.title || "").trim();
  const header = [title, url].filter(Boolean).join("\n");
  const body = (Array.isArray(rows) ? rows : []).map((row) => {
    const ref = Number(row.ref);
    const role = String(row.role || "el").trim() || "el";
    const name = String(row.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    const href = String(row.href || "").trim();
    return [`[${ref}]`, role, name, href].filter(Boolean).join(" ");
  });
  return [header, ...body].filter(Boolean).join("\n");
}

export function parseArgs(argv) {
  const args = [...argv];
  const cmd = String(args.shift() || "").trim();
  const out = {
    cmd,
    url: "",
    ref: 0,
    text: "",
    key: "",
    headed: false,
    path: "",
  };
  while (args.length) {
    const tok = String(args.shift() || "");
    if (tok === "--headed") {
      out.headed = true;
      continue;
    }
    if (tok === "--url" || tok === "--goto") {
      out.url = String(args.shift() || "").trim();
      continue;
    }
    if (tok === "--ref") {
      out.ref = Number(args.shift() || 0);
      continue;
    }
    if (tok === "--text" || tok === "--value") {
      out.text = String(args.shift() || "");
      continue;
    }
    if (tok === "--key") {
      out.key = String(args.shift() || "").trim();
      continue;
    }
    if (tok === "--path" || tok === "--out") {
      out.path = String(args.shift() || "").trim();
      continue;
    }
    if (tok.startsWith("-")) {
      throw new Error(`unknown arg: ${tok}`);
    }
    if (/^https?:\/\//i.test(tok) && !out.url) {
      out.url = tok;
      continue;
    }
    if (!out.text && cmd === "type") {
      out.text = tok;
      continue;
    }
    if (!out.key && cmd === "press") {
      out.key = tok;
      continue;
    }
    if (!out.ref && /^\d+$/.test(tok)) {
      out.ref = Number(tok);
      continue;
    }
    if (!out.path && (cmd === "screenshot" || cmd === "shot")) {
      out.path = tok;
      continue;
    }
  }
  return out;
}

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    closeAgentBrowser().catch(() => {});
  }, IDLE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function launchChrome(opts = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright-core"));
  } catch {
    throw new Error("playwright-core is not installed (cd server && npm install)");
  }
  const useHeaded = Boolean(opts.headed);
  const dir = profileDir(opts.root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return chromium.launchPersistentContext(dir, {
    channel: "chrome",
    headless: !useHeaded,
    viewport: VIEWPORT,
    args: useHeaded ? [] : ["--window-position=-2400,-2400"],
  });
}

async function ensureBrowser(opts = {}) {
  const wantHeaded = Boolean(opts.headed);
  if (context && page && !page.isClosed() && headed === wantHeaded) {
    bumpIdle();
    return page;
  }
  if (context && headed !== wantHeaded) {
    await closeAgentBrowser();
  }
  context = await launchChrome(opts);
  headed = wantHeaded;
  page = context.pages()[0] || (await context.newPage());
  bumpIdle();
  return page;
}

async function collectSnapshot(active) {
  const url = active.url();
  const title = await active.title().catch(() => "");
  const rows = await active.evaluate((max) => {
    document.querySelectorAll("[data-agent-ref]").forEach((el) => {
      el.removeAttribute("data-agent-ref");
    });
    const sel =
      'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="menuitem"], [contenteditable="true"]';
    const seen = new Set();
    /** @type {{ ref: number, role: string, name: string, href: string }[]} */
    const out = [];
    const nodes = document.querySelectorAll(sel);
    for (const el of nodes) {
      if (out.length >= max) break;
      if (!(el instanceof HTMLElement)) continue;
      if (seen.has(el)) continue;
      const style = window.getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 && rect.height < 2) continue;
      seen.add(el);
      const ref = out.length + 1;
      el.setAttribute("data-agent-ref", String(ref));
      const role =
        el.getAttribute("role") ||
        el.tagName.toLowerCase();
      const name =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.getAttribute("value") ||
        (el.innerText || "").slice(0, 80) ||
        "";
      const href = el instanceof HTMLAnchorElement ? el.href : "";
      out.push({ ref, role, name, href });
    }
    return out;
  }, SNAPSHOT_MAX);
  return {
    ok: true,
    url,
    title,
    snapshot: formatSnapshotLines(rows, { url, title }),
    count: rows.length,
  };
}

function denySensitive(url, allowSensitive) {
  if (allowSensitive) return null;
  if (isSensitiveUrl(url)) {
    return {
      ok: false,
      error: "blocked sensitive url",
      hint: "Banking, brokerage, Apple ID, and password managers are Yan-only.",
    };
  }
  return null;
}

export async function navigate(url, opts = {}) {
  const target = String(url || "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "url must be http(s)" };
  }
  const blocked = denySensitive(target, opts.allowSensitive);
  if (blocked) return blocked;
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    await active.goto(target, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    bumpIdle();
    return collectSnapshot(active);
  });
}

export async function snapshot(opts = {}) {
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    bumpIdle();
    return collectSnapshot(active);
  });
}

async function loc(active, ref) {
  const n = Number(ref);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error("ref must be a positive integer from the last snapshot");
  }
  const handle = active.locator(`[data-agent-ref="${n}"]`).first();
  if ((await handle.count()) < 1) {
    throw new Error(`ref ${n} is gone; snapshot again`);
  }
  return handle;
}

export async function click(ref, opts = {}) {
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const handle = await loc(active, ref);
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    await handle.click({ timeout: 15_000 });
    bumpIdle();
    await active.waitForTimeout(400).catch(() => {});
    return collectSnapshot(active);
  });
}

export async function fill(ref, text, opts = {}) {
  const value = String(text ?? "");
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const handle = await loc(active, ref);
    await handle.fill(value, { timeout: 15_000 });
    bumpIdle();
    return { ok: true, filled: Number(ref) };
  });
}

export async function typeText(ref, text, opts = {}) {
  const value = String(text ?? "");
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const handle = await loc(active, ref);
    await handle.click({ timeout: 15_000 });
    await active.keyboard.type(value, { delay: 20 });
    bumpIdle();
    return { ok: true, typed: Number(ref) };
  });
}

export async function press(key, opts = {}) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, error: "key required" };
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    await active.keyboard.press(k);
    bumpIdle();
    await active.waitForTimeout(400).catch(() => {});
    return collectSnapshot(active);
  });
}

export async function pageText(opts = {}) {
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const text = await active.evaluate(() => document.body?.innerText || "");
    bumpIdle();
    return { ok: true, text: String(text).slice(0, 80_000) };
  });
}

export async function pageEval(fn, opts = {}) {
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const result = await active.evaluate(fn);
    bumpIdle();
    return { ok: true, result };
  });
}

export async function screenshot(opts = {}) {
  return withLock(async () => {
    const active = await ensureBrowser(opts);
    const dest =
      String(opts.path || "").trim() ||
      join(tmpdir(), `agent-browser-${Date.now()}.png`);
    await mkdir(dirname(dest), { recursive: true });
    const buf = await active.screenshot({ type: "png", path: dest });
    bumpIdle();
    return {
      ok: true,
      path: dest,
      pngBase64: Buffer.from(buf).toString("base64"),
    };
  });
}

export async function loginHeaded(url, opts = {}) {
  const target = String(url || "").trim();
  if (target) {
    const blocked = denySensitive(target, opts.allowSensitive);
    if (blocked) return blocked;
  }
  return withLock(async () => {
    await closeAgentBrowserUnlocked();
    const active = await ensureBrowser({ ...opts, headed: true });
    if (target) {
      await active.goto(target, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    }
    const waitMs = Number(opts.waitMs || LOGIN_WAIT_MS);
    const start = Date.now();
    while (Date.now() - start < waitMs) {
      bumpIdle();
      if (!isLoginUrl(active.url())) break;
      await active.waitForTimeout(2000).catch(() => {});
    }
    return collectSnapshot(active);
  });
}

async function closeAgentBrowserUnlocked() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const ctx = context;
  context = null;
  page = null;
  headed = false;
  if (ctx) await ctx.close().catch(() => {});
}

export async function closeAgentBrowser() {
  return withLock(() => closeAgentBrowserUnlocked());
}

export function browserStatus() {
  return {
    ok: true,
    open: Boolean(context && page && !page.isClosed()),
    headed,
    profile: profileDir(),
  };
}

function toolResult(payload) {
  if (payload && payload.pngBase64) {
    const { pngBase64, ...rest } = payload;
    return {
      content: [
        { type: "text", text: JSON.stringify(rest) },
        { type: "image", data: pngBase64, mimeType: "image/png" },
      ],
    };
  }
  return JSON.stringify(payload);
}

/**
 * @param {object} session
 */
export function browserCustomTools(session) {
  const allowSensitive = browserActorIsYan(session);
  const opts = { allowSensitive };
  return {
    browser_navigate: {
      description:
        "Open a URL in the Studio's dedicated Google Chrome. Use only when curl/fetch/search cannot do it (login, JS, clicking). Not for static articles. JYPE: no banking/Fidelity/Apple ID. Chrome quits when the turn ends; cookies stay on disk. Read .cursor/skills/personal-browser/SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL" },
        },
        required: ["url"],
      },
      execute: async ({ url }) => toolResult(await navigate(url, opts)),
    },
    browser_snapshot: {
      description:
        "Accessibility-style list of clickable fields on the current Chrome page, with [ref] numbers for click/fill.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => toolResult(await snapshot(opts)),
    },
    browser_click: {
      description: "Click [ref] from the last snapshot, then snapshot again.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number", description: "Snapshot ref" },
        },
        required: ["ref"],
      },
      execute: async ({ ref }) => toolResult(await click(ref, opts)),
    },
    browser_fill: {
      description:
        "Replace the value of an input [ref]. Do not echo passwords back to the user.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number" },
          text: { type: "string" },
        },
        required: ["ref", "text"],
      },
      execute: async ({ ref, text }) => toolResult(await fill(ref, text, opts)),
    },
    browser_type: {
      description: "Click [ref] and type into it (does not clear first).",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "number" },
          text: { type: "string" },
        },
        required: ["ref", "text"],
      },
      execute: async ({ ref, text }) =>
        toolResult(await typeText(ref, text, opts)),
    },
    browser_press: {
      description: "Press a key in Chrome (Enter, Tab, Escape, Meta+a, ...).",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string" },
        },
        required: ["key"],
      },
      execute: async ({ key }) => toolResult(await press(key, opts)),
    },
    browser_screenshot: {
      description:
        "Screenshot the current Chrome tab. Prefer snapshot text unless the user needs to see the page.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => toolResult(await screenshot(opts)),
    },
    browser_login: {
      description:
        "Open headed Chrome on the Studio for 2FA / a login the agent cannot finish headless. Waits until the URL leaves the IdP, up to 10 minutes. Pass the site URL.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
      },
      execute: async ({ url }) => toolResult(await loginHeaded(url, opts)),
    },
    browser_close: {
      description:
        "Quit this Chrome now. Cookies stay in ~/.yanylevin/agent-browser/. The turn also quits Chrome when it finishes.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        await closeAgentBrowser();
        return JSON.stringify({ ok: true, open: false });
      },
    },
  };
}

export async function runAgentBrowser(argv) {
  const parsed = parseArgs(argv);
  const cmd = parsed.cmd;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      commands: [
        "status",
        "goto <url>",
        "snapshot",
        "click <ref>",
        "fill <ref> --text ...",
        "type <ref> --text ...",
        "press <key>",
        "screenshot [path]",
        "login [--url ...]",
        "close",
      ],
    };
  }
  if (cmd === "status") return browserStatus();
  if (cmd === "close" || cmd === "quit") {
    await closeAgentBrowser();
    return { ok: true, open: false };
  }
  if (cmd === "goto" || cmd === "open" || cmd === "navigate") {
    return navigate(parsed.url, { headed: parsed.headed, allowSensitive: true });
  }
  if (cmd === "snapshot") {
    return snapshot({ headed: parsed.headed });
  }
  if (cmd === "click") return click(parsed.ref, { headed: parsed.headed });
  if (cmd === "fill") {
    return fill(parsed.ref, parsed.text, { headed: parsed.headed });
  }
  if (cmd === "type") {
    return typeText(parsed.ref, parsed.text, { headed: parsed.headed });
  }
  if (cmd === "press") return press(parsed.key, { headed: parsed.headed });
  if (cmd === "screenshot" || cmd === "shot") {
    return screenshot({ headed: parsed.headed, path: parsed.path });
  }
  if (cmd === "text") {
    return pageText({ headed: parsed.headed });
  }
  if (cmd === "login") {
    return loginHeaded(parsed.url, {
      headed: true,
      allowSensitive: true,
    });
  }
  return { ok: false, error: `unknown command: ${cmd}` };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runAgentBrowser(process.argv.slice(2))
    .then(async (payload) => {
      const body = { ...payload };
      if (body.pngBase64) delete body.pngBase64;
      console.log(JSON.stringify(body, null, 2));
      if (payload?.pngBase64 && body.path) {
        await writeFile(body.path, Buffer.from(payload.pngBase64, "base64"));
      }
      await closeAgentBrowser().catch(() => {});
      process.exit(payload?.ok ? 0 : 1);
    })
    .catch(async (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      await closeAgentBrowser().catch(() => {});
      process.exit(1);
    });
}
