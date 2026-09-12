/**
 * Yan life-state log: validate, append, and look up 5-minute samples.
 * Yan only. Does not git-commit.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAN_EMAIL, readPhoneLocation } from "./phone-location.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LIFE_STATE_DIRNAME = "life-state";
export const LIFE_STATE_REL = `education/${YAN_EMAIL}/${LIFE_STATE_DIRNAME}`;
export const LIFE_STATE_SNAPSHOT_PATH = "/tmp/yanylevin-life-state-snapshot.json";
export const LIFE_STATE_GUESS_PATH = "/tmp/yanylevin-life-state-guess.json";
export const LIFE_STATE_CONTEXT_PATH = "/tmp/yanylevin-context-life-state.json";
export const CURRENT_STALE_MS = 10 * 60 * 1000;
export const SAMPLE_STALE_MS = 20 * 60 * 1000;
export const GPS_HEARTBEAT_STALE_MS = 30 * 60 * 1000;
export const GAP_URGENT_MS = 20 * 60 * 1000;

export const LIFE_STATE_KINDS = [
  "sleeping",
  "showering",
  "in_bedroom",
  "in_office",
  "at_home",
  "eating_home",
  "homework",
  "on_computer",
  "driving",
  "passenger",
  "walking",
  "in_class",
  "free_period",
  "school_lunch",
  "at_school",
  "at_gym",
  "eating_out",
  "at_friends",
  "errand",
  "traveling",
  "unknown",
];

const KIND_SET = new Set(LIFE_STATE_KINDS);
const PLACE_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const EVIDENCE_RE = /^[a-z0-9][a-z0-9:_-]{0,47}$/;

/** @param {string} [override] */
export function lifeStateDir(override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  const env = String(process.env.LIFE_STATE_DIR || "").trim();
  return env || join(ROOT, LIFE_STATE_REL);
}

function clipStr(raw, max) {
  const s = String(raw || "")
    .replace(/\u2014/g, ",")
    .replace(/\u2013/g, ",")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",");
  if (!s) return "";
  return s.slice(0, max);
}

function finiteNumber(raw) {
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** @param {unknown} iso */
export function isIsoInstant(iso) {
  const s = String(iso || "").trim();
  if (!s) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms);
}

/**
 * @param {Date} date
 * @param {string} timeZone
 */
export function formatLifeStateLocal(date, timeZone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const offset = String(map.timeZoneName || "GMT-07:00")
    .replace(/^GMT/, "")
    .replace(/^UTC/, "");
  const off = offset && offset !== "Z" ? offset : "Z";
  const dateKey = `${map.year}-${map.month}-${map.day}`;
  const local = `${dateKey}T${map.hour}:${map.minute}:${map.second}${off === "Z" ? "Z" : off}`;
  return { dateKey, local, timeZone };
}

/** @param {string} iso */
export function lifeStateLogMonthKey(iso) {
  const ms = Date.parse(iso);
  const d = Number.isFinite(ms) ? new Date(ms) : new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown>|null}
 */
export function parseLifeStateRecord(raw) {
  if (!raw || typeof raw !== "object") return null;
  const src = /** @type {Record<string, unknown>} */ (raw);
  const at = clipStr(src.at, 40);
  const local = clipStr(src.local, 40);
  const dateKey = clipStr(src.dateKey, 12);
  const kind = clipStr(src.kind, 32);
  const activity = clipStr(src.activity, 160);
  const place = clipStr(src.place, 64).toLowerCase();
  const placeLabel = clipStr(src.placeLabel, 80);
  const confidence = finiteNumber(src.confidence);
  const since = clipStr(src.since, 40);
  if (!isIsoInstant(at) || !isIsoInstant(local) || !isIsoInstant(since)) return null;
  if (!DATE_KEY_RE.test(dateKey)) return null;
  if (!KIND_SET.has(kind)) return null;
  if (!activity) return null;
  if (!PLACE_RE.test(place)) return null;
  if (!placeLabel) return null;
  if (confidence == null || confidence < 0 || confidence > 1) return null;
  const continued = src.continued === true;
  const evidenceRaw = Array.isArray(src.evidence) ? src.evidence : [];
  const evidence = evidenceRaw
    .map((t) => clipStr(t, 48).toLowerCase())
    .filter((t) => EVIDENCE_RE.test(t))
    .slice(0, 12);
  if (!evidence.length) return null;
  const model = clipStr(src.model, 32) || "composer-2.5";
  /** @type {Record<string, unknown>} */
  const out = {
    at: new Date(at).toISOString(),
    local,
    dateKey,
    kind,
    activity,
    place,
    placeLabel,
    confidence: Math.round(confidence * 100) / 100,
    since: new Date(since).toISOString(),
    continued,
    evidence,
    model,
  };
  const notes = clipStr(src.notes, 240);
  if (notes) out.notes = notes;
  return out;
}

/**
 * @param {object} partial
 * @param {{ now?: Date, timeZone?: string, previous?: Record<string, unknown>|null }} [opts]
 */
export function completeLifeStateRecord(partial, opts = {}) {
  const now = opts.now || new Date();
  const timeZone = opts.timeZone || "America/Los_Angeles";
  const clock = formatLifeStateLocal(now, timeZone);
  const prev = opts.previous && typeof opts.previous === "object" ? opts.previous : null;
  const kind = clipStr(partial?.kind, 32);
  const sameKind = Boolean(prev && prev.kind === kind);
  const src = {
    at: partial?.at || now.toISOString(),
    local: partial?.local || clock.local,
    dateKey: partial?.dateKey || clock.dateKey,
    kind,
    activity: partial?.activity,
    place: partial?.place,
    placeLabel: partial?.placeLabel,
    confidence: partial?.confidence,
    since: partial?.since || (sameKind ? prev.since : now.toISOString()),
    continued: partial?.continued ?? sameKind,
    evidence: partial?.evidence,
    notes: partial?.notes,
    model: partial?.model || "composer-2.5",
  };
  return parseLifeStateRecord(src);
}

/** @param {string} [dir] */
export function currentLifeStatePath(dir) {
  return join(lifeStateDir(dir), "current.json");
}

/** @param {string} [dir] */
export function lifeStateStatePath(dir) {
  return join(lifeStateDir(dir), "state.json");
}

/** @param {string} dir @param {string} monthKey */
export function lifeStateLogPath(dir, monthKey) {
  return join(dir, `log-${monthKey}.jsonl`);
}

/** @param {string} [dir] */
export async function readCurrentLifeState(dir) {
  try {
    const raw = JSON.parse(await readFile(currentLifeStatePath(dir), "utf8"));
    return parseLifeStateRecord(raw);
  } catch {
    return null;
  }
}

/** @param {string} [dir] */
export async function readLifeStateSchedulerState(dir) {
  try {
    const raw = JSON.parse(await readFile(lifeStateStatePath(dir), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Scheduler-only cursor. Does not overwrite lastAt from a successful sample.
 * @param {Record<string, unknown>} patch
 * @param {string} [dir]
 */
export async function writeLifeStateSchedulerState(patch, dir) {
  const root = lifeStateDir(dir);
  await mkdir(root, { recursive: true });
  const prev = await readLifeStateSchedulerState(root);
  const next = {
    ...prev,
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(lifeStateStatePath(root), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {string} dateKey
 * @param {number} days
 */
export function addDaysToLifeStateDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey || "")
    .split("-")
    .map((n) => Number(n));
  if (!y || !m || !d) return "";
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * Collapsed kind timeline for one local dateKey. Nightly jobs read this, not 288 JSONL lines.
 * @param {string} dateKey
 * @param {string} [dir]
 */
export async function summarizeLifeStateDay(dateKey, dir) {
  const key = String(dateKey || "").trim();
  if (!DATE_KEY_RE.test(key)) {
    return { ok: false, dateKey: key, error: "bad dateKey", sampleCount: 0, segments: [] };
  }
  const root = lifeStateDir(dir);
  const files = await listLifeStateLogFiles(root);
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const name of files) {
    const month = await readJsonlObjects(join(root, name));
    for (const row of month) {
      if (row.dateKey === key) rows.push(row);
    }
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  /** @type {Record<string, unknown>[]} */
  const segments = [];
  for (const row of rows) {
    const last = segments[segments.length - 1];
    if (
      last &&
      last.kind === row.kind &&
      last.place === row.place &&
      last.activity === row.activity
    ) {
      last.until = row.at;
      last.localUntil = row.local;
      last.count = Number(last.count || 1) + 1;
      last.confidence = row.confidence;
    } else {
      segments.push({
        since: row.since || row.at,
        until: row.at,
        local: row.local,
        kind: row.kind,
        activity: row.activity,
        place: row.place,
        placeLabel: row.placeLabel,
        confidence: row.confidence,
        evidence: row.evidence,
        count: 1,
      });
    }
  }
  let maxGapMinutes = 0;
  for (let i = 1; i < rows.length; i++) {
    const gap = Date.parse(String(rows[i].at)) - Date.parse(String(rows[i - 1].at));
    if (Number.isFinite(gap)) maxGapMinutes = Math.max(maxGapMinutes, Math.round(gap / 60000));
  }
  return {
    ok: true,
    dateKey: key,
    sampleCount: rows.length,
    maxGapMinutes,
    firstAt: rows[0]?.at || null,
    lastAt: rows[rows.length - 1]?.at || null,
    segments,
  };
}

/**
 * Prefetch yesterday's collapsed timeline for nightly jobs.
 * `dateKey` is the job date (tonight / early morning). Journal day is minus one.
 * @param {{ dateKey: string, timezone?: string, dir?: string }} opts
 */
export async function prefetchLifeStateContext(opts) {
  const jobKey = String(opts?.dateKey || "").trim();
  const journalKey = addDaysToLifeStateDateKey(jobKey, -1) || jobKey;
  const summary = await summarizeLifeStateDay(journalKey, opts?.dir);
  const payload = {
    at: new Date().toISOString(),
    jobDateKey: jobKey,
    timezone: opts?.timezone || "America/Los_Angeles",
    ...summary,
  };
  await writeFile(LIFE_STATE_CONTEXT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

/**
 * Heartbeat / 5-minute log health for Daily Briefing URGENT.
 * @param {{ now?: Date, dir?: string }} [opts]
 */
export async function assessLifeStateHeartbeat(opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const nowMs = now.getTime();
  const current = await readCurrentLifeState(opts.dir);
  const scheduler = await readLifeStateSchedulerState(opts.dir);
  const gps =
    opts.gps !== undefined ? opts.gps : await readPhoneLocation();
  let snapshot = opts.snapshot;
  if (snapshot === undefined) {
    try {
      snapshot = JSON.parse(await readFile(LIFE_STATE_SNAPSHOT_PATH, "utf8"));
    } catch {
      snapshot = null;
    }
  }

  const windowMs = 24 * 60 * 60 * 1000;
  const sinceMs = nowMs - windowMs;
  const root = lifeStateDir(opts.dir);
  const files = await listLifeStateLogFiles(root);
  /** @type {Record<string, unknown>[]} */
  const recent = [];
  for (const name of files) {
    const month = await readJsonlObjects(join(root, name));
    for (const row of month) {
      const t = Date.parse(String(row.at));
      if (Number.isFinite(t) && t >= sinceMs) recent.push(row);
    }
  }
  recent.sort((a, b) => String(a.at).localeCompare(String(b.at)));

  let maxGapMinutes = 0;
  for (let i = 1; i < recent.length; i++) {
    const gap = Date.parse(String(recent[i].at)) - Date.parse(String(recent[i - 1].at));
    if (Number.isFinite(gap)) maxGapMinutes = Math.max(maxGapMinutes, Math.round(gap / 60000));
  }
  const firstAt = recent[0]?.at || null;
  const lastAt = current?.at || recent[recent.length - 1]?.at || null;
  const spanMs = firstAt ? nowMs - Date.parse(String(firstAt)) : 0;
  const expectedTicks = spanMs > 0 ? Math.max(1, Math.round(spanMs / (5 * 60 * 1000))) : 0;
  const lastAgeMinutes = lastAt ? Math.round((nowMs - Date.parse(String(lastAt))) / 60000) : null;

  const gpsAt = gps?.receivedAt || gps?.timestamp || null;
  const gpsAgeMinutes = gpsAt ? Math.round((nowMs - Date.parse(String(gpsAt))) / 60000) : null;
  const gpsFresh =
    gpsAgeMinutes != null && gpsAgeMinutes * 60000 < GPS_HEARTBEAT_STALE_MS;
  const hasDevice = Boolean(gps && gps.device && typeof gps.device === "object");

  /** @type {{ code: string, detail: string }[]} */
  const issues = [];
  if (!lastAt) {
    issues.push({
      code: "life-state-empty",
      detail: "5-minute life-state log has no samples yet.",
    });
  } else if (lastAgeMinutes != null && lastAgeMinutes * 60000 >= SAMPLE_STALE_MS) {
    issues.push({
      code: "life-state-stale",
      detail: `5-minute life-state log stopped. Last sample ${lastAgeMinutes} min ago.`,
    });
  }
  if (recent.length >= 3 && maxGapMinutes >= Math.round(GAP_URGENT_MS / 60000)) {
    issues.push({
      code: "life-state-gap",
      detail: `Life-state gap of ${maxGapMinutes} min in the last 24h (ticks should start on :00/:05/:10).`,
    });
  }
  if (expectedTicks >= 12 && recent.length < Math.floor(expectedTicks * 0.7)) {
    issues.push({
      code: "life-state-sparse",
      detail: `Life-state wrote ${recent.length} samples in the last ${Math.round(spanMs / 3600000)}h; expected about ${expectedTicks}.`,
    });
  }
  if (String(scheduler.lastStatus || "") === "error") {
    issues.push({
      code: "life-state-error",
      detail: `Life-state Composer last failed: ${clipStr(scheduler.lastError || scheduler.lastStatus, 160)}.`,
    });
  }
  if (gpsAgeMinutes == null) {
    issues.push({
      code: "gps-missing",
      detail: "No iPhone GPS fix on disk. Heartbeat is not landing.",
    });
  } else if (!gpsFresh) {
    issues.push({
      code: "gps-stale",
      detail: `iPhone GPS heartbeat is stale (${gpsAgeMinutes} min). 5-minute posts are not landing. iPad must not be the source.`,
    });
  } else if (!hasDevice) {
    issues.push({
      code: "device-missing",
      detail: "iPhone GPS is fresh but has no device bundle (battery, charging, network, audio). Install the new iPhone build. iPad must not post location.",
    });
  }
  if (snapshot && typeof snapshot === "object") {
    const snapAt = Date.parse(String(snapshot.at || snapshot.clock?.at || ""));
    const snapFresh = Number.isFinite(snapAt) && nowMs - snapAt < SAMPLE_STALE_MS;
    if (snapFresh) {
      if (snapshot.home && snapshot.home.ok === false) {
        issues.push({
          code: "home-snapshot",
          detail: `Home snapshot failed: ${clipStr(snapshot.home.error, 120) || "ok=false"}.`,
        });
      }
      if (snapshot.screenTime && snapshot.screenTime.ok === false) {
        issues.push({
          code: "screentime-snapshot",
          detail: `Screen Time snapshot failed: ${clipStr(snapshot.screenTime.error, 120) || "ok=false"}.`,
        });
      }
    }
  }

  return {
    ok: issues.length === 0,
    at: now.toISOString(),
    lastSampleAt: lastAt,
    lastSampleAgeMinutes: lastAgeMinutes,
    ticksLast24h: recent.length,
    expectedTicksLast24h: expectedTicks,
    maxGapMinutes,
    lastStatus: scheduler.lastStatus || null,
    gps: {
      ageMinutes: gpsAgeMinutes,
      source: gps?.source || null,
      hasDevice,
      idiom: gps?.idiom || null,
    },
    issues,
  };
}

/**
 * @param {Record<string, unknown>|null|undefined} rec
 * @param {number} [staleMs]
 */
export function isCurrentLifeStateFresh(rec, staleMs = CURRENT_STALE_MS) {
  if (!rec || !isIsoInstant(rec.at)) return false;
  return Date.now() - Date.parse(String(rec.at)) <= staleMs;
}

/** @param {string} dir */
export async function listLifeStateLogFiles(dir) {
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names.filter((n) => /^log-\d{4}-\d{2}\.jsonl$/.test(n)).sort();
}

/** @param {string} file */
async function readJsonlObjects(file) {
  let raw = "";
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  /** @type {Record<string, unknown>[]} */
  const out = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = parseLifeStateRecord(JSON.parse(s));
      if (parsed) out.push(parsed);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/**
 * @param {string} [dir]
 * @param {number} [limit]
 */
export async function readRecentLifeState(dir, limit = 3) {
  const n = Math.min(Math.max(Number(limit) || 3, 1), 48);
  const root = lifeStateDir(dir);
  const files = await listLifeStateLogFiles(root);
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (let i = files.length - 1; i >= 0 && rows.length < n; i--) {
    const month = await readJsonlObjects(join(root, files[i]));
    for (let j = month.length - 1; j >= 0 && rows.length < n; j--) {
      rows.push(month[j]);
    }
  }
  return rows.reverse();
}

/**
 * Closest sample to `when`. Prefers the last sample at or before that instant.
 * @param {string|Date} when
 * @param {string} [dir]
 */
export async function readLifeStateAt(when, dir) {
  const ms = when instanceof Date ? when.getTime() : Date.parse(String(when || ""));
  if (!Number.isFinite(ms)) return null;
  const root = lifeStateDir(dir);
  const files = await listLifeStateLogFiles(root);
  /** @type {Record<string, unknown>|null} */
  let best = null;
  let bestDelta = Infinity;
  /** @type {Record<string, unknown>|null} */
  let lastBefore = null;
  let lastBeforeMs = -Infinity;
  for (const name of files) {
    const rows = await readJsonlObjects(join(root, name));
    for (const row of rows) {
      const t = Date.parse(String(row.at));
      if (!Number.isFinite(t)) continue;
      const delta = Math.abs(t - ms);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = row;
      }
      if (t <= ms && t >= lastBeforeMs) {
        lastBeforeMs = t;
        lastBefore = row;
      }
    }
  }
  return lastBefore || best;
}

/**
 * @param {Record<string, unknown>} record
 * @param {{ dir?: string, timeZone?: string }} [opts]
 */
export async function writeLifeStateRecord(record, opts = {}) {
  const parsed = parseLifeStateRecord(record);
  if (!parsed) {
    const err = new Error("invalid life-state record");
    err.status = 400;
    throw err;
  }
  const dir = lifeStateDir(opts.dir);
  await mkdir(dir, { recursive: true });
  const month = lifeStateLogMonthKey(String(parsed.at));
  await appendFile(lifeStateLogPath(dir, month), `${JSON.stringify(parsed)}\n`, "utf8");
  await writeFile(currentLifeStatePath(dir), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await writeFile(
    lifeStateStatePath(dir),
    `${JSON.stringify({ lastAt: parsed.at, lastStatus: "ok" }, null, 2)}\n`,
    "utf8"
  );
  return parsed;
}

/**
 * @param {unknown} guess
 * @param {{ dir?: string, now?: Date, timeZone?: string }} [opts]
 */
export async function appendLifeStateGuess(guess, opts = {}) {
  const previous = (await readRecentLifeState(opts.dir, 1))[0] || null;
  const completed = completeLifeStateRecord(guess, {
    now: opts.now,
    timeZone: opts.timeZone,
    previous,
  });
  if (!completed) {
    const err = new Error("invalid life-state guess");
    err.status = 400;
    throw err;
  }
  return writeLifeStateRecord(completed, opts);
}

async function readGuessInput(arg) {
  const raw = String(arg || "").trim();
  if (!raw || raw === "-") {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  }
  if (raw.startsWith("{")) return JSON.parse(raw);
  return JSON.parse(await readFile(raw, "utf8"));
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const cmd = process.argv[2] || "now";
  const rest = process.argv.slice(3);
  const run = async () => {
    if (cmd === "now") return readCurrentLifeState();
    if (cmd === "at") return readLifeStateAt(rest[0] || "");
    if (cmd === "recent") return readRecentLifeState(undefined, rest[0]);
    if (cmd === "day") return summarizeLifeStateDay(rest[0] || "");
    if (cmd === "health") return assessLifeStateHeartbeat();
    if (cmd === "append") {
      const guess = await readGuessInput(rest[0] || "-");
      return appendLifeStateGuess(guess);
    }
    return {
      ok: false,
      usage:
        "node life-state.js now | at <iso> | recent [n] | day <YYYY-MM-DD> | health | append <file-or-json>",
    };
  };
  run()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (r && typeof r === "object" && r.ok === false) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
