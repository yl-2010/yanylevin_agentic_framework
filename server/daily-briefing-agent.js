/**
 * Morning Daily Briefing: 3-phase local Cursor SDK pipeline.
 *   1. news        Grok 4.7 high   draft news capsules
 *   2. agent-recap Composer 2.5    overnight agent recap card
 *   3. unslop      Composer 2.5   unslop + write todo.json + taste.md
 * Yan only.
 */

import { execFile } from "node:child_process";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitAddCommitPush } from "./git-publish.js";
import { scheduleNowParts, scheduleTodayKey } from "./education-data.js";
import { zonedLocalToUtc } from "./local-clock.js";

export { zonedLocalToUtc };

/** setTimeout cannot wait out a 25-hour fall-back day. Wake and recompute. */
export const SCHEDULER_WAKE_CAP_MS = 24 * 60 * 60 * 1000;

/**
 * Delay until `when`. `fire` is false when the wait was capped, so the
 * timer must recompute the slot instead of running the job early.
 * @param {Date|number} when
 * @param {number} [now]
 */
export function schedulerWait(when, now = Date.now()) {
  const target = when instanceof Date ? when.getTime() : Number(when);
  const delay = Math.max(1000, target - now);
  if (delay > SCHEDULER_WAKE_CAP_MS) {
    return { delay: SCHEDULER_WAKE_CAP_MS, fire: false };
  }
  return { delay, fire: true };
}
import {
  BRIEFING_LATER_RETRY_MS,
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { assessLifeStateHeartbeat } from "./life-state.js";
import {
  assessHealthShortcutHeartbeat,
  readHealthState,
} from "./phone-health.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRIEFING_EMAIL = "you@example.com";
const LOCK_PATH = "/tmp/yanylevin-daily-briefing.lock";
const SERVER_LOG_PATH = "/tmp/personal-agent-server.log";
/** Global unslop skill. Phase 3 reads it; never inline into prompts. */
const UNSLOP_SKILL_PATH = join(homedir(), ".cursor/skills/unslop/SKILL.md");
import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";

const META_PATH = join(YAN_EDUCATION_DIR, "daily-briefing", "meta.json");

/** Undated leftover from before date-keyed drafts. Ignore it. */
export const NEWS_DRAFT_PATH = "/tmp/yanylevin-daily-briefing-news-draft.json";
export const AGENT_RECAP_DRAFT_PATH =
  "/tmp/yanylevin-daily-briefing-agent-recap.json";
export const NIGHTLY_STATUS_PATH = "/tmp/yanylevin-nightly-status.json";

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {string} dateKey
 */
export function newsDraftPath(dateKey) {
  const key = String(dateKey || "").trim();
  if (!DATE_KEY_RE.test(key)) return NEWS_DRAFT_PATH;
  return `/tmp/yanylevin-daily-briefing-news-draft-${key}.json`;
}

/**
 * @param {string} dateKey
 */
export function agentRecapDraftPath(dateKey) {
  const key = String(dateKey || "").trim();
  if (!DATE_KEY_RE.test(key)) return AGENT_RECAP_DRAFT_PATH;
  return `/tmp/yanylevin-daily-briefing-agent-recap-${key}.json`;
}

export const BRIEFING_NEWS_MODEL_SPEC = {
  id:
    process.env.CURSOR_PERSONAL_ATTACHMENT_MODEL ||
    process.env.CURSOR_EDUCATION_ATTACHMENT_MODEL ||
    "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

export const AGENT_RECAP_MODEL_SPEC = {
  id: process.env.CURSOR_AGENT_RECAP_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const BRIEFING_UNSLOP_MODEL_SPEC = {
  id: process.env.CURSOR_BRIEFING_UNSLOP_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const DEFAULT_NIGHTLY_HM = "01:00";
export const DEFAULT_CHAT_TITLE_REFRESH_HM = "01:30";
export const DEFAULT_LIFE_STATE_CLEANUP_HM = "01:30";
export const DEFAULT_CALENDAR_SORT_HM = "01:15";
export const DEFAULT_SYNTHESIS_HM = "02:30";
export const DEFAULT_BRAIN_PROJECTION_HM = "03:00";
export const DEFAULT_COMPILE_HM = "06:00";
export const DEFAULT_DUE_HM = "07:00";

const SERVER_LOG_PREFIXES = [
  "[nightly-",
  "[canvas-sync]",
  "[location-",
  "[health-",
  "[chat-title-refresh]",
  "[life-state-cleanup]",
  "[fact-check]",
];

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "daily-briefing",
  run: ({ dateKey }) => runDailyBriefing({ dateKey }),
  delaysMs: BRIEFING_LATER_RETRY_MS.slice(0, 2),
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
      "[daily-briefing] model catalog lookup failed; using explicit ModelSelection",
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

/**
 * @param {object} meta
 * @param {string} dateKey
 */
export function resolveBriefingTimezone(meta, dateKey) {
  const after = meta?.timezoneAfter;
  const on = after && typeof after.on === "string" ? after.on : "";
  const nextTz =
    after && typeof after.timezone === "string" ? after.timezone : "";
  if (on && nextTz && String(dateKey) >= on) return nextTz;
  return String(meta?.timezone || "America/Los_Angeles");
}

/**
 * Calendar date + clock in the timezone that applies to "now".
 * @param {object} meta
 * @param {Date} [now]
 */
export function briefingNow(meta, now = new Date()) {
  const primaryTz = String(meta?.timezone || "America/Los_Angeles");
  const primaryKey = scheduleTodayKey({ timezone: primaryTz }, now);
  if (resolveBriefingTimezone(meta, primaryKey) === primaryTz) {
    return scheduleNowParts({ timezone: primaryTz }, now);
  }
  const afterTz = String(meta?.timezoneAfter?.timezone || primaryTz);
  return scheduleNowParts({ timezone: afterTz }, now);
}

export function briefingFolderId(dateKey) {
  return `${dateKey}-daily-briefing`;
}

export function briefingTodoPath(dateKey) {
  return join(
    YAN_EDUCATION_DIR,
    "todos",
    briefingFolderId(dateKey),
    "todo.json"
  );
}

export async function briefingExists(dateKey) {
  try {
    const st = await stat(briefingTodoPath(dateKey));
    return st.isFile();
  } catch {
    return false;
  }
}

export function addDaysToDateKey(dateKey, days) {
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
 * @param {unknown} raw
 * @param {string} fallback
 */
export function clockHm(raw, fallback) {
  const value = String(raw || fallback).trim();
  return /^\d{2}:\d{2}$/.test(value) ? value : fallback;
}

export function nightlyAgentsHm(meta) {
  return clockHm(meta?.nightlyAgentsLocalTime, DEFAULT_NIGHTLY_HM);
}

export function chatTitleRefreshHm(meta) {
  return clockHm(meta?.chatTitleRefreshLocalTime, DEFAULT_CHAT_TITLE_REFRESH_HM);
}

export function lifeStateCleanupHm(meta) {
  return clockHm(
    meta?.lifeStateCleanupLocalTime,
    DEFAULT_LIFE_STATE_CLEANUP_HM
  );
}

export function calendarSortHm(meta) {
  return clockHm(meta?.calendarSortLocalTime, DEFAULT_CALENDAR_SORT_HM);
}

export function contextSynthesisHm(meta) {
  return clockHm(meta?.contextSynthesisLocalTime, DEFAULT_SYNTHESIS_HM);
}

export function brainProjectionHm(meta) {
  return clockHm(meta?.brainProjectionLocalTime, DEFAULT_BRAIN_PROJECTION_HM);
}

function compileHm(meta) {
  return clockHm(meta?.compileLocalTime, DEFAULT_COMPILE_HM);
}

export function dueHm(meta) {
  return clockHm(meta?.dueLocalTime, DEFAULT_DUE_HM);
}

/** @param {string} hm */
export function hmToMinutes(hm) {
  const [h, m] = String(hm)
    .split(":")
    .map((n) => Number(n));
  if (![h, m].every((n) => Number.isFinite(n))) return 0;
  return h * 60 + m;
}

/**
 * Next compile instant after `now`.
 * @param {object} meta
 * @param {Date} [now]
 */
export function nextCompileAt(meta, now = new Date()) {
  const tzs = [
    ...new Set(
      [meta?.timezone, meta?.timezoneAfter?.timezone]
        .map((z) => (typeof z === "string" ? z : ""))
        .filter(Boolean)
    ),
  ];
  const hm = compileHm(meta);
  /** @type {number[]} */
  const candidates = [];
  for (const tz of tzs) {
    const todayKey = scheduleTodayKey({ timezone: tz }, now);
    for (let add = 0; add <= 2; add++) {
      const dateKey = addDaysToDateKey(todayKey, add);
      if (resolveBriefingTimezone(meta, dateKey) !== tz) continue;
      const instant = zonedLocalToUtc(dateKey, hm, tz);
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

/**
 * @param {string} iso
 * @param {string} dateKey
 * @param {string} timezone
 */
export function isoOnDateKey(iso, dateKey, timezone) {
  if (!iso) return false;
  const key = scheduleTodayKey({ timezone }, new Date(iso));
  return key === String(dateKey);
}

/**
 * @param {string} path
 */
async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dateKey
 * @param {number} [maxLines]
 */
async function tailServerLogLines(dateKey, maxLines = 200) {
  try {
    const raw = await readFile(SERVER_LOG_PATH, "utf8");
    const lines = raw
      .split("\n")
      .filter((line) =>
        SERVER_LOG_PREFIXES.some((prefix) => line.includes(prefix))
      )
      .filter((line) => line.includes(dateKey) || !line.match(/\d{4}-\d{2}-\d{2}/));
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * @param {string} dateKey
 */
async function recentEducationCommits(dateKey) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--oneline", "-25", "--grep", dateKey, "--", "education/"],
      { cwd: REPO_ROOT, maxBuffer: 256 * 1024 }
    );
    return String(stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Write structured overnight agent status for the recap phase.
 * @param {string} dateKey
 * @param {string} timezone
 */
export async function prefetchNightlyStatus(dateKey, timezone) {
  const { pipelineFinishedOn, synthesisRanOn } = await import(
    "./context-synthesis-agent.js"
  );
  const { enrichmentRanOn } = await import("./location-enrichment-agent.js");
  const { refreshRanOn } = await import("./chat-title-refresh-agent.js");
  const { cleanupRanOn } = await import("./life-state-cleanup-agent.js");
  const { healthBrainRanOn } = await import("./health-brain-agent.js");
  const { locationBrainRanOn } = await import("./location-brain-agent.js");
  const { factCheckRanOn } = await import("./fact-check-agent.js");
  const { canvasSyncRanOn } = await import("./canvas-sync.js");

  const brainStatePath = join(
    REPO_ROOT,
    "education",
    BRIEFING_EMAIL,
    "brain",
    "state.json"
  );
  const locationStatePath = join(
    REPO_ROOT,
    "education",
    BRIEFING_EMAIL,
    "location",
    "state.json"
  );
  const brainState = (await readJsonFile(brainStatePath)) || {};
  const locationState = (await readJsonFile(locationStatePath)) || {};
  const healthState = (await readHealthState().catch(() => ({}))) || {};

  const journalKey = addDaysToDateKey(dateKey, -1);
  const journalPath = join(
    REPO_ROOT,
    "education",
    BRIEFING_EMAIL,
    "brain",
    "journal",
    `${journalKey}.md`
  );
  let journalExists = false;
  try {
    const st = await stat(journalPath);
    journalExists = st.isFile();
  } catch {
    /* missing */
  }

  const locationComposeRan = isoOnDateKey(
    locationState?.lastComposeAt,
    dateKey,
    timezone
  );
  const enrichmentRan = await enrichmentRanOn(dateKey);
  const takeawaysRan =
    String(healthState?.lastTakeawaysDateKey || "") === String(dateKey);
  const canvasRan = await canvasSyncRanOn(dateKey);
  const chatRefreshRan = await refreshRanOn(dateKey);
  const lifeStateCleanupRan = await cleanupRanOn(dateKey);
  const synthesisRan = await synthesisRanOn(dateKey);
  const pipelineFinished = await pipelineFinishedOn(dateKey);
  const locationBrainRan = await locationBrainRanOn(dateKey);
  const healthBrainRan = await healthBrainRanOn(dateKey);
  const factCheckRan = await factCheckRanOn(dateKey);

  /** @type {{ name: string, expected: boolean, ran: boolean, detail: string }[]} */
  const agents = [
    {
      name: "location-compose",
      expected: true,
      ran: locationComposeRan,
      detail: locationState?.lastComposeAt
        ? `lastComposeAt ${locationState.lastComposeAt}`
        : "no lastComposeAt",
    },
    {
      name: "location-enrichment",
      expected: true,
      ran: enrichmentRan,
      detail: locationState?.enrichment?.lastEnrichmentDateKey
        ? `lastEnrichmentDateKey ${locationState.enrichment.lastEnrichmentDateKey}`
        : "no enrichment cursor",
    },
    {
      name: "health-takeaways",
      expected: true,
      ran: takeawaysRan,
      detail: healthState?.lastTakeawaysDateKey
        ? `lastTakeawaysDateKey ${healthState.lastTakeawaysDateKey} (skips when no new dumps)`
        : "no takeaways date key",
    },
    {
      name: "canvas-sync",
      expected: true,
      ran: canvasRan,
      detail: canvasRan ? "synced today" : "not synced today",
    },
    {
      name: "chat-title-refresh",
      expected: true,
      ran: chatRefreshRan,
      detail: chatRefreshRan ? "refreshed today" : "not refreshed today",
    },
    {
      name: "life-state-cleanup",
      expected: true,
      ran: lifeStateCleanupRan,
      detail: lifeStateCleanupRan ? "cleaned today" : "not cleaned today",
    },
    {
      name: "context-synthesis",
      expected: true,
      ran: synthesisRan,
      detail: pipelineFinished
        ? `pipeline finished ${brainState?.lastPipelineAt || ""}`.trim()
        : brainState?.lastSynthesisAt
          ? `synthesis ${brainState.lastSynthesisAt} phase=${brainState?.lastPipelinePhase || "unknown"} (pipeline not finished)`
          : "no synthesis timestamp",
    },
    {
      name: "location-brain",
      expected: true,
      ran: locationBrainRan,
      detail: locationState?.brainPlaces?.lastDateKey
        ? `brainPlaces.lastDateKey ${locationState.brainPlaces.lastDateKey}`
        : "no brainPlaces cursor",
    },
    {
      name: "health-brain",
      expected: true,
      ran: healthBrainRan,
      detail: healthState?.brainHealth?.lastDateKey
        ? `brainHealth.lastDateKey ${healthState.brainHealth.lastDateKey}`
        : "no brainHealth cursor",
    },
    {
      name: "fact-check",
      expected: true,
      ran: factCheckRan,
      detail: brainState?.factCheck?.lastDateKey
        ? `factCheck.lastDateKey ${brainState.factCheck.lastDateKey}`
        : "no factCheck cursor",
    },
  ];

  const payload = {
    at: new Date().toISOString(),
    dateKey,
    timezone,
    journalKey,
    journalPath,
    journalExists,
    pipelineFinished,
    pipelinePhase: brainState?.lastPipelinePhase || null,
    agents,
    brainNotes: brainState?.notes || {},
    brainCursors: brainState?.cursors || {},
    serverLogTail: await tailServerLogLines(dateKey),
    gitCommits: await recentEducationCommits(dateKey),
    lifeState: await assessLifeStateHeartbeat(),
    healthShortcut: await assessHealthShortcutHeartbeat(),
  };

  await writeFile(NIGHTLY_STATUS_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

const LOCK_STALE_MS = 45 * 60 * 1000;

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

async function draftFileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function requireKey() {
  return requireCursorApiKey();
}

export function buildNewsPrompt({ dateKey, timezone, force, dueTime }) {
  const draft = newsDraftPath(dateKey);
  const rebuild = force
    ? `Rebuild: overwrite ${draft} even if it already exists.`
    : `If ${draft} already exists and this is not a rebuild, stop. An undated ${NEWS_DRAFT_PATH} or a draft for a different date is stale. Ignore it and write today's file.`;
  return [
    "Follow the daily-news skill (.cursor/skills/daily-news/SKILL.md). Phase 1 (news draft) only.",
    "You are phase 1 of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}). Due time will be ${dueTime}.`,
    "Read profile.md, preferences.md, taste.md, and last 7 days of dailyBriefing todos (titles, bodies, votes).",
    "Pick about 10 good stories. Interest areas in the skill are guidelines, not a quota.",
    "Sources: credible left-leaning and independent outlets only. WSJ is the rightmost allowed. Never Fox or anything right of WSJ.",
    "Yesterday's briefing is for de-dupe, not a template. Do not copy its capsules. Repeat a topic only when there is a real new development, labeled New:.",
    "Do not write todo.json. Do not rewrite taste.md. Do not unslop yet.",
    `Write only ${draft} as JSON: { "capsules": [...], "citations": [...] }. News capsules only (no agent recap). Each capsule needs id, category, title, body, vote null, citations.`,
    rebuild,
  ].join("\n");
}

export function buildAgentRecapPrompt({ dateKey, timezone, force }) {
  const recap = agentRecapDraftPath(dateKey);
  const rebuild = force
    ? `Rebuild: overwrite ${recap} even if it already exists.`
    : `If ${recap} already exists and this is not a rebuild, stop.`;
  return [
    "Follow the agent-recap skill (.cursor/skills/agent-recap/SKILL.md).",
    "You are phase 2 (agent recap) of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read ${NIGHTLY_STATUS_PATH} first, then dig as the skill says (brain/state.json notes, journal, git log, server log tail).`,
    "notes.calendar is written by synthesis before actions. It is not a record of calendar creates. List Apple Calendar before saying an event stayed off.",
    `pipelineFinished false or lastPipelinePhase not finished means actions/lint did not complete. Put that under URGENT.`,
    "lifeState.issues is URGENT. Copy the detail (5-minute log fail, no GPS on disk, missing device bundle, guess error, Home/Screen Time snapshot fail). Empty issues means omit. iPad is not the phone heartbeat. Do not invent a stale-GPS failure. An old pin while Yan stayed put is expected: iOS only wakes the iPhone app on a ~500m move, a visit, or opening the app. Location compose skip no-new-points is the same, not URGENT.",
    "healthShortcut.issues is URGENT. Each issue is a missing or stale iPhone Health Shortcut dump (none in the last 12 hours). Copy the detail. Empty issues means omit. This is the Shortcut POST, not a health-takeaways skip.",
    `Write only ${recap} as JSON:`,
    '{ "id": "agent-recap", "title": "Agent Recap", "category": "other", "noVote": true, "vote": null, "body": "..." }',
    "An URGENT bullet from the last 7 daily briefing agent recaps stays on today's card until you check and the failure is gone. A quiet night is not a fix. One morning that forgot the bullet does not clear it. Rewrite the detail from this morning. School OneNote signed out, or the 1:00 Canvas sync leaving page links unwritten, stays URGENT until a night lists pages and writes the links.",
    "Body: URGENT section (omit if none), Actions section (omit if none), then general recap prose. No citations.",
    "Cover every scheduled overnight agent except the daily briefing itself.",
    rebuild,
  ].join("\n");
}

export function buildUnslopPrompt({ dateKey, timezone, force, dueTime }) {
  const draft = newsDraftPath(dateKey);
  const recap = agentRecapDraftPath(dateKey);
  const rebuild = force
    ? "Rebuild/overwrite today's Daily Briefing even if that todo already exists. Preserve capsule votes when reusing the same capsule ids."
    : "If today's briefing todo already exists, stop. Do not create a (2).";
  return [
    "You are phase 3 (unslop + assemble) of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read and apply the unslop skill (${UNSLOP_SKILL_PATH}). Do not inline the whole skill.`,
    `Read ${draft} and ${recap}. Unslop news capsule titles and bodies plus the agent recap body. Do not remove an URGENT bullet. Phase 2 kept it because the failure is still open.`,
    `If ${draft} is missing, do not copy yesterday's todo news. Stop and say the news draft is missing.`,
    `Write ${YAN_EDUCATION_DIR}/todos/${dateKey}-daily-briefing/todo.json:`,
    `Title like "August 12th Daily Briefing". kind dailyBriefing. dueDate ${dateKey}, dueTime ${dueTime}. showInDates false. done false. createdAt is now, not a copy of yesterday.`,
    "capsules: agent-recap first (from agent recap draft, keep noVote true), then ~10 news capsules. Top-level citations from news draft only, alphabetical by name.",
    "Capsule thumbs are 3-way: up, down, null (neutral). Agent recap has noVote and no citations.",
    "Then rewrite /Users/you/Library/CloudStorage/OneDrive-Personal/Projects/.education/daily-briefing/taste.md from last week's news thumbs only (not agent recap).",
    rebuild,
  ].join("\n");
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
export async function runDailyBriefing(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runDailyBriefingOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {string} name
 * @param {import("node:fs/promises").FileHandle} handle
 * @param {string} prompt
 * @param {{ id: string, params: { id: string, value: string }[] }} phaseModel
 */
async function runPhase(name, handle, prompt, phaseModel) {
  try {
    await handle.writeFile(String(process.pid));
  } catch {
    /* lock still held */
  }
  const t0 = Date.now();
  const outcome = await promptWithAuthRetry({
    prefix: `daily-briefing-${name}`,
    prompt,
    model: phaseModel,
    cwd: REPO_ROOT,
  });
  if (outcome.usedFallback) {
    console.warn(`[daily-briefing-${name}] used auto after preferred-model retries`);
  }
  console.log(
    `[daily-briefing-${name}] status=${outcome.result?.status || (outcome.transientFailed ? "error" : "finished")} in ${Math.round((Date.now() - t0) / 1000)}s`
  );
  return outcome;
}

/**
 * @param {string} phase
 * @param {{ authFailed?: boolean, capacityFailed?: boolean, transientFailed?: boolean, result?: { status?: string } }} outcome
 * @param {string} dateKey
 */
function phaseFailed(phase, outcome, dateKey) {
  if (outcome.transientFailed) {
    laterAuthRetry.schedule(dateKey);
  }
  return {
    ok: false,
    dateKey,
    phase,
    status: outcome.result?.status || "error",
    reason: outcome.authFailed
      ? "auth"
      : outcome.capacityFailed
        ? "capacity"
        : "error",
  };
}

/**
 * @param {{ force?: boolean, dateKey?: string }} [opts]
 */
async function runDailyBriefingOnce({ force = false, dateKey: dateKeyOpt } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = dateKeyOpt || now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const dueTime = dueHm(meta);

  if (!force && (await briefingExists(dateKey))) {
    console.log(`[daily-briefing] skip ${dateKey}: already exists`);
    laterAuthRetry.clear();
    return { ok: true, skipped: true, reason: "exists", dateKey };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[daily-briefing] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    if (!force && (await briefingExists(dateKey))) {
      return { ok: true, skipped: true, reason: "exists", dateKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireKey();
    const newsModel = await resolveModelSelection(apiKey, BRIEFING_NEWS_MODEL_SPEC);
    const recapModel = await resolveModelSelection(apiKey, AGENT_RECAP_MODEL_SPEC);
    const unslopModel = await resolveModelSelection(apiKey, BRIEFING_UNSLOP_MODEL_SPEC);
    console.log(
      `[daily-briefing] compiling ${dateKey} tz=${timezone} news=${newsModel.id} recap=${recapModel.id} unslop=${unslopModel.id}`
    );

    await prefetchNightlyStatus(dateKey, timezone);

    const newsDraft = newsDraftPath(dateKey);
    const recapDraft = agentRecapDraftPath(dateKey);
    let outcome = { result: { status: "skipped" }, transientFailed: false };
    if (force || !(await draftFileExists(newsDraft))) {
      outcome = await runPhase(
        "news",
        handle,
        buildNewsPrompt({ dateKey, timezone, force, dueTime }),
        newsModel
      );
      if (outcome.transientFailed) return phaseFailed("news", outcome, dateKey);
    } else {
      console.log(`[daily-briefing] skip news ${dateKey}: draft exists`);
    }

    if (force || !(await draftFileExists(recapDraft))) {
      outcome = await runPhase(
        "agent-recap",
        handle,
        buildAgentRecapPrompt({ dateKey, timezone, force }),
        recapModel
      );
      if (outcome.transientFailed) return phaseFailed("agent-recap", outcome, dateKey);
    } else {
      console.log(`[daily-briefing] skip agent-recap ${dateKey}: draft exists`);
    }

    outcome = await runPhase(
      "unslop",
      handle,
      buildUnslopPrompt({ dateKey, timezone, force, dueTime }),
      unslopModel
    );
    if (outcome.transientFailed) return phaseFailed("unslop", outcome, dateKey);

    await gitAddCommitPush({
      paths: [YAN_EDUCATION_DIR],
      message: `education: ${dateKey} daily briefing`,
    });

    const exists = await briefingExists(dateKey);
    if (exists) {
      laterAuthRetry.clear();
      return { ok: true, dateKey, status: outcome.result?.status || "finished" };
    }
    console.error(
      `[daily-briefing] pipeline finished but todo missing for ${dateKey}`
    );
    laterAuthRetry.schedule(dateKey);
    return {
      ok: false,
      dateKey,
      status: outcome.result?.status || "unknown",
      reason: "todo-missing",
    };
  } finally {
    await releaseLock(handle);
  }
}

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(compileHm(meta))) return;
    if (await briefingExists(now.dateKey)) return;
    console.log(`[daily-briefing] missed-job recovery for ${now.dateKey}`);
    await runDailyBriefing({ dateKey: now.dateKey });
  } catch (err) {
    console.error("[daily-briefing] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextCompileAt(meta);
  const wait = schedulerWait(when);
  console.log(
    `[daily-briefing] next compile ${when.toISOString()} (in ${Math.round(wait.delay / 60000)} min)${wait.fire ? "" : " recheck"}`
  );
  timer = setTimeout(() => {
    const job = wait.fire
      ? runDailyBriefing().catch((err) =>
          console.error("[daily-briefing] scheduled run failed", err)
        )
      : Promise.resolve();
    job.finally(() => {
      readMeta()
        .then((m) => armTimer(m))
        .catch((err) => {
          console.error("[daily-briefing] reschedule failed", err);
          timer = setTimeout(() => startDailyBriefingScheduler(), 60 * 60 * 1000);
        });
    });
  }, wait.delay);
}

export function startDailyBriefingScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[daily-briefing] missed recovery", err)
        );
      }, 5000);
    })
    .catch((err) => {
      console.error("[daily-briefing] scheduler start failed", err);
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
  runDailyBriefing({ force })
    .then((result) => {
      console.log("[daily-briefing]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[daily-briefing] failed", err);
      process.exitCode = 1;
    });
}
