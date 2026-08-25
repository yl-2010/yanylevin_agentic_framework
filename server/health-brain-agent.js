/**
 * Nightly Composer 2.5 (Fast off): project standing Apple Health facts
 * into brain/health.md. 03:00 local, after synthesis and location-brain.
 * Yan only.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  brainProjectionHm,
  briefingNow,
  hmToMinutes,
} from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  sleep,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { isContextSynthesisBusy, BRAIN_REL } from "./context-synthesis-agent.js";
import { isLocationBrainBusy } from "./location-brain-agent.js";
import { nextLocalHmAt } from "./location-history-agent.js";
import {
  HEALTH_REL,
  HEALTH_TIMEZONE,
  YAN_EMAIL,
  readHealthState,
  writeHealthState,
} from "./phone-health.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-health-brain.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const LOCK_STALE_MS = 45 * 60 * 1000;
const WAIT_MS = 90 * 60 * 1000;
const WAIT_POLL_MS = 5000;

export const HEALTH_BRAIN_MODEL_SPEC = {
  id: process.env.CURSOR_HEALTH_BRAIN_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "health-brain",
  run: ({ dateKey }) => runHealthBrain({ dateKey, force: true }),
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
      "[health-brain] model catalog lookup failed; using explicit ModelSelection",
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

export async function healthBrainRanOn(dateKey) {
  const state = await readHealthState();
  const last = state?.brainHealth?.lastDateKey;
  return String(last || "") === String(dateKey);
}

export async function isHealthBrainBusy() {
  if (inFlight) return true;
  try {
    await stat(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

export function healthBrainModelSpec() {
  return modelSelection(HEALTH_BRAIN_MODEL_SPEC);
}

export function nextHealthBrainAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, brainProjectionHm(meta), now);
}

export function buildHealthBrainPrompt({ dateKey, timezone, force }) {
  const hist = HEALTH_REL;
  const brain = BRAIN_REL;
  const rebuild = force
    ? "Force: rewrite health.md from current takeaways and history-patterns even if brainHealth already ran today. Merge standing facts; do not dump daily paragraphs."
    : "If brainHealth.lastDateKey is already today's date key, the wrapper skips this job. First run (missing brainHealth cursor): distill history-patterns.md into health.md.";
  return [
    "Follow the health-brain skill (.cursor/skills/health-brain/SKILL.md).",
    "Project standing Apple Health facts into brain/health.md. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read ${hist}/takeaways.md, ${hist}/history-patterns.md, and skim ${hist}/workouts.md. Skip ${hist}/raw/apple-export-*.json.`,
    `Write only ${brain}/health.md. Do not edit patterns.md, journal, takeaways.md, workouts.md, or history-patterns.md.`,
    "Identity-shaped page: rewrite freely, standing bullets, inferred lines labeled. Keep it smaller than history-patterns.md.",
    "Cover typical sleep band, RHR/HRV band, training era (swim then strength), late-session vs short-sleep tell.",
    "Later nights only promote what new takeaways actually changed. No diagnoses. No advice.",
    "Update health/state.json brainHealth cursor when you finish (keep lastIngestAt, lastTakeawaysAt, timezone).",
    rebuild,
  ].join("\n");
}

async function waitUntilIdle(label, isBusy) {
  const start = Date.now();
  while (await isBusy()) {
    if (Date.now() - start > WAIT_MS) {
      console.warn(`[health-brain] timed out waiting for ${label}; continuing`);
      return false;
    }
    await sleep(WAIT_POLL_MS);
  }
  return true;
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

function chainFactCheckAfter(result) {
  const dateKey = result?.dateKey;
  if (!dateKey || result?.reason === "in-flight") return;
  import("./fact-check-agent.js")
    .then(({ chainFactCheck }) => chainFactCheck(dateKey))
    .catch((err) =>
      console.error("[health-brain] fact-check chain failed", err)
    );
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runHealthBrain(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runHealthBrainOnce(opts).finally(() => {
    inFlight = null;
  });
  const result = await inFlight;
  chainFactCheckAfter(result);
  return result;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runHealthBrainOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = HEALTH_TIMEZONE;

  if (!force && (await healthBrainRanOn(dateKey))) {
    console.log(`[health-brain] skip ${dateKey}: already projected`);
    laterAuthRetry.clear();
    return { ok: true, skipped: true, reason: "already-projected", dateKey };
  }

  await waitUntilIdle("context synthesis", isContextSynthesisBusy);
  await waitUntilIdle("location-brain", isLocationBrainBusy);

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[health-brain] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && (await healthBrainRanOn(dateKey))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-projected", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, HEALTH_BRAIN_MODEL_SPEC);
    console.log(`[health-brain] ${dateKey} tz=${timezone} model=${model.id}`);

    const prompt = buildHealthBrainPrompt({ dateKey, timezone, force });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "health-brain",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[health-brain] used auto after composer retries");
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
    const prev = await readHealthState();
    await writeHealthState({
      ...prev,
      timezone,
      brainHealth: {
        lastAt: new Date().toISOString(),
        lastDateKey: dateKey,
        timezone,
      },
    });
    await gitAddCommitPush({
      paths: [`${BRAIN_REL}/health.md`, `${HEALTH_REL}/state.json`],
      message: `brain: health facts ${dateKey}`,
    });
    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
    };
  } finally {
    await releaseLock(handle);
  }
}

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(brainProjectionHm(meta))) return;
    if (await healthBrainRanOn(now.dateKey)) return;
    console.log(`[health-brain] missed-job recovery for ${now.dateKey}`);
    await runHealthBrain();
  } catch (err) {
    console.error("[health-brain] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextHealthBrainAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[health-brain] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runHealthBrain()
      .catch((err) => console.error("[health-brain] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[health-brain] reschedule failed", err);
            timer = setTimeout(() => startHealthBrainScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

export function startHealthBrainScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[health-brain] missed recovery", err)
        );
      }, 16000);
    })
    .catch((err) => {
      console.error("[health-brain] scheduler start failed", err);
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
  runHealthBrain({ force })
    .then((result) => {
      console.log("[health-brain]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[health-brain] failed", err);
      process.exitCode = 1;
    });
}
