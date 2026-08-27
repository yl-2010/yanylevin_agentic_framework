/**
 * Nightly Grok 4.6 xhigh: fact-check overnight agent writes against
 * source dumps. Starts as soon as both 03:00 agents (location-brain
 * and health-brain) finish, before the 06:00 briefing. Yan only.
 */

import { execFile } from "node:child_process";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  addDaysToDateKey,
  briefingNow,
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
import { BRAIN_REL, YAN_EMAIL } from "./context-synthesis-agent.js";
import {
  isLocationBrainBusy,
  locationBrainRanOn,
} from "./location-brain-agent.js";
import { isHealthBrainBusy, healthBrainRanOn } from "./health-brain-agent.js";
import { LOCATION_HISTORY_REL } from "./phone-location.js";
import { HEALTH_REL } from "./phone-health.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-fact-check.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const BRAIN_STATE_PATH = join(REPO_ROOT, BRAIN_REL, "state.json");
const LOCK_STALE_MS = 90 * 60 * 1000;
const WAIT_MS = 90 * 60 * 1000;
const WAIT_POLL_MS = 5000;

export const FACT_CHECK_MODEL_SPEC = {
  id: process.env.CURSOR_FACT_CHECK_MODEL || "grok-4.6",
  params: [
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "fact-check",
  run: ({ dateKey }) => runFactCheck({ dateKey, force: true }),
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
      "[fact-check] model catalog lookup failed; using explicit ModelSelection",
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

async function readBrainState() {
  try {
    const raw = await readFile(BRAIN_STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function factCheckRanOn(dateKey) {
  const state = await readBrainState();
  return String(state?.factCheck?.lastDateKey || "") === String(dateKey);
}

export function factCheckModelSpec() {
  return modelSelection(FACT_CHECK_MODEL_SPEC);
}

/**
 * Gate for the chained start: both 03:00 projections must have
 * written today's cursor, and fact-check must not have already run.
 * @param {{ locationBrainRan: boolean, healthBrainRan: boolean, factCheckRan: boolean }} flags
 */
export function shouldStartFactCheck({
  locationBrainRan,
  healthBrainRan,
  factCheckRan,
}) {
  if (factCheckRan) return { start: false, reason: "already-ran" };
  if (!locationBrainRan || !healthBrainRan) {
    return { start: false, reason: "waiting-for-brain" };
  }
  return { start: true, reason: "projections-done" };
}

/**
 * Start fact-check once both 03:00 agents have finished for `dateKey`.
 * No-ops if either projection is still outstanding or today's run exists.
 * @param {{ dateKey?: string }} [opts]
 */
export async function maybeKickFactCheck({ dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const locationBrainRan = await locationBrainRanOn(dateKey);
  const healthBrainRan = await healthBrainRanOn(dateKey);
  const factCheckRan = await factCheckRanOn(dateKey);
  const gate = shouldStartFactCheck({
    locationBrainRan,
    healthBrainRan,
    factCheckRan,
  });
  if (!gate.start) {
    if (gate.reason === "waiting-for-brain" && (locationBrainRan || healthBrainRan)) {
      console.log(
        `[fact-check] waiting for 03:00 agents location=${locationBrainRan} health=${healthBrainRan} ${dateKey}`
      );
    }
    return { ok: true, skipped: true, reason: gate.reason, dateKey };
  }
  console.log(`[fact-check] both 03:00 agents done; starting ${dateKey}`);
  return runFactCheck({ dateKey });
}

/** Fire-and-forget kick from location-brain / health-brain completion. */
export function chainFactCheck(dateKey) {
  void maybeKickFactCheck({ dateKey }).catch((err) =>
    console.error("[fact-check] chained run failed", err)
  );
}

export function buildFactCheckPrompt({ dateKey, timezone, journalKey, force }) {
  const brain = BRAIN_REL;
  const loc = LOCATION_HISTORY_REL;
  const health = HEALTH_REL;
  const rebuild = force
    ? "Force: run even if factCheck.lastDateKey is already today's date key. Still verify; do not only append a re-ran line."
    : "If factCheck.lastDateKey is already today's date key, the wrapper skips this job.";
  return [
    "Follow the nightly-fact-check skill (.cursor/skills/nightly-fact-check/SKILL.md).",
    "Fact-check overnight agent writes against source dumps. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}). Journal file is ${brain}/journal/${journalKey}.md.`,
    "Do not compile news or the Daily Briefing. Those run at 06:00 on the context you leave clean.",
    `Read git-visible overnight writes under ${brain}/, ${loc}/, ${health}/, and education dates/classes/projects/todos if phase 4 or Canvas touched them.`,
    "Re-read iMessage with who/fromMe (never handle as speaker in a 1:1). JSON at is UTC with no Z.",
    "Mail claims (flights, refunds, bookings, 'not in mail') need Mail.app (personal-mail skill). /tmp/yanylevin-apple-mail-export only exists during a one-shot fill and is deleted after; a missing dump is expected. mailSince is new overnight mail only; search history in Mail.app. Round-trips: every leg. timezoneAfter is not a boarding pass.",
    "Health clocks: standing America/Los_Angeles; Austin workouts after 2026-08-12 through 2026-08-26 use America/Chicago.",
    `Write corrections in place per brain/schema.md. Set ${brain}/state.json notes.factCheck (what you fixed, or that nothing was wrong). Keep lastSynthesis* and cursors.`,
    "Git commit is the Node wrapper. After frontmatter changes, node server/brain-graph.js (wrapper also runs it).",
    rebuild,
  ].join("\n");
}

async function waitUntilIdle(label, isBusy) {
  const start = Date.now();
  while (await isBusy()) {
    if (Date.now() - start > WAIT_MS) {
      console.warn(`[fact-check] timed out waiting for ${label}; continuing`);
      return false;
    }
    await sleep(WAIT_POLL_MS);
  }
  return true;
}

async function writeFactCheckCursor({ dateKey }) {
  const prev = await readBrainState();
  await writeFile(
    BRAIN_STATE_PATH,
    `${JSON.stringify(
      {
        ...prev,
        factCheck: {
          lastAt: new Date().toISOString(),
          lastDateKey: dateKey,
        },
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function regenerateBrainGraph() {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [join(REPO_ROOT, "server", "brain-graph.js")],
      { cwd: REPO_ROOT }
    );
    const text = `${String(stdout).trim()} ${String(stderr).trim()}`.trim();
    if (text) console.log(`[fact-check] brain-graph ${text}`);
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (
      err
    );
    console.warn(
      "[fact-check] brain-graph failed",
      `${String(e?.stdout || "").trim()} ${String(e?.stderr || e?.message || err).trim()}`.trim()
    );
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
export async function runFactCheck(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runFactCheckOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runFactCheckOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const journalKey = addDaysToDateKey(dateKey, -1);

  if (!force && (await factCheckRanOn(dateKey))) {
    console.log(`[fact-check] skip ${dateKey}: already ran`);
    laterAuthRetry.clear();
    return { ok: true, skipped: true, reason: "already-ran", dateKey };
  }

  await waitUntilIdle("location-brain", isLocationBrainBusy);
  await waitUntilIdle("health-brain", isHealthBrainBusy);

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[fact-check] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && (await factCheckRanOn(dateKey))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-ran", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, FACT_CHECK_MODEL_SPEC);
    console.log(`[fact-check] ${dateKey} tz=${timezone} model=${model.id}`);

    const prompt = buildFactCheckPrompt({
      dateKey,
      timezone,
      journalKey,
      force,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "fact-check",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[fact-check] used auto after grok retries");
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
    await writeFactCheckCursor({ dateKey });
    await regenerateBrainGraph();
    await gitAddCommitPush({
      paths: [
        BRAIN_REL,
        LOCATION_HISTORY_REL,
        HEALTH_REL,
        `education/${YAN_EMAIL}/dates`,
        `education/${YAN_EMAIL}/classes`,
        `education/${YAN_EMAIL}/projects`,
        `education/${YAN_EMAIL}/todos`,
      ],
      message: `education: ${dateKey} fact-check`,
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
    await maybeKickFactCheck();
  } catch (err) {
    console.error("[fact-check] missed-job recovery failed", err);
  }
}

export function startFactCheckScheduler() {
  console.log(
    "[fact-check] chained after location-brain and health-brain; no clock"
  );
  setTimeout(() => {
    maybeRunMissed().catch((err) =>
      console.error("[fact-check] missed recovery", err)
    );
  }, 18000);
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
  runFactCheck({ force })
    .then((result) => {
      console.log("[fact-check]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[fact-check] failed", err);
      process.exitCode = 1;
    });
}
