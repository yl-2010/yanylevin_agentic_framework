/**
 * Morning Daily Briefing: 3-phase local Cursor SDK pipeline.
 *   1. news        Grok 4.6 xhigh  draft news capsules
 *   2. agent-recap Grok 4.6 high   overnight agent recap card
 *   3. unslop      Composer 2.5    unslop + write todo.json + taste.md
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
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRIEFING_EMAIL = "you@example.com";
const LOCK_PATH = "/tmp/yanylevin-daily-briefing.lock";
const SERVER_LOG_PATH = "/tmp/personal-agent-server.log";
/** Global unslop skill. Phase 3 reads it; never inline into prompts. */
const UNSLOP_SKILL_PATH = join(homedir(), ".cursor/skills/unslop/SKILL.md");
const META_PATH = join(
  REPO_ROOT,
  "education",
  BRIEFING_EMAIL,
  "daily-briefing",
  "meta.json"
);

export const NEWS_DRAFT_PATH = "/tmp/yanylevin-daily-briefing-news-draft.json";
export const AGENT_RECAP_DRAFT_PATH =
  "/tmp/yanylevin-daily-briefing-agent-recap.json";
export const NIGHTLY_STATUS_PATH = "/tmp/yanylevin-nightly-status.json";

export const BRIEFING_NEWS_MODEL_SPEC = {
  id:
    process.env.CURSOR_PERSONAL_ATTACHMENT_MODEL ||
    process.env.CURSOR_EDUCATION_ATTACHMENT_MODEL ||
    "grok-4.6",
  params: [
    { id: "effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ],
};

export const AGENT_RECAP_MODEL_SPEC = {
  id: process.env.CURSOR_AGENT_RECAP_MODEL || "grok-4.6",
  params: [
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

export const BRIEFING_UNSLOP_MODEL_SPEC = {
  id: process.env.CURSOR_BRIEFING_UNSLOP_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const DEFAULT_NIGHTLY_HM = "01:00";
export const DEFAULT_CHAT_TITLE_REFRESH_HM = "01:30";
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
  "[fact-check]",
];

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "daily-briefing",
  run: ({ dateKey }) => runDailyBriefing({ dateKey }),
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
    REPO_ROOT,
    "education",
    BRIEFING_EMAIL,
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

/**
 * Interpret YYYY-MM-DD HH:MM in `tz` as a UTC Date.
 * @param {string} dateKey
 * @param {string} hm
 * @param {string} tz
 */
export function zonedLocalToUtc(dateKey, hm, tz) {
  const [y, mo, d] = String(dateKey)
    .split("-")
    .map((n) => Number(n));
  const [hour, minute] = String(hm)
    .split(":")
    .map((n) => Number(n));
  if (![y, mo, d, hour, minute].every((n) => Number.isFinite(n))) {
    throw new Error(`bad zoned local ${dateKey} ${hm}`);
  }
  let utc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(utc));
    const got = {
      y: Number(parts.find((p) => p.type === "year")?.value),
      m: Number(parts.find((p) => p.type === "month")?.value),
      d: Number(parts.find((p) => p.type === "day")?.value),
      hour: Number(parts.find((p) => p.type === "hour")?.value),
      minute: Number(parts.find((p) => p.type === "minute")?.value),
    };
    const wanted = Date.UTC(y, mo - 1, d, hour, minute);
    const actual = Date.UTC(got.y, got.m - 1, got.d, got.hour, got.minute);
    utc += wanted - actual;
  }
  return new Date(utc);
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
  const { synthesisRanOn } = await import("./context-synthesis-agent.js");
  const { enrichmentRanOn } = await import("./location-enrichment-agent.js");
  const { refreshRanOn } = await import("./chat-title-refresh-agent.js");
  const { healthBrainRanOn } = await import("./health-brain-agent.js");
  const { locationBrainRanOn } = await import("./location-brain-agent.js");
  const { factCheckRanOn } = await import("./fact-check-agent.js");
  const { canvasSyncRanOn } = await import("./canvas-sync.js");
  const { readHealthState } = await import("./phone-health.js");

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
  const synthesisRan = await synthesisRanOn(dateKey);
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
      name: "context-synthesis",
      expected: true,
      ran: synthesisRan,
      detail: brainState?.lastSynthesisAt
        ? `lastSynthesisAt ${brainState.lastSynthesisAt}`
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
    agents,
    brainNotes: brainState?.notes || {},
    brainCursors: brainState?.cursors || {},
    serverLogTail: await tailServerLogLines(dateKey),
    gitCommits: await recentEducationCommits(dateKey),
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

function requireKey() {
  return requireCursorApiKey();
}

export function buildNewsPrompt({ dateKey, timezone, force, dueTime }) {
  const rebuild = force
    ? "Rebuild: overwrite the news draft even if it already exists."
    : "If the news draft file already exists and this is not a rebuild, stop.";
  return [
    "Follow the daily-news skill (.cursor/skills/daily-news/SKILL.md). Phase 1 (news draft) only.",
    "You are phase 1 of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}). Due time will be ${dueTime}.`,
    "Read profile.md, preferences.md, taste.md, and last 7 days of dailyBriefing todos (titles, bodies, votes).",
    "Pick about 10 good stories. Interest areas in the skill are guidelines, not a quota.",
    "Sources: credible left-leaning and independent outlets only. WSJ is the rightmost allowed. Never Fox or anything right of WSJ.",
    "Do not write todo.json. Do not rewrite taste.md. Do not unslop yet.",
    `Write only ${NEWS_DRAFT_PATH} as JSON: { "capsules": [...], "citations": [...] }. News capsules only (no agent recap). Each capsule needs id, category, title, body, vote null, citations.`,
    rebuild,
  ].join("\n");
}

export function buildAgentRecapPrompt({ dateKey, timezone }) {
  return [
    "Follow the agent-recap skill (.cursor/skills/agent-recap/SKILL.md).",
    "You are phase 2 (agent recap) of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read ${NIGHTLY_STATUS_PATH} first, then dig as the skill says (brain/state.json notes, journal, git log, server log tail).`,
    `Write only ${AGENT_RECAP_DRAFT_PATH} as JSON:`,
    '{ "id": "agent-recap", "title": "Agent Recap", "category": "other", "noVote": true, "vote": null, "body": "..." }',
    "Body: URGENT section (omit if none), Actions section (omit if none), then general recap prose. No citations.",
    "Cover every scheduled overnight agent except the daily briefing itself.",
  ].join("\n");
}

export function buildUnslopPrompt({ dateKey, timezone, force, dueTime }) {
  const rebuild = force
    ? "Rebuild/overwrite today's Daily Briefing even if that todo already exists. Preserve capsule votes when reusing the same capsule ids."
    : "If today's briefing todo already exists, stop. Do not create a (2).";
  return [
    "You are phase 3 (unslop + assemble) of Yan's morning Daily Briefing pipeline. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Read and apply the unslop skill (${UNSLOP_SKILL_PATH}). Do not inline the whole skill.`,
    `Read ${NEWS_DRAFT_PATH} and ${AGENT_RECAP_DRAFT_PATH}. Unslop news capsule titles and bodies plus the agent recap body.`,
    `Write education/${BRIEFING_EMAIL}/todos/${dateKey}-daily-briefing/todo.json:`,
    `Title like "August 12th Daily Briefing". kind dailyBriefing. dueDate ${dateKey}, dueTime ${dueTime}. showInDates false.`,
    "capsules: agent-recap first (from agent recap draft, keep noVote true), then ~10 news capsules. Top-level citations from news draft only, alphabetical by name.",
    "Capsule thumbs are 3-way: up, down, null (neutral). Agent recap has noVote and no citations.",
    "Then rewrite education/you@example.com/daily-briefing/taste.md from last week's news thumbs only (not agent recap).",
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

    let outcome = await runPhase(
      "news",
      handle,
      buildNewsPrompt({ dateKey, timezone, force, dueTime }),
      newsModel
    );
    if (outcome.transientFailed) return phaseFailed("news", outcome, dateKey);

    outcome = await runPhase(
      "agent-recap",
      handle,
      buildAgentRecapPrompt({ dateKey, timezone }),
      recapModel
    );
    if (outcome.transientFailed) return phaseFailed("agent-recap", outcome, dateKey);

    outcome = await runPhase(
      "unslop",
      handle,
      buildUnslopPrompt({ dateKey, timezone, force, dueTime }),
      unslopModel
    );
    if (outcome.transientFailed) return phaseFailed("unslop", outcome, dateKey);

    await gitAddCommitPush({
      paths: [`education/${BRIEFING_EMAIL}`],
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
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[daily-briefing] next compile ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runDailyBriefing()
      .catch((err) => console.error("[daily-briefing] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[daily-briefing] reschedule failed", err);
            timer = setTimeout(() => startDailyBriefingScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
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
