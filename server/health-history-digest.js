/**
 * Compact rollups of apple-export-*.json so Composer can read history
 * without loading 40MB year files.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHIVE_ONLY_SERIES,
  SHORTCUT_SERIES_CAMELS,
} from "./health-shortcut-build.js";
import { dateKeyInTz, healthDir, healthTimezoneForIso, HEALTH_TIMEZONE } from "./phone-health.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const SUMMER_START = "2026-06-10";

const LAST_KEYS = new Set([
  "restingHr",
  "walkingHr",
  "hrv",
  "vo2Max",
  "wristTemp",
  "cardioRecovery",
]);

const SLEEP_ASLEEP = new Set(["Core", "Deep", "REM", "Asleep"]);

function inRange(day, startDate, endDate) {
  if (!day) return false;
  if (startDate && day < startDate) return false;
  if (endDate && day > endDate) return false;
  return true;
}

function emptyDay() {
  return {
    workouts: [],
    asleepMin: 0,
    awakeMin: 0,
    sums: {},
    last: {},
  };
}

function bucket(days, day) {
  let b = days.get(day);
  if (!b) {
    b = emptyDay();
    days.set(day, b);
  }
  return b;
}

function minutesBetween(start, end) {
  const a = Date.parse(String(start || ""));
  const b = Date.parse(String(end || ""));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return (b - a) / 60000;
}

/**
 * @param {Record<string, unknown>} payload
 * @param {Map<string, ReturnType<typeof emptyDay>>} days
 * @param {{ timezone: string, startDate?: string, endDate?: string, seriesAllow?: string[], seriesDeny?: string[] }} opts
 */
export function ingestHealthPayload(payload, days, opts) {
  const timezone = opts.timezone;
  const allow = opts.seriesAllow ? new Set(opts.seriesAllow) : null;
  const deny = opts.seriesDeny ? new Set(opts.seriesDeny) : null;

  for (const w of payload.workouts || []) {
    const tz = healthTimezoneForIso(String(w.start || "")) || timezone;
    const day = dateKeyInTz(String(w.start || ""), tz);
    if (!inRange(day, opts.startDate, opts.endDate)) continue;
    const row = bucket(days, day);
    row.workouts.push({
      activity: String(w.activity || "Workout"),
      durationMin: Number(w.durationMin) || 0,
      distanceMi: w.distanceMi,
      avgHr: w.avgHr,
      energyKcal: w.energyKcal,
    });
  }

  for (const s of payload.sleep || []) {
    const day = dateKeyInTz(String(s.start || ""), timezone);
    if (!inRange(day, opts.startDate, opts.endDate)) continue;
    const min = minutesBetween(s.start, s.end);
    const row = bucket(days, day);
    const name = String(s.value || s.name || "");
    if (SLEEP_ASLEEP.has(name)) row.asleepMin += min;
    else if (name === "Awake") row.awakeMin += min;
  }

  const series = payload.series && typeof payload.series === "object" ? payload.series : {};
  for (const [camel, rows] of Object.entries(series)) {
    if (!Array.isArray(rows)) continue;
    if (allow && !allow.has(camel)) continue;
    if (deny && deny.has(camel)) continue;
    for (const item of rows) {
      const day = dateKeyInTz(String(item.start || ""), timezone);
      if (!inRange(day, opts.startDate, opts.endDate)) continue;
      const n = Number(item.value);
      if (!Number.isFinite(n)) continue;
      const row = bucket(days, day);
      if (LAST_KEYS.has(camel)) {
        const prev = row.last[camel];
        if (!prev || String(item.start) > prev.start) {
          row.last[camel] = { start: String(item.start), value: n };
        }
      } else {
        row.sums[camel] = (row.sums[camel] || 0) + n;
      }
    }
  }
}

function fmtHours(min) {
  if (!min) return "";
  return `${(min / 60).toFixed(1)}h`;
}

function fmtNum(n, digits = 0) {
  if (n == null || !Number.isFinite(n)) return "";
  return digits ? n.toFixed(digits) : String(Math.round(n));
}

export function formatDayLine(day, row) {
  const parts = [day];
  const sleep = fmtHours(row.asleepMin);
  if (sleep) {
    const awake = row.awakeMin ? ` awake ${Math.round(row.awakeMin)}m` : "";
    parts.push(`sleep ${sleep}${awake}`);
  }
  if (row.sums.steps) parts.push(`steps ${fmtNum(row.sums.steps)}`);
  if (row.last.restingHr) parts.push(`rhr ${fmtNum(row.last.restingHr.value)}`);
  if (row.last.hrv) parts.push(`hrv ${fmtNum(row.last.hrv.value)}`);
  if (row.sums.exerciseMinutes) parts.push(`ex ${fmtNum(row.sums.exerciseMinutes)}m`);
  if (row.sums.swimmingDistance) parts.push(`swim ${fmtNum(row.sums.swimmingDistance)}yd`);
  if (row.sums.effortScore) parts.push(`effort ${fmtNum(row.sums.effortScore, 1)}`);
  if (row.sums.timeInDaylight) parts.push(`daylight ${fmtNum(row.sums.timeInDaylight)}m`);
  if (row.workouts.length) {
    const wtxt = row.workouts
      .map((w) => {
        const bits = [w.activity, w.durationMin ? `${Math.round(w.durationMin)}m` : ""]
          .filter(Boolean);
        if (w.distanceMi) bits.push(`${w.distanceMi}mi`);
        if (w.avgHr) bits.push(`HR${w.avgHr}`);
        return bits.join(" ");
      })
      .join("; ");
    parts.push(wtxt);
  }
  return parts.join(" | ");
}

function monthKey(day) {
  return String(day || "").slice(0, 7);
}

export function formatMonthBlock(month, rows) {
  let workouts = 0;
  /** @type {Record<string, number>} */
  const byType = {};
  let sleepMin = 0;
  let sleepDays = 0;
  let steps = 0;
  let stepDays = 0;
  let swim = 0;
  let daylight = 0;
  let effort = 0;
  let effortDays = 0;
  for (const row of rows) {
    workouts += row.workouts.length;
    for (const w of row.workouts) {
      byType[w.activity] = (byType[w.activity] || 0) + 1;
    }
    if (row.asleepMin) {
      sleepMin += row.asleepMin;
      sleepDays += 1;
    }
    if (row.sums.steps) {
      steps += row.sums.steps;
      stepDays += 1;
    }
    swim += row.sums.swimmingDistance || 0;
    daylight += row.sums.timeInDaylight || 0;
    if (row.sums.effortScore) {
      effort += row.sums.effortScore;
      effortDays += 1;
    }
  }
  const types = Object.entries(byType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");
  const lines = [
    `## ${month}`,
    "",
    `${workouts} workouts${types ? ` (${types})` : ""}.`,
  ];
  if (sleepDays) lines.push(`Sleep ${fmtHours(sleepMin / sleepDays)} avg over ${sleepDays} nights.`);
  if (stepDays) lines.push(`Steps ${fmtNum(steps / stepDays)}/day over ${stepDays} days.`);
  if (swim) lines.push(`Swim ${fmtNum(swim)} yd.`);
  if (daylight) lines.push(`Daylight ${fmtNum(daylight)} min.`);
  if (effortDays) lines.push(`Workout effort samples on ${effortDays} days.`);
  lines.push("");
  return lines.join("\n");
}

async function readExportFiles(dir) {
  const rawDir = join(healthDir(dir), "raw");
  let names = [];
  try {
    names = await readdir(rawDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.filter((x) => x.startsWith("apple-export-") && x.endsWith(".json")).sort()) {
    out.push(JSON.parse(await readFile(join(rawDir, n), "utf8")));
  }
  return out;
}

/**
 * @param {{ dir?: string, timezone?: string, today?: string }} [opts]
 */
export async function writeHealthDigests(opts = {}) {
  const timezone = opts.timezone || HEALTH_TIMEZONE;
  const today = opts.today || dateKeyInTz(new Date().toISOString(), timezone);
  const payloads = await readExportFiles(opts.dir);
  const historyDays = new Map();
  const summerDays = new Map();
  const shortcutAllow = SHORTCUT_SERIES_CAMELS.filter((c) => c !== "sleep");

  for (const payload of payloads) {
    ingestHealthPayload(payload, historyDays, { timezone });
    ingestHealthPayload(payload, summerDays, {
      timezone,
      startDate: SUMMER_START,
      endDate: today,
      seriesAllow: shortcutAllow,
      seriesDeny: ARCHIVE_ONLY_SERIES,
    });
  }

  const histMonths = [...new Set([...historyDays.keys()].map(monthKey))].sort();
  const histParts = [
    "# Health history digest",
    "",
    `Timezone ${timezone}. Monthly rollup of the Apple XML archive. Includes daylight and physical-effort totals. Not a medical chart.`,
    "",
  ];
  for (const month of histMonths) {
    const rows = [...historyDays.entries()]
      .filter(([d]) => monthKey(d) === month)
      .map(([, r]) => r);
    histParts.push(formatMonthBlock(month, rows));
  }

  const summerKeys = [...summerDays.keys()].sort();
  const summerParts = [
    "# Summer shortcut digest",
    "",
    `Days ${SUMMER_START} through ${today} (${timezone}). Only series the iPhone shortcut can send. No UV Index, State of Mind, cycling speed/cadence, Time in Daylight, Physical Effort, or Workout Effort Score.`,
    "",
  ];
  for (const day of summerKeys) {
    summerParts.push(formatDayLine(day, summerDays.get(day)));
  }
  summerParts.push("");

  const root = healthDir(opts.dir);
  await mkdir(root, { recursive: true });
  const historyPath = join(root, "digest-history.md");
  const summerPath = join(root, "digest-summer-shortcut.md");
  await writeFile(historyPath, `${histParts.join("\n").trim()}\n`, "utf8");
  await writeFile(summerPath, summerParts.join("\n"), "utf8");
  return {
    historyPath,
    summerPath,
    historyMonths: histMonths.length,
    summerDays: summerKeys.length,
    timezone,
    today,
  };
}

void ROOT;
