/**
 * Import an Apple Health XML export (the zip from Health → Export All Health Data)
 * into education/<email>/health/raw as yearly dumps matching the shortcut schema.
 *
 * Skips raw heart-rate beats, CDA, GPX, and 18+ types. Compact JSON so git stays
 * under GitHub's 100MB file cap. Pretty-printing a full history would not.
 *
 *   node --env-file=.env health-apple-export.js [path-to.zip]
 *   node --env-file=.env health-apple-export.js --sleep-only [path-to.zip]
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  HEALTH_TIMEZONE,
  healthDir,
  normalizeWorkout,
  readHealthState,
  writeHealthState,
  buildWorkoutsMarkdown,
} from "./phone-health.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ZIP = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/Downloads",
  "health export aug 20 2026.zip"
);
const SLEEP_CLEANED_ZIP = join(
  homedir(),
  "Library/Mobile Documents/com~apple~CloudDocs/Downloads",
  "health export aug 20 2026 fake data removed.zip"
);
const XML_ENTRY = "apple_health_export/export.xml";
const MAX_FILE_BYTES = 90_000_000;

/** HealthKit type → series camel (sleep is stored on the payload, not series). */
export const RECORD_TYPE_MAP = {
  HKQuantityTypeIdentifierStepCount: "steps",
  HKQuantityTypeIdentifierDistanceWalkingRunning: "walkRunDistance",
  HKQuantityTypeIdentifierDistanceCycling: "cyclingDistance",
  HKQuantityTypeIdentifierFlightsClimbed: "flights",
  HKQuantityTypeIdentifierAppleExerciseTime: "exerciseMinutes",
  HKQuantityTypeIdentifierAppleStandTime: "standMinutes",
  HKQuantityTypeIdentifierActiveEnergyBurned: "activeCalories",
  HKQuantityTypeIdentifierBasalEnergyBurned: "restingCalories",
  HKQuantityTypeIdentifierRestingHeartRate: "restingHr",
  HKQuantityTypeIdentifierWalkingHeartRateAverage: "walkingHr",
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: "hrv",
  HKQuantityTypeIdentifierRespiratoryRate: "respiratoryRate",
  HKQuantityTypeIdentifierVO2Max: "vo2Max",
  HKQuantityTypeIdentifierAppleSleepingWristTemperature: "wristTemp",
  HKQuantityTypeIdentifierTimeInDaylight: "timeInDaylight",
  HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: "cardioRecovery",
  HKQuantityTypeIdentifierWalkingSpeed: "walkingSpeed",
  HKQuantityTypeIdentifierWalkingStepLength: "walkingStepLength",
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: "walkingDoubleSupport",
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: "walkingAsymmetry",
  HKQuantityTypeIdentifierStairAscentSpeed: "stairAscentSpeed",
  HKQuantityTypeIdentifierStairDescentSpeed: "stairDescentSpeed",
  HKQuantityTypeIdentifierRunningPower: "runningPower",
  HKQuantityTypeIdentifierRunningSpeed: "runningSpeed",
  HKQuantityTypeIdentifierRunningStrideLength: "runningStride",
  HKQuantityTypeIdentifierRunningGroundContactTime: "runningGroundContact",
  HKQuantityTypeIdentifierRunningVerticalOscillation: "runningVerticalOscillation",
  HKQuantityTypeIdentifierEnvironmentalAudioExposure: "environmentalAudio",
  HKQuantityTypeIdentifierHeadphoneAudioExposure: "headphoneAudio",
  HKQuantityTypeIdentifierPhysicalEffort: "physicalEffort",
  HKQuantityTypeIdentifierCyclingSpeed: "cyclingSpeed",
  HKQuantityTypeIdentifierCyclingCadence: "cyclingCadence",
  HKQuantityTypeIdentifierDistanceSwimming: "swimmingDistance",
  HKQuantityTypeIdentifierUVExposure: "uvIndex",
  HKQuantityTypeIdentifierWorkoutEffortScore: "effortScore",
  HKCategoryTypeIdentifierMindfulSession: "mindful",
};

const SLEEP_VALUES = {
  HKCategoryValueSleepAnalysisInBed: "InBed",
  HKCategoryValueSleepAnalysisAsleepUnspecified: "Asleep",
  HKCategoryValueSleepAnalysisAsleepCore: "Core",
  HKCategoryValueSleepAnalysisAsleepDeep: "Deep",
  HKCategoryValueSleepAnalysisAsleepREM: "REM",
  HKCategoryValueSleepAnalysisAwake: "Awake",
  HKCategoryValueSleepAnalysisAsleep: "Asleep",
};

export function parseAttrs(line) {
  /** @type {Record<string, string>} */
  const out = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[2];
  return out;
}

/** Apple Health timestamps look like `2026-03-21 10:03:57 -0500`. */
export function appleDateToIso(raw) {
  const s = String(raw || "").trim();
  const m = s.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/
  );
  if (!m) return "";
  const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

export function workoutActivityName(type) {
  const s = String(type || "").replace(/^HKWorkoutActivityType/, "");
  if (!s) return "Workout";
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

function compactNum(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n)) return n;
  return Math.round(n * 1e6) / 1e6;
}

function sampleRow(startIso, value, endIso) {
  /** @type {Record<string, unknown>} */
  const row = { start: startIso, value };
  if (endIso && endIso !== startIso) row.end = endIso;
  return row;
}

function yearKey(startDate) {
  return String(startDate || "").slice(0, 4);
}

function quarterKey(startDate) {
  const y = yearKey(startDate);
  const month = Number(String(startDate || "").slice(5, 7));
  if (!y || !Number.isFinite(month) || month < 1) return y;
  return `${y}-q${Math.ceil(month / 3)}`;
}

function distanceMiles(sum, unit) {
  const n = Number(sum);
  if (!Number.isFinite(n) || n < 0) return null;
  const u = String(unit || "mi").toLowerCase();
  if (u === "km") return Math.round(n * 0.621371 * 100) / 100;
  if (u === "m") return Math.round((n / 1609.344) * 100) / 100;
  if (u === "yd" || u === "yds") return Math.round((n / 1760) * 100) / 100;
  return Math.round(n * 100) / 100;
}

function emptyBucket() {
  return {
    workouts: [],
    sleep: [],
    /** @type {Record<string, Record<string, unknown>[]>} */
    series: {},
  };
}

/**
 * @param {Iterable<string> | AsyncIterable<string>} lines
 * @param {{ sleepOnly?: boolean }} [opts]
 */
export async function parseExportXmlLines(lines, opts = {}) {
  const sleepOnly = opts.sleepOnly === true;
  /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
  const byYear = new Map();
  /** @type {string} */
  let exportedAt = "";
  /** @type {null | { attrs: Record<string, string>, avgHr?: string, energy?: string, distance?: string, distanceUnit?: string }} */
  let workout = null;
  let records = 0;
  let skippedHr = 0;

  const bucket = (startDate) => {
    const y = yearKey(startDate) || "unknown";
    let b = byYear.get(y);
    if (!b) {
      b = emptyBucket();
      byYear.set(y, b);
    }
    return b;
  };

  const pushSeries = (startDate, camel, row) => {
    const b = bucket(startDate);
    if (!b.series[camel]) b.series[camel] = [];
    b.series[camel].push(row);
  };

  const finishWorkout = () => {
    if (!workout) return;
    const a = workout.attrs;
    const startIso = appleDateToIso(a.startDate);
    if (!startIso) {
      workout = null;
      return;
    }
    const endIso = appleDateToIso(a.endDate);
    const duration = compactNum(a.duration);
    const w = normalizeWorkout({
      activity: workoutActivityName(a.workoutActivityType),
      start: startIso,
      end: endIso,
      durationMin: duration,
      distanceMi: distanceMiles(workout.distance, workout.distanceUnit),
      energyKcal: workout.energy,
      avgHr: workout.avgHr,
      source: a.sourceName,
    });
    if (w) bucket(a.startDate).workouts.push(w);
    workout = null;
  };

  const ingestRecord = (a) => {
    const type = a.type || "";
    if (sleepOnly && type !== "HKCategoryTypeIdentifierSleepAnalysis") {
      if (type === "HKQuantityTypeIdentifierHeartRate") skippedHr += 1;
      return;
    }
    if (type === "HKQuantityTypeIdentifierHeartRate") {
      skippedHr += 1;
      return;
    }
    const startIso = appleDateToIso(a.startDate);
    if (!startIso) return;
    const endIso = appleDateToIso(a.endDate);
    if (type === "HKCategoryTypeIdentifierSleepAnalysis") {
      const name = SLEEP_VALUES[a.value];
      if (!name) return;
      bucket(a.startDate).sleep.push(sampleRow(startIso, name, endIso));
      records += 1;
      return;
    }
    const camel = RECORD_TYPE_MAP[type];
    if (!camel) return;
    let value;
    if (camel === "mindful") {
      const startMs = Date.parse(startIso);
      const endMs = Date.parse(endIso || startIso);
      const min = Math.round((endMs - startMs) / 60000);
      value = min > 0 ? min : 1;
    } else {
      value = compactNum(a.value);
    }
    if (value == null) return;
    pushSeries(a.startDate, camel, sampleRow(startIso, value, endIso));
    records += 1;
  };

  for await (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith("<ExportDate")) {
      exportedAt = appleDateToIso(parseAttrs(t).value) || exportedAt;
      continue;
    }
    if (t.startsWith("<Record")) {
      ingestRecord(parseAttrs(t));
      continue;
    }
    if (sleepOnly) continue;
    if (t.startsWith("<Workout ") || t === "<Workout>") {
      finishWorkout();
      workout = { attrs: parseAttrs(t) };
      continue;
    }
    if (workout && t.startsWith("<WorkoutStatistics")) {
      const a = parseAttrs(t);
      const typ = a.type || "";
      if (typ === "HKQuantityTypeIdentifierHeartRate" && a.average) {
        workout.avgHr = a.average;
      } else if (typ === "HKQuantityTypeIdentifierActiveEnergyBurned" && a.sum) {
        workout.energy = a.sum;
      } else if (
        (typ === "HKQuantityTypeIdentifierDistanceWalkingRunning" ||
          typ === "HKQuantityTypeIdentifierDistanceCycling" ||
          typ === "HKQuantityTypeIdentifierDistanceSwimming") &&
        a.sum
      ) {
        workout.distance = a.sum;
        workout.distanceUnit = a.unit;
      }
      continue;
    }
    if (workout && t.includes("</Workout>")) finishWorkout();
  }
  finishWorkout();

  return { byYear, exportedAt, records, skippedHr };
}

function byteLen(s) {
  return Buffer.byteLength(s, "utf8");
}

function payloadFor(bucket, exportedAt, receivedAt, timezone) {
  const series = {};
  for (const [k, rows] of Object.entries(bucket.series)) {
    if (rows.length) series[k] = rows;
  }
  return {
    schemaVersion: 1,
    exportedAt,
    receivedAt,
    source: "apple-export",
    timezone,
    workouts: bucket.workouts,
    sleep: bucket.sleep,
    series,
  };
}

function splitBucketByQuarter(year, bucket) {
  /** @type {Map<string, ReturnType<typeof emptyBucket>>} */
  const parts = new Map();
  const take = (start, kind, row) => {
    const q = quarterKey(start) || `${year}-q1`;
    let b = parts.get(q);
    if (!b) {
      b = emptyBucket();
      parts.set(q, b);
    }
    if (kind === "workouts") b.workouts.push(row);
    else if (kind === "sleep") b.sleep.push(row);
    else {
      if (!b.series[kind]) b.series[kind] = [];
      b.series[kind].push(row);
    }
  };
  for (const w of bucket.workouts) take(String(w.start || ""), "workouts", w);
  for (const s of bucket.sleep) take(String(s.start || ""), "sleep", s);
  for (const [camel, rows] of Object.entries(bucket.series)) {
    for (const row of rows) take(String(row.start || ""), camel, row);
  }
  return parts;
}

async function parseExportZip(zipPath, parseOpts = {}) {
  const child = spawn("unzip", ["-p", zipPath, XML_ENTRY], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (buf) => {
    stderr += String(buf);
  });
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const parsed = await parseExportXmlLines(rl, parseOpts);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    throw new Error(`unzip failed (${code}): ${stderr.trim() || zipPath}`);
  }
  return parsed;
}

function encodeHealthJson(payload, pretty) {
  return pretty ? `${JSON.stringify(payload, null, 2)}\n` : `${JSON.stringify(payload)}\n`;
}

/**
 * Sleep samples from a parsed export that fall in a dump's previous window.
 * Latest dump also keeps anything newer than its last sample.
 *
 * @param {Record<string, unknown>[]} allSleep
 * @param {Record<string, unknown>[]} existing
 * @param {{ includeNewer?: boolean }} [opts]
 */
export function sleepForDumpWindow(allSleep, existing, opts = {}) {
  const starts = (existing || [])
    .map((s) => String(s.start || ""))
    .filter(Boolean)
    .sort();
  if (!starts.length) return [];
  const min = starts[0];
  const max = opts.includeNewer ? "\uffff" : starts[starts.length - 1];
  return allSleep.filter((s) => {
    const t = String(s.start || "");
    return t >= min && t <= max;
  });
}

/**
 * @param {{ zipPath?: string, dir?: string, timezone?: string }} [opts]
 */
export async function importAppleHealthExport(opts = {}) {
  const zipPath = opts.zipPath || DEFAULT_ZIP;
  const root = healthDir(opts.dir);
  const rawDir = join(root, "raw");
  await mkdir(rawDir, { recursive: true });

  const parsed = await parseExportZip(zipPath);
  const receivedAt = new Date().toISOString();
  const exportedAt = parsed.exportedAt || receivedAt;
  const prev = await readHealthState(opts.dir);
  const timezone =
    String(opts.timezone || "").trim() ||
    String(prev.timezone || "").trim() ||
    HEALTH_TIMEZONE;

  /** @type {Record<string, unknown>[]} */
  const allWorkouts = [];
  /** @type {{ name: string, bytes: number, workoutCount: number, sleepCount: number, seriesKeys: string[] }[]} */
  const files = [];

  const years = [...parsed.byYear.keys()].filter((y) => y !== "unknown").sort();
  for (const year of years) {
    const bucket = parsed.byYear.get(year);
    if (!bucket) continue;
    let pieces = new Map([[year, bucket]]);
    const trial = JSON.stringify(payloadFor(bucket, exportedAt, receivedAt, timezone));
    if (byteLen(trial) > MAX_FILE_BYTES) {
      pieces = splitBucketByQuarter(year, bucket);
    }
    for (const [stamp, part] of [...pieces.entries()].sort()) {
      allWorkouts.push(...part.workouts);
      const payload = payloadFor(part, exportedAt, receivedAt, timezone);
      const json = `${JSON.stringify(payload)}\n`;
      const bytes = byteLen(json);
      if (bytes > 100_000_000) {
        throw new Error(`apple-export-${stamp}.json is ${bytes} bytes (GitHub max 100MB)`);
      }
      const name = `apple-export-${stamp}.json`;
      await writeFile(join(rawDir, name), json, "utf8");
      const seriesKeys = Object.keys(payload.series);
      files.push({
        name,
        bytes,
        workoutCount: part.workouts.length,
        sleepCount: part.sleep.length,
        seriesKeys,
      });
      await appendFile(
        join(root, `log-${receivedAt.slice(0, 7)}.jsonl`),
        `${JSON.stringify({
          receivedAt,
          exportedAt,
          rawFile: `raw/${name}`,
          workoutCount: part.workouts.length,
          sleepCount: part.sleep.length,
          seriesKeys,
        })}\n`,
        "utf8"
      );
    }
  }

  const workoutsPath = join(root, "workouts.md");
  await writeFile(
    workoutsPath,
    buildWorkoutsMarkdown(allWorkouts),
    "utf8"
  );
  await writeHealthState(
    {
      ...prev,
      lastIngestAt: receivedAt,
      timezone,
    },
    opts.dir
  );

  return {
    zipPath,
    exportedAt,
    receivedAt,
    records: parsed.records,
    skippedHr: parsed.skippedHr,
    files,
    workoutCount: allWorkouts.length,
  };
}

/**
 * Replace sleep on existing dumps from an Apple XML zip. Does not touch
 * workouts, series, or workouts.md.
 *
 * @param {{ zipPath?: string, dir?: string }} [opts]
 */
export async function replaceSleepFromAppleExport(opts = {}) {
  const zipPath = opts.zipPath || SLEEP_CLEANED_ZIP;
  const rawDir = join(healthDir(opts.dir), "raw");
  const parsed = await parseExportZip(zipPath, { sleepOnly: true });

  /** @type {Map<string, Record<string, unknown>[]>} */
  const sleepByYear = new Map();
  /** @type {Record<string, unknown>[]} */
  const allSleep = [];
  for (const [year, bucket] of parsed.byYear) {
    if (year === "unknown") continue;
    sleepByYear.set(year, bucket.sleep);
    allSleep.push(...bucket.sleep);
  }
  allSleep.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));

  let names = [];
  try {
    names = await readdir(rawDir);
  } catch {
    names = [];
  }
  const yearFiles = names
    .filter((n) => n.startsWith("apple-export-") && n.endsWith(".json"))
    .sort();
  const dumpFiles = names
    .filter((n) => n.endsWith(".json") && !n.startsWith("apple-export-") && n !== ".gitkeep")
    .sort();
  const latestDump = dumpFiles.at(-1) || "";

  /** @type {{ name: string, before: number, after: number }[]} */
  const files = [];

  for (const name of yearFiles) {
    const stamp = name.replace(/^apple-export-/, "").replace(/\.json$/, "");
    const year = stamp.slice(0, 4);
    const path = join(rawDir, name);
    const payload = JSON.parse(await readFile(path, "utf8"));
    const before = Array.isArray(payload.sleep) ? payload.sleep.length : 0;
    payload.sleep = sleepByYear.get(year) || [];
    await writeFile(path, encodeHealthJson(payload, false), "utf8");
    files.push({ name, before, after: payload.sleep.length });
  }

  for (const name of dumpFiles) {
    const path = join(rawDir, name);
    const payload = JSON.parse(await readFile(path, "utf8"));
    const existing = Array.isArray(payload.sleep) ? payload.sleep : [];
    const before = existing.length;
    payload.sleep = sleepForDumpWindow(allSleep, existing, {
      includeNewer: name === latestDump,
    });
    await writeFile(path, encodeHealthJson(payload, true), "utf8");
    files.push({ name, before, after: payload.sleep.length });
  }

  return {
    zipPath,
    exportedAt: parsed.exportedAt,
    records: parsed.records,
    files,
    sleepCount: allSleep.length,
  };
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const sleepOnly = process.argv.includes("--sleep-only");
  const zipArg = process.argv.find(
    (a, i) => i >= 2 && a !== "--sleep-only" && !a.startsWith("-")
  );
  if (sleepOnly) {
    const result = await replaceSleepFromAppleExport({
      zipPath: zipArg || SLEEP_CLEANED_ZIP,
    });
    console.log(
      JSON.stringify(
        {
          exportedAt: result.exportedAt,
          sleepCount: result.sleepCount,
          files: result.files,
        },
        null,
        2
      )
    );
  } else {
    const result = await importAppleHealthExport({
      zipPath: zipArg || DEFAULT_ZIP,
    });
    console.log(
      JSON.stringify(
        {
          exportedAt: result.exportedAt,
          records: result.records,
          skippedHr: result.skippedHr,
          workoutCount: result.workoutCount,
          files: result.files.map((f) => ({
            name: f.name,
            mb: Math.round((f.bytes / 1e6) * 10) / 10,
            workouts: f.workoutCount,
            sleep: f.sleepCount,
            series: f.seriesKeys.length,
          })),
        },
        null,
        2
      )
    );
  }
}
