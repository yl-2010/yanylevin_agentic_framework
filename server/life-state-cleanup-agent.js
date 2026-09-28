/**
 * Nightly Grok 4.7 xhigh (Fast off): clean yesterday's 5-minute life-state
 * log against Screen Time, iMessage, Teams, Calendar, location, and other
 * sources. 01:30 local, same slot as chat title refresh. Yan only.
 */

import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  addDaysToDateKey,
  briefingNow,
  hmToMinutes,
  lifeStateCleanupHm,
  resolveBriefingTimezone,
} from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  sleep,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { weekDateHelper } from "./local-clock.js";
import { isLifeStateBusy } from "./life-state-agent.js";
import {
  LIFE_STATE_CLEANUP_DAY_PATH,
  LIFE_STATE_CLEANUP_PATCH_PATH,
  LIFE_STATE_REL,
  dumpLifeStateCleanupDay,
  lifeStateCleanupStatePath,
  rewriteLifeStateDay,
} from "./life-state.js";
import { nextLocalHmAt } from "./location-history-agent.js";
import { YAN_EMAIL } from "./phone-location.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-life-state-cleanup.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const LOCK_STALE_MS = 90 * 60 * 1000;
const TICK_WAIT_MS = 8 * 60 * 1000;
const TICK_POLL_MS = 2000;

export const LIFE_STATE_CLEANUP_MODEL_SPEC = {
  id: process.env.CURSOR_LIFE_STATE_CLEANUP_MODEL || "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "life-state-cleanup",
  run: ({ dateKey }) => runLifeStateCleanup({ dateKey, force: true }),
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
      "[life-state-cleanup] model catalog lookup failed; using explicit ModelSelection",
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

async function readCleanupState() {
  try {
    const raw = await readFile(lifeStateCleanupStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} state
 */
async function writeCleanupState(state) {
  await writeFile(
    lifeStateCleanupStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf8"
  );
}

export function lifeStateCleanupModelSpec() {
  return modelSelection(LIFE_STATE_CLEANUP_MODEL_SPEC);
}

export function nextLifeStateCleanupAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, lifeStateCleanupHm(meta), now);
}

export { lifeStateCleanupHm };

export async function cleanupRanOn(dateKey) {
  const state = await readCleanupState();
  return String(state?.lastCleanupDateKey || "") === String(dateKey);
}

export function buildLifeStateCleanupPrompt({
  dateKey,
  timezone,
  journalKey,
  force,
}) {
  const rebuild = force
    ? "Force: re-clean even if cleanup-state.json lastCleanupDateKey is already today's date key."
    : "If cleanup-state.json lastCleanupDateKey is already today's date key, the wrapper skips this job.";
  return [
    "Follow the life-state-cleanup skill (.cursor/skills/life-state-cleanup/SKILL.md).",
    "Clean yesterday's 5-minute life-state log. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}). Journal / cleanup day is ${journalKey}.`,
    weekDateHelper(dateKey, timezone),
    `Dump: ${LIFE_STATE_CLEANUP_DAY_PATH} (segments plus every sample for ${journalKey}).`,
    "Read education/you@example.com/life-state/schema.md and heuristics.md.",
    "Use Screen Time, iMessage, school Teams, Calendar, location places.md/trips.md, schedule.json, gym entries, Shortcut signals, chat history, and Apple Health dump sleep (takeaways.md) only through the 2026-09-26 10:49 AM PT ingest. Unix socket for Screen Time and iMessage. Later Health-app sleep is inflated until Yan says otherwise. Do not use those later hours to decide sleeping vs awake.",
    "Keep every existing at/local/dateKey. Do not invent or delete ticks. Fix flicker and wrong kinds (lone sleeping between awake, Home while GPS was at school, leftover-fan shower).",
    `Write ${LIFE_STATE_CLEANUP_PATCH_PATH} as { dateKey: "${journalKey}", corrections: [...] }. Empty corrections if the day is clean.`,
    `Then: node server/life-state.js rewrite-day ${journalKey} ${LIFE_STATE_CLEANUP_PATCH_PATH}`,
    "Git commit is the Node wrapper. Do not edit brain, journal, or location markdown.",
    rebuild,
  ].join("\n");
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

async function waitForLifeStateIdle() {
  const start = Date.now();
  while (await isLifeStateBusy()) {
    if (Date.now() - start > TICK_WAIT_MS) {
      console.warn(
        "[life-state-cleanup] timed out waiting for 5-minute tick; continuing"
      );
      return false;
    }
    await sleep(TICK_POLL_MS);
  }
  return true;
}

/**
 * @param {string} journalKey
 */
async function applyCleanupPatch(journalKey) {
  let patch = null;
  try {
    patch = JSON.parse(await readFile(LIFE_STATE_CLEANUP_PATCH_PATH, "utf8"));
  } catch {
    return { ok: true, skipped: true, reason: "no-patch", corrected: 0 };
  }
  return rewriteLifeStateDay(journalKey, patch);
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runLifeStateCleanup(opts = {}) {
  if (inFlight) {
    return { ok: true, skipped: true, reason: "in-flight" };
  }
  inFlight = runLifeStateCleanupOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runLifeStateCleanupOnce({
  force = false,
  dateKey: dateKeyOpt,
} = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const journalKey = addDaysToDateKey(dateKey, -1);

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[life-state-cleanup] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey, journalKey };
  }

  try {
    if (!force && (await cleanupRanOn(dateKey))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-ran", dateKey, journalKey };
    }

    await waitForLifeStateIdle();
    const dump = await dumpLifeStateCleanupDay(journalKey);
    if (!dump.sampleCount) {
      const prev = await readCleanupState();
      await writeCleanupState({
        ...prev,
        lastCleanupAt: new Date().toISOString(),
        lastCleanupDateKey: dateKey,
        journalKey,
        corrected: 0,
        sampleCount: 0,
      });
      laterAuthRetry.clear();
      return {
        ok: true,
        skipped: true,
        reason: "no-samples",
        dateKey,
        journalKey,
      };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(
      apiKey,
      LIFE_STATE_CLEANUP_MODEL_SPEC
    );
    console.log(
      `[life-state-cleanup] ${dateKey} journal=${journalKey} tz=${timezone} model=${model.id} samples=${dump.sampleCount} force=${Boolean(force)}`
    );

    const prompt = buildLifeStateCleanupPrompt({
      dateKey,
      timezone,
      journalKey,
      force,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "life-state-cleanup",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[life-state-cleanup] used auto after preferred-model retries");
    }
    if (transientFailed) {
      laterAuthRetry.schedule(dateKey);
      return {
        ok: false,
        dateKey,
        journalKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }

    const applied = await applyCleanupPatch(journalKey);
    const prev = await readCleanupState();
    await writeCleanupState({
      ...prev,
      lastCleanupAt: new Date().toISOString(),
      lastCleanupDateKey: dateKey,
      journalKey,
      corrected: Number(applied?.corrected || 0),
      sampleCount: Number(applied?.sampleCount || dump.sampleCount || 0),
    });

    laterAuthRetry.clear();
    await gitAddCommitPush({
      paths: [LIFE_STATE_REL],
      message: `education: ${dateKey} life-state cleanup`,
    });

    return {
      ok: true,
      dateKey,
      journalKey,
      status: result?.status || "finished",
      corrected: Number(applied?.corrected || 0),
      sampleCount: Number(applied?.sampleCount || dump.sampleCount || 0),
    };
  } finally {
    await releaseLock(handle);
  }
}

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(lifeStateCleanupHm(meta))) return;
    if (await cleanupRanOn(now.dateKey)) return;
    console.log(`[life-state-cleanup] missed-job recovery for ${now.dateKey}`);
    await runLifeStateCleanup();
  } catch (err) {
    console.error("[life-state-cleanup] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextLifeStateCleanupAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[life-state-cleanup] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runLifeStateCleanup()
      .catch((err) =>
        console.error("[life-state-cleanup] scheduled run failed", err)
      )
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[life-state-cleanup] reschedule failed", err);
            timer = setTimeout(
              () => startLifeStateCleanupScheduler(),
              60 * 60 * 1000
            );
          });
      });
  }, capped);
}

export function startLifeStateCleanupScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[life-state-cleanup] missed recovery", err)
        );
      }, 18000);
    })
    .catch((err) => {
      console.error("[life-state-cleanup] scheduler start failed", err);
    });
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
  runLifeStateCleanup({ force })
    .then((result) => {
      console.log("[life-state-cleanup]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[life-state-cleanup] failed", err);
      process.exitCode = 1;
    });
}
