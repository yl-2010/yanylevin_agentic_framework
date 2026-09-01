/**
 * Compose Yan's GPS JSONL into stays + trips (Composer 2.5, Fast off).
 * Local Cursor SDK one-shot. Yan only. Does not git-commit location files.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
  hmToMinutes,
  nightlyAgentsHm,
  resolveBriefingTimezone,
  zonedLocalToUtc,
} from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import {
  LOCATION_HISTORY_REL,
  YAN_EMAIL,
  hasUnprocessedLocationPoints,
  locationHistoryDir,
} from "./phone-location.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-location-history.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const INTERVAL_MS = 4 * 60 * 60 * 1000;
const LOCK_STALE_MS = 45 * 60 * 1000;

export const LOCATION_HISTORY_MODEL_SPEC = {
  id: process.env.CURSOR_LOCATION_HISTORY_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "location-history",
  run: ({ dateKey }) => runLocationHistory({ dateKey, nightly: true }),
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
      "[location-history] model catalog lookup failed; using explicit ModelSelection",
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

function addDaysToDateKey(dateKey, days) {
  const [y, m, d] = String(dateKey)
    .split("-")
    .map((n) => Number(n));
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Next local HH:MM after `now` in the briefing timezone(s).
 * @param {object} meta
 * @param {string} hm
 * @param {Date} [now]
 */
export function nextLocalHmAt(meta, hm, now = new Date()) {
  const tzs = [
    ...new Set(
      [meta?.timezone, meta?.timezoneAfter?.timezone]
        .map((z) => (typeof z === "string" ? z : ""))
        .filter(Boolean)
    ),
  ];
  const clock = /^\d{2}:\d{2}$/.test(String(hm || "").trim())
    ? String(hm).trim()
    : nightlyAgentsHm(meta);
  /** @type {number[]} */
  const candidates = [];
  for (const tz of tzs) {
    const todayKey = scheduleTodayKeyFor(tz, now);
    for (let add = 0; add <= 2; add++) {
      const dateKey = addDaysToDateKey(todayKey, add);
      if (resolveBriefingTimezone(meta, dateKey) !== tz) continue;
      const instant = zonedLocalToUtc(dateKey, clock, tz);
      if (instant.getTime() > now.getTime() + 2000) {
        candidates.push(instant.getTime());
      }
    }
  }
  if (!candidates.length) {
    return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  return new Date(Math.min(...candidates));
}

/** @param {string} tz @param {Date} now */
function scheduleTodayKeyFor(tz, now) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  const d = parts.find((p) => p.type === "day")?.value;
  return `${y}-${m}-${d}`;
}

/**
 * Sooner of now+4h and next nightly 01:00 local.
 * @param {object} meta
 * @param {Date} [now]
 */
export function nextLocationHistoryAt(meta, now = new Date()) {
  const plus4 = now.getTime() + INTERVAL_MS;
  const close = nextLocalHmAt(meta, nightlyAgentsHm(meta), now).getTime();
  return new Date(Math.min(plus4, close));
}

export async function isLocationHistoryBusy() {
  if (inFlight) return true;
  try {
    await stat(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function chainNightlyEnrichment() {
  try {
    const { runLocationEnrichment } = await import(
      "./location-enrichment-agent.js"
    );
    await runLocationEnrichment();
  } catch (err) {
    console.error("[location-history] nightly enrichment failed", err);
  }
}

export function locationHistoryModelSpec() {
  return modelSelection(LOCATION_HISTORY_MODEL_SPEC);
}

export function buildLocationHistoryPrompt({ dateKey, timezone, force }) {
  const hist = LOCATION_HISTORY_REL;
  const rebuild = force
    ? "Force: compose even if you already processed today's points. Merge; do not wipe older days."
    : "If there are no JSONL lines after state.json lastProcessedReceivedAt, stop without rewriting markdown.";
  return [
    "Follow the location-history skill (.cursor/skills/location-history/SKILL.md).",
    "Compose Yan's phone location history. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Raw log + output folder: ${hist}/.`,
    "Read new log-YYYY-MM.jsonl lines after state.json lastProcessedReceivedAt.",
    "Write places.md (stays) and trips.md (walk / bike / car / plane / uber / robotaxi / lyft).",
    "When merging a day, keep already-specific stay names (person's house, business, gym) for the same address. Do not revert them to a street number. Do not revert a chat-corrected bike trip back to walk. Watch cycling is one bike trip even if GPS split it into two walks. Context synthesis at 02:30 may have corrected those lines.",
    "Search Mail.app for Uber / robotaxi / Lyft receipts ONLY when a new stay is outside the Seattle metro (traveling). Skip mail entirely at home.",
    "Receipt wins for mode, endpoints, and duration. Do not copy fare, payment, or email bodies.",
    "Never search Mail for anyone but Yan.",
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
 * @param {{ force?: boolean, nightly?: boolean, dateKey?: string }} [opts]
 */
export async function runLocationHistory(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runLocationHistoryOnce(opts).finally(() => {
    inFlight = null;
  });
  const result = await inFlight;
  if (
    opts.nightly &&
    result &&
    result.reason !== "in-flight" &&
    result.reason !== "auth"
  ) {
    await chainNightlyEnrichment();
  }
  return result;
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function runLocationHistoryOnce({ force = false } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);

  if (!force && !(await hasUnprocessedLocationPoints())) {
    console.log(`[location-history] skip ${dateKey}: no new points`);
    return { ok: true, skipped: true, reason: "no-new-points", dateKey };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[location-history] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && !(await hasUnprocessedLocationPoints())) {
      return { ok: true, skipped: true, reason: "no-new-points", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, LOCATION_HISTORY_MODEL_SPEC);
    console.log(
      `[location-history] composing ${dateKey} tz=${timezone} model=${model.id} dir=${locationHistoryDir()}`
    );

    const prompt = buildLocationHistoryPrompt({ dateKey, timezone, force });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
      prefix: "location-history",
      prompt,
      model,
      cwd: REPO_ROOT,
    });

    if (usedFallback) {
      console.warn("[location-history] used auto after preferred-model retries");
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
    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
    };
  } finally {
    await releaseLock(handle);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const now = new Date();
  const nightlyAt = nextLocalHmAt(meta, nightlyAgentsHm(meta), now);
  const plus4 = new Date(now.getTime() + INTERVAL_MS);
  const when =
    plus4.getTime() < nightlyAt.getTime() ? plus4 : nightlyAt;
  const isNightly = when.getTime() === nightlyAt.getTime();
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, INTERVAL_MS);
  console.log(
    `[location-history] next compose ${when.toISOString()} (in ${Math.round(capped / 60000)} min)${isNightly ? " nightly" : ""}`
  );
  timer = setTimeout(() => {
    runLocationHistory({ nightly: isNightly })
      .catch((err) => console.error("[location-history] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[location-history] reschedule failed", err);
            timer = setTimeout(() => startLocationHistoryScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

async function maybeRunUnprocessed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    const nightly = now.minutes >= hmToMinutes(nightlyAgentsHm(meta));
    if (!nightly && !(await hasUnprocessedLocationPoints())) return;
    console.log(
      `[location-history] startup ${nightly ? "nightly catch-up" : "unprocessed points"}`
    );
    await runLocationHistory({ nightly });
  } catch (err) {
    console.error("[location-history] startup compose failed", err);
  }
}

export function startLocationHistoryScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunUnprocessed().catch((err) =>
          console.error("[location-history] startup recovery", err)
        );
      }, 8000);
    })
    .catch((err) => {
      console.error("[location-history] scheduler start failed", err);
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
  runLocationHistory({ force })
    .then((result) => {
      console.log("[location-history]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[location-history] failed", err);
      process.exitCode = 1;
    });
}
