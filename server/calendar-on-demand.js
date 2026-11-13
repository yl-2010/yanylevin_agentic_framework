/**
 * Jev gate on new messages. A yes means a calendar event or a specific
 * task the message assigns to Yan. That starts one Composer 2.5 run for
 * the thread, after a short debounce. Composer picks the calendar or a todo.
 * A text from either parent is calendar or nothing. Jev is not offered a
 * todo, and the run that follows only writes a calendar event.
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SENT_FOOTER } from "./imessage-mention.js";
import { loadCalendarTombstones } from "./calendar-memory.js";
import { addLocalDays, zonedParts } from "./calendar-cli.js";
import { objectDirId, resolveBookkeepingFile } from "./education-onedrive.js";
import { listTopLevelProjects, PERSONAL_PROJECTS, YAN_EDUCATION_DIR } from "./onedrive-projects.js";
import { parseFrontmatter, BRAIN_ROOT } from "./brain-lib.js";
import { phoneDigits } from "./local-clock.js";
import { choice, noul, systemOne, typesafeConfig } from "./typesafe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CALENDAR_SIGNAL_THRESHOLD = 0.35;
export const DEBOUNCE_MS = 45_000;
export const SCHOOL_MAIL_POLL_MS = 30_000;
export const TEAMS_CHANNEL_POLL_MS = 60_000;
export const SEEN_PATH = "/tmp/yanylevin-calendar-on-demand-seen.json";
export const SCHOOL_MAIL_STATE_PATH = "/tmp/yanylevin-school-mail-calendar.json";
export const TEAMS_CHANNEL_STATE_PATH = "/tmp/yanylevin-teams-channel-calendar.json";
const SEEN_MAX = 800;
/** Mail and channel posts can land in the local index hours after their
 * received time. The poll keeps re-reading this window. Seen ids skip dupes. */
export const SCHOOL_MAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
export const TEAMS_CHANNEL_LOOKBACK_MS = 6 * 60 * 60 * 1000;
export const SCHOOL_MAIL_FETCH_MAX = 100;

/**
 * Newest timestamp actually present in this page. An empty page keeps the
 * previous stamp. Never substitute wall-clock now: that hides mail which
 * syncs late with an older received time.
 * @param {string} prev
 * @param {object[]} rows
 * @param {string} [field]
 */
export function nextObservedStamp(prev, rows, field = "received") {
  let newest = Date.parse(prev);
  let found = false;
  for (const row of rows || []) {
    const ms = Date.parse(String(row?.[field] || ""));
    if (!Number.isFinite(ms)) continue;
    found = true;
    if (!Number.isFinite(newest) || ms > newest) newest = ms;
  }
  if (!found || !Number.isFinite(newest)) return prev;
  return new Date(newest).toISOString();
}

export const CALENDAR_ON_DEMAND_MODEL_SPEC = {
  id: process.env.CURSOR_CALENDAR_ON_DEMAND_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** Yes is a calendar event or a specific assigned task. Composer picks which. */
export const CALENDAR_SIGNAL_QUESTION = noul(
  "Could this include a calendar event Yan might attend, or a specific task the message assigns to him?",
  {
    true: "A plan, meeting, invite, appointment, or a change to when or where something happens. Count maybes, a TBD venue, and a named day with no clock. Or a specific task the message assigns to him. Fill out a form a teacher or the school assigned him, answer a direct question asked of him, send an email or file the message says he has to send, or do another concrete task someone told him to do. The action is named in the text. A suggestion, an FYI, or a maybe is not a task. A call to @agent or @agentg is not a task for him. A calendar plan in that same message still counts. A survey, poll, or form a student emailed to his school inbox is not a task.",
    false: "Nothing for the calendar and no specific task assigned to him. A reaction, thanks, a newsletter, a passcode, homework or Canvas with no meeting, college recruitment, or mail that only informs him. Also a suggestion, a nudge, an optional if-you-want, a question not asked of him, or a task for someone else. Also a call to @agent or @agentg with no plan he is showing up for. Making a site, a page, or any other job handed to the agent is not his task. Also a survey, poll, or form a student sent to his school email, including a stats project, a classmate blast, and Student News.",
  }
);

/**
 * Parent texts only. Calendar or nothing. No task option.
 * A chore, a reply, or a form is nothing.
 */
export const PARENT_CALENDAR_QUESTION = choice(
  "Is this a calendar event Yan might attend, or nothing? There is no task option.",
  {
    calendar:
      "A plan, meeting, invite, appointment, or a change to when or where something happens. Count maybes, a TBD venue, and a named day with no clock.",
    nothing:
      "Not a calendar event. A chore, a reply, a form, a file to send, thanks, FYI, or anything he is not showing up for.",
  }
);

const PARENT_TEXT_SLUGS = [
];

/** @type {{ at: number, set: Set<string> | null }} */
let parentHandleCache = { at: 0, set: null };
/** @type {Map<string, { at: number, map: Map<string, string> }>} */
const handleNameCache = new Map();

const USER_TODOS_DIR = join(YAN_EDUCATION_DIR, "todos");
const COLLEGE_PREP_TODOS_DIR = join(PERSONAL_PROJECTS, "College Prep", "todos");

/** @type {Map<string, { key: string, messages: object[], timer: ReturnType<typeof setTimeout>|null, run: Function|null }>} */
const slots = new Map();
/** @type {object[]} */
const queue = [];
let running = false;
/** @type {Map<string, Set<string>>} */
const memorySeen = new Map();
/** @type {Set<string>} */
const inflight = new Set();
let seenLoaded = false;

/** @type {ReturnType<typeof setInterval>|null} */
let schoolTimer = null;
/** @type {ReturnType<typeof setInterval>|null} */
let channelTimer = null;
let schoolTicking = false;
let channelTicking = false;

function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

export function resetCalendarOnDemandForTests() {
  for (const slot of slots.values()) {
    if (slot.timer) clearTimeout(slot.timer);
  }
  slots.clear();
  queue.length = 0;
  running = false;
  memorySeen.clear();
  inflight.clear();
  seenLoaded = false;
  parentHandleCache = { at: 0, set: null };
  handleNameCache.clear();
}

/**
 * @param {unknown} answer
 */
export function calendarSignalYes(answer) {
  const raw =
    answer && typeof answer === "object"
      ? answer.noul ?? answer.probability
      : answer;
  const n = Number(raw);
  return Number.isFinite(n) && n >= CALENDAR_SIGNAL_THRESHOLD;
}

/**
 * Parent calendar choice. Same recall floor as the noul gate.
 * @param {unknown} answer
 */
export function parentCalendarYes(answer) {
  const picked = String(answer && typeof answer === "object" ? answer.choice : "")
    .trim()
    .toLowerCase();
  const confidence = Number(answer && typeof answer === "object" ? answer.confidence : NaN);
  return picked === "calendar" && Number.isFinite(confidence) && confidence >= CALENDAR_SIGNAL_THRESHOLD;
}

/**
 * Phone digits or lowercase email. Short junk stays blank.
 * @param {unknown} raw
 */
export function parentHandleKey(raw) {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("@")) return s;
  const digits = phoneDigits(s);
  return digits.length >= 10 ? digits : "";
}

/**
 * @param {Iterable<unknown>} values
 */
export function parentHandleSet(values) {
  const set = new Set();
  for (const value of values || []) {
    const key = parentHandleKey(value);
    if (key) set.add(key);
  }
  return set;
}

function handleInSet(raw, set) {
  const key = parentHandleKey(raw);
  return Boolean(key && set && set.has(key));
}

function isDirectChat(chatId, handle) {
  const id = String(chatId || "").trim();
  const h = String(handle || "").trim();
  if (!id) return Boolean(h);
  if (h && id.toLowerCase() === h.toLowerCase()) return true;
  if (id.startsWith("+")) return true;
  if (id.includes("@")) return true;
  return false;
}

/**
 * Incoming iMessage from either parent. Yan's own texts in that chat are not.
 * @param {object|null|undefined} message
 * @param {Set<string>} handleSet
 */
export function isParentIMessage(message, handleSet) {
  if (!message || typeof message !== "object") return false;
  if (message.fromMe === true || message.who === "yan") return false;
  if (handleInSet(message.handle, handleSet)) return true;
  const direct = isDirectChat(message.chatId, message.handle);
  if (direct && handleInSet(message.chatId, handleSet)) return true;
  return false;
}

function handlesFromPersonFields(fields) {
  const emails = Array.isArray(fields?.emails) ? fields.emails : [];
  const phones = Array.isArray(fields?.phones) ? fields.phones : [];
  return [...phones, ...emails];
}

async function loadParentHandleSet() {
  const now = Date.now();
  if (parentHandleCache.set && now - parentHandleCache.at < 60_000) {
    return parentHandleCache.set;
  }
  const set = new Set();
  for (const slug of PARENT_TEXT_SLUGS) {
    try {
      const raw = await readFile(join(BRAIN_ROOT, "people", slug, "person.md"), "utf8");
      const { fields } = parseFrontmatter(raw);
      for (const value of handlesFromPersonFields(fields)) {
        const key = parentHandleKey(value);
        if (key) set.add(key);
      }
    } catch {
      /* missing card */
    }
  }
  parentHandleCache = { at: now, set };
  return set;
}

/**
 * @param {object} message
 * @param {{ parentHandles?: Set<string> }} [deps]
 */
async function messageIsParentText(message, deps = {}) {
  if (deps.parentHandles instanceof Set) {
    return isParentIMessage(message, deps.parentHandles);
  }
  return isParentIMessage(message, await loadParentHandleSet());
}

/**
 * @agent / @agentg already starts a personal-agent turn. This watcher must
 * not also file that job as Yan's education todo.
 * @param {unknown} text
 */
export function isAgentInstruction(text) {
  return /(^|\s)@agentg?\b/i.test(String(text || ""));
}

/**
 * @param {string} source
 * @param {object|null|undefined} message
 */
export function rowEligible(source, message) {
  if (!message || typeof message !== "object") return false;
  if (source === "imessage") {
    if (message.tapback) return false;
    const associated = Number(message.associatedType) || 0;
    if (associated >= 2000 && associated <= 3007) return false;
    const text = String(message.text || "").trim();
    if (!text) return false;
    if (text.toLowerCase().includes(AGENT_SENT_FOOTER.toLowerCase())) return false;
    if (isAgentInstruction(text)) return false;
    return true;
  }
  if (source === "teams" || source === "teams-channel") {
    const type = String(message.messageType || "message").trim().toLowerCase();
    if (type && type !== "message") return false;
    const text = String(message.text || "").trim();
    if (!text) return false;
    if (text.toLowerCase().includes(AGENT_SENT_FOOTER.toLowerCase())) return false;
    if (isAgentInstruction(text)) return false;
    return true;
  }
  const subject = String(message.subject || "").trim();
  const body = String(message.body || message.preview || "").trim();
  return Boolean(subject || body);
}

/**
 * @param {string} source
 * @param {object|null|undefined} message
 */
export function rowKey(source, message) {
  if (!message || typeof message !== "object") return "";
  if (source === "imessage") {
    const guid = String(message.guid || "").trim();
    if (guid) return `guid:${guid}`;
    if (message.id != null && String(message.id).trim()) return `id:${message.id}`;
    return "";
  }
  if (source === "teams" || source === "teams-channel") {
    const id = String(message.id || "").trim();
    const chatId = String(message.chatId || "").trim();
    if (id && chatId) return `${chatId}:${id}`;
    return id ? `id:${id}` : "";
  }
  const mid = String(message.messageId || message.id || "").trim();
  return mid ? `mid:${mid}` : "";
}

/**
 * @param {string} source
 * @param {object|null|undefined} message
 */
export function threadKey(source, message) {
  if (source === "imessage") {
    return `imessage:${message?.chatId || message?.chat || message?.handle || "unknown"}`;
  }
  if (source === "teams" || source === "teams-channel") {
    return `${source}:${message?.chatId || message?.channel || message?.chat || "unknown"}`;
  }
  const from = String(message?.fromAddress || message?.from || "unknown")
    .toLowerCase()
    .slice(0, 160);
  return `${source}:${from}`;
}

/**
 * @param {string} source
 * @param {object} message
 */
export function buildJevState(source, message) {
  if (source === "imessage") {
    return {
      source: "imessage",
      chat: String(message?.chat || "").slice(0, 160),
      from: message?.fromMe
        ? "Yan"
        : String(message?.handle || message?.sender || "").slice(0, 160),
      text: String(message?.text || "").slice(0, 4000),
    };
  }
  if (source === "teams" || source === "teams-channel") {
    return {
      source,
      chat: String(message?.chat || message?.channel || "").slice(0, 160),
      from: String(message?.from || message?.fromEmail || "").slice(0, 160),
      text: String(message?.text || "").slice(0, 4000),
    };
  }
  return {
    source,
    from: String(message?.from || "").slice(0, 200),
    subject: String(message?.subject || "").slice(0, 300),
    received: String(message?.received || "").slice(0, 40),
    body: String(message?.body || message?.preview || "").slice(0, 4000),
  };
}

/**
 * Phone digits and emails to the person name on that brain card.
 * First slug in alpha order wins a shared handle.
 * @param {string} [peopleDir]
 */
export async function loadHandleNameMap(peopleDir = join(BRAIN_ROOT, "people")) {
  const now = Date.now();
  const cached = handleNameCache.get(peopleDir);
  if (cached && now - cached.at < 60_000) return cached.map;
  const map = new Map();
  let slugs = [];
  try {
    slugs = await readdir(peopleDir);
  } catch {
    handleNameCache.set(peopleDir, { at: now, map });
    return map;
  }
  slugs.sort();
  for (const slug of slugs) {
    if (!slug || slug.startsWith(".")) continue;
    try {
      const raw = await readFile(join(peopleDir, slug, "person.md"), "utf8");
      const { fields } = parseFrontmatter(raw);
      const name = String(fields?.name || "").trim();
      if (!name) continue;
      for (const value of handlesFromPersonFields(fields)) {
        const key = parentHandleKey(value);
        if (key && !map.has(key)) map.set(key, name);
      }
    } catch {
      /* index.md and cards without person.md */
    }
  }
  handleNameCache.set(peopleDir, { at: now, map });
  return map;
}

/**
 * @param {object} row
 * @param {Map<string, string> | undefined} handleNames
 */
function applyHandleNames(row, handleNames) {
  if (!(handleNames instanceof Map)) return row;
  const fromName = nameForHandle(row.from, handleNames);
  const chatName = nameForHandle(row.chat, handleNames);
  if (fromName) row.fromName = fromName;
  if (chatName) row.chatName = chatName;
  return row;
}

/**
 * @param {unknown} raw
 * @param {Map<string, string>} handleNames
 */
function nameForHandle(raw, handleNames) {
  const key = parentHandleKey(raw);
  if (!key) return "";
  return handleNames.get(key) || "";
}

function clipPackMessage(source, message, calendarOnly) {
  const row = {
    source,
    at: String(message?.at || message?.received || "").slice(0, 40),
    from: message?.fromMe
      ? "Yan"
      : String(message?.from || message?.handle || message?.fromEmail || "").slice(0, 160),
    chat: String(message?.chat || message?.channel || message?.subject || "").slice(0, 180),
    text: String(message?.text || message?.body || message?.preview || "").slice(0, 2500),
  };
  if (calendarOnly) row.calendarOnly = true;
  return row;
}

function isSkippedTodo(id, props) {
  if (!props || typeof props !== "object") return true;
  if (props.fixture === true) return true;
  if (String(id || "").startsWith("_example-")) return true;
  if (props.kind === "dailyBriefing") return true;
  if (props.done === true) return true;
  return false;
}

/**
 * Main and hidden projects the todo agent may write into.
 * Backend stays out. A fixture id stays out.
 * @param {{ roots?: string[] }} [opts]
 */
export async function projectTodoTargets(opts = {}) {
  const rows = await listTopLevelProjects({ includeBackend: false, roots: opts.roots });
  return rows
    .filter((row) => row.props?.fixture !== true && !String(row.id || "").startsWith("_example"))
    .map((row) => ({
      id: row.id,
      name: String(row.props?.name || row.folderName || row.id).replace(/^\.+/, ""),
      todosDir: join(row.dir, "todos"),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Open user-level and project todos, plus deleted todo rows.
 * Daily briefings and fixtures stay out. Missing folders are empty.
 * A scoped test passes collegeTodosDir or projectDirs and does not scan live projects.
 * @param {{ userTodosDir?: string, collegeTodosDir?: string, projectDirs?: { id: string, name: string, todosDir: string }[], deletedDir?: string }} [roots]
 */
export async function loadActionTodoIndex(roots = {}) {
  const userTodosDir = roots.userTodosDir || USER_TODOS_DIR;
  const deletedDir = roots.deletedDir || YAN_EDUCATION_DIR;
  const scoped =
    roots.userTodosDir != null || roots.collegeTodosDir != null || roots.projectDirs != null;
  /** @type {{ id: string, name: string, todosDir: string }[]} */
  let projects = [];
  if (Array.isArray(roots.projectDirs)) {
    projects = roots.projectDirs
      .filter((row) => row && row.id && row.todosDir)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name || row.id),
        todosDir: String(row.todosDir),
      }));
  } else if (roots.collegeTodosDir) {
    projects = [
      {
        id: "college-prep",
        name: "College Prep",
        todosDir: roots.collegeTodosDir,
      },
    ];
  } else if (!scoped) {
    projects = await projectTodoTargets();
  }
  const todos = [...(await readOpenTodos(userTodosDir, "user-level"))];
  for (const project of projects) {
    todos.push(...(await readOpenTodos(project.todosDir, `project:${project.id}`)));
  }
  todos.sort((a, b) => {
    const day = String(a.dueDate || "9999").localeCompare(String(b.dueDate || "9999"));
    if (day) return day;
    return String(a.name).localeCompare(String(b.name));
  });
  return {
    todos: todos.slice(0, 80),
    deleted: await readDeletedTodoLines(deletedDir),
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      todosDir: project.todosDir,
    })),
  };
}

/**
 * @param {string} parentDir
 * @param {string} parent
 */
async function readOpenTodos(parentDir, parent) {
  /** @type {object[]} */
  const out = [];
  let names = [];
  try {
    const entries = await readdir(parentDir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      console.error(
        "[calendar-on-demand] todos",
        parent,
        err instanceof Error ? err.message : err
      );
    }
    return out;
  }
  for (const dirName of names) {
    const id = objectDirId(dirName);
    if (!id) continue;
    const folder = join(parentDir, dirName);
    let props = null;
    try {
      const jsonPath = await resolveBookkeepingFile(folder, "todo.json");
      if (!jsonPath) continue;
      props = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch {
      continue;
    }
    if (isSkippedTodo(id, props)) continue;
    out.push({
      name: String(props.name || id),
      dueDate: typeof props.dueDate === "string" ? props.dueDate : "",
      dueTime: typeof props.dueTime === "string" ? props.dueTime : "",
      parent,
      folder,
    });
  }
  return out;
}

/**
 * @param {string} deletedDir
 */
async function readDeletedTodoLines(deletedDir) {
  try {
    const path = await resolveBookkeepingFile(deletedDir, "deleted.md");
    if (!path) return "";
    const text = await readFile(path, "utf8");
    return String(text || "")
      .split("\n")
      .filter((line) => line.includes("| todo |"))
      .slice(-60)
      .join("\n");
  } catch (err) {
    if (err?.code === "ENOENT") return "";
    console.error(
      "[calendar-on-demand] deleted todos",
      err instanceof Error ? err.message : err
    );
    return "";
  }
}

/**
 * Pacific dates with weekday names, today first. The model looks these up
 * instead of counting "next Saturday" from an ISO timestamp.
 * @param {Date} [now]
 * @param {number} [days]
 */
export function pacificWeekdayLines(now = new Date(), days = 21) {
  const tz = "America/Los_Angeles";
  const startKey = zonedParts(now, tz).dateKey;
  const lines = [];
  for (let i = 0; i < days; i++) {
    const key = addLocalDays(startKey, i);
    const noon = new Date(`${key}T20:00:00Z`);
    const weekday = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
    }).format(noon);
    lines.push(`${key} ${weekday}`);
  }
  return lines.join("\n");
}

/**
 * @param {{
 *   source: string,
 *   messages: object[],
 *   thread?: object[],
 *   events?: object[],
 *   tombstones?: object[],
 *   todos?: object[],
 *   deletedTodos?: string,
 *   skillText?: string,
 *   calendarOnly?: boolean,
 * }} pack
 */
export function buildOnDemandPrompt(pack) {
  const source = pack.source;
  const flags = (pack.messages || []).map((item) => item.calendarOnly === true);
  const allParent = flags.length > 0 && flags.every(Boolean);
  const someParent = flags.some(Boolean);
  const calendarOnly = pack.calendarOnly === true || allParent;
  const mixedParent = !calendarOnly && someParent;
  const handleNames = pack.handleNames instanceof Map ? pack.handleNames : undefined;
  const triggers = (pack.messages || []).map((item) =>
    applyHandleNames(
      clipPackMessage(source, item.message || item, item.calendarOnly === true),
      handleNames
    )
  );
  const thread = (pack.thread || [])
    .slice(-55)
    .map((row) => applyHandleNames(clipPackMessage(source, row), handleNames));
  const events = (pack.events || []).slice(0, 80).map((ev) => ({
    id: ev.id,
    title: ev.title,
    start: ev.start,
    end: ev.end,
    allDay: Boolean(ev.allDay),
    location: ev.location || "",
    url: ev.url || "",
    calendar: ev.calendar || "",
  }));
  const tombstones = (pack.tombstones || []).slice(-40).map((row) => ({
    id: row.id,
    title: row.title,
    start: row.start || row.startStamp || "",
    end: row.end || row.endStamp || "",
    allDay: Boolean(row.allDay),
    location: row.location || "",
    url: row.url || "",
  }));
  const todos = (pack.todos || []).slice(0, 80).map((row) => ({
    name: row.name,
    dueDate: row.dueDate || "",
    dueTime: row.dueTime || "",
    parent: row.parent || "",
    folder: row.folder || "",
  }));
  const deletedTodos = String(pack.deletedTodos || "").trim();
  const calendarLine =
    "Calendar. Add an event he is actually showing up for. A named day helps. Look up the weekday on the list below. This Saturday is the first Saturday. Next Saturday is the second. Do not count days yourself. TBD venue is fine when the plan is real. Look up the real start and end before you create. Pass --all-day only when the event has no clock (no school, a birthday, a holiday, a date-range delivery). A game, dinner, practice, appointment, or gym session gets that window, not the whole day. If you cannot find the time, create nothing for it. Do not move an existing event to another calendar. That resends invites, including a move on the same account. Pick the calendar only when you create. New events pick iCloud unless you are inviting someone, then Exchange. Skip college spam, including recruitment mail, Scoir, apply-now, and info sessions he did not register for. Skip the weekly EPS college-visit list unless Yan said he signed up for that visit. Skip education todos, homework, Canvas, due dates, and other dashboard items. Those stay on the education dashboard. The calendar is events. Also skip the EPS bell schedule, and EPS Ventures unless there is a signup confirmation.";
  /** @type {string[]} */
  const parts = [
    "Follow .cursor/skills/calendar-on-demand/SKILL.md and .cursor/skills/personal-calendar/SKILL.md.",
  ];
  if (calendarOnly) {
    parts.push(
      "You are the realtime calendar agent for Yan (you@example.com). Local only. Never spawn a Cursor cloud agent. ",
      "One item only: the plan this message is about. Do not sweep the inbox, other chats, or the rest of the day for unrelated events.",
      "This text is from one of Yan's parents. Jev chose calendar or nothing. Nothing did not wake you. Jev is that classifier, not a person in the chat and not a guest. Never put Jev in the title, notes, or guest list. Name the event after the people in the thread. You still decide. Create nothing when he is not showing up.",
      "Your only job is a calendar event if he is showing up. Do not create a todo. Do not update a todo. Do not write todo.json. A chore, a reply, a form, or a file to send is nothing.",
      calendarLine
    );
  } else {
    parts.push(
      "You are the realtime calendar and todo agent for Yan (you@example.com). Local only. Never spawn a Cursor cloud agent. ",
      "One item only: the plan or task this message is about. Do not sweep the inbox, other chats, or the rest of the day for unrelated events.",
      "Jev only asked whether this message might be a calendar event or a specific task the message assigns to Yan. Jev is that classifier, not a person in the chat and not a guest. Never put Jev in the title, notes, guest list, or todo name. Name a calendar event after the people in the thread. You still decide. Create nothing when it is not calendar-worthy and not a specific task assigned to him.",
      "Pick one. A calendar event if he is showing up. A todo only when the message assigns him a specific task and he is not attending an event. Do not create both unless the message has two separate things. RSVP, see you there, or confirming the plan is the calendar event, not a second todo. A vague follow-up is not that second thing."
    );
    if (mixedParent) {
      parts.push(
        "A trigger with calendarOnly true is a text from one of Yan's parents. That text is a calendar event or nothing. Do not create a todo from it. Do not update a todo from it. Do not write todo.json because of it."
      );
    }
    parts.push(
      calendarLine,
      `Todo. Only a specific task the message assigns to him. In a message, someone has to give him the task. In email, the mail has to give him a direct task, such as fill out a form a teacher or the school assigned him, reply to a direct question asked of him, or send an email about something the mail says he has to email about. The action is named in the text. If you cannot point at that sentence, create no todo. Skip FYI, thanks, newsletters, passcodes, suggestions, nudges, let-me-know-if-you-want, questions not asked of him, tasks for someone else, homework, Canvas, and due dates that already live on the education dashboard. Those stay education todos. Skip a call to @agent or @agentg, even if it only shows up in the thread. That message is already the agent's job, from Yan or from anyone else. Do not write a todo for it. Making a site or a page counts, including a get well site and a chem site. Do not invent a reply just because someone wrote. Skip college spam and the weekly EPS college-visit list unless he signed up. Skip a survey, poll, or form a student sent to his school email, including a stats project, a classmate blast, and Student News. A form a teacher or the school assigned him is not that skip. Set dueDate as YYYY-MM-DD and dueTime as HH:MM from the message. A deadline clock wins. A named part of the day wins when there is no clock: morning 08:30, after school or by Friday with no clock 15:30, tonight 20:00. ASAP or today with no clock is today at 15:30 when the message is still in the school day, otherwise tomorrow at 08:30. Before a named event means due before that start. Do not leave dueDate or dueTime blank. Do not use midnight. If the message is clearly about a project, write the todo in that project's todos folder. A debate task goes on Debate. College application tasks go in ${COLLEGE_PREP_TODOS_DIR}/<slug>/todo.json. Write a user-level todo at ${USER_TODOS_DIR}/<slug>/todo.json only when it matches no project. Do not invent a project. Fields are name, description, dueDate, dueTime, done false, createdAt now as ISO, showInDates false. Description is short markdown: who asked, what he has to do, and the link if the message has one. No school tag. No date.json. Do not also add that task to Apple Calendar. If an open todo below has a similar name, update that folder, including a new deadline. Do not mint (2). If it looks like a deleted todo row, skip it.`
    );
    const projectLines = (Array.isArray(pack.projects) ? pack.projects : [])
      .filter((row) => row && row.id && row.todosDir)
      .map(
        (row) =>
          `- ${row.name || row.id} (${row.id}): ${row.todosDir}/<slug>/todo.json`
      )
      .join("\n");
    if (projectLines) {
      parts.push(
        `Projects. Write the todo under the matching one. User-level is the fallback:\n${projectLines}`
      );
    }
  }
  parts.push(
    "Weekdays in America/Los_Angeles, today first:",
    pacificWeekdayLines(pack.now instanceof Date ? pack.now : new Date()),
    "If a similar event is already on that day and this message moves the time, place, or link, update that event. If the old one is only a tombstone and the new time, place, or link differs, create the new one. If create prints skipped deleted-identical, stop. Do not pass --force unless Yan explicitly asked for that exact event back.",
    "Put a join or register URL on --location, --url, and a one-line --notes. PathIvy and Zoom registration links come from Mail.app message source when the body dropped the href.",
    "fromName and chatName are the person on that phone or email, from their brain card. Use that name on the todo or the event. A name that only appears in the message text is not who the chat is with.",
    `Trigger (${source}):`,
    JSON.stringify(triggers, null, 2),
    "Thread around it (may be empty):",
    JSON.stringify(thread, null, 2),
    "Calendar window (yesterday through about three weeks):",
    JSON.stringify(events, null, 2),
    "Deleted calendar fingerprints. Identical means similar title and the same start, end, location, and link. A new time, place, or link is a new event:",
    JSON.stringify(tombstones, null, 2)
  );
  if (!calendarOnly) {
    parts.push(
      "Open todos you may update. Similar name means update that folder. Daily briefings are omitted:",
      JSON.stringify(todos, null, 2),
      "Deleted todos. Skip a create that looks like one of these:",
      deletedTodos || "None"
    );
  }
  parts.push("Personal calendar skill:", String(pack.skillText || "").trim());
  return parts.join("\n\n");
}

async function defaultRunJob(job, deps) {
  const { promptWithAuthRetry } = await import("./cursor-sdk-auth.js");
  const run = deps.prompt || promptWithAuthRetry;
  let skillText = deps.skillText;
  if (skillText == null) {
    try {
      skillText = await readFile(
        join(ROOT, ".cursor/skills/personal-calendar/SKILL.md"),
        "utf8"
      );
    } catch {
      skillText = "";
    }
  }
  const context = deps.prefetch
    ? await deps.prefetch(job)
    : await prefetchContext(job, deps);
  const prompt = buildOnDemandPrompt({
    source: job.source,
    messages: job.messages,
    thread: context.thread,
    events: context.events,
    tombstones: context.tombstones,
    todos: context.todos,
    deletedTodos: context.deletedTodos,
    projects: context.projects,
    handleNames: context.handleNames,
    skillText,
    calendarOnly: job.calendarOnly === true,
  });
  console.log(`[calendar-on-demand] run ${job.key} messages=${job.messages.length}`);
  return run({
    prefix: "calendar-on-demand",
    prompt,
    model: modelSelection(CALENDAR_ON_DEMAND_MODEL_SPEC),
    cwd: ROOT,
  });
}

async function prefetchContext(job, deps) {
  const messages = (job.messages || []).map((item) => item.message || item);
  const sample = messages[messages.length - 1] || {};
  /** @type {object[]} */
  let thread = [];
  if (job.source === "imessage") {
    const person = String(sample.chat || sample.handle || "").trim();
    if (person.length >= 2) {
      try {
        const recent =
          deps.recentThread ||
          (await import("./imessage-read.js")).recentThread;
        const rows = await recent(person, { limit: 55, previewStills: 0 });
        thread = Array.isArray(rows) ? rows : [];
      } catch (err) {
        console.error(
          "[calendar-on-demand] imessage thread",
          err instanceof Error ? err.message : err
        );
      }
    }
  } else if (job.source === "teams" || job.source === "teams-channel") {
    const chatId = String(sample.chatId || "").trim();
    if (chatId) {
      try {
        const fetchWindow =
          deps.fetchChatWindow ||
          (await import("./school-teams.js")).fetchChatWindow;
        const rows = await fetchWindow(chatId, { limit: 40 });
        thread = Array.isArray(rows) ? rows : [];
      } catch (err) {
        console.error(
          "[calendar-on-demand] teams thread",
          err instanceof Error ? err.message : err
        );
      }
    }
  }
  /** @type {object[]} */
  let events = [];
  try {
    const { runCalendar } = await import("./calendar-cli.js");
    const list = deps.runCalendar || runCalendar;
    const now = deps.now ? deps.now() : new Date();
    const from = new Date(now.getTime() - 2 * 24 * 3600_000).toISOString();
    const to = new Date(now.getTime() + 22 * 24 * 3600_000).toISOString();
    const result = await list(["events", "--from", from, "--to", to]);
    events = Array.isArray(result?.events) ? result.events : [];
  } catch (err) {
    console.error(
      "[calendar-on-demand] calendar",
      err instanceof Error ? err.message : err
    );
  }
  let tombstones = [];
  try {
    tombstones = await loadCalendarTombstones(deps);
  } catch (err) {
    console.error(
      "[calendar-on-demand] tombstones",
      err instanceof Error ? err.message : err
    );
  }
  let todos = [];
  let deletedTodos = "";
  let projects = [];
  if (job.calendarOnly !== true) {
    try {
      const index = deps.loadActionTodoIndex
        ? await deps.loadActionTodoIndex()
        : await loadActionTodoIndex();
      todos = Array.isArray(index?.todos) ? index.todos : [];
      deletedTodos = String(index?.deleted || "");
      projects = Array.isArray(index?.projects) ? index.projects : [];
    } catch (err) {
      console.error(
        "[calendar-on-demand] todos",
        err instanceof Error ? err.message : err
      );
    }
  }
  let handleNames = new Map();
  try {
    handleNames = deps.loadHandleNameMap
      ? await deps.loadHandleNameMap()
      : await loadHandleNameMap();
  } catch (err) {
    console.error(
      "[calendar-on-demand] handle names",
      err instanceof Error ? err.message : err
    );
  }
  return { thread, events, tombstones, todos, deletedTodos, projects, handleNames };
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      const run = job.run || defaultRunJob;
      try {
        await run(job, job.deps || {});
      } catch (err) {
        console.error(
          "[calendar-on-demand] run",
          job.key,
          err instanceof Error ? err.message : err
        );
      }
    }
  } finally {
    running = false;
    if (queue.length) void pump();
  }
}

/**
 * @param {{ source: string, message: object }} item
 * @param {{ debounceMs?: number, runJob?: Function, prefetch?: Function, now?: () => Date, skillText?: string, prompt?: Function }} [deps]
 */
export function enqueueCalendarThread(item, deps = {}) {
  const key = threadKey(item.source, item.message);
  let slot = slots.get(key);
  if (!slot) {
    slot = { key, messages: [], timer: null, run: null };
    slots.set(key, slot);
  }
  slot.messages.push(item);
  if (deps.runJob) slot.run = deps.runJob;
  if (slot.timer) clearTimeout(slot.timer);
  const wait = Number.isFinite(deps.debounceMs) ? deps.debounceMs : DEBOUNCE_MS;
  const snapshotDeps = deps;
  slot.timer = setTimeout(() => {
    slots.delete(key);
    const messages = slot.messages.slice();
    queue.push({
      key,
      source: item.source,
      messages,
      calendarOnly: messages.length > 0 && messages.every((row) => row.calendarOnly === true),
      run: slot.run,
      deps: snapshotDeps,
    });
    void pump();
  }, wait);
  slot.timer.unref?.();
}

/**
 * @param {string} source
 * @param {object} message
 * @param {object} [deps]
 */
export async function considerCalendarMessage(source, message, deps = {}) {
  if (!rowEligible(source, message)) return { ok: true, skipped: "noise" };
  const parent = source === "imessage" && (await messageIsParentText(message, deps));
  let answer = deps.calendarAnswer;
  if (answer == null) {
    if (!typesafeConfig().configured && !deps.systemOne) {
      return { ok: false, skipped: "no-key" };
    }
    const run = deps.systemOne || systemOne;
    const result = await run({
      state: buildJevState(source, message),
      questions: { calendar: parent ? PARENT_CALENDAR_QUESTION : CALENDAR_SIGNAL_QUESTION },
    });
    answer = result?.answers?.calendar;
  }
  const yes = parent ? parentCalendarYes(answer) : calendarSignalYes(answer);
  if (!yes) return { ok: true, skipped: "no-signal" };
  enqueueCalendarThread({ source, message, calendarOnly: parent }, deps);
  console.log(`[calendar-on-demand] queued ${threadKey(source, message)}`);
  return { ok: true, queued: true };
}

async function loadSeen(path) {
  if (seenLoaded && path === SEEN_PATH) return;
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [source, keys] of Object.entries(raw)) {
        if (!Array.isArray(keys)) continue;
        const set = memorySeen.get(source) || new Set();
        for (const key of keys) {
          if (key) set.add(String(key));
        }
        memorySeen.set(source, set);
      }
    }
  } catch {
    /* empty on first run */
  }
  if (path === SEEN_PATH) seenLoaded = true;
}

async function persistSeen(path) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [source, set] of memorySeen) {
    out[source] = [...set].slice(-SEEN_MAX);
  }
  await writeFile(path, `${JSON.stringify(out)}\n`, "utf8");
}

/**
 * Classify new rows. Seen keys are remembered so the overlap window does not
 * ask Jev twice.
 * @param {string} source
 * @param {object[]} rows
 * @param {object} [deps]
 */
export async function ingestCalendarRows(source, rows, deps = {}) {
  if (!typesafeConfig().configured && !deps.systemOne && !deps.calendarAnswer) {
    return { ok: false, skipped: "no-key", queued: 0 };
  }
  const path = deps.seenPath || SEEN_PATH;
  if (deps.seenPath) seenLoaded = false;
  await loadSeen(path);
  const set = memorySeen.get(source) || new Set();
  memorySeen.set(source, set);
  /** @type {object[]} */
  const fresh = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!rowEligible(source, row)) continue;
    const key = rowKey(source, row);
    if (!key || set.has(key) || inflight.has(`${source}:${key}`)) continue;
    inflight.add(`${source}:${key}`);
    fresh.push({ row, key });
  }
  let queued = 0;
  let errors = 0;
  for (const item of fresh) {
    try {
      const result = await considerCalendarMessage(source, item.row, deps);
      if (result.queued) queued += 1;
      set.add(item.key);
    } catch (err) {
      errors += 1;
      set.add(item.key);
      console.error(
        "[calendar-on-demand] jev",
        source,
        err instanceof Error ? err.message : err
      );
    } finally {
      inflight.delete(`${source}:${item.key}`);
    }
  }
  if (set.size > SEEN_MAX) {
    const kept = [...set].slice(-SEEN_MAX);
    memorySeen.set(source, new Set(kept));
  }
  try {
    await persistSeen(path);
  } catch (err) {
    console.error("[calendar-on-demand] seen", err);
  }
  return { ok: true, scanned: fresh.length, queued, errors };
}

/**
 * @param {string} source
 * @param {object[]} rows
 * @param {object} [deps]
 */
export function observeCalendarMessages(source, rows, deps) {
  return ingestCalendarRows(source, rows, deps);
}

async function loadStamp(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const lastAt = String(raw?.lastAt || "").trim();
    return { lastAt: Number.isFinite(Date.parse(lastAt)) ? new Date(lastAt).toISOString() : "" };
  } catch {
    return { lastAt: "" };
  }
}

async function saveStamp(path, lastAt) {
  await writeFile(path, `${JSON.stringify({ lastAt }, null, 2)}\n`, "utf8");
}

/**
 * @param {object} [deps]
 */
export async function pollSchoolMailCalendar(deps = {}) {
  if (!typesafeConfig().configured && !deps.systemOne) {
    return { ok: false, skipped: "no-key" };
  }
  const path = deps.statePath || SCHOOL_MAIL_STATE_PATH;
  const now = (deps.now || (() => new Date()))();
  const nowIso = now.toISOString();
  const state = await loadStamp(path);
  if (!state.lastAt) {
    await saveStamp(path, nowIso);
    return { ok: true, skipped: "watermark", queued: 0 };
  }
  const since = new Date(now.getTime() - SCHOOL_MAIL_LOOKBACK_MS).toISOString();
  const fetch =
    deps.fetchSchoolMessages ||
    (await import("./school-mail.js")).fetchSchoolMessages;
  let rows = [];
  try {
    rows = await fetch({ since, max: SCHOOL_MAIL_FETCH_MAX, includeBody: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[calendar-on-demand] school mail", msg);
    return { ok: false, error: msg };
  }
  const result = await ingestCalendarRows("school-mail", rows, deps);
  if (!result.errors) {
    await saveStamp(path, nextObservedStamp(state.lastAt, rows, "received"));
  }
  return { ok: true, ...result };
}

/**
 * @param {object} [deps]
 */
export async function pollTeamsChannelCalendar(deps = {}) {
  if (!typesafeConfig().configured && !deps.systemOne) {
    return { ok: false, skipped: "no-key" };
  }
  const path = deps.statePath || TEAMS_CHANNEL_STATE_PATH;
  const now = (deps.now || (() => new Date()))();
  const nowIso = now.toISOString();
  const state = await loadStamp(path);
  if (!state.lastAt) {
    await saveStamp(path, nowIso);
    return { ok: true, skipped: "watermark", queued: 0 };
  }
  const since = new Date(now.getTime() - TEAMS_CHANNEL_LOOKBACK_MS).toISOString();
  const fetch =
    deps.fetchRecentChannelMessages ||
    (await import("./school-teams.js")).fetchRecentChannelMessages;
  let rows = [];
  try {
    rows = await fetch({ since, max: 40 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const { isTeamsAuthError } = await import("./school-teams.js");
    if (isTeamsAuthError(err)) {
      return { ok: false, skipped: "not-signed-in", error: msg };
    }
    console.error("[calendar-on-demand] teams channels", msg);
    return { ok: false, error: msg };
  }
  const result = await ingestCalendarRows("teams-channel", rows, deps);
  if (!result.errors) {
    await saveStamp(path, nextObservedStamp(state.lastAt, rows, "at"));
  }
  return { ok: true, ...result };
}

export function startSchoolMailCalendarScheduler() {
  if (schoolTimer) return;
  if (!typesafeConfig().configured) {
    console.warn("[calendar-on-demand] TYPESAFE_API_KEY missing; school mail calendar and todo off");
    return;
  }
  const tick = () => {
    if (schoolTicking) return;
    schoolTicking = true;
    pollSchoolMailCalendar()
      .catch((err) => console.error("[calendar-on-demand] school mail poll", err))
      .finally(() => {
        schoolTicking = false;
      });
  };
  schoolTimer = setInterval(tick, SCHOOL_MAIL_POLL_MS);
  schoolTimer.unref?.();
  tick();
}

export function startTeamsChannelCalendarScheduler() {
  if (channelTimer) return;
  if (!typesafeConfig().configured) {
    console.warn("[calendar-on-demand] TYPESAFE_API_KEY missing; Teams channel calendar and todo off");
    return;
  }
  const tick = () => {
    if (channelTicking) return;
    channelTicking = true;
    pollTeamsChannelCalendar()
      .catch((err) => console.error("[calendar-on-demand] teams channel poll", err))
      .finally(() => {
        channelTicking = false;
      });
  };
  channelTimer = setInterval(tick, TEAMS_CHANNEL_POLL_MS);
  channelTimer.unref?.();
  tick();
}
