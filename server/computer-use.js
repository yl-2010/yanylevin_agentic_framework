/**
 * Mac app control for the Personal Agent. A resident Swift helper reads the
 * accessibility tree and posts input to one app. The real cursor stays put.
 */

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "computer-use", "main.swift");
const BIN = join(HERE, "computer-use", "bin", "computer-use");
const SOCKET = "/tmp/yanylevin-computer-use.sock";
const PID_FILE = "/tmp/yanylevin-computer-use.pid";
const CACHE = "/tmp/yanylevin-computer-use-trees.json";

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

export async function readAppState(app, opts = {}) {
  const raw = await call({
    cmd: "state",
    app: String(app || ""),
    foreground: opts.foreground === true,
  });
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

export async function performComputerUse(input) {
  const cmd = String(input?.cmd || "");
  const id = numberArg(input?.element_index ?? input?.id);
  const pid = pidOf(input) || rememberedPid();
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
    foreground: input?.foreground === true,
  };
  const raw = await call(body);
  if (!raw?.ok) return { ok: false, error: raw?.error || "action failed" };
  if (cmd === "restore") {
    if (raw.restored) return { ok: true, text: `restored ${raw.app || raw.pid}` };
    return { ok: true, text: "nothing to restore" };
  }
  return { ok: true };
}

function toolText(result) {
  if (result?.ok) return result.text || "ok";
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

export function computerUseCustomTools() {
  const foregroundProp = {
    type: "boolean",
    description:
      "Make this app the active window. A pixel click or drag then uses the real cursor.",
  };
  return {
    list_apps: {
      description: "List running Mac apps (name, bundle id, pid). Skip menu extras.",
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
      description:
        "Read one app's accessibility tree and a screenshot of its window. Pass an app name, bundle id, or pid. Act on the element number. Screenshot pixels are for when the tree has no control. Origin is the top-left of that image.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", description: "App name, bundle id, or pid" },
          foreground: foregroundProp,
        },
        required: ["app"],
      },
      execute: async (input) =>
        stateContent(
          await readAppState(input?.app, { foreground: input?.foreground === true })
        ),
    },
    click: {
      description:
        "Click an element number from the last tree, or screenshot x,y when the tree has no control. Pass pid. Without foreground, the click is posted to that app and the real cursor stays put.",
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          element_index: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string" },
          count: { type: "number" },
          foreground: foregroundProp,
        },
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "click" })),
    },
    type_text: {
      description: "Type into the focused control, or the element number you pass.",
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
      description: "Press a key in that app. Examples: Return, Escape, cmd+a, Meta+a.",
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
      description: "Scroll an element by pages. Positive is down. Fractions are fine.",
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
      description:
        "Drag in screenshot pixels from x,y to toX,toY. Without foreground, the drag is posted to that app and the real cursor stays put.",
      inputSchema: {
        type: "object",
        properties: {
          pid: { type: "number" },
          x: { type: "number" },
          y: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          foreground: foregroundProp,
        },
        required: ["x", "y", "toX", "toY"],
      },
      execute: async (input) => toolText(await performComputerUse({ ...input, cmd: "drag" })),
    },
    set_value: {
      description: "Set a control marked settable. Prefer this over typing the value one key at a time.",
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
      description: "Run a Secondary Action named in the tree, such as Raise or Show menu.",
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
    restore_front: {
      description: "Activate the app that was in front before the last foreground.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => toolText(await performComputerUse({ cmd: "restore" })),
    },
    select_text: {
      description: "Select a substring already in a text control.",
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
    foreground: false,
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
    if (token === "--foreground") {
      out.foreground = true;
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
        "restore",
      ],
    };
  }
  if (cmd === "apps") return listApps();
  if (cmd === "restore") return performComputerUse({ cmd: "restore" });
  if (cmd === "state") {
    const result = await readAppState(parsed.app, { foreground: parsed.foreground === true });
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
    foreground: parsed.foreground === true,
  });
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  console.error(
    "server/computer-use.js is off. Use Cursor computer use. That step uses this turn's model."
  );
  process.exit(1);
}
