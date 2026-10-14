/**
 * Canvas LMS fetch + dashboard sync agents.
 * Nightly: Grok 4.7 xhigh, full map (new classes, syllabus, dates).
 * Hourly: Composer 2.5 (not fast), mapped classes only.
 * Live overlay: page-open GET of submissions, grades, and planner overrides.
 * Token from server/.env (never commit). Agents never write done into todo.json.
 * Express may POST planner overrides when Yan checks off a Canvas todo.
 * Planner items only go back about two weeks. Overrides are the completion
 * record after that, so a checkoff still counts once the item leaves the feed.
 * Yan saying submit uses canvas-files.js (OneDrive file, text, or URL).
 * Hourly/nightly agents still do not POST submissions.
 * Full fetch also dumps comments, pages, modules, and course files into
 * .canvas/ for the agent. Teacher comments also overlay onto todo pages.
 * Pages, modules, and course files stay off the education UI.
 */

import { mkdir, open, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
  hmToMinutes,
  nightlyAgentsHm,
  resolveBriefingTimezone,
  zonedLocalToUtc,
} from "./daily-briefing-agent.js";
import { listClassEntriesForRoot, scheduleTodayKey } from "./education-data.js";
import { formatDeletedBlock, loadDeletedMarkdown } from "./education-match.js";
import { gitAddCommitPush } from "./git-publish.js";
import { attachCanvasComments, attachCanvasOverlay, canvasAssignmentIdFromLink } from "./canvas-grades.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

export const CANVAS_REL = `education/${YAN_EMAIL}/.canvas`;
export function canvasSyncHm(meta) {
  return nightlyAgentsHm(meta);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_BASE = "https://canvas.instructure.com";
const META_PATH = join(ROOT, "education", YAN_EMAIL, "daily-briefing", "meta.json");
const LOCK_PATH = "/tmp/yanylevin-canvas-sync.lock";
export const CANVAS_LOCK_STALE_MS = 90 * 60 * 1000;
export const CANVAS_LOCK_RETRY_MS = 3 * 60 * 1000;
const SKILL_PATH = ".cursor/skills/personal-canvas/SKILL.md";

export const CANVAS_SYNC_MODEL_SPEC = {
  id: process.env.CURSOR_CANVAS_SYNC_MODEL || "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "xhigh" },
    { id: "fast", value: "false" },
  ],
};

export const CANVAS_HOURLY_MODEL_SPEC = {
  id: process.env.CURSOR_CANVAS_HOURLY_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const LIVE_TIMEOUT_MS = 12_000;
export const LIVE_MIN_INTERVAL_MS = 10_000;

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let hourlyTimer = null;
/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {Promise<unknown>|null} */
let hourlyInFlight = null;
/** @type {{ snapshot: object, at: number }|null} */
let liveCache = null;
/** @type {Promise<object|null>|null} */
let liveFetchInFlight = null;
/** @type {{ comments: object[], at: number }|null} */
let liveCommentCache = null;
/** @type {Promise<object[]>|null} */
let liveCommentFetchInFlight = null;
const PENDING_COMPLETE_MS = 90_000;
/** @type {Map<number, { complete: boolean, overrideId?: string, at: number }>} */
const pendingComplete = new Map();

const laterAuthRetry = createLaterAuthRetry({
  prefix: "canvas-sync",
  run: () => runCanvasSync({ force: true }),
});

const hourlyLaterAuthRetry = createLaterAuthRetry({
  prefix: "canvas-hourly",
  run: () => runCanvasHourlySync({ force: true }),
});

export function canvasConfig() {
  const base = String(process.env.CANVAS_BASE_URL || DEFAULT_BASE)
    .trim()
    .replace(/\/+$/, "");
  const token = String(process.env.CANVAS_ACCESS_TOKEN || "").trim();
  return { base, token, configured: Boolean(base && token) };
}

/** @param {string} [override] */
export function canvasDir(override) {
  const explicit = String(override || "").trim();
  if (explicit) return explicit;
  return join(ROOT, CANVAS_REL);
}

export function clip(raw, max = 200) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

export function stripHtml(html, max = 4000) {
  const text = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, max);
}

function looksLikeFilename(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 180) return false;
  if (/^(download|preview|view|file)$/i.test(s)) return false;
  return /\.[a-z0-9]{2,8}$/i.test(s);
}

/**
 * Teacher-attached files from assignment HTML and any `attachments` array.
 * @param {unknown} html
 * @param {unknown} attachments
 * @returns {{ id: number, name: string }[]}
 */
export function parseCanvasFileRefs(html, attachments = []) {
  /** @type {Map<number, { id: number, name: string }>} */
  const out = new Map();
  const add = (rawId, rawName = "") => {
    const id = Number(rawId);
    if (!Number.isFinite(id) || id <= 0) return;
    const name = looksLikeFilename(rawName) ? String(rawName).trim() : "";
    const prev = out.get(id);
    if (!prev) {
      out.set(id, { id, name });
      return;
    }
    if (name && !prev.name) prev.name = name;
  };
  if (Array.isArray(attachments)) {
    for (const row of attachments) {
      add(
        row?.id ?? row?.attachment_id,
        row?.display_name || row?.filename || row?.name || ""
      );
    }
  }
  const raw = String(html || "");
  const re = /\/files\/(\d+)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const start = Math.max(0, m.index - 240);
    const slice = raw.slice(start, m.index + 280);
    const titled = slice.match(/title="([^"]+)"/i);
    const linked = slice.match(/>([^<]{1,180})<\/a>/i);
    add(m[1], (titled && titled[1]) || (linked && linked[1].trim()) || "");
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
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
    : canvasSyncHm(meta);
  /** @type {number[]} */
  const candidates = [];
  for (const tz of tzs) {
    const todayKey = scheduleTodayKey({ timezone: tz }, now);
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

export function nextCanvasSyncAt(meta, now = new Date()) {
  return nextLocalHmAt(meta, canvasSyncHm(meta), now);
}

/**
 * Signal 0 existence check. EPERM means the process exists.
 * @param {unknown} pid
 * @param {(pid: number, signal: number) => void} [killFn]
 */
export function lockPidIsAlive(pid, killFn = (p, s) => process.kill(p, s)) {
  const n = Number.parseInt(String(pid ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    killFn(n, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === "EPERM");
  }
}

/**
 * True when the file lock should block a new canvas-sync.
 * Dead PIDs never block. Live PIDs block until mtime is stale.
 * @param {{ pid?: unknown, mtimeMs?: number, nowMs?: number, staleMs?: number, pidAlive?: boolean }} [opts]
 */
export function canvasLockIsBlocking({
  pid,
  mtimeMs,
  nowMs = Date.now(),
  staleMs = CANVAS_LOCK_STALE_MS,
  pidAlive,
} = {}) {
  const alive = pidAlive != null ? Boolean(pidAlive) : lockPidIsAlive(pid);
  if (!alive) return false;
  if (!Number.isFinite(mtimeMs)) return true;
  return nowMs - mtimeMs <= staleMs;
}

/**
 * In-flight lock skip retries soon. Anything else stays on the next 01:00.
 * @param {{ reason?: string } | null | undefined} result
 * @param {object} meta
 * @param {Date} [now]
 */
export function nextCanvasSyncRetryAt(result, meta, now = new Date()) {
  if (result?.reason === "in-flight") {
    return new Date(now.getTime() + CANVAS_LOCK_RETRY_MS);
  }
  return nextCanvasSyncAt(meta, now);
}

/**
 * Strip term/teacher suffixes so "American Literature (Fall) 2026-27:jsmith"
 * compares to the dashboard name "American Literature".
 * @param {unknown} raw
 */
export function normalizeCourseName(raw) {
  return String(raw || "")
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(fall|winter|spring|year)\b/g, " ")
    .replace(/\d{4}-\d{2}\S*/g, " ")
    .replace(/:[a-z][a-z0-9_-]*$/i, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a Canvas course title looks like this dashboard class.
 * Requires the dashboard name to appear in the Canvas name so "Calculus"
 * does not count as "Advanced Calculus".
 * @param {string} className
 * @param {string} courseName
 */
export function dashboardClassMatchesCanvasCourse(className, courseName) {
  const dash = normalizeCourseName(className);
  const canvas = normalizeCourseName(courseName);
  if (!dash || !canvas) return false;
  return canvas.includes(dash);
}

/**
 * @param {object|null|undefined} snapshot
 * @param {string[]} classNames
 */
export function snapshotHasDashboardClass(snapshot, classNames) {
  const courses = Array.isArray(snapshot?.courses) ? snapshot.courses : [];
  const names = (classNames || []).map((n) => String(n || "").trim()).filter(Boolean);
  return names.some((cn) =>
    courses.some((c) => dashboardClassMatchesCanvasCourse(cn, c?.name))
  );
}

/**
 * Keep Canvas courses that match a dashboard class name. Prior-year shells,
 * advisory, library, clubs, and extras are dropped (they are not stored).
 * @param {unknown[]} courses
 * @param {string[]} classNames
 */
export function selectDashboardCanvasCourses(courses, classNames) {
  const list = Array.isArray(courses) ? courses : [];
  const names = (classNames || []).map((n) => String(n || "").trim()).filter(Boolean);
  /** @type {object[]} */
  const keep = [];
  /** @type {object[]} */
  const skip = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    if (names.some((cn) => dashboardClassMatchesCanvasCourse(cn, c.name))) {
      keep.push(c);
    } else {
      skip.push(c);
    }
  }
  return { keep, skip };
}

/**
 * Drop assignments/events whose course is not a dashboard match.
 * @param {object|null|undefined} snapshot
 * @param {string[]} classNames
 */
export function filterCanvasSnapshotToDashboard(snapshot, classNames) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const { keep, skip } = selectDashboardCanvasCourses(snapshot.courses, classNames);
  const keepIds = new Set(keep.map((c) => c.id));
  return {
    ...snapshot,
    skippedCourseCount: skip.length,
    courses: keep,
    assignments: (Array.isArray(snapshot.assignments) ? snapshot.assignments : []).filter(
      (a) => keepIds.has(a?.courseId)
    ),
    events: (Array.isArray(snapshot.events) ? snapshot.events : []).filter((e) =>
      keepIds.has(e?.courseId)
    ),
  };
}

async function listDashboardClassNames() {
  const root = join(ROOT, "education", YAN_EMAIL);
  /** @type {string[]} */
  const names = [];
  for (const entry of await listClassEntriesForRoot(root)) {
    try {
      const props = JSON.parse(
        await readFile(join(entry.objectDir, "class.json"), "utf8")
      );
      if (!props || typeof props !== "object") continue;
      if (props.fixture === true || props.freePeriod === true) continue;
      const name = String(props.name || "").trim();
      if (name) names.push(name);
    } catch {
      /* skip */
    }
  }
  return names;
}

async function readCourseMap(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir || canvasDir(), "course-map.json"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

export function mappedCourseIds(map) {
  if (!map || typeof map !== "object") return [];
  return Object.keys(map)
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id));
}

export function shouldSkipCanvasHourly(meta, now = new Date()) {
  const clock = briefingNow(meta, now);
  const nightly = hmToMinutes(canvasSyncHm(meta));
  return clock.minutes >= nightly - 10 && clock.minutes < nightly + 20;
}

export function nextCanvasHourlyAt(meta, now = new Date()) {
  const clock = briefingNow(meta, now);
  const tz = clock.timezone || "America/Los_Angeles";
  let hour = Number(clock.hour) + 1;
  let dateKey = clock.dateKey;
  if (hour >= 24) {
    hour = 0;
    dateKey = addDaysToDateKey(dateKey, 1);
  }
  let cursor = zonedLocalToUtc(
    dateKey,
    `${String(hour).padStart(2, "0")}:00`,
    tz
  );
  for (let i = 0; i < 30; i++) {
    if (cursor.getTime() > now.getTime() + 2000 && !shouldSkipCanvasHourly(meta, cursor)) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() + 60 * 60 * 1000);
  }
  return cursor;
}

export function canvasHourKey(meta, now = new Date()) {
  const clock = briefingNow(meta, now);
  const hh = String(clock.hour).padStart(2, "0");
  return `${clock.dateKey}T${hh}`;
}

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function fetchPlannerItems(base, token, fetchOpts) {
  try {
    // Canvas drops planner items about two weeks after the due date.
    // This feed is only a hint for recent rows. Older checkoffs live on
    // planner overrides (fetchPlannerOverrides).
    const start = encodeURIComponent(isoDaysFromNow(-14));
    const end = encodeURIComponent(isoDaysFromNow(60));
    return await canvasGetAll(
      base,
      token,
      `/api/v1/planner/items?start_date=${start}&end_date=${end}&per_page=50`,
      { ...fetchOpts, maxPages: 6 }
    );
  } catch (err) {
    console.error("[canvas-sync] planner items", err);
    return [];
  }
}

async function fetchPlannerOverrides(base, token, fetchOpts) {
  try {
    return await canvasGetAll(
      base,
      token,
      `/api/v1/planner/overrides?per_page=100`,
      { ...fetchOpts, maxPages: 10 }
    );
  } catch (err) {
    console.error("[canvas-sync] planner overrides", err);
    return [];
  }
}

/**
 * Planner overrides are not limited to the two-week planner feed.
 * A marked-complete override keeps the assignment done after that window.
 * @param {object[]} assignments
 * @param {object[]} overrides
 * @returns {Array<[string, string]>} canvas id, override id
 */
export function applyPlannerOverrides(assignments, overrides) {
  /** @type {Array<[string, string]>} */
  const saved = [];
  if (!Array.isArray(assignments) || !assignments.length) return saved;
  const byId = new Map();
  for (const row of assignments) {
    const id = Number(row?.id);
    if (Number.isFinite(id)) byId.set(id, row);
  }
  for (const ov of overrides || []) {
    const type = String(ov?.plannable_type || "").toLowerCase();
    if (type && type !== "assignment") continue;
    const pid = Number(ov?.plannable_id);
    const row = byId.get(pid);
    if (!row) continue;
    row.plannerComplete = Boolean(ov?.marked_complete);
    const oid = ov?.id;
    if (oid != null && oid !== "") {
      row.plannerOverrideId = String(oid);
      saved.push([String(row.id), String(oid)]);
    }
  }
  return saved;
}

function applyPlannerItems(assignments, items) {
  if (!Array.isArray(assignments) || !assignments.length) return;
  const byId = new Map();
  for (const row of assignments) {
    const id = Number(row?.id);
    if (Number.isFinite(id)) byId.set(id, row);
  }
  for (const item of items || []) {
    const pid = Number(item?.plannable_id || item?.plannable?.id);
    const row = byId.get(pid);
    if (!row) continue;
    if (item?.planner_override?.marked_complete) row.plannerComplete = true;
    const oid = item?.planner_override?.id;
    if (oid != null && oid !== "") row.plannerOverrideId = String(oid);
  }
}

function canvasIdFromTodo(todo) {
  if (!todo || typeof todo !== "object") return null;
  const fromField = Number(todo.canvasId);
  if (Number.isFinite(fromField)) return fromField;
  return canvasAssignmentIdFromLink(todo.canvasLink);
}

function applyPendingComplete(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  const rows = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  const now = Date.now();
  for (const [id, pending] of pendingComplete) {
    if (now - pending.at > PENDING_COMPLETE_MS) {
      pendingComplete.delete(id);
      continue;
    }
    let row = rows.find((a) => Number(a?.id) === id);
    if (!row) {
      row = { id };
      rows.push(row);
      snapshot.assignments = rows;
    }
    row.plannerComplete = Boolean(pending.complete);
    if (pending.overrideId) row.plannerOverrideId = String(pending.overrideId);
  }
}

export function rememberLiveSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return;
  applyPendingComplete(snapshot);
  liveCache = { snapshot, at: Date.now() };
}

async function readPlannerOverrides() {
  try {
    const raw = JSON.parse(
      await readFile(join(canvasDir(), "planner-overrides.json"), "utf8")
    );
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function writePlannerOverrideMap(map) {
  const dir = canvasDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "planner-overrides.json"),
    `${JSON.stringify(map, null, 2)}\n`,
    "utf8"
  );
}

async function writePlannerOverrideId(canvasId, overrideId) {
  const id = String(canvasId || "").trim();
  const oid = String(overrideId || "").trim();
  if (!id || !oid) return;
  const map = await readPlannerOverrides();
  if (map[id] === oid) return;
  map[id] = oid;
  await writePlannerOverrideMap(map);
}

async function rememberOverrideIds(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return;
  const map = await readPlannerOverrides();
  let changed = false;
  for (const pair of pairs) {
    const id = String(pair?.[0] || "").trim();
    const oid = String(pair?.[1] || "").trim();
    if (!id || !oid || map[id] === oid) continue;
    map[id] = oid;
    changed = true;
  }
  if (changed) await writePlannerOverrideMap(map);
}

async function findPlannerOverrideId(base, token, canvasId, timeoutMs) {
  const want = Number(canvasId);
  if (!Number.isFinite(want)) return "";
  const rows = await fetchPlannerOverrides(base, token, { timeoutMs });
  const hit = rows.find(
    (row) =>
      String(row?.plannable_type || "").toLowerCase() === "assignment" &&
      Number(row?.plannable_id) === want
  );
  return hit?.id != null && hit.id !== "" ? String(hit.id) : "";
}

export function patchLiveAssignmentSubmitted(canvasId, submittedAt = new Date().toISOString()) {
  const id = Number(canvasId);
  if (!Number.isFinite(id) || !liveCache?.snapshot) return;
  const rows = Array.isArray(liveCache.snapshot.assignments)
    ? liveCache.snapshot.assignments
    : [];
  let row = rows.find((a) => Number(a?.id) === id);
  if (!row) {
    row = { id };
    rows.push(row);
    liveCache.snapshot.assignments = rows;
  }
  row.submittedAt = submittedAt;
  row.workflowState = "submitted";
  liveCache.at = Date.now();
}

export function patchLiveAssignmentComplete(canvasId, complete, overrideId) {
  const id = Number(canvasId);
  if (!Number.isFinite(id)) return;
  pendingComplete.set(id, {
    complete: Boolean(complete),
    overrideId: overrideId ? String(overrideId) : undefined,
    at: Date.now(),
  });
  if (liveCache?.snapshot) {
    applyPendingComplete(liveCache.snapshot);
    liveCache.at = Date.now();
  }
}

export async function setPlannerComplete({ canvasId, plannerOverrideId, done }) {
  const { base, token, configured } = canvasConfig();
  if (!configured) return { ok: false, reason: "not configured" };
  const id = String(canvasId || "").trim();
  if (!id) {
    const err = new Error("Missing Canvas assignment id");
    err.status = 400;
    throw err;
  }
  const marked = Boolean(done);
  let overrideId = String(plannerOverrideId || "").trim();
  if (!overrideId) {
    const stored = await readPlannerOverrides();
    overrideId = String(stored[id] || "").trim();
  }
  const timeoutMs = LIVE_TIMEOUT_MS;
  let saved;
  if (overrideId) {
    saved = await canvasWrite(
      base,
      token,
      `/api/v1/planner/overrides/${encodeURIComponent(overrideId)}`,
      "PUT",
      { marked_complete: marked },
      { timeoutMs }
    );
  } else {
    try {
      saved = await canvasWrite(
        base,
        token,
        `/api/v1/planner/overrides`,
        "POST",
        {
          plannable_type: "assignment",
          plannable_id: Number(id) || id,
          marked_complete: marked,
        },
        { timeoutMs }
      );
    } catch (err) {
      const status = Number(err?.status);
      if (status !== 400 && status !== 409 && status !== 422) throw err;
      overrideId = await findPlannerOverrideId(base, token, id, timeoutMs);
      if (!overrideId) throw err;
      saved = await canvasWrite(
        base,
        token,
        `/api/v1/planner/overrides/${encodeURIComponent(overrideId)}`,
        "PUT",
        { marked_complete: marked },
        { timeoutMs }
      );
    }
  }
  const newId = String(saved?.id || overrideId || "").trim();
  if (newId) await writePlannerOverrideId(id, newId);
  patchLiveAssignmentComplete(id, marked, newId);
  return { ok: true, plannerOverrideId: newId, done: marked };
}

export async function seedLiveCanvasTodoDone(todo, done) {
  const canvasId = canvasIdFromTodo(todo);
  if (!Number.isFinite(canvasId)) {
    return { skipped: true, reason: "no-canvas-id" };
  }
  if (!liveCache?.snapshot) {
    const disk = await readCanvasSnapshot();
    if (disk) rememberLiveSnapshot(disk);
  }
  patchLiveAssignmentComplete(canvasId, done, todo?.plannerOverrideId);
  return { skipped: false, canvasId };
}

export async function syncCanvasTodoDone(todo, done) {
  const seeded = await seedLiveCanvasTodoDone(todo, done);
  if (seeded.skipped) return { ok: false, ...seeded };
  try {
    return await setPlannerComplete({
      canvasId: seeded.canvasId,
      plannerOverrideId: todo?.plannerOverrideId,
      done,
    });
  } catch (err) {
    console.error("[canvas-sync] planner complete", err);
    return { ok: false, reason: err instanceof Error ? err.message : "write failed" };
  }
}

async function fetchCourseById(base, token, id, { timeoutMs, includeSyllabus } = {}) {
  const bits = [
    "include[]=enrollments",
    "include[]=total_scores",
    "include[]=current_grading_period_scores",
  ];
  if (includeSyllabus) bits.push("include[]=syllabus_body");
  const { data } = await canvasFetch(
    base,
    token,
    `/api/v1/courses/${id}?${bits.join("&")}`,
    { timeoutMs }
  );
  if (!data || !data.id || data.access_restricted_by_date) return null;
  return data;
}

export function localDueParts(iso, timeZone) {
  const ms = Date.parse(iso || "");
  if (!Number.isFinite(ms)) return { dueDate: "", dueTime: "" };
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone || "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const map = {};
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type !== "literal") map[p.type] = p.value;
    }
    return {
      dueDate: `${map.year}-${map.month}-${map.day}`,
      dueTime: `${map.hour}:${map.minute}`,
    };
  } catch {
    return { dueDate: "", dueTime: "" };
  }
}

export async function canvasFetch(base, token, path, { timeoutMs } = {}) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  /** @type {RequestInit} */
  const init = {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };
  const ms = Number(timeoutMs);
  if (Number.isFinite(ms) && ms > 0) {
    init.signal = AbortSignal.timeout(ms);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const e = new Error(timedOut ? `Canvas timed out ${path}` : `Canvas fetch failed ${path}`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    const err = new Error(`Canvas ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const link = res.headers.get("link") || "";
  const next = link.match(/<([^>]+)>;\s*rel="next"/);
  return { data, next: next ? next[1] : "" };
}

export async function canvasGetAll(base, token, path, { timeoutMs, maxPages } = {}) {
  /** @type {unknown[]} */
  const out = [];
  let url = path;
  const limit = Math.min(40, Math.max(1, Number(maxPages) || 40));
  for (let i = 0; i < limit; i++) {
    const page = await canvasFetch(base, token, url, { timeoutMs });
    if (Array.isArray(page.data)) out.push(...page.data);
    else if (page.data) out.push(page.data);
    if (!page.next) break;
    url = page.next;
  }
  return out;
}

async function canvasWrite(base, token, path, method, body, { timeoutMs } = {}) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  /** @type {RequestInit} */
  const init = {
    method: String(method || "POST").toUpperCase(),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body || {}),
  };
  const ms = Number(timeoutMs);
  if (Number.isFinite(ms) && ms > 0) {
    init.signal = AbortSignal.timeout(ms);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    const e = new Error(timedOut ? `Canvas timed out ${path}` : `Canvas write failed ${path}`);
    e.status = 502;
    throw e;
  }
  if (!res.ok) {
    const err = new Error(`Canvas ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function firstStudentEnrollment(course, extra = null) {
  const listed = Array.isArray(course?.enrollments) ? course.enrollments : [];
  const student = listed.find((e) =>
    String(e?.type || e?.role || "").toLowerCase().includes("student")
  );
  return extra || student || listed[0] || null;
}

function finiteScore(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Student-facing course total. Canvas `current_score` is what the grades
 * page shows (n/a until something is posted). `final_score` treats missing
 * work as 0, so History looked like 12% / F while Canvas still said n/a.
 */
export function courseScores(course, extraEnrollment = null) {
  const enrollment = firstStudentEnrollment(course, extraEnrollment) || {};
  const grades =
    enrollment.grades && typeof enrollment.grades === "object"
      ? enrollment.grades
      : enrollment;
  const currentScore = finiteScore(
    grades.current_score,
    enrollment.computed_current_score,
    enrollment.current_period_computed_current_score,
    course?.current_score
  );
  const letter = String(
    grades.current_grade ||
      enrollment.computed_current_grade ||
      enrollment.current_period_computed_current_grade ||
      ""
  ).trim();
  return {
    grade: clip(
      letter || (currentScore != null ? String(currentScore) : ""),
      24
    ),
    currentScore,
  };
}

function assignmentRow(item, course, timeZone) {
  const title = clip(item?.name || item?.title, 160);
  if (!title) return null;
  const dueAtRaw = item?.due_at || "";
  const dueAt =
    dueAtRaw && !Number.isNaN(Date.parse(dueAtRaw))
      ? new Date(dueAtRaw).toISOString()
      : "";
  const local = localDueParts(dueAt, timeZone);
  const types = Array.isArray(item?.submission_types)
    ? item.submission_types.map((t) => clip(t, 40)).filter(Boolean)
    : [];
  const html = item?.description || "";
  const files = parseCanvasFileRefs(html, item?.attachments);
  const points = Number(item?.points_possible);
  const sub =
    item?.submission && typeof item.submission === "object"
      ? item.submission
      : null;
  const score = Number(sub?.score ?? sub?.entered_score ?? sub?.published_score);
  const gradeText = String(sub?.grade || sub?.entered_grade || "");
  const pctFromGrade = /%$/.test(gradeText)
    ? Number(gradeText.replace(/%$/, ""))
    : NaN;
  return {
    id: item?.id ?? null,
    courseId: course?.id ?? item?.course_id ?? null,
    course: clip(course?.name, 120),
    title,
    dueAt,
    dueDate: local.dueDate,
    dueTime: local.dueTime,
    htmlUrl: clip(item?.html_url, 400),
    points: Number.isFinite(points) ? points : null,
    pointsPossible: Number.isFinite(points) ? points : null,
    score: Number.isFinite(score) ? score : null,
    percent: Number.isFinite(pctFromGrade) ? pctFromGrade : null,
    grade: clip(gradeText, 24),
    submittedAt: sub?.submitted_at || "",
    workflowState: clip(sub?.workflow_state, 24),
    excused: Boolean(sub?.excused),
    plannerComplete: Boolean(item?.planner_override?.marked_complete),
    plannerOverrideId: clip(item?.planner_override?.id, 24),
    types,
    files,
    description: stripHtml(html, 1500),
  };
}

function eventRow(item, courseById, timeZone) {
  if (String(item?.type || "").toLowerCase() === "assignment") return null;
  const title = clip(item?.title || item?.name, 160);
  if (!title) return null;
  const startRaw = item?.start_at || item?.start_date || "";
  const startAt =
    startRaw && !Number.isNaN(Date.parse(startRaw))
      ? new Date(startRaw).toISOString()
      : "";
  const local = localDueParts(startAt, timeZone);
  const contextCode = String(item?.context_code || "");
  const courseIdMatch = contextCode.match(/course_(\d+)/);
  const courseId = item?.course_id || (courseIdMatch ? Number(courseIdMatch[1]) : null);
  const course = courseById.get(courseId);
  return {
    id: item?.id ?? null,
    courseId,
    course: clip(course?.name, 120),
    title,
    startAt,
    date: local.dueDate,
    time: local.dueTime,
    htmlUrl: clip(item?.html_url, 400),
    description: stripHtml(item?.description, 800),
  };
}

/**
 * @param {{ snapshotDir?: string, now?: Date }} [opts]
 */
export function formatCanvasAssignmentsMarkdown(snapshot, opts = {}) {
  const now = opts.now || new Date();
  const lines = [
    "# Canvas snapshot",
    "",
    `Updated: ${snapshot.updatedAt || now.toISOString()}`,
    `Timezone: ${snapshot.timezone || ""}`,
    "",
    "Agent maps these rows onto existing education dashboard classes (personal-canvas skill).",
    "Only dashboard / junior-year classes are stored. Never copy done/completed from Canvas.",
    "",
  ];
  const skipped = Number(snapshot.skippedCourseCount) || 0;
  if (skipped > 0) {
    lines.push(
      `Dropped ${skipped} Canvas enrollment${skipped === 1 ? "" : "s"} that do not match dashboard classes.`,
      ""
    );
  }
  const courses = Array.isArray(snapshot.courses) ? snapshot.courses : [];
  if (courses.length) {
    lines.push("## Courses", "");
    for (const c of courses) {
      const grade = c.grade ? ` grade ${c.grade}` : "";
      const code = c.courseCode ? ` [${c.courseCode}]` : "";
      lines.push(
        `- ${c.name}${code}${c.id != null ? ` (id ${c.id})` : ""}${grade}`
      );
    }
    lines.push("");
  }
  const items = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  items.sort((a, b) => {
    const da = Date.parse(a.dueAt || "") || 0;
    const db = Date.parse(b.dueAt || "") || 0;
    return da - db;
  });
  lines.push("## Assignments", "");
  if (!items.length) {
    lines.push("(none)", "");
  } else {
    for (const a of items) {
      const due = a.dueDate
        ? `${a.dueDate}${a.dueTime ? ` ${a.dueTime}` : ""}`
        : a.dueAt
          ? a.dueAt.replace("T", " ").slice(0, 16)
          : "undated";
      const course = a.course ? ` — ${a.course}` : "";
      const link = a.htmlUrl ? ` — ${a.htmlUrl}` : "";
      const id = a.id != null ? ` [canvasId ${a.id}]` : "";
      lines.push(`- **${a.title}** — due ${due}${course}${id}${link}`);
    }
    lines.push("");
  }
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (events.length) {
    lines.push("## Calendar events (not assignments)", "");
    for (const e of events.slice(0, 80)) {
      const when = e.date ? `${e.date}${e.time ? ` ${e.time}` : ""}` : "undated";
      const course = e.course ? ` — ${e.course}` : "";
      const link = e.htmlUrl ? ` — ${e.htmlUrl}` : "";
      lines.push(`- **${e.title}** — ${when}${course}${link}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Count assignments due in the next `hours` hours (and not more than 12h overdue).
 * @param {unknown} snapshot
 * @param {number} [hours]
 * @param {Date} [now]
 */
export function canvasDueSoonCount(snapshot, hours = 48, now = new Date()) {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const items = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  const end = now.getTime() + hours * 3600_000;
  const start = now.getTime() - 12 * 3600_000;
  let n = 0;
  for (const a of items) {
    const ms = Date.parse(a?.dueAt || "");
    if (!Number.isFinite(ms)) continue;
    if (ms >= start && ms <= end) n += 1;
  }
  return n;
}

/** @param {string} [dir] */
export async function readCanvasSnapshot(dir) {
  try {
    const raw = JSON.parse(await readFile(join(canvasDir(dir), "snapshot.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} [dir]
 * @param {Date} [now]
 */
export async function formatCanvasLiveLine(dir, now = new Date()) {
  const snap = await readCanvasSnapshot(dir);
  if (!snap) return "";
  const n = canvasDueSoonCount(snap, 48, now);
  if (n === 0) return "Canvas: nothing due in 48h (last snapshot).";
  const noun = n === 1 ? "item" : "items";
  return `Canvas: ${n} ${noun} due in 48h. Read ${SKILL_PATH} to sync or inspect.`;
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

async function readLastAgentSync(dir) {
  try {
    const raw = JSON.parse(await readFile(join(dir, "last-agent-sync.json"), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dateKey
 * @param {string} [dir]
 */
export async function canvasSyncRanOn(dateKey, dir) {
  const last = await readLastAgentSync(dir || canvasDir());
  return String(last?.dateKey || "") === String(dateKey);
}

async function writeLastAgentSync(dir, payload) {
  await writeFile(
    join(dir, "last-agent-sync.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

async function writeLastHourlySync(dir, payload) {
  await writeFile(
    join(dir, "last-hourly-sync.json"),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8"
  );
}

async function readLastHourlySync(dir) {
  try {
    return JSON.parse(await readFile(join(dir || canvasDir(), "last-hourly-sync.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Pull dashboard-matching courses, then their assignments (and optionally
 * syllabi / events). Submissions are for scores and live completion overlay.
 * @param {{
 *   dir?: string,
 *   timeZone?: string,
 *   light?: boolean,
 *   mappedOnly?: boolean,
 *   persist?: boolean,
 *   timeoutMs?: number,
 * }} [opts]
 */
export async function fetchCanvasSnapshot(opts = {}) {
  const { base, token, configured } = canvasConfig();
  if (!configured) {
    return { ok: false, reason: "not configured" };
  }
  const meta = await readMeta().catch(() => ({ timezone: "America/Los_Angeles" }));
  const now = briefingNow(meta);
  const timeZone = opts.timeZone || now.timezone || "America/Los_Angeles";
  const dateKey = now.dateKey;
  const light = Boolean(opts.light);
  const mappedOnly = Boolean(opts.mappedOnly);
  const persist = opts.persist !== false;
  const timeoutMs = opts.timeoutMs;
  const dir = canvasDir(opts.dir);
  const fetchOpts = timeoutMs != null ? { timeoutMs } : {};

  const classNames = await listDashboardClassNames();
  const courseMap = await readCourseMap(dir);
  /** @type {object[]} */
  let courses = [];
  /** @type {object[]} */
  let skip = [];

  if (mappedOnly) {
    const ids = mappedCourseIds(courseMap);
    if (!ids.length) {
      const empty = {
        updatedAt: new Date().toISOString(),
        base,
        timezone: timeZone,
        dateKey,
        skippedCourseCount: 0,
        courses: [],
        assignments: [],
        events: [],
      };
      return {
        ok: true,
        courses: 0,
        skippedCourses: 0,
        assignments: 0,
        events: 0,
        snapshot: empty,
      };
    }
    const fetched = await Promise.all(
      ids.map((id) =>
        fetchCourseById(base, token, id, {
          timeoutMs,
          includeSyllabus: !light,
        }).catch((err) => {
          console.error(`[canvas-sync] course ${id}`, err);
          return null;
        })
      )
    );
    courses = fetched.filter(Boolean);
  } else {
    const coursesRaw = await canvasGetAll(
      base,
      token,
      `/api/v1/courses?enrollment_state=current_and_future&per_page=50&include[]=enrollments&include[]=total_scores&include[]=current_grading_period_scores`,
      fetchOpts
    );
    const visible = coursesRaw.filter((c) => c && !c.access_restricted_by_date);
    const picked = selectDashboardCanvasCourses(visible, classNames);
    courses = picked.keep;
    skip = picked.skip;
  }

  const courseById = new Map(courses.map((c) => [c.id, c]));
  /** @type {Map<number, object>} */
  const enrollmentByCourse = new Map();
  if (!mappedOnly) {
    try {
      const ownEnrollments = await canvasGetAll(
        base,
        token,
        `/api/v1/users/self/enrollments?state[]=active&state[]=invited&per_page=50`,
        fetchOpts
      );
      for (const row of ownEnrollments) {
        const id = Number(row?.course_id);
        if (Number.isFinite(id) && !enrollmentByCourse.has(id)) {
          enrollmentByCourse.set(id, row);
        }
      }
    } catch (err) {
      console.error("[canvas-sync] enrollments", err);
    }
  }

  if (!light && !mappedOnly) {
    for (const course of courses) {
      try {
        const { data } = await canvasFetch(
          base,
          token,
          `/api/v1/courses/${course.id}?include[]=syllabus_body`,
          fetchOpts
        );
        if (data && typeof data === "object" && data.syllabus_body) {
          course.syllabus_body = data.syllabus_body;
        }
      } catch (err) {
        console.error(`[canvas-sync] syllabus course ${course.id}`, err);
      }
    }
  }

  const plannerPromise = fetchPlannerItems(base, token, fetchOpts);
  const overridePromise = fetchPlannerOverrides(base, token, fetchOpts);
  /** @type {ReturnType<typeof assignmentRow>[]} */
  const assignmentChunks = await Promise.all(
    courses.map(async (course) => {
      try {
        const rows = await canvasGetAll(
          base,
          token,
          `/api/v1/courses/${course.id}/assignments?per_page=50&order_by=due_at&include[]=submission`,
          fetchOpts
        );
        return rows
          .map((item) => assignmentRow(item, course, timeZone))
          .filter(Boolean);
      } catch (err) {
        console.error(`[canvas-sync] assignments course ${course.id}`, err);
        return [];
      }
    })
  );
  const assignments = assignmentChunks.flat();
  applyPlannerItems(assignments, await plannerPromise);
  const overrideIds = applyPlannerOverrides(assignments, await overridePromise);
  try {
    await rememberOverrideIds(overrideIds);
  } catch (err) {
    console.error("[canvas-sync] planner override ids", err);
  }

  const year = Number(String(dateKey).slice(0, 4));
  const month = Number(String(dateKey).slice(5, 7));
  const schoolStartYear = month >= 7 ? year : year - 1;
  const startDate = `${schoolStartYear}-08-01`;
  const endDate = `${schoolStartYear + 1}-07-31`;
  /** @type {ReturnType<typeof eventRow>[]} */
  let events = [];
  if (!light) {
    const eventChunks = await Promise.all(
      courses.map(async (course) => {
        try {
          const rows = await canvasGetAll(
            base,
            token,
            `/api/v1/calendar_events?type=event&context_codes[]=course_${course.id}&start_date=${startDate}&end_date=${endDate}&per_page=50`,
            fetchOpts
          );
          return rows
            .map((item) => eventRow(item, courseById, timeZone))
            .filter(Boolean);
        } catch (err) {
          console.error(`[canvas-sync] events course ${course.id}`, err);
          return [];
        }
      })
    );
    events = eventChunks.flat();
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    base,
    timezone: timeZone,
    dateKey,
    skippedCourseCount: skip.length,
    light,
    mappedOnly,
    courses: courses.map((c) => {
      const scores = courseScores(c, enrollmentByCourse.get(Number(c.id)));
      return {
        id: c.id,
        name: clip(c.name, 120),
        courseCode: clip(c.course_code, 40),
        htmlUrl: `${base}/courses/${c.id}`,
        syllabusUrl: `${base}/courses/${c.id}/assignments/syllabus`,
        grade: scores.grade,
        currentScore: scores.currentScore,
        syllabus: light ? "" : stripHtml(c.syllabus_body, 8000),
      };
    }),
    assignments,
    events,
  };

  /** @type {object|null} */
  let context = null;
  if (!light) {
    try {
      const {
        fetchCanvasContext,
        persistCanvasContext,
      } = await import("./canvas-context.js");
      const dumped = await fetchCanvasContext(
        base,
        token,
        snapshot.courses,
        fetchOpts
      );
      if (persist) {
        context = await persistCanvasContext(dir, {
          ...dumped,
          updatedAt: snapshot.updatedAt,
        });
      } else {
        context = {
          comments: dumped.comments.length,
          pages: dumped.pages.length,
          modules: dumped.modules.length,
          files: dumped.files.length,
        };
      }
    } catch (err) {
      console.error("[canvas-sync] context dump", err);
    }
  }

  rememberLiveSnapshot(snapshot);
  if (persist) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    await writeFile(join(dir, "assignments.md"), formatCanvasAssignmentsMarkdown(snapshot), "utf8");
  }
  return {
    ok: true,
    courses: snapshot.courses.length,
    skippedCourses: skip.length,
    assignments: assignments.length,
    events: events.length,
    context,
    snapshot,
  };
}

function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

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
      "[canvas-sync] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

export function buildCanvasSyncPrompt({
  dateKey,
  timezone,
  force,
  deletedBlock,
  hourlyBlock,
}) {
  const rebuild = force
    ? "This is a forced/manual sync. Re-read the snapshot and apply the skill even if last-agent-sync.json is today."
    : "If last-agent-sync.json is already today and the snapshot has not grown new work, still apply any missing todos/dates from the snapshot.";
  const deleted =
    typeof deletedBlock === "string" && deletedBlock.trim()
      ? deletedBlock.trim()
      : "";
  const hourly =
    typeof hourlyBlock === "string" && hourlyBlock.trim()
      ? hourlyBlock.trim()
      : "";
  return [
    `Follow ${SKILL_PATH}. Sync Canvas into Yan's education dashboard.`,
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Snapshot: ${CANVAS_REL}/snapshot.json (also assignments.md). Optional map: ${CANVAS_REL}/course-map.json.`,
    `Agent context dumps: ${CANVAS_REL}/comments.md, comments-new.md, pages.md, modules.md, files.md (and the matching .json). Teacher comments show on the todo page from the live overlay. Pages, modules, and course files stay off the UI.`,
    "Read comments-new.md. Fold new teacher comments into that class or todo .CONTEXT.md on OneDrive (Finder-hidden, and hidden from the education UI). Skip a comment already in .CONTEXT.md. Do not copy comments into .todo.json description. Do not create dashboard tiles from pages, modules, or course files. Use those dumps when writing todo descriptions or class .CONTEXT.md if they explain the work.",
    `Hourly Composer log: ${CANVAS_REL}/last-hourly-sync.json. Read it. Fix mistakes those daytime Composer 2.5 passes made (wrong tags, HW: prefixes left on names, Adv Calc HW dues pulled back to Canvas time, Data Science number/stat visual due pulled back to 2026-11-18, yoga CW hiddenFromHome, missing canvasId, duplicate todos, course-map drift).`,
    "Yan is a 2026-27 junior. Those academic dashboard classes are often missing from Canvas until school publishes them. That is expected.",
    "FIRST: map snapshot courses to Yan's class folders (OneDrive `.education` under the grade folder, skip free-period shells and fixtures). The snapshot already dropped non-dashboard enrollments. If ZERO dashboard classes appear in Canvas, STOP immediately. Do not invent Class of 2028, EPS Library, Iceland EBC, Graphic Design, or prior-year shells. Do not create todos. One short note is enough.",
    "If at least one class maps: set class.json canvasLink to that course gradebook (htmlUrl + /grades). Create or update todos for every Canvas assignment on those mapped classes only. Set canvasLink and canvasId. Tag CW/HW/QA/MA. Store name without a CW/HW/QA/MA prefix (HW: Signed Syllabus → Signed Syllabus). Use snapshot dueDate/dueTime.",
    "Pull major syllabus / calendar-event dates onto .date.json with canvasLink. OneDrive class bookkeeping is Finder-hidden: .todo.json, .date.json, .CONTEXT.md. Do not write a plain todo.json next to .todo.json.",
    "NEVER write done or completedAt from Canvas. New todos start done false. Updates leave those keys untouched. Page-load overlay paints completion in the API; you still must not persist it. Preserve finderHidden when it is already set.",
    "Do not POST to Canvas. Do not delete education todos just because Canvas dropped a row.",
    "Leave canvasFiles on .todo.json alone. Express downloads teacher attachments into the OneDrive todo folder after you finish. Spanish 4 pasted decoration images (image-<uuid>, image.png) are not downloaded.",
    "Do not recreate a todo or date that looks like a manually deleted.md row. Judgement, not exact due clocks. canvasId is a strong hint.",
    `After the Canvas writes, link OneNote pages yourself. Tag does not matter (CW, HW, QA, MA, or none). If Yan would open the page for that todo, link it. Two passes. Do not run link-todos. Use node server/school-onenote.js (status, sections, pages). Read _Content Library and the Yan Levin group. Skip _Collaboration Space. Seen page ids are ${CANVAS_REL}/onenote-seen.json, shape { "pages": { "<pageId>": { "title": "", "notebook": "" } } }. If that file is missing, pass 1 has no new pages. Pass 1: a page id not in that file is new. For each new page, check every todo in that class, any due date. Pass 2: every todo created tonight, and every todo with dueDate from today through 14 days out in this timezone, done or not, any tag. For each of those, check the class notebook for applicable pages, including pages already in onenote-seen.json. A page in Yan's notebook is a site named with the assignment name, oneNote personal. A Content Library page is a site named Content Library: plus the page title, oneNote content-library. Copy url (https webUrl), clientUrl (onenote:), and pageId. The same page may go on every todo it applies to. Do not cap how many OneNote sites a todo has. Do not remove an existing OneNote site because this pass did not mention it. Skip a pageId already on that todo. Keep sites that are not OneNote. If OneNote is signed out or a notebook fails, leave existing OneNote sites and skip both passes. Do not put OneNote URLs in description. A path in the description is not the link. A Canvas description that names a Content Library page means that page applies. After both passes, rewrite onenote-seen.json from the pages you listed.`,
    "After the OneNote sites, look at the other todos in the same class. If Yan would use a file in another todo's folder, add linkedFiles on this todo. name is the filename. pageId is optional, only when the OneNote site stays on the other todo and this todo should show the same button. Include canvasId so a renamed folder still resolves, and todo as the Finder folder id. Do not copy the file. Do not replace this todo's OneNote sites. Drop a pointer that no longer fits. Files Express downloads after you finish can be linked the next night. Tag does not matter for these pointers.",
    rebuild,
    hourly,
    deleted,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildCanvasHourlyPrompt({ dateKey, hourKey, timezone, deletedBlock }) {
  const deleted =
    typeof deletedBlock === "string" && deletedBlock.trim()
      ? deletedBlock.trim()
      : "";
  return [
    `Follow ${SKILL_PATH} (hourly pass). Sync Canvas todos into already mapped classes only.`,
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} hour ${hourKey} (timezone ${timezone}).`,
    `Snapshot: ${CANVAS_REL}/snapshot.json (light, mapped courses only). Map: ${CANVAS_REL}/course-map.json.`,
    "Do not look for new classes. Do not create class folders. Do not edit course-map.json. Do not mine syllabi or invent dates from empty events.",
    "Do not fold Canvas comments, pages, modules, or course files on the hourly pass. That is nightly / manual.",
    "For every snapshot assignment whose courseId is already in course-map.json: create or update the class todo (canvasId, canvasLink, tag, name without CW/HW/QA/MA prefix, dueDate/dueTime). Same Adv Calc HW due shift, Data Science number/stat visual due (2026-10-06 13:50, canvasId 40073385), and yoga hiddenFromHome rules.",
    "If the snapshot matches existing todos, do nothing.",
    "NEVER write done or completedAt from Canvas. Do not POST to Canvas. Do not delete todos because Canvas dropped a row. Do not recreate deleted.md rows. Preserve finderHidden when it is already set.",
    "Leave canvasFiles on .todo.json alone. Express downloads teacher attachments into the OneDrive todo folder after you finish. Spanish 4 pasted decoration images (image-<uuid>, image.png) are not downloaded.",
    "Do not run link-todos. Do not link OneNote pages on the hourly pass. That is the nightly Grok pass. Do not edit linkedFiles. Cross-todo file links are the nightly pass.",
    deleted,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function getLiveCanvasSnapshot({ force = false } = {}) {
  if (liveFetchInFlight) return liveFetchInFlight;
  if (!force) {
    if (liveCache?.snapshot) return liveCache.snapshot;
    const disk = await readCanvasSnapshot();
    if (disk) rememberLiveSnapshot(disk);
    return liveCache?.snapshot || disk;
  }
  if (liveCache?.snapshot && Date.now() - liveCache.at < LIVE_MIN_INTERVAL_MS) {
    return liveCache.snapshot;
  }
  liveFetchInFlight = (async () => {
    try {
      const fetched = await fetchCanvasSnapshot({
        light: true,
        mappedOnly: true,
        persist: false,
        timeoutMs: LIVE_TIMEOUT_MS,
      });
      if (fetched.ok && fetched.snapshot) return fetched.snapshot;
    } catch (err) {
      console.error("[canvas-sync] live fetch", err);
    }
    if (liveCache?.snapshot) return liveCache.snapshot;
    return readCanvasSnapshot();
  })().finally(() => {
    liveFetchInFlight = null;
  });
  return liveFetchInFlight;
}

function rememberLiveComments(comments) {
  liveCommentCache = {
    comments: Array.isArray(comments) ? comments : [],
    at: Date.now(),
  };
}

async function readCanvasComments(dir) {
  try {
    const raw = JSON.parse(
      await readFile(join(canvasDir(dir), "comments.json"), "utf8")
    );
    return Array.isArray(raw?.comments) ? raw.comments : [];
  } catch {
    return [];
  }
}

/**
 * Same 10s gate as grades. Force refetches mapped-course submission
 * comments. Otherwise memory, then comments.json. Does not rewrite the file.
 * @param {{ force?: boolean }} [opts]
 */
export async function getLiveCanvasComments({ force = false } = {}) {
  if (liveCommentFetchInFlight) return liveCommentFetchInFlight;
  if (!force) {
    if (liveCommentCache) return liveCommentCache.comments;
    const disk = await readCanvasComments();
    rememberLiveComments(disk);
    return disk;
  }
  if (liveCommentCache && Date.now() - liveCommentCache.at < LIVE_MIN_INTERVAL_MS) {
    return liveCommentCache.comments;
  }
  liveCommentFetchInFlight = (async () => {
    try {
      const { base, token, configured } = canvasConfig();
      if (!configured) throw new Error("canvas not configured");
      const map = await readCourseMap();
      const ids = mappedCourseIds(map);
      if (!ids.length) throw new Error("no mapped courses");
      const { fetchSubmissionComments } = await import("./canvas-context.js");
      const comments = await fetchSubmissionComments(
        base,
        token,
        ids.map((id) => ({ id })),
        { timeoutMs: LIVE_TIMEOUT_MS }
      );
      rememberLiveComments(comments);
      return comments;
    } catch (err) {
      console.error("[canvas-sync] live comments", err);
    }
    if (liveCommentCache) return liveCommentCache.comments;
    return readCanvasComments();
  })().finally(() => {
    liveCommentFetchInFlight = null;
  });
  return liveCommentFetchInFlight;
}

export async function applyLiveCanvasOverlay(tree, { force = false } = {}) {
  const { configured } = canvasConfig();
  if (!configured || !tree) return tree;
  try {
    const [snapshot, comments] = await Promise.all([
      getLiveCanvasSnapshot({ force }),
      getLiveCanvasComments({ force }),
    ]);
    if (snapshot) {
      const map = await readCourseMap();
      attachCanvasOverlay(tree, snapshot, map);
    }
    attachCanvasComments(tree, comments);
  } catch (err) {
    console.error("[canvas-sync] live overlay", err);
  }
  return tree;
}

async function writeLock() {
  const handle = await open(LOCK_PATH, "wx");
  await handle.writeFile(String(process.pid));
  return handle;
}

async function stealLock(reason) {
  console.log(`[canvas-sync] stealing lock (${reason})`);
  await rm(LOCK_PATH, { force: true });
  return writeLock();
}

async function acquireLock() {
  try {
    return await writeLock();
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    try {
      const raw = await readFile(LOCK_PATH, "utf8");
      const st = await stat(LOCK_PATH);
      const pid = String(raw || "").trim();
      if (
        canvasLockIsBlocking({
          pid,
          mtimeMs: st.mtimeMs,
        })
      ) {
        return null;
      }
      const alive = lockPidIsAlive(pid);
      return await stealLock(
        alive ? `stale mtime pid=${pid || "none"}` : `dead pid=${pid || "none"}`
      );
    } catch {
      try {
        return await stealLock("unreadable");
      } catch {
        return null;
      }
    }
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
 * Fetch snapshot then (unless fetchOnly) run the Grok 4.7 xhigh sync agent.
 * @param {{ force?: boolean, fetchOnly?: boolean }} [opts]
 */
export async function runCanvasSync(opts = {}) {
  if (inFlight) return inFlight;
  inFlight = runCanvasSyncOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean, fetchOnly?: boolean }} [opts]
 */
async function runCanvasSyncOnce({ force = false, fetchOnly = false } = {}) {
  const { configured } = canvasConfig();
  if (!configured) {
    return { ok: false, reason: "not configured" };
  }
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const dir = canvasDir();

  if (!force && !fetchOnly) {
    const last = await readLastAgentSync(dir);
    if (last?.dateKey === dateKey) {
      console.log(`[canvas-sync] skip ${dateKey}: already synced`);
      laterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-synced", dateKey };
    }
  }

  const handle = fetchOnly ? null : await acquireLock();
  if (!fetchOnly && !handle) {
    console.log(`[canvas-sync] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    const fetched = await fetchCanvasSnapshot({ timeZone: timezone });
    if (!fetched.ok) return fetched;
    if (fetchOnly) {
      const files = await pullCanvasAssignmentFiles(fetched.snapshot);
      return { ok: true, fetchOnly: true, dateKey, ...fetched, files };
    }

    const classNames = await listDashboardClassNames();
    if (!snapshotHasDashboardClass(fetched.snapshot, classNames)) {
      console.log(
        `[canvas-sync] skip agent ${dateKey}: junior-year courses not in Canvas yet`
      );
      await writeLastAgentSync(dir, {
        dateKey,
        at: new Date().toISOString(),
        status: "skipped",
        reason: "junior-year-courses-not-in-canvas",
      });
      laterAuthRetry.clear();
      await gitAddCommitPush({
        paths: [`education/${YAN_EMAIL}/.canvas`],
        message: `education: ${dateKey} canvas snapshot (junior courses not published)`,
      });
      return {
        ok: true,
        skipped: true,
        reason: "junior-year-courses-not-in-canvas",
        dateKey,
        courses: fetched.courses,
        assignments: fetched.assignments,
        events: fetched.events,
      };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, CANVAS_SYNC_MODEL_SPEC);
    console.log(
      `[canvas-sync] agent ${dateKey} tz=${timezone} model=${model.id} assignments=${fetched.assignments}`
    );

    const deletedBlock = formatDeletedBlock(
      await loadDeletedMarkdown(join(ROOT, "education", YAN_EMAIL))
    );
    const lastHourly = await readLastHourlySync(dir);
    const hourlyBlock = lastHourly
      ? `Last hourly Composer run: ${JSON.stringify(lastHourly)}. Review those writes against the full snapshot.`
      : "No last-hourly-sync.json yet (no daytime Composer run recorded).";
    const prompt = buildCanvasSyncPrompt({
      dateKey,
      timezone,
      force,
      deletedBlock,
      hourlyBlock,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
      prefix: "canvas-sync",
      prompt,
      model,
      cwd: ROOT,
    });

    if (usedFallback) {
      console.warn("[canvas-sync] used auto after grok retries");
    }
    if (transientFailed) {
      laterAuthRetry.schedule(dateKey);
      return {
        ok: false,
        dateKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
        courses: fetched.courses,
        assignments: fetched.assignments,
        events: fetched.events,
      };
    }

    laterAuthRetry.clear();
    const files = await pullCanvasAssignmentFiles(fetched.snapshot);
    try {
      const { markCanvasCommentsSeen, readCanvasContext } = await import(
        "./canvas-context.js"
      );
      const ctx = await readCanvasContext(dir);
      await markCanvasCommentsSeen(dir, ctx.comments);
    } catch (err) {
      console.error("[canvas-sync] mark comments seen", err);
    }
    await writeLastAgentSync(dir, {
      dateKey,
      at: new Date().toISOString(),
      status: result?.status || "finished",
    });
    await gitAddCommitPush({
      paths: [`education/${YAN_EMAIL}`],
      message: `education: ${dateKey} canvas sync`,
    });

    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
      courses: fetched.courses,
      assignments: fetched.assignments,
      events: fetched.events,
      files,
    };
  } finally {
    if (handle) await releaseLock(handle);
  }
}

export async function runCanvasHourlySync(opts = {}) {
  if (hourlyInFlight) return hourlyInFlight;
  hourlyInFlight = runCanvasHourlySyncOnce(opts).finally(() => {
    hourlyInFlight = null;
  });
  return hourlyInFlight;
}

async function runCanvasHourlySyncOnce({ force = false } = {}) {
  const { configured } = canvasConfig();
  if (!configured) {
    return { ok: false, reason: "not configured" };
  }
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const hourKey = canvasHourKey(meta);
  const timezone = resolveBriefingTimezone(meta, dateKey);
  if (!force && shouldSkipCanvasHourly(meta)) {
    console.log(`[canvas-hourly] skip ${hourKey}: nightly window`);
    return { ok: true, skipped: true, reason: "nightly-window", dateKey, hourKey };
  }
  const dir = canvasDir();
  if (!force) {
    const last = await readLastHourlySync(dir);
    if (last?.hourKey === hourKey) {
      console.log(`[canvas-hourly] skip ${hourKey}: already ran`);
      hourlyLaterAuthRetry.clear();
      return { ok: true, skipped: true, reason: "already-hourly", dateKey, hourKey };
    }
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[canvas-hourly] skip ${hourKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey, hourKey };
  }

  try {
    const map = await readCourseMap(dir);
    if (!mappedCourseIds(map).length) {
      console.log(`[canvas-hourly] skip ${hourKey}: no course-map`);
      await writeLastHourlySync(dir, {
        dateKey,
        hourKey,
        at: new Date().toISOString(),
        status: "skipped",
        reason: "no-course-map",
      });
      return { ok: true, skipped: true, reason: "no-course-map", dateKey, hourKey };
    }

    const fetched = await fetchCanvasSnapshot({
      timeZone: timezone,
      light: true,
      mappedOnly: true,
    });
    if (!fetched.ok) return fetched;
    if (!fetched.courses) {
      await writeLastHourlySync(dir, {
        dateKey,
        hourKey,
        at: new Date().toISOString(),
        status: "skipped",
        reason: "no-mapped-courses",
      });
      return { ok: true, skipped: true, reason: "no-mapped-courses", dateKey, hourKey };
    }

    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, CANVAS_HOURLY_MODEL_SPEC);
    console.log(
      `[canvas-hourly] agent ${hourKey} tz=${timezone} model=${model.id} assignments=${fetched.assignments}`
    );

    const deletedBlock = formatDeletedBlock(
      await loadDeletedMarkdown(join(ROOT, "education", YAN_EMAIL))
    );
    const prompt = buildCanvasHourlyPrompt({
      dateKey,
      hourKey,
      timezone,
      deletedBlock,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "canvas-hourly",
        prompt,
        model,
        cwd: ROOT,
      });

    if (usedFallback) {
      console.warn("[canvas-hourly] used auto after composer retries");
    }
    if (transientFailed) {
      hourlyLaterAuthRetry.schedule(hourKey);
      return {
        ok: false,
        dateKey,
        hourKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
        courses: fetched.courses,
        assignments: fetched.assignments,
      };
    }

    hourlyLaterAuthRetry.clear();
    const files = await pullCanvasAssignmentFiles(fetched.snapshot);
    await writeLastHourlySync(dir, {
      dateKey,
      hourKey,
      at: new Date().toISOString(),
      status: result?.status || "finished",
      model: model.id,
      assignments: fetched.assignments,
    });
    await gitAddCommitPush({
      paths: [`education/${YAN_EMAIL}`],
      message: `education: ${hourKey} canvas hourly`,
    });
    return {
      ok: true,
      dateKey,
      hourKey,
      status: result?.status || "finished",
      courses: fetched.courses,
      assignments: fetched.assignments,
      files,
    };
  } finally {
    await releaseLock(handle);
  }
}

async function pullCanvasAssignmentFiles(snapshot) {
  try {
    const { pullCanvasAssignmentFiles: pull } = await import("./canvas-files.js");
    const result = await pull({ snapshot });
    if (result?.downloaded || result?.skipped) {
      console.log(
        `[canvas-sync] assignment files downloaded=${result.downloaded || 0} skipped=${result.skipped || 0}`
      );
    }
    return result;
  } catch (err) {
    console.error("[canvas-sync] assignment files", err);
    return { ok: false, reason: err instanceof Error ? err.message : "pull failed" };
  }
}

async function maybeRunMissed() {
  try {
    const { configured } = canvasConfig();
    if (!configured) return;
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(canvasSyncHm(meta))) return;
    const last = await readLastAgentSync(canvasDir());
    if (last?.dateKey === now.dateKey) return;
    console.log(`[canvas-sync] missed-job recovery for ${now.dateKey}`);
    await runCanvasSync({ force: true });
  } catch (err) {
    console.error("[canvas-sync] missed-job recovery failed", err);
  }
}

function armTimer(meta, result = null) {
  if (timer) clearTimeout(timer);
  const when = nextCanvasSyncRetryAt(result, meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  const label = result?.reason === "in-flight" ? "retry" : "next agent";
  console.log(
    `[canvas-sync] ${label} ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runCanvasSync({ force: true })
      .then((next) => {
        readMeta()
          .then((m) => armTimer(m, next))
          .catch((err) => {
            console.error("[canvas-sync] reschedule failed", err);
            timer = setTimeout(() => startCanvasSyncScheduler(), 60 * 60 * 1000);
          });
      })
      .catch((err) => {
        console.error("[canvas-sync] scheduled run failed", err);
        readMeta()
          .then((m) => armTimer(m))
          .catch((armErr) => {
            console.error("[canvas-sync] reschedule failed", armErr);
            timer = setTimeout(() => startCanvasSyncScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

function armHourlyTimer(meta, result = null) {
  if (hourlyTimer) clearTimeout(hourlyTimer);
  const when =
    result?.reason === "in-flight"
      ? new Date(Date.now() + CANVAS_LOCK_RETRY_MS)
      : nextCanvasHourlyAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 3 * 60 * 60 * 1000);
  const label = result?.reason === "in-flight" ? "retry" : "next agent";
  console.log(
    `[canvas-hourly] ${label} ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  hourlyTimer = setTimeout(() => {
    runCanvasHourlySync({ force: false })
      .then((next) => {
        readMeta()
          .then((m) => armHourlyTimer(m, next))
          .catch((err) => {
            console.error("[canvas-hourly] reschedule failed", err);
            hourlyTimer = setTimeout(() => startCanvasHourlyScheduler(), 60 * 60 * 1000);
          });
      })
      .catch((err) => {
        console.error("[canvas-hourly] scheduled run failed", err);
        readMeta()
          .then((m) => armHourlyTimer(m))
          .catch((armErr) => {
            console.error("[canvas-hourly] reschedule failed", armErr);
            hourlyTimer = setTimeout(() => startCanvasHourlyScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

export function startCanvasHourlyScheduler() {
  const { configured } = canvasConfig();
  if (!configured) return;
  readMeta()
    .then((meta) => {
      armHourlyTimer(meta);
    })
    .catch((err) => {
      console.error("[canvas-hourly] scheduler start failed", err);
    });
}

export function startCanvasSyncScheduler() {
  const { configured } = canvasConfig();
  if (!configured) {
    console.log("[canvas-sync] skipped (no CANVAS_ACCESS_TOKEN)");
    return;
  }
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[canvas-sync] missed recovery", err)
        );
      }, 8000);
    })
    .catch((err) => {
      console.error("[canvas-sync] scheduler start failed", err);
    });
  startCanvasHourlyScheduler();
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
  const fetchOnly = process.argv.includes("--fetch-only");
  const hourly = process.argv.includes("--hourly");
  const pullFiles = process.argv.includes("--pull-files");
  const run = pullFiles
    ? import("./canvas-files.js").then((m) => m.pullCanvasAssignmentFiles())
    : hourly
      ? runCanvasHourlySync({ force: true })
      : runCanvasSync({ force, fetchOnly });
  run
    .then((result) => {
      const tag = pullFiles
        ? "[canvas-files]"
        : hourly
          ? "[canvas-hourly]"
          : "[canvas-sync]";
      console.log(tag, result && { ...result, snapshot: undefined });
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
      process.exit(process.exitCode || 0);
    })
    .catch((err) => {
      console.error(
        pullFiles
          ? "[canvas-files] failed"
          : hourly
            ? "[canvas-hourly] failed"
            : "[canvas-sync] failed",
        err
      );
      process.exit(1);
    });
}
