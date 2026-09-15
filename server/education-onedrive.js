/**
 * School OneDrive class folders (Mac CloudStorage path in meta.json).
 * Dashboard class file tiles list these live; bytes stay in OneDrive.
 */

import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

const PROPERTY_JSON = new Set([
  "class.json",
  "project.json",
  "todo.json",
  "date.json",
  "meta.json",
  "schedule.json",
]);

/**
 * Same basename rules as education object files (no traversal, no property JSON).
 * @param {unknown} name
 * @returns {string|null}
 */
function isSafeEntryName(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === "..") return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
  if (s.startsWith(".")) return null;
  if (PROPERTY_JSON.has(s.toLowerCase())) return null;
  return s;
}

const PERIOD_PREFIX = /^[A-Ha-h]\.\s*/;
const MAX_DEPTH = 8;
const MATCH_MIN_SCORE = 55;
const DEFAULT_UI_HIDDEN_FILES = new Set(["context.md", "deleted.md"]);

const NAME_ALIASES = [
  [/\bunited states\b/g, "us"],
  [/\bscience\b/g, "sci"],
  [/\bcalculus\b/g, "calc"],
  [/\bliterature\b/g, "lit"],
  [/\bp\.?\s*e\.?\b/g, "pe"],
];

/**
 * Absolute grade folder from meta.json, or null when unset.
 * @param {object|null|undefined} meta
 * @returns {string|null}
 */
export function gradeDirFromMeta(meta) {
  const root = String(meta?.onedriveRoot || "").trim();
  const grade = String(meta?.gradeFolder || "").trim();
  if (!root || !grade) return null;
  if (grade.includes("..") || grade.includes("/") || grade.includes("\\")) {
    return null;
  }
  return join(root, grade);
}

/**
 * Hidden Finder folder that holds class.json, CONTEXT.md, todos, and dates.
 */
export const EDUCATION_META_DIR = ".education";

const RESERVED_CLASS_ROOT_DIRS = new Set(["todos", "dates"]);

/**
 * Object folder id from a class-root directory name.
 * Hidden todos/dates use a leading-dot name so OneDrive syncs Finder hide.
 * `.education` is not an object folder.
 * @param {unknown} name
 * @returns {string|null}
 */
export function objectDirId(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === ".." || s === EDUCATION_META_DIR) return null;
  if (s === ".Trash" || s.startsWith("._")) return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
  if (s.startsWith(".")) {
    const id = s.slice(1);
    if (!id || id.startsWith(".") || id.includes("..")) return null;
    return id;
  }
  if (s.includes("..")) return null;
  return s;
}

/**
 * Visible then hidden folder paths for a class todo/date id.
 * @param {string} parent
 * @param {string} id
 * @returns {string[]}
 */
export function objectFolderPaths(parent, id) {
  const clean = objectDirId(id) || objectDirId(String(id || "").replace(/^\./, ""));
  if (!parent || !clean) return [];
  return [join(parent, clean), join(parent, `.${clean}`)];
}

/**
 * Dashboard object tree inside a class OneDrive folder (`class.json`, todos, dates).
 * Hidden in Finder until Cmd+Shift+.
 * @param {string} gradeDir
 * @param {string} onedriveFolder
 */
export function classObjectDir(gradeDir, onedriveFolder) {
  return join(gradeDir, onedriveFolder, EDUCATION_META_DIR);
}

/**
 * `.education` plus nested `.education/<classId>` for extra classes that share
 * the same visible OneDrive folder (History / Lit winter-spring shells).
 * @param {string} gradeDir
 * @param {string} onedriveFolder
 * @returns {Promise<string[]>}
 */
export async function listClassObjectDirs(gradeDir, onedriveFolder) {
  const metaDir = classObjectDir(gradeDir, onedriveFolder);
  /** @type {string[]} */
  const dirs = [metaDir];
  let entries;
  try {
    entries = await readdir(metaDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = String(entry.name || "");
    if (!name || name.startsWith(".")) continue;
    if (RESERVED_CLASS_ROOT_DIRS.has(name.toLowerCase())) continue;
    dirs.push(join(metaDir, name));
  }
  return dirs;
}

/**
 * Finder-hidden OneDrive folder name for a class that does not already have one.
 * @param {object|null|undefined} cls
 * @param {string} classId
 */
export function hiddenOnedriveFolderName(cls, classId) {
  const id = String(classId || "").trim();
  if (cls?.freePeriod === true) {
    const letter = String(cls.period || id.replace(/^free-period-/i, ""))
      .trim()
      .toUpperCase()
      .slice(0, 1);
    return letter ? `.Free Period ${letter}` : `.Free Period`;
  }
  if (id === "advanced-programming-ai-ml") return ".Advanced Programming AI-ML";
  if (id === "advanced-programming-emergent-topics") {
    return ".Advanced Programming Emergent Topics";
  }
  const name = String(cls?.name || id).trim() || id;
  return `.${name}`;
}

export function normalizeClassFolderName(name) {
  let t = String(name || "").toLowerCase();
  t = t.replace(/^\.+/, "");
  t = t.replace(PERIOD_PREFIX, "");
  t = t.replace(/&/g, " and ");
  for (const [re, to] of NAME_ALIASES) t = t.replace(re, to);
  t = t.replace(/[^a-z0-9]+/g, " ").trim();
  return t;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function onedriveNameScore(a, b) {
  const left = normalizeClassFolderName(a);
  const right = normalizeClassFolderName(b);
  if (!left || !right) return 0;
  if (left === right) return 100;
  if (left.includes(right) || right.includes(left)) return 80;
  const ta = new Set(left.split(/\s+/).filter(Boolean));
  const tb = new Set(right.split(/\s+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const tok of tb) if (ta.has(tok)) inter++;
  const recall = inter / tb.size;
  const precision = inter / ta.size;
  if (recall < 0.8) return 0;
  return Math.round(60 * recall + 20 * precision);
}

/**
 * Pick the OneDrive class folder basename for a class.
 * `class.json` `onedriveFolder` wins when that folder exists.
 * @param {object|null|undefined} cls
 * @param {string[]} folderNames
 * @returns {string|null}
 */
export function matchOnedriveFolder(cls, folderNames) {
  const names = Array.isArray(folderNames) ? folderNames.filter(Boolean) : [];
  if (!names.length || !cls || typeof cls !== "object") return null;

  const explicit = String(cls.onedriveFolder || "").trim();
  if (explicit && names.includes(explicit)) return explicit;
  if (cls.freePeriod === true) return null;

  const label = String(cls.name || "").trim();
  if (!label) return null;

  /** @type {{ name: string, score: number }[]} */
  const ranked = names
    .map((name) => ({ name, score: onedriveNameScore(label, name) }))
    .filter((row) => row.score >= MATCH_MIN_SCORE)
    .sort(
      (a, b) => b.score - a.score || a.name.localeCompare(b.name, "en")
    );
  return ranked[0]?.name || null;
}

/**
 * Relative path inside a class OneDrive folder (nested files).
 * @param {unknown} raw
 * @returns {string|null}
 */
export function isSafeRelativePath(raw) {
  const s = String(raw || "").trim();
  if (!s || s.length > 1024) return null;
  if (s.includes("\0") || s.includes("\\") || s.startsWith("/")) return null;
  const parts = s.split("/").filter((p) => p !== "");
  if (!parts.length || parts.length > MAX_DEPTH) return null;
  for (const part of parts) {
    if (!isSafeEntryName(part)) return null;
  }
  return parts.join("/");
}

/**
 * @param {string} name
 * @returns {boolean}
 */
function isIgnorableFsName(name) {
  const s = String(name || "");
  if (!s || s.startsWith(".")) return true;
  if (s === "Icon" || s.startsWith("Icon\r")) return true;
  return false;
}

async function dirHasPropertyJson(abs) {
  for (const name of ["todo.json", "date.json"]) {
    try {
      const st = await stat(join(abs, name));
      if (st.isFile()) return true;
    } catch {
      /* missing */
    }
  }
  return false;
}

/**
 * @param {string} gradeDir
 * @returns {Promise<string[]>}
 */
export async function listOnedriveFolderNames(gradeDir, { includeHidden = false } = {}) {
  if (!gradeDir) return [];
  try {
    const entries = await readdir(gradeDir, { withFileTypes: true });
    return entries
      .filter((e) => {
        if (!e.isDirectory()) return false;
        if (e.name === ".Trash") return false;
        if (!includeHidden && isIgnorableFsName(e.name)) return false;
        return true;
      })
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, "en"));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * @param {string} name
 * @param {Set<string>} hiddenSet
 * @param {Set<string>} visibleSet
 */
function isHiddenName(name, hiddenSet, visibleSet) {
  const key = String(name || "").toLowerCase();
  if (visibleSet.has(key)) return false;
  return hiddenSet.has(key);
}

/**
 * Recursive file/folder list for one class OneDrive folder.
 * @param {string} dir
 * @param {{
 *   relPrefix?: string,
 *   depth?: number,
 *   hiddenNames?: Set<string>|string[],
 *   visibleNames?: Set<string>|string[],
 * }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listOnedriveTree(dir, opts = {}) {
  const relPrefix = String(opts.relPrefix || "");
  const depth = Number(opts.depth) || 0;
  if (depth > MAX_DEPTH) return [];

  /** @type {Set<string>} */
  const hiddenSet = new Set();
  /** @type {Set<string>} */
  const visibleSet = new Set();
  const hiddenIn = opts.hiddenNames;
  const visibleIn = opts.visibleNames;
  if (hiddenIn instanceof Set) {
    for (const n of hiddenIn) hiddenSet.add(String(n).toLowerCase());
  } else if (Array.isArray(hiddenIn)) {
    for (const n of hiddenIn) hiddenSet.add(String(n).toLowerCase());
  }
  if (visibleIn instanceof Set) {
    for (const n of visibleIn) visibleSet.add(String(n).toLowerCase());
  } else if (Array.isArray(visibleIn)) {
    for (const n of visibleIn) visibleSet.add(String(n).toLowerCase());
  }
  for (const n of DEFAULT_UI_HIDDEN_FILES) {
    if (!visibleSet.has(n)) hiddenSet.add(n);
  }
  for (const n of visibleSet) hiddenSet.delete(n);

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }

  /** @type {{ name: string, size?: number, mtime: string, mtimeMs: number, kind: string, source: string, path: string, files?: object[] }[]} */
  const out = [];
  for (const entry of entries) {
    if (isIgnorableFsName(entry.name)) continue;
    if (
      depth === 0 &&
      RESERVED_CLASS_ROOT_DIRS.has(String(entry.name || "").toLowerCase())
    ) {
      continue;
    }
    const safe = isSafeEntryName(entry.name);
    if (!safe) continue;
    if (isHiddenName(entry.name, hiddenSet, visibleSet)) continue;
    const abs = join(dir, entry.name);
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    try {
      const st = await stat(abs);
      const mtimeMs = st.mtimeMs;
      const mtime = new Date(mtimeMs).toISOString();
      if (entry.isDirectory() || st.isDirectory()) {
        if (await dirHasPropertyJson(abs)) continue;
        const files = await listOnedriveTree(abs, {
          relPrefix: rel,
          depth: depth + 1,
          hiddenNames: hiddenSet,
          visibleNames: visibleSet,
        });
        out.push({
          name: entry.name,
          kind: "folder",
          source: "onedrive",
          path: rel,
          size: 0,
          mtime,
          mtimeMs,
          files,
        });
        continue;
      }
      if (!entry.isFile() && !st.isFile()) continue;
      out.push({
        name: entry.name,
        kind: "file",
        source: "onedrive",
        path: rel,
        size: st.size,
        mtime,
        mtimeMs,
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return out.map(({ mtimeMs, ...rest }) => rest);
}

/**
 * Education files first (same name wins over OneDrive), then OneDrive.
 * Incoming education rows keep their order; OneDrive rows append unless
 * their basename already exists. Caller should pin after merge.
 * @param {object[]} educationFiles
 * @param {object[]} onedriveFiles
 * @returns {object[]}
 */
export function mergeContextFileLists(educationFiles, onedriveFiles) {
  const edu = Array.isArray(educationFiles) ? educationFiles : [];
  const drive = Array.isArray(onedriveFiles) ? onedriveFiles : [];
  const used = new Set(
    edu.map((f) => String(f?.name || "").toLowerCase()).filter(Boolean)
  );
  /** @type {object[]} */
  const out = edu.map((f) => ({
    ...f,
    kind: f?.kind || "file",
    source: f?.source || "education",
  }));
  for (const f of drive) {
    const key = String(f?.name || "").toLowerCase();
    if (!key || used.has(key)) continue;
    used.add(key);
    out.push(f);
  }
  out.sort((a, b) => {
    const am = Date.parse(String(a?.mtime || "")) || 0;
    const bm = Date.parse(String(b?.mtime || "")) || 0;
    if (am !== bm) return bm - am;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
  return out;
}

/**
 * Absolute file path under a class OneDrive folder.
 * @param {string} classDir
 * @param {string} relPath
 * @returns {string}
 */
export function resolveOnedriveAbsolutePath(classDir, relPath) {
  const rel = isSafeRelativePath(relPath);
  if (!rel) {
    const err = new Error("invalid file name");
    err.status = 400;
    throw err;
  }
  const absDir = resolve(classDir);
  const absFile = resolve(join(absDir, rel));
  if (absFile !== absDir && !absFile.startsWith(absDir + sep)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  return absFile;
}

/**
 * @param {string} absFile
 * @returns {Promise<{ path: string, name: string, size: number, mtime: string }>}
 */
export async function statOnedriveFile(absFile) {
  let st;
  try {
    st = await stat(absFile);
  } catch (err) {
    if (err?.code === "ENOENT") {
      const missing = new Error("file not found");
      missing.status = 404;
      throw missing;
    }
    throw err;
  }
  if (!st.isFile()) {
    const err = new Error("file not found");
    err.status = 404;
    throw err;
  }
  return {
    path: absFile,
    name: basename(absFile),
    size: st.size,
    mtime: new Date(st.mtimeMs).toISOString(),
  };
}
