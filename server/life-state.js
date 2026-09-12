/**
 * Yan life-state log: validate, append, and look up 5-minute samples.
 * Yan only. Does not git-commit.
 */

import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { YAN_EMAIL } from "./phone-location.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const LIFE_STATE_DIRNAME = "life-state";
export const LIFE_STATE_REL = `education/${YAN_EMAIL}/${LIFE_STATE_DIRNAME}`;
export const LIFE_STATE_SNAPSHOT_PATH = "/tmp/yanylevin-life-state-snapshot.json";
export const LIFE_STATE_GUESS_PATH = "/tmp/yanylevin-life-state-guess.json";
export const CURRENT_STALE_MS = 10 * 60 * 1000;

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
    if (cmd === "append") {
      const guess = await readGuessInput(rest[0] || "-");
      return appendLifeStateGuess(guess);
    }
    return { ok: false, usage: "node life-state.js now | at <iso> | recent [n] | append <file-or-json>" };
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
