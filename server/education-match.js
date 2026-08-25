/**
 * Fuzzy match for education dates/todos so nightly actions and chat agents
 * update an existing folder instead of minting a second slug.
 *
 *   node --test server/education-match.test.js
 */

import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFixture } from "./education-data.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_EDUCATION_EMAIL = "you@example.com";

const YEAR_RE = /\b20\d{2}(?:\s*[-/]\s*\d{2,4})?\b/g;
const STOP_TOKENS = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "at",
  "and",
  "or",
  "for",
  "with",
]);

export function defaultEducationRoot(email = DEFAULT_EDUCATION_EMAIL) {
  return join(REPO_ROOT, "education", email);
}

/**
 * Lowercase, strip year tokens, treat advisor/advisory as one word, singularize.
 * @param {unknown} name
 */
export function normalizeEducationName(name) {
  let s = String(name || "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/[''`]/g, "");
  s = s.replace(YEAR_RE, " ");
  s = s.replace(/\badvisory\b/g, "advisor");
  s = s.replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
  return s.split(" ").map(singularizeToken).filter(Boolean).join(" ");
}

function singularizeToken(tok) {
  if (tok.length < 4) return tok;
  if (tok.endsWith("ies") && tok.length > 4) return `${tok.slice(0, -3)}y`;
  if (tok.endsWith("sses")) return tok.slice(0, -2);
  if (/(?:s|x|z|ch|sh)es$/.test(tok) && tok.length > 4) {
    return tok.replace(/es$/, "");
  }
  if (tok.endsWith("s") && !tok.endsWith("ss") && !tok.endsWith("us")) {
    return tok.slice(0, -1);
  }
  return tok;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export function namesAreSimilar(a, b) {
  const na = normalizeEducationName(a);
  const nb = normalizeEducationName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [shorter, longer] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (shorter.length >= 10 && longer.includes(shorter)) return true;
  const ta = na.split(" ").filter(Boolean);
  const tb = nb.split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return false;
  const setB = new Set(tb);
  const overlap = ta.filter((t) => setB.has(t));
  return (
    overlap.length >= 2 &&
    (overlap.length === ta.length || overlap.length === tb.length)
  );
}

function significantTokens(name) {
  return normalizeEducationName(name)
    .split(" ")
    .filter((t) => t.length >= 4 && !STOP_TOKENS.has(t));
}

export function sharesSignificantToken(a, b) {
  const sa = new Set(significantTokens(a));
  if (!sa.size) return false;
  return significantTokens(b).some((t) => sa.has(t));
}

function normDay(value) {
  const s = String(value || "").trim();
  return s || "";
}

function normTime(value) {
  const s = String(value || "").trim();
  return s || "";
}

function sameParent(a, b) {
  return String(a?.parent || "") === String(b?.parent || "");
}

/**
 * @param {{ parent?: string, date?: string, name?: string, time?: string }} existing
 * @param {{ parent?: string, date?: string, name?: string, time?: string }} candidate
 */
export function isSameEducationDate(existing, candidate) {
  if (!sameParent(existing, candidate)) return false;
  if (!normDay(existing?.date) || normDay(existing.date) !== normDay(candidate?.date)) {
    return false;
  }
  if (namesAreSimilar(existing?.name, candidate?.name)) return true;
  const t1 = normTime(existing?.time);
  const t2 = normTime(candidate?.time);
  return Boolean(t1 && t1 === t2 && sharesSignificantToken(existing?.name, candidate?.name));
}

/**
 * @param {{ parent?: string, dueDate?: string, name?: string, dueTime?: string }} existing
 * @param {{ parent?: string, dueDate?: string, name?: string, dueTime?: string }} candidate
 */
export function isSameEducationTodo(existing, candidate) {
  if (!sameParent(existing, candidate)) return false;
  if (normDay(existing?.dueDate) !== normDay(candidate?.dueDate)) return false;
  if (namesAreSimilar(existing?.name, candidate?.name)) return true;
  const t1 = normTime(existing?.dueTime);
  const t2 = normTime(candidate?.dueTime);
  return Boolean(t1 && t1 === t2 && sharesSignificantToken(existing?.name, candidate?.name));
}

/**
 * @template T
 * @param {T} candidate
 * @param {T[]} existing
 * @param {(a: T, b: T) => boolean} same
 * @returns {T|null}
 */
export function findMatch(candidate, existing, same) {
  const list = Array.isArray(existing) ? existing : [];
  return list.find((row) => same(row, candidate)) || null;
}

export function findMatchingDate(candidate, existing) {
  return findMatch(candidate, existing, isSameEducationDate);
}

export function findMatchingTodo(candidate, existing) {
  return findMatch(candidate, existing, isSameEducationTodo);
}

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          !e.name.startsWith(".") &&
          !e.name.startsWith("_example")
      )
      .map((e) => e.name);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} parentDir
 * @param {string} fileName
 * @param {string} parent
 * @param {string} pathPrefix
 */
async function loadObjects(parentDir, fileName, parent, pathPrefix) {
  const ids = await listDirs(parentDir);
  /** @type {object[]} */
  const out = [];
  for (const id of ids) {
    const props = await readJson(join(parentDir, id, fileName));
    if (!props || typeof props !== "object") continue;
    const item = { id, ...props };
    if (isFixture(item) || isFixture({ id })) continue;
    out.push({
      id,
      name: String(props.name || id),
      parent,
      path: `${pathPrefix}/${id}`,
      date: typeof props.date === "string" ? props.date : "",
      time: typeof props.time === "string" ? props.time : "",
      dueDate: typeof props.dueDate === "string" ? props.dueDate : "",
      dueTime: typeof props.dueTime === "string" ? props.dueTime : "",
      done: props.done === true,
    });
  }
  return out;
}

function compareByDayThenPath(a, b, dayKey) {
  const da = normDay(a[dayKey]) || "9999-99-99";
  const db = normDay(b[dayKey]) || "9999-99-99";
  if (da !== db) return da.localeCompare(db);
  return String(a.path).localeCompare(String(b.path));
}

function formatLine(row, dayKey, timeKey) {
  const day = normDay(row[dayKey]) || "undated";
  const time = normTime(row[timeKey]) || "--";
  return `${day} ${time} "${row.name}" ${row.parent} ${row.path}`;
}

/**
 * Compact prompt block of existing non-fixture dates and open todos.
 * @param {string} [userRoot]
 */
export async function loadEducationActionIndex(userRoot = defaultEducationRoot()) {
  const dates = [
    ...(await loadObjects(join(userRoot, "dates"), "date.json", "user-level", "dates")),
  ];
  const todos = [
    ...(await loadObjects(join(userRoot, "todos"), "todo.json", "user-level", "todos")),
  ];

  for (const classId of await listDirs(join(userRoot, "classes"))) {
    const parent = `class:${classId}`;
    dates.push(
      ...(await loadObjects(
        join(userRoot, "classes", classId, "dates"),
        "date.json",
        parent,
        `classes/${classId}/dates`
      ))
    );
    todos.push(
      ...(await loadObjects(
        join(userRoot, "classes", classId, "todos"),
        "todo.json",
        parent,
        `classes/${classId}/todos`
      ))
    );
  }

  for (const projectId of await listDirs(join(userRoot, "projects"))) {
    const parent = `project:${projectId}`;
    dates.push(
      ...(await loadObjects(
        join(userRoot, "projects", projectId, "dates"),
        "date.json",
        parent,
        `projects/${projectId}/dates`
      ))
    );
    todos.push(
      ...(await loadObjects(
        join(userRoot, "projects", projectId, "todos"),
        "todo.json",
        parent,
        `projects/${projectId}/todos`
      ))
    );
  }

  dates.sort((a, b) => compareByDayThenPath(a, b, "date"));
  const openTodos = todos
    .filter((t) => !t.done)
    .sort((a, b) => compareByDayThenPath(a, b, "dueDate"));

  return {
    dates,
    todos: openTodos,
    text: formatEducationActionIndex(dates, openTodos),
  };
}

/**
 * @param {object[]} dates
 * @param {object[]} todos
 */
export function formatEducationActionIndex(dates, todos) {
  const dateLines = (dates || []).map((row) => `- ${formatLine(row, "date", "time")}`);
  const todoLines = (todos || []).map((row) => `- ${formatLine(row, "dueDate", "dueTime")}`);
  return [
    "Existing education dates (fixtures omitted). Same parent + date + similar name means UPDATE that folder, never a new slug.",
    dateLines.length ? dateLines.join("\n") : "None",
    "Open education todos (done=false). Same parent + dueDate + similar name means UPDATE, never invent (2) unless Yan asked for a second copy.",
    todoLines.length ? todoLines.join("\n") : "None",
  ].join("\n");
}
