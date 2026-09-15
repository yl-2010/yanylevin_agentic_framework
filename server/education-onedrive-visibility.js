/**
 * Finder hide/show and Finder names for class todo and date folders on OneDrive.
 * Hide by renaming to a leading-dot folder. OneDrive syncs the name;
 * macOS `chflags hidden` stays on one Mac and also stalls the client.
 * Visible names look like `HW Sep 15 Assignment Name` (spaces, due date for
 * todos). Web and iOS still use JSON `name` + `tag`.
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
  classObjectFinderName,
  gradeDirFromMeta,
  objectDirId,
  objectFolderPaths,
  uniqueFinderFolderName,
} from "./education-onedrive.js";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";

const execFileAsync = promisify(execFile);


const PROGRAM_FILE_NAMES = new Set([
  "todo.json",
  "date.json",
  "class.json",
  "project.json",
  "meta.json",
  "schedule.json",
  "context.md",
  "deleted.md",
]);

function isJunkFsName(name) {
  const s = String(name || "");
  if (!s || s.startsWith(".")) return true;
  if (s === "Icon" || s.startsWith("Icon\r")) return true;
  return false;
}

/**
 * True when the folder has a dropped/user/agent file besides property JSON.
 * @param {string} dir
 */
export async function objectFolderHasUserFiles(dir, depth = 0) {
  if (depth > 8) return false;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return false;
    throw err;
  }
  for (const entry of entries) {
    if (isJunkFsName(entry.name)) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await objectFolderHasUserFiles(abs, depth + 1)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    if (PROGRAM_FILE_NAMES.has(String(entry.name).toLowerCase())) continue;
    return true;
  }
  return false;
}

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

/**
 * Rename a todo/date folder, keeping the leading-dot hide state.
 * Case-only changes go through a temp name so APFS accepts them.
 * @param {string} parent
 * @param {string} fromId
 * @param {string} toId
 * @returns {Promise<string|null>} resulting id (no leading dot)
 */
export async function renameObjectFolder(parent, fromId, toId) {
  const fromClean = objectDirId(fromId);
  const toClean = objectDirId(toId);
  if (!parent || !fromClean || !toClean) return fromClean || null;
  if (fromClean === toClean) return fromClean;

  const [fromVis, fromHid] = objectFolderPaths(parent, fromClean);
  const [toVis, toHid] = objectFolderPaths(parent, toClean);
  const vis = await dirExists(fromVis);
  const hid = await dirExists(fromHid);
  if (!vis && !hid) return fromClean;

  const hidden = hid && !vis;
  const fromPath = hidden ? fromHid : fromVis;
  const toPath = hidden ? toHid : toVis;
  const caseOnly = fromClean.toLowerCase() === toClean.toLowerCase();
  if (!caseOnly) {
    if ((await dirExists(toVis)) || (await dirExists(toHid))) return fromClean;
  }

  if (caseOnly) {
    const tmpPath = join(parent, `.__yan_rename_${process.hrtime.bigint()}__`);
    await rename(fromPath, tmpPath);
    await rename(tmpPath, toPath);
  } else {
    await rename(fromPath, toPath);
  }
  await clearFinderHiddenFlag(toPath);
  return toClean;
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

async function syncKind(
  parent,
  kind,
  cls,
  schedule,
  now,
  seen,
  { renameFinder = false } = {}
) {
  const fileName = kind === "todo" ? "todo.json" : "date.json";
  const names = await listChildDirs(parent);
  const occupied = new Set();
  for (const name of names) {
    const oid = objectDirId(name);
    if (oid) occupied.add(oid);
  }
  for (const name of names) {
    let id = objectDirId(name);
    if (!id || seen.has(id)) continue;
    const jsonPath = join(parent, name, fileName);
    const props = await readJson(jsonPath);
    if (!props) continue;
    if (renameFinder) {
      const desired = uniqueFinderFolderName(
        classObjectFinderName(kind, props),
        occupied,
        id
      );
      if (desired !== id) {
        try {
          const next = await renameObjectFolder(parent, id, desired);
          if (next && next !== id) {
            occupied.delete(id);
            occupied.add(next);
            id = next;
          }
        } catch (err) {
          console.error("[onedrive-visibility] rename", kind, name, err);
        }
      }
    }
    seen.add(id);
    const obj = { id, ...props };
    const [visPath, hidPath] = objectFolderPaths(parent, id);
    const folderPath = (await dirExists(visPath)) ? visPath : hidPath;
    const hasUserFiles = await objectFolderHasUserFiles(folderPath);
    const visible =
      kind === "todo"
        ? todoFolderShouldBeVisible(obj, cls, schedule, now, { hasUserFiles })
        : dateFolderShouldBeVisible(obj, schedule, now, { hasUserFiles });
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
  await syncKind(classFolder, "todo", cls, schedule, now, seenTodos, {
    renameFinder: true,
  });
  await syncKind(nestedTodos, "todo", cls, schedule, now, seenTodos);
  await syncKind(classFolder, "date", cls, schedule, now, seenDates, {
    renameFinder: true,
  });
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
