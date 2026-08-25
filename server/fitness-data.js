/**
 * File-backed gym / fitness tracker.
 * Roots: fitness/<email>/ under the repo.
 *
 * Session = Pacific calendar date of each entry's `at` timestamp.
 * Fresh entries stay pending (excluded from recent boxes / history charts)
 * until they are at least PENDING_SOLIDIFY_MS old, then they solidify into history.
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { gitAddCommitPush } from "./git-publish.js";
import {
  canonicalizeEmail,
  isFullAccessEmail,
  FULL_ACCESS_EMAILS,
} from "./identity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const FITNESS_ROOT = join(ROOT, "fitness");
export const FITNESS_TZ = "America/Los_Angeles";
/** How long new logs stay as floating "pending" chips before joining charts. */
export const PENDING_SOLIDIFY_MS = 2 * 60 * 60 * 1000;

/** Fallback swatches when machine.json has no valid color (index % length). */
const FALLBACK_MACHINE_COLORS = [
  "#1b7d8a",
  "#c45c26",
  "#3d6b3d",
  "#8b4d9a",
  "#b8860b",
  "#2f5d9f",
  "#a63d4a",
  "#5a6a7a",
];

/**
 * Normalize to lowercase #rrggbb, or null if invalid.
 * @param {unknown} raw
 */
export function normalizeMachineColor(raw) {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  if (s[0] !== "#") s = `#${s}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

export { FULL_ACCESS_EMAILS };

/** @param {string|null|undefined} email */
export function isFitnessUser(email) {
  return isFullAccessEmail(email);
}

/** @param {string} email */
export function userFitnessRoot(email) {
  const normalized = canonicalizeEmail(email);
  if (!isFitnessUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  if (
    normalized.includes("..") ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    const err = new Error("invalid email");
    err.status = 400;
    throw err;
  }
  return join(FITNESS_ROOT, normalized);
}

/**
 * YYYY-MM-DD in America/Los_Angeles.
 * @param {Date|string|number} [when]
 */
export function pacificDateKey(when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  if (Number.isNaN(d.getTime())) {
    return pacificDateKey(new Date());
  }
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FITNESS_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err instanceof SyntaxError)) return null;
    throw err;
  }
}

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, weight: number, at: string }[]}
 */
function normalizeEntries(raw) {
  const list = Array.isArray(raw?.entries)
    ? raw.entries
    : Array.isArray(raw)
      ? raw
      : [];
  /** @type {{ id: string, weight: number, at: string }[]} */
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const weight = Number(/** @type {{ weight?: unknown }} */ (item).weight);
    if (!Number.isFinite(weight)) continue;
    const atRaw = String(/** @type {{ at?: unknown }} */ (item).at || "").trim();
    const atDate = atRaw ? new Date(atRaw) : null;
    if (!atDate || Number.isNaN(atDate.getTime())) continue;
    const id = String(/** @type {{ id?: unknown }} */ (item).id || "").trim() || randomUUID();
    out.push({ id, weight, at: atDate.toISOString() });
  }
  out.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return out;
}

/**
 * Pending = logged within the last PENDING_SOLIDIFY_MS; older entries are history.
 * @param {{ id: string, weight: number, at: string }[]} entries
 * @param {Date|number} [now]
 */
function partitionEntries(entries, now = new Date()) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const cutoff = nowMs - PENDING_SOLIDIFY_MS;
  /** @type {{ id: string, weight: number, at: string, dateKey: string }[]} */
  const enriched = entries.map((e) => ({
    ...e,
    dateKey: pacificDateKey(e.at),
  }));
  const history = enriched.filter((e) => new Date(e.at).getTime() <= cutoff);
  const pending = enriched.filter((e) => new Date(e.at).getTime() > cutoff);
  return { history, pending };
}

/**
 * @param {{ id: string, weight: number, at: string, dateKey: string }[]} history
 */
function lastSession(history) {
  if (!history.length) return null;
  const lastKey = history[history.length - 1].dateKey;
  const session = history.filter((e) => e.dateKey === lastKey);
  const weights = session.map((e) => e.weight);
  const min = Math.min(...weights);
  return { dateKey: lastKey, entries: session, min };
}

/**
 * @param {{ id: string, weight: number, at: string, dateKey: string }[]} history
 * @param {string|null} lastSessionKey
 */
function recentBoxes(history, lastSessionKey) {
  const last3 = history.slice(-3);
  // Display left→right: 3rd recent, 2nd most recent, previous (newest)
  while (last3.length < 3) last3.unshift(null);
  return last3.map((e) => {
    if (!e) return null;
    const fromLastSession = Boolean(lastSessionKey && e.dateKey === lastSessionKey);
    return {
      id: e.id,
      weight: e.weight,
      at: e.at,
      dateKey: e.dateKey,
      fromLastSession,
      /** lighter when last session; darker when older */
      tone: fromLastSession ? "recent" : "older",
    };
  });
}

/** @param {{ id: string, weight: number, at: string, dateKey: string }} e */
function pointPayload(e) {
  return {
    id: e.id,
    weight: e.weight,
    at: e.at,
    dateKey: e.dateKey,
  };
}

/**
 * @param {string} email
 */
export async function readFitnessTree(email) {
  const normalized = canonicalizeEmail(email);
  const root = userFitnessRoot(normalized);
  const todayKey = pacificDateKey();
  const meta = (await readJsonFile(join(root, "meta.json"))) || {
    email: normalized,
    displayName: normalized.split("@")[0],
    timezone: FITNESS_TZ,
  };

  const machineIds = await listDirs(join(root, "machines"));
  /** @type {any[]} */
  const machines = [];

  for (const id of machineIds) {
    if (id.startsWith(".") || id.startsWith("_")) continue;
    const machineDir = join(root, "machines", id);
    const props =
      (await readJsonFile(join(machineDir, "machine.json"))) || {
        id,
        name: id,
        order: 999,
      };
    const entries = normalizeEntries(
      await readJsonFile(join(machineDir, "entries.json"))
    );
    const { history, pending } = partitionEntries(entries);
    const session = lastSession(history);
    const allTimeMax =
      history.length > 0 ? Math.max(...history.map((e) => e.weight)) : null;
    /** Full past history for web charts; iOS still uses last-10 `graph`. */
    const historyPoints = history.map(pointPayload);
    const graph = historyPoints.slice(-10);
    const recent = recentBoxes(history, session?.dateKey || null);

    const color =
      normalizeMachineColor(props.color) ||
      FALLBACK_MACHINE_COLORS[machines.length % FALLBACK_MACHINE_COLORS.length];

    machines.push({
      id: String(props.id || id),
      name: String(props.name || id),
      order: Number.isFinite(Number(props.order)) ? Number(props.order) : 999,
      color,
      allTimeMax,
      recent,
      graph,
      history: historyPoints,
      sessionMin: session ? session.min : null,
      lastSessionDate: session ? session.dateKey : null,
      pending: pending.map((e) => ({
        id: e.id,
        weight: e.weight,
        at: e.at,
        dateKey: e.dateKey,
      })),
      entryCount: entries.length,
      historyCount: history.length,
    });
  }

  machines.sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return String(a.name).localeCompare(String(b.name));
  });

  return {
    email: normalized,
    todayKey,
    timezone: FITNESS_TZ,
    meta,
    machines,
  };
}

/**
 * Append one or more weights to a machine (timestamped now unless `at` given).
 * @param {string} email
 * @param {string} machineId
 * @param {number[]} weights
 * @param {{ at?: string|Date, publish?: boolean }} [opts]
 */
export async function appendFitnessEntries(email, machineId, weights, opts = {}) {
  const normalized = canonicalizeEmail(email);
  const mid = String(machineId || "").trim();
  if (!mid) {
    const err = new Error("machineId required");
    err.status = 400;
    throw err;
  }
  const nums = (Array.isArray(weights) ? weights : [weights])
    .map((w) => Number(w))
    .filter((w) => Number.isFinite(w));
  if (!nums.length) {
    const err = new Error("weights required");
    err.status = 400;
    throw err;
  }

  const root = userFitnessRoot(normalized);
  const machineDir = join(root, "machines", mid);
  const propsPath = join(machineDir, "machine.json");
  const entriesPath = join(machineDir, "entries.json");

  let props = await readJsonFile(propsPath);
  if (!props) {
    const err = new Error("machine not found");
    err.status = 404;
    throw err;
  }

  const existing = normalizeEntries(await readJsonFile(entriesPath));
  const baseAt = opts.at ? new Date(opts.at) : new Date();
  if (Number.isNaN(baseAt.getTime())) {
    const err = new Error("invalid at");
    err.status = 400;
    throw err;
  }

  /** @type {{ id: string, weight: number, at: string }[]} */
  const created = [];
  for (let i = 0; i < nums.length; i++) {
    // Space multi-entry batches by 1ms so sort order is stable.
    const at = new Date(baseAt.getTime() + i).toISOString();
    const entry = { id: randomUUID(), weight: nums[i], at };
    existing.push(entry);
    created.push(entry);
  }
  existing.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  await mkdir(machineDir, { recursive: true });
  await writeFile(
    entriesPath,
    JSON.stringify({ entries: existing }, null, 2) + "\n",
    "utf8"
  );

  if (opts.publish !== false) {
    gitAddCommitPush({
      paths: [`fitness/${normalized}`],
      message: `fitness: add ${nums.length} entr${nums.length === 1 ? "y" : "ies"} on ${mid} for ${normalized}`,
    }).catch((err) => console.error("[fitness-data] git publish", err));
  }

  return { machineId: mid, created, tree: await readFitnessTree(normalized) };
}

/**
 * Ensure user fitness root + meta exist (for new authorized users).
 * @param {string} email
 */
export async function ensureFitnessUser(email) {
  const normalized = canonicalizeEmail(email);
  const root = userFitnessRoot(normalized);
  await mkdir(join(root, "machines"), { recursive: true });
  const metaPath = join(root, "meta.json");
  const existing = await readJsonFile(metaPath);
  if (!existing) {
    await writeFile(
      metaPath,
      JSON.stringify(
        {
          email: normalized,
          displayName: normalized.split("@")[0],
          timezone: FITNESS_TZ,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
  }
  return root;
}
