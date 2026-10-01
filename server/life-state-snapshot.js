/**
 * Compact life-state snapshot for Composer / on-demand guesses.
 * Each source is isolated so one failure does not kill the tick.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCalendar } from "./calendar-cli.js";
import { briefingNow, resolveBriefingTimezone } from "./daily-briefing-agent.js";
import { resolveNowScheduleContext } from "./education-data.js";
import { runHome } from "./home-cli.js";
import { recentMessages } from "./imessage-read.js";
import { readLifeStateRaw, readRecentLifeStateSignals, slimLifeStateStore } from "./life-state-intent.js";
import {
  LIFE_STATE_SNAPSHOT_PATH,
  formatLifeStateLocal,
  lifeStateDir,
  readRecentLifeState,
} from "./life-state.js";
import {
  parseDeviceContext,
  parseLocationPayload,
  readPhoneLocation,
  YAN_EMAIL,
} from "./phone-location.js";
import { recentSessions } from "./screentime-read.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const META_PATH = join(
  ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const FITNESS_DIR = join(ROOT, "fitness", YAN_EMAIL, "machines");

export const KNOWN_PLACES = [
  {
    slug: "kirkland-home",
    label: "Home",
    lat: 47.7001,
    lng: -122.2305,
    radiusM: 90,
  },
  {
    slug: "eastside-preparatory-school",
    label: "EPS",
    lat: 47.6436,
    lng: -122.1988,
    radiusM: 220,
  },
  {
    slug: "pro-club",
    label: "PRO Club",
    lat: 47.65119,
    lng: -122.14565,
    radiusM: 140,
  },
  {
    slug: "prashams-house",
    label: "Alex's house",
    lat: 47.6665,
    lng: -122.096,
    radiusM: 180,
  },
];

const HOME_EVENT_MS = 20 * 60 * 1000;
const SCREEN_MS = 15 * 60 * 1000;
const IMESSAGE_MS = 10 * 60 * 1000;
const GYM_MS = 40 * 60 * 1000;
const GPS_RECENT_MS = 8 * 60 * 1000;
const GPS_STALE_MS = 6 * 60 * 60 * 1000;

function clip(raw, max) {
  const s = String(raw || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, max);
}

function finiteNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function timeToMinutes(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function minutesToTime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** US lunch does not start when morning class ends. Clubs middle band runs until 11:45. */
const LUNCH_NOT_BEFORE_MIN = 11 * 60 + 45;

/** @param {number} aLat @param {number} aLng @param {number} bLat @param {number} bLng */
export function haversineMeters(aLat, aLng, bLat, bLng) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * @param {number} lat
 * @param {number} lng
 * @param {{ slug: string, label: string, lat: number, lng: number, radiusM: number }[]} [places]
 */
export function matchKnownPlace(lat, lng, places = KNOWN_PLACES) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  /** @type {{ slug: string, label: string, meters: number }|null} */
  let best = null;
  for (const p of places) {
    const meters = Math.round(haversineMeters(lat, lng, p.lat, p.lng));
    if (meters > p.radiusM) continue;
    if (!best || meters < best.meters) {
      best = { slug: p.slug, label: p.label, meters };
    }
  }
  return best;
}

function accessoryName(row) {
  return clip(row?.display_name || row?.name || row?.title || "", 80);
}

function accessoryRoom(row) {
  const room = row?.room;
  if (room && typeof room === "object") {
    return clip(room.name || room.display_name || "", 80);
  }
  return clip(room || row?.room_name || "", 80);
}

function accessoryCategory(row) {
  return clip(row?.category || row?.type || row?.service || "", 40).toLowerCase();
}

function powerOn(row) {
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

function roomKind(room, name) {
  const s = `${room} ${name}`.toLowerCase();
  if (/closet/.test(s)) return "closet";
  if (/bath/.test(s)) return "bathroom";
  if (/office/.test(s)) return "office";
  if (/bedroom|yan.?s room/.test(s)) return "bedroom";
  return "other";
}

function isLight(row, name, category) {
  if (/lightbulb|lighting|light/.test(category)) return true;
  if (/fan/.test(category) || /fan/.test(name.toLowerCase())) return false;
  return /light|lamp|overhead/.test(name.toLowerCase());
}

function isFan(row, name, category) {
  return /fan/.test(category) || /\bfan\b/.test(name.toLowerCase());
}

/**
 * Named HomeKit boolean outlets Yan uses as occupancy latches, not lights.
 * Bedroom Boolean on = last bedroom occupancy; off = last office occupancy or left the house.
 * Office Boolean is unused. Bathroom Boolean = in-bathroom latch. Leaving Bath Bool = at doorway.
 * @param {string} name
 */
export function homeBooleanKind(name) {
  const s = String(name || "").toLowerCase();
  if (/bedroom\s*boolean/.test(s)) return "bedroom";
  if (/office\s*boolean/.test(s)) return "office";
  if (/bathroom\s*boolean/.test(s)) return "bathroom";
  if (/leaving\s*bath/.test(s)) return "leaving-bath";
  return null;
}

/**
 * Occupancy / motion sensors. Skip office middle (unused). Skip ambiguous duplicate names.
 * Bathroom occupancy can also fire from the closet.
 * @param {string} name
 * @param {string} [room]
 */
export function homeOccupancyKind(name, room) {
  const n = String(name || "").toLowerCase();
  const r = String(room || "").toLowerCase();
  if (!n) return null;
  if (/\bmiddle\b/.test(n)) return null;
  if (/closet occup|closet occupancy/.test(n)) return "closet";
  if (/closet/.test(n) && /occup|motion/.test(n)) return "closet";
  if (/bathroom occup|bath occup/.test(n)) return "bathroom";
  if (/new bedroom occup|bedroom occup/.test(n)) return "bedroom";
  if (/^office sensor$/.test(n) || /office occup/.test(n)) return "office";
  if (/occupancy sensor/.test(n) && /office/.test(r)) return "office";
  return null;
}

function occupancyDetected(row) {
  const cands = [
    row?.occupancy_detected,
    row?.motion_detected,
    row?.occupancy,
    row?.motion,
    row?.state?.occupancy_detected,
    row?.state?.motion_detected,
    row?.state?.occupancy,
    row?.state?.motion,
  ];
  for (const v of cands) {
    if (v === true || v === "true" || v === "detected" || v === 1 || v === "1") {
      return true;
    }
    if (v === false || v === "false" || v === "clear" || v === 0 || v === "0") {
      return false;
    }
  }
  return null;
}

function asArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const key of ["accessories", "devices", "items", "list", "events"]) {
    if (Array.isArray(raw[key])) return raw[key];
  }
  if (Array.isArray(raw.results)) return raw.results;
  return [];
}

/**
 * Room rollup from a HomeClaw list payload. No accessory ids.
 * @param {unknown} listRaw
 * @param {unknown} [eventsRaw]
 * @param {number} [sinceMs]
 */
export function rollupHome(listRaw, eventsRaw = null, sinceMs = Date.now() - HOME_EVENT_MS) {
  const rows = asArray(listRaw).filter((r) => r && typeof r === "object");
  /** @type {Record<string, { lightsOn: number, lightsOff: number, fansOn: number, fansOff: number }>} */
  const rooms = {
    bedroom: { lightsOn: 0, lightsOff: 0, fansOn: 0, fansOff: 0 },
    office: { lightsOn: 0, lightsOff: 0, fansOn: 0, fansOff: 0 },
    bathroom: { lightsOn: 0, lightsOff: 0, fansOn: 0, fansOff: 0 },
    closet: { lightsOn: 0, lightsOff: 0, fansOn: 0, fansOff: 0 },
    other: { lightsOn: 0, lightsOff: 0, fansOn: 0, fansOff: 0 },
  };
  /** @type {boolean|null} */
  let bedroomBoolean = null;
  /** @type {boolean|null} */
  let bathroomBoolean = null;
  /** @type {boolean|null} */
  let leavingBathBool = null;
  /** @type {Record<string, boolean|null>} */
  const occupancy = { bedroom: null, bathroom: null, closet: null, office: null };
  /** @type {Record<string, number>} */
  const occupancyNameCount = {};
  for (const row of rows) {
    const name = accessoryName(row);
    if (homeOccupancyKind(name, accessoryRoom(row))) {
      occupancyNameCount[name] = (occupancyNameCount[name] || 0) + 1;
    }
  }
  for (const row of rows) {
    const name = accessoryName(row);
    const room = accessoryRoom(row);
    const category = accessoryCategory(row);
    const flag = homeBooleanKind(name);
    if (flag === "bedroom") {
      const on = powerOn(row);
      if (on != null) bedroomBoolean = on;
      continue;
    }
    if (flag === "bathroom") {
      const on = powerOn(row);
      if (on != null) bathroomBoolean = on;
      continue;
    }
    if (flag === "leaving-bath") {
      const on = powerOn(row);
      if (on != null) leavingBathBool = on;
      continue;
    }
    if (flag) continue;
    const occKind = homeOccupancyKind(name, room);
    if (occKind) {
      if ((occupancyNameCount[name] || 0) === 1) {
        const occ = occupancyDetected(row);
        if (occ != null) occupancy[occKind] = occ;
      }
      continue;
    }
    const on = powerOn(row);
    if (on == null) continue;
    const kind = roomKind(room, name);
    const bucket = rooms[kind] || rooms.other;
    if (isFan(row, name, category)) {
      if (on) bucket.fansOn += 1;
      else bucket.fansOff += 1;
      continue;
    }
    if (isLight(row, name, category) || /switch|outlet/.test(category)) {
      if (on) bucket.lightsOn += 1;
      else bucket.lightsOff += 1;
    }
  }

  const events = [];
  for (const ev of asArray(eventsRaw)) {
    if (!ev || typeof ev !== "object") continue;
    const at = clip(ev.at || ev.timestamp || ev.time || ev.date, 40);
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms < sinceMs) continue;
    const name = accessoryName(ev);
    if (homeBooleanKind(name) || homeOccupancyKind(name, accessoryRoom(ev))) continue;
    const room = accessoryRoom(ev);
    const char = clip(ev.characteristic || ev.service || ev.type || "", 40).toLowerCase();
    const value = ev.value ?? ev.state ?? ev.power;
    events.push({
      at: new Date(ms).toISOString(),
      room: room || undefined,
      name: name || undefined,
      roomKind: roomKind(room, name),
      characteristic: char || undefined,
      on: powerOn({ power: value }),
    });
  }
  events.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  return {
    rooms,
    bathroomLightsOn: rooms.bathroom.lightsOn > 0,
    bathroomFanOn: rooms.bathroom.fansOn > 0,
    bedroomLightsOn: rooms.bedroom.lightsOn > 0,
    officeLightsOn: rooms.office.lightsOn > 0,
    closetLightsOn: rooms.closet.lightsOn > 0,
    bedroomBoolean,
    bathroomBoolean,
    leavingBathBool,
    occupancy,
    lastMotionRoom:
      bedroomBoolean === true ? "bedroom" : bedroomBoolean === false ? "office" : null,
    recentEvents: events.slice(-12),
  };
}

/**
 * Lunch / middle-band gap between consecutive classes (>= 40 minutes).
 * @param {object|null} nowContext
 */
export function inferLunch(nowContext) {
  if (!nowContext?.isSchoolDay) {
    return { inLunch: false };
  }
  if (nowContext.inClass || nowContext.inFreePeriod) {
    return { inLunch: false };
  }
  const meetings = Array.isArray(nowContext.todayClasses)
    ? nowContext.todayClasses
        .map((m) => ({
          name: clip(m.name || m.className, 80),
          start: m.start,
          end: m.end,
          startMin: timeToMinutes(m.start),
          endMin: timeToMinutes(m.end),
        }))
        .filter((m) => m.startMin != null && m.endMin != null)
        .sort((a, b) => a.startMin - b.startMin)
    : [];
  const minutes = Number(nowContext.minutes);
  if (!Number.isFinite(minutes)) return { inLunch: false };
  for (let i = 0; i < meetings.length - 1; i++) {
    const cur = meetings[i];
    const next = meetings[i + 1];
    const gap = next.startMin - cur.endMin;
    if (gap < 40) continue;
    if (minutes >= cur.endMin && minutes < next.startMin) {
      const lunchStart = Math.max(cur.endMin, LUNCH_NOT_BEFORE_MIN);
      if (minutes < lunchStart || lunchStart >= next.startMin) {
        return { inLunch: false };
      }
      return {
        inLunch: true,
        start: minutesToTime(lunchStart),
        end: next.start,
        after: cur.name || undefined,
        before: next.name || undefined,
      };
    }
  }
  return { inLunch: false };
}

/**
 * @param {unknown[]} events
 * @param {Date} now
 */
export function overlappingCalendarEvents(events, now = new Date()) {
  const t = now.getTime();
  /** @type {object[]} */
  const out = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || typeof ev !== "object" || ev.allDay) continue;
    const start = Date.parse(String(ev.start || ""));
    const end = Date.parse(String(ev.end || ""));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (start <= t && t < end) {
      out.push({
        title: clip(ev.title, 80),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        calendar: clip(ev.calendar, 40) || undefined,
        location: clip(ev.location, 80) || undefined,
      });
    }
  }
  return out.slice(0, 6);
}

/**
 * @param {object[]} sessions
 * @param {number} sinceMs
 */
export function summarizeScreenSessions(sessions, sinceMs) {
  const rows = Array.isArray(sessions) ? sessions : [];
  /** @type {object[]} */
  const recent = [];
  for (const s of rows) {
    const end = Date.parse(String(s.end || s.start || ""));
    if (!Number.isFinite(end) || end < sinceMs) continue;
    recent.push({
      app: clip(s.name || s.app || "", 40),
      device: clip(s.device, 40),
      minutes: finiteNumber(s.minutes),
      start: s.start,
      end: s.end,
    });
    if (recent.length >= 12) break;
  }
  return recent;
}

/**
 * @param {object[]} messages
 * @param {number} sinceMs
 */
export function lastFromMeMessage(messages, sinceMs) {
  const rows = Array.isArray(messages) ? messages : [];
  for (const m of rows) {
    if (!m?.fromMe) continue;
    const at = Date.parse(String(m.at || ""));
    if (!Number.isFinite(at) || at < sinceMs) continue;
    return {
      at: new Date(at).toISOString(),
      chat: clip(m.chat, 80) || undefined,
    };
  }
  return null;
}

/**
 * @param {{ machine: string, at: string }[]} entries
 * @param {number} sinceMs
 */
export function latestGymEntry(entries, sinceMs) {
  let best = null;
  let bestMs = -Infinity;
  for (const e of Array.isArray(entries) ? entries : []) {
    const ms = Date.parse(String(e.at || ""));
    if (!Number.isFinite(ms) || ms < sinceMs) continue;
    if (ms > bestMs) {
      bestMs = ms;
      best = { machine: clip(e.machine, 40), at: new Date(ms).toISOString() };
    }
  }
  return best;
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") throw new Error("daily-briefing meta.json missing");
  return meta;
}

async function loadGymEntries() {
  /** @type {{ machine: string, at: string }[]} */
  const out = [];
  let names = [];
  try {
    names = await readdir(FITNESS_DIR);
  } catch {
    return out;
  }
  for (const id of names) {
    try {
      const raw = JSON.parse(
        await readFile(join(FITNESS_DIR, id, "entries.json"), "utf8")
      );
      const rows = Array.isArray(raw?.entries) ? raw.entries : [];
      for (const e of rows) {
        if (e?.at) out.push({ machine: id, at: String(e.at) });
      }
    } catch {
      /* skip machine */
    }
  }
  return out;
}

function slimSchedule(nowContext, lunch) {
  if (!nowContext) return { ok: false };
  return {
    ok: true,
    isSchoolDay: Boolean(nowContext.isSchoolDay),
    inClass: Boolean(nowContext.inClass),
    inFreePeriod: Boolean(nowContext.inFreePeriod),
    inLunch: Boolean(lunch?.inLunch),
    lunch,
    currentClass: nowContext.currentClass || null,
    nextClass: nowContext.nextClass || null,
    previousClass: nowContext.previousClass || null,
    todayClasses: Array.isArray(nowContext.todayClasses)
      ? nowContext.todayClasses.slice(0, 8)
      : [],
  };
}

function slimLocation(loc, nowMs) {
  const parsed = parseLocationPayload(loc);
  if (!parsed) return { ok: false, reason: "missing" };
  const when = Date.parse(String(parsed.timestamp || parsed.receivedAt || ""));
  const ageMinutes =
    Number.isFinite(when) ? Math.max(0, Math.round((nowMs - when) / 60_000)) : null;
  const place = matchKnownPlace(Number(parsed.latitude), Number(parsed.longitude));
  const device = parseDeviceContext(loc);
  return {
    ok: true,
    latitude: parsed.latitude,
    longitude: parsed.longitude,
    accuracyMeters: parsed.accuracyMeters,
    ageMinutes,
    stale: Number.isFinite(when) ? nowMs - when > GPS_STALE_MS : true,
    recent: Number.isFinite(when) ? nowMs - when <= GPS_RECENT_MS : false,
    speedMps: parsed.speedMps,
    courseDegrees: parsed.courseDegrees,
    placeName: parsed.placeName,
    locality: parsed.locality,
    knownPlace: place,
    device,
  };
}

/**
 * Pure snapshot from already-fetched sources. Used by tests.
 * @param {object} parts
 */
export function assembleLifeStateSnapshot(parts) {
  const now = parts.now instanceof Date ? parts.now : new Date();
  const timeZone = parts.timeZone || "America/Los_Angeles";
  const clock = formatLifeStateLocal(now, timeZone);
  const nowMs = now.getTime();
  const lunch = inferLunch(parts.schedule || null);
  const phone = slimLifeStateStore(parts.phoneIntent, now);
  return {
    at: now.toISOString(),
    local: clock.local,
    dateKey: clock.dateKey,
    timezone: timeZone,
    hour: Number(clock.local.slice(11, 13)),
    location: slimLocation(parts.location, nowMs),
    home: parts.homeError
      ? { ok: false, error: clip(parts.homeError, 120) }
      : { ok: true, ...rollupHome(parts.homeList, parts.homeEvents, nowMs - HOME_EVENT_MS) },
    schedule: slimSchedule(parts.schedule || null, lunch),
    calendar: overlappingCalendarEvents(parts.calendarEvents || [], now),
    screen: summarizeScreenSessions(parts.screenSessions || [], nowMs - SCREEN_MS),
    imessageFromMe: lastFromMeMessage(parts.imessage || [], nowMs - IMESSAGE_MS),
    gym: latestGymEntry(parts.gymEntries || [], nowMs - GYM_MS),
    phoneIntent: phone.latest,
    phoneSignals: {
      ...phone.signals,
      recent: Array.isArray(parts.phoneSignalRecent) ? parts.phoneSignalRecent : [],
    },
    previous: Array.isArray(parts.previous) ? parts.previous.slice(-3) : [],
  };
}

async function safe(label, fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[life-state-snapshot] ${label}`, msg);
    return { ok: false, error: clip(msg, 160) };
  }
}

/**
 * Live snapshot from Mac sources. Writes LIFE_STATE_SNAPSHOT_PATH.
 * @param {{ now?: Date, dir?: string, snapshotPath?: string }} [opts]
 */
export async function buildLifeStateSnapshot(opts = {}) {
  const now = opts.now || new Date();
  const meta = await readMeta();
  const clock = briefingNow(meta, now);
  const timeZone = resolveBriefingTimezone(meta, clock.dateKey);
  const sinceScreen = new Date(now.getTime() - SCREEN_MS).toISOString();
  const sinceImsg = new Date(now.getTime() - IMESSAGE_MS).toISOString();
  const calFrom = new Date(now.getTime() - 12 * 60 * 60 * 1000);
  const calTo = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const [
    loc,
    homeList,
    homeEvents,
    schedule,
    calendar,
    screen,
    imessage,
    gym,
    previous,
    phoneIntent,
    phoneSignalRecent,
  ] = await Promise.all([
    safe("location", () => readPhoneLocation()),
    safe("home-list", () => runHome(["list"])),
    safe("home-events", () => runHome(["events"])),
    safe("schedule", () => resolveNowScheduleContext(YAN_EMAIL, now)),
    safe("calendar", () =>
      runCalendar([
        "events",
        "--from",
        calFrom.toISOString(),
        "--to",
        calTo.toISOString(),
      ])
    ),
    safe("screentime", () => recentSessions({ since: sinceScreen, limit: 40 })),
    safe("imessage", () =>
      recentMessages({ since: sinceImsg, limit: 20, previewStills: 0 })
    ),
    safe("gym", () => loadGymEntries()),
    safe("previous", () => readRecentLifeState(opts.dir, 3)),
    safe("phone-intent", () => readLifeStateRaw(opts.dir)),
    safe("phone-signals-log", () => readRecentLifeStateSignals(opts.dir, now)),
  ]);

  const snapshot = assembleLifeStateSnapshot({
    now,
    timeZone,
    location: loc.ok ? loc.value : null,
    homeList: homeList.ok ? homeList.value : [],
    homeEvents: homeEvents.ok ? homeEvents.value : [],
    homeError: homeList.ok ? "" : homeList.error,
    schedule: schedule.ok ? schedule.value : null,
    calendarEvents: calendar.ok ? calendar.value?.events || [] : [],
    screenSessions: screen.ok ? screen.value : [],
    imessage: imessage.ok ? imessage.value : [],
    gymEntries: gym.ok ? gym.value : [],
    phoneIntent: phoneIntent.ok ? phoneIntent.value : null,
    phoneSignalRecent: phoneSignalRecent.ok ? phoneSignalRecent.value : [],
    previous: previous.ok ? previous.value : [],
  });
  if (!loc.ok) snapshot.location = { ok: false, error: loc.error };
  if (!schedule.ok) snapshot.schedule = { ok: false, error: schedule.error };
  if (!screen.ok) snapshot.screenError = screen.error;
  if (!imessage.ok) snapshot.imessageError = imessage.error;

  const path = opts.snapshotPath || LIFE_STATE_SNAPSHOT_PATH;
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return { path, snapshot, dir: lifeStateDir(opts.dir) };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  buildLifeStateSnapshot()
    .then((r) => {
      console.log(JSON.stringify({ ok: true, path: r.path, at: r.snapshot.at }, null, 2));
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
