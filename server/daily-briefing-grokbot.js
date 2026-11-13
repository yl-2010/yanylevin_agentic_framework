/**
 * Grok Bot runner for the morning Daily Briefing.
 *
 * With DAILY_BRIEFING_RUNNER=grokbot in server/.env, Express skips the Cursor
 * SDK phases. A Grok Bot routine runs this CLI on the Mac Studio instead and
 * does the model work itself. Everything that is not model work stays here
 * and reuses daily-briefing-agent.js: date and zone, the nightly prefetch, the
 * shared lock, the exact phase prompts, the draft paths, and the end-of-run
 * git step. The todo.json and taste.md that phase 3 writes are the same files
 * with the same schema as a Cursor run.
 *
 *   node server/daily-briefing-grokbot.js prepare   [--date YYYY-MM-DD] [--force] [--phase all|news|agent-recap|unslop] [--dry-run] [--out-dir DIR]
 *   node server/daily-briefing-grokbot.js phase-done --phase news|agent-recap [--date ...]
 *   node server/daily-briefing-grokbot.js finalize  [--date ...]
 *   node server/daily-briefing-grokbot.js status    [--date ...]
 *   node server/daily-briefing-grokbot.js release   [--date ...]
 *
 * Every command prints one JSON object. Exit 0 = ok, 2 = output failed
 * validation (fix the file and run the command again), 3 = another run holds
 * the lock, 1 = anything else.
 */

import "./load-server-env.js";
import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureServiceLogDir } from "./service-logs.js";
import {
  AGENT_RECAP_MODEL_SPEC,
  BRIEFING_NEWS_MODEL_SPEC,
  BRIEFING_REPO_ROOT,
  BRIEFING_UNSLOP_MODEL_SPEC,
  LOCK_PATH,
  LOCK_STALE_MS,
  META_PATH,
  NIGHTLY_STATUS_PATH,
  SERVER_LOG_PATH,
  UNSLOP_SKILL_PATH,
  addDaysToDateKey,
  agentRecapDraftPath,
  briefingContext,
  briefingExists,
  briefingRunner,
  briefingTodoPath,
  buildAgentRecapPrompt,
  buildNewsPrompt,
  buildUnslopPrompt,
  newsDraftPath,
  prefetchNightlyStatus,
} from "./daily-briefing-agent.js";
import { gitAddCommitPush } from "./git-publish.js";
import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";

export const GROKBOT_OUT_DIR = "/tmp/yanylevin-daily-briefing-grokbot";
export const PHASES = ["news", "agent-recap", "unslop"];
export const NEWS_CATEGORIES = new Set([
  "global",
  "us",
  "politics",
  "wa",
  "local",
  "pop",
  "tech",
  "markets",
  "other",
]);
const BRIEFING_DIR = join(YAN_EDUCATION_DIR, "daily-briefing");
export const TASTE_PATH = join(BRIEFING_DIR, "taste.md");
const SKILLS = {
  news: join(BRIEFING_REPO_ROOT, ".cursor/skills/daily-news/SKILL.md"),
  "agent-recap": join(BRIEFING_REPO_ROOT, ".cursor/skills/agent-recap/SKILL.md"),
};
const MODEL_SPECS = {
  news: BRIEFING_NEWS_MODEL_SPEC,
  "agent-recap": AGENT_RECAP_MODEL_SPEC,
  unslop: BRIEFING_UNSLOP_MODEL_SPEC,
};
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} code
   * @param {object} [extra]
   */
  constructor(message, code = 1, extra = {}) {
    super(message);
    this.code = code;
    this.extra = extra;
  }
}

/* ---------- validation (pure, exported for tests) ---------- */

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function httpUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * @param {unknown} list
 * @param {string} where
 * @param {string[]} errors
 */
function checkCitations(list, where, errors) {
  if (!Array.isArray(list) || !list.length) {
    errors.push(`${where}: citations must be a non-empty array of { name, url }`);
    return;
  }
  list.forEach((cite, i) => {
    if (!cite || typeof cite !== "object" || !nonEmpty(cite.name) || !httpUrl(cite.url)) {
      errors.push(`${where}: citations[${i}] needs a name and an http(s) url`);
    }
  });
}

/**
 * One news capsule, in the draft or in the final todo.
 * @param {any} cap
 * @param {string} where
 * @param {string[]} errors
 * @param {{ allowVotes?: boolean }} [opts]
 */
function checkNewsCapsule(cap, where, errors, opts = {}) {
  if (!cap || typeof cap !== "object") {
    errors.push(`${where}: not an object`);
    return;
  }
  if (!nonEmpty(cap.id) || !KEBAB_RE.test(cap.id)) errors.push(`${where}: id must be kebab-case`);
  if (cap.id === "agent-recap") errors.push(`${where}: agent-recap is not a news capsule`);
  if (!NEWS_CATEGORIES.has(cap.category)) {
    errors.push(`${where}: category must be one of ${[...NEWS_CATEGORIES].join(", ")}`);
  }
  if (!nonEmpty(cap.title)) errors.push(`${where}: title is empty`);
  if (!nonEmpty(cap.body)) errors.push(`${where}: body is empty`);
  const voteOk = opts.allowVotes
    ? cap.vote === null || cap.vote === "up" || cap.vote === "down"
    : cap.vote === null;
  if (!voteOk) errors.push(`${where}: vote must be null${opts.allowVotes ? ', "up", or "down"' : ""}`);
  if (cap.noVote) errors.push(`${where}: news capsules take votes (no noVote)`);
  checkCitations(cap.citations, where, errors);
}

/**
 * @param {any} draft
 */
export function validateNewsDraft(draft) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, errors: ["news draft must be a JSON object { capsules, citations }"], warnings };
  }
  const caps = draft.capsules;
  if (!Array.isArray(caps) || !caps.length) {
    errors.push("capsules must be a non-empty array");
  } else {
    const seen = new Set();
    caps.forEach((cap, i) => {
      checkNewsCapsule(cap, `capsules[${i}]`, errors);
      if (cap && seen.has(cap.id)) errors.push(`capsules[${i}]: duplicate id ${cap.id}`);
      if (cap) seen.add(cap.id);
    });
    if (caps.length < 9 || caps.length > 12) {
      warnings.push(`${caps.length} news capsules; the skill aims for about 10 (9-12)`);
    }
  }
  if (!Array.isArray(draft.citations)) errors.push("top-level citations must be an array");
  else checkCitations(draft.citations, "top-level", errors);
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @param {any} cap
 * @param {string} where
 * @param {string[]} errors
 */
function checkRecapCapsule(cap, where, errors) {
  if (!cap || typeof cap !== "object" || Array.isArray(cap)) {
    errors.push(`${where}: must be a JSON object`);
    return;
  }
  if (cap.id !== "agent-recap") errors.push(`${where}: id must be "agent-recap"`);
  if (cap.title !== "Agent Recap") errors.push(`${where}: title must be "Agent Recap"`);
  if (cap.category !== "other") errors.push(`${where}: category must be "other"`);
  if (cap.noVote !== true) errors.push(`${where}: noVote must be true`);
  if (cap.vote !== null) errors.push(`${where}: vote must be null`);
  if (!nonEmpty(cap.body)) errors.push(`${where}: body is empty`);
  if (cap.citations != null && !(Array.isArray(cap.citations) && !cap.citations.length)) {
    errors.push(`${where}: agent recap has no citations`);
  }
}

/**
 * @param {any} recap
 */
export function validateRecapDraft(recap) {
  /** @type {string[]} */
  const errors = [];
  checkRecapCapsule(recap, "agent recap", errors);
  return { ok: errors.length === 0, errors, warnings: [] };
}

/**
 * Final todo.json written by phase 3 (daily-news skill schema).
 * @param {any} todo
 * @param {{ dateKey: string, dueTime: string, force?: boolean }} ctx
 */
export function validateBriefingTodo(todo, { dateKey, dueTime, force = false }) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];
  if (!todo || typeof todo !== "object" || Array.isArray(todo)) {
    return { ok: false, errors: ["todo.json must be a JSON object"], warnings };
  }
  if (!nonEmpty(todo.name) || !/ Daily Briefing$/.test(todo.name)) {
    errors.push('name must look like "August 12th Daily Briefing"');
  }
  if (todo.kind !== "dailyBriefing") errors.push('kind must be "dailyBriefing"');
  if (todo.dueDate !== dateKey) errors.push(`dueDate must be ${dateKey}`);
  if (todo.dueTime !== dueTime) errors.push(`dueTime must be ${dueTime}`);
  if (todo.showInDates !== false) errors.push("showInDates must be false");
  if (!force && todo.done !== false) errors.push("done must be false");
  if (!nonEmpty(todo.createdAt) || Number.isNaN(Date.parse(todo.createdAt))) {
    errors.push("createdAt must be an ISO time (now, not a copy of yesterday)");
  }
  for (const key of ["tag", "classId", "projectId", "class", "project"]) {
    if (todo[key] != null) errors.push(`${key} must not be set (user-level todo, no tag)`);
  }
  const caps = Array.isArray(todo.capsules) ? todo.capsules : null;
  if (!caps || caps.length < 2) {
    errors.push("capsules must have the agent recap first, then the news capsules");
  } else {
    checkRecapCapsule(caps[0], "capsules[0]", errors);
    const seen = new Set(["agent-recap"]);
    caps.slice(1).forEach((cap, i) => {
      const where = `capsules[${i + 1}]`;
      checkNewsCapsule(cap, where, errors, { allowVotes: force });
      if (cap && seen.has(cap.id)) errors.push(`${where}: duplicate id ${cap.id}`);
      if (cap) seen.add(cap.id);
    });
    const news = caps.length - 1;
    if (news < 9 || news > 12) warnings.push(`${news} news capsules; the skill aims for about 10 (9-12)`);
  }
  if (!Array.isArray(todo.citations) || !todo.citations.length) {
    errors.push("top-level citations must list every news source");
  } else {
    checkCitations(todo.citations, "top-level", errors);
    const names = todo.citations.map((c) => String(c?.name || ""));
    const sorted = [...names].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
    if (names.join("\n") !== sorted.join("\n")) errors.push("top-level citations must be alphabetical by name");
  }
  return { ok: errors.length === 0, errors, warnings };
}

/* ---------- files, lock, status ---------- */

async function readJson(path) {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw);
}

/**
 * @param {string} path
 * @param {(data: any) => { ok: boolean, errors: string[], warnings: string[] }} check
 */
export async function validateFile(path, check) {
  let data;
  try {
    data = await readJson(path);
  } catch (err) {
    const missing = err && /** @type {{ code?: string }} */ (err).code === "ENOENT";
    return {
      ok: false,
      exists: !missing,
      errors: [missing ? `${path} does not exist` : `${path} is not valid JSON: ${err instanceof Error ? err.message : err}`],
      warnings: [],
    };
  }
  return { exists: true, ...check(data) };
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return 0;
  }
}

function lockTag(dateKey) {
  return `grokbot ${dateKey}`;
}

/**
 * Same lock file Express uses, so a Cursor run and a Grok Bot run never overlap.
 * @param {string} dateKey
 */
async function takeLock(dateKey) {
  const body = `${lockTag(dateKey)} ${new Date().toISOString()}`;
  try {
    const handle = await open(LOCK_PATH, "wx");
    await handle.writeFile(body);
    await handle.close();
    return { taken: true };
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
  }
  const held = await readFile(LOCK_PATH, "utf8").catch(() => "");
  const age = Date.now() - (await mtimeMs(LOCK_PATH));
  if (held.startsWith(lockTag(dateKey)) || age > LOCK_STALE_MS) {
    await writeFile(LOCK_PATH, body, "utf8");
    return { taken: true, reused: held.startsWith(lockTag(dateKey)) };
  }
  throw new CliError(
    `daily briefing lock is held (${held.trim() || "unknown"}, ${Math.round(age / 1000)}s old). Another run is compiling. Run status, wait, and retry; the lock goes stale after ${LOCK_STALE_MS / 60000} min.`,
    3
  );
}

/** @param {string} dateKey */
async function touchLock(dateKey) {
  const held = await readFile(LOCK_PATH, "utf8").catch(() => "");
  if (held.startsWith(lockTag(dateKey))) {
    await writeFile(LOCK_PATH, `${lockTag(dateKey)} ${new Date().toISOString()}`, "utf8");
  }
}

/** @param {string} dateKey */
async function dropLock(dateKey) {
  const held = await readFile(LOCK_PATH, "utf8").catch(() => "");
  if (held.startsWith(lockTag(dateKey))) {
    await rm(LOCK_PATH, { force: true });
    return true;
  }
  return false;
}

function runDir(outDir, dateKey) {
  return join(outDir, dateKey);
}

function statusPath(outDir, dateKey) {
  return join(runDir(outDir, dateKey), "status.json");
}

async function readStatus(outDir, dateKey) {
  try {
    return await readJson(statusPath(outDir, dateKey));
  } catch {
    return { dateKey, runner: "grokbot", phases: {} };
  }
}

async function writeStatus(outDir, dateKey, status) {
  await mkdir(runDir(outDir, dateKey), { recursive: true });
  await writeFile(statusPath(outDir, dateKey), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

/**
 * Same `[daily-briefing…]` lines the Express run writes, so the server log
 * and the next morning's agent recap still see the briefing.
 * @param {string} line
 * @param {boolean} dry
 */
async function serverLog(line, dry) {
  const text = `[daily-briefing-grokbot] ${new Date().toISOString()} ${line}`;
  if (dry) return;
  ensureServiceLogDir();
  await appendFile(SERVER_LOG_PATH, `${text}\n`, "utf8").catch(() => {});
}

/* ---------- bundles ---------- */

/** Last 7 days of briefing todos (de-dupe for news, URGENT carry-over for recap). */
async function recentBriefingTodos(dateKey) {
  const out = [];
  for (let back = 1; back <= 7; back++) {
    const path = briefingTodoPath(addDaysToDateKey(dateKey, -back));
    if (await mtimeMs(path)) out.push(path);
  }
  return out;
}

function modelLabel(spec) {
  const params = (spec.params || []).map((p) => `${p.id}=${p.value}`).join(", ");
  return params ? `${spec.id} (${params})` : spec.id;
}

const COMMON_RUNNER_NOTES = [
  "You are doing the model work the Cursor SDK agent used to do. Treat `prompt` as your whole task, word for word.",
  "The Cursor agent ran on Yan's Mac Studio with cwd = `cwd`. Every relative path in the prompt or skill resolves from there. Read and write files on the Mac with shell (cat, a heredoc, or node -e). Do not write anywhere except `writes`.",
  "Read every file in `skills` first and follow it. Read `inputs` (missing ones are fine unless the prompt needs them).",
  "When the output is written, run `doneCommand`. Exit 2 lists what failed validation. Fix the file and run it again. Give up on a phase only after 3 failed tries, then report the errors.",
];

const PHASE_TOOLS = {
  news: [
    "Web search and page fetch for this morning's news. Only sources the skill allows (WSJ is the rightmost; never Fox or anything right of WSJ). Every capsule cites real article URLs you opened.",
    "Shell on the Mac to read profile.md, preferences.md, taste.md, and the last 7 daily briefing todos.",
  ],
  "agent-recap": [
    "Shell on the Mac: read the nightly prefetch, brain/state.json, the journal, ~/Library/Logs/personal-agent/personal-agent-server.log, and `git log` in the repo.",
    "`node server/calendar-cli.js` (run from cwd) before saying a calendar event is missing. If macOS denies Calendar access to this shell, say the check could not run instead of guessing.",
    "No web search needed. No cloud agents.",
  ],
  unslop: [
    "Shell on the Mac to read the two drafts and the unslop skill, and to write todo.json and taste.md (mkdir -p the todo folder first).",
    "The daily-news skill (phase 3 section) has the exact todo.json schema and the taste rewrite rules.",
  ],
};

/**
 * @param {{ phase: string, dateKey: string, timezone: string, dueTime: string, force: boolean, scriptCmd: string, nightlyStatusPath: string }} p
 */
export async function buildBundle({ phase, dateKey, timezone, dueTime, force, scriptCmd, nightlyStatusPath }) {
  const recent = await recentBriefingTodos(dateKey);
  /** @type {string} */
  let prompt;
  /** @type {string[]} */
  let skills;
  /** @type {string[]} */
  let inputs;
  /** @type {{ path: string, format: string }[]} */
  let writes;
  let validation;
  let doneCommand;
  if (phase === "news") {
    prompt = buildNewsPrompt({ dateKey, timezone, force, dueTime });
    skills = [SKILLS.news];
    inputs = [
      META_PATH,
      join(BRIEFING_DIR, "profile.md"),
      join(BRIEFING_DIR, "preferences.md"),
      TASTE_PATH,
      ...recent,
    ];
    writes = [{ path: newsDraftPath(dateKey), format: 'JSON { "capsules": [...], "citations": [...] }' }];
    validation =
      "JSON object. capsules: non-empty array, ids kebab-case and unique, category in global|us|politics|wa|local|pop|tech|markets|other, title and body non-empty, vote null, citations non-empty [{ name, url }]. citations: [{ name, url }]. About 10 capsules (outside 9-12 is a warning).";
    doneCommand = `${scriptCmd} phase-done --phase news --date ${dateKey}`;
  } else if (phase === "agent-recap") {
    prompt = buildAgentRecapPrompt({ dateKey, timezone, force });
    skills = [SKILLS["agent-recap"]];
    let journal = "";
    try {
      journal = String((await readJson(nightlyStatusPath))?.journalPath || "");
    } catch {
      journal = "";
    }
    inputs = [NIGHTLY_STATUS_PATH, journal, SERVER_LOG_PATH, ...recent].filter(Boolean);
    writes = [{ path: agentRecapDraftPath(dateKey), format: 'JSON { "id": "agent-recap", "title": "Agent Recap", "category": "other", "noVote": true, "vote": null, "body": "..." }' }];
    validation =
      'id "agent-recap", title "Agent Recap", category "other", noVote true, vote null, non-empty body, no citations.';
    doneCommand = `${scriptCmd} phase-done --phase agent-recap --date ${dateKey}`;
  } else {
    prompt = buildUnslopPrompt({ dateKey, timezone, force, dueTime });
    skills = [UNSLOP_SKILL_PATH, SKILLS.news];
    inputs = [newsDraftPath(dateKey), agentRecapDraftPath(dateKey), TASTE_PATH, join(BRIEFING_DIR, "preferences.md"), ...recent];
    writes = [
      { path: briefingTodoPath(dateKey), format: "JSON todo (daily-news skill, phase 3 schema)" },
      { path: TASTE_PATH, format: "markdown, rewritten from last week's news thumbs" },
    ];
    validation = `todo.json: name "<Month Dayth> Daily Briefing", kind dailyBriefing, dueDate ${dateKey}, dueTime ${dueTime}, showInDates false, done false, createdAt ISO now, no tag; capsules[0] is the agent recap (noVote true, vote null, no citations), then news capsules (each with citations); top-level citations alphabetical by name. taste.md must be rewritten after this bundle was prepared.`;
    doneCommand = `${scriptCmd} finalize --date ${dateKey}`;
  }
  return {
    phase,
    dateKey,
    timezone,
    dueTime,
    force,
    preparedAt: new Date().toISOString(),
    replaces: `Cursor SDK local agent, model ${modelLabel(MODEL_SPECS[phase])}`,
    cwd: BRIEFING_REPO_ROOT,
    skills,
    inputs,
    writes,
    validation,
    doneCommand,
    tools: PHASE_TOOLS[phase],
    runnerNotes: COMMON_RUNNER_NOTES,
    prompt,
  };
}

async function writeBundle(outDir, bundle) {
  const dir = runDir(outDir, bundle.dateKey);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${bundle.phase}.json`);
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");
  await writeFile(join(dir, `${bundle.phase}.prompt.txt`), `${bundle.prompt}\n`, "utf8");
  return path;
}

/* ---------- commands ---------- */

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force" || a === "--dry-run" || a === "--json") args[a.slice(2)] = true;
    else if (a.startsWith("--")) {
      const [key, inline] = a.slice(2).split("=", 2);
      args[key] = inline ?? argv[++i];
    } else args._.push(a);
  }
  return args;
}

function scriptCommand() {
  return `cd ${BRIEFING_REPO_ROOT} && node server/daily-briefing-grokbot.js`;
}

const DRAFT_CHECKS = {
  news: { path: newsDraftPath, check: validateNewsDraft },
  "agent-recap": { path: agentRecapDraftPath, check: validateRecapDraft },
};

/**
 * @param {{ date?: string, force?: boolean, phase?: string, dryRun?: boolean, outDir?: string }} opts
 */
export async function prepare(opts = {}) {
  const phase = opts.phase || "all";
  if (phase !== "all" && !PHASES.includes(phase)) throw new CliError(`unknown phase ${phase}`);
  if (opts.date && !DATE_KEY_RE.test(opts.date)) throw new CliError("--date must be YYYY-MM-DD");
  const dry = !!opts.dryRun;
  const outDir = opts.outDir || (dry ? await mkdtemp(join(tmpdir(), "yl-briefing-grokbot-dry-")) : GROKBOT_OUT_DIR);
  const force = !!opts.force;
  const { dateKey, timezone, dueTime } = await briefingContext({ dateKey: opts.date });
  const base = { ok: true, dateKey, timezone, dueTime, runner: briefingRunner(), dryRun: dry, outDir: runDir(outDir, dateKey) };

  if (!force && (await briefingExists(dateKey))) {
    return { ...base, skipped: true, reason: "exists", todo: briefingTodoPath(dateKey), next: "Nothing to do. Today's briefing already exists." };
  }
  if (!dry) await takeLock(dateKey);

  const status = await readStatus(outDir, dateKey);
  status.dateKey = dateKey;
  status.runner = "grokbot";
  status.force = force;
  status.phases = status.phases || {};
  const nightlyStatusPath = dry ? join(runDir(outDir, dateKey), "nightly-status.json") : NIGHTLY_STATUS_PATH;
  const wanted = phase === "all" ? PHASES : [phase];
  if (wanted.includes("news") || wanted.includes("agent-recap")) {
    await mkdir(runDir(outDir, dateKey), { recursive: true });
    await prefetchNightlyStatus(dateKey, timezone, nightlyStatusPath);
    status.prefetchedAt = new Date().toISOString();
  }
  if (!status.startedAt) {
    status.startedAt = new Date().toISOString();
    await serverLog(`compiling ${dateKey} tz=${timezone} runner=grokbot`, dry);
  }

  /** @type {Record<string, object>} */
  const phases = {};
  const ctx = { dateKey, timezone, dueTime, scriptCmd: scriptCommand(), nightlyStatusPath };
  for (const name of ["news", "agent-recap"]) {
    if (!wanted.includes(name)) continue;
    const draft = DRAFT_CHECKS[name].path(dateKey);
    const existing = force ? null : await validateFile(draft, DRAFT_CHECKS[name].check);
    if (existing?.ok) {
      // Same as the Cursor run: a draft already on disk is not redone.
      phases[name] = { state: "done", output: draft, reason: "draft exists" };
      status.phases[name] = { ...(status.phases[name] || {}), state: "done", output: draft };
      continue;
    }
    // A leftover draft that fails validation is rebuilt, so its prompt says overwrite.
    const rebuild = force || !!existing?.exists;
    const bundle = await buildBundle({ phase: name, force: rebuild, ...ctx });
    const path = await writeBundle(outDir, bundle);
    phases[name] = { state: "ready", bundle: path, output: draft };
    status.phases[name] = { state: "ready", bundle: path, output: draft, preparedAt: bundle.preparedAt };
  }
  if (wanted.includes("unslop")) {
    phases.unslop = await prepareUnslop(outDir, status, { ...ctx, force, strict: phase === "unslop" });
  }
  await writeStatus(outDir, dateKey, status);
  return { ...base, phases, next: nextStep(status, dateKey) };
}

/**
 * Phase 3 waits for both drafts, like the Cursor pipeline.
 */
async function prepareUnslop(outDir, status, { dateKey, timezone, dueTime, scriptCmd, nightlyStatusPath, force, strict }) {
  const missing = [];
  for (const name of ["news", "agent-recap"]) {
    const result = await validateFile(DRAFT_CHECKS[name].path(dateKey), DRAFT_CHECKS[name].check);
    if (!result.ok) missing.push(`${name}: ${result.errors.join("; ")}`);
  }
  if (missing.length) {
    if (strict) throw new CliError(`unslop needs both drafts first. ${missing.join(" | ")}`, 2, { errors: missing });
    status.phases.unslop = { state: "waiting", reason: "needs news and agent-recap drafts" };
    return { state: "waiting", reason: "runs after phase-done for news and agent-recap" };
  }
  const bundle = await buildBundle({ phase: "unslop", dateKey, timezone, dueTime, force, scriptCmd, nightlyStatusPath });
  const path = await writeBundle(outDir, bundle);
  status.phases.unslop = { state: "ready", bundle: path, output: briefingTodoPath(dateKey), preparedAt: bundle.preparedAt };
  return { state: "ready", bundle: path, output: briefingTodoPath(dateKey) };
}

function nextStep(status, dateKey) {
  const p = status.phases || {};
  const ready = PHASES.filter((name) => p[name]?.state === "ready");
  if (status.finalizedAt) return "Done.";
  if (ready.includes("news") || ready.includes("agent-recap")) {
    return `Run the ready bundles (${ready.filter((n) => n !== "unslop").join(", ")}) in order, each followed by its doneCommand. phase-done prepares unslop once both drafts pass.`;
  }
  if (ready.includes("unslop")) return `Run the unslop bundle, then: ${scriptCommand()} finalize --date ${dateKey}`;
  return `${scriptCommand()} status --date ${dateKey}`;
}

/**
 * @param {{ phase?: string, date?: string, outDir?: string }} opts
 */
export async function phaseDone(opts = {}) {
  const phase = opts.phase;
  if (!phase || !DRAFT_CHECKS[phase]) {
    throw new CliError("phase-done needs --phase news or --phase agent-recap (unslop ends with finalize)");
  }
  const outDir = opts.outDir || GROKBOT_OUT_DIR;
  const { dateKey, timezone, dueTime } = await briefingContext({ dateKey: opts.date });
  const status = await readStatus(outDir, dateKey);
  status.phases = status.phases || {};
  const draft = DRAFT_CHECKS[phase].path(dateKey);
  const result = await validateFile(draft, DRAFT_CHECKS[phase].check);
  await touchLock(dateKey);
  if (!result.ok) {
    status.phases[phase] = { ...(status.phases[phase] || {}), state: "invalid", errors: result.errors, checkedAt: new Date().toISOString() };
    await writeStatus(outDir, dateKey, status);
    throw new CliError(`${phase} draft failed validation`, 2, { dateKey, phase, output: draft, errors: result.errors, warnings: result.warnings });
  }
  status.phases[phase] = { ...(status.phases[phase] || {}), state: "done", output: draft, doneAt: new Date().toISOString(), warnings: result.warnings };
  await serverLog(`${phase} status=finished ${dateKey}`, false);
  let unslop = status.phases.unslop || null;
  const otherDone = status.phases.news?.state === "done" && status.phases["agent-recap"]?.state === "done";
  if (otherDone && unslop?.state !== "ready") {
    unslop = await prepareUnslop(outDir, status, {
      dateKey,
      timezone,
      dueTime,
      scriptCmd: scriptCommand(),
      nightlyStatusPath: NIGHTLY_STATUS_PATH,
      force: !!status.force,
      strict: false,
    });
  }
  await writeStatus(outDir, dateKey, status);
  return { ok: true, dateKey, phase, output: draft, warnings: result.warnings, unslop, next: nextStep(status, dateKey) };
}

/**
 * @param {{ date?: string, outDir?: string }} opts
 */
export async function finalize(opts = {}) {
  const outDir = opts.outDir || GROKBOT_OUT_DIR;
  const { dateKey, dueTime } = await briefingContext({ dateKey: opts.date });
  const status = await readStatus(outDir, dateKey);
  status.phases = status.phases || {};
  const todoPath = briefingTodoPath(dateKey);
  const result = await validateFile(todoPath, (todo) => validateBriefingTodo(todo, { dateKey, dueTime, force: !!status.force }));
  const errors = [...result.errors];
  const preparedAt = Date.parse(status.phases.unslop?.preparedAt || "");
  const tasteAt = await mtimeMs(TASTE_PATH);
  if (!tasteAt) errors.push(`${TASTE_PATH} does not exist`);
  else if (Number.isFinite(preparedAt) && tasteAt < preparedAt - 1000) {
    errors.push("taste.md was not rewritten in this run (phase 3 rewrites it from last week's news thumbs)");
  }
  await touchLock(dateKey);
  if (errors.length) {
    status.phases.unslop = { ...(status.phases.unslop || {}), state: "invalid", errors, checkedAt: new Date().toISOString() };
    await writeStatus(outDir, dateKey, status);
    await serverLog(`finalize ${dateKey} failed: ${errors.join("; ").slice(0, 400)}`, false);
    throw new CliError("daily briefing failed validation", 2, { dateKey, todo: todoPath, errors, warnings: result.warnings });
  }
  // Same end step as the Cursor pipeline.
  const git = await gitAddCommitPush({
    paths: [YAN_EDUCATION_DIR],
    message: `education: ${dateKey} daily briefing`,
  }).catch((err) => ({ pushed: false, reason: err instanceof Error ? err.message : String(err) }));
  const exists = await briefingExists(dateKey);
  status.phases.unslop = { ...(status.phases.unslop || {}), state: "done", output: todoPath, doneAt: new Date().toISOString() };
  status.finalizedAt = new Date().toISOString();
  status.result = { ok: exists, todo: todoPath };
  await writeStatus(outDir, dateKey, status);
  await dropLock(dateKey);
  await serverLog(`unslop status=finished ${dateKey}; briefing ${exists ? "written" : "missing"} ${todoPath}`, false);
  if (!exists) throw new CliError("pipeline finished but todo missing", 2, { dateKey, todo: todoPath });
  return { ok: true, dateKey, todo: todoPath, taste: TASTE_PATH, warnings: result.warnings, git };
}

/**
 * @param {{ date?: string, outDir?: string }} opts
 */
export async function status(opts = {}) {
  const outDir = opts.outDir || GROKBOT_OUT_DIR;
  const { dateKey, timezone, dueTime } = await briefingContext({ dateKey: opts.date });
  const run = await readStatus(outDir, dateKey);
  const news = await validateFile(newsDraftPath(dateKey), validateNewsDraft);
  const recap = await validateFile(agentRecapDraftPath(dateKey), validateRecapDraft);
  const lock = await readFile(LOCK_PATH, "utf8").catch(() => "");
  return {
    ok: true,
    dateKey,
    timezone,
    dueTime,
    runner: briefingRunner(),
    briefingExists: await briefingExists(dateKey),
    todo: briefingTodoPath(dateKey),
    drafts: {
      news: { path: newsDraftPath(dateKey), ok: news.ok, errors: news.errors },
      "agent-recap": { path: agentRecapDraftPath(dateKey), ok: recap.ok, errors: recap.errors },
    },
    lock: lock ? { held: lock.trim(), ageSec: Math.round((Date.now() - (await mtimeMs(LOCK_PATH))) / 1000) } : null,
    run,
    next: nextStep(run, dateKey),
  };
}

export async function release(opts = {}) {
  const { dateKey } = await briefingContext({ dateKey: opts.date });
  return { ok: true, dateKey, released: await dropLock(dateKey) };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const cmd = args._[0] || "status";
  const opts = {
    date: args.date,
    force: !!args.force,
    phase: args.phase,
    dryRun: !!args["dry-run"],
    outDir: args["out-dir"],
  };
  const run = { prepare, "phase-done": phaseDone, finalize, status, release }[cmd];
  if (!run) throw new CliError(`unknown command ${cmd}. Use prepare, phase-done, finalize, status, or release.`);
  return run(opts);
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
  main()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((err) => {
      const code = err instanceof CliError ? err.code : 1;
      console.log(
        JSON.stringify(
          { ok: false, error: err instanceof Error ? err.message : String(err), ...(err?.extra || {}) },
          null,
          2
        )
      );
      process.exitCode = code;
    });
}
