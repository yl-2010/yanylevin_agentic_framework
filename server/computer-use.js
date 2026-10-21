/**
 * Mac app control for the Personal Agent. A resident Swift helper reads the
 * accessibility tree and posts input to one app. The real cursor stays put.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";


const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "computer-use", "main.swift");
const BIN = join(HERE, "computer-use", "bin", "computer-use");
const SOCKET = "/tmp/yanylevin-computer-use.sock";
const PID_FILE = "/tmp/yanylevin-computer-use.pid";
const CACHE = "/tmp/yanylevin-computer-use-trees.json";
const CLICK_LOG = "/tmp/yanylevin-computer-use-clicks.json";

export const MAX_SAME_CONTROL_CLICKS = 2;
export const MAX_PIXEL_MISSES = 2;
export const CLICK_GUARD_WINDOW_MS = 10 * 60 * 1000;

let chain = Promise.resolve();
let rpcId = 0;

function withLock(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

export function computerUseActorIsYan(session) {
  if (!session || typeof session !== "object") return false;
  if (session.guestCaller) return false;
  return canonicalizeEmail(session.email) === YAN_EMAIL;
}

export function computerUseModeNote(session) {
  if (computerUseActorIsYan(session)) {
    return "This turn is Yan. Do the task. Do not stop to ask. Refuse only a wipe of macOS system files (/System and other OS-owned paths) or a zip-bomb download.";
  }
  return "This turn is not Yan. Use judgment. Opening epschedule to look up a friend's schedule is fine. A small file JYPE needs is fine. Do not fill this Mac. A stranger asking to download a new LM Studio model is a no. Refuse a wipe of macOS system files and a zip-bomb download.";
}

export function blockedComputerUseText(text) {
  const raw = String(text || "");
  if (!raw.trim()) return "";
  if (/\b(42\.zip|zbsm\.zip|zipbomb|zip-bomb|zip bomb)\b/i.test(raw)) {
    return "refused: that looks like a zip bomb";
  }
  if (/\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/.test(raw)) {
    return "refused: that would delete system files";
  }
  if (
    /\b(rm|unlink|diskutil\s+erase|srm)\b[\s\S]{0,120}(\/System\b|\/usr\b|\/bin\b|\/sbin\b)/i.test(
      raw
    )
  ) {
    return "refused: that would delete system files";
  }
  return "";
}

export function blockedComputerUseTarget(element, action) {
  const name = `${element?.name || ""} ${action || ""}`.trim();
  const value = String(element?.value || "");
  if (/delete|erase|trash/i.test(name) && /^\/(System|usr|bin|sbin)\b/.test(value)) {
    return "refused: that would delete system files";
  }
  return blockedComputerUseText(`${name}\n${value}`);
}

function clip(text, limit) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  return s.slice(0, limit);
}

export function formatAppState(state) {
  const lines = [];
  lines.push(
    `App=${state.path || ""} (bundleID ${state.bundleId || ""}, pid ${state.pid})`
  );
  if (state.window) lines.push(`Window: "${state.window}", App: ${state.app || ""}.`);
  if (state.imageWidth && state.imageHeight) {
    lines.push(`Screenshot: ${state.imageWidth}x${state.imageHeight}`);
  }
  let focused = null;
  for (const el of state.elements || []) {
    const traits = [];
    if (el.disabled) traits.push("disabled");
    if (el.settable) traits.push("settable");
    if (el.valueType) traits.push(el.valueType);
    const trait = traits.length ? ` (${traits.join(", ")})` : "";
    const name = el.name ? ` ${el.name}` : "";
    const bits = [`${el.id} ${el.role || "element"}${name}${trait}`];
    if (el.value) bits.push(`Value: ${clip(el.value, 400)}`);
    if (el.help) bits.push(`Help: ${clip(el.help, 160)}`);
    if (el.identifier) bits.push(`ID: ${el.identifier}`);
    if (Array.isArray(el.actions) && el.actions.length) {
      bits.push(`Secondary Actions: ${el.actions.join(", ")}`);
    }
    if (el.omitted) bits.push(`(+${el.omitted} descendants omitted)`);
    const indent = "\t".repeat(Number(el.depth) || 0);
    lines.push(indent + bits.join(", "));
    if (el.focused) focused = el;
  }
  if (focused) {
    const name = focused.name ? ` ${focused.name}` : "";
    lines.push(`The focused UI element is ${focused.id} ${focused.role || "element"}${name}`);
  }
  if (state.screenshotError) lines.push(String(state.screenshotError));
  return lines.join("\n");
}

export function treeUnchanged(text) {
  return String(text || "").includes("no change in the accessibility tree");
}

export function sameControlKey(role, name) {
  const label = String(name || "").trim();
  if (!label) return "";
  return `${String(role || "").trim()}|${label}`.toLowerCase();
}

function blankClickRow(now) {
  return { names: {}, pixelMisses: 0, at: now };
}

function clickRow(log, pid, now) {
  const prev = log[String(pid)];
  if (!prev || typeof prev !== "object") return blankClickRow(now);
  const at = Number(prev.at) || 0;
  if (!at || now - at > CLICK_GUARD_WINDOW_MS) return blankClickRow(now);
  return {
    names: prev.names && typeof prev.names === "object" ? { ...prev.names } : {},
    pixelMisses: Number(prev.pixelMisses) || 0,
    at,
  };
}

export function applyClickGuard(log, { pid, name, role, now, pixel }) {
  const key = String(pid || 0);
  const row = clickRow(log, pid, now);
  row.at = now;
  const next = { ...log, [key]: row };
  if (pixel) {
    if (row.pixelMisses >= MAX_PIXEL_MISSES) {
      return {
        allow: false,
        log: next,
        error:
          "stopped: pixel clicks are not landing and the tree is unchanged. Do not click again. Tell the user the control is not in the accessibility tree.",
      };
    }
    return { allow: true, log: next };
  }
  const label = sameControlKey(role, name);
  if (!label) return { allow: true, log: next };
  const count = (Number(row.names[label]) || 0) + 1;
  row.names = { ...row.names, [label]: count };
  next[key] = row;
  if (count > MAX_SAME_CONTROL_CLICKS) {
    return {
      allow: false,
      log: next,
      error: `stopped: clicked "${String(name).trim()}" ${count} times. That control is not doing the job. Do not click it again. Say what failed.`,
    };
  }
  return { allow: true, log: next };
}

export function applyPixelResult(log, { pid, changed, now }) {
  const key = String(pid || 0);
  const row = clickRow(log, pid, now);
  row.at = now;
  row.pixelMisses = changed ? 0 : row.pixelMisses + 1;
  const next = { ...log, [key]: row };
  if (changed) return { log: next, error: "" };
  if (row.pixelMisses >= MAX_PIXEL_MISSES) {
    return {
      log: next,
      error:
        "stopped: pixel clicks are not landing and the tree is unchanged. Do not click again. Tell the user the control is not in the accessibility tree.",
    };
  }
  return {
    log: next,
    error:
      "pixel click posted but the accessibility tree did not change. The click missed. Do not spray a grid. One more try, then stop.",
  };
}

function readClickLog() {
  try {
    const parsed = JSON.parse(readFileSync(CLICK_LOG, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeClickLog(log) {
  writeFileSync(CLICK_LOG, JSON.stringify(log));
}

export function diffTreeText(previous, next) {
  const prev = String(previous || "");
  const curr = String(next || "");
  if (!prev) return curr;
  if (prev === curr) return "There has been no change in the accessibility tree.";
  const prevLines = prev.split("\n");
  const nextLines = curr.split("\n");
  const nextSet = new Set(nextLines);
  const prevSet = new Set(prevLines);
  const body = [
    ...prevLines.filter((line) => !nextSet.has(line)).map((line) => `- ${line}`),
    ...nextLines.filter((line) => !prevSet.has(line)).map((line) => `+ ${line}`),
  ].join("\n");
  return `The following is a diff from the previous accessibility tree\n${body}`;
}

function readCache() {
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  writeFileSync(CACHE, JSON.stringify(cache));
}

function elementOf(pid, id) {
  const cache = readCache();
  const rows =
    pid && cache[String(pid)] ? [cache[String(pid)]] : Object.values(cache);
  for (const row of rows) {
    const hit = (row?.elements || []).find((el) => el.id === id);
    if (hit) return hit;
  }
  return undefined;
}

function helperPid() {
  try {
    return Number(readFileSync(PID_FILE, "utf8"));
  } catch {
    return 0;
  }
}

function helperAlive() {
  const pid = helperPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopHelper() {
  const pid = helperPid();
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  try {
    unlinkSync(SOCKET);
  } catch {
    /* no socket */
  }
}

function binaryFresh() {
  try {
    return statSync(BIN).mtimeMs >= statSync(SRC).mtimeMs;
  } catch {
    return false;
  }
}

export function ensureComputerUseBinary() {
  if (binaryFresh()) return BIN;
  mkdirSync(dirname(BIN), { recursive: true });
  if (helperAlive()) stopHelper();
  execFileSync(
    "swiftc",
    [
      "-O",
      "-o",
      BIN,
      SRC,
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
      "-framework",
      "ScreenCaptureKit",
    ],
    { stdio: "inherit" }
  );
  execFileSync("codesign", ["-s", "-", "--force", BIN], { stdio: "inherit" });
  return BIN;
}

function pingSocket() {
  return new Promise((resolve) => {
    const sock = createConnection(SOCKET);
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, 200);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function ensureHelper() {
  ensureComputerUseBinary();
  if (helperAlive() && (await pingSocket())) return;
  if (helperAlive()) stopHelper();
  try {
    unlinkSync(SOCKET);
  } catch {
    /* already gone */
  }
  const child = spawn(BIN, ["serve"], { detached: true, stdio: "ignore" });
  child.unref();
  for (let i = 0; i < 40; i += 1) {
    if (await pingSocket()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("computer use helper did not start");
}

function rpc(payload) {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("computer use timed out"));
    }, 20000);
    sock.on("connect", () => {
      sock.write(`${JSON.stringify(payload)}\n`);
    });
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      clearTimeout(timer);
      sock.end();
      try {
        resolve(JSON.parse(buf.slice(0, nl)));
      } catch (err) {
        reject(err);
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function call(payload) {
  return withLock(async () => {
    await ensureHelper();
    rpcId += 1;
    return rpc({ ...payload, rpc: rpcId });
  });
}

function numberArg(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export async function listApps() {
  const raw = await call({ cmd: "apps" });
  if (!raw?.ok) return { ok: false, error: raw?.error || "list failed" };
  return { ok: true, apps: raw.apps || [] };
}

export async function readAppState(app) {
  const raw = await call({ cmd: "state", app: String(app || "") });
  if (!raw?.ok) return { ok: false, error: raw?.error || "state failed" };
  const fullText = formatAppState(raw);
  const cache = readCache();
  const prev = cache[String(raw.pid)]?.text || "";
  const key = String(raw.pid);
  delete cache[key];
  cache[key] = { text: fullText, elements: raw.elements || [] };
  writeCache(cache);
  return {
    ok: true,
    pid: raw.pid,
    text: diffTreeText(prev, fullText),
    jpeg: raw.jpeg || "",
    imageWidth: raw.imageWidth || 0,
    imageHeight: raw.imageHeight || 0,
  };
}

function pidOf(input) {
  return numberArg(input?.pid) || 0;
}

function rememberedPid() {
  const ids = Object.keys(readCache())
    .map(Number)
    .filter((n) => n > 0);
  return ids.at(-1) || 0;
}

function pixelTarget(cmd, input, id) {
  if (cmd !== "click" && cmd !== "drag") return false;
  if (id != null) return false;
  return numberArg(input?.x) != null && numberArg(input?.y) != null;
}

export async function performComputerUse(input) {
  const cmd = String(input?.cmd || "");
  const text = [input?.text, input?.value, input?.key, input?.name]
    .filter(Boolean)
    .join("\n");
  const blockedText = blockedComputerUseText(text);
  if (blockedText) return { ok: false, error: blockedText };
  const id = numberArg(input?.element_index ?? input?.id);
  const pid = pidOf(input) || rememberedPid();
  if (id != null) {
    const blockedTarget = blockedComputerUseTarget(elementOf(pid, id), input?.name || cmd);
    if (blockedTarget) return { ok: false, error: blockedTarget };
  }
  const pixel = pixelTarget(cmd, input, id);
  const now = Date.now();
  let guardLog = readClickLog();
  if (cmd === "click" && id != null) {
    const el = elementOf(pid, id);
    const verdict = applyClickGuard(guardLog, {
      pid,
      name: el?.name,
      role: el?.role,
      now,
    });
    guardLog = verdict.log;
    writeClickLog(guardLog);
    if (!verdict.allow) return { ok: false, error: verdict.error };
  }
  if (pixel) {
    const verdict = applyClickGuard(guardLog, { pid, pixel: true, now });
    guardLog = verdict.log;
    writeClickLog(guardLog);
    if (!verdict.allow) return { ok: false, error: verdict.error };
  }
  const body = {
    cmd,
    app: input?.app || "",
    pid: pid || undefined,
    id,
    element_index: id,
    text: input?.text,
    value: input?.value,
    key: input?.key,
    name: input?.name,
    pages: input?.pages,
    x: input?.x,
    y: input?.y,
    toX: input?.toX,
    toY: input?.toY,
    button: input?.button,
    count: input?.count,
  };
  const raw = await call(body);
  if (!raw?.ok) return { ok: false, error: raw?.error || "action failed" };
  if (!pixel) return { ok: true };
  const before = readCache()[String(pid)]?.text || "";
  let after = { ok: false, text: "" };
  try {
    after = await readAppState(String(pid || ""));
  } catch {
    after = { ok: false, text: "" };
  }
  const changed = Boolean(before) && after?.ok === true && !treeUnchanged(after.text);
  const verdict = applyPixelResult(readClickLog(), { pid, changed, now: Date.now() });
  writeClickLog(verdict.log);
  if (verdict.error) return { ok: false, error: verdict.error };
  return { ok: true };
}

function toolText(result) {
  if (result?.ok) return "ok";
  return result?.error || "action failed";
}

function stateContent(result) {
  if (!result?.ok) return result?.error || "state failed";
  const content = [{ type: "text", text: result.text }];
  if (result.jpeg) {
    content.push({ type: "image", data: result.jpeg, mimeType: "image/jpeg" });
  }
  return { content };
}

export function computerUseCustomTools(session) {
  const note = computerUseModeNote(session);
  const observe =
    "Call this before you click or type. The text is an accessibility tree. Act on the element number. Use screenshot pixels only when the tree has no control. Pixel origin is the top-left of the screenshot.";
  return {
    list_apps: {
      description: `${note} List running Mac apps (name, bundle id, pid). Skip menu extras.`,
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const result = await listApps();
        if (!result.ok) return result.error;
        return (result.apps || [])
          .map((app) => `${app.pid}\t${app.name}\t${app.bundleId}`)
          .join("\n");
      },
    },
    get_app_state: {
      description: `${note} ${observe} Pass an app name, bundle id, or pid.`,
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App name, bundle id, or pid" },
        },
        required: ["app"],
      },
      execute: async ({ app }) => stateContent(await readAppState(app)),
    },
    click: {
      description: `${note} Click an element number from the last tree, or one screenshot x,y when the tree has no control. Pass pid. The click stays in that app. It does not move the real cursor or raise the window. A click returns ok when the event is posted. If the next tree is unchanged, stop. The helper refuses a third click on the same control and further pixel clicks after two misses.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string" },
          count: { type: "number" },
        },
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "click" })),
    },
    type_text: {
      description: `${note} Type into the focused control, or the element number you pass. Typing stays in that app. It does not move the real cursor or raise the window.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          text: { type: "string" },
        },
        required: ["text"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "type" })),
    },
    press_key: {
      description: `${note} Press a key in that app. Examples: Return, Escape, cmd+a, Meta+a. The key stays in that app. It does not raise the window.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          key: { type: "string" },
        },
        required: ["key"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "key" })),
    },
    scroll: {
      description: `${note} Scroll an element by pages. Positive is down. Fractions are fine.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          pages: { type: "number" },
        },
        required: ["element_index", "pages"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "scroll" })),
    },
    drag: {
      description: `${note} Drag in screenshot pixels from x,y to toX,toY. The drag stays in that app and does not move the real cursor. Same stop rules as a pixel click. Two misses end it.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
        },
        required: ["x", "y", "toX", "toY"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "drag" })),
    },
    set_value: {
      description: `${note} Set a control marked settable. Prefer this over typing the value one key at a time.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          value: { type: "string" },
        },
        required: ["element_index", "value"],
      },
      execute: async (input) =>
        toolText(await performComputerUse({ ...input, cmd: "set_value" })),
    },
    perform_secondary_action: {
      description: `${note} Run a Secondary Action named in the tree, such as Raise or Show menu.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          name: { type: "string" },
        },
        required: ["element_index", "name"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "action" })),
    },
    select_text: {
      description: `${note} Select a substring already in a text control.`,
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          text: { type: "string" },
        },
        required: ["element_index", "text"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "select" })),
    },
  };
}

export function parseComputerUseArgs(argv) {
  const args = [...argv];
  const cmd = String(args.shift() || "").trim();
  const out = {
    cmd,
    app: "",
    id: undefined,
    text: "",
    key: "",
    name: "",
    pages: undefined,
    x: undefined,
    y: undefined,
    toX: undefined,
    toY: undefined,
    pid: undefined,
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    const next = args[i + 1];
    if (token === "--text" || token === "--value") {
      out.text = args.slice(i + 1).join(" ");
      break;
    }
    if (token === "--key") {
      out.key = String(next || "");
      i += 1;
      continue;
    }
    if (token === "--name") {
      out.name = String(next || "");
      i += 1;
      continue;
    }
    if (token === "--pages") {
      out.pages = numberArg(next);
      i += 1;
      continue;
    }
    if (token === "--x") {
      out.x = numberArg(next);
      i += 1;
      continue;
    }
    if (token === "--y") {
      out.y = numberArg(next);
      i += 1;
      continue;
    }
    if (token === "--to-x") {
      out.toX = numberArg(next);
      i += 1;
      continue;
    }
    if (token === "--to-y") {
      out.toY = numberArg(next);
      i += 1;
      continue;
    }
    if (token === "--pid") {
      out.pid = numberArg(next);
      i += 1;
      continue;
    }
    positional.push(token);
  }
  if (cmd === "state") out.app = positional.join(" ");
  else if (positional[0] != null && positional[0] !== "") out.id = numberArg(positional[0]);
  if (cmd === "key" && !out.key) out.key = positional.join("+");
  if ((cmd === "type" || cmd === "set" || cmd === "select") && !out.text && positional.length > 1) {
    out.text = positional.slice(1).join(" ");
  }
  return out;
}

export async function runComputerUse(argv) {
  const parsed = parseComputerUseArgs(argv);
  const cmd = parsed.cmd;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    return {
      ok: true,
      commands: [
        "apps",
        "state <app>",
        "click <id>",
        "type <id> --text ...",
        "key <spec>",
        "scroll <id> --pages N",
        "drag --x --y --to-x --to-y",
        "set <id> --value ...",
        "action <id> --name ...",
        "select <id> --text ...",
      ],
    };
  }
  if (cmd === "apps") return listApps();
  if (cmd === "state") {
    const result = await readAppState(parsed.app);
    if (!result.ok) return result;
    return { ok: true, text: result.text, pid: result.pid, image: Boolean(result.jpeg) };
  }
  const map = {
    click: "click",
    type: "type",
    key: "key",
    scroll: "scroll",
    drag: "drag",
    set: "set_value",
    action: "action",
    select: "select",
  };
  const rpcCmd = map[cmd];
  if (!rpcCmd) return { ok: false, error: `unknown command: ${cmd}` };
  const cache = readCache();
  const remembered = Object.keys(cache)
    .map(Number)
    .filter((n) => n > 0)
    .at(-1);
  return performComputerUse({
    cmd: rpcCmd,
    pid: parsed.pid || remembered,
    element_index: parsed.id,
    text: parsed.text,
    value: parsed.text,
    key: parsed.key || parsed.text,
    name: parsed.name,
    pages: parsed.pages,
    x: parsed.x,
    y: parsed.y,
    toX: parsed.toX,
    toY: parsed.toY,
  });
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runComputerUse(process.argv.slice(2))
    .then((result) => {
      if (result?.text) process.stdout.write(`${result.text}\n`);
      else process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exit(result?.ok === false ? 1 : 0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
