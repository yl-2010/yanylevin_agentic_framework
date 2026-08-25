/**
 * Apple Health dump from Yan's iPhone Shortcut.
 * POST /api/education/health → education/<email>/health/
 * (raw JSON, monthly JSONL, workouts.md, state.json).
 */

import { timingSafeEqual } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAddCommitPush } from "./git-publish.js";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

export const HEALTH_DIRNAME = "health";
export const HEALTH_REL = `education/${YAN_EMAIL}/${HEALTH_DIRNAME}`;
/** Standing Health display zone. History is Seattle life, not the travel briefing clock. */
export const HEALTH_TIMEZONE = "America/Los_Angeles";
/** Austin trip: workouts after this local date (exclusive) through HEALTH_AUSTIN_UNTIL_DATE. */
export const HEALTH_AUSTIN_TIMEZONE = "America/Chicago";
export const HEALTH_AUSTIN_AFTER_DATE = "2026-08-12";
export const HEALTH_AUSTIN_UNTIL_DATE = "2026-08-26";
export const MAX_WORKOUTS = 2000;
export const MAX_SLEEP = 4000;
export const MAX_SERIES = 8000;
const TWO_HOUR_MS = 2 * 60 * 60 * 1000;
const TWO_HOUR_SLOP_MS = 5 * 60 * 1000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_STR = 120;

/** @param {string|null|undefined} email */
export function isYanHealthUser(email) {
  return canonicalizeEmail(email) === YAN_EMAIL;
}

/** @param {string} [override] */
export function healthDir(override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  const env = String(process.env.PHONE_HEALTH_DIR || "").trim();
  return env || join(ROOT, HEALTH_REL);
}

function clipStr(raw, max = MAX_STR) {
  const s = String(raw ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!s) return "";
  return s.slice(0, max);
}

function finiteNumber(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const s = String(raw).trim().replace(/,/g, "");
  const m = s.match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function toIso(raw) {
  if (raw instanceof Date && Number.isFinite(raw.getTime())) {
    return raw.toISOString();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw > 1e9 ? raw * 1000 : NaN;
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  const s = clipStr(raw, 64);
  if (!s) return "";
  const ms = Date.parse(s);
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  // Shortcuts JSON dates look like "Aug 20, 2026 at 08:51".
  const apple = s.replace(/\s+at\s+/i, " ");
  const ms2 = Date.parse(apple);
  if (Number.isFinite(ms2)) return new Date(ms2).toISOString();
  return "";
}

function asList(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    if (t.startsWith("[") || t.startsWith("{")) {
      try {
        const parsed = JSON.parse(t);
        return asList(parsed);
      } catch {
        /* split below */
      }
    }
    return t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  }
  if (typeof raw === "object") {
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.values)) return raw.values;
    return [raw];
  }
  return [raw];
}

function unwrapPayload(raw) {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    try {
      return unwrapPayload(JSON.parse(t));
    } catch {
      return null;
    }
  }
  if (typeof raw !== "object") return null;
  const obj = /** @type {Record<string, unknown>} */ (raw);
  const keys = Object.keys(obj);
  if (keys.length === 1 && typeof keys[0] === "string" && keys[0].startsWith("{")) {
    try {
      return unwrapPayload(JSON.parse(keys[0]));
    } catch {
      /* keep obj */
    }
  }
  return obj;
}

/**
 * @param {unknown} starts
 * @param {unknown} values
 * @param {Record<string, unknown>} [extraLists]
 */
export function zipSeries(starts, values, extraLists = {}) {
  const s = asList(starts);
  const v = asList(values);
  const extras = Object.fromEntries(
    Object.entries(extraLists).map(([k, list]) => [k, asList(list)])
  );
  const n = Math.max(
    s.length,
    v.length,
    ...Object.values(extras).map((x) => x.length)
  );
  if (!n) return [];
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (let i = 0; i < n && out.length < MAX_SERIES; i++) {
    /** @type {Record<string, unknown>} */
    const row = {};
    const start = toIso(s[i]) || clipStr(s[i], 48);
    if (start) row.start = start;
    if (v[i] != null && v[i] !== "") {
      const num = finiteNumber(v[i]);
      row.value = num != null ? num : clipStr(v[i], 80);
    }
    for (const [k, list] of Object.entries(extras)) {
      if (list[i] == null || list[i] === "") continue;
      if (/end|date/i.test(k)) {
        const iso = toIso(list[i]);
        if (iso) row[k] = iso;
        continue;
      }
      const num = finiteNumber(list[i]);
      row[k] = num != null && !/name|type|source|unit|activity/i.test(k)
        ? num
        : clipStr(list[i], 80);
    }
    if (Object.keys(row).length) out.push(row);
  }
  return out;
}

function durationMinutes(raw, startIso, endIso) {
  const a = Date.parse(startIso || "");
  const b = Date.parse(endIso || "");
  if (Number.isFinite(a) && Number.isFinite(b) && b > a) {
    const elapsed = Math.round((b - a) / 60_000);
    if (elapsed >= 0 && elapsed < 24 * 60) return elapsed;
  }
  if (raw != null && raw !== "") {
    const s = String(raw).trim();
    const clock = s.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (clock) {
      const h = Number(clock[1]);
      const m = Number(clock[2]);
      const sec = Number(clock[3] || 0);
      if (clock[3] != null || h > 24) return Math.round((h * 3600 + m * 60 + sec) / 60);
      return h * 60 + m;
    }
    const n = finiteNumber(raw);
    if (n != null) {
      if (n > 0 && n < 20 && s.includes("h")) return Math.round(n * 60);
      if (n > 0 && n <= 600) return Math.round(n);
      if (n > 600 && n < 86_400) return Math.round(n / 60);
    }
  }
  return null;
}

function distanceMiles(raw) {
  const n = finiteNumber(raw);
  if (n == null) return null;
  const s = String(raw).toLowerCase();
  if (s.includes("km")) return Math.round((n / 1.60934) * 100) / 100;
  if (s.includes("m") && !s.includes("mi") && n > 50) {
    return Math.round((n / 1609.34) * 100) / 100;
  }
  if (n > 80 && n < 100_000 && !s.includes("mi")) {
    return Math.round((n / 1609.34) * 100) / 100;
  }
  return Math.round(n * 100) / 100;
}

/**
 * @param {Record<string, unknown>} src
 * @returns {Record<string, unknown>|null}
 */
export function normalizeWorkout(src) {
  if (!src || typeof src !== "object") return null;
  const activity =
    clipStr(
      src.activity ??
        src.type ??
        src.name ??
        src.workoutType ??
        src.activityType ??
        src.Title,
      80
    ) || "Workout";
  const start = toIso(
    src.start ?? src.startDate ?? src.StartDate ?? src.date ?? src.WFStartDate
  );
  if (!start) return null;
  const end = toIso(src.end ?? src.endDate ?? src.EndDate);
  const durationMin = durationMinutes(
    src.durationMin ?? src.duration ?? src.Duration ?? src.durationMinutes,
    start,
    end
  );
  const distanceMi = distanceMiles(
    src.distanceMi ??
      src.distance ??
      src.totalDistance ??
      src.Distance ??
      src.distanceKm
  );
  const energyKcal = finiteNumber(
    src.energyKcal ??
      src.calories ??
      src.activeEnergy ??
      src.activeCalories ??
      src.totalEnergyBurned ??
      src.energy ??
      src.ActiveEnergy
  );
  const avgHr = finiteNumber(
    src.avgHr ?? src.averageHeartRate ?? src.heartRate ?? src.AverageHeartRate
  );
  const source = clipStr(
    src.source ?? src.sourceName ?? src.Source ?? src.SourceName,
    80
  );
  /** @type {Record<string, unknown>} */
  const out = { activity, start };
  if (end) out.end = end;
  if (durationMin != null && durationMin >= 0 && durationMin < 24 * 60) {
    out.durationMin = durationMin;
  }
  if (distanceMi != null && distanceMi >= 0 && distanceMi < 500) {
    out.distanceMi = distanceMi;
  }
  if (energyKcal != null && energyKcal >= 0 && energyKcal < 20_000) {
    out.energyKcal = Math.round(energyKcal);
  }
  if (avgHr != null && avgHr >= 30 && avgHr < 230) out.avgHr = Math.round(avgHr);
  if (source) out.source = source;
  return out;
}

function workoutsFromParallel(src) {
  const rows = zipSeries(
    src.starts ?? src.start ?? src.startDates,
    src.values ?? src.durations ?? src.durationMin,
    {
      end: src.ends ?? src.end ?? src.endDates,
      activity: src.names ?? src.name ?? src.activities ?? src.types,
      durationMin: src.durations ?? src.durationMin,
      distanceMi: src.distances ?? src.distance,
      energyKcal: src.energies ?? src.calories ?? src.activeEnergy,
      avgHr: src.avgHrs ?? src.heartRates,
      source: src.sources ?? src.source,
    }
  );
  return rows.map((row) =>
    normalizeWorkout({
      activity: row.activity ?? row.name,
      start: row.start,
      end: row.end,
      durationMin: row.durationMin ?? row.value,
      distanceMi: row.distanceMi,
      energyKcal: row.energyKcal,
      avgHr: row.avgHr,
      source: row.source,
    })
  ).filter(Boolean);
}

function collectWorkouts(src) {
  /** @type {Record<string, unknown>[]} */
  const out = [];
  const push = (item) => {
    const w = normalizeWorkout(/** @type {Record<string, unknown>} */ (item));
    if (w) out.push(w);
  };
  if (Array.isArray(src.workouts)) {
    if (src.workouts.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      for (const item of src.workouts) push(item);
    } else {
      out.push(...workoutsFromParallel({ starts: src.workouts }));
    }
  } else if (src.workouts && typeof src.workouts === "object") {
    out.push(
      ...workoutsFromParallel(/** @type {Record<string, unknown>} */ (src.workouts))
    );
  }
  if (src.workoutStarts || src.workoutNames) {
    out.push(
      ...workoutsFromParallel({
        starts: src.workoutStarts,
        names: src.workoutNames,
        ends: src.workoutEnds,
        durations: src.workoutDurations,
        distances: src.workoutDistances,
        energies: src.workoutEnergies,
        avgHrs: src.workoutAvgHrs,
        sources: src.workoutSources,
      })
    );
  }
  const seen = new Set();
  return out.filter((w) => {
    const key = workoutKey(w);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_WORKOUTS);
}

/** @param {Record<string, unknown>} w */
export function workoutKey(w) {
  const start = String(w.start || "").slice(0, 19);
  const activity = String(w.activity || "workout").toLowerCase();
  return `${start}|${activity}`;
}

function shiftIso(iso, ms) {
  const t = Date.parse(String(iso || ""));
  if (!Number.isFinite(t)) return String(iso || "");
  return new Date(t + ms).toISOString();
}

function workoutActivityKey(w) {
  return String(w?.activity || "workout").toLowerCase();
}

function similarWorkoutStats(a, b) {
  if (workoutActivityKey(a) !== workoutActivityKey(b)) return false;
  const da = Number(a?.durationMin);
  const db = Number(b?.durationMin);
  if (Number.isFinite(da) && Number.isFinite(db) && Math.abs(da - db) > 2) {
    return false;
  }
  let shared = 0;
  if (a?.energyKcal != null && b?.energyKcal != null) {
    if (Number(a.energyKcal) !== Number(b.energyKcal)) return false;
    shared += 1;
  }
  if (a?.avgHr != null && b?.avgHr != null) {
    if (Number(a.avgHr) !== Number(b.avgHr)) return false;
    shared += 1;
  }
  if (shared > 0) return true;
  return (
    Number.isFinite(da) &&
    Number.isFinite(db) &&
    Math.abs(da - db) <= 1 &&
    da >= 15
  );
}

/**
 * Shortcut dumps logged the same Watch session two hours later than the
 * Apple XML archive. Keep the earlier UTC copy.
 *
 * @param {Record<string, unknown>[]} workouts
 */
export function dedupeTwoHourWorkoutCopies(workouts) {
  const sorted = (workouts || [])
    .filter((w) => w && w.start)
    .sort((a, b) => String(a.start).localeCompare(String(b.start)));
  const later = new Set();
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const ta = Date.parse(String(a.start));
    if (!Number.isFinite(ta)) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      if (later.has(j)) continue;
      const b = sorted[j];
      const tb = Date.parse(String(b.start));
      if (!Number.isFinite(tb)) continue;
      const diff = tb - ta;
      if (diff > TWO_HOUR_MS + TWO_HOUR_SLOP_MS) break;
      if (
        Math.abs(diff - TWO_HOUR_MS) <= TWO_HOUR_SLOP_MS &&
        similarWorkoutStats(a, b)
      ) {
        later.add(j);
      }
    }
  }
  return sorted.filter((_, i) => !later.has(i));
}

function hmToMinutes(hm) {
  const m = String(hm || "").match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hmDiffMinutes(a, b) {
  const aa = hmToMinutes(a);
  const bb = hmToMinutes(b);
  if (aa == null || bb == null) return null;
  let d = Math.abs(aa - bb);
  if (d > 12 * 60) d = 24 * 60 - d;
  return d;
}

function isEarlierHm(a, b) {
  const aa = hmToMinutes(a);
  const bb = hmToMinutes(b);
  if (aa == null || bb == null) return false;
  if (aa <= 60 && bb >= 22 * 60) return false;
  if (bb <= 60 && aa >= 22 * 60) return true;
  return aa < bb;
}

function seriesFrom(src, camel, extra = {}) {
  if (Array.isArray(src[camel])) {
    return src[camel]
      .map((item) => {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const start = toIso(item.start ?? item.startDate ?? item.date);
          const value = item.value ?? item.Value;
          if (!start && value == null) return null;
          /** @type {Record<string, unknown>} */
          const row = {};
          if (start) row.start = start;
          const end = toIso(item.end ?? item.endDate);
          if (end) row.end = end;
          if (value != null && value !== "") {
            const num = finiteNumber(value);
            row.value = num != null ? num : clipStr(value, 80);
          }
          const name = clipStr(item.name ?? item.type ?? item.stage, 80);
          if (name) row.name = name;
          const unit = clipStr(item.unit, 24);
          if (unit) row.unit = unit;
          return row;
        }
        return null;
      })
      .filter(Boolean)
      .slice(0, MAX_SERIES);
  }
  const obj = src[camel];
  if (obj && typeof obj === "object") {
    return zipSeries(obj.starts ?? obj.start, obj.values ?? obj.value, {
      end: obj.ends ?? obj.end,
      unit: obj.units ?? obj.unit,
      name: obj.names ?? obj.name,
      ...extra,
    }).slice(0, MAX_SERIES);
  }
  const startsKey = `${camel}Starts`;
  const valuesKey = `${camel}Values`;
  if (src[startsKey] || src[valuesKey]) {
    return zipSeries(src[startsKey], src[valuesKey], extra).slice(0, MAX_SERIES);
  }
  return [];
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseHealthPayload(raw) {
  const src = unwrapPayload(raw);
  if (!src) return null;
  const workouts = collectWorkouts(src);
  const sleep = seriesFrom(src, "sleep", {
    end: src.sleepEnds,
    name: src.sleepNames,
  }).slice(0, MAX_SLEEP);
  const dailyKeys = [
    "steps",
    "walkRunDistance",
    "cyclingDistance",
    "flights",
    "exerciseMinutes",
    "standHours",
    "standMinutes",
    "activeCalories",
    "restingCalories",
    "restingHr",
    "walkingHr",
    "hrv",
    "respiratoryRate",
    "vo2Max",
    "wristTemp",
    "mindful",
    "timeInDaylight",
    "cardioRecovery",
    "walkingSpeed",
    "walkingStepLength",
    "walkingDoubleSupport",
    "walkingAsymmetry",
    "stairAscentSpeed",
    "stairDescentSpeed",
    "runningPower",
    "runningSpeed",
    "runningStride",
    "runningGroundContact",
    "runningVerticalOscillation",
    "environmentalAudio",
    "headphoneAudio",
    "physicalEffort",
    "cyclingSpeed",
    "cyclingCadence",
    "swimmingDistance",
    "stateOfMind",
    "uvIndex",
    "effortScore",
  ];
  /** @type {Record<string, unknown>} */
  const series = {};
  for (const key of dailyKeys) {
    /** @type {Record<string, unknown>} */
    const extra = {};
    if (src[`${key}Ends`]) extra.end = src[`${key}Ends`];
    if (src[`${key}Names`]) extra.name = src[`${key}Names`];
    const rows = seriesFrom(src, key, extra);
    if (rows.length) series[key] = rows;
  }

  const exportedAt =
    toIso(src.exportedAt ?? src.collectedAt ?? src.date) || new Date().toISOString();

  const hasAnything =
    workouts.length > 0 || sleep.length > 0 || Object.keys(series).length > 0;
  if (!hasAnything) return null;

  /** @type {Record<string, unknown>} */
  const out = {
    schemaVersion: 1,
    exportedAt,
    workouts,
    sleep,
    series,
  };
  const windowStart = toIso(src.windowStart);
  const windowEnd = toIso(src.windowEnd);
  if (windowStart) out.windowStart = windowStart;
  if (windowEnd) out.windowEnd = windowEnd;
  return out;
}

export async function readHealthMetaTimezone(_now = new Date()) {
  return HEALTH_TIMEZONE;
}

/**
 * Seattle clock, except the Aug 2026 Austin trip (after Aug 12 through Aug 26).
 * @param {string} iso
 */
export function healthTimezoneForIso(iso) {
  const chicagoDay = dateKeyInTz(String(iso || ""), HEALTH_AUSTIN_TIMEZONE);
  if (
    chicagoDay > HEALTH_AUSTIN_AFTER_DATE &&
    chicagoDay <= HEALTH_AUSTIN_UNTIL_DATE
  ) {
    return HEALTH_AUSTIN_TIMEZONE;
  }
  return HEALTH_TIMEZONE;
}

function tzForWorkout(w, override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  return healthTimezoneForIso(String(w?.start || ""));
}

/** @param {string} iso @param {string} timezone */
export function dateKeyInTz(iso, timezone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return y && m && d ? `${y}-${m}-${d}` : "";
}

/** @param {string} iso @param {string} timezone */
export function hmInTz(iso, timezone) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const h = parts.find((p) => p.type === "hour")?.value;
  const m = parts.find((p) => p.type === "minute")?.value;
  if (h == null || m == null) return "";
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

function formatDuration(min) {
  if (min == null) return "";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * @param {Record<string, unknown>} w
 * @param {string} timezone
 */
export function formatWorkoutLine(w, timezone) {
  const tz = tzForWorkout(w, timezone);
  const activity = String(w.activity || "Workout");
  const startHm = hmInTz(String(w.start || ""), tz);
  const endHm = w.end ? hmInTz(String(w.end), tz) : "";
  const dur = formatDuration(
    durationMinutes(w.durationMin, String(w.start || ""), String(w.end || ""))
  );
  const bits = [];
  if (typeof w.distanceMi === "number") bits.push(`${w.distanceMi} mi`);
  if (typeof w.energyKcal === "number") bits.push(`${w.energyKcal} kcal`);
  if (typeof w.avgHr === "number") bits.push(`avg HR ${w.avgHr}`);
  let time = startHm || "";
  if (startHm && endHm) time = `${startHm}–${endHm}`;
  else if (startHm) time = startHm;
  const head = dur ? `${time} (${dur})`.trim() : time;
  const extra = bits.length ? ` — ${bits.join(", ")}` : "";
  return `- **${activity}** ${head}${extra}`.replace(/\s+/g, " ").trim();
}

/**
 * @param {string} markdown
 * @returns {Map<string, { activity: string, start: string, line: string }[]>}
 */
export function parseWorkoutsMarkdown(markdown) {
  /** @type {Map<string, { activity: string, start: string, line: string }[]>} */
  const days = new Map();
  let day = "";
  for (const rawLine of String(markdown || "").split("\n")) {
    const line = rawLine.trimEnd();
    const dayMatch = line.match(/^## (\d{4}-\d{2}-\d{2})\s*$/);
    if (dayMatch) {
      day = dayMatch[1];
      if (!days.has(day)) days.set(day, []);
      continue;
    }
    if (!day || !line.startsWith("- ")) continue;
    const activityMatch = line.match(/^- \*\*(.+?)\*\*/);
    const activity = activityMatch ? activityMatch[1] : "Workout";
    const hm = line.match(/(\d{2}:\d{2})/);
    const startGuess = hm ? `${day}T${hm[1]}:00` : `${day}T00:00:00`;
    days.get(day).push({
      activity,
      start: startGuess,
      line,
    });
  }
  return days;
}

function renderWorkoutsMarkdown(byDay) {
  const days = [...byDay.keys()].sort().reverse();
  const parts = ["# Workouts", ""];
  for (const day of days) {
    const rows = (byDay.get(day) || []).slice();
    rows.sort((a, b) => String(b.start).localeCompare(String(a.start)));
    parts.push(`## ${day}`, "");
    for (const row of rows) parts.push(row.line);
    parts.push("");
  }
  return `${parts.join("\n").trim()}\n`;
}

/**
 * @param {Record<string, unknown>[]} workouts
 * @param {string} timezone
 */
export function buildWorkoutsMarkdown(workouts, timezone) {
  const unique = dedupeTwoHourWorkoutCopies(workouts);
  /** @type {Map<string, { activity: string, start: string, line: string }[]>} */
  const byDay = new Map();
  const seenMinute = new Set();
  for (const w of unique) {
    const tz = tzForWorkout(w, timezone);
    const day = dateKeyInTz(String(w.start || ""), tz);
    if (!day) continue;
    const minuteKey = `${day}|${workoutActivityKey(w)}|${String(w.start).slice(0, 16)}`;
    if (seenMinute.has(minuteKey)) continue;
    seenMinute.add(minuteKey);
    const rows = byDay.get(day) || [];
    rows.push({
      activity: String(w.activity || "Workout"),
      start: String(w.start),
      line: formatWorkoutLine(w, tz),
    });
    byDay.set(day, rows);
  }
  return renderWorkoutsMarkdown(byDay);
}

/**
 * @param {Record<string, unknown>[]} workouts
 * @param {string} existing
 * @param {string} timezone
 */
export function mergeWorkoutsMarkdown(workouts, existing, timezone) {
  const byDay = parseWorkoutsMarkdown(existing);
  for (const w of dedupeTwoHourWorkoutCopies(workouts)) {
    const tz = tzForWorkout(w, timezone);
    const day = dateKeyInTz(String(w.start || ""), tz);
    if (!day) continue;
    const line = formatWorkoutLine(w, tz);
    const startHm = hmInTz(String(w.start || ""), tz);
    const activity = String(w.activity);
    const rows = byDay.get(day) || [];
    const exact = rows.find(
      (r) =>
        r.activity.toLowerCase() === activity.toLowerCase() &&
        (r.line === line || r.start.slice(0, 16) === String(w.start).slice(0, 16))
    );
    if (exact) {
      exact.activity = activity;
      exact.start = String(w.start);
      exact.line = line;
      byDay.set(day, rows);
      continue;
    }
    const twin = rows.find((r) => {
      if (r.activity.toLowerCase() !== activity.toLowerCase()) return false;
      const oldHm = (r.line.match(/(\d{2}:\d{2})/) || [])[1];
      return hmDiffMinutes(oldHm, startHm) === 120;
    });
    if (twin) {
      const oldHm = (twin.line.match(/(\d{2}:\d{2})/) || [])[1];
      if (isEarlierHm(startHm, oldHm)) {
        twin.activity = activity;
        twin.start = String(w.start);
        twin.line = line;
      }
      byDay.set(day, rows);
      continue;
    }
    rows.push({ activity, start: String(w.start), line });
    byDay.set(day, rows);
  }
  return renderWorkoutsMarkdown(byDay);
}

function shortcutWorkoutMatchesExport(w, exportWorkouts) {
  const t = Date.parse(String(w.start || ""));
  if (!Number.isFinite(t)) return { same: false, plus2h: false };
  let same = false;
  let plus2h = false;
  for (const e of exportWorkouts) {
    if (workoutActivityKey(e) !== workoutActivityKey(w)) continue;
    const te = Date.parse(String(e.start || ""));
    if (!Number.isFinite(te)) continue;
    const d = t - te;
    if (Math.abs(d) <= TWO_HOUR_SLOP_MS) same = true;
    if (Math.abs(d - TWO_HOUR_MS) <= TWO_HOUR_SLOP_MS) plus2h = true;
  }
  return { same, plus2h };
}

/**
 * Point Health files at Seattle clock time and drop the two-hour shortcut copies.
 *
 * @param {{ dir?: string }} [opts]
 */
export async function repairHealthSeattleTimezone(opts = {}) {
  const root = healthDir(opts.dir);
  const rawDir = join(root, "raw");
  let names = [];
  try {
    names = await readdir(rawDir);
  } catch {
    names = [];
  }
  /** @type {Record<string, unknown>[]} */
  const exportWorkouts = [];
  /** @type {{ path: string, pretty: boolean, payload: Record<string, unknown> }[]} */
  const shortcutFiles = [];
  let exportFiles = 0;
  let shifted = 0;

  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const p = join(rawDir, name);
    const text = await readFile(p, "utf8");
    if (name.startsWith("apple-export-")) {
      const next = text.replace(
        /"timezone":\s*"America\/Chicago"/g,
        `"timezone":"${HEALTH_TIMEZONE}"`
      );
      if (next !== text) await writeFile(p, next, "utf8");
      const payload = JSON.parse(next);
      exportWorkouts.push(
        ...(Array.isArray(payload.workouts) ? payload.workouts : [])
      );
      exportFiles += 1;
      continue;
    }
    const payload = JSON.parse(text);
    shortcutFiles.push({
      path: p,
      pretty: /^\s{2}"/m.test(text),
      payload,
    });
  }

  for (const file of shortcutFiles) {
    file.payload.timezone = HEALTH_TIMEZONE;
    const workouts = Array.isArray(file.payload.workouts)
      ? file.payload.workouts
      : [];
    for (const w of workouts) {
      const { same, plus2h } = shortcutWorkoutMatchesExport(w, exportWorkouts);
      if (same || !plus2h) continue;
      w.start = shiftIso(w.start, -TWO_HOUR_MS);
      if (w.end) w.end = shiftIso(w.end, -TWO_HOUR_MS);
      shifted += 1;
    }
    const json = file.pretty
      ? `${JSON.stringify(file.payload, null, 2)}\n`
      : `${JSON.stringify(file.payload)}\n`;
    await writeFile(file.path, json, "utf8");
  }

  const markdown = buildWorkoutsMarkdown(exportWorkouts);
  await writeFile(join(root, "workouts.md"), markdown, "utf8");
  const prev = await readHealthState(opts.dir);
  await writeHealthState(
    {
      ...prev,
      timezone: HEALTH_TIMEZONE,
    },
    opts.dir
  );
  return {
    exportFiles,
    shortcutFiles: shortcutFiles.length,
    shiftedWorkouts: shifted,
    workouts: exportWorkouts.length,
  };
}

function rawStamp(iso) {
  const d = new Date(Date.parse(iso) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}${min}${s}Z`;
}

function monthKey(iso) {
  const d = new Date(Date.parse(iso) || Date.now());
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function readHealthState(dir) {
  try {
    const raw = JSON.parse(await readFile(join(healthDir(dir), "state.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

export async function writeHealthState(state, dir) {
  const root = healthDir(dir);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

export function isShortcutHealthRawFile(name) {
  const base = String(name || "")
    .split("/")
    .pop();
  return Boolean(base) && base.endsWith(".json") && !base.startsWith("apple-export-");
}

export async function listHealthRawFiles(dir) {
  const rawDir = join(healthDir(dir), "raw");
  let names = [];
  try {
    names = await readdir(rawDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => join(rawDir, n));
}

export async function hasUnprocessedHealthDumps(dir) {
  const files = (await listHealthRawFiles(dir)).filter((p) =>
    isShortcutHealthRawFile(p)
  );
  if (!files.length) return false;
  const state = await readHealthState(dir);
  const cursor = String(state.lastTakeawaysAt || "").trim();
  if (!cursor || Number.isNaN(Date.parse(cursor))) return true;
  const cursorMs = Date.parse(cursor);
  for (let i = files.length - 1; i >= 0; i--) {
    try {
      const st = await stat(files[i]);
      if (st.mtimeMs > cursorMs) return true;
      const parsed = JSON.parse(await readFile(files[i], "utf8"));
      const at = Date.parse(String(parsed.receivedAt || parsed.exportedAt || ""));
      if (Number.isFinite(at) && at > cursorMs) return true;
    } catch {
      /* skip unreadable */
    }
  }
  return false;
}

/**
 * @param {unknown} raw
 * @param {{ dir?: string, source?: string, timezone?: string, git?: boolean }} [opts]
 */
export async function writeHealthDump(raw, opts = {}) {
  const parsed = parseHealthPayload(raw);
  if (!parsed) {
    const err = new Error("health payload empty or invalid");
    err.status = 400;
    throw err;
  }
  const receivedAt = new Date().toISOString();
  parsed.receivedAt = receivedAt;
  if (opts.source) parsed.source = clipStr(opts.source, 24);
  const timezone = String(opts.timezone || "").trim() || (await readHealthMetaTimezone());
  parsed.timezone = timezone;

  const root = healthDir(opts.dir);
  const rawDir = join(root, "raw");
  await mkdir(rawDir, { recursive: true });

  const stamp = rawStamp(receivedAt);
  const rawFile = join(rawDir, `${stamp}.json`);
  await writeFile(rawFile, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

  const jsonl = {
    receivedAt,
    exportedAt: parsed.exportedAt,
    rawFile: `raw/${stamp}.json`,
    workoutCount: Array.isArray(parsed.workouts) ? parsed.workouts.length : 0,
    sleepCount: Array.isArray(parsed.sleep) ? parsed.sleep.length : 0,
    seriesKeys: Object.keys(parsed.series || {}),
  };
  await appendFile(
    join(root, `log-${monthKey(receivedAt)}.jsonl`),
    `${JSON.stringify(jsonl)}\n`,
    "utf8"
  );

  const workoutsPath = join(root, "workouts.md");
  let existing = "";
  try {
    existing = await readFile(workoutsPath, "utf8");
  } catch {
    existing = "";
  }
  const merged = mergeWorkoutsMarkdown(
    /** @type {Record<string, unknown>[]} */ (parsed.workouts || []),
    existing
  );
  await writeFile(workoutsPath, merged, "utf8");

  const prev = await readHealthState(opts.dir);
  await writeHealthState(
    {
      ...prev,
      lastIngestAt: receivedAt,
      timezone,
    },
    opts.dir
  );

  if (opts.git !== false && !opts.dir) {
    gitAddCommitPush({
      paths: [HEALTH_REL],
      message: `health: ingest ${dateKeyInTz(receivedAt, timezone)}`,
    }).catch((err) => console.error("[phone-health] git", err));
  }

  return {
    receivedAt,
    exportedAt: parsed.exportedAt,
    rawFile: `raw/${stamp}.json`,
    workoutCount: jsonl.workoutCount,
    sleepCount: jsonl.sleepCount,
  };
}

/**
 * Constant-time compare for the Shortcut ingest token.
 * @param {string|null|undefined} provided
 */
export function healthTokenMatches(provided) {
  const expected = String(
    process.env.HEALTH_INGEST_TOKEN || process.env.LOCATION_INGEST_TOKEN || ""
  ).trim();
  const got = String(provided || "").trim();
  if (!expected || !got) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
