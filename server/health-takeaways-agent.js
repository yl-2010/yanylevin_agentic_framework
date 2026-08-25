/**
 * Nightly Composer 2.5 (Fast off): turn Apple Health dumps into
 * takeaways.md. 01:00 local, same clock as location compose. Yan only.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
  hmToMinutes,
  nightlyAgentsHm,
} from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { nextLocalHmAt } from "./location-history-agent.js";
import {
  HEALTH_REL,
  HEALTH_TIMEZONE,
  YAN_EMAIL,
  hasUnprocessedHealthDumps,
  healthDir,
  readHealthState,
  writeHealthState,
} from "./phone-health.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-health-takeaways.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const LOCK_STALE_MS = 45 * 60 * 1000;

export const HEALTH_TAKEAWAYS_MODEL_SPEC = {
  id: process.env.CURSOR_HEALTH_TAKEAWAYS_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "health-takeaways",
  run: ({ dateKey }) => runHealthTakeaways({ dateKey, force: true }),
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
      "[health-takeaways] model catalog lookup failed; using explicit ModelSelection",
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

export function healthTakeawaysModelSpec() {
  return modelSelection(HEALTH_TAKEAWAYS_MODEL_SPEC);
}

export function nextHealthTakeawaysAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, nightlyAgentsHm(meta), now);
}

export function buildHealthTakeawaysPrompt({ dateKey, timezone, force }) {
  const hist = HEALTH_REL;
  const rebuild = force
    ? "Force: write takeaways even if you already processed today's dump. Merge; do not wipe older days."
    : "If there are no raw JSON files newer than state.json lastTakeawaysAt, stop without rewriting takeaways.md.";
  return [
    "Follow the health-takeaways skill (.cursor/skills/health-takeaways/SKILL.md).",
    "Turn Yan's Apple Health dumps into natural-language takeaways. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Health folder: ${hist}/.`,
    "Read new shortcut raw/*.json after state.json lastTakeawaysAt, plus workouts.md and the existing takeaways.md.",
    "Skip raw/apple-export-*.json. That is the compact full-history archive from Apple's XML export, too large for this pass.",
    "Write takeaways.md: short prose per day, newest day on top. Call out workouts by name, duration, and effort. Sleep as hours plus quality tells. Mention RHR/HRV/steps only when they moved.",
    "Do not dump tables of every sample. Do not invent diagnoses. This is lifestyle context, not a medical chart.",
    "Gym machine weights live under fitness/ and are a different log. Do not mix them in unless a workout name clearly matches.",
    "Update state.json lastTakeawaysAt when you finish.",
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

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runHealthTakeaways(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runHealthTakeawaysOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runHealthTakeawaysOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = HEALTH_TIMEZONE;

  if (!force && !(await hasUnprocessedHealthDumps())) {
    console.log(`[health-takeaways] skip ${dateKey}: no new dumps`);
    return { ok: true, skipped: true, reason: "no-new-dumps", dateKey };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[health-takeaways] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && !(await hasUnprocessedHealthDumps())) {
      return { ok: true, skipped: true, reason: "no-new-dumps", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, HEALTH_TAKEAWAYS_MODEL_SPEC);
    console.log(
      `[health-takeaways] ${dateKey} tz=${timezone} model=${model.id} dir=${healthDir()}`
    );

    const prompt = buildHealthTakeawaysPrompt({ dateKey, timezone, force });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "health-takeaways",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[health-takeaways] used auto after preferred-model retries");
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
      lastTakeawaysAt: new Date().toISOString(),
      lastTakeawaysDateKey: dateKey,
      timezone,
    });
    await gitAddCommitPush({
      paths: [HEALTH_REL],
      message: `health: takeaways ${dateKey}`,
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
    if (now.minutes < hmToMinutes(nightlyAgentsHm(meta))) return;
    if (!(await hasUnprocessedHealthDumps())) return;
    console.log(`[health-takeaways] missed-job recovery for ${now.dateKey}`);
    await runHealthTakeaways();
  } catch (err) {
    console.error("[health-takeaways] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextHealthTakeawaysAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[health-takeaways] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runHealthTakeaways()
      .catch((err) =>
        console.error("[health-takeaways] scheduled run failed", err)
      )
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[health-takeaways] reschedule failed", err);
            timer = setTimeout(() => startHealthTakeawaysScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

export function startHealthTakeawaysScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[health-takeaways] missed recovery", err)
        );
      }, 10000);
    })
    .catch((err) => {
      console.error("[health-takeaways] scheduler start failed", err);
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
  runHealthTakeaways({ force })
    .then((result) => {
      console.log("[health-takeaways]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[health-takeaways] failed", err);
      process.exitCode = 1;
    });
}
