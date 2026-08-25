/**
 * Last-known iPhone location for Yan's Personal Agent (web + iOS + Cursor).
 * Written by the iOS app (or an iPhone Shortcut) via POST /api/education/location.
 * iPhone Always: significant-change, visits, and a 15-minute `periodic` heartbeat.
 * Stored as education/<email>/.location.json plus
 * education/<email>/location/ (append-only JSONL + composed stays/trips).
 */

import { timingSafeEqual } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

export const LOCATION_REL = `education/${YAN_EMAIL}/.location.json`;
export const LOCATION_HISTORY_DIRNAME = "location";
export const LOCATION_HISTORY_REL = `education/${YAN_EMAIL}/${LOCATION_HISTORY_DIRNAME}`;
export const HISTORY_DEDUPE_MS = 60_000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PLACE = 120;
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** @param {string|null|undefined} email */
export function isYanLocationUser(email) {
  return canonicalizeEmail(email) === YAN_EMAIL;
}

/** @param {string} [override] */
export function phoneLocationPath(override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  const env = String(process.env.PHONE_LOCATION_PATH || "").trim();
  return env || join(ROOT, LOCATION_REL);
}

/** @param {string} [override] */
export function locationHistoryDir(override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  const env = String(process.env.PHONE_LOCATION_HISTORY_DIR || "").trim();
  return env || join(ROOT, LOCATION_HISTORY_REL);
}

/**
 * @param {{ path?: string, historyDir?: string }} [opts]
 */
function historyDirForWrite(opts = {}) {
  const explicit = String(opts.historyDir || "").trim();
  if (explicit) return explicit;
  const locPath = String(opts.path || "").trim();
  if (locPath) return join(dirname(locPath), LOCATION_HISTORY_DIRNAME);
  return locationHistoryDir();
}

/** @param {string} iso */
export function locationLogMonthKey(iso) {
  const ms = Date.parse(iso);
  const d = Number.isFinite(ms) ? new Date(ms) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** @param {string} dir @param {string} monthKey */
export function locationLogPath(dir, monthKey) {
  return join(dir, `log-${monthKey}.jsonl`);
}

/**
 * @param {unknown} raw
 * @returns {string}
 */
function clipStr(raw, max = MAX_PLACE) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, max);
}

/**
 * @param {unknown} raw
 * @returns {number|null}
 */
function finiteNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseLocationPayload(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const latitude = finiteNumber(src.latitude);
  const longitude = finiteNumber(src.longitude);
  if (latitude == null || longitude == null) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return null;
  }

  /** @type {Record<string, unknown>} */
  const out = {
    latitude: Math.round(latitude * 1e6) / 1e6,
    longitude: Math.round(longitude * 1e6) / 1e6,
  };

  const accuracy = finiteNumber(src.accuracyMeters ?? src.accuracy);
  if (accuracy != null && accuracy >= 0 && accuracy < 50_000) {
    out.accuracyMeters = Math.round(accuracy);
  }

  const ts = clipStr(src.timestamp, 40);
  if (ts && !Number.isNaN(Date.parse(ts))) out.timestamp = new Date(ts).toISOString();

  const receivedAt = clipStr(src.receivedAt, 40);
  if (receivedAt && !Number.isNaN(Date.parse(receivedAt))) {
    out.receivedAt = new Date(receivedAt).toISOString();
  }

  const source = clipStr(src.source, 24).toLowerCase();
  if (
    source === "ios" ||
    source === "shortcut" ||
    source === "ui" ||
    source === "visit" ||
    source === "periodic"
  ) {
    out.source = source;
  }

  const speed = finiteNumber(src.speedMps ?? src.speed);
  if (speed != null && speed >= 0 && speed < 500) {
    out.speedMps = Math.round(speed * 100) / 100;
  }

  const course = finiteNumber(src.courseDegrees ?? src.course);
  if (course != null && course >= 0 && course <= 360) {
    out.courseDegrees = Math.round(course * 10) / 10;
  }

  const altitude = finiteNumber(src.altitudeMeters ?? src.altitude);
  if (altitude != null && altitude > -500 && altitude < 20_000) {
    out.altitudeMeters = Math.round(altitude);
  }

  const visitKind = clipStr(src.visitKind, 24).toLowerCase();
  if (visitKind === "arrival" || visitKind === "departure") {
    out.visitKind = visitKind;
  }

  const placeName = clipStr(src.placeName ?? src.name);
  const locality = clipStr(src.locality);
  const subLocality = clipStr(src.subLocality);
  const administrativeArea = clipStr(src.administrativeArea, 40);
  const postalCode = clipStr(src.postalCode, 20);
  const country = clipStr(src.country, 40);
  const areas = Array.isArray(src.areasOfInterest)
    ? src.areasOfInterest.map((x) => clipStr(x, 80)).filter(Boolean).slice(0, 6)
    : [];

  if (placeName) out.placeName = placeName;
  if (locality) out.locality = locality;
  if (subLocality) out.subLocality = subLocality;
  if (administrativeArea) out.administrativeArea = administrativeArea;
  if (postalCode) out.postalCode = postalCode;
  if (country) out.country = country;
  if (areas.length) out.areasOfInterest = areas;

  return out;
}

/**
 * @param {unknown} raw
 * @param {{ source?: string, path?: string, historyDir?: string }} [opts]
 */
export async function writePhoneLocation(raw, opts = {}) {
  const parsed = parseLocationPayload(raw);
  if (!parsed) {
    const err = new Error("latitude and longitude required");
    err.status = 400;
    throw err;
  }
  if (opts.source && !parsed.source) parsed.source = opts.source;
  parsed.receivedAt = new Date().toISOString();
  const file = phoneLocationPath(opts.path);
  await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  try {
    await appendLocationHistory(parsed, { historyDir: historyDirForWrite(opts) });
  } catch (err) {
    console.error("[phone-location] history append", err);
  }
  return parsed;
}

/**
 * Same rounded lat/lng and GPS timestamp within ~60s.
 * @param {Record<string, unknown>|null|undefined} a
 * @param {Record<string, unknown>|null|undefined} b
 * @param {number} [windowMs]
 */
export function isNearDuplicateLocation(a, b, windowMs = HISTORY_DEDUPE_MS) {
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a.latitude !== b.latitude || a.longitude !== b.longitude) return false;
  const ta = Date.parse(String(a.timestamp || a.receivedAt || ""));
  const tb = Date.parse(String(b.timestamp || b.receivedAt || ""));
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(ta - tb) < windowMs;
}

/** @param {string} dir */
export async function listLocationLogFiles(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^log-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
}

/** @param {string} file */
async function readLastJsonlObject(file) {
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  try {
    const parsed = JSON.parse(lines[lines.length - 1]);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {string} [dir] */
export async function readLastHistoryEntry(dir) {
  const root = locationHistoryDir(dir);
  const files = await listLocationLogFiles(root);
  for (let i = files.length - 1; i >= 0; i--) {
    const last = await readLastJsonlObject(join(root, files[i]));
    if (last) return last;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {{ historyDir?: string }} [opts]
 * @returns {Promise<boolean>} true if a line was appended
 */
export async function appendLocationHistory(parsed, opts = {}) {
  const loc = parseLocationPayload(parsed);
  if (!loc) return false;
  const dir = locationHistoryDir(opts.historyDir);
  await mkdir(dir, { recursive: true });
  const prev = await readLastHistoryEntry(dir);
  if (isNearDuplicateLocation(prev, loc)) return false;
  const month = locationLogMonthKey(String(loc.receivedAt || loc.timestamp || ""));
  const file = locationLogPath(dir, month);
  await appendFile(file, `${JSON.stringify(loc)}\n`, "utf8");
  return true;
}

/** @param {string} [dir] */
export async function readLocationHistoryState(dir) {
  const file = join(locationHistoryDir(dir), "state.json");
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** @param {string} [dir] */
export async function hasUnprocessedLocationPoints(dir) {
  const last = await readLastHistoryEntry(dir);
  const latest = String(last?.receivedAt || last?.timestamp || "").trim();
  if (!latest || Number.isNaN(Date.parse(latest))) return false;
  const state = await readLocationHistoryState(dir);
  const cursor = String(state?.lastProcessedReceivedAt || "").trim();
  if (!cursor || Number.isNaN(Date.parse(cursor))) return true;
  return Date.parse(latest) > Date.parse(cursor);
}

/** @param {string} [path] */
export async function readPhoneLocation(path) {
  try {
    const raw = JSON.parse(await readFile(phoneLocationPath(path), "utf8"));
    return parseLocationPayload(raw);
  } catch {
    return null;
  }
}

/**
 * Prefer a location object already on this turn (iOS uiContext), else disk.
 * @param {string} email
 * @param {Record<string, unknown>|null|undefined} uiContext
 */
export async function resolvePhoneLocation(email, uiContext) {
  if (!isYanLocationUser(email)) return null;
  const fromUi = parseLocationPayload(uiContext?.phoneLocation);
  if (fromUi) {
    writePhoneLocation(fromUi, { source: fromUi.source || "ui" }).catch((err) => {
      console.error("[phone-location] persist ui", err);
    });
    return fromUi;
  }
  return readPhoneLocation();
}

function ageLabel(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours === 1) return "1 hour ago";
  if (hours < 48) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function placeLabel(loc) {
  const bits = [];
  if (Array.isArray(loc.areasOfInterest) && loc.areasOfInterest[0]) {
    bits.push(String(loc.areasOfInterest[0]));
  }
  if (loc.placeName && loc.placeName !== loc.locality) bits.push(String(loc.placeName));
  if (loc.subLocality) bits.push(String(loc.subLocality));
  if (loc.locality) bits.push(String(loc.locality));
  if (loc.administrativeArea) bits.push(String(loc.administrativeArea));
  const seen = new Set();
  return bits.filter((b) => {
    const k = b.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).join(", ");
}

/**
 * One Live-context line, or null when there is no fix.
 * @param {Record<string, unknown>|null|undefined} loc
 */
export function formatPhoneLocationLine(loc) {
  const parsed = parseLocationPayload(loc);
  if (!parsed) return null;
  const whenIso = String(parsed.timestamp || parsed.receivedAt || "");
  const when = whenIso && !Number.isNaN(Date.parse(whenIso)) ? ageLabel(whenIso) : "time unknown";
  const stale =
    whenIso && Date.now() - Date.parse(whenIso) > STALE_AFTER_MS ? " stale" : "";
  const place = placeLabel(parsed);
  const acc =
    typeof parsed.accuracyMeters === "number" ? `, ±${parsed.accuracyMeters} m` : "";
  const coords = `${parsed.latitude}, ${parsed.longitude}`;
  const head = place ? `${place} (${coords})` : coords;
  return `Phone location: ${head}${acc}, ${when}${stale}.`;
}

/**
 * Constant-time compare for the optional Shortcut ingest token.
 * @param {string|null|undefined} provided
 */
export function ingestTokenMatches(provided) {
  const expected = String(process.env.LOCATION_INGEST_TOKEN || "").trim();
  const got = String(provided || "").trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
