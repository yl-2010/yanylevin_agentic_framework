/**
 * School OneDrive class folders (Mac CloudStorage path in meta.json).
 * Dashboard class file tiles list these live; bytes stay in OneDrive.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";

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
 * Finder names for OneDrive bookkeeping. Leading dot hides the file.
 * Plain names still resolve so a writer that has not caught up keeps working.
 * @param {string} fileName
 * @returns {string[]}
 */
export function bookkeepingBasenames(fileName) {
  const plain = String(fileName || "").replace(/^\.+/, "");
  const lower = plain.toLowerCase();
  if (lower === "context.md") {
    return [".CONTEXT.md", ".context.md", "CONTEXT.md", "context.md"];
  }
  if (lower === "deleted.md") {
    return [".deleted.md", ".DELETED.md", "deleted.md"];
  }
  if (!plain) return [];
  return [`.${plain}`, plain];
}

/**
 * @param {string} dir
 * @param {string} fileName todo.json, date.json, CONTEXT.md, deleted.md
 * @returns {Promise<string|null>}
 */
export async function resolveBookkeepingFile(dir, fileName) {
  if (!dir) return null;
  for (const name of bookkeepingBasenames(fileName)) {
    const path = join(dir, name);
    try {
      const st = await stat(path);
      if (st.isFile()) return path;
    } catch {
      /* missing */
    }
  }
  return null;
}

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

const URL_TILE_MAX_BYTES = 8192;
const URL_TILE_KEYS = new Set([
  "kind",
  "url",
  "href",
  "name",
  "title",
  "weburl",
  "webviewurl",
]);

/**
 * Link-only file tile. Click opens the URL. No download.
 * Accepts `kind: "url"` or an object that is only name/title + url/href.
 * @param {unknown} obj
 * @param {string} [fallbackName]
 * @returns {{ name: string, kind: string, url: string, webUrl: string, webViewUrl: string }|null}
 */
export function urlTileFromObject(obj, fallbackName) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const url = String(obj.url || obj.href || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const kind = String(obj.kind || "").trim().toLowerCase();
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  const onlyLinkKeys = keys.every((k) => URL_TILE_KEYS.has(k));
  if (kind !== "url" && !onlyLinkKeys) return null;
  const name =
    String(obj.name || obj.title || fallbackName || url).trim() || url;
  return {
    name,
    kind: "url",
    url,
    webUrl: url,
    webViewUrl: url,
  };
}

/**
 * Windows/macOS Internet Shortcut (`.url`).
 * @param {unknown} text
 * @param {string} [fallbackName]
 */
export function urlTileFromInternetShortcut(text, fallbackName) {
  const m = String(text || "").match(/^\s*URL\s*=\s*(\S+)/im);
  if (!m) return null;
  const url = String(m[1] || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const name = String(fallbackName || url).trim() || url;
  return {
    name,
    kind: "url",
    url,
    webUrl: url,
    webViewUrl: url,
  };
}

/**
 * Dropped `.json` link stub or `.url` shortcut in a class/project/todo/date folder.
 * @param {string} abs
 * @param {string} name
 * @param {object} [extra]
 */
export async function urlTileFromDroppedFile(abs, name, extra = {}) {
  const base = String(name || "").trim();
  const lower = base.toLowerCase();
  if (!lower.endsWith(".json") && !lower.endsWith(".url")) return null;
  try {
    const st = await stat(abs);
    if (!st.isFile() || st.size > URL_TILE_MAX_BYTES) return null;
    const text = await readFile(abs, "utf8");
    const fallback = base.replace(/\.(json|url)$/i, "");
    const tile = lower.endsWith(".json")
      ? urlTileFromObject(JSON.parse(text), fallback)
      : urlTileFromInternetShortcut(text, fallback);
    if (!tile) return null;
    return {
      ...tile,
      ...extra,
      size: 0,
      mtime: extra.mtime || new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

/** Word / Excel / PowerPoint. HTML, PDF, and everything else stay copy-open. */
const OFFICE_SCHEME_BY_EXT = {
  ".doc": "ms-word",
  ".docx": "ms-word",
  ".docm": "ms-word",
  ".dot": "ms-word",
  ".dotx": "ms-word",
  ".dotm": "ms-word",
  ".xls": "ms-excel",
  ".xlsx": "ms-excel",
  ".xlsm": "ms-excel",
  ".xlsb": "ms-excel",
  ".xlt": "ms-excel",
  ".xltx": "ms-excel",
  ".xltm": "ms-excel",
  ".xlam": "ms-excel",
  ".ppt": "ms-powerpoint",
  ".pptx": "ms-powerpoint",
  ".pptm": "ms-powerpoint",
  ".pot": "ms-powerpoint",
  ".potx": "ms-powerpoint",
  ".potm": "ms-powerpoint",
  ".pps": "ms-powerpoint",
  ".ppsx": "ms-powerpoint",
  ".ppsm": "ms-powerpoint",
};

/**
 * @param {unknown} name
 * @returns {string|null}
 */
export function officeSchemeForName(name) {
  const ext = extname(String(name || "")).toLowerCase();
  return OFFICE_SCHEME_BY_EXT[ext] || null;
}

/**
 * SharePoint Documents root from meta.json. https only.
 * @param {object|null|undefined} meta
 * @returns {string|null}
 */
export function onedriveWebRootFromMeta(meta) {
  const raw = String(meta?.onedriveWebRoot || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    if (!u.hostname.toLowerCase().includes("sharepoint.com")) return null;
    return raw.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * @param {object|null|undefined} meta
 * @returns {{ onedriveRoot?: string, onedriveWebRoot?: string }}
 */
export function officeOpenOptsFromMeta(meta) {
  const onedriveRoot = String(meta?.onedriveRoot || "").trim();
  const onedriveWebRoot = onedriveWebRootFromMeta(meta);
  if (!onedriveRoot || !onedriveWebRoot) return {};
  return { onedriveRoot, onedriveWebRoot };
}

/**
 * SharePoint URL for a file under the synced OneDrive folder.
 * @param {string} absPath
 * @param {string|null|undefined} onedriveRoot
 * @param {string|null|undefined} webRoot
 * @returns {string|null}
 */
export function onedriveWebUrlForAbs(absPath, onedriveRoot, webRoot) {
  const root = String(onedriveRoot || "").trim();
  const web = String(webRoot || "").trim().replace(/\/+$/, "");
  const file = String(absPath || "").trim();
  if (!file || !root || !web) return null;
  const rel = relative(resolve(root), resolve(file));
  if (!rel || rel === "." || rel.startsWith("..")) return null;
  const parts = rel.split(/[/\\]/).filter(Boolean);
  if (!parts.length) return null;
  return `${web}/${parts.map(encodeURIComponent).join("/")}`;
}

/**
 * Office URI scheme that opens the same cloud item, not a downloaded copy.
 * Path segments in `webUrl` are already encoded. Do not encodeURIComponent the
 * whole URL: that turns %20 into %2520, and Word opens with no document.
 * @param {string|null|undefined} webUrl
 * @param {unknown} name
 * @returns {string|null}
 */
export function officeOpenUri(webUrl, name) {
  const scheme = officeSchemeForName(name);
  const url = String(webUrl || "").trim();
  if (!scheme || !url) return null;
  if (/[\u0000-\u001f|]/.test(url)) return null;
  return `${scheme}:ofe|u|${url}`;
}

/**
 * SharePoint URL that opens in the browser (Office Online), not a DAV download.
 * @param {string|null|undefined} webUrl
 * @returns {string|null}
 */
export function officeWebViewUrl(webUrl) {
  const url = String(webUrl || "").trim();
  if (!url) return null;
  if (/[?&]web=/.test(url)) return url;
  return url.includes("?") ? `${url}&web=1` : `${url}?web=1`;
}

/**
 * Attach webUrl + officeUri when this is an Office file on OneDrive.
 * HTML / PDF / other types stay untouched so clients keep copy-open.
 * @param {object} row
 * @param {string} absPath
 * @param {{ onedriveRoot?: string, onedriveWebRoot?: string }} [opts]
 */
export function attachOfficeOpenFields(row, absPath, opts = {}) {
  if (!row || String(row.kind || "file") === "folder") return row;
  const webUrl = onedriveWebUrlForAbs(
    absPath,
    opts.onedriveRoot,
    opts.onedriveWebRoot
  );
  const officeUri = officeOpenUri(webUrl, row.name);
  const webViewUrl = officeWebViewUrl(webUrl);
  if (!webUrl || !officeUri || !webViewUrl) return row;
  row.webUrl = webUrl;
  row.webViewUrl = webViewUrl;
  row.officeUri = officeUri;
  return row;
}

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

const FINDER_NAME_MAX = 180;
const FINDER_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const FINDER_TODO_TAGS = new Set(["CW", "HW", "QA", "MA"]);
const FINDER_TAG_PREFIX = /^(CW|HW|QA|MA)(?:\s*:\s*|\s+)/i;
const FINDER_ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/g;

/**
 * `YYYY-MM-DD` → `Sep 15`. Empty when the date is missing or invalid.
 * @param {unknown} isoDate
 */
export function formatFinderShortDate(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || "").trim());
  if (!m) return "";
  const month = FINDER_MONTHS[Number(m[2]) - 1];
  const day = Number(m[3]);
  if (!month || day < 1 || day > 31) return "";
  return `${month} ${day}`;
}

/**
 * Finder/OneDrive-safe folder basename. Spaces between words, no kebab.
 * Underscores only if a space is not legal there (leading/trailing already
 * stripped). Illegal Windows/OneDrive characters become spaces.
 * @param {unknown} name
 */
export function sanitizeFinderFolderName(name) {
  let s = String(name || "")
    .replace(/[\u2013\u2014]/g, " ")
    .replace(/"/g, "")
    .replace(FINDER_ILLEGAL, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (!s || s === "." || s === "..") return "";
  if (s.length > FINDER_NAME_MAX) {
    const cut = s.slice(0, FINDER_NAME_MAX).replace(/ \S*$/, "").trim();
    s = cut.length >= 24 ? cut : s.slice(0, FINDER_NAME_MAX).trim();
  }
  return s;
}

/**
 * OneDrive class todo/date folder name as it should appear in Finder.
 * Todos: `HW Sep 15 Assignment Name`. Dates: `Sep 15 Event Name`.
 * Hide is a leading dot on this same string. App/web titles still come
 * from JSON `name` + `tag`, not this folder.
 * @param {"todo"|"date"} kind
 * @param {object|null|undefined} props
 */
export function classObjectFinderName(kind, props) {
  const tagRaw =
    kind === "todo" ? String(props?.tag || "").trim().toUpperCase() : "";
  const tagPart = FINDER_TODO_TAGS.has(tagRaw) ? tagRaw : "";
  const dateIso = kind === "todo" ? props?.dueDate : props?.date;
  const datePart = formatFinderShortDate(dateIso);
  const rawName = String(props?.name || props?.title || "").trim();
  const stripped = rawName.replace(FINDER_TAG_PREFIX, "").trim() || rawName;
  const namePart = sanitizeFinderFolderName(stripped);
  const joined = sanitizeFinderFolderName(
    [tagPart, datePart, namePart].filter(Boolean).join(" ")
  );
  return joined || "Untitled";
}

/**
 * Unique basename within a parent. ` (2)` / ` (3)` if taken.
 * `currentId` is the folder we are renaming, so it may keep its name.
 * @param {string} desired
 * @param {Iterable<string>} occupied
 * @param {string} [currentId]
 */
export function uniqueFinderFolderName(desired, occupied, currentId = "") {
  const base = sanitizeFinderFolderName(desired) || "Untitled";
  const currentKey = String(currentId || "").toLowerCase();
  const taken = new Set();
  for (const id of occupied || []) {
    const key = String(id || "").toLowerCase();
    if (!key || key === currentKey) continue;
    taken.add(key);
  }
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = sanitizeFinderFolderName(`${base} (${n})`);
    if (candidate && !taken.has(candidate.toLowerCase())) return candidate;
  }
  return sanitizeFinderFolderName(`${base} (${Date.now()})`) || base;
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
    if (await resolveBookkeepingFile(abs, name)) return true;
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
 *   onedriveRoot?: string,
 *   onedriveWebRoot?: string,
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
          onedriveRoot: opts.onedriveRoot,
          onedriveWebRoot: opts.onedriveWebRoot,
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
      const urlTile = await urlTileFromDroppedFile(abs, entry.name, {
        source: "onedrive",
        path: rel,
        mtime,
        mtimeMs,
      });
      if (urlTile) {
        out.push(urlTile);
        continue;
      }
      out.push(
        attachOfficeOpenFields(
          {
            name: entry.name,
            kind: "file",
            source: "onedrive",
            path: rel,
            size: st.size,
            mtime,
            mtimeMs,
          },
          abs,
          opts
        )
      );
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
