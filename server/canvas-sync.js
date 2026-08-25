/**
 * Canvas LMS fetch + nightly dashboard sync agent (Grok 4.6 high).
 * Token from server/.env (never commit). Writes
 * education/you@example.com/.canvas/ then a local agent maps
 * assignments onto existing education classes. Does not sync done state.
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
import { scheduleTodayKey } from "./education-data.js";
import { gitAddCommitPush } from "./git-publish.js";
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
const LOCK_STALE_MS = 90 * 60 * 1000;
const SKILL_PATH = ".cursor/skills/personal-canvas/SKILL.md";

export const CANVAS_SYNC_MODEL_SPEC = {
  id: process.env.CURSOR_CANVAS_SYNC_MODEL || "grok-4.6",
  params: [
    { id: "effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;
/** @type {Promise<unknown>|null} */
let inFlight = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "canvas-sync",
  run: () => runCanvasSync({ force: true }),
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

function clip(raw, max = 200) {
  return String(raw || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function stripHtml(html, max = 4000) {
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
  const root = join(ROOT, "education", YAN_EMAIL, "classes");
  let ids = [];
  try {
    ids = await readdir(root);
  } catch {
    return [];
  }
  /** @type {string[]} */
  const names = [];
  for (const id of ids) {
    if (!id || id.startsWith(".") || id.startsWith("_example")) continue;
    try {
      const props = JSON.parse(await readFile(join(root, id, "class.json"), "utf8"));
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

async function canvasFetch(base, token, path) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
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

async function canvasGetAll(base, token, path) {
  /** @type {unknown[]} */
  const out = [];
  let url = path;
  for (let i = 0; i < 40; i++) {
    const page = await canvasFetch(base, token, url);
    if (Array.isArray(page.data)) out.push(...page.data);
    else if (page.data) out.push(page.data);
    if (!page.next) break;
    url = page.next;
  }
  return out;
}

function courseGrade(course) {
  const enrollments = Array.isArray(course?.enrollments) ? course.enrollments : [];
  const grades = enrollments[0]?.grades || enrollments[0] || {};
  return clip(
    grades.current_grade ||
      grades.final_grade ||
      (grades.current_score != null ? String(grades.current_score) : ""),
    24
  );
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
  const points = Number(item?.points_possible);
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
    types,
    description: stripHtml(item?.description, 1500),
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

/**
 * Pull dashboard-matching courses, then their assignments, syllabi, and events.
 * Prior-year / extra enrollments are listed by Canvas but not stored. No submission/done.
 * @param {{ dir?: string, timeZone?: string }} [opts]
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

  const coursesRaw = await canvasGetAll(
    base,
    token,
    `/api/v1/courses?enrollment_state=current_and_future&per_page=50&include[]=total_scores&include[]=current_grading_period_scores`
  );
  const visible = coursesRaw.filter((c) => c && !c.access_restricted_by_date);
  const classNames = await listDashboardClassNames();
  const { keep: courses, skip } = selectDashboardCanvasCourses(visible, classNames);
  const courseById = new Map(courses.map((c) => [c.id, c]));

  for (const course of courses) {
    try {
      const { data } = await canvasFetch(
        base,
        token,
        `/api/v1/courses/${course.id}?include[]=syllabus_body`
      );
      if (data && typeof data === "object" && data.syllabus_body) {
        course.syllabus_body = data.syllabus_body;
      }
    } catch (err) {
      console.error(`[canvas-sync] syllabus course ${course.id}`, err);
    }
  }

  /** @type {ReturnType<typeof assignmentRow>[]} */
  const assignments = [];
  for (const course of courses) {
    try {
      const rows = await canvasGetAll(
        base,
        token,
        `/api/v1/courses/${course.id}/assignments?per_page=50&order_by=due_at`
      );
      for (const item of rows) {
        const row = assignmentRow(item, course, timeZone);
        if (row) assignments.push(row);
      }
    } catch (err) {
      console.error(`[canvas-sync] assignments course ${course.id}`, err);
    }
  }

  const year = Number(String(dateKey).slice(0, 4));
  const month = Number(String(dateKey).slice(5, 7));
  const schoolStartYear = month >= 7 ? year : year - 1;
  const startDate = `${schoolStartYear}-08-01`;
  const endDate = `${schoolStartYear + 1}-07-31`;
  /** @type {ReturnType<typeof eventRow>[]} */
  const events = [];
  for (const course of courses) {
    try {
      const rows = await canvasGetAll(
        base,
        token,
        `/api/v1/calendar_events?type=event&context_codes[]=course_${course.id}&start_date=${startDate}&end_date=${endDate}&per_page=50`
      );
      for (const item of rows) {
        const row = eventRow(item, courseById, timeZone);
        if (row) events.push(row);
      }
    } catch (err) {
      console.error(`[canvas-sync] events course ${course.id}`, err);
    }
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    base,
    timezone: timeZone,
    dateKey,
    skippedCourseCount: skip.length,
    courses: courses.map((c) => ({
      id: c.id,
      name: clip(c.name, 120),
      courseCode: clip(c.course_code, 40),
      htmlUrl: `${base}/courses/${c.id}`,
      syllabusUrl: `${base}/courses/${c.id}/assignments/syllabus`,
      grade: courseGrade(c),
      syllabus: stripHtml(c.syllabus_body, 8000),
    })),
    assignments,
    events,
  };

  const dir = canvasDir(opts.dir);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "assignments.md"), formatCanvasAssignmentsMarkdown(snapshot), "utf8");
  return {
    ok: true,
    courses: snapshot.courses.length,
    skippedCourses: skip.length,
    assignments: assignments.length,
    events: events.length,
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

function buildCanvasSyncPrompt({ dateKey, timezone, force }) {
  const rebuild = force
    ? "This is a forced/manual sync. Re-read the snapshot and apply the skill even if last-agent-sync.json is today."
    : "If last-agent-sync.json is already today and the snapshot has not grown new work, still apply any missing todos/dates from the snapshot.";
  return [
    `Follow ${SKILL_PATH}. Sync Canvas into Yan's education dashboard.`,
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Snapshot: ${CANVAS_REL}/snapshot.json (also assignments.md). Optional map: ${CANVAS_REL}/course-map.json.`,
    "Yan is a 2026-27 junior. Those academic dashboard classes are often missing from Canvas until school publishes them. That is expected.",
    "FIRST: map snapshot courses to education/you@example.com/classes/ (skip free-period shells and fixtures). The snapshot already dropped non-dashboard enrollments. If ZERO dashboard classes appear in Canvas, STOP immediately. Do not invent Class of 2028, EPS Library, Iceland EBC, Graphic Design, or prior-year shells. Do not create todos. One short note is enough.",
    "If at least one class maps: create or update todos for every Canvas assignment on those mapped classes only. Set canvasLink and canvasId. Tag CW/HW/QA/MA. Use snapshot dueDate/dueTime.",
    "Pull major syllabus / calendar-event dates onto date.json with canvasLink.",
    "NEVER write done or completedAt from Canvas. New todos start done false. Updates leave those keys untouched.",
    "Do not POST to Canvas. Do not delete education todos just because Canvas dropped a row.",
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
 * Fetch snapshot then (unless fetchOnly) run the Grok 4.6 high sync agent.
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
      return { ok: true, fetchOnly: true, dateKey, ...fetched };
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

    const prompt = buildCanvasSyncPrompt({ dateKey, timezone, force });
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
    };
  } finally {
    if (handle) await releaseLock(handle);
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

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextCanvasSyncAt(meta);
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[canvas-sync] next agent ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runCanvasSync({ force: true })
      .catch((err) => console.error("[canvas-sync] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[canvas-sync] reschedule failed", err);
            timer = setTimeout(() => startCanvasSyncScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
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
  runCanvasSync({ force, fetchOnly })
    .then((result) => {
      console.log("[canvas-sync]", result && { ...result, snapshot: undefined });
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[canvas-sync] failed", err);
      process.exitCode = 1;
    });
}
