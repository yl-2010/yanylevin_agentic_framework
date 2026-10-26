/**
 * Append-only log of side effects Yan would not already see.
 * Mail, education dates, lights, and the vacuum belong here.
 * Teams and iMessage sends do not. Those already show in the chat.
 * Calendar writes do not, including nightly ones. Those already show on the calendar.
 * File stays on the Mac. data/agent-actions.jsonl is gitignored.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatPacificTime } from "./chat-log.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const AGENT_ACTIONS_PATH = join(ROOT, "data", "agent-actions.jsonl");

const AGENT_LABELS = {
  "home-agent": "Home agent",
  "calendar-on-demand": "Calendar on demand",
  "nightly-actions": "Nightly actions",
};

/** Already visible in Teams, Messages, or on the calendar. The Actions rail skips these. */
const HIDDEN_KINDS = new Set(["teams", "imessage", "calendar"]);
const HIDDEN_AGENTS = new Set(["calendar-on-demand"]);

/**
 * @param {string} kind
 * @param {string} [agent]
 */
export function isDashboardAction(kind, agent = "") {
  if (HIDDEN_KINDS.has(String(kind || "").trim())) return false;
  if (HIDDEN_AGENTS.has(String(agent || "").trim())) return false;
  return true;
}

/**
 * @param {string} agent
 */
export function agentLabel(agent) {
  const id = String(agent || "").trim();
  if (AGENT_LABELS[id]) return AGENT_LABELS[id];
  const words = id
    .split("-")
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return "Agent";
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/**
 * Pull --via <agent> out of a CLI argv list.
 * @param {string[]} args
 */
export function splitVia(args) {
  const list = Array.isArray(args) ? [...args] : [];
  const i = list.indexOf("--via");
  if (i === -1) return { via: "", args: list };
  const next = list[i + 1];
  const via = next && !String(next).startsWith("--") ? String(next).trim() : "";
  list.splice(i, via ? 2 : 1);
  return { via, args: list };
}

/**
 * @param {string} path
 * @param {string} id
 */
async function actionIdExists(path, id) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
  const needle = `"id":${JSON.stringify(id)}`;
  return text.split("\n").some((line) => line.includes(needle));
}

/**
 * @param {object} entry
 * @param {{ path?: string }} [opts]
 */
export async function appendAgentAction(entry, opts = {}) {
  const path = opts.path || AGENT_ACTIONS_PATH;
  const agent = String(entry?.agent || "").trim();
  const kind = String(entry?.kind || "").trim();
  const summary = String(entry?.summary || "")
    .replace(/\s+/g, " ")
    .trim();
  const at = entry?.at ? String(entry.at) : new Date().toISOString();
  if (!agent || !kind || !summary) return null;
  if (!isDashboardAction(kind, agent)) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  const id = String(entry?.id || "").trim();
  if (id && (await actionIdExists(path, id))) return null;
  /** @type {Record<string, string>} */
  const row = { at, agent, kind, summary };
  if (id) row.id = id;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

/**
 * @param {object} row
 */
function publicEntry(row) {
  const at = String(row.at || "");
  return {
    at,
    utc: at,
    when: formatPacificTime(at),
    agent: String(row.agent || ""),
    agentName: agentLabel(row.agent),
    kind: String(row.kind || ""),
    summary: String(row.summary || ""),
  };
}

/**
 * @param {string} path
 */
async function readJson(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {object|null} state
 */
export function lightsActionSummary(state) {
  const names = (Array.isArray(state?.turnedOff) ? state.turnedOff : [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
  if (names.length === 1) return `Turned off ${names[0]}`;
  if (names.length > 1) return `Turned off ${names.join(", ")}`;
  return "Turned off Yan's room lights";
}

/**
 * @param {object|null} state
 */
export function vacuumSeedRows(state) {
  /** @type {{ zone: string, at: string, scene: string }[]} */
  const rows = [];
  const zones =
    state?.zones && typeof state.zones === "object" ? state.zones : {};
  for (const [zone, row] of Object.entries(zones)) {
    const at = String(row?.lastStartedAt || "").trim();
    if (!at || Number.isNaN(Date.parse(at))) continue;
    rows.push({
      zone: String(zone || "yan"),
      at,
      scene: String(row?.scene || "vacuum").trim() || "vacuum",
    });
  }
  const at = String(state?.lastStartedAt || "").trim();
  const scene = String(state?.scene || "Vacuum Yan").trim() || "Vacuum Yan";
  if (at && !Number.isNaN(Date.parse(at))) {
    const exists = rows.some((row) => row.at === at && row.scene === scene);
    if (!exists) rows.push({ zone: "yan", at, scene });
  }
  return rows;
}

/**
 * One card for the latest light-off and each recorded vacuum start.
 * @param {{ path?: string, lightsPath?: string, vacuumPath?: string, lights?: object|null, vacuum?: object|null }} [opts]
 */
export async function ensureHomeSeeds(opts = {}) {
  const path = opts.path || AGENT_ACTIONS_PATH;
  const lights =
    opts.lights !== undefined
      ? opts.lights
      : opts.lightsPath
        ? await readJson(opts.lightsPath)
        : null;
  const offAt = String(lights?.lastTurnedOffAt || "").trim();
  if (offAt && !Number.isNaN(Date.parse(offAt))) {
    await appendAgentAction(
      {
        at: offAt,
        agent: "home-agent",
        kind: "lights",
        summary: lightsActionSummary(lights),
        id: `home-agent:lights:${offAt}`,
      },
      { path }
    );
  }
  const vacuum =
    opts.vacuum !== undefined
      ? opts.vacuum
      : opts.vacuumPath
        ? await readJson(opts.vacuumPath)
        : null;
  for (const row of vacuumSeedRows(vacuum)) {
    await appendAgentAction(
      {
        at: row.at,
        agent: "home-agent",
        kind: "vacuum",
        summary: `Started ${row.scene}`,
        id: `home-agent:vacuum:${row.zone}:${row.at}`,
      },
      { path }
    );
  }
}

/**
 * @param {{ path?: string, seed?: boolean, lightsPath?: string, vacuumPath?: string, lights?: object|null, vacuum?: object|null }} [opts]
 */
export async function readAgentActions(opts = {}) {
  const path = opts.path || AGENT_ACTIONS_PATH;
  if (opts.seed !== false) {
    await ensureHomeSeeds({ ...opts, path });
  }
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  /** @type {ReturnType<typeof publicEntry>[]} */
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (!row?.summary || !row?.at) continue;
      if (!isDashboardAction(row.kind, row.agent)) continue;
      entries.push(publicEntry(row));
    } catch {
      /* skip a torn line */
    }
  }
  entries.sort((a, b) => Date.parse(b.utc) - Date.parse(a.utc));
  let mtimeMs = 0;
  let size = 0;
  try {
    const info = await stat(path);
    mtimeMs = info.mtimeMs;
    size = info.size;
  } catch {
    /* no file yet */
  }
  return { entries, mtimeMs, size };
}

/**
 * @param {{ via?: string, cmd?: string, event?: object|null, path?: string }} opts
 */
export async function logCalendarCommand(opts = {}) {
  const via = String(opts.via || "").trim();
  const cmd = String(opts.cmd || "").trim();
  if (!via) return null;
  if (cmd !== "create" && cmd !== "update" && cmd !== "delete") return null;
  const event = opts.event || {};
  const title = String(event.title || "Untitled")
    .replace(/\s+/g, " ")
    .trim();
  const calendar = String(event.calendar || "calendar")
    .replace(/\s+/g, " ")
    .trim();
  const verb = cmd === "create" ? "Added" : cmd === "update" ? "Updated" : "Deleted";
  const idPart = String(event.id || "").trim();
  return appendAgentAction(
    {
      agent: via,
      kind: "calendar",
      summary: `${verb} ${title} on ${calendar}`,
      id: idPart ? `calendar:${via}:${cmd}:${idPart}` : "",
    },
    { path: opts.path }
  );
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return "";
  const value = args[i + 1];
  if (String(value).startsWith("--")) return "";
  return String(value);
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const args = process.argv.slice(2);
  const cmd = args[0] || "";
  const run = async () => {
    if (cmd !== "append") {
      throw new Error(
        "usage: node server/agent-actions.js append --agent <id> --kind <kind> --summary <text>"
      );
    }
    const agent = flagValue(args, "--agent");
    const kind = flagValue(args, "--kind");
    const summary = flagValue(args, "--summary");
    const at = flagValue(args, "--at");
    if (!agent || !kind || !summary) {
      throw new Error("append needs --agent, --kind, and --summary");
    }
    const row = await appendAgentAction({
      agent,
      kind,
      summary,
      at: at || undefined,
    });
    console.log(JSON.stringify({ ok: true, appended: Boolean(row) }));
  };
  run().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
