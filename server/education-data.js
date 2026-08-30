/**
 * File-backed education OS reader / todo.done writer.
 * Roots: education/<email>/ under the repo.
 */

import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gitAddCommitPush } from "./git-publish.js";
import {
  canonicalizeEmail,
  isFullAccessEmail,
  FULL_ACCESS_EMAILS,
} from "./identity.js";

/** Property JSON filenames that are never treated as context files. */
const PROPERTY_JSON = new Set([
  "class.json",
  "project.json",
  "todo.json",
  "date.json",
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
function pinContextFileOrder(files, topNames, bottomNames) {
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
 * @param {object} project
 */
function projectOrderNum(project) {
  const n = Number(project?.order);
  return Number.isFinite(n) ? n : 9999;
}

/**
 * Projects panel order: pinned top, then newest last-opened, then pinned bottom.
 * Never-opened projects keep leftover `order` (then A-Z). A pin in both lists
 * stays on top. Missing names are skipped. Pins match folder id or display name.
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
 * }} [opts]
 * @returns {Promise<{ name: string, size: number, mtime: string }[]>}
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
  const visible = out
    .filter((f) => !hiddenSet.has(f.name.toLowerCase()))
    .map(({ name, size, mtime }) => ({ name, size, mtime }));
  return pinContextFileOrder(visible, opts?.topNames, opts?.bottomNames);
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
 * }} opts
 * @returns {Promise<{ path: string, name: string, size: number, mtime: string }>}
 */
export async function resolveContextFile(email, opts) {
  const root = userEducationRoot(email);
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
  if (scope === "user") {
    folder = root;
  } else if (scope === "class") {
    if (!id) {
      const err = new Error("class id required");
      err.status = 400;
      throw err;
    }
    folder = join(root, "classes", id);
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
      folder = join(root, "classes", classId, "todos", id);
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
      folder = join(root, "classes", classId, "dates", id);
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
  if (absFolder !== absRoot && !absFolder.startsWith(absRoot + sep)) {
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

/** @param {string} email */
export function userEducationRoot(email) {
  const normalized = canonicalizeEmail(email);
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

async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err && (err.code === "ENOENT" || err instanceof SyntaxError)) return null;
    throw err;
  }
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
 * Fixture trees stay on disk for agents; UI/API consumers hide them.
 * @param {{ id?: string, fixture?: boolean }|null|undefined} obj
 */
export function isFixture(obj) {
  if (!obj || typeof obj !== "object") return false;
  if (obj.fixture === true) return true;
  const id = String(obj.id || "");
  return id.startsWith("_example-");
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
function pruneFreePeriodsWhenOccupied(activeClassIdsByDate, classes) {
  const byId = new Map(classes.map((c) => [c.id, c]));
  for (const dateKey of Object.keys(activeClassIdsByDate)) {
    const ids = activeClassIdsByDate[dateKey];
    const occupied = new Set();
    for (const id of ids) {
      const c = byId.get(id);
      if (!c || isFreePeriodClass(c)) continue;
      const p = String(c.period || "").toUpperCase();
      if (p) occupied.add(p);
    }
    activeClassIdsByDate[dateKey] = ids.filter((id) => {
      const c = byId.get(id);
      if (!c || !isFreePeriodClass(c)) return true;
      const p = String(c.period || "").toUpperCase();
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

async function loadObjectFolder(
  parentDir,
  kind,
  { includeFixtures = false, classId = null, projectId = null } = {}
) {
  const ids = await listDirs(parentDir);
  const fileName = kind === "todo" ? "todo.json" : "date.json";
  /** @type {object[]} */
  const out = [];
  for (const id of ids) {
    const objectDir = join(parentDir, id);
    const jsonPath = join(objectDir, fileName);
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
    }
    if (!includeFixtures && isFixture(item)) continue;
    item.files = await listContextFiles(objectDir, contextFileListOpts(props));
    out.push(item);
  }
  return out;
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

function timeToMinutes(t) {
  const m = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
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
function classesForDayParts(schedule, classes, day, allowedIds) {
  const visible = (classes || []).filter((c) => {
    if (isFixture(c)) return false;
    if (allowedIds) return allowedIds.has(c.id);
    return true;
  });

  function classForPeriod(period) {
    const letter = String(period || "").toUpperCase();
    if (!letter) return null;
    const matches = visible.filter(
      (c) => String(c.period || "").toUpperCase() === letter
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
export async function resolveNowScheduleContext(email, now = new Date()) {
  const root = userEducationRoot(email);
  const schedule = (await readJsonFile(join(root, "schedule.json"))) || {};
  const clock = scheduleNowParts(schedule, now);
  const schedulePdf =
    String(schedule.source || "").trim() ||
    "education/2026-27 Weekly Class Schedule.pdf";

  const classIds = await listDirs(join(root, "classes"));
  /** @type {object[]} */
  const classes = [];
  for (const classId of classIds) {
    const props = await readJsonFile(join(root, "classes", classId, "class.json"));
    if (!props || typeof props !== "object") continue;
    const cls = { id: classId, ...props };
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

  const current =
    todayClasses.find(
      (m) =>
        m.startMin != null &&
        m.endMin != null &&
        clock.minutes >= m.startMin &&
        clock.minutes < m.endMin
    ) || null;

  const next =
    todayClasses.find(
      (m) => m.startMin != null && m.startMin > clock.minutes
    ) || null;

  const previous =
    [...todayClasses]
      .reverse()
      .find((m) => m.endMin != null && m.endMin <= clock.minutes) || null;

  return {
    timezone: clock.timezone,
    dateKey: clock.dateKey,
    localTime: formatMinutes(clock.minutes),
    minutes: clock.minutes,
    isSchoolDay,
    inClass: Boolean(current && !current.freePeriod),
    inFreePeriod: Boolean(current?.freePeriod),
    currentClass: current
      ? {
          classId: current.classId,
          name: current.className,
          period: current.period,
          start: current.start,
          end: current.end,
          freePeriod: Boolean(current.freePeriod),
        }
      : null,
    nextClass: next
      ? {
          classId: next.classId,
          name: next.className,
          period: next.period,
          start: next.start,
          end: next.end,
          freePeriod: Boolean(next.freePeriod),
        }
      : null,
    previousClass: previous
      ? {
          classId: previous.classId,
          name: previous.className,
          period: previous.period,
          start: previous.start,
          end: previous.end,
          freePeriod: Boolean(previous.freePeriod),
        }
      : null,
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

function parseYmdParts(dateKey) {
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

function addDaysParts(parts, delta) {
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

function isSchoolDayParts(parts, schedule) {
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

/** Dates the Classes panels may show (today + following school day, or next two). */
function uiPanelDateKeys(schedule, todayKey) {
  const now = parseYmdParts(todayKey);
  if (!now) return [todayKey];
  const todayIsSchool = isSchoolDayParts(now, schedule);
  /** @type {string[]} */
  const keys = [];
  let day1;
  let day2;
  if (todayIsSchool) {
    day1 = now;
    day2 = nextSchoolDayParts(now, schedule, true);
  } else {
    day1 = nextSchoolDayParts(now, schedule, true);
    day2 = day1 ? nextSchoolDayParts(day1, schedule, true) : null;
  }
  if (day1) keys.push(ymdParts(day1));
  const override = schedule?.dayOverrides?.[keys[0]];
  if (override?.allPeriods) return keys;
  if (day2) keys.push(ymdParts(day2));
  return keys.length ? keys : [todayKey];
}

/** Strip trimester metadata before sending the tree to the web UI. */
function publicSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") return {};
  const { trimesters, ...rest } = schedule;
  return rest;
}

function publicClassProps(cls) {
  if (!cls || typeof cls !== "object") return cls;
  const { trimester, ...rest } = cls;
  return rest;
}

/**
 * @param {string} email
 * @param {{ includeFixtures?: boolean }} [opts]
 *   When false (default), strip fixture + out-of-season classes for the web UI
 *   and omit trimester fields. Agents still read on-disk trees directly.
 */
export async function readEducationTree(email, { includeFixtures = false } = {}) {
  const root = userEducationRoot(email);
  const meta = (await readJsonFile(join(root, "meta.json"))) || {};
  const schedule = (await readJsonFile(join(root, "schedule.json"))) || {};
  const todayKey = scheduleTodayKey(schedule);
  const panelKeys = includeFixtures ? [] : uiPanelDateKeys(schedule, todayKey);

  const todos = await loadObjectFolder(join(root, "todos"), "todo", {
    includeFixtures,
  });
  const dates = await loadObjectFolder(join(root, "dates"), "date", {
    includeFixtures,
  });

  const classIds = await listDirs(join(root, "classes"));
  /** @type {object[]} */
  const classes = [];
  /** @type {Record<string, string[]>} */
  const activeClassIdsByDate = {};

  for (const classId of classIds) {
    const classDir = join(root, "classes", classId);
    const props = await readJsonFile(join(classDir, "class.json"));
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

    const classTodos = await loadObjectFolder(join(classDir, "todos"), "todo", {
      includeFixtures,
      classId,
    });
    const classDates = await loadObjectFolder(join(classDir, "dates"), "date", {
      includeFixtures,
      classId,
    });
    const classFiles = await listContextFiles(
      classDir,
      contextFileListOpts(props)
    );

    const published = includeFixtures ? cls : publicClassProps(cls);
    classes.push({
      ...published,
      files: classFiles,
      // Todos/dates only when the class is in season for today.
      todos: activeToday ? classTodos : [],
      dates: activeToday ? classDates : [],
    });
  }

  if (!includeFixtures) {
    pruneFreePeriodsWhenOccupied(activeClassIdsByDate, classes);
  }

  const projectIds = await listDirs(join(root, "projects"));
  /** @type {object[]} */
  const projects = [];
  for (const projectId of projectIds) {
    const projectDir = join(root, "projects", projectId);
    const props = await readJsonFile(join(projectDir, "project.json"));
    if (!props || typeof props !== "object") continue;
    const project = { id: projectId, ...props };
    if (!includeFixtures && isFixture(project)) continue;

    const projectTodos = await loadObjectFolder(
      join(projectDir, "todos"),
      "todo",
      { includeFixtures, projectId }
    );
    const projectDates = await loadObjectFolder(
      join(projectDir, "dates"),
      "date",
      { includeFixtures, projectId }
    );
    const projectFiles = await listContextFiles(
      projectDir,
      contextFileListOpts(props)
    );
    projects.push({
      ...project,
      files: projectFiles,
      todos: projectTodos,
      dates: projectDates,
    });
  }
  const openedAt = await readProjectsOpened(root);
  const sortedProjects = sortEducationProjects(projects, {
    projectsTop: meta.projectsTop,
    projectsBottom: meta.projectsBottom,
    openedAt,
  });

  let nowContext = null;
  if (!includeFixtures) {
    try {
      nowContext = await resolveNowScheduleContext(email);
    } catch (err) {
      console.error("[education-data] nowContext", err);
    }
  }

  return {
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
  { classId = null, projectId = null } = {}
) {
  const root = userEducationRoot(email);
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
    candidates.push(join(root, "classes", scopedClass, "todos", id, "todo.json"));
  } else {
    candidates.push(join(root, "todos", id, "todo.json"));
    const classIds = await listDirs(join(root, "classes"));
    for (const cid of classIds) {
      candidates.push(join(root, "classes", cid, "todos", id, "todo.json"));
    }
    const projectIds = await listDirs(join(root, "projects"));
    for (const pid of projectIds) {
      candidates.push(join(root, "projects", pid, "todos", id, "todo.json"));
    }
  }

  for (const path of candidates) {
    const props = await readJsonFile(path);
    if (props && typeof props === "object") {
      let resolvedClass = scopedClass;
      let resolvedProject = scopedProject;
      if (!resolvedClass && !resolvedProject) {
        const cm = path.match(/\/classes\/([^/]+)\/todos\//);
        if (cm) resolvedClass = cm[1];
        const pm = path.match(/\/projects\/([^/]+)\/todos\//);
        if (pm) resolvedProject = pm[1];
      }
      return {
        path,
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
  { classId = null, projectId = null } = {}
) {
  const found = await findTodo(email, todoId, { classId, projectId });
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

  const rel = found.path.startsWith(ROOT + "/")
    ? found.path.slice(ROOT.length + 1)
    : found.path;
  const scope = found.projectId
    ? ` project=${found.projectId}`
    : found.classId
      ? ` class=${found.classId}`
      : "";
  gitAddCommitPush({
    paths: [rel],
    message: `education: set todo ${todoId}${scope} done=${Boolean(done)}`,
  }).catch((err) => console.error("[education-data] git publish", err));

  return next;
}

/**
 * Record that the signed-in user opened a project (web or iOS). Does not git commit.
 * @param {string} email
 * @param {string} projectId
 */
export async function markProjectOpened(email, projectId) {
  const root = userEducationRoot(email);
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
  { classId = null, projectId = null } = {}
) {
  const capId = isSafeCapsuleId(capsuleId);
  if (!capId) {
    const err = new Error("invalid capsule id");
    err.status = 400;
    throw err;
  }
  const nextVote = normalizeCapsuleVote(vote);
  const found = await findTodo(email, todoId, { classId, projectId });
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
    : found.path;
  gitAddCommitPush({
    paths: [rel],
    message: `education: set todo ${todoId} capsule ${capId} vote=${nextVote || "none"}`,
  }).catch((err) => console.error("[education-data] git publish", err));

  return next;
}

/**
 * @param {string} email
 * @returns {Promise<number>} mtime ms of user tree root (best-effort)
 */
export async function userTreeMtime(email) {
  const root = userEducationRoot(email);
  try {
    const s = await stat(root);
    return s.mtimeMs;
  } catch {
    return 0;
  }
}

export { ROOT as REPO_ROOT };
