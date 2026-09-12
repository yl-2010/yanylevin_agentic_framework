/**
 * Short-lived phone-dock intents for the 5-minute life-state log.
 * Written by Yan's "phone plugged in" Shortcut. Yan only.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { lifeStateDir } from "./life-state.js";

export const INTENT_FILENAME = "intent.json";
export const INTENT_KINDS = ["going_to_shower", "going_to_sleep"];
export const SHOWER_INTENT_TTL_MS = 60 * 60 * 1000;
export const SLEEP_INTENT_TTL_MS = 8 * 60 * 60 * 1000;

const KIND_SET = new Set(INTENT_KINDS);

function clip(raw, max) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, max);
}

function intentTtlMs(kind) {
  return kind === "going_to_sleep" ? SLEEP_INTENT_TTL_MS : SHOWER_INTENT_TTL_MS;
}

/**
 * @param {unknown} raw
 * @returns {"going_to_shower"|"going_to_sleep"|null}
 */
export function parseIntentKind(raw) {
  const s = clip(raw, 40).toLowerCase().replace(/-/g, "_");
  if (KIND_SET.has(s)) return /** @type {"going_to_shower"|"going_to_sleep"} */ (s);
  if (s === "shower" || s === "showering" || s === "going_to_shower") {
    return "going_to_shower";
  }
  if (s === "sleep" || s === "sleeping" || s === "going_to_bed" || s === "going_to_sleep") {
    return "going_to_sleep";
  }
  return null;
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
  const source = clip(src.source, 24).toLowerCase() || "shortcut";
  return {
    kind,
    orientation: orientation || (kind === "going_to_shower" ? "portrait" : "landscape"),
    source: source.slice(0, 24),
  };
}

/** @param {string} [override] */
export function lifeStateIntentPath(override) {
  return join(lifeStateDir(override), INTENT_FILENAME);
}

/**
 * @param {unknown} raw
 * @param {{ dir?: string, now?: Date }} [opts]
 */
export async function writeLifeStateIntent(raw, opts = {}) {
  const parsed = parseLifeStateIntent(raw);
  if (!parsed) {
    const err = new Error("intent going_to_shower or going_to_sleep required");
    err.status = 400;
    throw err;
  }
  const now = opts.now instanceof Date ? opts.now : new Date();
  const out = {
    kind: parsed.kind,
    orientation: parsed.orientation,
    source: parsed.source,
    at: now.toISOString(),
  };
  const dir = lifeStateDir(opts.dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, INTENT_FILENAME), `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

/**
 * Fresh dock intent, or null if missing/stale.
 * @param {string} [dir]
 * @param {Date} [now]
 */
export async function readLifeStateIntent(dir, now = new Date()) {
  let raw;
  try {
    raw = JSON.parse(await readFile(lifeStateIntentPath(dir), "utf8"));
  } catch {
    return null;
  }
  return slimLifeStateIntent(raw, now);
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
  const at = clip(src.at, 40);
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return null;
  const ageMs = Math.max(0, now.getTime() - ms);
  if (ageMs > intentTtlMs(kind)) return null;
  return {
    kind,
    orientation: parseOrientation(src.orientation) || null,
    source: clip(src.source, 24) || "shortcut",
    at: new Date(ms).toISOString(),
    ageMinutes: Math.round(ageMs / 60_000),
  };
}
