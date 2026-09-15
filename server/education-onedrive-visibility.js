/**
 * Finder hide/show for class todo and date folders on OneDrive.
 * Uses `chflags hidden` so names stay undotted (Cmd+Shift+. still reveals them).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  dateFolderShouldBeVisible,
  todoFolderShouldBeVisible,
} from "./education-class-todo.js";
import {
  findTodo,
  listClassEntriesForRoot,
  userEducationRoot,
} from "./education-data.js";
import { gradeDirFromMeta } from "./education-onedrive.js";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

const execFileAsync = promisify(execFile);


function isSafeObjectId(id) {
  const s = String(id || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return null;
  return s;
}

async function readJson(path) {
  try {
    const raw = await readFile(path, "utf8");
    const val = JSON.parse(raw);
    return val && typeof val === "object" ? val : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} absPath
 * @param {boolean} hidden
 */
export async function setFinderHidden(absPath, hidden) {
  if (process.platform !== "darwin") return;
  const flag = hidden ? "hidden" : "nohidden";
  await execFileAsync("chflags", [flag, absPath]);
}

async function listChildDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * @param {object} entry
 * @param {string} id
 * @param {"todo"|"date"} kind
 */
export function classObjectFolderCandidates(entry, id, kind) {
  const nested = kind === "todo" ? "todos" : "dates";
  const classFolder = entry.classFolder || entry.objectDir;
  /** @type {string[]} */
  const out = [];
  if (classFolder) out.push(join(classFolder, id));
  if (entry.objectDir) out.push(join(entry.objectDir, nested, id));
  return [...new Set(out)];
}

async function findDate(email, dateId, { classId = null } = {}) {
  const root = userEducationRoot(email);
  const id = isSafeObjectId(dateId);
  if (!id) return null;
  const scopedClass =
    classId == null || classId === "" ? null : isSafeObjectId(classId);
  if (classId != null && classId !== "" && !scopedClass) return null;

  /** @type {string[]} */
  const candidates = [];
  if (scopedClass) {
    const entry = (await listClassEntriesForRoot(root)).find(
      (e) => e.id === scopedClass
    );
    if (entry) {
      for (const folder of classObjectFolderCandidates(entry, id, "date")) {
        candidates.push(join(folder, "date.json"));
      }
    } else {
      candidates.push(join(root, "classes", scopedClass, "dates", id, "date.json"));
    }
  } else {
    candidates.push(join(root, "dates", id, "date.json"));
    for (const entry of await listClassEntriesForRoot(root)) {
      for (const folder of classObjectFolderCandidates(entry, id, "date")) {
        candidates.push(join(folder, "date.json"));
      }
    }
  }
  for (const path of candidates) {
    const props = await readJson(path);
    if (!props) continue;
    let resolvedClass = scopedClass;
    if (!resolvedClass) {
      const entries = await listClassEntriesForRoot(root);
      const hit = entries.find(
        (e) => path === e.objectDir || path.startsWith((e.classFolder || e.objectDir) + "/")
      );
      if (hit) resolvedClass = hit.id;
    }
    return { path, props, classId: resolvedClass };
  }
  return null;
}

async function stampRevealed(jsonPath, props) {
  if (props?.folderRevealedAt) return false;
  const next = { ...props, folderRevealedAt: new Date().toISOString() };
  await writeFile(jsonPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  return true;
}

/**
 * Poll of the open education screen (web route or iOS stack), not a click.
 * @param {string} email
 * @param {Record<string, unknown>} query
 */
export async function revealOpenEducationObject(email, query) {
  const view = String(query?.view || "").trim().toLowerCase();
  const todoId = String(query?.todoId || "").trim();
  const dateId = String(query?.dateId || "").trim();
  const classId = String(query?.classId || "").trim() || null;
  const projectId = String(query?.projectId || "").trim() || null;
  if (projectId) return false;
  if (view === "todo" || view === "capsule") {
    if (!todoId) return false;
    const found = await findTodo(email, todoId, { classId, projectId: null });
    if (!found?.classId) return false;
    return stampRevealed(found.path, found.props);
  }
  if (view === "date") {
    if (!dateId) return false;
    const found = await findDate(email, dateId, { classId });
    if (!found?.classId) return false;
    return stampRevealed(found.path, found.props);
  }
  return false;
}

async function syncClassFolder(entry, cls, schedule, now) {
  const classFolder = entry.classFolder || entry.objectDir;
  if (!classFolder) return;
  const nestedTodos = join(entry.objectDir, "todos");
  const nestedDates = join(entry.objectDir, "dates");
  const todoParents = [classFolder, nestedTodos];
  const dateParents = [classFolder, nestedDates];
  const seenTodos = new Set();
  const seenDates = new Set();

  for (const parent of todoParents) {
    for (const id of await listChildDirs(parent)) {
      if (seenTodos.has(id)) continue;
      const jsonPath = join(parent, id, "todo.json");
      const props = await readJson(jsonPath);
      if (!props) continue;
      seenTodos.add(id);
      const todo = { id, ...props };
      const visible = todoFolderShouldBeVisible(todo, cls, schedule, now);
      try {
        await setFinderHidden(join(parent, id), !visible);
      } catch (err) {
        console.error("[onedrive-visibility] todo", join(parent, id), err);
      }
    }
  }
  for (const parent of dateParents) {
    for (const id of await listChildDirs(parent)) {
      if (seenDates.has(id)) continue;
      const jsonPath = join(parent, id, "date.json");
      const props = await readJson(jsonPath);
      if (!props) continue;
      seenDates.add(id);
      const dateObj = { id, ...props };
      const visible = dateFolderShouldBeVisible(dateObj, schedule, now);
      try {
        await setFinderHidden(join(parent, id), !visible);
      } catch (err) {
        console.error("[onedrive-visibility] date", join(parent, id), err);
      }
    }
  }
}

/**
 * @param {string} [email]
 */
export async function syncOnedriveObjectVisibility(email = YAN_EMAIL) {
  if (canonicalizeEmail(email) !== YAN_EMAIL) return;
  const root = userEducationRoot(email);
  const meta = (await readJson(join(root, "meta.json"))) || {};
  const schedule = (await readJson(join(root, "schedule.json"))) || {};
  if (!gradeDirFromMeta(meta)) return;
  const now = new Date();
  for (const entry of await listClassEntriesForRoot(root)) {
    if (entry.source !== "onedrive") continue;
    const props = await readJson(join(entry.objectDir, "class.json"));
    if (!props) continue;
    const cls = { id: entry.id, ...props };
    await syncClassFolder(entry, cls, schedule, now);
  }
}
