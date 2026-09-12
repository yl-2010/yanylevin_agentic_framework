/**
 * Short-lived phone signals for the 5-minute life-state log.
 * Written by Yan's Shortcuts (dock, unplug, Driving Focus, Tesla Bluetooth).
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lifeStateDir, lifeStateLogMonthKey } from "./life-state.js";

export const INTENT_FILENAME = "intent.json";
export const SIGNALS_LOG_PREFIX = "signals";
export const SIGNALS_RECENT_MS = 6 * 60 * 60 * 1000;
export const SIGNALS_RECENT_LIMIT = 24;
export const INTENT_KINDS = [
  "going_to_shower",
  "going_to_sleep",
  "plugged_in",
  "unplugged",
  "driving_focus",
  "tesla_bluetooth",
];
export const SHOWER_INTENT_TTL_MS = 60 * 60 * 1000;
export const SLEEP_INTENT_TTL_MS = 8 * 60 * 60 * 1000;
export const PLUGGED_INTENT_TTL_MS = 12 * 60 * 60 * 1000;
export const UNPLUGGED_INTENT_TTL_MS = 45 * 60 * 1000;
export const DRIVING_FOCUS_TTL_MS = 3 * 60 * 60 * 1000;
export const TESLA_BLUETOOTH_TTL_MS = 3 * 60 * 60 * 1000;
export const DRIVING_FOCUS_RESUME_MS = 15 * 60 * 1000;
export const TESLA_BLUETOOTH_RESUME_MS = 10 * 60 * 1000;

const KIND_SET = new Set(INTENT_KINDS);
const ALIAS = {
  shower: "going_to_shower",
  showering: "going_to_shower",
  going_to_shower: "going_to_shower",
  sleep: "going_to_sleep",
  sleeping: "going_to_sleep",
  going_to_bed: "going_to_sleep",
  going_to_sleep: "going_to_sleep",
  plugged: "plugged_in",
  pluggedin: "plugged_in",
  plugged_in: "plugged_in",
  charging: "plugged_in",
  unplug: "unplugged",
  unplugged: "unplugged",
  driving_focus: "driving_focus",
  drivingfocus: "driving_focus",
  tesla: "tesla_bluetooth",
  tesla_bt: "tesla_bluetooth",
  tesla_bluetooth: "tesla_bluetooth",
};

function clip(raw, max) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, max);
}

function intentTtlMs(kind) {
  if (kind === "going_to_sleep") return SLEEP_INTENT_TTL_MS;
  if (kind === "going_to_shower") return SHOWER_INTENT_TTL_MS;
  if (kind === "plugged_in") return PLUGGED_INTENT_TTL_MS;
  if (kind === "unplugged") return UNPLUGGED_INTENT_TTL_MS;
  if (kind === "driving_focus") return DRIVING_FOCUS_TTL_MS;
  if (kind === "tesla_bluetooth") return TESLA_BLUETOOTH_TTL_MS;
  return SHOWER_INTENT_TTL_MS;
}

function resumeWindowMs(kind) {
  if (kind === "driving_focus") return DRIVING_FOCUS_RESUME_MS;
  if (kind === "tesla_bluetooth") return TESLA_BLUETOOTH_RESUME_MS;
  return 0;
}

/**
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseIntentKind(raw) {
  const s = clip(raw, 40).toLowerCase().replace(/-/g, "_");
  if (!s) return null;
  if (KIND_SET.has(s)) return s;
  return ALIAS[s] || null;
}

/**
 * @param {unknown} raw
 * @returns {"portrait"|"landscape"|null}
 */
export function parseOrientation(raw) {
  const s = clip(raw, 24).toLowerCase();
  if (s === "portrait" || s === "vertical") return "portrait";
  if (s === "landscape" || s === "horizontal") return "landscape";
  return null;
}

/**
 * @param {unknown} raw
 * @returns {{ kind: string, orientation: string|null, source: string }|null}
 */
export function parseLifeStateIntent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const orientation = parseOrientation(src.orientation ?? src.deviceOrientation);
  let kind = parseIntentKind(src.intent ?? src.kind ?? src.action);
  if (!kind && orientation === "portrait") kind = "going_to_shower";
  if (!kind && orientation === "landscape") kind = "going_to_sleep";
  if (!kind) return null;
  return {
    kind,
    orientation,
    source: (clip(src.source, 24).toLowerCase() || "shortcut").slice(0, 24),
  };
}

/** @param {string} [override] */
export function lifeStateIntentPath(override) {
  return join(lifeStateDir(override), INTENT_FILENAME);
}

/** @param {string} [dir] @param {string} iso */
export function lifeStateSignalsLogPath(dir, iso) {
  return join(lifeStateDir(dir), `${SIGNALS_LOG_PREFIX}-${lifeStateLogMonthKey(iso)}.jsonl`);
}

/**
 * @param {unknown} raw
 */
export function normalizeIntentStore(raw) {
  if (!raw || typeof raw !== "object") return { latest: null, byKind: {} };
  const src = /** @type {Record<string, unknown>} */ (raw);
  if (src.byKind && typeof src.byKind === "object") {
    return {
      latest: src.latest && typeof src.latest === "object" ? src.latest : null,
      byKind: /** @type {Record<string, object>} */ ({ ...src.byKind }),
    };
  }
  if (src.kind) {
    return { latest: src, byKind: { [String(src.kind)]: src } };
  }
  return { latest: null, byKind: {} };
}

/**
 * @param {{ latest: object|null, byKind: Record<string, object> }} store
 * @param {{ kind: string, orientation: string|null, source: string }} parsed
 * @param {Date} now
 */
export function applyIntentToStore(store, parsed, now) {
  const at = now.toISOString();
  /** @type {Record<string, unknown>} */
  const rec = {
    kind: parsed.kind,
    source: parsed.source,
    at,
  };
  if (parsed.orientation) rec.orientation = parsed.orientation;

  const byKind = { ...store.byKind };
  if (parsed.kind === "unplugged") {
    delete byKind.plugged_in;
  }
  if (
    parsed.kind === "plugged_in" ||
    parsed.kind === "going_to_shower" ||
    parsed.kind === "going_to_sleep"
  ) {
    delete byKind.unplugged;
  }

  const windowMs = resumeWindowMs(parsed.kind);
  if (windowMs) {
    const prev = byKind[parsed.kind];
    const prevLast = Date.parse(String(prev?.lastAt || prev?.at || ""));
    if (prev && Number.isFinite(prevLast) && now.getTime() - prevLast < windowMs) {
      rec.since = prev.since || prev.at;
      rec.lastAt = at;
      rec.resumed = true;
    } else {
      rec.since = at;
      rec.lastAt = at;
      rec.resumed = false;
    }
  }

  byKind[parsed.kind] = rec;
  return { latest: rec, byKind };
}

/**
 * @param {unknown} raw
 * @param {{ dir?: string, now?: Date }} [opts]
 */
export async function writeLifeStateIntent(raw, opts = {}) {
  const parsed = parseLifeStateIntent(raw);
  if (!parsed) {
    const err = new Error("intent kind required");
    err.status = 400;
    throw err;
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const dir = lifeStateDir(opts.dir);
  await mkdir(dir, { recursive: true });
  let existing = { latest: null, byKind: {} };
  try {
    existing = normalizeIntentStore(
      JSON.parse(await readFile(join(dir, INTENT_FILENAME), "utf8"))
    );
  } catch {
    /* first write */
  }
  const out = applyIntentToStore(existing, parsed, now);
  await writeFile(join(dir, INTENT_FILENAME), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  try {
    await appendFile(
      lifeStateSignalsLogPath(opts.dir, out.latest.at),
      `${JSON.stringify(out.latest)}\n`,
      "utf8"
    );
  } catch (err) {
    console.error("[life-state-intent] signals log", err);
  }
  return out.latest;
}

/**
 * Latest slim signal, or null.
 * @param {string} [dir]
 * @param {Date} [now]
 */
export async function readLifeStateIntent(dir, now = new Date()) {
  const store = await readLifeStateStore(dir, now);
  return store.latest;
}

/**
 * @param {string} [dir]
 */
export async function readLifeStateRaw(dir) {
  try {
    return JSON.parse(await readFile(lifeStateIntentPath(dir), "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} [dir]
 * @param {Date} [now]
 */
export async function readLifeStateStore(dir, now = new Date()) {
  let raw;
  try {
    raw = JSON.parse(await readFile(lifeStateIntentPath(dir), "utf8"));
  } catch {
    return { latest: null, signals: {} };
  }
  return slimLifeStateStore(raw, now);
}

function signalsMonthKeys(now) {
  const iso = now.toISOString();
  const d = new Date(now.getTime());
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return [lifeStateLogMonthKey(iso), lifeStateLogMonthKey(prev.toISOString())];
}

/**
 * Append-only automation sends. The 5-minute tick reads these. POSTs do not start a tick.
 * @param {string} [dir]
 * @param {Date} [now]
 * @param {{ sinceMs?: number, limit?: number }} [opts]
 */
export async function readRecentLifeStateSignals(dir, now = new Date(), opts = {}) {
  const sinceMs = Number.isFinite(opts.sinceMs)
    ? opts.sinceMs
    : now.getTime() - SIGNALS_RECENT_MS;
  const limit = Number.isFinite(opts.limit) ? opts.limit : SIGNALS_RECENT_LIMIT;
  /** @type {object[]} */
  const rows = [];
  for (const month of signalsMonthKeys(now)) {
    let text = "";
    try {
      text = await readFile(
        join(lifeStateDir(dir), `${SIGNALS_LOG_PREFIX}-${month}.jsonl`),
        "utf8"
      );
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        const at = Date.parse(String(rec?.at || rec?.lastAt || ""));
        if (!Number.isFinite(at) || at < sinceMs) continue;
        const kind = parseIntentKind(rec.kind ?? rec.intent);
        if (!kind) continue;
        const orientation = parseOrientation(rec.orientation);
        /** @type {Record<string, unknown>} */
        const row = {
          kind,
          at: new Date(at).toISOString(),
          source: clip(rec.source, 24) || "shortcut",
        };
        if (orientation) row.orientation = orientation;
        if (rec.resumed === true) row.resumed = true;
        rows.push(row);
      } catch {
        /* skip bad line */
      }
    }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return rows.slice(-limit);
}

/**
 * @param {unknown} raw
 * @param {Date} [now]
 */
export function slimLifeStateStore(raw, now = new Date()) {
  const store = normalizeIntentStore(raw);
  /** @type {Record<string, object>} */
  const signals = {};
  for (const rec of Object.values(store.byKind)) {
    const slim = slimLifeStateIntent(rec, now);
    if (slim) signals[slim.kind] = slim;
  }
  return {
    latest: slimLifeStateIntent(store.latest, now),
    signals,
  };
}

/**
 * @param {unknown} raw
 * @param {Date} [now]
 */
export function slimLifeStateIntent(raw, now = new Date()) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const kind = parseIntentKind(src.kind ?? src.intent);
  if (!kind) return null;
  const at = clip(src.lastAt || src.at, 40);
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const ageMs = Math.max(0, now.getTime() - ms);
  if (ageMs > intentTtlMs(kind)) return null;
  const sinceRaw = clip(src.since, 40);
  const sinceMs = Date.parse(sinceRaw);
  /** @type {Record<string, unknown>} */
  const out = {
    kind,
    source: clip(src.source, 24) || "shortcut",
    at: new Date(ms).toISOString(),
    ageMinutes: Math.round(ageMs / 60_000),
  };
  const orientation = parseOrientation(src.orientation);
  if (orientation) out.orientation = orientation;
  if (Number.isFinite(sinceMs)) {
    out.since = new Date(sinceMs).toISOString();
    out.tripMinutes = Math.round((now.getTime() - sinceMs) / 60_000);
  }
  if (src.resumed === true) out.resumed = true;
  return out;
}
