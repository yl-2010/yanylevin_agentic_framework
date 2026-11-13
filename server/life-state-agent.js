/**
 * Clock :00/:05/:10/… snapshots Yan's signals, then local gpt-oss guesses
 * life state. No Cursor SDK. Yan only. Does not git-commit.
 * Shortcut POSTs save to signals JSONL. They do not call this.
 * A slow run still leaves the next start on the following round 5.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { briefingNow, resolveBriefingTimezone } from "./daily-briefing-agent.js";
import { chatCompletions } from "./lmstudio.js";
import {
  LIFE_STATE_REL,
  appendLifeStateGuess,
  writeLifeStateSchedulerState,
} from "./life-state.js";
import { buildLifeStateSnapshot } from "./life-state-snapshot.js";
import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-life-state.lock";
const META_PATH = join(YAN_EDUCATION_DIR, "daily-briefing", "meta.json");
const SKILL_PATH = join(REPO_ROOT, ".cursor/skills/life-state/SKILL.md");
export const LIFE_STATE_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 8 * 60 * 1000;
export const LIFE_STATE_MODEL = "openai/gpt-oss-20b";

export const LIFE_STATE_GUESS_RULES = [
  "You are Yan's 5-minute life-state tick. Infer what Yan is doing this minute from the snapshot.",
  "Output one JSON object only, no prose, no code fence.",
  "Fields: kind, activity, place, placeLabel, confidence, evidence (array of short tokens), optional notes.",
  "Do not include at, local, dateKey, since, or continued.",
  'Set "model" to "gpt-oss-20b".',
  "Screen sessions in this snapshot win over the previous sample's activity text. Do not copy the previous activity.",
  "Do not pick driving while GPS is at a known place unless a driving_focus or tesla_bluetooth signal is under 10 minutes old.",
].join("\n");

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

/**
 * Delay until the next clock-aligned 5-minute mark (:00, :05, :10, …).
 * Never 0: if `nowMs` is already on a mark, wait a full interval.
 * @param {number} [nowMs]
 */
export function msUntilNextLifeStateTick(nowMs = Date.now()) {
  const t = Number(nowMs);
  const n = Number.isFinite(t) ? t : Date.now();
  const remainder =
    ((n % LIFE_STATE_INTERVAL_MS) + LIFE_STATE_INTERVAL_MS) %
    LIFE_STATE_INTERVAL_MS;
  return remainder === 0
    ? LIFE_STATE_INTERVAL_MS
    : LIFE_STATE_INTERVAL_MS - remainder;
}

export function lifeStateModelId() {
  return LIFE_STATE_MODEL;
}

export function buildLifeStatePrompt() {
  return LIFE_STATE_GUESS_RULES;
}

/**
 * First `{...}` object in a model reply. Ignores prose around it.
 * @param {string} text
 */
export function parseLifeStateGuessText(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(start, i + 1));
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

async function lifeStateSystemPrompt() {
  const [skill, schema, heuristics] = await Promise.all([
    readFile(SKILL_PATH, "utf8"),
    readFile(join(LIFE_STATE_REL, "schema.md"), "utf8"),
    readFile(join(LIFE_STATE_REL, "heuristics.md"), "utf8"),
  ]);
  return [
    LIFE_STATE_GUESS_RULES,
    "--- life-state skill ---",
    skill,
    "--- schema.md ---",
    schema,
    "--- heuristics.md ---",
    heuristics,
  ].join("\n\n");
}

async function askLifeState(system, snapshot) {
  const res = await chatCompletions({
    messages: [
      { role: "system", content: system },
      { role: "user", content: `Snapshot:\n${JSON.stringify(snapshot, null, 2)}` },
    ],
    temperature: 0.2,
    maxTokens: 6000,
  });
  const guess = parseLifeStateGuessText(res.content);
  if (!guess) return null;
  guess.model = "gpt-oss-20b";
  return guess;
}

export async function isLifeStateBusy() {
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
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runLifeState(opts = {}) {
  if (inFlight) {
    return { ok: true, skipped: true, reason: "in-flight" };
  }
  inFlight = runLifeStateOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function runLifeStateOnce({ force = false } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[life-state] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    const snap = await buildLifeStateSnapshot();
    console.log(
      `[life-state] guessing ${dateKey} tz=${timezone} model=${LIFE_STATE_MODEL} force=${Boolean(force)}`
    );
    let guess = null;
    let lmError = "";
    try {
      const system = await lifeStateSystemPrompt();
      guess = await askLifeState(system, snap.snapshot);
      if (!guess) guess = await askLifeState(system, snap.snapshot);
    } catch (err) {
      lmError = err instanceof Error ? err.message : String(err);
    }
    if (!guess) {
      console.error("[life-state] gpt-oss skipped", lmError || "invalid json");
      await writeLifeStateSchedulerState({
        lastStatus: "error",
        lastError: lmError ? "lm-studio" : "invalid-json",
      });
      return {
        ok: false,
        dateKey,
        reason: lmError ? "lm-studio" : "invalid-json",
        error: lmError || "invalid json",
      };
    }
    try {
      await appendLifeStateGuess(guess, { timeZone: timezone });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[life-state] append rejected", msg);
      await writeLifeStateSchedulerState({ lastStatus: "error", lastError: "invalid-guess" });
      return { ok: false, dateKey, reason: "invalid-guess", error: msg };
    }
    await writeLifeStateSchedulerState({ lastStatus: "ok", lastError: null });
    return { ok: true, dateKey, snapshotPath: snap.path, kind: guess.kind };
  } finally {
    await releaseLock(handle);
  }
}

function armTimer() {
  if (timer) clearTimeout(timer);
  const delay = msUntilNextLifeStateTick();
  const when = new Date(Date.now() + delay);
  console.log(
    `[life-state] next guess ${when.toISOString()} (in ${Math.round(delay / 1000)}s)`
  );
  timer = setTimeout(() => {
    runLifeState()
      .catch((err) => console.error("[life-state] scheduled run failed", err))
      .finally(() => {
        try {
          armTimer();
        } catch (err) {
          console.error("[life-state] reschedule failed", err);
          timer = setTimeout(() => startLifeStateScheduler(), 60 * 1000);
        }
      });
  }, delay);
}

export function startLifeStateScheduler() {
  armTimer();
  setTimeout(() => {
    runLifeState().catch((err) =>
      console.error("[life-state] startup guess failed", err)
    );
  }, 12_000);
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
  const force = process.argv.includes("--force");
  runLifeState({ force })
    .then((result) => {
      console.log("[life-state]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[life-state] failed", err);
      process.exitCode = 1;
    });
}
