/**
 * Nightly Grok 4.6 high pass: enrich places.md / trips.md with what Yan
 * was doing at each stay (business, building, trip mode). Yan only.
 * Chained after the 01:00 location compose. Does not git-commit location files.
 */

import { open, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
  hmToMinutes,
  nightlyAgentsHm,
  resolveBriefingTimezone,
} from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  sleep,
} from "./cursor-sdk-auth.js";
import {
  LOCATION_HISTORY_REL,
  YAN_EMAIL,
  locationHistoryDir,
} from "./phone-location.js";
import {
  isLocationHistoryBusy,
  nextLocalHmAt,
} from "./location-history-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-location-enrichment.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const LOCK_STALE_MS = 90 * 60 * 1000;
const COMPOSE_WAIT_MS = 15 * 60 * 1000;
const COMPOSE_POLL_MS = 5000;

export const LOCATION_ENRICHMENT_MODEL_SPEC = {
  id: process.env.CURSOR_LOCATION_ENRICHMENT_MODEL || "grok-4.6",
  params: [
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "location-enrichment",
  run: ({ dateKey }) => runLocationEnrichment({ dateKey, force: true }),
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
      "[location-enrichment] model catalog lookup failed; using explicit ModelSelection",
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

async function readState() {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function enrichmentRanOn(dateKey) {
  const state = await readState();
  const last = state?.enrichment?.lastEnrichmentDateKey;
  return String(last || "") === String(dateKey);
}

export function locationEnrichmentModelSpec() {
  return modelSelection(LOCATION_ENRICHMENT_MODEL_SPEC);
}

export function nextLocationEnrichmentAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, nightlyAgentsHm(meta), now);
}

export function buildLocationEnrichmentPrompt({ dateKey, timezone, force }) {
  const hist = LOCATION_HISTORY_REL;
  const rebuild = force
    ? "Force: re-enrich even entries you already filled in. Re-check every generic car trip against Mail.app. Prefer correcting vague lines; do not wipe older days."
    : "Only enrich stays/trips that are still vague (street-only, generic car, missing activity) or newer than enrichment.lastEnrichmentAt. First run: backfill the last 14 days.";
  return [
    "Follow the location-enrichment skill (.cursor/skills/location-enrichment/SKILL.md).",
    "Enrich Yan's composed places.md and trips.md. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `History folder: ${hist}/.`,
    "places.md and trips.md were just composed (or are current). Do not re-cluster GPS.",
    "Two equal passes: stays AND trips. A finished places.md does not finish the job.",
    "For each unenriched stay: identify the business/building, what Yan was doing, and supporting context from iMessage, Mail.app, Calendar, contacts, chat history, and web search for the address.",
    "Chat history is a required source, same rank as Calendar and iMessage. Grep and Read education/you@example.com/.chat-history/ for stay addresses, business names, trip modes, and what Yan said he was doing. Follow .cursor/skills/past-chats/SKILL.md. Do not skip this source. Do not paste transcripts into places.md or trips.md.",
    "trips.md is unfinished if any line is still **car** or **rideshare**. That is the compose GPS default, not a conclusion.",
    "Trip pass is required. Before keeping car, search Mail.app (see the skill) for ride receipts covering those local dates. Also grep chat history for robotaxi / Uber / pickup / flight mentions on those dates.",
    "Exchange Inbox first (mailbox Inbox of account Exchange): Tesla Robotaxi receipts (subject contains Robotaxi, sender tesla.com) and Uber (subject contains trip with / sender uber.com), plus Waymo, Lyft, Zoox. One needle per osascript; use a 14-day date cutoff.",
    "Gmail inbox is mailbox INBOX (all caps) of account Google; Tesla/Uber receipts are usually on Exchange, not Gmail.",
    "Read matching bodies. Extract service, pickup, dropoff, start/end time only. Match to GPS legs by overlapping local time and endpoints. Receipt wins. Tesla Robotaxi → **robotaxi**, not car and not uber.",
    "Do not skip the trip/mail pass because places already have business names.",
    "Rewrite those markdown lines in place. Keep dates. No fares or payment details.",
    "If context synthesis already named a stay (person's house, gym, library), keep that name. Do not revert it to a street.",
    "Update state.json enrichment cursor when you finish.",
    rebuild,
  ].join("\n");
}

async function waitForLocationHistoryIdle() {
  const start = Date.now();
  while (await isLocationHistoryBusy()) {
    if (Date.now() - start > COMPOSE_WAIT_MS) {
      console.warn(
        "[location-enrichment] timed out waiting for location compose; continuing"
      );
      return false;
    }
    await sleep(COMPOSE_POLL_MS);
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

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runLocationEnrichment(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runLocationEnrichmentOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runLocationEnrichmentOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);

  if (!force && (await enrichmentRanOn(dateKey))) {
    console.log(`[location-enrichment] skip ${dateKey}: already enriched`);
    laterAuthRetry.clear();
    return { ok: true, skipped: true, reason: "already-enriched", dateKey };
  }

  await waitForLocationHistoryIdle();

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[location-enrichment] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && (await enrichmentRanOn(dateKey))) {
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-enriched", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(
      apiKey,
      LOCATION_ENRICHMENT_MODEL_SPEC
    );
    console.log(
      `[location-enrichment] ${dateKey} tz=${timezone} model=${model.id} dir=${locationHistoryDir()}`
    );

    const prompt = buildLocationEnrichmentPrompt({ dateKey, timezone, force });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
      prefix: "location-enrichment",
      prompt,
      model,
      cwd: REPO_ROOT,
    });

    if (usedFallback) {
      console.warn("[location-enrichment] used auto after grok retries");
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

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(nightlyAgentsHm(meta))) return;
    if (await enrichmentRanOn(now.dateKey)) return;
    console.log(`[location-enrichment] missed-job recovery for ${now.dateKey}`);
    await runLocationEnrichment();
  } catch (err) {
    console.error("[location-enrichment] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextLocationEnrichmentAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[location-enrichment] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runLocationEnrichment()
      .catch((err) =>
        console.error("[location-enrichment] scheduled run failed", err)
      )
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[location-enrichment] reschedule failed", err);
            timer = setTimeout(
              () => startLocationEnrichmentScheduler(),
              60 * 60 * 1000
            );
          });
      });
  }, capped);
}

export function startLocationEnrichmentScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[location-enrichment] missed recovery", err)
        );
      }, 12000);
    })
    .catch((err) => {
      console.error("[location-enrichment] scheduler start failed", err);
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
  runLocationEnrichment({ force })
    .then((result) => {
      console.log("[location-enrichment]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[location-enrichment] failed", err);
      process.exitCode = 1;
    });
}
