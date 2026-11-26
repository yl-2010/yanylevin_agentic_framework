#!/usr/bin/env node
/**
 * Daily AP study packets. One 30 minute packet per day across five AP exams,
 * written by a model from the learner model, printed to PDF pages, and put in
 * the "AP Study 2026-27" OneNote notebook. Yan writes on the pages with a
 * stylus. The next run reads his ink, grades it, updates the model, and writes
 * reposts that page with red marks beside each answer.
 *
 * node server/ap-study.js seed | calendar | syllabi | plan | write | render |
 *   publish | grade | mark | run | pace | status | ink-check   [--date YYYY-MM-DD] [--force]
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile, copyFile, open } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AP_STUDY_DIR, PERSONAL_PROJECTS, SCHOOL_PROJECTS } from "./onedrive-projects.js";
import {
  EXAM_IDS,
  DIAGNOSTIC_DAYS,
  addDays,
  applyGrade,
  applyPriors,
  buildCalendar,
  dayDiff,
  loadCalendarSpec,
  loadCurricula,
  markKnown,
  newModel,
  paceCheck,
  planDay,
  topicIndex,
  weekday,
  aprilPriorityList,
} from "./ap-study-model.js";
import { normalizePacket, renderPacket, renderInk, esc } from "./ap-study-render.js";
import {
  harvestInk,
  publishPrintoutPage,
  resolvePageId,
  deletePublishedPage,
  AP_NOTEBOOK_NAME,
  monthSectionName,
} from "./ap-study-onenote.js";
import { layoutMarks } from "./ap-study-marks.js";
import {
  buildAlignPrompt,
  buildGradePrompt,
  buildRevisePrompt,
  buildWritePrompt,
  checkPacketAgainstPlan,
  lintPacket,
  normalizeAlign,
  normalizeGrade,
  runJsonAgent,
} from "./ap-study-agents.js";

const REPO_CURRICULUM = join(dirname(fileURLToPath(import.meta.url)), "ap-curriculum");
const SCHOOL_ROOT = join(SCHOOL_PROJECTS, "..");

export const DEFAULT_AP_STUDY_HM = "04:00";

/** School class folder, its class notebook, and the AP exams it feeds. */
export const SCHOOL_CLASSES = [
  { folder: /^[A-Z]\. Advanced Calc/i, notebook: "Advanced Calculus 26-27", exams: ["calc-bc"], name: "Advanced Calculus" },
  { folder: /^[A-Z]\. US History/i, notebook: "US History 26-27", exams: ["us-history"], name: "US History" },
  { folder: /^[A-Z]\. American Lit/i, notebook: "Am. Lit", exams: ["lit"], name: "American Literature" },
  { folder: /^[A-Z]\. Physics/i, notebook: "Physics 26-27", exams: ["physics-c-mech", "physics-2"], name: "Physics" },
];

/** @param {string} [root] */
export function apPaths(root = process.env.AP_STUDY_DIR || AP_STUDY_DIR) {
  return {
    root,
    curriculum: join(root, "curriculum"),
    calendar: join(root, "calendar.json"),
    model: join(root, "learner", "model.json"),
    priors: join(root, "learner", "priors.json"),
    insights: join(root, "learner", "insights"),
    prefs: join(root, "preferences.md"),
    overrides: join(root, "overrides.json"),
    pace: join(root, "pace.json"),
    status: join(root, "status.json"),
    syllabi: join(root, "syllabi"),
    days: join(root, "days"),
    lock: join(root, ".run.lock"),
  };
}

// ---------------------------------------------------------------- io

/** @param {string} path @param {any} [fallback] */
async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** @param {string} path @param {any} data */
async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

/** @param {string} path */
async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** @param {string} path */
async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

/** @param {ReturnType<typeof apPaths>} P */
async function acquireLock(P) {
  await mkdir(P.root, { recursive: true });
  try {
    const handle = await open(P.lock, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch {
    const pid = Number(await readText(P.lock));
    let alive = false;
    if (pid) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) return null;
    await rm(P.lock, { force: true });
    const handle = await open(P.lock, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  }
}

/** @param {ReturnType<typeof apPaths>} P @param {import("node:fs/promises").FileHandle|null} handle */
async function releaseLock(P, handle) {
  if (!handle) return;
  await handle.close().catch(() => {});
  await rm(P.lock, { force: true });
}

/** @param {string} [tz] */
export function todayKey(tz = "America/Los_Angeles", now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** "Tue Nov 24" */
export function shortDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).replace(",", "");
}

// ---------------------------------------------------------------- state

/** @param {ReturnType<typeof apPaths>} P */
export async function loadState(P = apPaths()) {
  const dir = existsSync(join(P.curriculum, "calc-bc.json")) ? P.curriculum : REPO_CURRICULUM;
  const curricula = loadCurricula(dir);
  const spec = loadCalendarSpec(dir);
  let calendar = await readJson(P.calendar);
  if (!calendar) calendar = buildCalendar(curricula, spec);
  const model = (await readJson(P.model)) || newModel();
  const overrides = (await readJson(P.overrides)) || {};
  return { P, curricula, spec, calendar, model, overrides, index: topicIndex(curricula) };
}

/** Default starting guesses from grades and classes so far. Yan-only data lives in the data dir. */
export const DEFAULT_PRIORS_NOTE =
  "Starting mastery guesses. Diagnostics (Nov 24 to 28) and self ratings replace these. Edit freely.";

/** @param {{ force?: boolean }} [opts] */
export async function seed(opts = {}) {
  const P = apPaths();
  await mkdir(P.curriculum, { recursive: true });
  for (const name of await readdir(REPO_CURRICULUM)) {
    if (!name.endsWith(".json")) continue;
    const dest = join(P.curriculum, name);
    if (opts.force || !existsSync(dest)) await copyFile(join(REPO_CURRICULUM, name), dest);
  }
  const curricula = loadCurricula(P.curriculum);
  const spec = loadCalendarSpec(P.curriculum);
  const calendar = buildCalendar(curricula, spec);
  if (opts.force || !existsSync(P.calendar)) await writeJson(P.calendar, calendar);
  await mkdir(P.insights, { recursive: true });
  for (const exam of EXAM_IDS) {
    const path = join(P.insights, `${exam}.md`);
    if (!existsSync(path)) {
      await writeFile(path, `# ${curricula[exam].name}: how Yan learns it\n\nThe grader adds dated notes below. Edit or prune freely.\n`);
    }
  }
  if (!existsSync(P.prefs)) {
    await writeFile(
      P.prefs,
      `# AP study preferences\n\nThe packet writer reads this every day. Add notes like "more FRQs", "shorter learn cards", or "no poetry this week".\n`
    );
  }
  if (!existsSync(P.overrides)) {
    await writeJson(P.overrides, { paused: false, skipDates: [], skipDiagnostics: false });
  }
  let model = await readJson(P.model);
  const priors = await readJson(P.priors);
  if (!model || opts.force) {
    model = newModel();
    if (priors?.priors?.length) applyPriors(model, curricula, priors.priors);
    await writeJson(P.model, model);
  }
  return {
    ok: true,
    dir: P.root,
    calendarErrors: calendar.errors,
    topics: Object.keys(calendar.topics).length,
    priors: priors?.priors?.length || 0,
    modelTopics: Object.keys(model.topics).length,
  };
}

/** Rebuild calendar.json from the spec. The model is untouched. */
export async function rebuildCalendar() {
  const P = apPaths();
  const { curricula, spec } = await loadState(P);
  const calendar = buildCalendar(curricula, spec);
  await writeJson(P.calendar, calendar);
  return { ok: true, weeks: calendar.weeks.length, topics: Object.keys(calendar.topics).length, errors: calendar.errors };
}

// ---------------------------------------------------------------- school context

async function gradeDir() {
  try {
    const rows = (await readdir(SCHOOL_ROOT)).filter((n) => /^\d+th Grade$/.test(n)).sort((a, b) => parseInt(b) - parseInt(a));
    return rows[0] ? join(SCHOOL_ROOT, rows[0]) : "";
  } catch {
    return "";
  }
}

/**
 * Class todos due from 10 days back to 10 days ahead.
 * @param {string} date
 */
export async function schoolTodos(date) {
  const root = await gradeDir();
  /** @type {Record<string, { name: string, exams: string[], todos: any[] }>} */
  const out = {};
  if (!root) return out;
  const folders = await readdir(root).catch(() => []);
  for (const cls of SCHOOL_CLASSES) {
    const folder = folders.find((f) => cls.folder.test(f));
    if (!folder) continue;
    const todos = [];
    for (const name of await readdir(join(root, folder)).catch(() => [])) {
      if (!name.startsWith(".")) continue;
      const todo = await readJson(join(root, folder, name, ".todo.json"));
      if (!todo?.dueDate) continue;
      const diff = dayDiff(date, todo.dueDate);
      if (diff < -10 || diff > 10) continue;
      todos.push({
        due: todo.dueDate,
        tag: todo.tag || "",
        name: todo.name || name,
        done: Boolean(todo.done),
        description: String(todo.description || "").replace(/\(\[Web view\]\([^)]*\)\)/g, "").replace(/https?:\/\/\S+/g, "").slice(0, 400),
      });
    }
    todos.sort((a, b) => a.due.localeCompare(b.due));
    out[cls.name] = { name: cls.name, exams: cls.exams, todos };
  }
  return out;
}

/** @param {{ tag?: string, name?: string }} todo */
export function looksLikeTest(todo) {
  const tag = String(todo.tag || "").toUpperCase();
  if (tag === "HW" || tag === "CW") return false;
  if (/\b(test|exam|midterm|quiz)\b/i.test(String(todo.name || ""))) return true;
  return tag === "TE" || tag === "QA";
}

/**
 * Capture class syllabi and unit outlines from the class notebooks.
 * @param {{ force?: boolean }} [opts]
 */
export async function captureSyllabi(opts = {}) {
  const P = apPaths();
  await mkdir(P.syllabi, { recursive: true });
  const { onenoteToken, readClassNotebookOutline } = await import("./school-onenote.js");
  const token = await onenoteToken();
  const done = [];
  const failed = [];
  for (const cls of SCHOOL_CLASSES) {
    const path = join(P.syllabi, `${cls.exams[0]}.md`);
    if (!opts.force && Date.now() - (await mtimeMs(path)) < 25 * 86400000) continue;
    try {
      const outline = await readClassNotebookOutline(token, cls.notebook);
      const lines = [`# ${cls.name} (${outline.notebook})`, "", `Captured ${new Date().toISOString().slice(0, 10)} from the class notebook. Feeds: ${cls.exams.join(", ")}.`, ""];
      lines.push("## Sections and pages", "");
      for (const s of outline.sections) {
        lines.push(`### ${s.name}`);
        for (const p of s.pages.slice(0, 60)) lines.push(`- ${p.title}${p.modified ? ` (${p.modified.slice(0, 10)})` : ""}`);
        lines.push("");
      }
      if (outline.docs.length) {
        lines.push("## Course documents", "");
        for (const d of outline.docs) lines.push(`### ${d.section} / ${d.title}`, "", d.text.trim(), "");
      }
      await writeFile(path, `${lines.join("\n")}\n`);
      done.push(cls.name);
    } catch (err) {
      failed.push({ class: cls.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { ok: failed.length === 0, done, failed };
}

/**
 * @param {ReturnType<typeof apPaths>} P
 * @param {string} date
 */
async function writeSchoolContext(P, date, dayDir) {
  const todos = await schoolTodos(date);
  const lines = [`# School context for ${date}`, ""];
  for (const cls of Object.values(todos)) {
    lines.push(`## ${cls.name} (AP: ${cls.exams.join(", ")})`, "");
    if (!cls.todos.length) lines.push("No assignments in the window.");
    for (const t of cls.todos) {
      lines.push(`- ${t.due} ${t.tag} ${t.name}${t.done ? " (done)" : ""}${looksLikeTest(t) ? " [assessment]" : ""}`);
      if (t.description) lines.push(`  ${t.description.replace(/\s+/g, " ").trim()}`);
    }
    lines.push("");
  }
  lines.push("# Class syllabi and notebook outlines", "");
  for (const cls of SCHOOL_CLASSES) {
    const text = await readText(join(P.syllabi, `${cls.exams[0]}.md`));
    if (text) lines.push(text.slice(0, 6000), "");
  }
  await writeFile(join(dayDir, "school.md"), lines.join("\n"));
  return todos;
}

// ---------------------------------------------------------------- plan

/** @param {ReturnType<typeof apPaths>} P @param {string} date */
async function planHistory(P, date) {
  const out = [];
  for (let i = 1; i <= 14; i++) {
    const plan = await readJson(join(P.days, addDays(date, -i), "plan.json"));
    if (plan) out.push(plan);
  }
  return out;
}

/** @param {Awaited<ReturnType<typeof loadState>>} S @param {string} date */
async function currentPace(S, date) {
  const saved = await readJson(S.P.pace);
  if (saved && saved.asOf <= date && dayDiff(saved.asOf, date) < 7) return saved;
  const pace = paceCheck(S.calendar, S.model, date);
  await writeJson(S.P.pace, pace);
  return pace;
}

/**
 * @param {string} date
 * @param {{ align?: boolean }} [opts]
 */
export async function planFor(date, opts = {}) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  await mkdir(dayDir, { recursive: true });
  let align = {};
  const todos = await writeSchoolContext(S.P, date, dayDir);
  if (opts.align !== false && !DIAGNOSTIC_DAYS.some((d) => d.date === date)) {
    align = await runAlign(S, date, dayDir).catch((err) => {
      console.warn(`[ap-study] align skipped: ${err instanceof Error ? err.message : err}`);
      return fallbackAlign(todos, date);
    });
  }
  await writeJson(join(dayDir, "align.json"), align);
  const pace = await currentPace(S, date);
  const plan = planDay({
    date,
    curricula: S.curricula,
    calendar: S.calendar,
    model: S.model,
    pace,
    history: await planHistory(S.P, date),
    align,
    prefs: S.overrides,
  });
  await writeJson(join(dayDir, "plan.json"), plan);
  return plan;
}

/**
 * Without the model: heavy day from test count, schoolTest per exam.
 * @param {Record<string, any>} todos
 * @param {string} date
 */
export function fallbackAlign(todos, date) {
  const soon = (t) => t.due === date || t.due === addDays(date, 1);
  const tests = Object.values(todos).flatMap((c) => c.todos.filter((t) => soon(t) && looksLikeTest(t)).map((t) => ({ ...t, exams: c.exams })));
  const exams = {};
  for (const t of tests) for (const e of t.exams) exams[e] = { reinforce: [], preview: [], avoid: [], schoolTest: true, note: t.name };
  return { heavyDay: tests.length >= 2, heavyReason: tests.length >= 2 ? tests.map((t) => t.name).join(", ") : "", exams };
}

/** @param {Awaited<ReturnType<typeof loadState>>} S @param {string} date @param {string} dayDir */
async function runAlign(S, date, dayDir) {
  const lines = ["# AP topics", "", "key | name | unit | introduced", "---|---|---|---"];
  for (const [key, row] of Object.entries(S.index)) {
    lines.push(`${key} | ${row.name} | ${row.unitName} | ${S.model.topics[key]?.introducedAt ? "yes" : "no"}`);
  }
  await writeFile(join(dayDir, "topics.md"), lines.join("\n"));
  const { raw } = await runJsonAgent({
    prefix: "ap-study-align",
    cwd: dayDir,
    prompt: buildAlignPrompt({ date, contextFile: "school.md", topicsFile: "topics.md" }),
    outFile: "align.json",
  });
  return normalizeAlign(raw, S.index);
}

// ---------------------------------------------------------------- write

/** @param {Awaited<ReturnType<typeof loadState>>} S @param {any} plan @param {string} dayDir */
async function writeWriterContext(S, plan, dayDir) {
  const exams = [...new Set(plan.blocks.map((b) => b.exam))];
  const lines = [`# Writer context for ${plan.date}`, "", `Mode: ${plan.mode}. ${plan.summary}`, ""];
  lines.push("## Topics in the plan", "");
  for (const b of plan.blocks) {
    for (const t of b.topics || []) {
      const m = S.model.topics[t.key];
      const tags = m ? Object.entries(m.errorTags || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} x${n}`).join(", ") : "";
      lines.push(
        `- ${t.key} ${t.name} (${t.unit}). Block ${b.kind}, mode ${t.mode}${t.short ? ", short version" : ""}. ` +
          (m ? `Mastery ${m.mastery.toFixed(2)}, graded ${m.graded}x, last ${m.lastScore ?? "n/a"}${tags ? `, mistakes: ${tags}` : ""}.` : "Never seen.")
      );
    }
  }
  lines.push("");
  for (const exam of exams) {
    const c = S.curricula[exam];
    lines.push(`## ${c.name}`, "", `Exam ${c.examDate}. Format: ${JSON.stringify(c.format)}`, "");
    const insights = await readText(join(S.P.insights, `${exam}.md`));
    if (insights) lines.push("### Insights", "", insights.slice(-3500), "");
  }
  lines.push("## Recent feedback", "");
  for (let i = 1; i <= 7; i++) {
    const g = await readJson(join(S.P.days, addDays(plan.date, -i), "grade.json"));
    if (!g || g.status !== "graded") continue;
    const rows = g.items.filter((it) => exams.includes(it.exam) && !it.skipped);
    if (!rows.length) continue;
    lines.push(`### ${g.date}`);
    for (const it of rows) lines.push(`- ${it.topic} ${Math.round(it.score * 100)}%: ${it.feedback}`);
    if (g.notes) lines.push(`- His note: ${g.notes}`);
    lines.push("");
  }
  const align = await readJson(join(dayDir, "align.json"));
  if (align?.exams) {
    lines.push("## School alignment", "");
    for (const [exam, row] of Object.entries(align.exams)) if (row.note) lines.push(`- ${exam}: ${row.note}`);
    lines.push("");
  }
  const prefs = await readText(S.P.prefs);
  if (prefs) lines.push("## Preferences", "", prefs, "");
  await writeFile(join(dayDir, "context.md"), lines.join("\n"));
}

/** @param {string} date */
export async function writePacket(date) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  const plan = await readJson(join(dayDir, "plan.json"));
  if (!plan) throw new Error(`no plan for ${date}; run plan first`);
  if (!plan.blocks?.length) return { ok: true, skipped: true, reason: plan.mode };
  await writeWriterContext(S, plan, dayDir);
  const { raw, model } = await runJsonAgent({
    prefix: "ap-study-write",
    cwd: dayDir,
    prompt: buildWritePrompt({ date, planFile: "plan.json", contextFile: "context.md" }),
    outFile: "packet.json",
  });
  const focus = S.curricula[plan.focusExam]?.short;
  const title = focus ? `${shortDate(date)} · ${focus}${plan.mode === "diagnostic" ? " diagnostic" : ""}` : raw?.title;
  let packet = normalizePacket({ ...raw, date, title });
  const problems = lintPacket(packet, plan);
  let revised = false;
  if (problems.length) {
    await writeJson(join(dayDir, "packet-draft.json"), packet);
    const fixed = await runJsonAgent({
      prefix: "ap-study-revise",
      cwd: dayDir,
      prompt: buildRevisePrompt({ draftFile: "packet-draft.json", problems }),
      outFile: "packet.json",
    }).catch((err) => {
      console.warn(`[ap-study] revise skipped: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    let next = null;
    try {
      if (fixed) next = normalizePacket({ ...fixed.raw, date, title });
    } catch {
      next = null;
    }
    if (next && lintPacket(next, plan).length < problems.length) {
      packet = next;
      revised = true;
    }
  }
  const warnings = checkPacketAgainstPlan(packet, plan);
  await writeJson(join(dayDir, "packet.json"), packet);
  return { ok: true, model, revised, warnings, items: packet.sections.reduce((n, s) => n + s.items.length, 0) };
}

/** @param {string} date */
export async function renderDay(date) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  const packet = normalizePacket(await readJson(join(dayDir, "packet.json")));
  const out = await renderPacket(packet, dayDir, { curricula: S.curricula });
  return { ok: true, pages: out.work.pageCount, keyPages: out.key.pageCount };
}

// ---------------------------------------------------------------- college prep todo

export const COLLEGE_PREP_TODOS = join(PERSONAL_PROJECTS, "College Prep", "todos");

/** @param {string} date */
export function studyTodoPath(date) {
  return join(COLLEGE_PREP_TODOS, `ap-study-${date}`, "todo.json");
}

/**
 * Todo written only after the OneNote page exists. The site tile is the
 * same OneNote file link class todos use.
 * @param {{ date: string, plan?: any, page?: any, createdAt?: string }} opts
 */
export function buildStudyTodo(opts) {
  const page = opts.page || {};
  const url = String(page.webUrl || "").trim();
  const pageId = String(page.id || "").trim();
  if (!pageId || !/^https:\/\//i.test(url)) return null;
  const name = `${shortDate(opts.date)} AP study`;
  const detail = String(opts.plan?.summary || "")
    .replace(/^AP:\s*/, "")
    .replace(/,\s*\d+\s*min\s*$/, "")
    .trim();
  /** @type {{ name: string, url: string, oneNote: string, pageId: string, main: boolean, clientUrl?: string }} */
  const site = { name, url, oneNote: "personal", pageId, main: true };
  const clientUrl = String(page.clientUrl || "").trim();
  if (/^onenote:/i.test(clientUrl)) site.clientUrl = clientUrl;
  return {
    name,
    dueDate: opts.date,
    dueTime: "23:59",
    done: false,
    showInDates: false,
    createdAt: opts.createdAt || new Date().toISOString(),
    description: detail ? `${detail}. 30 minutes.` : "30 minutes.",
    sites: [site],
  };
}

/**
 * Keep done, createdAt, and any extra keys. Refresh the name and the link.
 * @param {any} prev
 * @param {any} next
 */
export function mergeStudyTodo(prev, next) {
  if (!prev) return next;
  return { ...prev, name: next.name, description: next.description, dueDate: next.dueDate, sites: next.sites };
}

/**
 * @param {string} date
 * @param {any} page
 * @param {any} plan
 */
export async function ensureStudyTodo(date, page, plan) {
  const next = buildStudyTodo({ date, plan, page });
  if (!next) return { ok: false, reason: "no page" };
  const path = studyTodoPath(date);
  const prev = await readJson(path);
  const todo = mergeStudyTodo(prev, next);
  if (prev && JSON.stringify(prev) === JSON.stringify(todo)) return { ok: true, skipped: true, path };
  await writeJson(path, todo);
  return { ok: true, created: !prev, path };
}

// ---------------------------------------------------------------- publish

/** @param {Awaited<ReturnType<typeof loadState>>} S @param {any} plan @param {string} date */
async function sideNote(S, plan, date) {
  const rows = [`<p><b>${esc(plan.summary)}</b></p>`];
  const pace = await readJson(S.P.pace);
  const behind = pace ? EXAM_IDS.filter((e) => pace.exams[e]?.behindWeeks > 0) : [];
  if (behind.length) {
    rows.push(`<p>Behind: ${behind.map((e) => `${esc(S.curricula[e].short)} ${pace.exams[e].behindWeeks} wk`).join(", ")}</p>`);
  }
  const g = await readJson(join(S.P.days, addDays(date, -1), "grade.json"));
  if (g?.status === "graded") {
    const done = g.items.filter((i) => !i.skipped);
    const pct = done.length ? Math.round((done.reduce((s, i) => s + i.earned, 0) / done.reduce((s, i) => s + i.points, 0)) * 100) : 0;
    rows.push(`<p>Yesterday: ${done.length} of ${g.items.length} answered, ${pct}%.</p>`);
  }
  return rows.join("");
}

/**
 * The day's publish.json with the page's current Graph id, saved back when it
 * changed. Null when the page is no longer in OneNote.
 * @param {string} dayDir
 * @param {any} row
 * @param {string} [token]
 */
async function currentPage(dayDir, row, token) {
  if (!row?.id) return null;
  const { onenoteToken } = await import("./school-onenote.js");
  const id = await resolvePageId(token || (await onenoteToken()), row);
  if (!id) return null;
  if (id === row.id) return row;
  const next = { ...row, id };
  await writeJson(join(dayDir, "publish.json"), next);
  return next;
}

/** @param {string} date */
export async function publishDay(date, opts = {}) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  let existing = await readJson(join(dayDir, "publish.json"));
  const plan = await readJson(join(dayDir, "plan.json"));
  if (existing?.id && opts.force) existing = await currentPage(dayDir, existing);
  if (existing?.id && !opts.force) {
    const todo = await ensureStudyTodo(date, existing, plan).catch((err) => {
      console.error(`[ap-study] todo failed for ${date}`, err);
      return null;
    });
    return { ok: true, skipped: true, reason: "published", page: existing, todo: todo?.path || "" };
  }
  if (existing?.id) {
    const ink = await harvestInk(existing.id);
    if (ink.traces > 0) return { ok: false, reason: "the published page already has ink", page: existing };
  }
  const packet = normalizePacket(await readJson(join(dayDir, "packet.json")));
  const boxes = await readJson(join(dayDir, "boxes.json"));
  const pngs = Array.from({ length: boxes.pages }, (_, i) => join(dayDir, "pages", `page-${i + 1}.png`));
  const page = await publishPrintoutPage({
    dateKey: date,
    title: `${shortDate(date)} AP packet: ${packet.title.replace(/^.*?·\s*/, "")}`,
    pngPaths: pngs,
    pdfPath: join(dayDir, "pages", "work.pdf"),
    sideHtml: await sideNote(S, plan, date),
  });
  const row = { ...page, publishedAt: new Date().toISOString(), pages: pngs.length };
  await writeJson(join(dayDir, "publish.json"), row);
  if (existing?.id) {
    const { onenoteToken } = await import("./school-onenote.js");
    await deletePublishedPage(await onenoteToken(), existing).catch((err) => {
      console.error(`[ap-study] could not delete the old ${date} page`, err);
    });
  }
  const todo = await ensureStudyTodo(date, row, plan).catch((err) => {
    console.error(`[ap-study] todo failed for ${date}`, err);
    return null;
  });
  return { ok: true, page: row, todo: todo?.path || "" };
}

// ---------------------------------------------------------------- grade

/**
 * @param {string} date
 * @param {{ force?: boolean, marks?: boolean }} [opts]
 */
export async function gradeDay(date, opts = {}) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  const publish = await readJson(join(dayDir, "publish.json"));
  if (!publish?.id) return { ok: false, date, reason: "not published" };
  const prior = await readJson(join(dayDir, "grade.json"));
  if (prior?.status === "graded" && !opts.force) return { ok: true, skipped: true, date, reason: "graded" };

  const packet = normalizePacket(await readJson(join(dayDir, "packet.json")));
  const plan = await readJson(join(dayDir, "plan.json"));
  const boxes = await readJson(join(dayDir, "boxes.json"));
  // A marked page has his ink baked into the images, so regrade from the saved crops.
  const saved = publish.marked ? await readJson(join(dayDir, "crops.json")) : null;
  if (publish.marked && !saved) return { ok: false, date, reason: "marked page has no saved crops" };
  let crops = saved?.crops || [];
  let totalStrokes = saved?.strokes || 0;
  if (!saved) {
    const live = await currentPage(dayDir, publish);
    if (!live) return { ok: false, date, reason: "page not found in OneNote" };
    const ink = await harvestInk(live.id);
    const pngs = Array.from({ length: boxes.pages }, (_, i) => join(dayDir, "pages", `page-${i + 1}.png`));
    const pages = pngs.map((png, i) => ({ png, strokes: ink.pages[i]?.strokes || [] }));
    totalStrokes = pages.reduce((n, p) => n + p.strokes.length, 0);
    if (totalStrokes > 0) {
      const rendered = await renderInk(pages, boxes.boxes, join(dayDir, "ink"));
      crops = rendered.crops.map((c) => ({
        ...c,
        path: c.path ? relative(dayDir, c.path) : "",
        ...(c.item.startsWith("_") ? {} : { box: c.part ? `${c.item}-${c.part}` : c.item }),
      }));
      await writeJson(join(dayDir, "crops.json"), { strokes: totalStrokes, crops });
      await writeJson(join(dayDir, "ink", "strokes.json"), pages.map((p) => p.strokes.map(strokeBox)));
    }
  }

  /** @type {any} */
  let grade;
  if (totalStrokes === 0) {
    grade = { date, status: "skipped", items: [], learnTopicsSeen: [], selfRatings: [], insights: {}, summary: "" };
  } else {
    const { raw, model } = await runJsonAgent({
      prefix: "ap-study-grade",
      cwd: dayDir,
      prompt: buildGradePrompt({ date, packetFile: "packet.json", cropsFile: "crops.json", planFile: "plan.json" }),
      outFile: "grade.json",
    });
    grade = normalizeGrade(raw, packet, S.index, crops);
    grade.model = model;
    if (grade.minutesSpent && plan?.minutes) grade.timeRatio = Math.round((grade.minutesSpent / plan.minutes) * 100) / 100;
  }
  grade.gradedAt = new Date().toISOString();
  await writeJson(join(dayDir, "grade.json"), grade);

  if (S.model.appliedDays[date] === "skipped" && grade.status === "graded") delete S.model.appliedDays[date];
  if (opts.force && S.model.appliedDays[date] === "graded") {
    console.warn(`[ap-study] ${date} was already applied to the model; regrade updates grade.json and the marks only`);
  }
  const applied = applyGrade(S.model, S.curricula, S.calendar, date, grade);
  await writeJson(S.P.model, S.model);

  for (const [exam, note] of Object.entries(grade.insights || {})) {
    if (!EXAM_IDS.includes(exam)) continue;
    const path = join(S.P.insights, `${exam}.md`);
    const prev = await readText(path);
    if (!prev.includes(`## ${date}`)) await writeFile(path, `${prev.trimEnd()}\n\n## ${date}\n\n${note}\n`);
  }

  let marks = null;
  if (grade.status === "graded" && opts.marks !== false) {
    marks = await markDay(date).catch((err) => {
      console.error(`[ap-study] marks failed for ${date}`, err);
      return null;
    });
  }
  return { ok: true, date, status: grade.status, strokes: totalStrokes, applied, marks };
}

/** @param {{ points: [number, number][] }} s */
function strokeBox(s) {
  const xs = s.points.map((p) => p[0]);
  const ys = s.points.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
}

/**
 * Repost the day's page with his ink and red marks from grade.json (plus
 * `extra`, box id -> note) drawn into the page images. Deletes the page it
 * replaces and repoints the College Prep todo.
 * @param {string} date
 * @param {Record<string, string>} [extra]
 */
export async function markDay(date, extra = {}) {
  const S = await loadState();
  const dayDir = join(S.P.days, date);
  const publish = await readJson(join(dayDir, "publish.json"));
  if (!publish?.id) return { ok: false, date, reason: "not published" };
  const grade = await readJson(join(dayDir, "grade.json"));
  const boxes = await readJson(join(dayDir, "boxes.json"));
  const bboxes = await readJson(join(dayDir, "ink", "strokes.json"));
  if (!bboxes) return { ok: false, date, reason: "no ink/strokes.json; grade first" };
  const notes = { ...(grade?.notes || {}), ...extra };
  let head = "";
  if (grade?.status === "graded") {
    const done = grade.items.filter((i) => !i.skipped);
    const pts = done.reduce((s, i) => s + i.points, 0);
    const earned = done.reduce((s, i) => s + i.earned, 0);
    head = `${earned}/${pts}${grade.summary ? ` · ${grade.summary}` : ""}`;
  }
  const inkPngs = Array.from({ length: boxes.pages }, (_, i) => join(dayDir, "ink", `ink-page-${i + 1}.png`));
  const { marks, pngs } = await layoutMarks({ inkPngs, boxes: boxes.boxes, notes, bboxes, head, outDir: join(dayDir, "pages") });

  const { onenoteToken, readOnenotePageInk } = await import("./school-onenote.js");
  const token = await onenoteToken();
  const live = await currentPage(dayDir, publish, token);
  if (live && !publish.marked) {
    const ink = await readOnenotePageInk(token, live.id);
    await writeFile(join(dayDir, "ink", "original.inkml"), ink.inkml);
  }
  const page = await publishPrintoutPage({
    dateKey: date,
    title: publish.title,
    pngPaths: pngs,
    pdfPath: join(dayDir, "pages", "work.pdf"),
    token,
  });
  const row = { ...page, publishedAt: new Date().toISOString(), pages: boxes.pages, marked: true };
  await writeJson(join(dayDir, "publish.json"), row);
  await writeJson(join(dayDir, "marks.json"), { at: row.publishedAt, marks });
  if (live) {
    await deletePublishedPage(token, live).catch((err) => console.error(`[ap-study] could not delete the old ${date} page`, err));
  }
  const status = await readJson(S.P.status);
  if (status?.date === addDays(date, 1)) await writeStatus(S.P, status.date, status.error || "");
  const plan = await readJson(join(dayDir, "plan.json"));
  await ensureStudyTodo(date, row, plan).catch((err) => console.error(`[ap-study] todo failed for ${date}`, err));
  return { ok: true, date, marks: marks.length, url: row.webUrl };
}

// ---------------------------------------------------------------- pace page

/** @param {string} date */
export async function publishPace(date) {
  const S = await loadState();
  const pace = paceCheck(S.calendar, S.model, date);
  await writeJson(S.P.pace, pace);
  const rows = EXAM_IDS.map((e) => {
    const p = pace.exams[e];
    const status = p.behindWeeks > 0 ? `${p.behindWeeks} wk behind` : p.ahead ? `${p.ahead} topics ahead` : "on schedule";
    return `<tr><td>${esc(S.curricula[e].name)}</td><td>${p.introduced} of ${p.topics}</td><td>${p.scheduled}</td><td>${esc(status)}</td><td>${p.onTrackMiss}</td><td>${p.minutes} min</td></tr>`;
  }).join("");
  const april = date >= "2027-03-25" ? aprilPriorityList(S.calendar, S.model).slice(0, 12) : [];
  const html = `<p>Introduced means a learn page plus 2 graded items. Weak means introduced over 14 days ago and still under 0.6 mastery. Minutes are next week's plan.</p>
<table border="1"><tr><td><b>Exam</b></td><td><b>Introduced</b></td><td><b>Due by now</b></td><td><b>Status</b></td><td><b>Weak</b></td><td><b>Next week</b></td></tr>${rows}</table>
${april.length ? `<p><b>April priorities</b></p><ol>${april.map((k) => `<li>${esc(`${S.curricula[S.index[k].exam].short}: ${S.index[k].name}`)}</li>`).join("")}</ol>` : ""}`;
  const { createOnenotePage, ensureOwnedNotebook, ensureSection, onenoteToken } = await import("./school-onenote.js");
  const token = await onenoteToken();
  const nb = await ensureOwnedNotebook(token, AP_NOTEBOOK_NAME);
  const section = await ensureSection(token, nb.id, monthSectionName(date));
  const page = await createOnenotePage(token, section.id, {
    html: `<!DOCTYPE html><html><head><title>${esc(`${shortDate(date)} pace check`)}</title></head><body>${html}</body></html>`,
    parts: [],
  });
  return { ok: true, pace, page: page.webUrl };
}

// ---------------------------------------------------------------- run

/**
 * Nightly job: grade recent days, plan, write, render, publish.
 * @param {{ date?: string, force?: boolean }} [opts]
 */
export async function runDay(opts = {}) {
  const P = apPaths();
  const date = opts.date || todayKey();
  if (date < DIAGNOSTIC_DAYS[0].date) return { ok: true, skipped: true, reason: "before start", date };
  const handle = await acquireLock(P);
  if (!handle) return { ok: true, skipped: true, reason: "in-flight", date };
  const log = { date, steps: [] };
  const step = (name, data) => {
    log.steps.push({ name, ...data });
    console.log(`[ap-study] ${date} ${name}`, JSON.stringify(data).slice(0, 400));
  };
  try {
    if (!existsSync(P.model)) step("seed", await seed());
    const S = await loadState(P);
    if (S.overrides.paused) {
      step("paused", {});
      return { ok: true, skipped: true, reason: "paused", date };
    }

    for (let i = 3; i >= 1; i--) {
      const d = addDays(date, -i);
      const pub = await readJson(join(P.days, d, "publish.json"));
      if (!pub?.id) continue;
      const g = await readJson(join(P.days, d, "grade.json"));
      if (g?.status === "graded") continue;
      if (g?.status === "skipped" && i > 2) continue;
      try {
        step(`grade ${d}`, await gradeDay(d));
      } catch (err) {
        step(`grade ${d} failed`, { error: err instanceof Error ? err.message : String(err) });
        if (err?.transient) throw err;
      }
    }

    if (weekday(date) === 0 && date >= S.calendar.start) {
      step("pace", await publishPace(date).then((r) => ({ page: r.page })).catch((err) => ({ error: String(err?.message || err) })));
    }

    const syllabusAge = await mtimeMs(join(P.syllabi, "us-history.md"));
    if (Date.now() - syllabusAge > 25 * 86400000) {
      step("syllabi", await captureSyllabi().catch((err) => ({ error: String(err?.message || err) })));
    }

    const dayDir = join(P.days, date);
    const published = await readJson(join(dayDir, "publish.json"));
    if (published?.id && !opts.force) {
      step("already published", { url: published.webUrl });
      const plan = await readJson(join(dayDir, "plan.json"));
      step("todo", await ensureStudyTodo(date, published, plan).catch((err) => ({ error: String(err?.message || err) })));
      await writeStatus(P, date);
      return { ok: true, skipped: true, reason: "published", date, url: published.webUrl };
    }

    const plan = await planFor(date);
    step("plan", { mode: plan.mode, summary: plan.summary, minutes: plan.minutes });
    if (!plan.blocks.length) {
      await writeStatus(P, date);
      return { ok: true, date, mode: plan.mode };
    }
    step("write", await writePacket(date));
    step("render", await renderDay(date));
    const pub = await publishDay(date, { force: opts.force });
    step("publish", { url: pub.page?.webUrl });
    await writeStatus(P, date);
    return { ok: true, date, mode: plan.mode, summary: plan.summary, url: pub.page?.webUrl };
  } catch (err) {
    step("failed", { error: err instanceof Error ? err.message : String(err) });
    await writeStatus(P, date, err instanceof Error ? err.message : String(err)).catch(() => {});
    return { ok: false, date, error: err instanceof Error ? err.message : String(err), transient: Boolean(err?.transient) };
  } finally {
    await writeJson(join(P.days, date, "run-log.json"), log).catch(() => {});
    await releaseLock(P, handle);
  }
}

/** @param {ReturnType<typeof apPaths>} P @param {string} date @param {string} [error] */
async function writeStatus(P, date, error = "") {
  const plan = await readJson(join(P.days, date, "plan.json"));
  const pub = await readJson(join(P.days, date, "publish.json"));
  const prevDate = addDays(date, -1);
  const prev = await readJson(join(P.days, prevDate, "grade.json"));
  const prevPub = await readJson(join(P.days, prevDate, "publish.json"));
  const pace = await readJson(P.pace);
  let yesterday = null;
  if (prev?.status === "graded") {
    const done = prev.items.filter((i) => !i.skipped);
    const pts = done.reduce((s, i) => s + i.points, 0);
    yesterday = { answered: done.length, items: prev.items.length, percent: pts ? Math.round((done.reduce((s, i) => s + i.earned, 0) / pts) * 100) : 0, marksUrl: prevPub?.marked ? prevPub.webUrl : "" };
  } else if (prev?.status === "skipped") {
    yesterday = { skipped: true };
  }
  const status = {
    date,
    updatedAt: new Date().toISOString(),
    mode: plan?.mode || "",
    summary: plan?.summary || "",
    minutes: plan?.minutes || 0,
    url: pub?.webUrl || "",
    clientUrl: pub?.clientUrl || "",
    yesterday,
    behind: pace ? EXAM_IDS.filter((e) => pace.exams[e]?.behindWeeks > 0).map((e) => ({ exam: e, weeks: pace.exams[e].behindWeeks })) : [],
    error,
  };
  await writeJson(P.status, status);
  return status;
}

/**
 * Daily Briefing capsule. Null when there is nothing for today.
 * @param {string} date
 */
/**
 * Drop the AP Study card in right after the agent recap. Replaces one that
 * is already there.
 * @param {{ capsules?: any[] }} todo
 * @param {any} capsule
 */
export function insertApStudyCapsule(todo, capsule) {
  if (!capsule || !todo || !Array.isArray(todo.capsules) || !todo.capsules.length) return false;
  const caps = todo.capsules.filter((c) => c?.id !== "ap-study");
  caps.splice(Math.min(1, caps.length), 0, capsule);
  todo.capsules = caps;
  return true;
}

/**
 * Read today's briefing todo and insert the AP Study card when there is one.
 * @param {string} date
 */
export async function attachApStudyToBriefing(date) {
  const { briefingTodoPath } = await import("./daily-briefing-agent.js");
  const path = briefingTodoPath(date);
  let todo;
  try {
    todo = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { ok: false, reason: "no todo" };
  }
  const capsule = await apStudyBriefingCapsule(date);
  if (!capsule) return { ok: true, skipped: true, reason: "no packet" };
  if (!insertApStudyCapsule(todo, capsule)) return { ok: false, reason: "no capsules" };
  await writeFile(path, `${JSON.stringify(todo, null, 2)}\n`);
  return { ok: true, path };
}

export async function apStudyBriefingCapsule(date) {
  const P = apPaths();
  const s = await readJson(P.status);
  if (!s || s.date !== date) return null;
  const S = await loadState(P).catch(() => null);
  const name = (e) => S?.curricula?.[e]?.short || e;
  const lines = [];
  if (s.error && !s.url) lines.push(`Today's packet failed: ${s.error}`);
  else if (s.summary) lines.push(`${s.summary}.${s.url ? " It's in OneNote under AP Study 2026-27." : ""}`);
  if (s.yesterday?.skipped) lines.push("Yesterday's packet had no ink, so it counted as a missed day.");
  else if (s.yesterday) lines.push(`Yesterday: ${s.yesterday.answered} of ${s.yesterday.items} answered, ${s.yesterday.percent}%.${s.yesterday.marksUrl ? " Red marks are on that page." : ""}`);
  if (s.behind?.length) lines.push(`Behind: ${s.behind.map((b) => `${name(b.exam)} by ${b.weeks} wk`).join(", ")}.`);
  if (!lines.length) return null;
  return { id: "ap-study", title: "AP Study", category: "other", noVote: true, vote: null, body: lines.join("\n"), citations: [] };
}

// ---------------------------------------------------------------- status

export async function statusReport(date = todayKey()) {
  const S = await loadState();
  const pace = await readJson(S.P.pace);
  const graded = Object.values(S.model.topics).filter((t) => t.graded > 0);
  const byExam = Object.fromEntries(
    EXAM_IDS.map((e) => {
      const rows = Object.entries(S.calendar.topics).filter(([, c]) => c.exam === e);
      const seen = rows.filter(([k]) => S.model.topics[k]?.introducedAt);
      const mastery = rows.length ? rows.reduce((s, [k]) => s + (S.model.topics[k]?.mastery ?? 0), 0) / rows.length : 0;
      return [e, { topics: rows.length, introduced: seen.length, avgMastery: Math.round(mastery * 100) / 100, behindWeeks: pace?.exams?.[e]?.behindWeeks ?? null }];
    })
  );
  return {
    ok: true,
    date,
    dir: S.P.root,
    status: await readJson(S.P.status),
    overrides: S.overrides,
    gradedTopics: graded.length,
    appliedDays: Object.keys(S.model.appliedDays).length,
    exams: byExam,
  };
}

// ---------------------------------------------------------------- scheduler

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

async function schedulerMeta() {
  const { readBriefingMeta } = await import("./daily-briefing-agent.js");
  return readBriefingMeta();
}

/** @param {any} meta */
export function apStudyHm(meta) {
  const raw = String(meta?.apStudyLocalTime || DEFAULT_AP_STUDY_HM).trim();
  return /^\d{2}:\d{2}$/.test(raw) ? raw : DEFAULT_AP_STUDY_HM;
}

async function armTimer() {
  const { briefingNow, hmToMinutes, schedulerWait } = await import("./daily-briefing-agent.js");
  const meta = await schedulerMeta();
  const now = briefingNow(meta);
  const target = hmToMinutes(apStudyHm(meta));
  let delayMin = target - now.minutes;
  if (delayMin <= 0) delayMin += 24 * 60;
  const wait = schedulerWait(Date.now() + delayMin * 60000);
  console.log(`[ap-study] next run in ${Math.round(wait.delay / 60000)} min${wait.fire ? "" : " recheck"}`);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    const job = wait.fire ? runScheduled() : Promise.resolve();
    job.finally(() => armTimer().catch((err) => console.error("[ap-study] reschedule failed", err)));
  }, wait.delay);
}

/** Retries a transient model failure twice, 20 then 60 minutes later. */
async function runScheduled() {
  const { briefingNow } = await import("./daily-briefing-agent.js");
  const meta = await schedulerMeta();
  const date = briefingNow(meta).dateKey;
  for (const waitMin of [0, 20, 60]) {
    if (waitMin) await new Promise((r) => setTimeout(r, waitMin * 60000));
    const r = await runDay({ date }).catch((err) => ({ ok: false, transient: false, error: String(err) }));
    if (r.ok || !r.transient) return r;
  }
  return null;
}

async function maybeRunMissed() {
  const { briefingNow, hmToMinutes } = await import("./daily-briefing-agent.js");
  const meta = await schedulerMeta();
  const now = briefingNow(meta);
  if (now.minutes < hmToMinutes(apStudyHm(meta))) return;
  if (now.dateKey < DIAGNOSTIC_DAYS[0].date) return;
  const P = apPaths();
  if (existsSync(join(P.days, now.dateKey, "publish.json"))) return;
  const s = await readJson(P.status);
  if (s?.date === now.dateKey && !s.error && s.mode && !s.url) return;
  console.log(`[ap-study] missed-run recovery for ${now.dateKey}`);
  await runScheduled();
}

export function startApStudyScheduler() {
  if (String(process.env.AP_STUDY_SCHEDULER || "1") === "0") return;
  armTimer().catch((err) => console.error("[ap-study] scheduler start failed", err));
  setTimeout(() => {
    maybeRunMissed().catch((err) => console.error("[ap-study] missed recovery failed", err));
  }, 45000);
}

// ---------------------------------------------------------------- cli

/** @param {string[]} argv */
function parseCli(argv) {
  const out = { cmd: argv[0] || "help", date: "", force: false, page: "", align: true, noMarks: false, topics: [], notes: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--date") out.date = argv[++i] || "";
    else if (a === "--force") out.force = true;
    else if (a === "--page") out.page = argv[++i] || "";
    else if (a === "--no-align") out.align = false;
    else if (a === "--no-marks") out.noMarks = true;
    else if (a === "--topic") out.topics.push(argv[++i] || "");
    else if (a === "--note") {
      const [id, ...rest] = String(argv[++i] || "").split("=");
      if (id && rest.length) out.notes[id.trim()] = rest.join("=");
    }
  }
  return out;
}

const USAGE = `node server/ap-study.js <command> [--date YYYY-MM-DD] [--force]
  seed        copy curriculum, build calendar, create model from priors
  calendar    rebuild calendar.json from calendar-spec
  syllabi     capture class syllabi from the class notebooks
  plan        plan a day (--no-align skips the school alignment model)
  write       write packet.json from plan.json
  render      print packet pages, key, and answer boxes
  publish     put the day's pages in OneNote
  grade       read ink, grade, update model, repost the page with red marks (--no-marks skips them)
  mark        repost the marks from grade.json; --note q3-b="1/2 | comment" adds or replaces one box
  run         nightly job for a date (default today)
  pace        Sunday pace check and OneNote page
  status      summary JSON
  know        mark topics already known (--topic key, repeatable)
  ink-check   stroke counts on a page (--page ID)`;

export async function runCli(argv) {
  const a = parseCli(argv);
  const date = a.date || todayKey();
  switch (a.cmd) {
    case "seed":
      return seed({ force: a.force });
    case "calendar":
      return rebuildCalendar();
    case "syllabi":
      return captureSyllabi({ force: a.force });
    case "plan":
      return planFor(date, { align: a.align });
    case "write":
      return writePacket(date);
    case "render":
      return renderDay(date);
    case "publish":
      return publishDay(date, { force: a.force });
    case "grade":
      return gradeDay(date, { force: a.force, marks: !a.noMarks });
    case "mark":
      return markDay(date, a.notes);
    case "run":
      return runDay({ date, force: a.force });
    case "pace":
      return publishPace(date);
    case "status":
      return statusReport(date);
    case "know": {
      const keys = a.topics.map((k) => k.trim()).filter(Boolean);
      if (!keys.length) return { ok: false, error: "know needs --topic" };
      const S = await loadState();
      const unknown = keys.filter((k) => !S.index[k]);
      if (unknown.length) return { ok: false, error: `unknown topic: ${unknown.join(", ")}` };
      for (const key of keys) markKnown(S.model, key, date);
      await writeJson(S.P.model, S.model);
      return { ok: true, date, topics: keys };
    }
    case "ink-check": {
      if (!a.page) return { ok: false, error: "ink-check needs --page" };
      const ink = await harvestInk(a.page);
      return { ok: true, traces: ink.traces, pages: ink.pages.map((p) => ({ index: p.index, alt: p.image.alt, strokes: p.strokes.length })) };
    }
    default:
      return { ok: true, usage: USAGE };
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      if (r && r.ok === false) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
