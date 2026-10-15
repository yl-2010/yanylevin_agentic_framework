/**
 * File-backed education OS reader / todo.done writer.
 * Roots: education/<email>/ under the repo.
 */

import { createReadStream } from "node:fs";
import { createRequire } from "node:module";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAddCommitPush } from "./git-publish.js";
import { attachCanvasOverlay } from "./canvas-grades.js";
import {
  listClassObjectDirs,
  gradeDirFromMeta,
  listOnedriveFolderNames,
  listOnedriveTree,
  matchOnedriveFolder,
  mergeContextFileLists,
  isSafeRelativePath,
  objectDirId,
  objectFolderPaths,
  resolveBookkeepingFile,
  resolveOnedriveAbsolutePath,
  statOnedriveFile,
  attachOfficeOpenFields,
  officeOpenOptsFromMeta,
  urlTileFromDroppedFile,
  urlTileFromObject,
} from "./education-onedrive.js";
import {
  canonicalizeEmail,
  isFullAccessEmail,
  isJypeAccessEmail,
  FULL_ACCESS_EMAILS,
} from "./identity.js";
import { JYPE_ROOT_REL, normalizeJypeWorkspace } from "./jype.js";

const require = createRequire(import.meta.url);
const { decodeEducationFileQueryValue } = require("../education/file-query.js");

const FILE_QUERY_KEYS = ["scope", "id", "classId", "projectId", "name", "source", "path"];

/** Undo ylb64 query values from a dragged file link. Plain ids pass through. */
export function decodeEducationFileQuery(opts) {
  const out = opts && typeof opts === "object" ? { ...opts } : {};
  for (const key of FILE_QUERY_KEYS) {
    if (out[key] == null || out[key] === "") continue;
    out[key] = decodeEducationFileQueryValue(out[key]);
  }
  return out;
}

/** Property JSON filenames that are never treated as context files. */
const PROPERTY_JSON = new Set([
  "class.json",
  "project.json",
  "todo.json",
  "date.json",
  "case.json",
  "meta.json",
  "schedule.json",
]);

/**
 * Dropped files hidden from dashboard tiles unless listed in `visibleFiles`.
 * Kept on disk for the model. Match is case-insensitive.
 */
const DEFAULT_UI_HIDDEN_FILES = new Set(["context.md", "deleted.md"]);

/**
 * Safe basename for a context file (no path segments / traversal).
 * @param {unknown} name
 * @returns {string|null}
 */
export function isSafeContextFileName(name) {
  const s = String(name || "").trim();
  if (!s || s === "." || s === "..") return null;
  if (s.includes("/") || s.includes("\\") || s.includes("\0")) return null;
  if (s.startsWith(".")) return null;
  if (PROPERTY_JSON.has(s.toLowerCase())) return null;
  return s;
}

/**
 * @param {unknown} raw
 * @returns {Set<string>} lowercase safe basenames
 */
function parseFileNameList(raw) {
  /** @type {Set<string>} */
  const out = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const safe = isSafeContextFileName(entry);
    if (safe) out.add(safe.toLowerCase());
  }
  return out;
}

/**
 * Basenames listed in properties JSON `hiddenFiles` (UI omits these; files stay on disk).
 * @param {object|null|undefined} props
 * @returns {Set<string>} lowercase names
 */
export function parseHiddenFileNames(props) {
  return parseFileNameList(props?.hiddenFiles);
}

/**
 * Basenames listed in `visibleFiles` (shown even if default-hidden or in `hiddenFiles`).
 * @param {object|null|undefined} props
 * @returns {Set<string>} lowercase names
 */
export function parseVisibleFileNames(props) {
  return parseFileNameList(props?.visibleFiles);
}

/**
 * Ordered basenames from `filesTop` / `filesBottom`. First occurrence wins.
 * @param {unknown} raw
 * @returns {string[]} lowercase safe basenames
 */
export function parseOrderedFileNames(raw) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const safe = isSafeContextFileName(entry);
    if (!safe) continue;
    const key = safe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * @param {object|null|undefined} props
 * @returns {{
 *   hiddenNames: Set<string>,
 *   visibleNames: Set<string>,
 *   topNames: string[],
 *   bottomNames: string[],
 * }}
 */
export function contextFileListOpts(props) {
  return {
    hiddenNames: parseHiddenFileNames(props),
    visibleNames: parseVisibleFileNames(props),
    topNames: parseOrderedFileNames(props?.filesTop),
    bottomNames: parseOrderedFileNames(props?.filesBottom),
  };
}

/**
 * @param {unknown} names
 * @returns {Set<string>}
 */
function toLowerNameSet(names) {
  /** @type {Set<string>} */
  const out = new Set();
  if (names instanceof Set) {
    for (const n of names) out.add(String(n).toLowerCase());
  } else if (Array.isArray(names)) {
    for (const n of names) out.add(String(n).toLowerCase());
  }
  return out;
}

/**
 * Stick named files to the top / bottom in the given order. Unpinned files
 * keep their incoming order (mtime newest first). A name in both lists stays
 * on top. Missing or hidden names are skipped.
 * @param {{ name: string }[]} files
 * @param {string[]|Set<string>|undefined} topNames
 * @param {string[]|Set<string>|undefined} bottomNames
 * @returns {{ name: string }[]}
 */
export function pinContextFileOrder(files, topNames, bottomNames) {
  const topList = Array.isArray(topNames)
    ? topNames
    : topNames instanceof Set
      ? [...topNames]
      : [];
  const bottomList = Array.isArray(bottomNames)
    ? bottomNames
    : bottomNames instanceof Set
      ? [...bottomNames]
      : [];
  if (!topList.length && !bottomList.length) return files;

  /** @type {Map<string, { name: string }>} */
  const byLower = new Map();
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, f);
  }

  const used = new Set();
  /** @type {{ name: string }[]} */
  const top = [];
  for (const raw of topList) {
    const key = String(raw).toLowerCase();
    const f = byLower.get(key);
    if (!f || used.has(key)) continue;
    top.push(f);
    used.add(key);
  }

  const bottomUsed = new Set();
  /** @type {{ name: string }[]} */
  const bottom = [];
  for (const raw of bottomList) {
    const key = String(raw).toLowerCase();
    if (used.has(key) || bottomUsed.has(key)) continue;
    const f = byLower.get(key);
    if (!f) continue;
    bottom.push(f);
    bottomUsed.add(key);
  }

  const middle = files.filter((f) => {
    const key = f.name.toLowerCase();
    return !used.has(key) && !bottomUsed.has(key);
  });
  return [...top, ...middle, ...bottom];
}

/** Runtime last-opened map. Gitignored; not an object-folder properties JSON. */
const PROJECTS_OPENED_FILE = ".projects-opened.json";

/**
 * Ordered project pins from `projectsTop` / `projectsBottom` on meta.json.
 * Entries are folder ids or display names. First occurrence wins.
 * @param {unknown} raw
 * @returns {string[]} lowercase pins
 */
export function parseOrderedProjectPins(raw) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    const s = String(entry || "").trim();
    if (!s || s === "." || s === "..") continue;
    if (s.includes("/") || s.includes("\\") || s.includes("\0")) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * @param {object} project
 * @param {string} pin lowercase
 */
function projectMatchesPin(project, pin) {
  const id = String(project?.id || "")
    .trim()
    .toLowerCase();
  const name = String(project?.name || "")
    .trim()
    .toLowerCase();
  return Boolean(pin) && (id === pin || name === pin);
}

/**
 * @param {object} project
 * @param {Record<string, string|number>|undefined} openedAt
 */
function projectOpenedMs(project, openedAt) {
  const raw = openedAt?.[project?.id];
  const t = typeof raw === "number" ? raw : Date.parse(String(raw || ""));
  return Number.isFinite(t) ? t : 0;
}

/**
 * Treat a new project (no leftover `order`, not yet in the opened map) as
 * opened at project.json birthtime, same as a user opening it.
 * @param {Record<string, string>} openedAt
 * @param {{ id: string, order?: unknown, _birthMs?: number }[]} projects
 * @returns {Record<string, string>}
 */
export function mergeCreateOpenedAt(openedAt, projects) {
  /** @type {Record<string, string>} */
  const out = { ...openedAt };
  if (!Array.isArray(projects)) return out;
  for (const p of projects) {
    const id = String(p?.id || "").trim();
    if (!id || out[id]) continue;
    if (Number.isFinite(Number(p.order))) continue;
    const birth = Number(p._birthMs);
    if (!Number.isFinite(birth) || birth <= 0) continue;
    out[id] = new Date(birth).toISOString();
  }
  return out;
}

/**
 * @param {object} project
 */
function projectOrderNum(project) {
  const n = Number(project?.order);
  return Number.isFinite(n) ? n : 9999;
}

/**
 * Projects panel order: pinned top, then newest last-opened (user open or
 * agent create), then pinned bottom. Never-opened leftover-`order` projects
 * stay below those, then A-Z. A pin in both lists stays on top. Missing
 * names are skipped. Pins match folder id or display name.
 * @param {object[]} projects
 * @param {{
 *   projectsTop?: unknown,
 *   projectsBottom?: unknown,
 *   topNames?: unknown,
 *   bottomNames?: unknown,
 *   openedAt?: Record<string, string|number>,
 * }} [opts]
 * @returns {object[]}
 */
export function sortEducationProjects(projects, opts = {}) {
  const list = Array.isArray(projects) ? [...projects] : [];
  const openedAt =
    opts.openedAt && typeof opts.openedAt === "object" && !Array.isArray(opts.openedAt)
      ? opts.openedAt
      : {};
  list.sort((a, b) => {
    const ao = projectOpenedMs(a, openedAt);
    const bo = projectOpenedMs(b, openedAt);
    if (ao !== bo) return bo - ao;
    const aOrd = projectOrderNum(a);
    const bOrd = projectOrderNum(b);
    if (aOrd !== bOrd) return aOrd - bOrd;
    return String(a.name || a.id).localeCompare(String(b.name || b.id));
  });

  const topList = parseOrderedProjectPins(opts.topNames ?? opts.projectsTop);
  const bottomList = parseOrderedProjectPins(opts.bottomNames ?? opts.projectsBottom);
  if (!topList.length && !bottomList.length) return list;

  const used = new Set();
  const findUnused = (pin) =>
    list.find((p) => !used.has(p.id) && projectMatchesPin(p, pin));

  /** @type {object[]} */
  const top = [];
  for (const pin of topList) {
    const p = findUnused(pin);
    if (!p) continue;
    top.push(p);
    used.add(p.id);
  }

  /** @type {object[]} */
  const bottom = [];
  for (const pin of bottomList) {
    const p = findUnused(pin);
    if (!p) continue;
    bottom.push(p);
    used.add(p.id);
  }

  const middle = list.filter((p) => !used.has(p.id));
  return [...top, ...middle, ...bottom];
}

/**
 * @param {string} root
 * @returns {Promise<Record<string, string>>}
 */
async function readProjectsOpened(root) {
  const data = await readJsonFile(join(root, PROJECTS_OPENED_FILE));
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  /** @type {Record<string, string>} */
  const out = {};
  for (const [id, iso] of Object.entries(data)) {
    const safe = isSafeObjectId(id);
    if (!safe) continue;
    const t = Date.parse(String(iso || ""));
    if (!Number.isFinite(t)) continue;
    out[safe] = new Date(t).toISOString();
  }
  return out;
}

/**
 * List dropped context files in an object folder.
 * Default order is newest mtime first (same name, then A-Z). Optional `filesTop` /
 * `filesBottom` pin names above or below that. Skips property JSON, nested
 * object dirs, dotfiles, and UI-hidden names (`context.md` and `deleted.md` by default, plus
 * `hiddenFiles`, minus `visibleFiles`).
 * @param {string} dir
 * @param {{
 *   hiddenNames?: Set<string>|string[],
 *   visibleNames?: Set<string>|string[],
 *   topNames?: string[]|Set<string>,
 *   bottomNames?: string[]|Set<string>,
 *   skipPin?: boolean,
 *   onedriveRoot?: string,
 *   onedriveWebRoot?: string,
 * }} [opts]
 * @returns {Promise<{ name: string, size: number, mtime: string, kind: string, source: string }[]>}
 */
export async function listContextFiles(dir, opts = {}) {
  /** @type {{ name: string, size: number, mtimeMs: number, mtime: string }[]} */
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const safe = isSafeContextFileName(entry.name);
    if (!safe) continue;
    const filePath = join(dir, entry.name);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      out.push({
        name: entry.name,
        size: st.size,
        mtimeMs: st.mtimeMs,
        mtime: new Date(st.mtimeMs).toISOString(),
      });
    } catch {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  const hiddenSet = toLowerNameSet(opts?.hiddenNames);
  const visibleSet = toLowerNameSet(opts?.visibleNames);
  for (const n of DEFAULT_UI_HIDDEN_FILES) {
    if (!visibleSet.has(n)) hiddenSet.add(n);
  }
  for (const n of visibleSet) hiddenSet.delete(n);
  /** @type {{ name: string, size?: number, mtime: string, kind: string, source: string, url?: string }[]} */
  const visible = [];
  for (const f of out) {
    if (hiddenSet.has(f.name.toLowerCase())) continue;
    const abs = join(dir, f.name);
    const urlTile = await urlTileFromDroppedFile(abs, f.name, {
      source: "education",
      mtime: f.mtime,
    });
    if (urlTile) {
      visible.push(urlTile);
      continue;
    }
    visible.push(
      attachOfficeOpenFields(
        {
          name: f.name,
          size: f.size,
          mtime: f.mtime,
          kind: "file",
          source: "education",
        },
        abs,
        opts
      )
    );
  }
  if (opts?.skipPin) return visible;
  return pinContextFileOrder(visible, opts?.topNames, opts?.bottomNames);
}

/**
 * Resolve a file under the class OneDrive folder (bytes stay in OneDrive).
 * @param {string} root user education root
 * @param {{
 *   scope?: string,
 *   id?: string|null,
 *   classId?: string|null,
 *   name?: string,
 *   path?: string|null,
 * }} opts
 */
async function resolveOnedriveContextFile(root, opts) {
  const scope = String(opts?.scope || "").trim().toLowerCase();
  const classId =
    scope === "class"
      ? opts?.id != null && opts.id !== ""
        ? isSafeObjectId(opts.id)
        : null
      : opts?.classId != null && opts.classId !== ""
        ? isSafeObjectId(opts.classId)
        : null;
  if (scope !== "class" && scope !== "todo" && scope !== "date") {
    const err = new Error("invalid scope");
    err.status = 400;
    throw err;
  }
  if (!classId) {
    const err = new Error("class id required");
    err.status = 400;
    throw err;
  }

  const rel = isSafeRelativePath(opts?.path || opts?.name);
  if (!rel) {
    const err = new Error("invalid file name");
    err.status = 400;
    throw err;
  }

  const meta = (await readJsonFile(join(root, "meta.json"))) || {};
  const gradeDir = gradeDirFromMeta(meta);
  if (!gradeDir) {
    const err = new Error("file not found");
    err.status = 404;
    throw err;
  }

  const entry = await classEntryForRoot(root, classId);
  if (!entry?.onedriveFolder) {
    const err = new Error("file not found");
    err.status = 404;
    throw err;
  }

  const absFile = resolveOnedriveAbsolutePath(
    join(gradeDir, entry.onedriveFolder),
    rel
  );
  return statOnedriveFile(absFile);
}

/**
 * Resolve a context file under the user's education tree.
 * @param {string} email
 * @param {{
 *   scope: "class"|"project"|"todo"|"date"|"user",
 *   id?: string|null,
 *   classId?: string|null,
 *   projectId?: string|null,
 *   name: string,
 *   source?: string|null,
 *   path?: string|null,
 * }} opts
 * @returns {Promise<{ path: string, name: string, size: number, mtime: string }>}
 */
export async function resolveContextFile(email, opts) {
  opts = decodeEducationFileQuery(opts);
  const root = userEducationRoot(email, opts);
  const source = String(opts?.source || "").trim().toLowerCase();
  if (source === "onedrive") {
    return resolveOnedriveContextFile(root, opts);
  }

  const fileName = isSafeContextFileName(opts?.name);
  if (!fileName) {
    const err = new Error("invalid file name");
    err.status = 400;
    throw err;
  }

  const scope = String(opts?.scope || "").trim().toLowerCase();
  const id = opts?.id != null && opts.id !== "" ? isSafeObjectId(opts.id) : null;
  const classId =
    opts?.classId != null && opts.classId !== ""
      ? isSafeObjectId(opts.classId)
      : null;
  const projectId =
    opts?.projectId != null && opts.projectId !== ""
      ? isSafeObjectId(opts.projectId)
      : null;

  /** @type {string|null} */
  let folder = null;
  /** Class folder used to follow linkedFiles when this todo does not have the file. */
  /** @type {string|null} */
  let classFolderForLinks = null;
  if (scope === "user") {
    folder = root;
  } else if (scope === "class") {
    if (!id) {
      const err = new Error("class id required");
      err.status = 400;
      throw err;
    }
    const entry = await classEntryForRoot(root, id);
    folder = entry?.objectDir || join(root, "classes", id);
  } else if (scope === "project") {
    if (!id) {
      const err = new Error("project id required");
      err.status = 400;
      throw err;
    }
    folder = join(root, "projects", id);
  } else if (scope === "todo") {
    if (!id) {
      const err = new Error("todo id required");
      err.status = 400;
      throw err;
    }
    if (projectId) {
      folder = join(root, "projects", projectId, "todos", id);
    } else if (classId) {
      const entry = await classEntryForRoot(root, classId);
      if (entry) {
        classFolderForLinks = entry.classFolder || entry.objectDir || null;
        folder = await firstExistingDir([
          ...objectFolderPaths(classFolderForLinks, id),
          ...objectFolderPaths(join(entry.objectDir, "todos"), id),
        ]);
      } else {
        classFolderForLinks = join(root, "classes", classId);
        folder = join(classFolderForLinks, "todos", id);
      }
    } else {
      folder = join(root, "todos", id);
    }
  } else if (scope === "date") {
    if (!id) {
      const err = new Error("date id required");
      err.status = 400;
      throw err;
    }
    if (projectId) {
      folder = join(root, "projects", projectId, "dates", id);
    } else if (classId) {
      const entry = await classEntryForRoot(root, classId);
      if (entry) {
        folder = await firstExistingDir([
          ...objectFolderPaths(entry.classFolder || entry.objectDir, id),
          ...objectFolderPaths(join(entry.objectDir, "dates"), id),
        ]);
      } else {
        folder = join(root, "classes", classId, "dates", id);
      }
    } else {
      folder = join(root, "dates", id);
    }
  } else {
    const err = new Error("invalid scope");
    err.status = 400;
    throw err;
  }

  const absFolder = resolve(folder);
  const absRoot = resolve(root);
  const meta = (await readJsonFile(join(root, "meta.json"))) || {};
  const gradeDir = gradeDirFromMeta(meta);
  const absGrade = gradeDir ? resolve(gradeDir) : null;
  const inEducation =
    absFolder === absRoot || absFolder.startsWith(absRoot + sep);
  const inOnedrive =
    Boolean(absGrade) &&
    (absFolder === absGrade || absFolder.startsWith(absGrade + sep));
  if (!inEducation && !inOnedrive) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  const absFile = resolve(join(absFolder, fileName));
  if (absFile !== absFolder && !absFile.startsWith(absFolder + sep)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }

  const linkedTodoFile = async () => {
    if (scope !== "todo" || !classFolderForLinks || !id) return null;
    return resolveLinkedTodoFile(classFolderForLinks, id, fileName);
  };

  let st;
  try {
    st = await stat(absFile);
  } catch (err) {
    if (err?.code === "ENOENT") {
      const linked = await linkedTodoFile();
      if (linked) return linked;
      if (scope === "class" && id) {
        try {
          return await resolveOnedriveContextFile(root, {
            scope: "class",
            id,
            name: fileName,
            path: fileName,
          });
        } catch {
          /* still missing */
        }
      }
      const missing = new Error("file not found");
      missing.status = 404;
      throw missing;
    }
    throw err;
  }
  if (!st.isFile()) {
    const linked = await linkedTodoFile();
    if (linked) return linked;
    if (scope === "class" && id) {
      try {
        return await resolveOnedriveContextFile(root, {
          scope: "class",
          id,
          name: fileName,
          path: fileName,
        });
      } catch {
        /* still missing */
      }
    }
    const err = new Error("file not found");
    err.status = 404;
    throw err;
  }

  return {
    path: absFile,
    name: fileName,
    size: st.size,
    mtime: new Date(st.mtimeMs).toISOString(),
  };
}

/** Best-effort Content-Type from extension. */
export function contentTypeForFileName(name) {
  const ext = extname(String(name || "")).toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx":
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".pages": "application/vnd.apple.pages",
    ".numbers": "application/vnd.apple.numbers",
    ".key": "application/vnd.apple.keynote",
    ".zip": "application/zip",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
  };
  return map[ext] || "application/octet-stream";
}

/**
 * Stream a resolved context file to an Express response.
 * @param {import('express').Response} res
 * @param {{ path: string, name: string, size: number }} file
 */
export function sendContextFile(res, file) {
  const type = contentTypeForFileName(file.name);
  const ascii = String(file.name)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
  const encoded = encodeURIComponent(file.name);
  res.setHeader("Content-Type", type);
  res.setHeader("Content-Length", String(file.size));
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader("Cache-Control", "private, no-store");
  createReadStream(file.path).pipe(res);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EDUCATION_ROOT = join(ROOT, "education");

export { FULL_ACCESS_EMAILS };

/** @param {string|null|undefined} email */
export function isEducationUser(email) {
  return isFullAccessEmail(email);
}

/**
 * Live URL tiles stored on class.json / project.json / todo.json / date.json `sites`.
 * Click opens the URL. No file on disk. Same tiles as dropped `.json` / `.url` links.
 * @param {object|null|undefined} props
 */
export function siteFilesFromProps(props) {
  const sites = Array.isArray(props?.sites) ? props.sites : [];
  /** @type {object[]} */
  const out = [];
  const seen = new Set();
  for (const raw of sites) {
    const tile = urlTileFromObject(raw);
    if (!tile) continue;
    const key = tile.url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...tile, source: "site" });
  }
  return out;
}

/** @param {string} email */
export function userEducationRoot(email, opts = {}) {
  const workspace = normalizeJypeWorkspace(opts.workspace);
  const normalized = canonicalizeEmail(email);
  if (workspace === "jype") {
    if (!isJypeAccessEmail(normalized)) {
      const err = new Error("forbidden");
      err.status = 403;
      throw err;
    }
    return join(ROOT, JYPE_ROOT_REL);
  }
  if (!isEducationUser(normalized)) {
    const err = new Error("forbidden");
    err.status = 403;
    throw err;
  }
  // Prevent path traversal — email folders are literal addresses.
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) {
    const err = new Error("invalid email");
    err.status = 400;
    throw err;
  }
  return join(EDUCATION_ROOT, normalized);
}

/** OneDrive File Provider sometimes returns EDEADLK (errno 11) on read. */
function isTransientReadError(err) {
  if (!err || err instanceof SyntaxError) return false;
  if (err.errno === -11 || err.errno === 11) return true;
  const code = String(err.code || "");
  return (
    code === "EAGAIN" ||
    code === "EBUSY" ||
    code === "EDEADLK" ||
    code === "Unknown system error -11"
  );
}

async function readJsonFile(path) {
  const attempts = 4;
  for (let i = 0; i < attempts; i++) {
    try {
      const raw = await readFile(path, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      if (err && (err.code === "ENOENT" || err instanceof SyntaxError)) return null;
      if (isTransientReadError(err) && i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return null;
}

async function readClassProps(objectDir) {
  try {
    return await readJsonFile(join(objectDir, "class.json"));
  } catch (err) {
    console.error(
      "[education-data] skip class.json",
      objectDir,
      err?.code || err?.message || err
    );
    return null;
  }
}

async function firstExistingDir(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      const st = await stat(p);
      if (st.isDirectory()) return p;
    } catch {
      /* try next */
    }
  }
  return paths.find(Boolean) || null;
}

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
}

/**
 * Class object folders: OneDrive `.education` when mapped, else
 * `education/<email>/classes/<id>` (fixtures, Alex, leftovers).
 * @param {string} root
 * @returns {Promise<{
 *   id: string,
 *   objectDir: string,
 *   classFolder: string,
 *   onedriveFolder: string|null,
 *   source: "onedrive"|"education",
 * }[]>}
 */
export async function listClassEntriesForRoot(root) {
  /** @type {Map<string, { id: string, objectDir: string, classFolder: string, onedriveFolder: string|null, source: "onedrive"|"education" }>} */
  const byId = new Map();
  const meta = (await readJsonFile(join(root, "meta.json"))) || {};
  const gradeDir = gradeDirFromMeta(meta);

  for (const classId of await listDirs(join(root, "classes"))) {
    const objectDir = join(root, "classes", classId);
    const props = await readClassProps(objectDir);
    if (!props || typeof props !== "object") continue;
    const id = isSafeObjectId(props.id) || isSafeObjectId(classId);
    if (!id) continue;
    byId.set(id, {
      id,
      objectDir,
      classFolder: objectDir,
      onedriveFolder: String(props.onedriveFolder || "").trim() || null,
      source: "education",
    });
  }

  if (gradeDir) {
    const folderNames = await listOnedriveFolderNames(gradeDir, {
      includeHidden: true,
    });
    for (const name of folderNames) {
      const classFolder = join(gradeDir, name);
      for (const objectDir of await listClassObjectDirs(gradeDir, name)) {
        const props = await readClassProps(objectDir);
        if (!props || typeof props !== "object") continue;
        const id = isSafeObjectId(props.id);
        if (!id) continue;
        byId.set(id, {
          id,
          objectDir,
          classFolder,
          onedriveFolder: name,
          source: "onedrive",
        });
      }
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @param {string} email
 */
export async function listClassEntries(email, opts = {}) {
  return listClassEntriesForRoot(userEducationRoot(email, opts));
}

/**
 * @param {string} root
 * @param {string} classId
 */
async function classEntryForRoot(root, classId) {
  const id = isSafeObjectId(classId);
  if (!id) return null;
  const entries = await listClassEntriesForRoot(root);
  return entries.find((e) => e.id === id) || null;
}

/**
 * Fixture trees stay on disk for agents; UI/API consumers hide them.
 * @param {{ id?: string, fixture?: boolean }|null|undefined} obj
 */
export function isFixture(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.fixture === true) return true;
  const id = String(obj.id || "");
  return id.startsWith("_example-");
}

/**
 * User-hidden objects stay on disk; the education UI omits them.
 * @param {{ hidden?: unknown }|null|undefined} obj
 */
export function isHiddenFromUi(obj) {
  return Boolean(obj && typeof obj === "object" && obj.hidden === true);
}

const TRI_KEYS = ["fall", "winter", "spring"];

/**
 * Normalize class.json `trimester` → list of terms, or ["year"].
 * Supports `"year"`, a single term, or an array of terms.
 * @param {{ trimester?: unknown }|null|undefined} cls
 * @returns {string[]}
 */
export function classTrimesters(cls) {
  const raw = cls?.trimester;
  if (raw == null || raw === "") return ["year"];
  if (Array.isArray(raw)) {
    const out = raw
      .map((t) => String(t || "").trim().toLowerCase())
      .filter((t) => t === "year" || TRI_KEYS.includes(t));
    return out.length ? out : ["year"];
  }
  const t = String(raw).trim().toLowerCase();
  if (t === "year" || TRI_KEYS.includes(t)) return [t];
  return ["year"];
}

/**
 * Which trimester a YYYY-MM-DD falls in, from schedule.trimesters ranges.
 * @param {string} dateKey
 * @param {{ trimesters?: Record<string, { start?: string, end?: string }> }|null|undefined} schedule
 * @returns {"fall"|"winter"|"spring"|null}
 */
function normalizePeriodMap(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const key of TRI_KEYS) {
    const letter = String(raw[key] || "")
      .trim()
      .toUpperCase();
    if (letter) out[key] = letter;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Trimester → period letter when `period` is a map, or `periods` on the
 * published class row.
 * @param {object|null|undefined} cls
 * @returns {Record<string, string>|null}
 */
export function classPeriodsMap(cls) {
  if (!cls || typeof cls !== "object") return null;
  if (cls.period && typeof cls.period === "object" && !Array.isArray(cls.period)) {
    return normalizePeriodMap(cls.period);
  }
  if (cls.periods && typeof cls.periods === "object" && !Array.isArray(cls.periods)) {
    return normalizePeriodMap(cls.periods);
  }
  return null;
}

/**
 * Period letter for a class on a YYYY-MM-DD.
 * @param {object|null|undefined} cls
 * @param {string} dateKey
 * @param {object|null|undefined} schedule
 */
export function classPeriodOnDate(cls, dateKey, schedule) {
  const map = classPeriodsMap(cls);
  if (map) {
    const term = trimesterForDate(dateKey, schedule);
    if (term && map[term]) return map[term];
    for (const key of TRI_KEYS) {
      if (map[key]) return map[key];
    }
    return "";
  }
  return String(cls?.period || "")
    .trim()
    .toUpperCase();
}

export function trimesterForDate(dateKey, schedule) {
  const key = String(dateKey || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const map = schedule?.trimesters;
  if (!map || typeof map !== "object") return null;
  for (const name of TRI_KEYS) {
    const range = map[name];
    if (!range || typeof range !== "object") continue;
    const start = String(range.start || "");
    const end = String(range.end || "");
    if (start && end && key >= start && key <= end) return name;
  }
  return null;
}

/**
 * When today falls in a break (summer before fall, or between terms), treat the
 * next term as in season for todos — schedule panels still use trimesterForDate.
 * @param {string} dateKey
 * @param {object|null|undefined} schedule
 * @returns {"fall"|"winter"|"spring"|null}
 */
export function effectiveTrimesterForVisibility(dateKey, schedule) {
  const direct = trimesterForDate(dateKey, schedule);
  if (direct) return direct;

  const map = schedule?.trimesters;
  if (!map || typeof map !== "object") return null;

  const schoolStart = String(schedule?.schoolStart || "");
  const schoolEnd = String(schedule?.schoolEnd || "");
  /** @type {{ name: (typeof TRI_KEYS)[number], start: string, end: string }[]} */
  const ordered = TRI_KEYS.map((name) => ({
    name,
    start: String(map[name]?.start || ""),
    end: String(map[name]?.end || ""),
  })).filter((t) => t.start && t.end);

  const fall = ordered.find((t) => t.name === "fall");
  if (schoolStart && dateKey < schoolStart && fall && dateKey < fall.start) {
    const prepFrom = `${String(Number(fall.start.slice(0, 4)) - 1)}-06-01`;
    if (dateKey >= prepFrom) return "fall";
    return null;
  }

  if (schoolEnd && dateKey > schoolEnd) return null;
  if (schoolStart && dateKey < schoolStart) return null;

  for (const t of ordered) {
    if (dateKey < t.start) return t.name;
  }
  return null;
}

/**
 * Year-long classes are always active in-year; tri classes only inside their ranges.
 * Folders stay on disk forever — this is visibility only.
 * @param {{ trimester?: unknown }|null|undefined} cls
 * @param {string} dateKey
 * @param {object|null|undefined} schedule
 */
export function isClassActiveOnDate(cls, dateKey, schedule) {
  const terms = classTrimesters(cls);
  if (terms.includes("year")) return true;
  const tri = trimesterForDate(dateKey, schedule);
  if (!tri) return false;
  return terms.includes(tri);
}

/**
 * Whether a trimester class is in season for todo/date visibility today
 * (includes pre-fall summer and gaps before the next term starts).
 * @param {{ trimester?: unknown }|null|undefined} cls
 * @param {string} todayKey
 * @param {object|null|undefined} schedule
 */
export function isClassInSeasonToday(cls, todayKey, schedule) {
  const terms = classTrimesters(cls);
  if (terms.includes("year")) return true;
  const tri = effectiveTrimesterForVisibility(todayKey, schedule);
  if (!tri) return false;
  return terms.includes(tri);
}

/** Free-period shells fill empty A–H slots; prefer real classes when both match. */
export function isFreePeriodClass(cls) {
  return Boolean(cls && typeof cls === "object" && cls.freePeriod === true);
}

/**
 * Drop free-period ids from a date's active list when a real class already
 * occupies the same period letter that day.
 * @param {Record<string, string[]>} activeClassIdsByDate
 * @param {object[]} classes
 */
function pruneFreePeriodsWhenOccupied(activeClassIdsByDate, classes, schedule) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  for (const dateKey of Object.keys(activeClassIdsByDate)) {
    const ids = activeClassIdsByDate[dateKey];
    const occupied = new Set();
    for (const id of ids) {
      const c = byId.get(id);
      if (!c || isFreePeriodClass(c)) continue;
      const p = classPeriodOnDate(c, dateKey, schedule);
      if (p) occupied.add(p);
    }
    activeClassIdsByDate[dateKey] = ids.filter((id) => {
      const c = byId.get(id);
      if (!c || !isFreePeriodClass(c)) return true;
      const p = classPeriodOnDate(c, dateKey, schedule);
      return Boolean(p) && !occupied.has(p);
    });
  }
}

/**
 * Best-effort file birth time for todo input-order ties.
 * Prefers birthtime, then ctime, then mtime.
 * @param {string} filePath
 * @returns {Promise<string|null>} ISO timestamp
 */
async function fileCreatedAtIso(filePath) {
  try {
    const st = await stat(filePath);
    const ms =
      Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0
        ? st.birthtimeMs
        : Number.isFinite(st.ctimeMs) && st.ctimeMs > 0
          ? st.ctimeMs
          : st.mtimeMs;
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Leading CW/HW/QA/MA on Canvas titles. Tag lives on `tag`; UI paints it separately. */
const TODO_TAG_PREFIX = /^(CW|HW|QA|MA)(?:\s*:\s*|\s+)/i;

export function stripTodoTagPrefix(name) {
  const raw = String(name || "").trim();
  const stripped = raw.replace(TODO_TAG_PREFIX, "").trim();
  return stripped || raw;
}

/**
 * @param {string} parent
 * @param {string} child
 */
function pathInside(parent, child) {
  const base = resolve(parent);
  const target = resolve(child);
  return target === base || target.startsWith(base + sep);
}

/**
 * Pointers on `.todo.json` `linkedFiles`. Same class only.
 * `name` is one file in the other todo's folder. `pageId` is a OneNote site
 * already stored on that todo. `canvasId` wins over the Finder folder id.
 * @param {unknown} raw
 * @returns {{ name: string, pageId: string, todo: string, canvasId: string }[]}
 */
export function parseLinkedFiles(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {{ name: string, pageId: string, todo: string, canvasId: string }[]} */
  const out = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const todo =
      objectDirId(entry.todo) ||
      objectDirId(String(entry.todo || "").replace(/^\./, "")) ||
      "";
    let canvasId = String(entry.canvasId ?? "").trim();
    if (canvasId.length > 80 || /[\\/\0]/.test(canvasId)) canvasId = "";
    if (!todo && !canvasId) continue;
    const pageId = String(entry.pageId || "").trim();
    const pageOk =
      pageId &&
      pageId.length <= 512 &&
      !pageId.includes("/") &&
      !pageId.includes("\\") &&
      !pageId.includes("\0");
    const name = isSafeContextFileName(entry.name);
    if (pageOk) out.push({ name: "", pageId, todo, canvasId });
    if (name) out.push({ name, pageId: "", todo, canvasId });
  }
  return out;
}

/**
 * @param {string} classFolder
 * @param {string} todoId
 * @returns {Promise<string|null>}
 */
async function existingTodoDir(classFolder, todoId) {
  const paths = [
    ...objectFolderPaths(classFolder, todoId),
    ...objectFolderPaths(join(classFolder, "todos"), todoId),
  ];
  for (const p of paths) {
    if (!p) continue;
    try {
      const st = await stat(p);
      if (st.isDirectory()) return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * Finder folder for a Canvas assignment id. A leading-dot hide still counts.
 * A visible folder wins when both exist.
 * @param {string} classFolder
 * @param {string} canvasId
 * @returns {Promise<string|null>}
 */
async function findTodoDirByCanvasId(classFolder, canvasId) {
  const want = String(canvasId || "").trim();
  if (!want) return null;
  /** @type {string|null} */
  let hidden = null;
  for (const parent of [classFolder, join(classFolder, "todos")]) {
    for (const dirName of await listDirs(parent)) {
      if (!objectDirId(dirName)) continue;
      const objectDir = join(parent, dirName);
      const jsonPath = await resolveBookkeepingFile(objectDir, "todo.json");
      if (!jsonPath) continue;
      const props = await readJsonFile(jsonPath);
      if (String(props?.canvasId ?? "").trim() !== want) continue;
      if (!String(dirName).startsWith(".")) return objectDir;
      if (!hidden) hidden = objectDir;
    }
  }
  return hidden;
}

/**
 * @param {string} classFolder
 * @param {{ todo: string, canvasId: string }} link
 * @param {string} currentDir
 * @returns {Promise<string|null>}
 */
async function findSiblingTodoDir(classFolder, link, currentDir) {
  const current = resolve(currentDir);
  if (link.canvasId) {
    const hit = await findTodoDirByCanvasId(classFolder, link.canvasId);
    if (hit && resolve(hit) !== current) return hit;
  }
  if (link.todo) {
    const hit = await existingTodoDir(classFolder, link.todo);
    if (hit && resolve(hit) !== current) return hit;
  }
  return null;
}

/**
 * File named on this todo's `linkedFiles` that lives in a sibling todo folder.
 * Returns null when this todo already has that filename. The caller streams
 * the sibling file. Bytes stay where they are.
 * @param {string} classFolder
 * @param {string} todoId
 * @param {string} fileName
 * @returns {Promise<{ path: string, name: string, size: number, mtime: string }|null>}
 */
export async function resolveLinkedTodoFile(classFolder, todoId, fileName) {
  const name = isSafeContextFileName(fileName);
  const id = objectDirId(todoId);
  if (!classFolder || !name || !id) return null;
  const current = await existingTodoDir(classFolder, id);
  if (!current || !pathInside(classFolder, current)) return null;
  const local = resolve(join(current, name));
  if (pathInside(current, local)) {
    try {
      const own = await stat(local);
      if (own.isFile()) return null;
    } catch {
      /* not in this folder */
    }
  }
  const jsonPath = await resolveBookkeepingFile(current, "todo.json");
  if (!jsonPath) return null;
  const props = await readJsonFile(jsonPath);
  const links = parseLinkedFiles(props?.linkedFiles).filter(
    (link) => link.name && link.name.toLowerCase() === name.toLowerCase()
  );
  for (const link of links) {
    const sibling = await findSiblingTodoDir(classFolder, link, current);
    if (!sibling || !pathInside(classFolder, sibling)) continue;
    const absFile = resolve(join(sibling, name));
    if (!pathInside(sibling, absFile) || !pathInside(classFolder, absFile)) continue;
    try {
      const st = await stat(absFile);
      if (!st.isFile()) continue;
      return {
        path: absFile,
        name,
        size: st.size,
        mtime: new Date(st.mtimeMs).toISOString(),
      };
    } catch {
      /* try the next pointer */
    }
  }
  return null;
}

/**
 * @param {object} todo
 * @param {{ canvasId: string, todo: string }} link
 * @param {Map<string, object>} byId
 * @param {Map<string, object>} byCanvas
 */
function siblingTodo(todo, link, byId, byCanvas) {
  if (link.canvasId) {
    const hit = byCanvas.get(link.canvasId);
    if (hit && hit !== todo) return hit;
  }
  if (link.todo) {
    const hit = byId.get(link.todo);
    if (hit && hit !== todo) return hit;
  }
  return null;
}

/**
 * Append file and OneNote tiles from `linkedFiles`. Own files stay first.
 * A missing file or page is omitted. `_objectDir` is removed before return.
 * @param {object[]} todos
 * @param {{ onedriveRoot?: string, onedriveWebRoot?: string }} [officeOpen]
 */
export async function applyTodoFileLinks(todos, officeOpen = {}) {
  const list = Array.isArray(todos) ? todos : [];
  try {
    /** @type {Map<string, object>} */
    const byId = new Map();
    /** @type {Map<string, object>} */
    const byCanvas = new Map();
    for (const todo of list) {
      if (!todo || typeof todo !== "object") continue;
      if (todo.id && !byId.has(todo.id)) byId.set(todo.id, todo);
      const canvasId = String(todo.canvasId ?? "").trim();
      if (canvasId && !byCanvas.has(canvasId)) byCanvas.set(canvasId, todo);
    }
    for (const todo of list) {
      if (!todo || typeof todo !== "object") continue;
      const links = parseLinkedFiles(todo.linkedFiles);
      if (!links.length) continue;
      /** @type {Set<string>} */
      const ownNames = new Set();
      /** @type {Set<string>} */
      const ownPageIds = new Set();
      /** @type {Set<string>} */
      const ownUrls = new Set();
      for (const site of Array.isArray(todo.sites) ? todo.sites : []) {
        const pageId = String(site?.pageId || "").trim();
        if (pageId) ownPageIds.add(pageId);
        const url = String(site?.url || site?.href || "").trim().toLowerCase();
        if (url) ownUrls.add(url);
      }
      for (const file of Array.isArray(todo.files) ? todo.files : []) {
        const kind = String(file?.kind || "file");
        if (kind === "file") ownNames.add(String(file?.name || "").toLowerCase());
        const url = String(file?.url || "").trim().toLowerCase();
        if (url) ownUrls.add(url);
      }
      /** @type {object[]} */
      const linked = [];
      const seenNames = new Set();
      const seenPages = new Set();
      for (const link of links) {
        const sibling = siblingTodo(todo, link, byId, byCanvas);
        if (!sibling) continue;
        if (link.pageId) {
          if (ownPageIds.has(link.pageId) || seenPages.has(link.pageId)) continue;
          const site = (Array.isArray(sibling.sites) ? sibling.sites : []).find(
            (row) => String(row?.pageId || "").trim() === link.pageId
          );
          if (!site) continue;
          const tile = urlTileFromObject(site);
          if (!tile) continue;
          const urlKey = tile.url.toLowerCase();
          if (ownUrls.has(urlKey)) continue;
          linked.push({ ...tile, source: "site" });
          seenPages.add(link.pageId);
          ownUrls.add(urlKey);
          continue;
        }
        const key = link.name.toLowerCase();
        if (!key || ownNames.has(key) || seenNames.has(key)) continue;
        const fromSibling = (Array.isArray(sibling.files) ? sibling.files : []).find(
          (file) =>
            String(file?.kind || "file") === "file" &&
            String(file?.name || "").toLowerCase() === key
        );
        if (fromSibling) {
          linked.push({ ...fromSibling });
          seenNames.add(key);
          ownNames.add(key);
          continue;
        }
        const dir = sibling._objectDir;
        if (!dir) continue;
        const abs = join(dir, link.name);
        if (!pathInside(dir, abs)) continue;
        try {
          const st = await stat(abs);
          if (!st.isFile()) continue;
          linked.push(
            attachOfficeOpenFields(
              {
                name: link.name,
                size: st.size,
                mtime: new Date(st.mtimeMs).toISOString(),
                kind: "file",
                source: "education",
              },
              abs,
              officeOpen
            )
          );
          seenNames.add(key);
          ownNames.add(key);
        } catch {
          /* pointer whose file is gone */
        }
      }
      if (linked.length) todo.files = [...(todo.files || []), ...linked];
    }
  } finally {
    for (const todo of list) {
      if (todo && typeof todo === "object") delete todo._objectDir;
    }
  }
  return list;
}

async function loadObjectFolder(
  parentDir,
  kind,
  {
    includeFixtures = false,
    classId = null,
    projectId = null,
    officeOpen = {},
    keepObjectDir = false,
  } = {}
) {
  const ids = await listDirs(parentDir);
  const fileName = kind === "todo" ? "todo.json" : "date.json";
  /** @type {Map<string, string>} */
  const dirById = new Map();
  for (const dirName of ids) {
    const id = objectDirId(dirName);
    if (!id) continue;
    const prev = dirById.get(id);
    if (!prev || !dirName.startsWith(".")) dirById.set(id, dirName);
  }
  /** @type {object[]} */
  const out = [];
  for (const [id, dirName] of dirById) {
    const objectDir = join(parentDir, dirName);
    const jsonPath = await resolveBookkeepingFile(objectDir, fileName);
    if (!jsonPath) continue;
    const props = await readJsonFile(jsonPath);
    if (!props || typeof props !== "object") continue;
    const item = { id, ...props };
    if (classId) item.classId = classId;
    if (projectId) item.projectId = projectId;
    if (kind === "todo") {
      const explicit =
        typeof props.createdAt === "string" && props.createdAt.trim()
          ? props.createdAt.trim()
          : null;
      item.createdAt = explicit || (await fileCreatedAtIso(jsonPath)) || null;
      if (typeof item.name === "string") item.name = stripTodoTagPrefix(item.name);
    }
    if (kind === "date" && isHiddenFromUi(item)) continue;
    if (!includeFixtures && isFixture(item)) continue;
    const fileOpts = {
      ...contextFileListOpts(props),
      ...officeOpen,
    };
    item.files = pinContextFileOrder(
      [
        ...siteFilesFromProps(props),
        ...(await listContextFiles(objectDir, {
          ...fileOpts,
          skipPin: true,
        })),
      ],
      fileOpts.topNames,
      fileOpts.bottomNames
    );
    if (keepObjectDir) item._objectDir = objectDir;
    out.push(item);
  }
  return out;
}

function debateCleanLine(value, max) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function debateCleanLines(value, maxLines, maxLen) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(/\n\s*\n/);
  return parts
    .map((part) => debateCleanLine(part, maxLen))
    .filter(Boolean)
    .slice(0, maxLines);
}

function debateCleanUrl(value) {
  const url = String(value ?? "").trim();
  if (!/^https:\/\/[^\s]+$/i.test(url)) return "";
  return url.slice(0, 500);
}

function debateFramework(raw) {
  if (!raw || typeof raw !== "object") return null;
  const value = debateCleanLine(raw.value, 160);
  const criterion = debateCleanLine(raw.criterion, 240);
  const text = debateCleanLines(raw.text, 8, 2000);
  const cards = debateCards(raw.cards);
  if (!value && !criterion && !text.length && !cards.length) return null;
  const framework = {};
  if (value) framework.value = value;
  if (criterion) framework.criterion = criterion;
  if (text.length) framework.text = text;
  if (cards.length) framework.cards = cards;
  return framework;
}

function debateDefinitions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const term = debateCleanLine(item.term, 80);
      const points = debateCleanLines(item.points ?? item.text, 16, 2000);
      const cards = debateCards(item.cards);
      if (!term || (!points.length && !cards.length)) return null;
      const def = { term };
      if (points.length) def.points = points;
      if (cards.length) def.cards = cards;
      return def;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function debateCards(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const tag = debateCleanLine(item.tag, 300);
      const summary = debateCleanLine(item.summary, 500);
      const quote = debateCleanLine(item.quote, 6000);
      const source = debateCleanLine(item.source, 240);
      const url = debateCleanUrl(item.url);
      const means = debateCleanLines(item.means, 12, 500);
      if (!tag || !quote || !url) return null;
      const card = { tag, quote, url };
      if (summary) card.summary = summary;
      if (source) card.source = source;
      if (means.length) card.means = means;
      return card;
    })
    .filter(Boolean)
    .slice(0, 8);
}

function debateContentions(raw, max = 4) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const label = debateCleanLine(item.label, 12);
      const title = debateCleanLine(item.title, 160);
      const chain = debateCleanLines(item.chain, 64, 400);
      const cards = debateCards(item.cards);
      if (!title || (!chain.length && !cards.length)) return null;
      const contention = { title };
      if (label) contention.label = label;
      if (chain.length) contention.chain = chain;
      if (cards.length) contention.cards = cards;
      return contention;
    })
    .filter(Boolean)
    .slice(0, max);
}

function debateSide(raw) {
  if (!raw || typeof raw !== "object") return null;
  const framework = debateFramework(raw.framework);
  const definitions = debateDefinitions(raw.definitions);
  const contentions = debateContentions(raw.contentions);
  const blockfile = debateContentions(raw.blockfile, 12);
  if (!framework && !definitions.length && !contentions.length && !blockfile.length) {
    return null;
  }
  const side = {};
  if (framework) side.framework = framework;
  if (definitions.length) side.definitions = definitions;
  if (contentions.length) side.contentions = contentions;
  if (blockfile.length) side.blockfile = blockfile;
  return side;
}

/**
 * Aff/Neg speech stored on case.json. Drops anything that is not the
 * framework, definitions, contention cards, or the blockfile.
 * @param {object|null|undefined} props
 */
export function publicDebateCase(props) {
  if (!props || typeof props !== "object") return {};
  const resolution = debateCleanLine(props.resolution, 400);
  const aff = debateSide(props.aff);
  const neg = debateSide(props.neg);
  const out = {};
  if (resolution) out.resolution = resolution;
  if (aff) out.aff = aff;
  if (neg) out.neg = neg;
  return out;
}

/**
 * Debate (and later) cases live under projects/<id>/cases/<caseId>/case.json.
 * Todos nested under a case still belong to the project for home flatten.
 * @param {string} projectDir
 * @param {{ includeFixtures?: boolean, projectId?: string|null, officeOpen?: object }} opts
 */
async function loadProjectCases(
  projectDir,
  { includeFixtures = false, projectId = null, officeOpen = {} } = {}
) {
  const ids = await listDirs(join(projectDir, "cases"));
  /** @type {object[]} */
  const cases = [];
  /** @type {object[]} */
  const todos = [];
  for (const dirName of ids) {
    const id = objectDirId(dirName);
    if (!id) continue;
    const caseDir = join(projectDir, "cases", dirName);
    const props = await readJsonFile(join(caseDir, "case.json"));
    if (!props || typeof props !== "object") continue;
    const row = { id, ...props };
    if (!includeFixtures && isFixture(row)) continue;
    const caseTodos = await loadObjectFolder(join(caseDir, "todos"), "todo", {
      includeFixtures,
      projectId,
      officeOpen,
    });
    for (const t of caseTodos) {
      t.caseId = id;
      t.caseName = row.name || id;
    }
    todos.push(...caseTodos);
    if (isHiddenFromUi(row)) continue;
    cases.push({
      id,
      name: row.name || id,
      ...publicDebateCase(row),
    });
  }
  cases.sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
      sensitivity: "base",
    })
  );
  return { cases, todos };
}

export async function loadClassScopedObjects(entry, kind, opts) {
  const nestedName = kind === "todo" ? "todos" : "dates";
  /** @type {Map<string, object>} */
  const byId = new Map();
  const classFolder = entry.classFolder || entry.objectDir;
  const parents = [];
  if (classFolder) parents.push(classFolder);
  if (entry.objectDir) {
    const nested = join(entry.objectDir, nestedName);
    if (nested !== classFolder) parents.push(nested);
  }
  const loadOpts =
    kind === "todo" ? { ...opts, keepObjectDir: true } : opts;
  for (const parent of parents) {
    for (const item of await loadObjectFolder(parent, kind, loadOpts)) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  const items = [...byId.values()];
  if (kind === "todo") await applyTodoFileLinks(items, opts?.officeOpen || {});
  return items;
}

/**
 * Local YYYY-MM-DD in the schedule timezone (default America/Los_Angeles).
 * @param {object|null|undefined} schedule
 * @param {Date} [now]
 */
export function scheduleTodayKey(schedule, now = new Date()) {
  const tz = String(schedule?.timezone || "America/Los_Angeles");
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
}

/**
 * Clock parts in the schedule timezone (default America/Los_Angeles).
 * @param {object|null|undefined} schedule
 * @param {Date} [now]
 */
export function scheduleNowParts(schedule, now = new Date()) {
  const tz = String(schedule?.timezone || "America/Los_Angeles");
  const todayKey = scheduleTodayKey(schedule, now);
  const ymd = parseYmdParts(todayKey);
  /** @type {{ hour: number, minute: number }} */
  let hm = { hour: now.getHours(), minute: now.getMinutes() };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value);
    const minute = Number(parts.find((p) => p.type === "minute")?.value);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      hm = { hour, minute };
    }
  } catch {
    /* keep local */
  }
  return {
    ...(ymd || { y: now.getFullYear(), m: now.getMonth() + 1, day: now.getDate(), weekday: now.getDay() }),
    dateKey: todayKey,
    hour: hm.hour,
    minute: hm.minute,
    minutes: hm.hour * 60 + hm.minute,
    timezone: tz,
    iso: now.toISOString(),
  };
}

export function timeToMinutes(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes before class start that count as the active highlight, unless passing is shorter. */
export const CLASS_HIGHLIGHT_LEAD_MINUTES = 10;

/**
 * Highlight window start for one meeting in a day's sorted list.
 * First period: start minus lead. Passing shorter than lead: previous end.
 * Otherwise start minus lead (lunch and 15-minute passing stay 10 minutes).
 *
 * @param {{ startMin?: number|null, endMin?: number|null }[]} meetings
 * @param {number} index
 * @param {number} [leadMinutes]
 * @returns {number|null}
 */
export function meetingHighlightStartMin(
  meetings,
  index,
  leadMinutes = CLASS_HIGHLIGHT_LEAD_MINUTES
) {
  const meeting = Array.isArray(meetings) ? meetings[index] : null;
  if (!meeting || meeting.startMin == null || !Number.isFinite(meeting.startMin)) {
    return null;
  }
  const prevEnd = index > 0 ? meetings[index - 1]?.endMin : null;
  if (prevEnd == null || !Number.isFinite(prevEnd)) {
    return meeting.startMin - leadMinutes;
  }
  const gap = meeting.startMin - prevEnd;
  if (gap < leadMinutes) return prevEnd;
  return meeting.startMin - leadMinutes;
}

/**
 * @param {{ startMin?: number|null, endMin?: number|null }[]} meetings
 * @param {number} index
 * @param {number} nowMinutes
 * @param {number} [leadMinutes]
 */
export function isMeetingHighlighted(
  meetings,
  index,
  nowMinutes,
  leadMinutes = CLASS_HIGHLIGHT_LEAD_MINUTES
) {
  const meeting = Array.isArray(meetings) ? meetings[index] : null;
  if (!meeting || meeting.startMin == null || meeting.endMin == null) return false;
  const highlightStart = meetingHighlightStartMin(meetings, index, leadMinutes);
  if (highlightStart == null) return false;
  return nowMinutes >= highlightStart && nowMinutes < meeting.endMin;
}

/**
 * @param {{ startMin?: number|null, endMin?: number|null }[]} meetings
 * @param {number} nowMinutes
 * @param {number} [leadMinutes]
 */
export function activeMeetingAt(
  meetings,
  nowMinutes,
  leadMinutes = CLASS_HIGHLIGHT_LEAD_MINUTES
) {
  const list = Array.isArray(meetings) ? meetings : [];
  for (let i = 0; i < list.length; i++) {
    if (isMeetingHighlighted(list, i, nowMinutes, leadMinutes)) return list[i];
  }
  return null;
}

function nowContextClassPayload(meeting) {
  if (!meeting) return null;
  return {
    classId: meeting.classId,
    name: meeting.className,
    period: meeting.period,
    start: meeting.start,
    end: meeting.end,
    freePeriod: Boolean(meeting.freePeriod),
  };
}

function formatMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build today's classes (same rules as the Classes UI).
 * @param {object} schedule
 * @param {object[]} classes
 * @param {{ dateKey: string, weekday: number }} day
 * @param {Set<string>|null} allowedIds
 */
export function classesForDayParts(schedule, classes, day, allowedIds) {
  const visible = (classes || []).filter((c) => {
    if (isFixture(c)) return false;
    if (allowedIds) return allowedIds.has(c.id);
    return true;
  });

  function classForPeriod(period) {
    const letter = String(period || "").toUpperCase();
    if (!letter) return null;
    const dateKey = day?.dateKey || "";
    const matches = visible.filter(
      (c) => classPeriodOnDate(c, dateKey, schedule) === letter
    );
    if (!matches.length) return null;
    return matches.find((c) => !isFreePeriodClass(c)) || matches[0];
  }

  /** @type {object[]} */
  const out = [];
  const override = schedule?.dayOverrides?.[day.dateKey];
  const overrideSlots = Array.isArray(override?.slots)
    ? override.slots
    : Array.isArray(override?.meetings)
      ? override.meetings
      : null;

  if (overrideSlots) {
    for (const slot of overrideSlots) {
      const period = String(slot?.period || "").toUpperCase();
      if (!period) continue;
      const cls = classForPeriod(period);
      if (!cls) continue;
      const startMin = timeToMinutes(slot.start);
      const endMin = timeToMinutes(slot.end);
      out.push({
        classId: cls.id,
        className: cls.name || cls.id,
        freePeriod: isFreePeriodClass(cls),
        period,
        start: slot.start || formatMinutes(startMin),
        end: slot.end || formatMinutes(endMin),
        startMin,
        endMin,
      });
    }
  } else {
    const periods = Array.isArray(schedule?.weekdayPeriods?.[String(day.weekday)])
      ? schedule.weekdayPeriods[String(day.weekday)]
      : [];
    const bellList = Array.isArray(schedule?.bells)
      ? [...schedule.bells].sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
      : [];
    periods.forEach((periodRaw, i) => {
      const bell = bellList[i];
      if (!bell) return;
      const period = String(periodRaw || "").toUpperCase();
      const cls = classForPeriod(period);
      if (!cls) return;
      const startMin = timeToMinutes(bell.start);
      const endMin = timeToMinutes(bell.end);
      out.push({
        classId: cls.id,
        className: cls.name || cls.id,
        freePeriod: isFreePeriodClass(cls),
        period,
        start: bell.start || formatMinutes(startMin),
        end: bell.end || formatMinutes(endMin),
        startMin,
        endMin,
      });
    });
  }

  out.sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
  return out;
}

/**
 * Deterministic "am I in class right now?" from schedule.json + classes.
 * @param {string} email
 * @param {Date} [now]
 */
export async function resolveNowScheduleContext(email, now = new Date(), opts = {}) {
  const root = userEducationRoot(email, opts);
  const schedule = (await readJsonFile(join(root, "schedule.json"))) || {};
  const clock = scheduleNowParts(schedule, now);
  const schedulePdf =
    String(schedule.source || "").trim() ||
    "education/2026-27 Weekly Class Schedule.pdf";

  const classEntries = await listClassEntriesForRoot(root);
  /** @type {object[]} */
  const classes = [];
  for (const entry of classEntries) {
    const props = await readJsonFile(join(entry.objectDir, "class.json"));
    if (!props || typeof props !== "object") continue;
    const cls = { id: entry.id, ...props };
    if (isFixture(cls)) continue;
    if (!isClassActiveOnDate(cls, clock.dateKey, schedule)) continue;
    classes.push(cls);
  }

  const allowedIds = new Set(classes.map((c) => c.id));
  const isSchoolDay = isSchoolDayParts(
    { y: clock.y, m: clock.m, day: clock.day, weekday: clock.weekday },
    schedule
  );
  const todayClasses = isSchoolDay
    ? classesForDayParts(
        schedule,
        classes,
        { dateKey: clock.dateKey, weekday: clock.weekday },
        allowedIds
      )
    : [];

  const current = activeMeetingAt(todayClasses, clock.minutes);
  const inRoom = Boolean(
    current &&
      current.startMin != null &&
      current.endMin != null &&
      clock.minutes >= current.startMin &&
      clock.minutes < current.endMin
  );

  const next =
    todayClasses.find(
      (m) =>
        m.startMin != null &&
        m.startMin > clock.minutes &&
        m !== current
    ) || null;

  const previous =
    [...todayClasses]
      .reverse()
      .find(
        (m) =>
          m.endMin != null &&
          m.endMin <= clock.minutes &&
          m !== current
      ) || null;

  return {
    timezone: clock.timezone,
    dateKey: clock.dateKey,
    localTime: formatMinutes(clock.minutes),
    minutes: clock.minutes,
    isSchoolDay,
    inClass: Boolean(inRoom && current && !current.freePeriod),
    inFreePeriod: Boolean(inRoom && current?.freePeriod),
    currentClass: nowContextClassPayload(current),
    nextClass: nowContextClassPayload(next),
    previousClass: nowContextClassPayload(previous),
    todayClasses: todayClasses.map((m) => ({
      classId: m.classId,
      name: m.className,
      period: m.period,
      start: m.start,
      end: m.end,
      freePeriod: Boolean(m.freePeriod),
    })),
    schedulePdf,
    scheduleJson: `education/${canonicalizeEmail(email)}/schedule.json`,
  };
}

export function parseYmdParts(dateKey) {
  const m = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {
    return null;
  }
  return { y, m: mo, day: d, weekday: dt.getDay() };
}

export function addDaysParts(parts, delta) {
  const dt = new Date(parts.y, parts.m - 1, parts.day + delta);
  return {
    y: dt.getFullYear(),
    m: dt.getMonth() + 1,
    day: dt.getDate(),
    weekday: dt.getDay(),
  };
}

function ymdParts(parts) {
  return `${parts.y}-${String(parts.m).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isSchoolDayParts(parts, schedule) {
  if (parts.weekday === 0 || parts.weekday === 6) return false;
  const key = ymdParts(parts);
  const closed = Array.isArray(schedule?.closedDates)
    ? new Set(schedule.closedDates.map(String))
    : new Set();
  if (closed.has(key)) return false;
  const start = schedule?.schoolStart ? String(schedule.schoolStart) : "";
  const end = schedule?.schoolEnd ? String(schedule.schoolEnd) : "";
  if (start && key < start) return false;
  if (end && key > end) return false;
  return true;
}

function nextSchoolDayParts(from, schedule, skipToday = true) {
  let cur = skipToday ? addDaysParts(from, 1) : { ...from };
  for (let i = 0; i < 120; i++) {
    if (isSchoolDayParts(cur, schedule)) return cur;
    cur = addDaysParts(cur, 1);
  }
  return null;
}

/**
 * Dates the Classes panels may show. Always include today (if a school day)
 * plus the next two school days so the client can roll past last-bell+15
 * without a refetch. A–H days still render as one panel on the client.
 */
export function uiPanelDateKeys(schedule, todayKey) {
  const now = parseYmdParts(todayKey);
  if (!now) return [todayKey];
  /** @type {string[]} */
  const keys = [];
  const seen = new Set();
  const push = (parts) => {
    if (!parts) return;
    const key = ymdParts(parts);
    if (seen.has(key)) return;
    seen.add(key);
    keys.push(key);
  };
  if (isSchoolDayParts(now, schedule)) push(now);
  const day1 = nextSchoolDayParts(now, schedule, true);
  push(day1);
  if (day1) push(nextSchoolDayParts(day1, schedule, true));
  return keys.length ? keys : [todayKey];
}

/** Keep trimester ranges on the client so period maps resolve per day. */
function publicSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return {};
  return { ...schedule };
}

function publicClassProps(cls, dateKey, schedule) {
  if (!cls || typeof cls !== "object") return cls;
  const { trimester, period, periods, ...rest } = cls;
  const map = classPeriodsMap(cls);
  const letter = classPeriodOnDate(cls, dateKey, schedule);
  /** @type {Record<string, unknown>} */
  const out = { ...rest, period: letter || undefined };
  if (map) out.periods = map;
  return out;
}

/**
 * Home clients flatten `class.todos`. Keep hiddenFromHome items on
 * `classOnlyTodos` so older home lists omit them while class pages can merge.
 * @param {object[]} todos
 */
export function partitionClassTodos(todos) {
  /** @type {object[]} */
  const home = [];
  /** @type {object[]} */
  const classOnly = [];
  for (const t of todos || []) {
    if (t && t.hiddenFromHome === true) classOnly.push(t);
    else home.push(t);
  }
  return { home, classOnly };
}

/**
 * @param {string} email
 * @param {{ includeFixtures?: boolean }} [opts]
 *   When false (default), strip fixture + out-of-season classes for the web UI
 *   and omit trimester fields. Agents still read on-disk trees directly.
 */
export async function readEducationTree(email, { includeFixtures = false, workspace = "" } = {}) {
  const root = userEducationRoot(email, { workspace });
  const meta = (await readJsonFile(join(root, "meta.json"))) || {};
  const schedule = (await readJsonFile(join(root, "schedule.json"))) || {};
  const todayKey = scheduleTodayKey(schedule);
  const panelKeys = includeFixtures ? [] : uiPanelDateKeys(schedule, todayKey);
  const officeOpen = officeOpenOptsFromMeta(meta);

  const todos = await loadObjectFolder(join(root, "todos"), "todo", {
    includeFixtures,
    officeOpen,
  });
  const dates = await loadObjectFolder(join(root, "dates"), "date", {
    includeFixtures,
    officeOpen,
  });

  const classEntries = await listClassEntriesForRoot(root);
  /** @type {object[]} */
  const classes = [];
  /** @type {Record<string, string[]>} */
  const activeClassIdsByDate = {};
  const gradeDir = gradeDirFromMeta(meta);
  const driveFolderNames = gradeDir
    ? await listOnedriveFolderNames(gradeDir, { includeHidden: true })
    : [];

  for (const entry of classEntries) {
    const classId = entry.id;
    const classDir = entry.objectDir;
    const props = await readClassProps(classDir);
    if (!props || typeof props !== "object") continue;
    const cls = { id: classId, ...props };
    if (!includeFixtures && isFixture(cls)) continue;

    const activeToday = includeFixtures
      ? true
      : isClassInSeasonToday(cls, todayKey, schedule);
    const panelDates = includeFixtures
      ? []
      : panelKeys.filter((k) => isClassActiveOnDate(cls, k, schedule));
    if (!includeFixtures && !activeToday && panelDates.length === 0) continue;

    for (const k of panelDates) {
      if (!activeClassIdsByDate[k]) activeClassIdsByDate[k] = [];
      activeClassIdsByDate[k].push(classId);
    }

    const classTodos = await loadClassScopedObjects(entry, "todo", {
      includeFixtures,
      classId,
      officeOpen,
    });
    const classDates = await loadClassScopedObjects(entry, "date", {
      includeFixtures,
      classId,
      officeOpen,
    });
    const fileOpts = {
      ...contextFileListOpts(props),
      ...officeOpen,
    };
    const eduFiles = await listContextFiles(classDir, {
      ...fileOpts,
      skipPin: true,
    });
    let driveFiles = [];
    const driveFolder =
      entry.onedriveFolder || matchOnedriveFolder(props, driveFolderNames);
    if (gradeDir && driveFolder) {
      driveFiles = await listOnedriveTree(join(gradeDir, driveFolder), {
        hiddenNames: fileOpts.hiddenNames,
        visibleNames: fileOpts.visibleNames,
        ...officeOpen,
      });
    }
    const classFiles = pinContextFileOrder(
      [...siteFilesFromProps(props), ...mergeContextFileLists(eduFiles, driveFiles)],
      fileOpts.topNames,
      fileOpts.bottomNames
    );

    const published = includeFixtures
      ? cls
      : publicClassProps(cls, todayKey, schedule);
    const { home: homeTodos, classOnly: classOnlyTodos } =
      partitionClassTodos(classTodos);
    /** @type {Record<string, unknown>} */
    const classRow = {
      ...published,
      files: classFiles,
      // Todos/dates only when the class is in season for today.
      todos: activeToday ? homeTodos : [],
      dates: activeToday ? classDates : [],
    };
    if (activeToday && classOnlyTodos.length) {
      classRow.classOnlyTodos = classOnlyTodos;
    }
    if (driveFolder) classRow.onedriveFolder = driveFolder;
    classes.push(classRow);
  }

  if (!includeFixtures) {
    pruneFreePeriodsWhenOccupied(activeClassIdsByDate, classes, schedule);
  }

  const projectIds = await listDirs(join(root, "projects"));
  /** @type {object[]} */
  const projects = [];
  for (const projectId of projectIds) {
    const projectDir = join(root, "projects", projectId);
    const projectJson = join(projectDir, "project.json");
    const props = await readJsonFile(projectJson);
    if (!props || typeof props !== "object") continue;
    const project = { id: projectId, ...props };
    if (isHiddenFromUi(project)) continue;
    if (!includeFixtures && isFixture(project)) continue;

    let birthMs = 0;
    try {
      const st = await stat(projectJson);
      birthMs = Number(st.birthtimeMs) || Number(st.ctimeMs) || 0;
    } catch {
      /* skip */
    }

    const projectTodos = await loadObjectFolder(
      join(projectDir, "todos"),
      "todo",
      { includeFixtures, projectId, officeOpen }
    );
    const projectDates = await loadObjectFolder(
      join(projectDir, "dates"),
      "date",
      { includeFixtures, projectId, officeOpen }
    );
    const { cases: projectCases, todos: caseTodos } = await loadProjectCases(
      projectDir,
      { includeFixtures, projectId, officeOpen }
    );
    const projectFiles = [
      ...siteFilesFromProps(props),
      ...(await listContextFiles(projectDir, {
        ...contextFileListOpts(props),
        ...officeOpen,
      })),
    ];
    projects.push({
      ...project,
      _birthMs: birthMs,
      files: projectFiles,
      todos: [...projectTodos, ...caseTodos],
      dates: projectDates,
      ...(projectCases.length ? { cases: projectCases } : {}),
    });
  }
  const openedAt = mergeCreateOpenedAt(await readProjectsOpened(root), projects);
  const sortedProjects = sortEducationProjects(
    projects.map(({ _birthMs, ...rest }) => rest),
    {
      projectsTop: meta.projectsTop,
      projectsBottom: meta.projectsBottom,
      openedAt,
    }
  );

  let nowContext = null;
  if (!includeFixtures) {
    try {
      nowContext = await resolveNowScheduleContext(email, new Date(), { workspace });
    } catch (err) {
      console.error("[education-data] nowContext", err);
    }
  }

  const tree = {
    email: canonicalizeEmail(email),
    meta,
    schedule: includeFixtures ? schedule : publicSchedule(schedule),
    todos,
    dates,
    classes,
    projects: sortedProjects,
    ...(includeFixtures
      ? {}
      : { activeClassIdsByDate, todayKey, ...(nowContext ? { nowContext } : {}) }),
  };

  if (!includeFixtures) {
    try {
      const snapPath = join(root, ".canvas", "snapshot.json");
      const mapPath = join(root, ".canvas", "course-map.json");
      const snapRaw = await readFile(snapPath, "utf8").catch(() => "");
      if (snapRaw) {
        const snapshot = JSON.parse(snapRaw);
        const mapRaw = await readFile(mapPath, "utf8").catch(() => "");
        const courseMap = mapRaw ? JSON.parse(mapRaw) : null;
        attachCanvasOverlay(tree, snapshot, courseMap);
      }
    } catch (err) {
      console.error("[education-data] canvas grades", err);
    }
  }

  return tree;
}

function isSafeObjectId(id) {
  const s = String(id || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return null;
  return s;
}

/**
 * Find a todo.json by id under the user's tree (user-level, class, or project).
 * When classId / projectId is set, only that folder is checked (avoids id collisions).
 * @param {string} email
 * @param {string} todoId
 * @param {{ classId?: string|null, projectId?: string|null }} [opts]
 * @returns {Promise<{ path: string, props: object, classId: string|null, projectId: string|null }|null>}
 */
export async function findTodo(
  email,
  todoId,
  { classId = null, projectId = null, workspace = "" } = {}
) {
  const root = userEducationRoot(email, { workspace });
  const id = isSafeObjectId(todoId);
  if (!id) return null;

  const scopedClass =
    classId == null || classId === "" ? null : isSafeObjectId(classId);
  if (classId != null && classId !== "" && !scopedClass) return null;

  const scopedProject =
    projectId == null || projectId === "" ? null : isSafeObjectId(projectId);
  if (projectId != null && projectId !== "" && !scopedProject) return null;

  /** @type {string[]} */
  const candidates = [];
  if (scopedProject) {
    candidates.push(
      join(root, "projects", scopedProject, "todos", id, "todo.json")
    );
  } else if (scopedClass) {
    const entry = await classEntryForRoot(root, scopedClass);
    if (entry) {
      const classFolder = entry.classFolder || entry.objectDir;
      for (const folder of objectFolderPaths(classFolder, id)) {
        candidates.push(join(folder, "todo.json"));
      }
      for (const folder of objectFolderPaths(join(entry.objectDir, "todos"), id)) {
        candidates.push(join(folder, "todo.json"));
      }
    } else {
      candidates.push(
        join(root, "classes", scopedClass, "todos", id, "todo.json")
      );
    }
  } else {
    candidates.push(join(root, "todos", id, "todo.json"));
    for (const entry of await listClassEntriesForRoot(root)) {
      const classFolder = entry.classFolder || entry.objectDir;
      for (const folder of objectFolderPaths(classFolder, id)) {
        candidates.push(join(folder, "todo.json"));
      }
      for (const folder of objectFolderPaths(join(entry.objectDir, "todos"), id)) {
        candidates.push(join(folder, "todo.json"));
      }
    }
    const projectIds = await listDirs(join(root, "projects"));
    for (const pid of projectIds) {
      candidates.push(join(root, "projects", pid, "todos", id, "todo.json"));
    }
  }

  for (const path of candidates) {
    const resolved = await resolveBookkeepingFile(dirname(path), basename(path));
    const props = resolved ? await readJsonFile(resolved) : null;
    if (props && typeof props === "object") {
      let resolvedClass = scopedClass;
      let resolvedProject = scopedProject;
      if (!resolvedClass && !resolvedProject) {
        const entries = await listClassEntriesForRoot(root);
        const hit = entries.find((e) => {
          const classFolder = e.classFolder || e.objectDir;
          return (
            resolved.startsWith(classFolder + "/") ||
            resolved.startsWith(e.objectDir + "/")
          );
        });
        if (hit) resolvedClass = hit.id;
        const pm = resolved.match(/\/projects\/([^/]+)\/todos\//);
        if (pm) resolvedProject = pm[1];
      }
      return {
        path: resolved,
        props,
        classId: resolvedClass,
        projectId: resolvedProject,
      };
    }
  }
  return null;
}

/**
 * @param {string} email
 * @param {string} todoId
 * @param {boolean} done
 * @param {{ classId?: string|null, projectId?: string|null }} [opts]
 */
export async function setTodoDone(
  email,
  todoId,
  done,
  { classId = null, projectId = null, workspace = "" } = {}
) {
  const found = await findTodo(email, todoId, { classId, projectId, workspace });
  if (!found) {
    const err = new Error("todo not found");
    err.status = 404;
    throw err;
  }
  if (isFixture({ id: todoId, ...found.props })) {
    const err = new Error("fixture todos are read-only");
    err.status = 403;
    throw err;
  }
  const next = { ...found.props, done: Boolean(done) };
  if (done) {
    next.completedAt = new Date().toISOString();
  } else {
    delete next.completedAt;
  }
  await writeFile(found.path, JSON.stringify(next, null, 2) + "\n", "utf8");
  queueOnedriveVisibility(email);

  const rel = found.path.startsWith(ROOT + "/")
    ? found.path.slice(ROOT.length + 1)
    : null;
  const scope = found.projectId
    ? ` project=${found.projectId}`
    : found.classId
      ? ` class=${found.classId}`
      : "";
  if (rel) {
    gitAddCommitPush({
      paths: [rel],
      message: `education: set todo ${todoId}${scope} done=${Boolean(done)}`,
    }).catch((err) => console.error("[education-data] git publish", err));
  }

  return next;
}

/**
 * Record that a project was opened (web/iOS click) or created (agent).
 * Does not git commit.
 * @param {string} email
 * @param {string} projectId
 */
export async function markProjectOpened(email, projectId, opts = {}) {
  const root = userEducationRoot(email, opts);
  const id = isSafeObjectId(projectId);
  if (!id) {
    const err = new Error("invalid project id");
    err.status = 400;
    throw err;
  }
  const props = await readJsonFile(join(root, "projects", id, "project.json"));
  if (!props || typeof props !== "object") {
    const err = new Error("project not found");
    err.status = 404;
    throw err;
  }
  if (isFixture({ id, ...props })) {
    const err = new Error("fixture projects are read-only");
    err.status = 403;
    throw err;
  }
  const opened = await readProjectsOpened(root);
  const lastOpenedAt = new Date().toISOString();
  opened[id] = lastOpenedAt;
  await writeFile(
    join(root, PROJECTS_OPENED_FILE),
    JSON.stringify(opened, null, 2) + "\n",
    "utf8"
  );
  return { id, lastOpenedAt };
}

/**
 * @param {unknown} raw
 * @returns {"up"|"down"|null}
 */
function normalizeCapsuleVote(raw) {
  if (raw == null || raw === "" || raw === false) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "up" || s === "down") return s;
  if (s === "null" || s === "none" || s === "clear") return null;
  const err = new Error("vote must be up, down, or null");
  err.status = 400;
  throw err;
}

function isSafeCapsuleId(id) {
  const s = String(id || "").trim();
  if (!s || s.includes("..") || s.includes("/") || s.includes("\\")) return null;
  return s;
}

/**
 * Set thumbs on a daily-briefing capsule. `vote` null is the neutral rating
 * (neither thumb), not missing data.
 * @param {string} email
 * @param {string} todoId
 * @param {string} capsuleId
 * @param {unknown} vote
 * @param {{ classId?: string|null, projectId?: string|null }} [opts]
 */
export async function setCapsuleVote(
  email,
  todoId,
  capsuleId,
  vote,
  { classId = null, projectId = null, workspace = "" } = {}
) {
  const capId = isSafeCapsuleId(capsuleId);
  if (!capId) {
    const err = new Error("invalid capsule id");
    err.status = 400;
    throw err;
  }
  const nextVote = normalizeCapsuleVote(vote);
  const found = await findTodo(email, todoId, { classId, projectId, workspace });
  if (!found) {
    const err = new Error("todo not found");
    err.status = 404;
    throw err;
  }
  if (isFixture({ id: todoId, ...found.props })) {
    const err = new Error("fixture todos are read-only");
    err.status = 403;
    throw err;
  }
  const capsules = Array.isArray(found.props.capsules)
    ? found.props.capsules.map((c) =>
        c && typeof c === "object" ? { ...c } : c
      )
    : [];
  const idx = capsules.findIndex(
    (c) => c && typeof c === "object" && String(c.id) === capId
  );
  if (idx < 0) {
    const err = new Error("capsule not found");
    err.status = 404;
    throw err;
  }
  if (capsules[idx]?.noVote === true) {
    const err = new Error("capsule is not votable");
    err.status = 403;
    throw err;
  }
  capsules[idx] = { ...capsules[idx], vote: nextVote };
  const next = { ...found.props, capsules };
  await writeFile(found.path, JSON.stringify(next, null, 2) + "\n", "utf8");

  const rel = found.path.startsWith(ROOT + "/")
    ? found.path.slice(ROOT.length + 1)
    : null;
  if (rel) {
    gitAddCommitPush({
      paths: [rel],
      message: `education: set todo ${todoId} capsule ${capId} vote=${nextVote || "none"}`,
    }).catch((err) => console.error("[education-data] git publish", err));
  }

  return next;
}

/**
 * @param {string} email
 * @returns {Promise<number>} mtime ms of user tree root (best-effort)
 */
export async function userTreeMtime(email, opts = {}) {
  const root = userEducationRoot(email, opts);
  try {
    const s = await stat(root);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

export { ROOT as REPO_ROOT };

function queueOnedriveVisibility(email) {
  import("./education-onedrive-visibility.js")
    .then((m) => m.syncOnedriveObjectVisibility(email))
    .catch((err) => console.error("[onedrive-visibility]", err));
}
