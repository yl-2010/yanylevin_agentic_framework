/**
 * Local password vault. Secrets stay in the login keychain. The index and
 * the access log in ~/.yanylevin/passwords have no secrets. Nothing here
 * prints a site password.
 */

import { createHash, createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatPacificTime } from "./chat-log.js";

const PASSWORD_SERVICE = "yanylevin.passwords";
const OTP_SERVICE = "yanylevin.passwords.otp";
const NOTES_SERVICE = "yanylevin.passwords.notes";
const MAC_SERVICE = "yanylevin.passwords.mac";
const MAC_ACCOUNT = "login";

const MAC_APPS = new Set([
  "passwords",
  "securityagent",
  "authenticationservicesagent",
  "coreauthui",
]);

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function passwordsDir() {
  return join(homedir(), ".yanylevin", "passwords");
}

function resolveVault(opts = {}) {
  const env = opts.env || process.env;
  const dir = resolve(opts.dir || env.PASSWORDS_DIR || passwordsDir());
  let backend = opts.backend || (env.PASSWORDS_BACKEND === "file" ? "file" : "keychain");
  if (backend !== "file" && backend !== "keychain") backend = "keychain";
  if (backend === "file" && dir === resolve(passwordsDir())) {
    throw new Error("file backend cannot use the real password directory");
  }
  return { dir, backend };
}

function chomp(text) {
  const s = String(text ?? "");
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

function redact(text, secret) {
  const raw = String(text ?? "");
  const hidden = String(secret ?? "");
  if (!hidden) return raw;
  return raw.split(hidden).join("[redacted]");
}

function run(cmd, args, stdin) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(cmd, args, {
      stdio: [stdin == null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code === 0) {
        resolveRun({ stdout, stderr });
        return;
      }
      const error = new Error((stderr || stdout || `${cmd} exited ${code}`).trim());
      error.code = code;
      reject(error);
    });
    if (stdin != null) child.stdin.end(stdin);
  });
}

function secretFile(dir, service, account) {
  const safe = (value) => String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(dir, "secrets", safe(service), safe(account));
}

async function setSecret(vault, service, account, secret, label) {
  const value = String(secret ?? "");
  if (vault.backend === "file") {
    const file = secretFile(vault.dir, service, account);
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, value, { mode: 0o600 });
    await chmod(file, 0o600);
    return;
  }
  await run("/usr/bin/security", [
    "add-generic-password",
    "-U",
    "-s",
    service,
    "-a",
    account,
    "-l",
    String(label || service).slice(0, 200),
    "-X",
    Buffer.from(value, "utf8").toString("hex"),
  ]);
}

async function getSecret(vault, service, account) {
  if (vault.backend === "file") {
    try {
      return await readFile(secretFile(vault.dir, service, account), "utf8");
    } catch (err) {
      if (err.code === "ENOENT") return "";
      throw err;
    }
  }
  try {
    const { stdout } = await run("/usr/bin/security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    return chomp(stdout);
  } catch (err) {
    if (err.code === 44 || /could not be found/i.test(err.message || "")) return "";
    throw err;
  }
}

async function deleteSecret(vault, service, account) {
  if (vault.backend === "file") {
    await unlink(secretFile(vault.dir, service, account)).catch((err) => {
      if (err.code !== "ENOENT") throw err;
    });
    return;
  }
  try {
    await run("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
  } catch (err) {
    if (err.code === 44 || /could not be found/i.test(err.message || "")) return;
    throw err;
  }
}

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await mkdir(join(dir, "inbox"), { recursive: true, mode: 0o700 });
}

function storedMeta(entry) {
  return {
    id: String(entry?.id || ""),
    title: String(entry?.title || ""),
    url: String(entry?.url || ""),
    username: String(entry?.username || ""),
    hasOtp: !!entry?.hasOtp,
    updatedAt: String(entry?.updatedAt || ""),
  };
}

function publicAccount(entry) {
  return {
    id: entry.id,
    title: entry.title,
    url: entry.url,
    username: entry.username,
    hasOtp: !!entry.hasOtp,
  };
}

async function readIndex(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "index.json"), "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.map(storedMeta).filter((entry) => entry.id);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeIndex(dir, entries) {
  await ensureDir(dir);
  const file = join(dir, "index.json");
  const tmp = join(dir, "index.json.tmp");
  await writeFile(tmp, JSON.stringify(entries.map(storedMeta), null, 2), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

export function hostOf(url) {
  const first = String(url || "").split(",")[0].trim();
  if (!first) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(first) ? first : `https://${first}`;
  try {
    return new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function accountKey(title, url, username) {
  const user = String(username || "").trim().toLowerCase();
  const host = hostOf(url);
  if (host) return `host\n${host}\nuser\n${user}`;
  return `title\n${String(title || "").trim().toLowerCase()}\nuser\n${user}`;
}

function accountId(title, url, username) {
  return createHash("sha256").update(accountKey(title, url, username)).digest("hex").slice(0, 16);
}

export function parseCsv(text) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        quoted = false;
        continue;
      }
      field += c;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    field += c;
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => String(cell).trim() !== ""));
}

function headerMap(header) {
  const map = {};
  header.forEach((name, index) => {
    map[String(name || "").trim().toLowerCase()] = index;
  });
  for (const key of ["title", "url", "username", "password"]) {
    if (map[key] == null) throw new Error(`CSV is missing a ${key} column`);
  }
  return map;
}

function cell(row, index) {
  if (index == null || index < 0) return "";
  return String(row[index] ?? "");
}

async function wipeFile(file) {
  const st = await stat(file);
  if (st.size > 0) await writeFile(file, Buffer.alloc(st.size));
  await unlink(file);
}

function requireReason(reason) {
  const text = String(reason || "").trim();
  if (!text) {
    const err = new Error("a reason is required");
    err.code = "REASON";
    throw err;
  }
  return text;
}

/**
 * One line for the dashboard Actions rail. No secret.
 * @param {{ title?: string, username?: string, reason?: string, kind?: string }} entry
 */
export function passwordActionSummary(entry) {
  const title = String(entry?.title || "").trim() || "account";
  const username = String(entry?.username || "").trim();
  const reason = String(entry?.reason || "").replace(/\s+/g, " ").trim();
  const who = username ? ` for ${username}` : "";
  const kind = String(entry?.kind || "fill");
  let verb = `Filled the ${title} password${who}`;
  if (kind === "otp") verb = `Used a ${title} one-time code${who}`;
  if (kind === "unlock-dialog") verb = "Typed the Mac login password";
  return reason ? `${verb}. ${reason}` : verb;
}

/**
 * @param {{ at?: string, id?: string, title?: string, kind?: string }} entry
 */
export function passwordActionId(entry) {
  const at = String(entry?.at || "");
  const id = String(entry?.id || entry?.title || "account");
  const kind = String(entry?.kind || "fill") || "fill";
  return `password:${id}:${kind}:${at}`;
}

/**
 * @param {ReturnType<typeof resolveVault>} vault
 * @param {{ actionsPath?: string, logAction?: boolean, agent?: string }} opts
 * @param {Record<string, string>} row
 */
async function logPasswordAction(vault, opts, row) {
  if (opts.logAction === false) return null;
  const actionsPath = String(opts.actionsPath || "");
  const realVault = resolve(vault.dir) === resolve(passwordsDir());
  if (!actionsPath && !realVault) return null;
  try {
    const { appendAgentAction } = await import("./agent-actions.js");
    const agent = String(opts.agent || "").trim() || "personal-agent";
    return await appendAgentAction(
      {
        at: row.at,
        agent,
        kind: "password",
        summary: passwordActionSummary(row),
        id: passwordActionId(row),
      },
      actionsPath ? { path: actionsPath } : {}
    );
  } catch (err) {
    console.error("[agent-actions]", err instanceof Error ? err.message : err);
    return null;
  }
}

async function appendAccess(vault, entry, opts = {}) {
  await ensureDir(vault.dir);
  const row = {
    at: new Date().toISOString(),
    id: entry.id,
    title: entry.title || "",
    url: entry.url || "",
    username: entry.username || "",
    reason: entry.reason,
    kind: entry.kind,
  };
  const file = join(vault.dir, "access.jsonl");
  await appendFile(file, JSON.stringify(row) + "\n", { mode: 0o600 });
  await chmod(file, 0o600);
  await logPasswordAction(vault, opts, row);
  return row;
}

async function mustEntry(vault, id) {
  const wanted = String(id || "").trim();
  if (!wanted) throw new Error("id is required");
  const index = await readIndex(vault.dir);
  const entry = index.find((row) => row.id === wanted);
  if (!entry) throw new Error("no such account");
  return entry;
}

export function base32Decode(input) {
  const clean = String(input || "").toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function totpCode(material, nowMs = Date.now()) {
  let secret = String(material || "").trim();
  let digits = 6;
  let period = 30;
  let algo = "sha1";
  if (secret.startsWith("otpauth://")) {
    const url = new URL(secret);
    secret = url.searchParams.get("secret") || "";
    digits = Number(url.searchParams.get("digits") || 6);
    period = Number(url.searchParams.get("period") || 30);
    const named = (url.searchParams.get("algorithm") || "SHA1").toLowerCase();
    algo = named === "sha256" || named === "sha512" ? named : "sha1";
  }
  if (!secret || !Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("one-time code secret is unusable");
  }
  if (!Number.isFinite(period) || period < 1) period = 30;
  const key = base32Decode(secret);
  if (!key.length) throw new Error("one-time code secret is unusable");
  const counter = Math.floor(nowMs / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac(algo, key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(bin % mod).padStart(digits, "0");
}

export async function importCsv(file, opts = {}) {
  const vault = resolveVault(opts);
  const text = await readFile(file, "utf8");
  const rows = parseCsv(text);
  if (!rows.length) throw new Error("CSV is empty");
  const map = headerMap(rows[0]);
  const index = await readIndex(vault.dir);
  const byId = new Map(index.map((entry) => [entry.id, entry]));
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  const now = new Date().toISOString();

  for (const row of rows.slice(1)) {
    const title = cell(row, map.title).trim();
    const url = cell(row, map.url).trim();
    const username = cell(row, map.username).trim();
    const password = cell(row, map.password);
    const notes = map.notes == null ? null : cell(row, map.notes);
    const otp = map.otpauth == null ? null : cell(row, map.otpauth).trim();
    if (!title && !url && !username && !password && !otp) continue;
    const id = accountId(title, url, username);
    const prev = byId.get(id);
    const label = username ? `${title} (${username})` : title || id;

    if (!prev) {
      if (!password && !otp) continue;
      if (password) await setSecret(vault, PASSWORD_SERVICE, id, password, label);
      if (otp) await setSecret(vault, OTP_SERVICE, id, otp, `${label} otp`);
      if (notes) await setSecret(vault, NOTES_SERVICE, id, notes, `${label} notes`);
      byId.set(id, { id, title, url, username, hasOtp: !!otp, updatedAt: now });
      added++;
      continue;
    }

    let changed = prev.title !== title || prev.url !== url || prev.username !== username;
    if (password) {
      const current = await getSecret(vault, PASSWORD_SERVICE, id);
      if (current !== password) {
        await setSecret(vault, PASSWORD_SERVICE, id, password, label);
        changed = true;
      }
    }
    if (otp != null) {
      const current = await getSecret(vault, OTP_SERVICE, id);
      if ((otp || "") !== (current || "")) {
        if (otp) await setSecret(vault, OTP_SERVICE, id, otp, `${label} otp`);
        else await deleteSecret(vault, OTP_SERVICE, id);
        changed = true;
      }
    }
    if (notes != null) {
      const current = await getSecret(vault, NOTES_SERVICE, id);
      if ((notes || "") !== (current || "")) {
        if (notes) await setSecret(vault, NOTES_SERVICE, id, notes, `${label} notes`);
        else await deleteSecret(vault, NOTES_SERVICE, id);
        changed = true;
      }
    }
    const hasOtp = otp == null ? prev.hasOtp : !!otp;
    byId.set(id, {
      id,
      title,
      url,
      username,
      hasOtp,
      updatedAt: changed ? now : prev.updatedAt,
    });
    if (changed) updated++;
    else unchanged++;
  }

  await writeIndex(vault.dir, [...byId.values()]);
  if (opts.deleteFile !== false) await wipeFile(file);
  return { added, updated, unchanged };
}

export async function listAccounts(opts = {}) {
  const vault = resolveVault(opts);
  const query = String(opts.query || "").trim().toLowerCase();
  const rows = (await readIndex(vault.dir))
    .filter((entry) => {
      if (!query) return true;
      return [entry.title, entry.url, entry.username].join("\n").toLowerCase().includes(query);
    })
    .map(publicAccount)
    .sort((a, b) => a.title.localeCompare(b.title) || a.username.localeCompare(b.username) || a.id.localeCompare(b.id));
  return rows;
}

async function ardiaFill(ref, secret) {
  const sel = String(ref || "").startsWith("@") ? String(ref) : `@${String(ref || "").replace(/^@/, "")}`;
  if (!/^@e\d+$/i.test(sel)) throw new Error("ardia ref must look like e11");
  const source = `await page.fill(${JSON.stringify(sel)}, ${JSON.stringify(String(secret))});\nreturn "filled";\n`;
  await run("ardia", ["browse", "script"], source);
}

async function chromeFill(ref, secret) {
  const n = Number(String(ref || "").replace(/^@/, "").replace(/^e/i, ""));
  if (!Number.isInteger(n) || n < 1) throw new Error("chrome ref must be the snapshot number");
  const { fill } = await import("./agent-browser.js");
  const result = await fill(n, secret);
  if (result && result.ok === false) throw new Error(result.error || "chrome fill failed");
}

async function defaultType({ browser, ref, secret }) {
  const which = String(browser || "").toLowerCase();
  if (which === "ardia") return ardiaFill(ref, secret);
  if (which === "chrome") return chromeFill(ref, secret);
  throw new Error("browser must be ardia or chrome");
}

export async function fillAccount(opts = {}) {
  const reason = requireReason(opts.reason);
  const browser = String(opts.browser || "").toLowerCase();
  if (browser !== "ardia" && browser !== "chrome") throw new Error("browser must be ardia or chrome");
  if (!String(opts.ref || "").trim()) throw new Error("ref is required");
  const vault = resolveVault(opts);
  const entry = await mustEntry(vault, opts.id);
  const secret = await getSecret(vault, PASSWORD_SERVICE, entry.id);
  if (!secret) throw new Error("no password stored for that account");
  await appendAccess(vault, { ...entry, reason, kind: "fill" }, opts);
  const typePassword = opts.typePassword || defaultType;
  try {
    await typePassword({ browser, ref: opts.ref, secret, entry });
  } catch (err) {
    throw new Error(redact(err.message || "fill failed", secret));
  }
  return { ok: true, filled: true };
}

export async function otpAccount(opts = {}) {
  const reason = requireReason(opts.reason);
  const vault = resolveVault(opts);
  const entry = await mustEntry(vault, opts.id);
  const stored = await getSecret(vault, OTP_SERVICE, entry.id);
  if (!stored) throw new Error("no one-time code stored for that account");
  const code = totpCode(stored, opts.now);
  await appendAccess(vault, { ...entry, reason, kind: "otp" }, opts);
  if (opts.browser || opts.ref) {
    const browser = String(opts.browser || "").toLowerCase();
    if (browser !== "ardia" && browser !== "chrome") throw new Error("browser must be ardia or chrome");
    if (!String(opts.ref || "").trim()) throw new Error("ref is required");
    const typePassword = opts.typePassword || defaultType;
    try {
      await typePassword({ browser, ref: opts.ref, secret: code, entry });
    } catch (err) {
      throw new Error(redact(err.message || "fill failed", code));
    }
    return { ok: true, filled: true };
  }
  return { ok: true, code };
}

export function isMacPasswordApp(name) {
  return MAC_APPS.has(String(name || "").trim().toLowerCase());
}

async function defaultFrontmost() {
  const { stdout } = await run("osascript", [
    "-e",
    'tell application "System Events" to get name of first application process whose frontmost is true',
  ]);
  return stdout.trim();
}

function appleString(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function typeIntoFrontmost({ secret }) {
  const source = `tell application "System Events" to keystroke ${appleString(secret)}\n`;
  await run("osascript", ["-"], source);
}

export async function unlockDialog(opts = {}) {
  const reason = requireReason(opts.reason);
  const vault = resolveVault(opts);
  const frontmost = opts.frontmostApp || defaultFrontmost;
  const name = await frontmost();
  if (!isMacPasswordApp(name)) {
    throw new Error("the Passwords app or a macOS password dialog has to be in front");
  }
  const secret = await getSecret(vault, MAC_SERVICE, MAC_ACCOUNT);
  if (!secret) throw new Error("no Mac login password stored");
  await appendAccess(
    vault,
    {
      id: "mac-login",
      title: "Mac login",
      url: "",
      username: "",
      reason,
      kind: "unlock-dialog",
    },
    opts
  );
  const typePassword = opts.typePassword || typeIntoFrontmost;
  try {
    await typePassword({ secret });
  } catch (err) {
    throw new Error(redact(err.message || "could not type", secret));
  }
  return { ok: true, typed: true };
}

export async function setMacPassword(secret, opts = {}) {
  const value = String(secret ?? "").replace(/[\r\n]+$/, "");
  if (!value) throw new Error("empty");
  const vault = resolveVault(opts);
  await setSecret(vault, MAC_SERVICE, MAC_ACCOUNT, value, "Mac login");
  return { ok: true };
}

export async function readPasswordAccess(opts = {}) {
  const vault = resolveVault(opts);
  let text = "";
  try {
    text = await readFile(join(vault.dir, "access.jsonl"), "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line);
      rows.push({
        at: String(raw.at || ""),
        when: formatPacificTime(raw.at),
        id: String(raw.id || ""),
        title: String(raw.title || ""),
        url: String(raw.url || ""),
        username: String(raw.username || ""),
        reason: String(raw.reason || ""),
        kind: String(raw.kind || ""),
      });
    } catch {
      /* skip a broken line */
    }
  }
  rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (opts.limit == null) return rows.slice(0, 200);
  if (opts.limit <= 0) return rows;
  return rows.slice(0, opts.limit);
}

/**
 * Copy access-log rows into the agent action log. A repeated id is skipped.
 * @param {{ path?: string, dir?: string, backend?: string, env?: NodeJS.ProcessEnv }} opts
 */
export async function seedPasswordActions(opts = {}) {
  const path = String(opts.path || "");
  if (!path) return;
  const rows = await readPasswordAccess({
    dir: opts.dir,
    backend: opts.backend,
    env: opts.env,
    limit: 0,
  });
  if (!rows.length) return;
  const { appendAgentAction, readActionIds } = await import("./agent-actions.js");
  const ids = await readActionIds(path);
  for (const row of rows) {
    const id = passwordActionId(row);
    if (ids.has(id)) continue;
    ids.add(id);
    await appendAgentAction(
      {
        at: row.at,
        agent: "personal-agent",
        kind: "password",
        summary: passwordActionSummary(row),
        id,
      },
      { path }
    );
  }
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return "";
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || "";
  try {
    if (cmd === "list") {
      const rows = await listAccounts({ query: flag(argv, "--query") });
      process.stdout.write(`${JSON.stringify(rows)}\n`);
      return;
    }
    if (cmd === "import") {
      const file = argv[1];
      if (!file || file.startsWith("--")) throw new Error("import needs a CSV path");
      const counts = await importCsv(file);
      process.stdout.write(`added ${counts.added}\nupdated ${counts.updated}\nunchanged ${counts.unchanged}\n`);
      return;
    }
    if (cmd === "fill") {
      await fillAccount({
        id: flag(argv, "--id"),
        reason: flag(argv, "--reason"),
        browser: flag(argv, "--browser"),
        ref: flag(argv, "--ref"),
        agent: flag(argv, "--via"),
      });
      process.stdout.write("filled\n");
      return;
    }
    if (cmd === "otp") {
      const browser = flag(argv, "--browser");
      const ref = flag(argv, "--ref");
      const result = await otpAccount({
        id: flag(argv, "--id"),
        reason: flag(argv, "--reason"),
        browser,
        ref,
        agent: flag(argv, "--via"),
      });
      process.stdout.write(result.filled ? "filled\n" : `${result.code}\n`);
      return;
    }
    if (cmd === "unlock-dialog") {
      await unlockDialog({
        reason: flag(argv, "--reason"),
        agent: flag(argv, "--via"),
      });
      process.stdout.write("typed\n");
      return;
    }
    if (cmd === "set-mac") {
      await setMacPassword(await readStdin());
      process.stdout.write("saved\n");
      return;
    }
    throw new Error("commands: list, import, fill, otp, unlock-dialog, set-mac");
  } catch (err) {
    process.stderr.write(`${err.message || "password command failed"}\n`);
    process.exitCode = 1;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (invokedDirectly()) main();
