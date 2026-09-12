/**
 * Apple Home via HomeClaw. The App Store menu-bar app holds HMHomeManager;
 * this wraps homeclaw-cli over its local socket. Does not build macos/YLHome.
 */

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const HOMECLAW_APP = "/Applications/HomeClaw.app";
export const HOMECLAW_CLI_IN_APP = join(HOMECLAW_APP, "Contents/MacOS/homeclaw-cli");
export const MAS_URL = "https://apps.apple.com/us/app/homeclaw/id6759682551?mt=12";
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/zjSnz8eK";

const JSON_COMMANDS = new Set([
  "status",
  "list",
  "get",
  "search",
  "scenes",
  "get-scene",
  "device-map",
  "events",
  "config",
  "automations",
  "triggers",
]);

const CHAR_ALIAS = {
  lock: "lock_target_state",
  temperature: "target_temperature",
  target_temperature: "target_temperature",
  heating_cooling: "target_heating_cooling",
  position: "target_position",
  door: "target_door_state",
  speed: "rotation_speed",
  color_temperature: "color_temperature",
  hue: "hue",
  saturation: "saturation",
  brightness: "brightness",
  power: "power",
  on: "power",
};

export function missingInstallMessage() {
  return `HomeClaw is not installed. Install from the Mac App Store (${MAS_URL}) or TestFlight (${TESTFLIGHT_URL}), launch it, grant HomeKit, leave it in the menu bar, then retry.`;
}

export function notRunningMessage() {
  return "HomeClaw.app is installed but not running, or HomeKit was not granted. Open HomeClaw, click Allow for HomeKit, leave the menu bar icon up, then retry.";
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} [explicit]
 * @returns {Promise<string|null>}
 */
export async function findHomeclawCli(explicit = process.env.HOMECLAW_CLI) {
  const candidates = [
    String(explicit || "").trim(),
    HOMECLAW_CLI_IN_APP,
    "/opt/homebrew/bin/homeclaw-cli",
    "/usr/local/bin/homeclaw-cli",
    join(homedir(), "Applications/HomeClaw.app/Contents/MacOS/homeclaw-cli"),
  ].filter(Boolean);
  for (const p of candidates) {
    if (await exists(p)) return p;
  }
  try {
    const { stdout } = await execFileAsync("which", ["homeclaw-cli"], {
      timeout: 5_000,
    });
    const found = String(stdout || "").trim();
    if (found && (await exists(found))) return found;
  } catch {
    /* not in PATH */
  }
  return null;
}

function aliasChar(raw) {
  const k = String(raw || "").toLowerCase();
  return CHAR_ALIAS[k] || k;
}

/**
 * Split `set NAME on brightness 40` into HomeClaw one-characteristic calls.
 * @param {string[]} tokens after the accessory name
 * @returns {string[][]}
 */
export function parseSetPairs(tokens) {
  const pairs = [];
  let i = 0;
  while (i < tokens.length) {
    const t = String(tokens[i] || "").toLowerCase();
    if (t === "on" || t === "true") {
      pairs.push(["power", "true"]);
      i += 1;
      continue;
    }
    if (t === "off" || t === "false") {
      pairs.push(["power", "false"]);
      i += 1;
      continue;
    }
    const value = tokens[i + 1];
    if (value == null) {
      throw new Error(`set needs a value after "${tokens[i]}"`);
    }
    pairs.push([aliasChar(t), String(value)]);
    i += 2;
  }
  return pairs;
}

function wantsJson(command, args) {
  if (args.includes("--json")) return false;
  if (command === "automations" && args[1] === "list") return true;
  if (command === "automations" && args[1] === "get") return true;
  return JSON_COMMANDS.has(command);
}

/**
 * @param {string[]} args
 * @returns {string[][]}
 */
function splitFlags(args) {
  const positional = [];
  const flags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (String(a).startsWith("--")) {
      flags.push(a === "--type" ? "--category" : a);
      const next = args[i + 1];
      if (next != null && !String(next).startsWith("--")) {
        flags.push(next);
        i += 1;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export function expandHomeArgs(args) {
  const raw = args.filter((a) => a !== "--live").map((a) => (a === "--type" ? "--category" : a));
  if (!raw.length) return [["status"]];
  const command = raw[0];
  if (command === "homes") return [["status"]];
  if (command === "rooms") {
    const rest = raw.slice(1);
    return [["list", ...rest]];
  }
  if (command === "toggle") {
    const { positional, flags } = splitFlags(raw.slice(1));
    const name = positional[0];
    if (!name) throw new Error("toggle needs an accessory name");
    return [["__toggle", name, ...flags]];
  }
  if (command === "set") {
    const { positional, flags } = splitFlags(raw.slice(1));
    const name = positional[0];
    if (!name) throw new Error("set needs an accessory name");
    const pairs = parseSetPairs(positional.slice(1));
    if (!pairs.length) throw new Error("set needs a characteristic and value");
    return pairs.map(([k, v]) => ["set", name, k, v, ...flags]);
  }
  return [raw];
}

async function runCli(bin, args, timeoutMs) {
  const command = args[0];
  const forwarded = [...args];
  if (wantsJson(command, forwarded)) forwarded.push("--json");
  try {
    const { stdout, stderr } = await execFileAsync(bin, forwarded, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OUTPUT_FORMAT: "json" },
    });
    return { stdout: String(stdout || ""), stderr: String(stderr || "") };
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || err);
    if (/not running|could not connect|connection refused|socket/i.test(detail)) {
      throw new Error(notRunningMessage());
    }
    const parsed = parseJson(detail) || parseJson(String(err.stdout || ""));
    if (parsed) return { stdout: JSON.stringify(parsed), stderr: detail, parsed };
    throw new Error(detail.slice(-2500) || "homeclaw-cli failed");
  }
}

function parseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const line = raw.split("\n").filter(Boolean).at(-1);
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function powerFromGet(obj) {
  if (!obj || typeof obj !== "object") return null;
  const cands = [
    obj.power,
    obj.power_state,
    obj.state?.power,
    obj.state?.power_state,
    obj.characteristics?.power,
    obj.accessory?.power,
  ];
  for (const v of cands) {
    if (v === true || v === "true" || v === "on" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === "off" || v === 0 || v === "0") return false;
  }
  if (Array.isArray(obj.characteristics)) {
    const row = obj.characteristics.find((c) =>
      /^(power|on)$/i.test(String(c.name || c.characteristic || c.type || ""))
    );
    if (row && row.value != null) return powerFromGet({ power: row.value });
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, bin?: string }} [opts]
 */
export async function runHome(args, opts = {}) {
  const bin = opts.bin || (await findHomeclawCli());
  if (!bin) throw new Error(missingInstallMessage());
  const timeoutMs = opts.timeoutMs || 70_000;
  const batches = expandHomeArgs(args);
  const results = [];
  for (const batch of batches) {
    if (batch[0] === "__toggle") {
      const name = batch[1];
      const got = await runCli(bin, ["get", name], timeoutMs);
      const obj = parseJson(got.stdout);
      const on = powerFromGet(obj);
      if (on == null) {
        throw new Error(
          `toggle: could not read power for ${JSON.stringify(name)}. Use set … power true/false.`
        );
      }
      const next = await runCli(
        bin,
        ["set", name, "power", on ? "false" : "true", ...batch.slice(2)],
        timeoutMs
      );
      results.push(parseJson(next.stdout) || { ok: true, stdout: next.stdout });
      continue;
    }
    const out = await runCli(bin, batch, timeoutMs);
    results.push(parseJson(out.stdout) || { ok: true, stdout: out.stdout.trim() });
  }
  if (results.length === 1) return results[0];
  return { ok: true, results };
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runHome(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (r && r.ok === false) process.exit(1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
