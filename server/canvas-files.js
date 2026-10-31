/**
 * Canvas assignment files on Yan's OneDrive class todos.
 * Pull teacher attachments into the todo folder. Submit Yan's file,
 * text, or URL. Yan only.
 */

import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canvasConfig,
  canvasFetch,
  parseCanvasFileRefs,
  patchLiveAssignmentSubmitted,
  readCanvasSnapshot,
  YAN_EMAIL,
} from "./canvas-sync.js";
import { canvasAssignmentIdFromLink, canvasCourseIdFromLink } from "./canvas-grades.js";
import { fetchAssignmentComments } from "./canvas-context.js";
import { listClassEntriesForRoot } from "./education-data.js";
import { objectDirId, resolveBookkeepingFile } from "./education-onedrive.js";
import { listTopLevelProjects } from "./onedrive-projects.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OFFICE_EDIT_EXTS = new Set([
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
]);

export function officeBytesRefusal(name) {
  return `${name} already exists. Edit that Word, Excel, or PowerPoint file in the app with computer use. A new file can be stored under a new name.`;
}
const SKIP_SUBMIT_NAMES = new Set([
  "todo.json",
  "date.json",
  "class.json",
  "context.md",
  "deleted.md",
]);
const JUNK_BASE =
  /^(scanned document(?: \d+)?|scan(?:ned)?(?: \d+)?|img[_-]?\d+|dsc[_-]?\d+|screenshot(?: \d+)?|untitled(?: \d+)?|photo[_-]?\d+|image[_-]?\d+)$/i;
/** Canvas paste names: image-<uuid> or image- plus a long random token. */
const JUNK_IMAGE_TOKEN =
  /^image[-_](?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[a-z0-9]{12,})$/i;

const MIME_BY_EXT = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".heic": "image/heic",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".rtf": "application/rtf",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pages": "application/vnd.apple.pages",
  ".numbers": "application/vnd.apple.numbers",
  ".key": "application/vnd.apple.keynote",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
};

import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";

function yanRoot() {
  return YAN_EDUCATION_DIR;
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

function sanitizeFileBase(raw) {
  let s = String(raw || "")
    .replace(/[<>:"/\\|?*#\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^\.+/, "").replace(/\.+$/, "").trim();
  if (s.length > 120) {
    const cut = s.slice(0, 120).replace(/ \S*$/, "").trim();
    s = cut.length >= 16 ? cut : s.slice(0, 120).trim();
  }
  return s;
}

const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".heic",
  ".avif",
]);

/**
 * Spanish 4 pasted decoration. Canvas names those `image-<uuid>` or `image.png`.
 * A real filename, and every non-image, still downloads.
 * @param {unknown} classId
 * @param {unknown} rawName
 * @param {unknown} [contentType]
 */
export function isSpanishDecorationImage(classId, rawName, contentType = "") {
  if (String(classId || "").trim() !== "spanish-4") return false;
  const type = String(contentType || "").toLowerCase();
  const base = basename(String(rawName || "").trim());
  const ext = extname(base).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext) || type.startsWith("image/");
  if (!isImage) return false;
  const stem = basename(base, ext).trim();
  if (!stem || /^image$/i.test(stem) || isJunkFileBase(stem)) return true;
  return false;
}

/** Scanner names and Canvas `image-<random>` tokens. Real titles stay. */
export function isJunkFileBase(base) {
  const s = String(base || "").trim();
  if (!s) return false;
  return JUNK_BASE.test(s) || JUNK_IMAGE_TOKEN.test(s);
}

/**
 * Readable filename for a chat upload. Junk scanner names and kebab/snake
 * become spaces. Proper titles stay.
 * @param {unknown} originalName
 * @param {unknown} [fallbackTitle]
 */
export function displayUploadName(originalName, fallbackTitle = "") {
  const raw = String(originalName || "").trim();
  const ext = extname(raw) || extname(String(fallbackTitle || "")) || "";
  const base = basename(raw, extname(raw));
  if (base && !isJunkFileBase(base) && !/[_-]/.test(base)) {
    const keep = sanitizeFileBase(base);
    return keep ? `${keep}${ext}` : `${sanitizeFileBase(fallbackTitle) || "Upload"}${ext}`;
  }
  if (base && !isJunkFileBase(base) && /[_-]/.test(base)) {
    const spaced = sanitizeFileBase(base.replace(/[_-]+/g, " "));
    if (spaced) return `${spaced}${ext}`;
  }
  const fb = sanitizeFileBase(fallbackTitle) || "Upload";
  return `${fb}${ext || ".pdf"}`;
}

/**
 * Name to store for a teacher file pulled from Canvas.
 * A real title is kept. `image-<uuid>` and other junk use the assignment title.
 * @param {unknown} raw
 * @param {unknown} [fallbackTitle]
 * @param {unknown} [fileId]
 */
export function canvasDownloadName(raw, fallbackTitle = "", fileId = "") {
  const baseRaw = basename(String(raw || "").trim());
  const ext = extname(baseRaw);
  const rawStem = basename(baseRaw, ext);
  if (rawStem && !isJunkFileBase(rawStem)) {
    const stem = sanitizeFileBase(rawStem) || (fileId ? `canvas-${fileId}` : "file");
    return `${stem}${ext}`;
  }
  const fb =
    sanitizeFileBase(fallbackTitle) || (fileId ? `canvas-${fileId}` : "Upload");
  return `${fb}${ext || ""}`;
}

/**
 * @param {string} desired
 * @param {Set<string>} taken lowercase names already used
 * @param {string} [keepLower] this file's current name, which may stay
 */
export function allocateFileName(desired, taken, keepLower = "") {
  const ext = extname(desired);
  const stem = basename(desired, ext) || "file";
  let name = desired;
  let n = 2;
  const used = taken instanceof Set ? taken : new Set();
  while (used.has(name.toLowerCase()) && name.toLowerCase() !== keepLower) {
    name = `${stem} ${n}${ext}`;
    n += 1;
  }
  return name;
}

/**
 * @param {{ name?: string, path?: string }[]} entries
 * @param {{ canvasFileNames?: unknown[], chatNames?: unknown[] }} [opts]
 */
export function pickSubmitFiles(entries, { canvasFileNames = [], chatNames = [] } = {}) {
  const canvasSet = new Set(
    (Array.isArray(canvasFileNames) ? canvasFileNames : [])
      .map((n) => String(n || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const chatSet = new Set(
    (Array.isArray(chatNames) ? chatNames : [])
      .map((n) => String(n || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const usable = (Array.isArray(entries) ? entries : []).filter((row) => {
    const name = String(row?.name || "").trim();
    const lower = name.toLowerCase();
    if (!name || name.startsWith(".")) return false;
    if (SKIP_SUBMIT_NAMES.has(lower)) return false;
    if (lower.endsWith(".url")) return false;
    if (canvasSet.has(lower)) return false;
    return true;
  });
  if (chatSet.size) {
    const hits = usable.filter((row) => chatSet.has(String(row.name).toLowerCase()));
    if (hits.length) return { ok: true, reason: "chat", files: hits };
    return { ok: false, reason: "missing-chat", files: usable };
  }
  if (!usable.length) return { ok: false, reason: "none", files: [] };
  if (usable.length === 1) return { ok: true, reason: "single", files: usable };
  return { ok: false, reason: "ambiguous", files: usable };
}

async function listTodoFiles(dir) {
  /** @type {{ name: string, path: string, mtimeMs: number, size: number }[]} */
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
    const path = join(dir, entry.name);
    try {
      const st = await stat(path);
      if (!st.isFile()) continue;
      out.push({
        name: entry.name,
        path,
        mtimeMs: st.mtimeMs,
        size: st.size,
      });
    } catch {
      /* skip */
    }
  }
  return out;
}

/**
 * Copy into a OneDrive folder with a temp+rename+fsync so the File Provider
 * actually notices the new file.
 * @param {string} dir
 * @param {string} name
 * @param {string} srcPath
 */
export async function writeFileIntoFolder(dir, name, srcPath) {
  const safe = basename(String(name || "").trim());
  if (!safe || safe.startsWith(".") || safe.includes("/") || safe.includes("\\")) {
    throw new Error("Bad destination filename");
  }
  await mkdir(dir, { recursive: true });
  const dest = join(dir, safe);
  if (OFFICE_EDIT_EXTS.has(extname(safe).toLowerCase())) {
    try {
      const existing = await stat(dest);
      if (existing.isFile()) {
        const err = new Error(officeBytesRefusal(safe));
        err.code = "EXISTING_OFFICE";
        throw err;
      }
    } catch (err) {
      if (err?.code === "EXISTING_OFFICE") throw err;
    }
  }
  const tmp = join(
    tmpdir(),
    `yl-canvas-${process.pid}-${randomBytes(4).toString("hex")}${extname(safe) || ".bin"}`
  );
  try {
    await copyFile(srcPath, tmp);
    const fh = await open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await copyFile(tmp, dest);
    const destFh = await open(dest, "r+");
    try {
      await destFh.sync();
    } finally {
      await destFh.close();
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
  return dest;
}

function assignmentFileTitle(props) {
  return String(props?.name || "").trim();
}

/**
 * Rename junk teacher files already sitting in OneDrive todo folders.
 * The next pull then sees the readable name and does not download a second copy.
 */
export async function retitleJunkCanvasFiles() {
  const entries = await listClassEntriesForRoot(yanRoot());
  let renamed = 0;
  for (const entry of entries) {
    if (entry.source !== "onedrive") continue;
    let dirs;
    try {
      dirs = await readdir(entry.classFolder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (d.name === ".education" || d.name === ".Trash") continue;
      const jsonPath = await resolveBookkeepingFile(
        join(entry.classFolder, d.name),
        "todo.json"
      );
      const props = jsonPath ? await readJsonFile(jsonPath) : null;
      const rows = Array.isArray(props?.canvasFiles) ? props.canvasFiles : [];
      if (!rows.length) continue;
      const dir = join(entry.classFolder, d.name);
      const existing = await listTodoFiles(dir);
      const byLower = new Map(existing.map((f) => [f.name.toLowerCase(), f]));
      const taken = new Set(byLower.keys());
      /** @type {{ id: number, name: string }[]} */
      const next = [];
      let changed = false;
      for (const row of rows) {
        const id = Number(row?.id);
        const oldName = basename(String(row?.name || "").trim());
        if (!Number.isFinite(id) || id <= 0 || !oldName) {
          if (oldName) next.push({ id, name: oldName });
          continue;
        }
        const desired = canvasDownloadName(oldName, assignmentFileTitle(props), id);
        const finalName = allocateFileName(desired, taken, oldName.toLowerCase());
        if (finalName.toLowerCase() !== oldName.toLowerCase()) {
          const old = byLower.get(oldName.toLowerCase());
          if (old) {
            await writeFileIntoFolder(dir, finalName, old.path);
            await rm(old.path, { force: true });
            byLower.delete(oldName.toLowerCase());
            byLower.set(finalName.toLowerCase(), { ...old, name: finalName, path: join(dir, finalName) });
            renamed += 1;
          }
          taken.delete(oldName.toLowerCase());
          changed = true;
        }
        taken.add(finalName.toLowerCase());
        next.push({ id, name: finalName });
      }
      if (changed) await mergeCanvasFiles(jsonPath, next);
    }
  }
  return { ok: true, renamed };
}

export async function findYanTodoByCanvasId(canvasId) {
  const want = Number(canvasId);
  if (!Number.isFinite(want) || want <= 0) return null;
  const entries = await listClassEntriesForRoot(yanRoot());
  for (const entry of entries) {
    if (entry.source !== "onedrive") continue;
    const classFolder = entry.classFolder;
    let dirs;
    try {
      dirs = await readdir(classFolder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (d.name === ".education" || d.name === ".Trash") continue;
      const jsonPath = await resolveBookkeepingFile(
        join(classFolder, d.name),
        "todo.json"
      );
      const props = jsonPath ? await readJsonFile(jsonPath) : null;
      if (!props || typeof props !== "object") continue;
      const id = Number(props.canvasId);
      if (id !== want) continue;
      return {
        path: jsonPath,
        dir: join(classFolder, d.name),
        props,
        classId: entry.id,
        todoId: objectDirId(d.name),
        onedriveFolder: entry.onedriveFolder,
      };
    }
  }
  return findProjectTodoByCanvasId(want);
}

async function findProjectTodoByCanvasId(want) {
  const projects = await listTopLevelProjects();
  for (const project of projects) {
    let dirs;
    try {
      dirs = await readdir(join(project.dir, "todos"), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const dir = join(project.dir, "todos", d.name);
      const jsonPath = await resolveBookkeepingFile(dir, "todo.json");
      const props = jsonPath ? await readJsonFile(jsonPath) : null;
      if (!props || Number(props.canvasId) !== want) continue;
      return {
        path: jsonPath,
        dir,
        props,
        classId: "",
        projectId: project.id,
        todoId: d.name,
        onedriveFolder: project.folderName,
      };
    }
  }
  return null;
}

export async function findYanTodoByFolder({ classId, todoId } = {}) {
  const cid = String(classId || "").trim();
  const tid = String(todoId || "").trim();
  if (!cid || !tid) return null;
  const entries = await listClassEntriesForRoot(yanRoot());
  const entry = entries.find((e) => e.id === cid && e.source === "onedrive");
  if (!entry) return null;
  const names = [tid, tid.startsWith(".") ? tid.slice(1) : `.${tid}`];
  for (const name of names) {
    const jsonPath = await resolveBookkeepingFile(
      join(entry.classFolder, name),
      "todo.json"
    );
    const props = jsonPath ? await readJsonFile(jsonPath) : null;
    if (props && typeof props === "object") {
      return {
        path: jsonPath,
        dir: join(entry.classFolder, name),
        props,
        classId: entry.id,
        todoId: objectDirId(name),
        onedriveFolder: entry.onedriveFolder,
      };
    }
  }
  return null;
}

async function mergeCanvasFiles(todoPath, files) {
  const props = await readJsonFile(todoPath);
  if (!props || typeof props !== "object") return;
  /** @type {Map<number, { id: number, name: string }>} */
  const byId = new Map();
  for (const row of Array.isArray(props.canvasFiles) ? props.canvasFiles : []) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    byId.set(id, { id, name: String(row?.name || "") });
  }
  for (const row of files || []) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const prev = byId.get(id);
    byId.set(id, { id, name: String(row?.name || prev?.name || "") });
  }
  const next = [...byId.values()].sort((a, b) => a.id - b.id);
  const prevJson = JSON.stringify(props.canvasFiles || []);
  if (JSON.stringify(next) === prevJson) return;
  props.canvasFiles = next;
  await writeFile(todoPath, `${JSON.stringify(props, null, 2)}\n`, "utf8");
}

async function removeCanvasFileIds(todoPath, ids) {
  const drop = new Set((Array.isArray(ids) ? ids : []).map((id) => Number(id)));
  const props = await readJsonFile(todoPath);
  if (!props || typeof props !== "object") return;
  const prev = Array.isArray(props.canvasFiles) ? props.canvasFiles : [];
  const next = prev.filter((row) => !drop.has(Number(row?.id)));
  if (next.length === prev.length) return;
  if (next.length) props.canvasFiles = next;
  else delete props.canvasFiles;
  await writeFile(todoPath, `${JSON.stringify(props, null, 2)}\n`, "utf8");
}

function canvasMetaName(meta, fallback = "") {
  return String(meta?.display_name || meta?.filename || fallback || "").trim();
}

function canvasMetaType(meta) {
  return String(meta?.["content-type"] || meta?.content_type || "");
}

/**
 * Delete Spanish 4 Canvas images that are pasted decoration, and forget them
 * on canvasFiles so the next pull does not put them back.
 */
export async function dropSpanishDecorationFiles() {
  const { base, token, configured } = canvasConfig();
  if (!configured) return { ok: false, reason: "not configured", removed: 0 };
  const entries = await listClassEntriesForRoot(yanRoot());
  const entry = entries.find((e) => e.id === "spanish-4" && e.source === "onedrive");
  if (!entry?.classFolder) return { ok: true, removed: 0 };
  let dirs;
  try {
    dirs = await readdir(entry.classFolder, { withFileTypes: true });
  } catch {
    return { ok: true, removed: 0 };
  }
  let removed = 0;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = join(entry.classFolder, d.name);
    const jsonPath = await resolveBookkeepingFile(dir, "todo.json");
    const props = jsonPath ? await readJsonFile(jsonPath) : null;
    const rows = Array.isArray(props?.canvasFiles) ? props.canvasFiles : [];
    if (!jsonPath || !rows.length) continue;
    /** @type {number[]} */
    const drop = [];
    for (const row of rows) {
      const id = Number(row?.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      let meta = null;
      try {
        meta = await canvasFileMeta(base, token, id);
      } catch (err) {
        console.error(`[canvas-files] spanish decoration ${id}`, err);
        continue;
      }
      if (
        !isSpanishDecorationImage(
          "spanish-4",
          canvasMetaName(meta, row?.name),
          canvasMetaType(meta)
        )
      ) {
        continue;
      }
      const name = basename(String(row?.name || "").trim());
      if (name) await rm(join(dir, name), { force: true }).catch(() => {});
      drop.push(id);
      removed += 1;
    }
    if (drop.length) await removeCanvasFileIds(jsonPath, drop);
  }
  return { ok: true, removed };
}

function mimeForName(name) {
  const ext = extname(String(name || "")).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function normalizeSubmitTypes(types) {
  return (Array.isArray(types) ? types : []).map((t) => String(t).toLowerCase());
}

export function assignmentAllowsUpload(types) {
  return normalizeSubmitTypes(types).includes("online_upload");
}

export function assignmentAllowsText(types) {
  return normalizeSubmitTypes(types).includes("online_text_entry");
}

export function assignmentAllowsUrl(types) {
  return normalizeSubmitTypes(types).includes("online_url");
}

/**
 * Pick how to submit. An attached file wins over text/url when upload is allowed.
 * @param {{ types?: unknown, text?: string, url?: string, hasFile?: boolean }} opts
 */
export function pickCanvasSubmitKind(opts = {}) {
  const types = normalizeSubmitTypes(opts.types);
  const text = String(opts.text || "").trim();
  const url = String(opts.url || "").trim();
  const hasFile = Boolean(opts.hasFile);
  if (hasFile && types.includes("online_upload")) return "online_upload";
  if (url && types.includes("online_url")) return "online_url";
  if (text && types.includes("online_text_entry")) return "online_text_entry";
  if (hasFile) return "not-online-upload";
  if (url) return "not-online-url";
  if (text) return "not-online-text";
  if (types.includes("online_upload")) return "need-file";
  if (types.includes("online_text_entry")) return "need-text";
  if (types.includes("online_url")) return "need-url";
  return "unsupported";
}

async function canvasFormPost(base, token, path, params, { timeoutMs } = {}) {
  const url = path.startsWith("http") ? path : `${base}${path}`;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      for (const item of value) body.append(key, String(item));
    } else if (value != null) {
      body.append(key, String(value));
    }
  }
  /** @type {RequestInit} */
  const init = {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  };
  const ms = Number(timeoutMs);
  if (Number.isFinite(ms) && ms > 0) init.signal = AbortSignal.timeout(ms);
  const res = await fetch(url, init);
  if (!res.ok) {
    const err = new Error(`Canvas ${res.status} ${path}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function downloadUrlToFile(url, dest, token) {
  const tryOnce = async (withAuth) => {
    /** @type {RequestInit} */
    const init = { redirect: "follow" };
    if (withAuth) {
      init.headers = { Authorization: `Bearer ${token}` };
    }
    const res = await fetch(url, init);
    if (!res.ok || !res.body) {
      const err = new Error(`Canvas download ${res.status}`);
      err.status = res.status;
      throw err;
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  };
  try {
    await tryOnce(true);
  } catch (err) {
    if (err && err.status === 401) {
      await tryOnce(false);
      return;
    }
    throw err;
  }
}

async function canvasFileMeta(base, token, fileId) {
  const { data } = await canvasFetch(base, token, `/api/v1/files/${fileId}`);
  return data && typeof data === "object" ? data : null;
}

/**
 * Store a local file into a class todo OneDrive folder.
 * @param {{ src: string, canvasId?: unknown, classId?: string, todoId?: string, name?: string }} opts
 */
export async function storeClassFile(opts) {
  const src = resolveSrc(opts?.src);
  const st = await stat(src);
  if (!st.isFile()) {
    return { ok: false, reason: "not-a-file" };
  }
  const todo = opts?.canvasId
    ? await findYanTodoByCanvasId(opts.canvasId)
    : await findYanTodoByFolder({ classId: opts?.classId, todoId: opts?.todoId });
  if (!todo) return { ok: false, reason: "todo-not-found" };
  const wanted =
    String(opts?.name || "").trim() ||
    displayUploadName(basename(src), todo.props?.name || "");
  const name = basename(wanted);
  let dest;
  try {
    dest = await writeFileIntoFolder(todo.dir, name, src);
  } catch (err) {
    if (err?.code === "EXISTING_OFFICE") {
      return { ok: false, reason: "existing-office", error: err.message, name };
    }
    throw err;
  }
  return {
    ok: true,
    path: dest,
    name,
    dir: todo.dir,
    classId: todo.classId,
    todoId: todo.todoId,
    canvasId: Number(todo.props?.canvasId) || null,
  };
}

function resolveSrc(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Missing --src / --file");
  return isAbsolute(s) ? s : resolve(ROOT, s);
}

async function liveAssignment(snapshot, canvasId, courseId) {
  const id = Number(canvasId);
  const fromSnap = (snapshot?.assignments || []).find((a) => Number(a?.id) === id);
  const { base, token, configured } = canvasConfig();
  if (!configured) return fromSnap || null;
  const course = Number(courseId || fromSnap?.courseId);
  if (!Number.isFinite(course) || !Number.isFinite(id)) return fromSnap || null;
  try {
    const { data } = await canvasFetch(
      base,
      token,
      `/api/v1/courses/${course}/assignments/${id}`
    );
    if (!data || typeof data !== "object") return fromSnap || null;
    const types = Array.isArray(data.submission_types) ? data.submission_types : [];
    const files = parseCanvasFileRefs(data.description, data.attachments);
    return {
      ...(fromSnap || {}),
      id,
      courseId: course,
      types,
      files: files.length ? files : fromSnap?.files || [],
      htmlUrl: data.html_url || fromSnap?.htmlUrl,
    };
  } catch (err) {
    console.error("[canvas-files] assignment lookup", err);
    return fromSnap || null;
  }
}

/**
 * Upload files already on disk to Canvas as an online_upload submission.
 * @param {{
 *   canvasId?: unknown,
 *   classId?: string,
 *   todoId?: string,
 *   files?: string[],
 *   src?: string,
 *   name?: string,
 * }} opts
 */
export async function submitCanvasAssignment(opts = {}) {
  const { base, token, configured } = canvasConfig();
  if (!configured) return { ok: false, reason: "not configured" };

  const text = String(opts.text || "").trim();
  const url = String(opts.url || "").trim();
  const incoming = [
    ...(opts.src ? [opts.src] : []),
    ...(Array.isArray(opts.files) ? opts.files : []),
  ].filter(Boolean);

  const todo = opts.canvasId
    ? await findYanTodoByCanvasId(opts.canvasId)
    : await findYanTodoByFolder({ classId: opts.classId, todoId: opts.todoId });
  const snapshot = await readCanvasSnapshot();
  const canvasId =
    Number(todo?.props?.canvasId) ||
    canvasAssignmentIdFromLink(todo?.props?.canvasLink) ||
    Number(opts.canvasId);
  const fromSnap = (snapshot?.assignments || []).find(
    (a) => Number(a?.id) === canvasId
  );
  const courseId =
    canvasCourseIdFromLink(todo?.props?.canvasLink) ||
    Number(fromSnap?.courseId) ||
    Number(opts.courseId);
  if (!Number.isFinite(canvasId) || !Number.isFinite(courseId)) {
    return { ok: false, reason: todo ? "missing-canvas-ids" : "todo-not-found" };
  }

  const assignment = await liveAssignment(snapshot, canvasId, courseId);
  const types = assignment?.types || [];
  const kind = pickCanvasSubmitKind({
    types,
    text,
    url,
    hasFile: incoming.length > 0,
  });
  if (kind === "online_url") {
    await canvasFormPost(
      base,
      token,
      `/api/v1/courses/${courseId}/assignments/${canvasId}/submissions`,
      {
        "submission[submission_type]": "online_url",
        "submission[url]": url,
      }
    );
    patchLiveAssignmentSubmitted(canvasId);
    return { ok: true, canvasId, courseId, kind, url };
  }
  if (kind === "online_text_entry") {
    await canvasFormPost(
      base,
      token,
      `/api/v1/courses/${courseId}/assignments/${canvasId}/submissions`,
      {
        "submission[submission_type]": "online_text_entry",
        "submission[body]": text,
      }
    );
    patchLiveAssignmentSubmitted(canvasId);
    return {
      ok: true,
      canvasId,
      courseId,
      kind,
      chars: text.length,
    };
  }
  if (kind !== "online_upload" && kind !== "need-file") {
    return { ok: false, reason: kind, types, canvasId, courseId };
  }
  if (!todo) return { ok: false, reason: "todo-not-found", canvasId, courseId };

  const storedNames = [];
  /** @type {string[]} */
  const extraPaths = [];
  const todoDir = resolve(todo.dir);
  for (const one of incoming) {
    const abs = resolveSrc(one);
    if (abs === join(todoDir, basename(abs)) || abs.startsWith(`${todoDir}/`)) {
      storedNames.push(basename(abs));
      extraPaths.push(abs);
      continue;
    }
    const stored = await storeClassFile({
      src: abs,
      canvasId: todo.props?.canvasId || opts.canvasId,
      classId: todo.classId,
      todoId: todo.todoId,
      name: opts.name,
    });
    if (!stored.ok) return stored;
    extraPaths.push(stored.path);
    storedNames.push(stored.name);
  }

  if (!assignmentAllowsUpload(types)) {
    return {
      ok: false,
      reason: "not-online-upload",
      types,
      canvasId,
    };
  }

  const folderFiles = await listTodoFiles(todo.dir);
  const canvasFileNames = (todo.props?.canvasFiles || []).map((row) => row?.name);
  const picked = pickSubmitFiles(folderFiles, {
    canvasFileNames,
    chatNames: storedNames,
  });
  if (!picked.ok) {
    return {
      ok: false,
      reason: picked.reason,
      candidates: picked.files.map((f) => f.name),
      dir: todo.dir,
      canvasId,
    };
  }

  /** @type {number[]} */
  const fileIds = [];
  for (const row of picked.files) {
    const uploaded = await uploadSubmissionFile({
      base,
      token,
      courseId,
      assignmentId: canvasId,
      filePath: row.path,
      name: row.name,
    });
    const id = Number(uploaded?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, reason: "upload-failed", file: row.name };
    }
    fileIds.push(id);
  }

  await canvasFormPost(
    base,
    token,
    `/api/v1/courses/${courseId}/assignments/${canvasId}/submissions`,
    {
      "submission[submission_type]": "online_upload",
      "submission[file_ids][]": fileIds,
    }
  );
  patchLiveAssignmentSubmitted(canvasId);
  return {
    ok: true,
    canvasId,
    courseId,
    kind: "online_upload",
    names: picked.files.map((f) => f.name),
    fileIds,
    extraPaths,
  };
}

async function uploadSubmissionFile({
  base,
  token,
  courseId,
  assignmentId,
  filePath,
  name,
}) {
  const size = (await stat(filePath)).size;
  const contentType = mimeForName(name);
  const start = await canvasFormPost(
    base,
    token,
    `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/self/files`,
    {
      name,
      size: String(size),
      content_type: contentType,
      on_duplicate: "overwrite",
      submit_assignment: "false",
    }
  );
  if (start && start.id && !start.upload_url) return start;
  if (!start?.upload_url) {
    throw new Error("Canvas file upload did not return upload_url");
  }
  const form = new FormData();
  for (const [key, value] of Object.entries(start.upload_params || {})) {
    form.append(key, String(value));
  }
  const buf = await readFile(filePath);
  form.append("file", new Blob([buf], { type: contentType }), name);
  const up = await fetch(start.upload_url, {
    method: "POST",
    body: form,
    redirect: "manual",
  });
  if (up.status >= 300 && up.status < 400) {
    const loc = up.headers.get("location");
    if (!loc) throw new Error("Canvas upload missing Location");
    const confirm = await fetch(loc, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!confirm.ok) {
      const err = new Error(`Canvas upload confirm ${confirm.status}`);
      err.status = confirm.status;
      throw err;
    }
    return confirm.json();
  }
  if (!up.ok) {
    const err = new Error(`Canvas upload ${up.status}`);
    err.status = up.status;
    throw err;
  }
  const text = await up.text();
  if (!text.trim()) return start;
  try {
    return JSON.parse(text);
  } catch {
    return start;
  }
}

/**
 * Download teacher-attached files into mapped OneDrive todos.
 * @param {{ snapshot?: object|null }} [opts]
 */
export async function pullCanvasAssignmentFiles(opts = {}) {
  const { base, token, configured } = canvasConfig();
  if (!configured) return { ok: false, reason: "not configured" };
  const snapshot = opts.snapshot || (await readCanvasSnapshot());
  if (!snapshot) return { ok: false, reason: "no-snapshot" };

  const decoration = await dropSpanishDecorationFiles();
  const retitled = await retitleJunkCanvasFiles();

  let downloaded = 0;
  let skipped = 0;
  let missingTodo = 0;
  const assignments = Array.isArray(snapshot.assignments) ? snapshot.assignments : [];
  for (const row of assignments) {
    const files = Array.isArray(row?.files) ? row.files : [];
    if (!files.length) continue;
    const todo = await findYanTodoByCanvasId(row.id);
    if (!todo) {
      missingTodo += 1;
      continue;
    }
    const existing = await listTodoFiles(todo.dir);
    const byName = new Map(existing.map((f) => [f.name.toLowerCase(), f]));
    /** @type {{ id: number, name: string }[]} */
    const written = [];
    for (const ref of files) {
      const id = Number(ref?.id);
      if (!Number.isFinite(id) || id <= 0) continue;
      let meta = null;
      try {
        meta = await canvasFileMeta(base, token, id);
      } catch (err) {
        console.error(`[canvas-files] file ${id}`, err);
        continue;
      }
      const rawName = ref.name || meta?.display_name || meta?.filename;
      const stored = (todo.props?.canvasFiles || []).find(
        (row) => Number(row?.id) === id
      );
      if (
        isSpanishDecorationImage(
          todo.classId,
          canvasMetaName(meta, ref.name),
          canvasMetaType(meta)
        )
      ) {
        const victim = basename(String(stored?.name || "").trim());
        if (victim) await rm(join(todo.dir, victim), { force: true }).catch(() => {});
        skipped += 1;
        continue;
      }
      const storedName = basename(String(stored?.name || "").trim());
      const storedStem = basename(storedName, extname(storedName));
      const computed = canvasDownloadName(
        rawName,
        assignmentFileTitle(todo.props),
        id
      );
      const preferred =
        storedName &&
        byName.has(storedName.toLowerCase()) &&
        !isJunkFileBase(storedStem)
          ? storedName
          : computed;
      const keepLower =
        preferred.toLowerCase() === storedName.toLowerCase()
          ? storedName.toLowerCase()
          : "";
      const finalName = allocateFileName(preferred, new Set(byName.keys()), keepLower);
      const prior = byName.get(finalName.toLowerCase());
      const size = Number(meta?.size);
      if (prior && Number.isFinite(size) && prior.size === size) {
        skipped += 1;
        written.push({ id, name: finalName });
        continue;
      }
      const url = String(meta?.url || "").trim();
      if (!url) continue;
      const tmp = join(
        tmpdir(),
        `yl-canvas-${process.pid}-${randomBytes(4).toString("hex")}${extname(finalName) || ".bin"}`
      );
      try {
        await mkdir(todo.dir, { recursive: true });
        await downloadUrlToFile(url, tmp, token);
        const dest = join(todo.dir, finalName);
        await copyFile(tmp, dest);
        const fh = await open(dest, "r+");
        try {
          await fh.sync();
        } finally {
          await fh.close();
        }
        downloaded += 1;
        written.push({ id, name: finalName });
        byName.set(finalName.toLowerCase(), { name: finalName, path: dest, size });
      } catch (err) {
        console.error(`[canvas-files] download ${id}`, err);
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
    if (written.length) await mergeCanvasFiles(todo.path, written);
  }
  return {
    ok: true,
    downloaded,
    skipped,
    missingTodo,
    renamed: retitled.renamed,
    decorationRemoved: decoration.removed || 0,
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return "";
  return String(argv[i + 1] || "").trim();
}

function argList(argv, name) {
  /** @type {string[]} */
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1]) {
      out.push(String(argv[i + 1]).trim());
      i += 1;
    }
  }
  return out.filter(Boolean);
}

async function runCli(argv = process.argv.slice(2)) {
  const cmd = String(argv[0] || "").trim();
  if (cmd === "pull" || argv.includes("--pull-files")) {
    return pullCanvasAssignmentFiles();
  }
  if (cmd === "retitle") {
    return retitleJunkCanvasFiles();
  }
  if (cmd === "comments") {
    return readAssignmentCommentsCli({
      canvasId: argValue(argv, "--canvas-id"),
      courseId: argValue(argv, "--course-id"),
    });
  }
  if (cmd === "store") {
    return storeClassFile({
      src: argValue(argv, "--src") || argValue(argv, "--file"),
      canvasId: argValue(argv, "--canvas-id"),
      classId: argValue(argv, "--class"),
      todoId: argValue(argv, "--todo"),
      name: argValue(argv, "--name"),
    });
  }
  if (cmd === "submit" || argv.includes("--submit")) {
    const textFile = argValue(argv, "--text-file");
    const textFromFile = textFile
      ? await readFile(resolveSrc(textFile), "utf8")
      : "";
    return submitCanvasAssignment({
      canvasId: argValue(argv, "--canvas-id"),
      classId: argValue(argv, "--class"),
      todoId: argValue(argv, "--todo"),
      src: argValue(argv, "--src"),
      files: argList(argv, "--file"),
      name: argValue(argv, "--name"),
      text: argValue(argv, "--text") || argValue(argv, "--body") || textFromFile,
      url: argValue(argv, "--url"),
    });
  }
  return {
    ok: false,
    reason: "usage",
    usage: [
      "node --env-file=server/.env server/canvas-files.js submit --canvas-id ID",
      "node --env-file=server/.env server/canvas-files.js submit --canvas-id ID --file /path.pdf",
      "node --env-file=server/.env server/canvas-files.js submit --canvas-id ID --text 'paragraph'",
      "node --env-file=server/.env server/canvas-files.js submit --canvas-id ID --text-file /tmp/body.txt",
      "node --env-file=server/.env server/canvas-files.js submit --canvas-id ID --url https://example.com",
      "node --env-file=server/.env server/canvas-files.js comments --canvas-id ID",
      "node --env-file=server/.env server/canvas-files.js store --src /path.pdf --canvas-id ID",
      "node --env-file=server/.env server/canvas-files.js pull",
    ],
  };
}

async function readAssignmentCommentsCli(opts) {
  const { base, token, configured } = canvasConfig();
  if (!configured) return { ok: false, reason: "not configured" };
  const snapshot = await readCanvasSnapshot();
  const canvasId = Number(opts.canvasId);
  const fromSnap = (snapshot?.assignments || []).find(
    (a) => Number(a?.id) === canvasId
  );
  const todo = Number.isFinite(canvasId)
    ? await findYanTodoByCanvasId(canvasId)
    : null;
  const courseId =
    Number(opts.courseId) ||
    canvasCourseIdFromLink(todo?.props?.canvasLink) ||
    Number(fromSnap?.courseId);
  if (!Number.isFinite(canvasId) || !Number.isFinite(courseId)) {
    return { ok: false, reason: "missing-canvas-ids" };
  }
  return fetchAssignmentComments(base, token, {
    courseId,
    assignmentId: canvasId,
    course: fromSnap?.course || "",
    assignmentName: fromSnap?.title || todo?.props?.name || "",
  });
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
  runCli()
    .then((result) => {
      console.log("[canvas-files]", result);
      if (!result?.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[canvas-files] failed", err);
      process.exitCode = 1;
    });
}
