/**
 * Apply Canvas snapshot assignments to Yan's mapped OneDrive class todos.
 * The hourly watch uses this for due, name, and tag updates. It does not
 * touch done, canvasFiles, linkedFiles, or sites. New todos are the
 * new-assignment agent, so the watch passes skipCreate.
 *
 *   node server/canvas-hourly-apply.js [--dry-run]
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";
import { withCloudRetry } from "./cloud-storage-io.js";
import { stripHtml } from "./canvas-sync.js";
import { classMeetingsBetween } from "./education-class-todo.js";
import {
  classPeriodOnDate,
  listClassEntriesForRoot,
  stripTodoTagPrefix,
} from "./education-data.js";
import {
  findMatchingTodo,
  loadDeletedMarkdown,
  namesAreSimilar,
} from "./education-match.js";
import {
  classObjectFinderName,
  formatFinderShortDate,
  listClassObjectDirs,
  objectDirId,
  resolveBookkeepingFile,
  uniqueFinderFolderName,
} from "./education-onedrive.js";

/** OneDrive grade-folder names for Yan's mapped Canvas classes (hourly fast path). */
const MAPPED_ONEDRIVE_FOLDERS = {
  "data-science-1": "A. Data Sci 1",
  "advanced-calculus": "C. Advanced Calc",
  "spanish-4": "D. Spanish 4",
  "us-history": "E. US History",
  "american-literature": "F. American Lit",
  "pe-yoga": "G. PE Yoga",
  physics: "H. Physics",
};

const YAN_ROOT = YAN_EDUCATION_DIR;
const CANVAS_DIR = join(YAN_ROOT, ".canvas");

const TODO_TAG_PREFIX = /^(CW|HW|QA|MA)(?:\s*:\s*|\s+)/i;
const COMBINED_TAG = /^CW\s*\/\s*HW\s*:/i;

let cloudWriteChain = Promise.resolve();

function isCloudPath(path) {
  return String(path).includes(`${sep}Library${sep}CloudStorage${sep}`);
}

async function readCloudJson(path) {
  try {
    const text = await withCloudRetry(path, () => readFile(path, "utf8"), { attempts: 24 });
    return JSON.parse(text);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

function isTransientCloudIo(err) {
  const code = err?.code;
  const errno = err?.errno;
  if (code === "EAGAIN" || code === "EDEADLK" || errno === -11) return true;
  if (String(code || "").includes("Unknown system error -11")) return true;
  return false;
}

async function writeCloudJson(path, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  const writeOnce = async () => {
    await withCloudRetry(path, () => writeFile(path, body, "utf8"), { attempts: 12 });
  };
  if (!isCloudPath(path)) return writeOnce();
  const task = cloudWriteChain.then(() => writeOnce());
  cloudWriteChain = task.catch(() => {});
  return task;
}

function minutesToHm(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m)) return "";
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function parseTagFromTitle(title) {
  const raw = String(title || "").trim();
  if (COMBINED_TAG.test(raw)) return "CW";
  const bracket = raw.match(/^\[(CW|HW|QA|MA)\]/i);
  if (bracket) return bracket[1].toUpperCase();
  const m = raw.match(TODO_TAG_PREFIX);
  if (m) return m[1].toUpperCase();
  return "";
}

function inferTag(assignment) {
  const fromTitle = parseTagFromTitle(assignment.title);
  if (fromTitle) return fromTitle;
  const types = Array.isArray(assignment.types) ? assignment.types : [];
  const title = String(assignment.title || "").toLowerCase();
  const rawTitle = String(assignment.title || "");
  if (/^yoga class\s*#/i.test(rawTitle) || /work period/i.test(rawTitle)) return "CW";
  if (/student[- ]led/i.test(rawTitle)) return "MA";
  if (/survey/i.test(rawTitle) && assignment.courseId === 3638895) return "CW";
  if (types.includes("online_quiz") || /\bquiz\b/.test(title) || /\bcheck\b/.test(title)) {
    return "QA";
  }
  if (
    /\b(test|exam|essay|paper|project|presentation|lab|performance|final)\b/.test(title)
  ) {
    return "MA";
  }
  if (/\bclasswork\b/.test(title) || /\bin[- ]class\b/.test(title)) return "CW";
  const pts = Number(assignment.pointsPossible);
  if (Number.isFinite(pts) && pts >= 10) return "MA";
  return "HW";
}

function yogaShouldHide(name, tag, existing) {
  if (tag !== "CW") return undefined;
  if (existing && existing.hiddenFromHome === false) return undefined;
  const n = String(name || "").toLowerCase();
  if (/yoga class\s*#\d+/i.test(name)) return true;
  if (n.includes("survey") || n.includes("reflection") || n.includes("write-up")) {
    return false;
  }
  if (n.includes("goal setting") || n.includes("student-led")) return false;
  return undefined;
}

function parseDeletedTodos(markdown) {
  /** @type {{ name: string, parent: string, dueDate: string, canvasId: string }[]} */
  const out = [];
  for (const line of String(markdown || "").split("\n")) {
    const m = line.match(
      /^\s*-\s+deleted\s+.+?\|\s*todo\s*\|\s*(.+?)\s*\|\s*on\s+([^|]+?)\s*\|\s*(class:[^|]+)\s*\|/i
    );
    if (!m) continue;
    const on = m[2].trim();
    const day = on.match(/^(\d{4}-\d{2}-\d{2})/);
    const timed = on.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    out.push({
      name: stripTodoTagPrefix(m[1].trim()),
      parent: m[3].trim(),
      dueDate: day ? day[1] : "",
      canvasId: "",
    });
    if (timed) out[out.length - 1].dueDate = timed[1];
  }
  return out;
}

function looksDeleted(candidate, deletedTodos) {
  for (const row of deletedTodos) {
    if (row.parent !== candidate.parent) continue;
    if (namesAreSimilar(row.name, candidate.name)) return true;
    if (
      candidate.dueDate &&
      row.dueDate &&
      row.dueDate === candidate.dueDate &&
      sharesLooseName(row.name, candidate.name)
    ) {
      return true;
    }
  }
  return false;
}

function sharesLooseName(a, b) {
  return namesAreSimilar(a, b);
}

function advCalcHwDue(assignment, cls, schedule) {
  const canvasDate = String(assignment.dueDate || "").trim();
  if (!canvasDate || !cls || !schedule) return null;
  const periodLetter = String(classPeriodOnDate(cls, canvasDate, schedule) || "")
    .trim()
    .toUpperCase();
  if (periodLetter !== "C") return null;
  const schoolStart = String(schedule.schoolStart || canvasDate);
  const meetings = classMeetingsBetween(cls, schedule, schoolStart, canvasDate);
  const cMeetings = meetings.filter((m) => String(m.period || "").toUpperCase() === "C");
  if (!cMeetings.length) return null;
  const last = cMeetings[cMeetings.length - 1];
  if (last.dateKey !== canvasDate) return null;
  const idx = cMeetings.length - 2;
  if (idx < 0) return null;
  const prev = cMeetings[idx];
  return {
    dueDate: prev.dateKey,
    dueTime: minutesToHm(prev.startMin),
  };
}

export function computeDue(assignment, classId, cls, schedule) {
  const id = Number(assignment.id);
  if (id === 40073385) {
    return { dueDate: "2026-10-06", dueTime: "13:50" };
  }
  if (id === 40432088) {
    return { dueDate: "2026-10-26", dueTime: "08:30" };
  }
  if (id === 40440347) {
    return { dueDate: "2026-10-27", dueTime: "09:55" };
  }
  if (id === 40440348) {
    return { dueDate: "2026-10-29", dueTime: "12:25" };
  }
  if (classId === "advanced-calculus" && inferTag(assignment) === "HW") {
    const shifted = advCalcHwDue(assignment, cls, schedule);
    if (shifted) return shifted;
  }
  if (id === 40291677) {
    return { dueDate: "2026-11-20", dueTime: "10:30" };
  }
  const dueDate = String(assignment.dueDate || "").trim();
  const dueTime = String(assignment.dueTime || "").trim();
  return {
    dueDate: dueDate || undefined,
    dueTime: dueTime || undefined,
  };
}

function desiredProps(assignment, classId, cls, schedule) {
  const tag = inferTag(assignment);
  const name = stripTodoTagPrefix(assignment.title);
  const due = computeDue(assignment, classId, cls, schedule);
  const desc = stripHtml(assignment.description, 2000);
  /** @type {Record<string, unknown>} */
  const props = {
    name,
    tag,
    canvasLink: assignment.htmlUrl,
    canvasId: assignment.id,
  };
  if (due.dueDate) props.dueDate = due.dueDate;
  if (due.dueTime) props.dueTime = due.dueTime;
  if (desc) props.description = desc;
  if (classId === "pe-yoga") {
    const hide = yogaShouldHide(name, tag, null);
    if (hide === true) props.hiddenFromHome = true;
  }
  return props;
}

async function cloudReaddir(dir) {
  return withCloudRetry(dir, () => readdir(dir, { withFileTypes: true }), { attempts: 24 });
}

async function listTodoDirs(classFolder) {
  /** @type {{ dirName: string, objectDir: string, props: object, jsonPath: string }[]} */
  const out = [];
  let entries;
  try {
    entries = await cloudReaddir(classFolder);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".education" || e.name === ".Trash") continue;
    if (!objectDirId(e.name)) continue;
    const objectDir = join(classFolder, e.name);
    out.push({
      dirName: e.name,
      objectDir,
      props: null,
      jsonPath: join(objectDir, ".todo.json"),
    });
  }
  return out;
}

function hashNumbersConflict(a, b) {
  const na = String(a || "").match(/#\s*(\d+)/);
  const nb = String(b || "").match(/#\s*(\d+)/);
  if (!na || !nb) return false;
  return na[1] !== nb[1];
}

/**
 * A todo that already belongs to a different Canvas assignment.
 * Empty canvasId can still be claimed. A set id never moves.
 * @param {object|null|undefined} props
 * @param {unknown} canvasId
 */
export function canvasIdBlocksMatch(props, canvasId) {
  const existing = String(props?.canvasId ?? "").trim();
  if (!existing) return false;
  const want = String(canvasId ?? "").trim();
  if (!want) return false;
  return existing !== want;
}

/**
 * Folder title includes a due day (`HW Oct 30 …`). A different due day is a
 * different assignment, even when the titles share a prefix.
 * @param {string} dirName
 * @param {unknown} dueDate
 */
export function folderDueConflicts(dirName, dueDate) {
  const id = objectDirId(dirName) || String(dirName || "").replace(/^\./, "");
  const m = id.match(/^(?:CW|HW|QA|MA)\s+([A-Za-z]{3})\s+(\d{1,2})\b/i);
  if (!m) return false;
  const want = formatFinderShortDate(dueDate);
  if (!want) return false;
  const got = `${m[1].slice(0, 1).toUpperCase()}${m[1].slice(1).toLowerCase()} ${Number(m[2])}`;
  return got.toLowerCase() !== want.toLowerCase();
}

/**
 * Fallback when a todo has no canvasId yet. Same assignment only.
 * A shared opening ("Read and annotate Walden") is not a match.
 * @param {string} dirName
 * @param {{ name?: string, dueDate?: string }} desired
 */
export function folderNameMatchesTodo(dirName, desired) {
  if (folderDueConflicts(dirName, desired?.dueDate)) return false;
  const id = objectDirId(dirName) || String(dirName || "").replace(/^\./, "");
  const stripped = id
    .replace(/^(CW|HW|QA|MA)\s+/i, "")
    .replace(/^[A-Za-z]{3}\s+\d{1,2}\s+/i, "")
    .trim();
  if (hashNumbersConflict(stripped, desired?.name)) return false;
  return namesAreSimilar(stripped, desired?.name);
}

async function findTodoDirByFolderScan(classFolder, desired) {
  let entries;
  try {
    entries = await cloudReaddir(classFolder);
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name === ".education") continue;
    if (!folderNameMatchesTodo(e.name, desired)) continue;
    const objectDir = join(classFolder, e.name);
    const jsonPath = await resolveBookkeepingFile(objectDir, "todo.json");
    if (!jsonPath) continue;
    let props;
    try {
      props = await readCloudJson(jsonPath);
    } catch {
      continue;
    }
    if (!props || typeof props !== "object") continue;
    if (canvasIdBlocksMatch(props, desired?.canvasId)) continue;
    return { dirName: e.name, objectDir, props, jsonPath };
  }
  return null;
}

async function todoJsonPath(t) {
  if (t.resolvedJsonPath) return t.resolvedJsonPath;
  const path =
    (await resolveBookkeepingFile(t.objectDir, "todo.json")) ||
    join(t.objectDir, ".todo.json");
  t.jsonPath = path;
  t.resolvedJsonPath = path;
  return path;
}

async function propsForTodo(t) {
  if (t.props && typeof t.props === "object") return t.props;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      await todoJsonPath(t);
      const props = await readCloudJson(t.jsonPath);
      if (props && typeof props === "object") {
        t.props = props;
        return props;
      }
    } catch (err) {
      if (!isTransientCloudIo(err)) break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

async function hydrateTodos(todos) {
  for (const t of todos) {
    await propsForTodo(t);
  }
}

function buildTodoIndexes(todos) {
  /** @type {Map<string, typeof todos[0]>} */
  const byCanvasId = new Map();
  /** @type {Map<string, typeof todos[0]>} */
  const byCanvasLink = new Map();
  for (const t of todos) {
    const props = t.props;
    if (!props || typeof props !== "object") continue;
    const id = String(props.canvasId ?? "").trim();
    if (id) byCanvasId.set(id, t);
    const link = String(props.canvasLink || "").trim();
    if (link) byCanvasLink.set(link, t);
  }
  return { byCanvasId, byCanvasLink };
}

function findTodoMatch(todos, indexes, assignment, classId, desired) {
  const canvasId = String(assignment.id);
  const byId = indexes.byCanvasId.get(canvasId);
  if (byId) return byId;
  const link = String(assignment.htmlUrl || "");
  const byLink = indexes.byCanvasLink.get(link);
  if (byLink) return byLink;
  const parent = `class:${classId}`;
  const candidate = {
    parent,
    name: desired.name,
    dueDate: desired.dueDate || "",
    dueTime: desired.dueTime || "",
  };
  const open = todos.filter(
    (t) => t.props && typeof t.props === "object" && !canvasIdBlocksMatch(t.props, canvasId)
  );
  const slim = open.map((t) => ({
    parent,
    name: String(t.props.name || ""),
    dueDate: String(t.props.dueDate || ""),
    dueTime: String(t.props.dueTime || ""),
    _ref: t,
  }));
  const hit = findMatchingTodo(candidate, slim);
  if (hit?._ref) return hit._ref;
  return open.find((t) => folderNameMatchesTodo(t.dirName, desired)) || null;
}

async function loadMappedClassEntries(mappedClassIds) {
  const meta = JSON.parse(await readFile(join(YAN_ROOT, "meta.json"), "utf8"));
  const gradeDir = join(
    String(meta.onedriveRoot || "").trim(),
    String(meta.gradeFolder || "").trim()
  );
  /** @type {{ id: string, objectDir: string, classFolder: string, source: "onedrive" }[]} */
  const entries = [];
  for (const classId of mappedClassIds) {
    const folderName = MAPPED_ONEDRIVE_FOLDERS[classId];
    if (!folderName) continue;
    const classFolder = join(gradeDir, folderName);
    const objectDirs = await listClassObjectDirs(gradeDir, folderName);
    const objectDir = objectDirs[0] || join(classFolder, ".education");
    entries.push({
      id: classId,
      objectDir,
      classFolder,
      source: "onedrive",
    });
  }
  if (entries.length) return entries;
  return (await listClassEntriesForRoot(YAN_ROOT)).filter((e) => mappedClassIds.has(e.id));
}

async function loadContext() {
  const snapshot = JSON.parse(await readFile(join(CANVAS_DIR, "snapshot.json"), "utf8"));
  const courseMap = JSON.parse(await readFile(join(CANVAS_DIR, "course-map.json"), "utf8"));
  const schedule = JSON.parse(await readFile(join(YAN_ROOT, "schedule.json"), "utf8"));
  const deletedMarkdown = await loadDeletedMarkdown(YAN_ROOT);
  const deletedTodos = parseDeletedTodos(deletedMarkdown);
  const mappedClassIds = new Set(Object.values(courseMap));
  const entries = await loadMappedClassEntries(mappedClassIds);
  const classById = new Map(entries.map((e) => [e.id, e]));
  /** @type {Map<string, object>} */
  const classProps = new Map();
  for (const entry of entries) {
    const classPath = await resolveBookkeepingFile(entry.objectDir, "class.json");
    if (!classPath) continue;
    try {
      const props = await readCloudJson(classPath);
      if (props) classProps.set(entry.id, props);
    } catch {
      /* skip */
    }
  }
  return { snapshot, courseMap, schedule, deletedTodos, classById, classProps };
}

/**
 * @param {{ dryRun?: boolean }} [opts]
 */
export async function applyCanvasHourlyTodos(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const skipCreate = Boolean(opts.skipCreate);
  const { snapshot, courseMap, schedule, deletedTodos, classById, classProps } =
    await loadContext();
  const mappedIds = new Set(Object.keys(courseMap).map(Number));
  const assignments = (snapshot.assignments || []).filter((a) =>
    mappedIds.has(Number(a.courseId))
  );

  let created = 0;
  let updated = 0;
  let skipped = 0;
  /** @type {string[]} */
  const log = [];
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const createdIds = [];
  /** @type {string[]} */
  const skippedIds = [];

  /** @type {Map<string, { todos: Awaited<ReturnType<typeof listTodoDirs>>, indexes: ReturnType<typeof buildTodoIndexes> }>} */
  const todosByClass = new Map();
  async function todosForClass(classId) {
    if (todosByClass.has(classId)) return todosByClass.get(classId);
    const entry = classById.get(classId);
    const list = entry ? await listTodoDirs(entry.classFolder) : [];
    if (process.env.CANVAS_HOURLY_VERBOSE) {
      console.error(`[canvas-hourly-apply] ${classId}: ${list.length} todo folders`);
    }
    await hydrateTodos(list);
    const indexes = buildTodoIndexes(list);
    const bundle = { todos: list, indexes };
    todosByClass.set(classId, bundle);
    return bundle;
  }

  for (const assignment of assignments) {
    const classId = courseMap[String(assignment.courseId)];
    if (!classId) continue;
    const entry = classById.get(classId);
    if (!entry || entry.source !== "onedrive") continue;
    const cls = classProps.get(classId) || { id: classId };
    const desired = desiredProps(assignment, classId, cls, schedule);
    const parent = `class:${classId}`;
    const { todos, indexes } = await todosForClass(classId);
    let existing = findTodoMatch(todos, indexes, assignment, classId, desired);
    if (!existing) {
      existing = await findTodoDirByFolderScan(entry.classFolder, desired);
      if (existing) {
        const already = todos.find((t) => t.dirName === existing.dirName);
        if (already) {
          existing = already;
          await propsForTodo(existing);
        } else {
          todos.push(existing);
        }
        Object.assign(indexes, buildTodoIndexes(todos));
      }
    }

    if (!existing) {
      if (skipCreate) {
        skipped += 1;
        continue;
      }
      const candidate = {
        parent,
        name: desired.name,
        dueDate: desired.dueDate || "",
        dueTime: desired.dueTime || "",
      };
      if (looksDeleted(candidate, deletedTodos)) {
        skipped += 1;
        skippedIds.push(String(assignment.id));
        continue;
      }
      const yogaHide = classId === "pe-yoga" ? yogaShouldHide(desired.name, desired.tag, null) : undefined;
      if (yogaHide === true) desired.hiddenFromHome = true;
      const finderBase = classObjectFinderName("todo", desired);
      const occupied = todos.map((t) => objectDirId(t.dirName) || t.dirName.replace(/^\./, ""));
      const folderId = uniqueFinderFolderName(finderBase, occupied);
      const objectDir = join(entry.classFolder, folderId);
      const jsonPath =
        (await resolveBookkeepingFile(objectDir, "todo.json")) ||
        join(objectDir, ".todo.json");
      const onDisk = await resolveBookkeepingFile(objectDir, "todo.json");
      if (onDisk) {
        existing = {
          dirName: folderId,
          objectDir,
          props: await readCloudJson(onDisk),
          jsonPath: onDisk,
        };
        todos.push(existing);
      } else {
        const now = new Date().toISOString();
        const payload = {
          ...desired,
          done: false,
          createdAt: now,
        };
        if (!dryRun) {
          try {
            await withCloudRetry(objectDir, () => mkdir(objectDir, { recursive: true }), {
              attempts: 12,
            });
            await writeCloudJson(jsonPath, payload);
          } catch (err) {
            errors.push(`create ${classId} canvas ${assignment.id}: ${err?.message || err}`);
            continue;
          }
        }
        todos.push({
          dirName: folderId,
          objectDir,
          props: payload,
          jsonPath,
        });
        created += 1;
        createdIds.push(String(assignment.id));
        log.push(`create ${classId} ${folderId} canvas ${assignment.id}`);
        continue;
      }
    }

    const baseProps = await propsForTodo(existing);
    if (!baseProps || typeof baseProps !== "object") {
      errors.push(
        `update ${classId} canvas ${assignment.id}: unreadable todo.json (${existing.dirName})`
      );
      continue;
    }
    const merged = { ...baseProps };
    let changed = false;
    for (const key of ["name", "tag", "dueDate", "dueTime", "canvasLink", "canvasId"]) {
      if (desired[key] == null) continue;
      const cur = merged[key];
      const next = desired[key];
      const same =
        key === "canvasId"
          ? String(cur ?? "") === String(next)
          : cur === next;
      if (!same) {
        merged[key] = next;
        changed = true;
      }
    }
    if (classId === "pe-yoga" && desired.tag === "CW") {
      const hide = yogaShouldHide(merged.name, merged.tag, merged);
      if (hide === true && merged.hiddenFromHome !== true) {
        merged.hiddenFromHome = true;
        changed = true;
      }
    }
    if (!changed) continue;
    if (!dryRun) {
      try {
        await writeCloudJson(existing.jsonPath, merged);
      } catch (err) {
        errors.push(`update ${classId} canvas ${assignment.id}: ${err?.message || err}`);
        continue;
      }
    }
    updated += 1;
    const diffKeys = [];
    for (const key of ["name", "tag", "dueDate", "dueTime", "canvasLink", "canvasId", "hiddenFromHome"]) {
      const cur = baseProps[key];
      const next = merged[key];
      const same = key === "canvasId" ? String(cur ?? "") === String(next ?? "") : cur === next;
      if (!same) diffKeys.push(key);
    }
    log.push(
      `update ${classId} ${existing.dirName} canvas ${assignment.id}${diffKeys.length ? ` [${diffKeys.join(", ")}]` : ""}`
    );
  }

  return {
    ok: errors.length === 0,
    created,
    updated,
    skipped,
    createdIds,
    skippedIds,
    assignments: assignments.length,
    log,
    errors,
  };
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
  const dryRun = process.argv.includes("--dry-run");
  applyCanvasHourlyTodos({ dryRun })
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
