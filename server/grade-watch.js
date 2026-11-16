/**
 * Grade watch. One Canvas assignment, texts chosen when the watch is
 * created, a poller that sends those texts when a grade is posted.
 * Who may start one lives in .cursor/skills/grade-watch/SKILL.md.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatAssignmentWork, trimScore } from "./canvas-grades.js";
import { GRADE_WATCHES_DIR } from "./onedrive-projects.js";
import { applyAgentSentFooter } from "./imessage-mention.js";

export const GRADE_WATCH_INTERVAL_MS = 10_000;
export const GRADE_WATCH_BACKOFF_MS = 60_000;
const LOCK_STALE_MS = 120_000;
const TEXT_MAX = 4_000;
const MESSAGE_MAX = 10;
const CANVAS_BASE = "https://canvas.instructure.com";
const TOKEN_RE = /\{(score|points|percent|grade|assignment|course)\}/g;

/** @type {ReturnType<typeof setTimeout> | null} */
let timer = null;
let ticking = false;
let schedulerStarted = false;

function finite(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function norm(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/[^a-z0-9%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeId(id) {
  const s = String(id || "").trim();
  return /^[0-9a-f-]{36}$/i.test(s) ? s : "";
}

export function gradeWatchesDir(root) {
  const explicit = String(root || "").trim();
  if (explicit) return explicit;
  return GRADE_WATCHES_DIR;
}

/**
 * Student-visible grade. `score` and `grade` only. `entered_score` is the
 * teacher field and can exist before the student can see it.
 * `workflow_state: "graded"` with an empty score does not count.
 * @param {object|null|undefined} sub
 */
export function submissionIsPosted(sub) {
  if (!sub || typeof sub !== "object") return false;
  if (sub.excused === true) return true;
  if (finite(sub.score) != null) return true;
  return Boolean(String(sub.grade || "").trim());
}

/**
 * @param {object} record
 * @param {object|null|undefined} sub
 */
export function gradeWatchContext(record, sub) {
  const score = finite(sub?.score);
  const points = finite(record?.pointsPossible);
  const excused = sub?.excused === true;
  const gradeStr = String(sub?.grade || "").trim();
  let percent = "";
  if (/%$/.test(gradeStr)) percent = gradeStr;
  else if (score != null && points != null && points > 0) {
    percent = `${trimScore((score / points) * 100)}%`;
  }
  const work = formatAssignmentWork({
    pointsPossible: points,
    score,
    grade: gradeStr,
    percent: percent.endsWith("%") ? Number(percent.slice(0, -1)) : null,
    workflowState: excused || score != null || gradeStr ? "graded" : "",
    excused,
  });
  return {
    score: score != null ? trimScore(score) : excused ? "excused" : "",
    points: points != null ? trimScore(points) : "",
    percent,
    grade: work.graded ? work.display : "",
    assignment: String(record?.title || ""),
    course: String(record?.course || ""),
  };
}

/**
 * @param {string} text
 * @param {object} ctx
 */
export function fillGradeWatchText(text, ctx) {
  const src = ctx && typeof ctx === "object" ? ctx : {};
  return String(text || "").replace(TOKEN_RE, (whole, key) => {
    const value = src[key];
    if (value == null || value === "") return whole;
    return String(value);
  });
}

/**
 * Newest createdAt first. The dashboard paints that order on the left.
 * @param {object[]} rows
 */
export function sortGradeWatchesNewestFirst(rows) {
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => {
    const dt = Date.parse(b?.createdAt) - Date.parse(a?.createdAt);
    if (dt) return dt;
    return String(b?.id || "").localeCompare(String(a?.id || ""));
  });
}

function courseMatchesHint(row, courseMap, hint) {
  const n = norm(hint);
  if (!n) return true;
  const classId = norm(courseMap?.[String(row.courseId)] || "");
  const course = norm(row.course);
  return (
    course.includes(n) ||
    classId.includes(n) ||
    String(row.courseId) === String(hint).trim()
  );
}

function mappedIdSet(courseMap) {
  const ids = new Set();
  if (!courseMap || typeof courseMap !== "object") return ids;
  for (const key of Object.keys(courseMap)) {
    const n = Number(key);
    if (Number.isFinite(n)) ids.add(n);
  }
  return ids;
}

/**
 * @param {object[]} assignments
 * @param {Record<string, string>} courseMap
 * @param {string} query
 * @param {string} [courseHint]
 */
export function matchMappedAssignment(assignments, courseMap, query, courseHint) {
  const q = String(query || "").trim();
  if (!q) return { error: "assignment required" };
  const mapped = mappedIdSet(courseMap);
  const rows = (Array.isArray(assignments) ? assignments : []).filter((row) =>
    mapped.has(Number(row?.courseId))
  );
  const hint = String(courseHint || "").trim();
  const pool = hint ? rows.filter((row) => courseMatchesHint(row, courseMap, hint)) : rows;
  if (hint && !pool.length) return { error: "no class matches that course" };

  const url = q.match(/\/courses\/(\d+)\/assignments\/(\d+)/);
  if (url) {
    const courseId = Number(url[1]);
    const assignmentId = Number(url[2]);
    if (!mapped.has(courseId)) {
      return { error: "that class is not one of Yan's Canvas courses" };
    }
    const hit = rows.find(
      (row) => Number(row?.id) === assignmentId && Number(row?.courseId) === courseId
    );
    if (!hit) return { error: "assignment not found" };
    if (hint && !courseMatchesHint(hit, courseMap, hint)) {
      return { error: "that assignment is not in that course" };
    }
    return { match: hit };
  }

  if (/^\d+$/.test(q)) {
    const id = Number(q);
    const hits = pool.filter((row) => Number(row?.id) === id);
    if (hits.length === 1) return { match: hits[0] };
    if (hits.length > 1) return { ambiguous: hits };
    return { error: "assignment not found" };
  }

  const nq = norm(q);
  const exact = pool.filter((row) => norm(row?.title) === nq);
  const hits = exact.length
    ? exact
    : nq.length >= 2
      ? pool.filter((row) => norm(row?.title).includes(nq))
      : [];
  if (hits.length === 1) return { match: hits[0] };
  if (hits.length > 1) return { ambiguous: hits };
  return { error: "assignment not found" };
}

function assignmentHref(row) {
  const url = String(row?.htmlUrl || "").trim();
  if (/^https?:\/\//i.test(url)) return url;
  return `${CANVAS_BASE}/courses/${row.courseId}/assignments/${row.id}`;
}

function matchSummary(row) {
  return {
    id: row?.id ?? null,
    courseId: row?.courseId ?? null,
    title: String(row?.title || ""),
    course: String(row?.course || ""),
  };
}

export function publicGradeWatchEntry(record) {
  return {
    id: record.id,
    title: String(record.title || ""),
    course: String(record.course || ""),
    createdAt: record.createdAt,
    href: String(record.href || ""),
    status: record.status,
  };
}

function recordPath(id, root) {
  return join(gradeWatchesDir(root), `${id}.json`);
}

function lockPath(id, root) {
  return join(gradeWatchesDir(root), `${id}.lock`);
}

async function readRecord(id, root) {
  const safe = safeId(id);
  if (!safe) return null;
  try {
    const raw = JSON.parse(await readFile(recordPath(safe, root), "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

async function writeRecord(record, root) {
  const id = safeId(record?.id);
  if (!id) throw new Error("grade watch id missing");
  const dir = gradeWatchesDir(root);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = recordPath(id, root);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

export async function listGradeWatchRecords(root) {
  const dir = gradeWatchesDir(root);
  let names = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name.endsWith(".tmp")) continue;
    const id = safeId(name.slice(0, -".json".length));
    if (!id) continue;
    const row = await readRecord(id, root);
    if (row) rows.push(row);
  }
  return rows;
}

export async function listPublicGradeWatches(opts = {}) {
  const rows = await listGradeWatchRecords(opts.root);
  return sortGradeWatchesNewestFirst(rows.filter((row) => row.status === "watching")).map(
    publicGradeWatchEntry
  );
}

async function acquireLock(id, root) {
  const path = lockPath(id, root);
  await mkdir(gradeWatchesDir(root), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
  }
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return false;
    await rm(path, { force: true });
    await writeFile(path, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(id, root) {
  await rm(lockPath(id, root), { force: true });
}

async function defaultAssignments() {
  const { getLiveCanvasSnapshot } = await import("./canvas-sync.js");
  const snap = await getLiveCanvasSnapshot();
  return Array.isArray(snap?.assignments) ? snap.assignments : [];
}

async function defaultCourseMap() {
  const { canvasDir } = await import("./canvas-sync.js");
  try {
    const raw = JSON.parse(await readFile(join(canvasDir(), "course-map.json"), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return raw;
  } catch {
    return {};
  }
}

async function defaultFetchSubmission(record) {
  const { canvasConfig, canvasFetch } = await import("./canvas-sync.js");
  const { base, token, configured } = canvasConfig();
  if (!configured) {
    const err = new Error("canvas is not configured");
    err.status = 503;
    throw err;
  }
  const { data } = await canvasFetch(
    base,
    token,
    `/api/v1/courses/${record.courseId}/assignments/${record.assignmentId}/submissions/self`
  );
  return data;
}

async function defaultResolveImessage(opts) {
  const { resolveIMessageTarget } = await import("./imessage-send.js");
  const to = String(opts.to || "").trim();
  const chatGuid = String(opts.chatGuid || "").trim();
  const resolved = await resolveIMessageTarget({ to, chatGuid });
  if (!resolved.chatGuid) {
    const err = new Error(`no Messages chat for ${to || chatGuid}`);
    err.status = 400;
    throw err;
  }
  return resolved;
}

async function defaultResolveTeams(opts) {
  const { resolveTeamsChat } = await import("./school-teams.js");
  const result = await resolveTeamsChat({ chat: opts.chat });
  if (!result.ok) {
    const extra = result.chats?.length ? `: ${result.chats.join(", ")}` : "";
    const err = new Error(`${result.error}${extra}`);
    err.status = 400;
    throw err;
  }
  return result;
}

async function defaultSendImessage(opts) {
  const { sendIMessage } = await import("./imessage-send.js");
  return sendIMessage(opts);
}

async function defaultSendTeams(opts) {
  const { sendTeamsMessage } = await import("./school-teams.js");
  return sendTeamsMessage(opts);
}

/**
 * @param {unknown} raw
 * @param {object} deps
 */
async function resolveMessages(raw, deps) {
  if (!Array.isArray(raw) || !raw.length) {
    return { error: "at least one message" };
  }
  if (raw.length > MESSAGE_MAX) return { error: "too many messages" };
  const resolveImessage = deps.resolveImessage || defaultResolveImessage;
  const resolveTeams = deps.resolveTeams || defaultResolveTeams;
  /** @type {object[]} */
  const messages = [];
  for (const item of raw) {
    const channel = String(item?.channel || "").trim().toLowerCase();
    const text = String(item?.text || "").trim();
    if (!text) return { error: "message text required" };
    if (text.length > TEXT_MAX) return { error: "message is too long" };
    if (channel === "imessage") {
      const to = String(item?.to || item?.chat || "").trim();
      const chatGuid = String(item?.chatGuid || "").trim();
      if (!to) return { error: "imessage needs a chat" };
      try {
        const resolved = await resolveImessage({ to, chatGuid });
        const resolvedGuid = String(resolved?.chatGuid || "").trim();
        if (!resolvedGuid) return { error: `no Messages chat for ${to}` };
        messages.push({
          channel,
          to: String(resolved?.to || to),
          chatGuid: resolvedGuid,
          text,
          sentAt: null,
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    } else if (channel === "teams") {
      const chat = String(item?.chat || item?.to || "").trim();
      if (!chat) return { error: "teams needs a chat" };
      try {
        const resolved = await resolveTeams({ chat });
        const chatId = String(resolved?.chatId || "").trim();
        if (!chatId) return { error: "teams chat not found" };
        messages.push({
          channel,
          chatId,
          chatName: String(resolved?.chatName || chat),
          text,
          sentAt: null,
        });
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    } else {
      return { error: "channel must be imessage or teams" };
    }
  }
  return { messages };
}

function priorForAssignment(records, courseId, assignmentId) {
  const hits = records.filter(
    (row) =>
      Number(row?.courseId) === Number(courseId) &&
      Number(row?.assignmentId) === Number(assignmentId) &&
      (row.status === "watching" || row.status === "sent")
  );
  return sortGradeWatchesNewestFirst(hits)[0] || null;
}

/**
 * @param {string} id
 * @param {object} submission
 * @param {object} [deps]
 */
export async function deliverGradeWatch(id, submission, deps = {}) {
  const root = deps.root;
  const safe = safeId(id);
  if (!safe) return { ok: false, error: "not found" };
  const locked = await acquireLock(safe, root);
  if (!locked) return { ok: false, error: "busy", id: safe };
  try {
    const rec = await readRecord(safe, root);
    if (!rec) return { ok: false, error: "not found", id: safe };
    if (rec.status === "sent") {
      return { ok: true, alreadySent: true, id: safe, grade: rec.posted?.grade || "" };
    }
    if (rec.status !== "watching") return { ok: false, error: rec.status, id: safe };
    if (!submissionIsPosted(submission)) return { ok: false, error: "not posted", id: safe };
    const ctx = gradeWatchContext(rec, submission);
    const sendImessage = deps.sendImessage || defaultSendImessage;
    const sendTeams = deps.sendTeams || defaultSendTeams;
    let failed = "";
    for (const msg of rec.messages || []) {
      if (msg.sentAt) continue;
      const body = fillGradeWatchText(msg.text, ctx);
      try {
        if (msg.channel === "imessage") {
          const text = applyAgentSentFooter(body, {
            chat: msg.to,
            handle: msg.to,
            platform: "imessage",
          });
          await sendImessage({ to: msg.to, chatGuid: msg.chatGuid, text });
        } else {
          const result = await sendTeams({ chat: msg.chatId, text: body });
          if (result && result.ok === false) {
            throw new Error(result.error || "teams send failed");
          }
        }
        msg.sentAt = new Date().toISOString();
        delete msg.error;
      } catch (err) {
        msg.error = err instanceof Error ? err.message : String(err);
        failed = msg.error;
      }
      await writeRecord(rec, root);
      if (failed) break;
    }
    const pending = (rec.messages || []).some((msg) => !msg.sentAt);
    if (!pending) {
      rec.status = "sent";
      rec.sentAt = new Date().toISOString();
      rec.posted = { score: ctx.score, grade: ctx.grade, percent: ctx.percent };
      await writeRecord(rec, root);
    }
    return {
      ok: !pending,
      id: safe,
      grade: ctx.grade,
      pending,
      error: failed,
    };
  } finally {
    await releaseLock(safe, root);
  }
}

/**
 * @param {{
 *   assignment?: string,
 *   course?: string,
 *   messages?: unknown,
 *   requestedBy?: string,
 * }} input
 * @param {object} [deps]
 */
export async function createGradeWatch(input, deps = {}) {
  const root = deps.root;
  const assignments = deps.assignments || (await defaultAssignments());
  const courseMap = deps.courseMap || (await defaultCourseMap());
  const found = matchMappedAssignment(
    assignments,
    courseMap,
    input?.assignment,
    input?.course
  );
  if (found.error) return { ok: false, error: found.error };
  if (found.ambiguous) {
    return {
      ok: false,
      error: "more than one assignment matches",
      matches: found.ambiguous.slice(0, 8).map(matchSummary),
    };
  }
  const hit = found.match;
  const records = await listGradeWatchRecords(root);
  const prior = priorForAssignment(records, hit.courseId, hit.id);
  if (prior) {
    return {
      ok: true,
      existing: true,
      alreadySent: prior.status === "sent",
      id: prior.id,
      title: prior.title,
      course: prior.course,
      status: prior.status,
      grade: prior.posted?.grade || "",
    };
  }
  const resolved = await resolveMessages(input?.messages, deps);
  if (resolved.error) return { ok: false, error: resolved.error };
  const createdAt = deps.now ? new Date(deps.now).toISOString() : new Date().toISOString();
  const record = {
    id: randomUUID(),
    status: "watching",
    courseId: Number(hit.courseId),
    assignmentId: Number(hit.id),
    title: String(hit.title || ""),
    course: String(hit.course || ""),
    classId: String(courseMap[String(hit.courseId)] || ""),
    href: assignmentHref(hit),
    pointsPossible: finite(hit.pointsPossible ?? hit.points),
    messages: resolved.messages,
    createdAt,
    sentAt: null,
    requestedBy: String(input?.requestedBy || "").trim().slice(0, 120),
  };
  await writeRecord(record, root);
  let posted = null;
  try {
    const fetchSubmission = deps.fetchSubmission || defaultFetchSubmission;
    posted = await fetchSubmission(record);
  } catch (err) {
    return {
      ok: true,
      id: record.id,
      watching: true,
      title: record.title,
      course: record.course,
      checkError: err instanceof Error ? err.message : String(err),
    };
  }
  if (!submissionIsPosted(posted)) {
    return {
      ok: true,
      id: record.id,
      watching: true,
      title: record.title,
      course: record.course,
    };
  }
  const sent = await deliverGradeWatch(record.id, posted, deps);
  return {
    ok: true,
    id: record.id,
    sent: Boolean(sent.ok),
    watching: !sent.ok,
    title: record.title,
    course: record.course,
    grade: sent.grade || "",
    error: sent.error || "",
  };
}

/**
 * @param {{ id?: string, assignment?: string, course?: string }} input
 * @param {object} [deps]
 */
export async function cancelGradeWatch(input, deps = {}) {
  const root = deps.root;
  const id = safeId(input?.id);
  if (id) {
    const rec = await readRecord(id, root);
    if (!rec) return { ok: false, error: "not found" };
    if (rec.status !== "watching") return { ok: false, error: rec.status, id };
    rec.status = "canceled";
    rec.canceledAt = new Date().toISOString();
    await writeRecord(rec, root);
    return { ok: true, id, status: "canceled", title: rec.title };
  }
  const assignment = String(input?.assignment || "").trim();
  if (!assignment) return { ok: false, error: "id required" };
  const watching = (await listGradeWatchRecords(root)).filter((row) => row.status === "watching");
  const found = matchMappedAssignment(watching, courseMapFromWatches(watching), assignment, input?.course);
  if (found.error) return { ok: false, error: found.error };
  if (found.ambiguous) {
    return {
      ok: false,
      error: "more than one grade watch matches",
      matches: found.ambiguous.slice(0, 8).map((row) => ({
        id: row.id,
        title: row.title,
        course: row.course,
      })),
    };
  }
  return cancelGradeWatch({ id: found.match.id }, deps);
}

function courseMapFromWatches(rows) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const row of rows) {
    if (row?.courseId != null) map[String(row.courseId)] = String(row.classId || row.course || "class");
  }
  return map;
}

/**
 * One pass. Returns the delay before the next pass.
 * @param {object} [deps]
 */
export async function pollGradeWatchesOnce(deps = {}) {
  const root = deps.root;
  const active = (await listGradeWatchRecords(root)).filter((row) => row.status === "watching");
  if (!active.length) return GRADE_WATCH_INTERVAL_MS;
  const fetchSubmission = deps.fetchSubmission || defaultFetchSubmission;
  let backoff = false;
  for (const row of active) {
    try {
      const sub = await fetchSubmission(row);
      if (!submissionIsPosted(sub)) continue;
      await deliverGradeWatch(row.id, sub, deps);
    } catch (err) {
      if (Number(err?.status) === 429) backoff = true;
      console.error(
        "[grade-watch]",
        row.id,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return backoff ? GRADE_WATCH_BACKOFF_MS : GRADE_WATCH_INTERVAL_MS;
}

export function startGradeWatchScheduler() {
  if (schedulerStarted) return;
  schedulerStarted = true;
  const arm = (delay) => {
    timer = setTimeout(async () => {
      timer = null;
      if (ticking) {
        arm(GRADE_WATCH_INTERVAL_MS);
        return;
      }
      ticking = true;
      let next = GRADE_WATCH_INTERVAL_MS;
      try {
        next = await pollGradeWatchesOnce();
      } catch (err) {
        console.error("[grade-watch]", err instanceof Error ? err.message : String(err));
      } finally {
        ticking = false;
      }
      arm(next);
    }, delay);
    timer.unref?.();
  };
  arm(1000);
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return "";
  return String(process.argv[i + 1] || "");
}

async function cliMain() {
  const cmd = String(process.argv[2] || "").trim();
  if (cmd === "list") {
    const rows = await listPublicGradeWatches();
    process.stdout.write(`${JSON.stringify({ ok: true, gradeWatches: rows }, null, 2)}\n`);
    return;
  }
  if (cmd === "cancel") {
    const result = await cancelGradeWatch({
      id: argValue("--id"),
      assignment: argValue("--assignment"),
      course: argValue("--course"),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (cmd === "start") {
    const raw = argValue("--messages");
    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      throw new Error("start needs --messages as a JSON array");
    }
    const result = await createGradeWatch({
      assignment: argValue("--assignment"),
      course: argValue("--course"),
      messages,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  throw new Error("usage: grade-watch.js start|list|cancel");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  cliMain().catch((err) => {
    console.error("[grade-watch]", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
