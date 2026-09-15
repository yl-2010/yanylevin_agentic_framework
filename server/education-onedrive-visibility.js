/**
 * Finder hide/show for class todo and date folders on OneDrive.
 * Hide by renaming to a leading-dot folder. OneDrive syncs the name;
 * macOS `chflags hidden` stays on one Mac and also stalls the client.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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
import {
  gradeDirFromMeta,
  objectDirId,
  objectFolderPaths,
} from "./education-onedrive.js";
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

async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function clearFinderHiddenFlag(absPath) {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("chflags", ["nohidden", absPath]);
  } catch {
    /* leftover flag is best-effort */
  }
}

/**
 * Hide with `.id`, show as `id`. Clears leftover chflags so OneDrive can sync.
 * @param {string} parent
 * @param {string} id
 * @param {boolean} hidden
 * @returns {Promise<string|null>} resulting folder path
 */
export async function setObjectFolderHidden(parent, id, hidden) {
  const paths = objectFolderPaths(parent, id);
  if (paths.length < 2) return null;
  const [visiblePath, hiddenPath] = paths;
  const vis = await dirExists(visiblePath);
  const hid = await dirExists(hiddenPath);
  if (hidden) {
    if (hid && !vis) {
      await clearFinderHiddenFlag(hiddenPath);
      return hiddenPath;
    }
    if (vis && hid) {
      await clearFinderHiddenFlag(visiblePath);
      await clearFinderHiddenFlag(hiddenPath);
      return hiddenPath;
    }
    if (vis) {
      await clearFinderHiddenFlag(visiblePath);
      await rename(visiblePath, hiddenPath);
      await clearFinderHiddenFlag(hiddenPath);
      return hiddenPath;
    }
    return null;
  }
  if (vis && !hid) {
    await clearFinderHiddenFlag(visiblePath);
    return visiblePath;
  }
  if (vis && hid) {
    await clearFinderHiddenFlag(visiblePath);
    await clearFinderHiddenFlag(hiddenPath);
    return visiblePath;
  }
  if (hid) {
    await clearFinderHiddenFlag(hiddenPath);
    await rename(hiddenPath, visiblePath);
    await clearFinderHiddenFlag(visiblePath);
    return visiblePath;
  }
  return null;
}

async function listChildDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && e.name).map((e) => e.name);
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
  if (classFolder) out.push(...objectFolderPaths(classFolder, id));
  if (entry.objectDir) {
    out.push(...objectFolderPaths(join(entry.objectDir, nested), id));
  }
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
        (e) =>
          path === e.objectDir ||
          path.startsWith((e.classFolder || e.objectDir) + "/")
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

async function syncKind(parent, kind, cls, schedule, now, seen) {
  const fileName = kind === "todo" ? "todo.json" : "date.json";
  for (const name of await listChildDirs(parent)) {
    const id = objectDirId(name);
    if (!id || seen.has(id)) continue;
    const jsonPath = join(parent, name, fileName);
    const props = await readJson(jsonPath);
    if (!props) continue;
    seen.add(id);
    const obj = { id, ...props };
    const visible =
      kind === "todo"
        ? todoFolderShouldBeVisible(obj, cls, schedule, now)
        : dateFolderShouldBeVisible(obj, schedule, now);
    try {
      await setObjectFolderHidden(parent, id, !visible);
    } catch (err) {
      console.error("[onedrive-visibility]", kind, join(parent, name), err);
    }
  }
}

async function syncClassFolder(entry, cls, schedule, now) {
  const classFolder = entry.classFolder || entry.objectDir;
  if (!classFolder) return;
  const nestedTodos = join(entry.objectDir, "todos");
  const nestedDates = join(entry.objectDir, "dates");
  const seenTodos = new Set();
  const seenDates = new Set();
  await syncKind(classFolder, "todo", cls, schedule, now, seenTodos);
  await syncKind(nestedTodos, "todo", cls, schedule, now, seenTodos);
  await syncKind(classFolder, "date", cls, schedule, now, seenDates);
  await syncKind(nestedDates, "date", cls, schedule, now, seenDates);
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
