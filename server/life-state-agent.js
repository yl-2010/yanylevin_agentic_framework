/**
 * Clock :00/:05/:10/… snapshots Yan's signals, then Composer 2.5 guesses
 * life state. Local Cursor SDK one-shot. Yan only. Does not git-commit.
 * Shortcut POSTs save to signals JSONL. They do not call this.
 * A 2-minute run still leaves the next start on the following round 5.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { briefingNow, resolveBriefingTimezone } from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import {
  LIFE_STATE_GUESS_PATH,
  LIFE_STATE_REL,
  LIFE_STATE_SNAPSHOT_PATH,
  writeLifeStateSchedulerState,
} from "./life-state.js";
import { buildLifeStateSnapshot } from "./life-state-snapshot.js";
import { YAN_EMAIL } from "./phone-location.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-life-state.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
export const LIFE_STATE_INTERVAL_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 8 * 60 * 1000;

export const LIFE_STATE_MODEL_SPEC = {
  id: process.env.CURSOR_LIFE_STATE_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "life-state",
  run: ({ dateKey }) => runLifeState({ dateKey, force: true }),
});

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
      "[life-state] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

export function lifeStateModelSpec() {
  return modelSelection(LIFE_STATE_MODEL_SPEC);
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

export function buildLifeStatePrompt({ dateKey, timezone, snapshotPath }) {
  return [
    "Follow the life-state skill (.cursor/skills/life-state/SKILL.md).",
    "Guess what Yan is doing this minute. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Snapshot: ${snapshotPath || LIFE_STATE_SNAPSHOT_PATH}`,
    "Read education/you@example.com/life-state/schema.md and heuristics.md.",
    "Read the snapshot and its previous samples. Do not open Mail, OneNote, Teams, Canvas, journal, or Health sleep.",
    `Write a guess JSON to ${LIFE_STATE_GUESS_PATH} (kind, activity, place, placeLabel, confidence, evidence, optional notes, model composer-2.5). CLI fills at/local/dateKey/since/continued.`,
    `Then: node server/life-state.js append ${LIFE_STATE_GUESS_PATH}`,
    `Output folder: ${LIFE_STATE_REL}/. Do not git commit. Do not edit any other file.`,
  ].join("\n");
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
    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, LIFE_STATE_MODEL_SPEC);
    console.log(
      `[life-state] guessing ${dateKey} tz=${timezone} model=${model.id} force=${Boolean(force)}`
    );

    const prompt = buildLifeStatePrompt({
      dateKey,
      timezone,
      snapshotPath: snap.path,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "life-state",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[life-state] used auto after preferred-model retries");
    }
    if (transientFailed) {
      laterAuthRetry.schedule(dateKey);
      await writeLifeStateSchedulerState({
        lastStatus: "error",
        lastError: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      });
      return {
        ok: false,
        dateKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }

    laterAuthRetry.clear();
    await writeLifeStateSchedulerState({ lastStatus: "ok", lastError: null });
    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
      snapshotPath: snap.path,
    };
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
