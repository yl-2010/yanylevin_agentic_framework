/**
 * Nightly Composer 2.5 (Fast off): project named GPS stays into
 * brain/places cards. 03:00 local, after the 02:30 synthesis pipeline.
 * Yan only.
 */

import { execFile } from "node:child_process";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  brainProjectionHm,
  briefingNow,
  hmToMinutes,
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
import { isContextSynthesisBusy, BRAIN_REL } from "./context-synthesis-agent.js";
import { nextLocalHmAt } from "./location-history-agent.js";
import {
  LOCATION_HISTORY_REL,
  YAN_EMAIL,
  locationHistoryDir,
  readLocationHistoryState,
} from "./phone-location.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-location-brain.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const LOCK_STALE_MS = 90 * 60 * 1000;
const SYNTHESIS_WAIT_MS = 90 * 60 * 1000;
const WAIT_POLL_MS = 5000;

export const LOCATION_BRAIN_MODEL_SPEC = {
  id: process.env.CURSOR_LOCATION_BRAIN_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "location-brain",
  run: ({ dateKey }) => runLocationBrain({ dateKey, force: true }),
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
      "[location-brain] model catalog lookup failed; using explicit ModelSelection",
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

function statePath() {
  return join(locationHistoryDir(), "state.json");
}

export async function locationBrainRanOn(dateKey) {
  const state = await readLocationHistoryState();
  const last = state?.brainPlaces?.lastDateKey;
  return String(last || "") === String(dateKey);
}

export function locationBrainModelSpec() {
  return modelSelection(LOCATION_BRAIN_MODEL_SPEC);
}

export function nextLocationBrainAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, brainProjectionHm(meta), now);
}

export function buildLocationBrainPrompt({ dateKey, timezone, force }) {
  const hist = LOCATION_HISTORY_REL;
  const brain = BRAIN_REL;
  const rebuild = force
    ? "Force: re-check the last 14 days even if brainPlaces already ran today. Prefer correcting matches; do not wipe older timeline lines."
    : "If brainPlaces.lastDateKey is already today's date key, the wrapper skips this job. First run (missing brainPlaces cursor): backfill the last 14 days, and always refresh any card that already exists.";
  return [
    "Follow the location-brain skill (.cursor/skills/location-brain/SKILL.md).",
    "Project named GPS stays into brain/places cards. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read ${hist}/places.md (trips.md only if a stay name is ambiguous). Read ${brain}/schema.md and existing ${brain}/places/.`,
    `Write only ${brain}/places/<slug>.md. Do not edit places.md, trips.md, identity, people cards, or journal.`,
    "Match existing cards by name, alias, or address before creating. Leon Street Flats, Milos's house, and the 30th Airbnb already exist.",
    "Create a card when a stay has a real name (someone's house, lodging, gym, named campus building) and it already has a card, appears on 2+ distinct days in the lookback, or is lodging / a person's house / a gym Yan uses.",
    "Skip street-only pins, robotaxi pickup/dropoff, and dwell under about 15 minutes unless a card already exists.",
    "Append - YYYY-MM-DD | stay fact [GPS] under <!-- timeline -->. Skip if that date already has the same stay. Rewrite Standing, summary, last_touched, aliases, address. Never rewrite old timeline lines.",
    "Copy the shape of brain/places/306-e-30th-airbnb.md.",
    "Update location/state.json brainPlaces cursor when you finish (keep compose and enrichment fields).",
    rebuild,
  ].join("\n");
}

export async function isLocationBrainBusy() {
  if (inFlight) return true;
  try {
    await stat(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function waitForSynthesisIdle() {
  const start = Date.now();
  while (await isContextSynthesisBusy()) {
    if (Date.now() - start > SYNTHESIS_WAIT_MS) {
      console.warn(
        "[location-brain] timed out waiting for context synthesis; continuing"
      );
      return false;
    }
    await sleep(WAIT_POLL_MS);
  }
  return true;
}

async function writeBrainPlacesCursor({ dateKey, timezone }) {
  const prev = (await readLocationHistoryState()) || {};
  await writeFile(
    statePath(),
    `${JSON.stringify(
      {
        ...prev,
        brainPlaces: {
          lastAt: new Date().toISOString(),
          lastDateKey: dateKey,
          timezone,
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
    if (text) console.log(`[location-brain] brain-graph ${text}`);
  } catch (err) {
    const e = /** @type {{ stdout?: string, stderr?: string, message?: string }} */ (
      err
    );
    console.warn(
      "[location-brain] brain-graph failed",
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

function chainFactCheckAfter(result) {
  const dateKey = result?.dateKey;
  if (!dateKey || result?.reason === "in-flight") return;
  import("./fact-check-agent.js")
    .then(({ chainFactCheck }) => chainFactCheck(dateKey))
    .catch((err) =>
      console.error("[location-brain] fact-check chain failed", err)
    );
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runLocationBrain(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runLocationBrainOnce(opts).finally(() => {
    inFlight = null;
  });
  const result = await inFlight;
  chainFactCheckAfter(result);
  return result;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runLocationBrainOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);

  if (!force && (await locationBrainRanOn(dateKey))) {
    console.log(`[location-brain] skip ${dateKey}: already projected`);
    laterAuthRetry.clear();
    return { ok: true, skipped: true, reason: "already-projected", dateKey };
  }

  await waitForSynthesisIdle();

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[location-brain] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && (await locationBrainRanOn(dateKey))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-projected", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, LOCATION_BRAIN_MODEL_SPEC);
    console.log(
      `[location-brain] ${dateKey} tz=${timezone} model=${model.id}`
    );

    const prompt = buildLocationBrainPrompt({ dateKey, timezone, force });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "location-brain",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[location-brain] used auto after composer retries");
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
    await writeBrainPlacesCursor({ dateKey, timezone });
    await regenerateBrainGraph();
    await gitAddCommitPush({
      paths: [
        `${BRAIN_REL}/places`,
        `${BRAIN_REL}/people/index.md`,
        `${BRAIN_REL}/people/graph.md`,
        `${LOCATION_HISTORY_REL}/state.json`,
      ],
      message: `brain: location places ${dateKey}`,
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
    if (await locationBrainRanOn(now.dateKey)) return;
    console.log(`[location-brain] missed-job recovery for ${now.dateKey}`);
    await runLocationBrain();
  } catch (err) {
    console.error("[location-brain] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextLocationBrainAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[location-brain] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runLocationBrain()
      .catch((err) => console.error("[location-brain] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[location-brain] reschedule failed", err);
            timer = setTimeout(() => startLocationBrainScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

export function startLocationBrainScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[location-brain] missed recovery", err)
        );
      }, 14000);
    })
    .catch((err) => {
      console.error("[location-brain] scheduler start failed", err);
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
  runLocationBrain({ force })
    .then((result) => {
      console.log("[location-brain]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[location-brain] failed", err);
      process.exitCode = 1;
    });
}
