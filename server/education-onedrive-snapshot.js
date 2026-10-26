/**
 * Local copy of Yan's OneDrive class rows.
 * The education page reads this. A background walk updates it.
 * CloudStorage reads of dataless todo files take hundreds of milliseconds
 * each, and the dashboard used to do that before it could paint.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalizeEmail } from "./identity.js";

const REFRESH_MS = 3 * 60_000;
const STALE_MS = 10 * 60_000;

/** @type {Map<string, { at: number, rows: object[], sourceClasses: object[], incomplete?: boolean }>} */
const memory = new Map();
/** @type {Map<string, Promise<void>>} */
const inflight = new Map();
/** @type {((email: string) => Promise<void>)|null} */
let builder = null;
/** @type {(email: string) => void} */
let onWrote = () => {};

export function snapshotDir() {
  const override = String(process.env.EDUCATION_ONEDRIVE_SNAPSHOT_DIR || "").trim();
  if (override) return override;
  return join(homedir(), "Library/Application Support/yanylevin/education-onedrive-snapshot");
}

function snapshotPath(email) {
  const key = canonicalizeEmail(email);
  return join(snapshotDir(), `${key}.json`);
}

export function registerOnedriveSnapshotBuilder(fn) {
  builder = fn;
}

export function onOnedriveSnapshotWrote(fn) {
  onWrote = typeof fn === "function" ? fn : () => {};
}

export function resetOnedriveSnapshotState() {
  memory.clear();
  inflight.clear();
}

/**
 * @param {string} email
 */
export async function readOnedriveSnapshot(email) {
  const key = canonicalizeEmail(email);
  if (!key) return null;
  const hit = memory.get(key);
  if (hit) return hit;
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(key), "utf8"));
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    memory.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @param {string} email
 * @param {{ at?: number, rows: object[], sourceClasses?: object[], incomplete?: boolean }} snap
 */
export async function writeOnedriveSnapshot(email, snap) {
  const key = canonicalizeEmail(email);
  if (!key) return;
  const next = {
    at: Number(snap?.at) || Date.now(),
    rows: Array.isArray(snap?.rows) ? snap.rows : [],
    sourceClasses: Array.isArray(snap?.sourceClasses) ? snap.sourceClasses : [],
    incomplete: Boolean(snap?.incomplete),
  };
  memory.set(key, next);
  const path = snapshotPath(key);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(next));
  await rename(tmp, path);
  onWrote(key);
}

function unionById(oldList, newList) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const item of oldList || []) {
    if (item?.id) map.set(String(item.id), item);
  }
  for (const item of newList || []) {
    if (item?.id) map.set(String(item.id), item);
  }
  return [...map.values()];
}

function mergeRow(oldRow, newRow) {
  const oldFiles = Array.isArray(oldRow.files) ? oldRow.files : [];
  const newFiles = Array.isArray(newRow.files) ? newRow.files : [];
  return {
    ...newRow,
    todos: unionById(oldRow.todos, newRow.todos),
    dates: unionById(oldRow.dates, newRow.dates),
    files: oldFiles.length > newFiles.length ? oldFiles : newFiles,
  };
}

/**
 * A flaky OneDrive walk omits files it could not read. Keep the previous
 * copy of those classes instead of publishing a hole.
 * A clean walk replaces the snapshot.
 * @param {object[]|null|undefined} prevRows
 * @param {object[]|null|undefined} nextRows
 * @param {{ incomplete?: boolean }} [opts]
 */
export function mergeClassRows(prevRows, nextRows, { incomplete = false } = {}) {
  const prev = Array.isArray(prevRows) ? prevRows : [];
  const next = Array.isArray(nextRows) ? nextRows : [];
  if (!incomplete) return next;
  if (!next.length) return prev;
  /** @type {Map<string, object>} */
  const prevById = new Map(prev.filter((row) => row?.id).map((row) => [String(row.id), row]));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {object[]} */
  const out = [];
  for (const row of next) {
    if (!row?.id) continue;
    const id = String(row.id);
    seen.add(id);
    const old = prevById.get(id);
    out.push(old ? mergeRow(old, row) : row);
  }
  for (const row of prev) {
    if (row?.id && !seen.has(String(row.id))) out.push(row);
  }
  return out;
}

/**
 * @param {string} email
 * @param {string|null|undefined} classId
 * @param {string} todoId
 */
export async function findSnapshotTodo(email, classId, todoId) {
  const snap = await readOnedriveSnapshot(email);
  if (!snap?.rows || !todoId) return null;
  const wantClass = classId ? String(classId) : "";
  for (const row of snap.rows) {
    if (!row?.id) continue;
    if (wantClass && String(row.id) !== wantClass) continue;
    for (const todo of row.todos || []) {
      if (!todo || String(todo.id) !== String(todoId)) continue;
      if (!todo._jsonPath || !todo._raw || typeof todo._raw !== "object") return null;
      return {
        classId: String(row.id),
        jsonPath: String(todo._jsonPath),
        raw: todo._raw,
      };
    }
  }
  return null;
}

/**
 * @param {string} email
 * @param {{ classId?: string|null, todoId: string, raw: object }} patch
 */
export async function patchSnapshotTodo(email, { classId = null, todoId, raw } = {}) {
  const snap = await readOnedriveSnapshot(email);
  if (!snap?.rows || !raw || typeof raw !== "object" || !todoId) return false;
  const wantClass = classId ? String(classId) : "";
  let hit = false;
  for (const row of snap.rows) {
    if (!row?.id) continue;
    if (wantClass && String(row.id) !== wantClass) continue;
    for (const todo of row.todos || []) {
      if (!todo || String(todo.id) !== String(todoId)) continue;
      todo._raw = raw;
      if (typeof raw.done === "boolean") todo.done = raw.done;
      if (raw.completedAt) todo.completedAt = raw.completedAt;
      else delete todo.completedAt;
      if (Array.isArray(raw.capsules)) todo.capsules = raw.capsules;
      hit = true;
    }
  }
  if (!hit) return false;
  snap.at = Date.now();
  await writeOnedriveSnapshot(email, snap);
  return true;
}

export function snapshotIsStale(snap, now = Date.now()) {
  const at = Number(snap?.at) || 0;
  return !at || now - at > STALE_MS;
}

/**
 * One walk at a time per email. Overlapping callers share that walk.
 * @param {string} email
 */
export function scheduleOnedriveSnapshotRefresh(email) {
  const key = canonicalizeEmail(email);
  if (!key || !builder) return null;
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = Promise.resolve()
    .then(() => builder(key))
    .catch((err) => {
      console.error("[onedrive-snapshot] refresh failed", err);
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, job);
  return job;
}

/**
 * @param {string} email
 */
export function startOnedriveSnapshotLoop(email) {
  const tick = () => {
    scheduleOnedriveSnapshotRefresh(email);
  };
  const first = setTimeout(tick, 2000);
  first.unref?.();
  const timer = setInterval(tick, REFRESH_MS);
  timer.unref?.();
  return timer;
}
