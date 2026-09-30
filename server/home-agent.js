/**
 * Hourly home check. Turns off lights in Yan's Bedroom and Yan's Office
 * when the phone pin is fresh and clearly away. Composer 2.5 only when a
 * vacuum might be due. Yan's scene is immediate. Sunny and master warn
 * the family chat, then a second Composer pass 15 minutes later.
 * Local Cursor SDK one-shot. Yan only.
 * Does not run on server boot. Does not git-commit.
 */

import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { briefingNow, resolveBriefingTimezone } from "./daily-briefing-agent.js";
import { isSchoolDayParts, scheduleNowParts } from "./education-data.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { runHome } from "./home-cli.js";
import { readCurrentLifeState } from "./life-state.js";
import { haversineMeters, homeBooleanKind, KNOWN_PLACES } from "./life-state-snapshot.js";
import { readPhoneLocation, YAN_EMAIL } from "./phone-location.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-home-agent.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const TZ = "America/Los_Angeles";

export const HOME_AGENT_INTERVAL_MS = 60 * 60 * 1000;
export const VACUUM_DUE_MS = 72 * 60 * 60 * 1000;
export const FAMILY_VACUUM_DUE_MS = 7 * 24 * 60 * 60 * 1000;
export const VACUUM_WARN_LEAD_MS = 15 * 60 * 1000;
export const VACUUM_CONFIRM_GRACE_MS = 20 * 60 * 1000;
export const VACUUM_SCENE = "Vacuum Yan";
export const SUNNY_VACUUM_SCENE = "Roomba Sunny Boy Landing Laundry Room";
export const MASTER_VACUUM_SCENE = "Roomba Master Rooms";
export const VACUUM_SCENE_FORBIDDEN = "Vacuum Yan's Rooms";
export const FAMILY_VACUUM_CHAT = "Levin-Saha Family";
export const VACUUM_ZONE_SPECS = {
  yan: {
    id: "yan",
    scene: VACUUM_SCENE,
    dueMs: VACUUM_DUE_MS,
    family: false,
    area: "",
  },
  sunny: {
    id: "sunny",
    scene: SUNNY_VACUUM_SCENE,
    dueMs: FAMILY_VACUUM_DUE_MS,
    family: true,
    area: "Sunny's room, the landing, and the laundry room",
  },
  master: {
    id: "master",
    scene: MASTER_VACUUM_SCENE,
    dueMs: FAMILY_VACUUM_DUE_MS,
    family: true,
    area: "the master rooms",
  },
};
const VACUUM_ZONE_IDS = ["yan", "sunny", "master"];
/** Silence longer than this means he may already be home. */
export const LIGHTS_LOCATION_FRESH_MS = 20 * 60 * 1000;
/** Fast drive used only to ask whether he could have reached the house. */
const LIGHTS_FAST_MPS = 25;
/** A recent life-state sample at the house blocks a lights-off. */
export const LIGHTS_LIFE_STATE_FRESH_MS = 30 * 60 * 1000;
const YAN_LIGHT_ROOMS = new Set(["yan's bedroom", "yan's office"]);
const LOCK_STALE_MS = 15 * 60 * 1000;

const HOME_PLACE = KNOWN_PLACES.find((p) => p.slug === "kirkland-home");

export const HOME_AGENT_MODEL_SPEC = {
  id: process.env.CURSOR_HOME_AGENT_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let confirmTimer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "home-agent",
  run: () => runHomeAgent({ force: true }),
});

/**
 * @param {string} [root]
 */
export function vacuumStatePath(root = REPO_ROOT) {
  return join(root, "education", YAN_EMAIL, "home", "vacuum.json");
}

/**
 * @param {string} [root]
 */
export function lightsStatePath(root = REPO_ROOT) {
  return join(root, "education", YAN_EMAIL, "home", "lights.json");
}

/**
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
 */
function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

export function homeAgentModelSpec() {
  return modelSelection(HOME_AGENT_MODEL_SPEC);
}

/**
 * Wait until the next Pacific clock hour. On the hour, wait a full hour.
 * @param {number} [nowMs]
 * @param {string} [timeZone]
 */
export function msUntilNextHomeAgentTick(nowMs = Date.now(), timeZone = TZ) {
  const n = Number(nowMs);
  const t = Number.isFinite(n) ? n : Date.now();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(new Date(t))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const minute = Number(parts.minute) || 0;
  const second = Number(parts.second) || 0;
  const into = (minute * 60 + second) * 1000 + (t % 1000);
  if (into === 0) return HOME_AGENT_INTERVAL_MS;
  return HOME_AGENT_INTERVAL_MS - into;
}

/**
 * Due at exactly `dueMs`. A missing start is due.
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 * @param {number} [dueMs]
 */
export function vacuumIsDue(iso, nowMs, dueMs = VACUUM_DUE_MS) {
  if (!iso) return true;
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return true;
  return nowMs - started >= dueMs;
}

/**
 * @param {string} raw
 */
function hmToMinutes(raw) {
  const m = String(raw || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * First bell through last bell, from schedule.json bells.
 * @param {object|null|undefined} schedule
 * @returns {{ startMin: number, endMin: number }|null}
 */
export function bellWindowMinutes(schedule) {
  const bells = Array.isArray(schedule?.bells) ? schedule.bells : [];
  let startMin = null;
  let endMin = null;
  for (const bell of bells) {
    const start = hmToMinutes(bell?.start);
    const end = hmToMinutes(bell?.end);
    if (start == null || end == null) continue;
    if (startMin == null || start < startMin) startMin = start;
    if (endMin == null || end > endMin) endMin = end;
  }
  if (startMin == null || endMin == null || endMin <= startMin) return null;
  return { startMin, endMin };
}

/**
 * School day and the Pacific clock is inside the bells. The end minute is out.
 * @param {number} nowMs
 * @param {object|null|undefined} schedule
 * @param {string} [timeZone]
 */
export function schoolInSessionAt(nowMs, schedule, timeZone = TZ) {
  if (!schedule || !Number.isFinite(nowMs)) return false;
  const clock = scheduleNowParts({ timezone: timeZone }, new Date(nowMs));
  if (!isSchoolDayParts(clock, schedule)) return false;
  const window = bellWindowMinutes(schedule);
  if (!window) return false;
  return clock.minutes >= window.startMin && clock.minutes < window.endMin;
}

/**
 * A family warning needs the start, 15 minutes later, to still fall in session.
 * @param {number} nowMs
 * @param {object|null|undefined} schedule
 * @param {string} [timeZone]
 */
export function familyWarnWindowOpen(nowMs, schedule, timeZone = TZ) {
  return (
    schoolInSessionAt(nowMs, schedule, timeZone) &&
    schoolInSessionAt(nowMs + VACUUM_WARN_LEAD_MS, schedule, timeZone)
  );
}

/**
 * @param {string|null|undefined} iso
 * @param {string} dateKey
 * @param {string} [timeZone]
 */
export function vacuumStampOnDate(iso, dateKey, timeZone = TZ) {
  if (!iso || !dateKey) return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  return scheduleNowParts({ timezone: timeZone }, new Date(ms)).dateKey === dateKey;
}

/**
 * Legacy vacuum.json stored one start. That start is Yan's.
 * @param {object|null|undefined} state
 */
export function vacuumZonesFromState(state) {
  const raw =
    state?.zones && typeof state.zones === "object" && !Array.isArray(state.zones)
      ? state.zones
      : null;
  /** @type {Record<string, { lastStartedAt: string|null, scene: string, reason: string }>} */
  const zones = {};
  for (const id of VACUUM_ZONE_IDS) {
    const row = raw && raw[id] && typeof raw[id] === "object" ? raw[id] : null;
    let lastStartedAt = row?.lastStartedAt ? String(row.lastStartedAt) : null;
    let reason = row?.reason ? String(row.reason) : "";
    if (id === "yan" && !row && !raw) {
      const scene = String(state?.scene || "");
      if (!scene || scene === VACUUM_SCENE) {
        lastStartedAt = state?.lastStartedAt ? String(state.lastStartedAt) : null;
        reason = state?.reason ? String(state.reason) : "";
      }
    }
    zones[id] = {
      lastStartedAt,
      scene: VACUUM_ZONE_SPECS[id].scene,
      reason,
    };
  }
  return zones;
}

/**
 * @param {Record<string, { lastStartedAt: string|null, scene: string, reason: string }>} zones
 */
function zonesForDisk(zones) {
  /** @type {Record<string, { lastStartedAt: string, scene: string, reason: string }>} */
  const out = {};
  for (const id of VACUUM_ZONE_IDS) {
    const row = zones[id];
    if (!row?.lastStartedAt) continue;
    out[id] = {
      lastStartedAt: row.lastStartedAt,
      scene: VACUUM_ZONE_SPECS[id].scene,
      reason: String(row.reason || "").slice(0, 240),
    };
  }
  return out;
}

/**
 * @param {string} raw
 */
export function normalizeVacuumZone(raw) {
  const id = String(raw || "").trim().toLowerCase();
  if (!VACUUM_ZONE_SPECS[id]) return "";
  return id;
}

/**
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 * @param {number} dueMs
 */
function startedWithin(iso, nowMs, dueMs) {
  if (!iso) return false;
  return !vacuumIsDue(iso, nowMs, dueMs);
}

/**
 * @param {Record<string, { lastStartedAt?: string|null }>} zones
 * @param {string} dateKey
 * @param {string} timeZone
 */
function anyZoneStartedOnDate(zones, dateKey, timeZone) {
  return VACUUM_ZONE_IDS.some((id) =>
    vacuumStampOnDate(zones[id]?.lastStartedAt, dateKey, timeZone)
  );
}

/**
 * Pending still owns the day until the confirm grace passes.
 * @param {object|null|undefined} pending
 * @param {number} nowMs
 */
export function pendingConfirmBlocks(pending, nowMs) {
  if (!pending || typeof pending !== "object" || !pending.zone) return false;
  const at = Date.parse(String(pending.confirmAt || ""));
  if (!Number.isFinite(at)) return true;
  return nowMs - at <= VACUUM_CONFIRM_GRACE_MS;
}

/**
 * @param {object|null|undefined} pending
 * @param {number} nowMs
 * @returns {{ action: "none"|"drop"|"wait", delayMs?: number }}
 */
export function vacuumConfirmPlan(pending, nowMs) {
  if (!pending || typeof pending !== "object" || !pending.zone) return { action: "none" };
  const at = Date.parse(String(pending.confirmAt || ""));
  if (!Number.isFinite(at)) return { action: "drop" };
  if (nowMs - at > VACUUM_CONFIRM_GRACE_MS) return { action: "drop" };
  return { action: "wait", delayMs: Math.max(0, at - nowMs) };
}

/**
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 */
export function nextCheckStillOpen(iso, nowMs) {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return at > nowMs;
}

/**
 * @param {{ latitude?: number, longitude?: number, accuracyMeters?: number }|null|undefined} location
 */
export function classifyVacuumLocation(location) {
  const lat = location?.latitude;
  const lng = location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !HOME_PLACE) {
    return { kind: "missing" };
  }
  const meters = haversineMeters(lat, lng, HOME_PLACE.lat, HOME_PLACE.lng);
  const accuracy = Number(location.accuracyMeters);
  const pad = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0;
  if (meters <= HOME_PLACE.radiusM) return { kind: "home", meters };
  if (meters - pad > HOME_PLACE.radiusM) return { kind: "away", meters };
  return { kind: "unclear", meters };
}

/**
 * Pick at most one zone. Yan first, then Sunny, then master.
 * Family zones need a school-session window that still covers the 15-minute warning.
 * @param {{
 *   nowMs?: number,
 *   force?: boolean,
 *   nextCheckAt?: string|null,
 *   location?: { latitude?: number, longitude?: number, accuracyMeters?: number }|null,
 *   zones?: Record<string, { lastStartedAt?: string|null }>,
 *   pending?: object|null,
 *   blockedDate?: string|null,
 *   dateKey?: string,
 *   timeZone?: string,
 *   familyWindowOpen?: boolean,
 * }} opts
 */
export function pickVacuumZone(opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const timeZone = opts.timeZone || TZ;
  const dateKey =
    opts.dateKey || scheduleNowParts({ timezone: timeZone }, new Date(nowMs)).dateKey;
  const zones = opts.zones || vacuumZonesFromState({});
  const force = Boolean(opts.force);

  if (pendingConfirmBlocks(opts.pending, nowMs)) {
    return { run: false, reason: "pending-confirm", zone: null };
  }
  if (!force && nextCheckStillOpen(opts.nextCheckAt, nowMs)) {
    return { run: false, reason: "next-check", zone: null };
  }
  if (opts.blockedDate && opts.blockedDate === dateKey) {
    return { run: false, reason: "denied-today", zone: null };
  }
  if (anyZoneStartedOnDate(zones, dateKey, timeZone)) {
    return { run: false, reason: "already-ran-today", zone: null };
  }
  if (!force) {
    const where = classifyVacuumLocation(opts.location);
    if (where.kind === "home") return { run: false, reason: "at-home", zone: null };
    if (where.kind === "missing") return { run: false, reason: "no-pin", zone: null };
    if (where.kind === "unclear") return { run: false, reason: "not-clearly-away", zone: null };
  }

  const yanAt = zones.yan?.lastStartedAt || null;
  if (vacuumIsDue(yanAt, nowMs, VACUUM_DUE_MS)) {
    return { run: true, reason: force ? "force" : "due", zone: "yan" };
  }

  const yanFresh =
    startedWithin(yanAt, nowMs, VACUUM_DUE_MS) &&
    !vacuumStampOnDate(yanAt, dateKey, timeZone);
  const sunnyAt = zones.sunny?.lastStartedAt || null;
  if (yanFresh && vacuumIsDue(sunnyAt, nowMs, FAMILY_VACUUM_DUE_MS)) {
    if (!opts.familyWindowOpen) return { run: false, reason: "not-in-session", zone: null };
    return { run: true, reason: force ? "force" : "due", zone: "sunny" };
  }

  const sunnyFresh =
    startedWithin(sunnyAt, nowMs, FAMILY_VACUUM_DUE_MS) &&
    !vacuumStampOnDate(sunnyAt, dateKey, timeZone);
  const masterAt = zones.master?.lastStartedAt || null;
  if (yanFresh && sunnyFresh && vacuumIsDue(masterAt, nowMs, FAMILY_VACUUM_DUE_MS)) {
    if (!opts.familyWindowOpen) return { run: false, reason: "not-in-session", zone: null };
    return { run: true, reason: force ? "force" : "due", zone: "master" };
  }
  return { run: false, reason: "recent-vacuum", zone: null };
}

/**
 * HomeClaw often lists action_count 0 for these Roomba scenes. They still
 * start the Roomba. A trigger that returns without an error is a real start.
 * @param {{
 *   nowMs?: number,
 *   force?: boolean,
 *   lastStartedAt?: string|null,
 *   scene?: string|null,
 *   zones?: object,
 *   nextCheckAt?: string|null,
 *   location?: { latitude?: number, longitude?: number, accuracyMeters?: number }|null,
 *   pending?: object|null,
 *   blockedDate?: string|null,
 *   dateKey?: string,
 *   timeZone?: string,
 *   familyWindowOpen?: boolean,
 * }} opts
 */
export function homeVacuumGate(opts = {}) {
  const zones =
    opts.zones ||
    vacuumZonesFromState({
      lastStartedAt: opts.lastStartedAt,
      scene: opts.scene || (opts.lastStartedAt ? VACUUM_SCENE : ""),
      zones: opts.zones,
    });
  return pickVacuumZone({
    nowMs: opts.nowMs,
    force: opts.force,
    nextCheckAt: opts.nextCheckAt,
    location: opts.location,
    zones,
    pending: opts.pending,
    blockedDate: opts.blockedDate,
    dateKey: opts.dateKey,
    timeZone: opts.timeZone,
    familyWindowOpen: Boolean(opts.familyWindowOpen),
  });
}

/**
 * How long a clearly-away pin stays trustworthy. At least 20 minutes, longer
 * when the dot is far enough that even a fast drive could not have reached
 * the house yet.
 * @param {number} meters
 */
export function lightsPinMaxAgeMs(meters) {
  const m = Number(meters);
  const driveMs = Number.isFinite(m) && m > 0 ? (m / LIGHTS_FAST_MPS) * 1000 : 0;
  return Math.max(LIGHTS_LOCATION_FRESH_MS, driveMs);
}

/**
 * Turn lights off only when the pin is fresh, has an accuracy, and the
 * accuracy circle sits entirely outside the house. Anything else is home.
 * A recent life-state sample at kirkland-home also blocks it.
 * @param {{ latitude?: number, longitude?: number, accuracyMeters?: number, timestamp?: string, receivedAt?: string }|null|undefined} location
 * @param {number} [nowMs]
 * @param {{ place?: string, at?: string }|null} [lifeState]
 */
export function classifyLightsPresence(location, nowMs = Date.now(), lifeState = null) {
  const where = classifyVacuumLocation(location);
  if (where.kind === "missing") return { turnOff: false, reason: "no-pin" };
  if (where.kind === "home") return { turnOff: false, reason: "at-home" };
  if (where.kind === "unclear") return { turnOff: false, reason: "not-clearly-away" };
  const accuracy = Number(location?.accuracyMeters);
  if (!Number.isFinite(accuracy) || accuracy <= 0) {
    return { turnOff: false, reason: "no-accuracy" };
  }
  const iso = location?.timestamp || location?.receivedAt || "";
  const at = Date.parse(String(iso));
  if (!Number.isFinite(at) || nowMs - at > lightsPinMaxAgeMs(where.meters)) {
    return { turnOff: false, reason: "stale-pin" };
  }
  if (freshHomeLifeState(lifeState, nowMs)) {
    return { turnOff: false, reason: "life-state-home" };
  }
  return { turnOff: true, reason: "away", meters: where.meters };
}

/**
 * @param {{ place?: string, at?: string }|null|undefined} life
 * @param {number} nowMs
 */
function freshHomeLifeState(life, nowMs) {
  if (!life || typeof life !== "object") return false;
  if (String(life.place || "").toLowerCase() !== "kirkland-home") return false;
  const at = Date.parse(String(life.at || ""));
  if (!Number.isFinite(at)) return true;
  return nowMs - at <= LIGHTS_LIFE_STATE_FRESH_MS;
}

/**
 * @param {unknown} room
 */
export function normalizeHomeRoomName(room) {
  const raw =
    room && typeof room === "object"
      ? room.name || room.display_name || ""
      : room;
  return String(raw || "")
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function accessoryLabel(row) {
  return String(row?.display_name || row?.name || "").trim();
}

function accessoryId(row) {
  return String(row?.id || row?.uuid || "").trim();
}

function accessoryPowerOn(row) {
  const cands = [
    row?.power,
    row?.on,
    row?.power_state,
    row?.state?.power,
    row?.state?.on,
    row?.characteristics?.power,
  ];
  for (const v of cands) {
    if (v === true || v === "true" || v === "on" || v === 1 || v === "1") return true;
    if (v === false || v === "false" || v === "off" || v === 0 || v === "0") return false;
  }
  return null;
}

/**
 * Lights in Yan's Bedroom and Yan's Office only. Booleans, the bathroom
 * fan, the office TV, and the desk port are not lights. The rest of the
 * house is not these rooms.
 * @param {Record<string, unknown>} row
 */
export function isYanRoomLight(row) {
  const id = accessoryId(row);
  const label = accessoryLabel(row);
  const blob = `${row?.display_name || ""} ${row?.name || ""}`.trim();
  const room = normalizeHomeRoomName(row?.room || row?.room_name);
  if (!id || !YAN_LIGHT_ROOMS.has(room)) return false;
  if (row?.reachable === false) return false;
  if (homeBooleanKind(blob) || homeBooleanKind(label)) return false;
  const category = String(row?.category || row?.type || "").toLowerCase();
  const n = blob.toLowerCase();
  if (/fan/.test(category) || /\bfan\b/.test(n)) return false;
  if (/window|sensor|lock|thermostat|door/.test(category)) return false;
  if (/\bdesk port\b/.test(n) || (/\boffice tv\b/.test(n) && !/light/.test(n))) return false;
  if (/lightbulb|lighting/.test(category)) return true;
  if (category === "switch" && /light|lamp|main|closet|accent|skyline|chandelier|overhead|nanoleaf/.test(n)) {
    return true;
  }
  if (category === "outlet" && /lamp|light|laser|skyline|nanoleaf/.test(n)) return true;
  return false;
}

function asAccessoryRows(listRaw) {
  if (Array.isArray(listRaw)) return listRaw;
  if (!listRaw || typeof listRaw !== "object") return [];
  for (const key of ["accessories", "devices", "items", "list"]) {
    if (Array.isArray(listRaw[key])) return listRaw[key];
  }
  return [];
}

/**
 * @param {unknown} listRaw
 * @returns {{ id: string, name: string, room: string }[]}
 */
export function yanRoomLightsToTurnOff(listRaw) {
  /** @type {{ id: string, name: string, room: string }[]} */
  const out = [];
  for (const row of asAccessoryRows(listRaw)) {
    if (!row || typeof row !== "object") continue;
    if (!isYanRoomLight(row)) continue;
    if (accessoryPowerOn(row) !== true) continue;
    const roomRaw = row.room && typeof row.room === "object" ? row.room.name || "" : row.room;
    out.push({
      id: accessoryId(row),
      name: accessoryLabel(row),
      room: String(roomRaw || row.room_name || "").trim(),
    });
  }
  return out;
}

/**
 * @param {string} [path]
 */
export async function readLightsState(path = lightsStatePath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {{
 *   path?: string,
 *   at?: string,
 *   reason?: string,
 *   turnedOff?: { name: string, room: string }[],
 *   failed?: { name: string, room: string }[],
 * }} opts
 */
export async function recordLightsCheck(opts = {}) {
  const path = opts.path || lightsStatePath();
  const prev = await readLightsState(path);
  const at = opts.at || new Date().toISOString();
  const turnedOff = (opts.turnedOff || []).map((row) => ({
    room: String(row.room || ""),
    name: String(row.name || ""),
  }));
  /** @type {Record<string, unknown>} */
  const next = {
    ...prev,
    lastCheckedAt: at,
    reason: String(opts.reason || "").trim().slice(0, 80),
    turnedOff,
  };
  if (opts.failed?.length) {
    next.failed = opts.failed.map((row) => ({
      room: String(row.room || ""),
      name: String(row.name || ""),
    }));
  } else {
    delete next.failed;
  }
  if (turnedOff.length) next.lastTurnedOffAt = at;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {{
 *   location?: object|null,
 *   lifeState?: { place?: string, at?: string }|null,
 *   nowMs?: number,
 *   path?: string,
 *   listAccessories: () => Promise<unknown>,
 *   setOff: (id: string) => Promise<unknown>,
 * }} opts
 */
export async function turnOffYanRoomLightsIfAway(opts) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const presence = classifyLightsPresence(opts.location, nowMs, opts.lifeState);
  if (!presence.turnOff) {
    const prev = await readLightsState(opts.path);
    const already =
      prev.reason === presence.reason &&
      Array.isArray(prev.turnedOff) &&
      prev.turnedOff.length === 0 &&
      !prev.failed;
    if (already) {
      return { ok: true, skipped: true, reason: presence.reason, turnedOff: [], state: prev };
    }
    const state = await recordLightsCheck({
      path: opts.path,
      at: new Date(nowMs).toISOString(),
      reason: presence.reason,
      turnedOff: [],
    });
    return { ok: true, skipped: true, reason: presence.reason, turnedOff: [], state };
  }

  const targets = yanRoomLightsToTurnOff(await opts.listAccessories());
  /** @type {{ id: string, name: string, room: string }[]} */
  const turnedOff = [];
  /** @type {{ id: string, name: string, room: string, error: string }[]} */
  const failed = [];
  for (const target of targets) {
    try {
      await opts.setOff(target.id);
      turnedOff.push(target);
    } catch (err) {
      failed.push({
        ...target,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const state = await recordLightsCheck({
    path: opts.path,
    at: new Date(nowMs).toISOString(),
    reason: failed.length ? "away-partial" : "away",
    turnedOff: turnedOff.map(({ name, room }) => ({ name, room })),
    failed: failed.map(({ name, room }) => ({ name, room })),
  });
  return {
    ok: failed.length === 0,
    skipped: false,
    reason: failed.length ? "away-partial" : "away",
    turnedOff,
    failed,
    state,
  };
}

/**
 * @param {{ latitude?: number, longitude?: number, accuracyMeters?: number, timestamp?: string, receivedAt?: string }|null|undefined} pin
 */
function phonePinLine(pin) {
  if (!pin) return "Phone pin: missing.";
  const pinAt = pin.timestamp || pin.receivedAt || "unknown";
  return `Phone pin: ${pin.latitude}, ${pin.longitude} at ${pinAt}${
    pin.accuracyMeters != null ? `, accuracy ${pin.accuracyMeters}m` : ""
  }.`;
}

const IMESSAGE_SEND_CURL =
  "curl -sS --unix-socket /tmp/personal-agent-local.sock -H 'Content-Type: application/json' -d '{\"to\":\"Levin-Saha Family\",\"text\":\"...\"}' http://localhost/imessage/send";

/**
 * @param {{ dateKey: string, timezone: string, vacuumPath: string, location?: object|null, zone?: string|null }} opts
 */
export function buildHomeAgentPrompt(opts) {
  const requested = Object.prototype.hasOwnProperty.call(opts, "zone")
    ? opts.zone
    : "yan";
  const zoneId = requested && VACUUM_ZONE_SPECS[requested] ? requested : "";
  const spec = zoneId ? VACUUM_ZONE_SPECS[zoneId] : null;
  const lines = [
    "Follow the home-agent skill (.cursor/skills/home-agent/SKILL.md).",
    "Decide whether to start the Roomba. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${opts.dateKey} (timezone ${opts.timezone}).`,
    `Vacuum state file: ${opts.vacuumPath}`,
    phonePinLine(opts.location),
    "Parents live in the house. Yan being out does not mean the house is empty.",
    "Do not turn any lights, switches, or outlets on or off. The script already did the away-lights check.",
    "Do not git commit. Do not edit any other file.",
  ];
  if (!spec) {
    lines.push(
      "No vacuum zone is eligible on this run.",
      "Do not trigger a scene. Do not send an iMessage.",
      'Record it with: node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>',
      "A skip must not change lastStartedAt."
    );
    return lines.join("\n");
  }
  lines.push(
    `The only scene you may trigger is ${JSON.stringify(spec.scene)}.`,
    `Never trigger ${JSON.stringify(VACUUM_SCENE_FORBIDDEN)}.`,
    "HomeClaw listing action_count 0 is normal for this scene. The Roomba still starts. Record the start unless the trigger command itself fails.",
    "If the trigger fails, do not record a start.",
    "Read the vacuum file, Apple Calendar for the next several hours (node server/calendar-cli.js events), life-state now and recent samples (node server/life-state.js now, node server/life-state.js recent 6), and today's class schedule when it is a school day (education/you@example.com/schedule.json)."
  );
  if (spec.family) {
    lines.push(
      `This zone is ${zoneId}. Name this part of the house in the text: ${spec.area}.`,
      "Do not trigger the scene on this pass. This pass only sends the 15-minute warning.",
      "Send the warning only if the people who use that part of the house are unlikely to be home within 2 hours and the house will not be asleep during those 2 hours.",
      "Early morning, and an evening where people will be in bed within 2 hours, are no. A long absence does not override that.",
      `If yes, send one iMessage to ${JSON.stringify(FAMILY_VACUUM_CHAT)} on the local socket. Say the Roomba starts in 15 minutes in that part of the house, and that a reply of no or any other rejection stops it. Do not write the agent footer. The server adds // Sent by Yan's Personal Agent.`,
      IMESSAGE_SEND_CURL,
      `Then: node server/home-agent.js record-warn --zone ${zoneId} --reason "<one line>"`,
      'If no: node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>',
      "A skip must not change lastStartedAt. Do not send a warning when you skip."
    );
  } else {
    lines.push(
      "Start the vacuum only if he is unlikely to be home within 2 hours and the house will not be asleep during those 2 hours.",
      "Early morning, and an evening where people will be in bed within 2 hours, are no. A long absence does not override that.",
      `If yes: node server/home-agent.js trigger --zone yan --reason "<one line>"`,
      `That runs home-cli trigger ${JSON.stringify(VACUUM_SCENE)} and then record-start.`,
      'If no: node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>',
      "A skip must not change lastStartedAt."
    );
  }
  return lines.join("\n");
}

/**
 * @param {{ dateKey: string, timezone: string, vacuumPath: string, zone: string, warnedAt: string }} opts
 */
export function buildVacuumConfirmPrompt(opts) {
  const spec = VACUUM_ZONE_SPECS[opts.zone];
  const scene = spec ? spec.scene : String(opts.zone || "");
  const area = spec?.area || "that part of the house";
  const thread = `curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/imessage/thread?person=${encodeURIComponent(FAMILY_VACUUM_CHAT)}&limit=40"`;
  return [
    "Follow the home-agent skill (.cursor/skills/home-agent/SKILL.md).",
    "This is the 15-minute confirm pass. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${opts.dateKey} (timezone ${opts.timezone}).`,
    `Vacuum state file: ${opts.vacuumPath}`,
    `Pending zone: ${opts.zone}. Scene: ${JSON.stringify(scene)}. Area: ${area}.`,
    `The warning was sent at ${opts.warnedAt}.`,
    `Read the ${FAMILY_VACUUM_CHAT} thread since that time:`,
    thread,
    "Ignore the warning message itself. It carries the agent footer.",
    "Silence is a yes. Unrelated chatter is not a rejection.",
    "A no, or any other clear rejection, from Rajasi, Michael, Adi, or Yan means do not start.",
    "If the objection is unclear, do not start.",
    `If nobody rejected: node server/home-agent.js trigger --zone ${opts.zone} --reason "<one line>". Send no iMessage.`,
    `That runs home-cli trigger ${JSON.stringify(scene)} and then record-start.`,
    "HomeClaw listing action_count 0 is normal for this scene. If the trigger fails, do not record a start.",
    `If someone rejected or the objection is unclear: send one short ack in ${JSON.stringify(FAMILY_VACUUM_CHAT)} that the Roomba is not starting. Use the same local socket. Do not write the agent footer. The server adds it.`,
    IMESSAGE_SEND_CURL,
    `Then: node server/home-agent.js record-deny --reason "<one line>" --next-check <ISO time>`,
    "If you cannot read the thread: do not start and do not send. Run clear-pending, then record-skip with a next-check.",
    "node server/home-agent.js clear-pending",
    "Do not git commit. Do not edit any other file.",
    "Do not turn any lights, switches, or outlets on or off.",
  ].join("\n");
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

async function readSchoolSchedule() {
  try {
    const raw = await readFile(
      join(REPO_ROOT, "education", YAN_EMAIL, "schedule.json"),
      "utf8"
    );
    const schedule = JSON.parse(raw);
    return schedule && typeof schedule === "object" ? schedule : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} [path]
 */
export async function readVacuumState(path = vacuumStatePath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} patch
 * @param {{ clear?: string[] }} [opts]
 */
async function writeVacuumPatch(path, patch, opts = {}) {
  const prev = await readVacuumState(path);
  const next = { ...prev, ...patch };
  for (const key of opts.clear || []) delete next[key];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {{ path?: string, at?: string, reason?: string, zone?: string }} opts
 */
export async function recordVacuumStart(opts = {}) {
  const path = opts.path || vacuumStatePath();
  const at = opts.at || new Date().toISOString();
  const zone = normalizeVacuumZone(opts.zone || "yan");
  if (!zone) throw new Error(`unknown vacuum zone ${opts.zone}`);
  const prev = await readVacuumState(path);
  const zones = vacuumZonesFromState(prev);
  const reason = String(opts.reason || "").trim().slice(0, 240);
  zones[zone] = {
    lastStartedAt: at,
    scene: VACUUM_ZONE_SPECS[zone].scene,
    reason,
  };
  return writeVacuumPatch(
    path,
    {
      lastStartedAt: at,
      scene: VACUUM_ZONE_SPECS[zone].scene,
      reason,
      zones: zonesForDisk(zones),
    },
    { clear: ["nextCheckAt", "lastSkippedAt", "skipReason", "pending"] }
  );
}

/**
 * @param {{ path?: string, at?: string, reason?: string, zone?: string }} opts
 */
export async function recordVacuumWarn(opts = {}) {
  const zone = normalizeVacuumZone(opts.zone);
  const spec = zone ? VACUUM_ZONE_SPECS[zone] : null;
  if (!spec?.family) throw new Error("record-warn needs --zone sunny or master");
  const path = opts.path || vacuumStatePath();
  const warnedMs = Date.parse(opts.at || new Date().toISOString());
  if (!Number.isFinite(warnedMs)) throw new Error("record-warn needs a valid time");
  const reason = String(opts.reason || "").trim().slice(0, 240);
  return writeVacuumPatch(path, {
    pending: {
      zone,
      scene: spec.scene,
      area: spec.area,
      warnedAt: new Date(warnedMs).toISOString(),
      confirmAt: new Date(warnedMs + VACUUM_WARN_LEAD_MS).toISOString(),
      reason,
      confirmAttempts: 0,
    },
  });
}

/**
 * @param {{ path?: string, at?: string, reason?: string, nextCheckAt?: string, dateKey?: string, timeZone?: string }} opts
 */
export async function recordVacuumDeny(opts = {}) {
  const path = opts.path || vacuumStatePath();
  const at = opts.at || new Date().toISOString();
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error("record-deny needs a valid time");
  const nextCheckAt = opts.nextCheckAt ? String(opts.nextCheckAt) : "";
  if (!nextCheckAt || Number.isNaN(Date.parse(nextCheckAt))) {
    throw new Error("record-deny needs --next-check as an ISO time");
  }
  const timeZone = opts.timeZone || TZ;
  const dateKey =
    opts.dateKey || scheduleNowParts({ timezone: timeZone }, new Date(atMs)).dateKey;
  const reason = String(opts.reason || "").trim().slice(0, 240);
  return writeVacuumPatch(
    path,
    {
      lastDeniedAt: new Date(atMs).toISOString(),
      denyReason: reason,
      blockedDate: dateKey,
      lastSkippedAt: new Date(atMs).toISOString(),
      skipReason: reason,
      nextCheckAt: new Date(nextCheckAt).toISOString(),
    },
    { clear: ["pending"] }
  );
}

/**
 * @param {{ path?: string }} [opts]
 */
export async function clearVacuumPending(opts = {}) {
  const path = opts.path || vacuumStatePath();
  return writeVacuumPatch(path, {}, { clear: ["pending"] });
}

/**
 * @param {{ path?: string, at?: string, reason?: string, nextCheckAt?: string }} opts
 */
export async function recordVacuumSkip(opts = {}) {
  const path = opts.path || vacuumStatePath();
  const at = opts.at || new Date().toISOString();
  const nextCheckAt = opts.nextCheckAt ? String(opts.nextCheckAt) : "";
  if (!nextCheckAt || Number.isNaN(Date.parse(nextCheckAt))) {
    throw new Error("record-skip needs --next-check as an ISO time");
  }
  return writeVacuumPatch(path, {
    lastSkippedAt: at,
    skipReason: String(opts.reason || "").trim().slice(0, 240),
    nextCheckAt: new Date(nextCheckAt).toISOString(),
  });
}

/**
 * @param {string} apiKey
 * @param {{ id: string, params: { id: string, value: string }[] }} spec
 */
async function resolveModelSelection(apiKey, spec) {
  const fallback = modelSelection(spec);
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    const listed = models?.find((m) => m?.id === fallback.id);
    if (!listed) return fallback;
    const wanted = fallback.params;
    const variant = (listed.variants || []).find((v) => {
      const params = v?.params || [];
      if (wanted.length === 0) return !params.length;
      return wanted.every((w) =>
        params.some((p) => p.id === w.id && p.value === w.value)
      );
    });
    if (variant?.params?.length) {
      return modelSelection({ id: listed.id, params: variant.params });
    }
    return fallback;
  } catch (err) {
    console.warn(
      "[home-agent] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

export async function isHomeAgentBusy() {
  if (inFlight) return true;
  try {
    await stat(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  try {
    const handle = await open(LOCK_PATH, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    try {
      const st = await stat(LOCK_PATH);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_PATH, { force: true });
        const handle = await open(LOCK_PATH, "wx");
        await handle.writeFile(String(process.pid));
        return handle;
      }
    } catch {
      /* still locked */
    }
    return null;
  }
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {
    /* ignore */
  }
  await rm(LOCK_PATH, { force: true });
}

/**
 * @param {string} prefix
 * @param {string} prompt
 */
async function runHomeComposer(prefix, prompt) {
  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const model = await resolveModelSelection(apiKey, HOME_AGENT_MODEL_SPEC);
  const outcome = await promptWithAuthRetry({
    prefix,
    prompt,
    model,
    cwd: REPO_ROOT,
  });
  return { model, ...outcome };
}

const HARD_VACUUM_SKIPS = new Set([
  "pending-confirm",
  "already-ran-today",
  "denied-today",
]);

function scheduleConfirmRetry(delayMs) {
  if (confirmTimer) clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    runVacuumConfirm().catch((err) =>
      console.error("[home-agent] confirm failed", err)
    );
  }, delayMs);
  if (typeof confirmTimer.unref === "function") confirmTimer.unref();
}

/**
 * Arm the 15-minute confirm, or drop a warning whose window has passed.
 * @param {{ state?: object, path?: string, nowMs?: number }} [opts]
 */
export async function armVacuumConfirmTimer(opts = {}) {
  const state = opts.state || (await readVacuumState(opts.path));
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const plan = vacuumConfirmPlan(state?.pending, nowMs);
  if (plan.action === "drop") {
    await clearVacuumPending({ path: opts.path });
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    console.log("[home-agent] dropped stale vacuum warning");
    return { armed: false, reason: "confirm-expired" };
  }
  if (plan.action !== "wait") {
    if (confirmTimer) {
      clearTimeout(confirmTimer);
      confirmTimer = null;
    }
    return { armed: false, reason: "no-pending" };
  }
  scheduleConfirmRetry(plan.delayMs || 0);
  console.log(
    `[home-agent] vacuum confirm in ${Math.round((plan.delayMs || 0) / 1000)}s (${state.pending.confirmAt})`
  );
  return { armed: true, delayMs: plan.delayMs, confirmAt: state.pending.confirmAt };
}

/**
 * @param {{ force?: boolean }} [opts]
 */
export async function runHomeAgent(opts = {}) {
  if (inFlight) {
    return { ok: true, skipped: true, reason: "in-flight" };
  }
  inFlight = runHomeAgentOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function runHomeAgentOnce({ force = false } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const nowMs = Date.now();
  let state = await readVacuumState();
  if (vacuumConfirmPlan(state.pending, nowMs).action === "drop") {
    state = await clearVacuumPending();
  }
  const location = await readPhoneLocation();
  let lights = { ok: true, skipped: true, reason: "not-run", turnedOff: [] };
  try {
    const lifeState = await readCurrentLifeState();
    lights = await turnOffYanRoomLightsIfAway({
      location,
      lifeState,
      nowMs,
      listAccessories: () => runHome(["list"]),
      setOff: (id) => runHome(["set", id, "off"]),
    });
    const names = (lights.turnedOff || []).map((row) => row.name).filter(Boolean);
    console.log(
      `[home-agent] lights ${dateKey}: ${lights.reason}${
        names.length ? ` off ${names.join(", ")}` : ""
      }`
    );
  } catch (err) {
    console.error("[home-agent] lights check failed", err);
    lights = { ok: false, skipped: true, reason: "lights-error", turnedOff: [] };
  }
  const schedule = await readSchoolSchedule();
  const familyWindowOpen = familyWarnWindowOpen(nowMs, schedule, timezone);
  const gate = homeVacuumGate({
    nowMs,
    force,
    lastStartedAt: state.lastStartedAt,
    scene: state.scene,
    zones: state.zones,
    nextCheckAt: state.nextCheckAt,
    location,
    pending: state.pending,
    blockedDate: state.blockedDate,
    dateKey,
    timeZone: timezone,
    familyWindowOpen,
  });

  if (!gate.run && (!force || HARD_VACUUM_SKIPS.has(gate.reason))) {
    if (gate.reason === "pending-confirm") {
      await armVacuumConfirmTimer({ state });
    }
    console.log(`[home-agent] skip ${dateKey}: ${gate.reason}`);
    return { ok: true, skipped: true, reason: gate.reason, dateKey, lights };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[home-agent] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    console.log(
      `[home-agent] deciding ${dateKey} tz=${timezone} zone=${gate.zone || "none"} force=${Boolean(force)}`
    );
    const prompt = buildHomeAgentPrompt({
      dateKey,
      timezone,
      vacuumPath: vacuumStatePath(),
      location,
      zone: gate.zone,
    });
    const { model, result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await runHomeComposer("home-agent", prompt);
    console.log(`[home-agent] model=${model.id}`);

    if (usedFallback) {
      console.warn("[home-agent] used auto after preferred-model retries");
    }
    if (transientFailed) {
      laterAuthRetry.schedule(dateKey);
      return {
        ok: false,
        dateKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }

    laterAuthRetry.clear();
    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
      lights,
    };
  } finally {
    await releaseLock(handle);
    armVacuumConfirmTimer().catch((err) =>
      console.error("[home-agent] confirm arm failed", err)
    );
  }
}

/**
 * Second Composer pass. Reads the family thread and either starts the
 * pending scene or sends the denial ack. The decide pass arms this.
 */
export async function runVacuumConfirm() {
  if (inFlight) {
    scheduleConfirmRetry(60_000);
    return { ok: true, skipped: true, reason: "in-flight" };
  }
  inFlight = runVacuumConfirmOnce().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runVacuumConfirmOnce() {
  const nowMs = Date.now();
  let state = await readVacuumState();
  const plan = vacuumConfirmPlan(state.pending, nowMs);
  if (plan.action === "none") {
    return { ok: true, skipped: true, reason: "no-pending" };
  }
  if (plan.action === "drop") {
    await clearVacuumPending();
    console.log("[home-agent] confirm window missed, pending dropped");
    return { ok: true, skipped: true, reason: "confirm-expired" };
  }
  const attempts = Number(state.pending.confirmAttempts || 0);
  if (attempts >= 2) {
    await clearVacuumPending();
    console.log("[home-agent] confirm gave up");
    return { ok: false, skipped: true, reason: "confirm-gave-up" };
  }

  const handle = await acquireLock();
  if (!handle) {
    scheduleConfirmRetry(60_000);
    return { ok: true, skipped: true, reason: "in-flight" };
  }

  try {
    state = await writeVacuumPatch(vacuumStatePath(), {
      pending: { ...state.pending, confirmAttempts: attempts + 1 },
    });
    const meta = await readMeta();
    const now = briefingNow(meta);
    const dateKey = now.dateKey;
    const timezone = resolveBriefingTimezone(meta, dateKey);
    const prompt = buildVacuumConfirmPrompt({
      dateKey,
      timezone,
      vacuumPath: vacuumStatePath(),
      zone: state.pending.zone,
      warnedAt: state.pending.warnedAt,
    });
    console.log(`[home-agent] confirming ${state.pending.zone} ${dateKey}`);
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await runHomeComposer("home-agent-confirm", prompt);
    if (usedFallback) {
      console.warn("[home-agent] confirm used auto after preferred-model retries");
    }
    if (transientFailed) {
      const again = await readVacuumState();
      if (vacuumConfirmPlan(again.pending, Date.now()).action === "wait") {
        scheduleConfirmRetry(60_000);
      }
      return {
        ok: false,
        dateKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }
    return { ok: true, dateKey, status: result?.status || "finished" };
  } finally {
    await releaseLock(handle);
  }
}

function armTimer() {
  if (timer) clearTimeout(timer);
  const delay = msUntilNextHomeAgentTick();
  const when = new Date(Date.now() + delay);
  console.log(
    `[home-agent] next check ${when.toISOString()} (in ${Math.round(delay / 1000)}s)`
  );
  timer = setTimeout(() => {
    runHomeAgent()
      .catch((err) => console.error("[home-agent] scheduled run failed", err))
      .finally(() => {
        try {
          armTimer();
        } catch (err) {
          console.error("[home-agent] reschedule failed", err);
          timer = setTimeout(() => startHomeAgentScheduler(), 60 * 1000);
        }
      });
  }, delay);
}

export function startHomeAgentScheduler() {
  armTimer();
  armVacuumConfirmTimer().catch((err) =>
    console.error("[home-agent] confirm arm failed", err)
  );
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return "";
  return process.argv[i + 1] || "";
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(arg).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const cmd = process.argv[2];
  const force = process.argv.includes("--force");
  const run = async () => {
    if (cmd === "trigger") {
      const zone = normalizeVacuumZone(argValue("--zone") || "yan");
      if (!zone) throw new Error(`unknown vacuum zone ${argValue("--zone")}`);
      await runHome(["trigger", VACUUM_ZONE_SPECS[zone].scene]);
      const state = await recordVacuumStart({
        zone,
        reason: argValue("--reason"),
      });
      console.log("[home-agent] recorded start", zone, state.lastStartedAt);
      return;
    }
    if (cmd === "record-start") {
      const zone = normalizeVacuumZone(argValue("--zone") || "yan");
      if (!zone) throw new Error(`unknown vacuum zone ${argValue("--zone")}`);
      const state = await recordVacuumStart({
        zone,
        reason: argValue("--reason"),
      });
      console.log("[home-agent] recorded start", zone, state.lastStartedAt);
      return;
    }
    if (cmd === "record-warn") {
      const state = await recordVacuumWarn({
        zone: argValue("--zone"),
        reason: argValue("--reason"),
      });
      console.log("[home-agent] recorded warning until", state.pending?.confirmAt);
      return;
    }
    if (cmd === "record-deny") {
      const state = await recordVacuumDeny({
        reason: argValue("--reason"),
        nextCheckAt: argValue("--next-check"),
      });
      console.log("[home-agent] recorded denial for", state.blockedDate);
      return;
    }
    if (cmd === "clear-pending") {
      await clearVacuumPending();
      console.log("[home-agent] cleared pending warning");
      return;
    }
    if (cmd === "record-skip") {
      const state = await recordVacuumSkip({
        reason: argValue("--reason"),
        nextCheckAt: argValue("--next-check"),
      });
      console.log("[home-agent] recorded skip until", state.nextCheckAt);
      return;
    }
    const result = await runHomeAgent({ force });
    console.log("[home-agent]", result);
    if (!result?.ok && !result?.skipped) process.exitCode = 1;
  };
  run().catch((err) => {
    console.error("[home-agent] failed", err);
    process.exitCode = 1;
  });
}
