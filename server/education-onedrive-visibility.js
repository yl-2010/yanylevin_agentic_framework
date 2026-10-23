/**
 * Finder hide/show and Finder names for class todo and date folders on OneDrive.
 * Hide by renaming to a leading-dot folder. OneDrive syncs the name;
 * macOS `chflags hidden` stays on one Mac and also stalls the client.
 * Visible names look like `HW Sep 15 Assignment Name` (spaces, due date for
 * todos). Web and iOS still use JSON `name` + `tag`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  dateFolderShouldBeVisible,
  todoFolderShouldBeVisible,
} from "./education-class-todo.js";
import {
  assignmentLooksComplete,
  todoCanvasAssignmentId,
} from "./canvas-grades.js";
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
  resolveBookkeepingFile,
  uniqueFinderFolderName,
} from "./education-onedrive.js";
import { canonicalizeEmail, OWNER_EMAIL as YAN_EMAIL } from "./identity.js";
import { isTransientCloudError, withCloudRetry } from "./cloud-storage-io.js";

function cloudReaddir(dir) {
  return withCloudRetry(dir, () => readdir(dir, { withFileTypes: true }));
}

function cloudStat(path) {
  return withCloudRetry(path, () => stat(path));
}

function cloudReadFile(path) {
  return withCloudRetry(path, () => readFile(path, "utf8"));
}

function cloudRename(from, to) {
  return withCloudRetry(from, () => rename(from, to));
}

function cloudRm(path, opts) {
  return withCloudRetry(path, () => rm(path, opts));
}

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
 * True when the folder has a file Yan put there, or a file an agent put
 * there because Yan asked. Canvas downloads passed in `ignoreNames` do not
 * count. Property JSON and markdown bookkeeping do not count.
 * @param {string} dir
 * @param {number} [depth]
 * @param {Set<string>|null} [ignoreNames] lowercase basenames
 */
export async function objectFolderHasUserFiles(dir, depth = 0, ignoreNames = null) {
  if (depth > 8) return false;
  let entries;
  try {
    entries = await cloudReaddir(dir);
  } catch (err) {
    if (err?.code === "ENOENT" || isTransientCloudError(err)) return false;
    throw err;
  }
  for (const entry of entries) {
    if (isJunkFsName(entry.name)) continue;
    if (ignoreNames?.has(String(entry.name).toLowerCase())) continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await objectFolderHasUserFiles(abs, depth + 1, ignoreNames)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    if (PROGRAM_FILE_NAMES.has(String(entry.name).toLowerCase())) continue;
    return true;
  }
  return false;
}

const BOOKKEEPING_HIDES = [
  ["todo.json", ".todo.json"],
  ["date.json", ".date.json"],
  ["CONTEXT.md", ".CONTEXT.md"],
  ["context.md", ".CONTEXT.md"],
  ["deleted.md", ".deleted.md"],
];

async function fileExists(path) {
  try {
    const st = await cloudStat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/**
 * Rename OneDrive bookkeeping to a leading-dot name so Finder hides it.
 * A newer plain file replaces the dotted one. The dotted file wins otherwise.
 * @param {string} dir
 */
export async function hideBookkeepingFiles(dir) {
  for (const [from, to] of BOOKKEEPING_HIDES) {
    const src = join(dir, from);
    const dest = join(dir, to);
    const srcOk = await fileExists(src);
    if (!srcOk) continue;
    const destOk = await fileExists(dest);
    if (!destOk) {
      await cloudRename(src, dest);
      continue;
    }
    if (src === dest) continue;
    const srcStat = await cloudStat(src);
    const destStat = await cloudStat(dest);
    if (srcStat.mtimeMs >= destStat.mtimeMs) {
      await cloudRm(dest, { force: true });
      await cloudRename(src, dest);
    } else {
      await cloudRm(src, { force: true });
    }
  }
}

/**
 * Finder uses the same completion signal as the dashboard overlay.
 * Does not write `done` back to the file.
 * @param {object} todo
 * @param {Map<number, object>} byId
 */
export function finderTodoFromCanvas(todo, byId) {
  if (!todo) return todo;
  const id = todoCanvasAssignmentId(todo);
  if (id == null) return todo;
  const row = byId instanceof Map ? byId.get(id) : null;
  if (!assignmentLooksComplete(row)) return todo;
  const next = { ...todo, done: true };
  if (!next.completedAt && row?.submittedAt) next.completedAt = row.submittedAt;
  return next;
}

async function canvasCompleteById() {
  try {
    const { getLiveCanvasSnapshot } = await import("./canvas-sync.js");
    const snap = await getLiveCanvasSnapshot();
    const map = new Map();
    for (const row of snap?.assignments || []) {
      const id = Number(row?.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      if (assignmentLooksComplete(row)) map.set(id, row);
    }
    return map;
  } catch (err) {
    console.error("[onedrive-visibility] canvas", err);
    return new Map();
  }
}

function canvasFileNameSet(props) {
  const out = new Set();
  const rows = Array.isArray(props?.canvasFiles) ? props.canvasFiles : [];
  for (const row of rows) {
    const name = String(row?.name || "").trim().toLowerCase();
    if (name) out.add(name);
  }
  return out;
}

function isSafeObjectId(id) {
  const s = String(id || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return null;
  return s;
}

async function readJson(path) {
  try {
    const raw = await cloudReadFile(path);
    const val = JSON.parse(raw);
    return val && typeof val === "object" ? val : null;
  } catch {
    return null;
  }
}

async function dirExists(path) {
  try {
    const st = await cloudStat(path);
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
 * OneDrive sometimes keeps both the plain name and the dotted name.
 * Move anything only in `fromDir` into `intoDir`, then remove `fromDir`.
 * @param {string} fromDir
 * @param {string} intoDir
 */
async function absorbDuplicateFolder(fromDir, intoDir) {
  const entries = await cloudReaddir(fromDir);
  for (const entry of entries) {
    const src = join(fromDir, entry.name);
    const dest = join(intoDir, entry.name);
    let destExists = false;
    try {
      await cloudStat(dest);
      destExists = true;
    } catch {
      destExists = false;
    }
    if (!destExists) {
      await cloudRename(src, dest);
      continue;
    }
    const srcSt = await cloudStat(src);
    const destSt = await cloudStat(dest);
    if (srcSt.mtimeMs > destSt.mtimeMs) {
      await cloudRm(dest, { recursive: true, force: true });
      await cloudRename(src, dest);
    }
  }
  await cloudRm(fromDir, { recursive: true, force: true });
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
      await absorbDuplicateFolder(visiblePath, hiddenPath);
      await clearFinderHiddenFlag(hiddenPath);
      return hiddenPath;
    }
    if (vis) {
      await clearFinderHiddenFlag(visiblePath);
      await cloudRename(visiblePath, hiddenPath);
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
    await absorbDuplicateFolder(hiddenPath, visiblePath);
    await clearFinderHiddenFlag(visiblePath);
    return visiblePath;
  }
  if (hid) {
    await clearFinderHiddenFlag(hiddenPath);
    await cloudRename(hiddenPath, visiblePath);
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
    await cloudRename(fromPath, tmpPath);
    await cloudRename(tmpPath, toPath);
  } else {
    await cloudRename(fromPath, toPath);
  }
  await clearFinderHiddenFlag(toPath);
  return toClean;
}

async function listChildDirs(dir) {
  try {
    const entries = await cloudReaddir(dir);
    return entries.filter((e) => e.isDirectory() && e.name).map((e) => e.name);
  } catch (err) {
    if (err?.code === "ENOENT" || isTransientCloudError(err)) return [];
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
    const resolved = await resolveBookkeepingFile(dirname(path), basename(path));
    const props = resolved ? await readJson(resolved) : null;
    if (!props) continue;
    let resolvedClass = scopedClass;
    if (!resolvedClass) {
      const entries = await listClassEntriesForRoot(root);
      const hit = entries.find(
        (e) =>
          resolved === e.objectDir ||
          resolved.startsWith((e.classFolder || e.objectDir) + "/")
      );
      if (hit) resolvedClass = hit.id;
    }
    return { path: resolved, props, classId: resolvedClass };
  }
  return null;
}

async function stampRevealed(jsonPath, props) {
  if (props?.folderRevealedAt) return false;
  const next = { ...props, folderRevealedAt: new Date().toISOString() };
  await withCloudRetry(jsonPath, () =>
    writeFile(jsonPath, JSON.stringify(next, null, 2) + "\n", "utf8")
  );
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
  canvasById,
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
    const folder = join(parent, name);
    try {
      await hideBookkeepingFiles(folder);
    } catch (err) {
      console.error("[onedrive-visibility] hide bookkeeping", folder, err);
    }
    const jsonPath = await resolveBookkeepingFile(folder, fileName);
    const props = jsonPath ? await readJson(jsonPath) : null;
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
    const obj =
      kind === "todo"
        ? finderTodoFromCanvas({ id, ...props }, canvasById)
        : { id, ...props };
    const [visPath, hidPath] = objectFolderPaths(parent, id);
    const folderPath = (await dirExists(visPath)) ? visPath : hidPath;
    const hasUserFiles = await objectFolderHasUserFiles(
      folderPath,
      0,
      canvasFileNameSet(props)
    );
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

async function syncClassFolder(entry, cls, schedule, now, canvasById) {
  const classFolder = entry.classFolder || entry.objectDir;
  if (!classFolder) return;
  const metaDir = join(classFolder, ".education");
  try {
    await hideBookkeepingFiles(metaDir);
  } catch (err) {
    console.error("[onedrive-visibility] hide bookkeeping", metaDir, err);
  }
  const nestedTodos = join(entry.objectDir, "todos");
  const nestedDates = join(entry.objectDir, "dates");
  const seenTodos = new Set();
  const seenDates = new Set();
  await syncKind(classFolder, "todo", cls, schedule, now, seenTodos, canvasById, {
    renameFinder: true,
  });
  await syncKind(nestedTodos, "todo", cls, schedule, now, seenTodos, canvasById);
  await syncKind(classFolder, "date", cls, schedule, now, seenDates, canvasById, {
    renameFinder: true,
  });
  await syncKind(nestedDates, "date", cls, schedule, now, seenDates, canvasById);
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
  const canvasById = await canvasCompleteById();
  for (const entry of await listClassEntriesForRoot(root)) {
    if (entry.source !== "onedrive") continue;
    const props = await readJson(join(entry.objectDir, "class.json"));
    if (!props) continue;
    const cls = { id: entry.id, ...props };
    await syncClassFolder(entry, cls, schedule, now, canvasById);
  }
}
