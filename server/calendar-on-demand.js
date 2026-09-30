/**
 * Jev gate on new messages. A yes starts one Composer 2.5 run for that
 * thread, after a short debounce, and only for the plan the message is about.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_SENT_FOOTER } from "./imessage-mention.js";
import { loadCalendarTombstones } from "./calendar-memory.js";
import { addLocalDays, zonedParts } from "./calendar-cli.js";
import { noul, systemOne, typesafeConfig } from "./typesafe.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const CALENDAR_SIGNAL_THRESHOLD = 0.35;
export const DEBOUNCE_MS = 45_000;
export const SCHOOL_MAIL_POLL_MS = 30_000;
export const TEAMS_CHANNEL_POLL_MS = 60_000;
export const SEEN_PATH = "/tmp/yanylevin-calendar-on-demand-seen.json";
export const SCHOOL_MAIL_STATE_PATH = "/tmp/yanylevin-school-mail-calendar.json";
export const TEAMS_CHANNEL_STATE_PATH = "/tmp/yanylevin-teams-channel-calendar.json";
const SEEN_MAX = 800;
const OVERLAP_MS = 20_000;

export const CALENDAR_ON_DEMAND_MODEL_SPEC = {
  id: process.env.CURSOR_CALENDAR_ON_DEMAND_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

export const CALENDAR_SIGNAL_QUESTION = noul(
  "Could this message be a plan, event, meeting, invite, appointment, or a change to when or where something happens? Count maybes, a TBD venue, and a named day with no clock. Ignore a pure reaction, homework with no meeting, and a one-time passcode."
);

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
    return true;
  }
  if (source === "teams" || source === "teams-channel") {
    const type = String(message.messageType || "message").trim().toLowerCase();
    if (type && type !== "message") return false;
    const text = String(message.text || "").trim();
    if (!text) return false;
    if (text.toLowerCase().includes(AGENT_SENT_FOOTER.toLowerCase())) return false;
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

function clipPackMessage(source, message) {
  return {
    source,
    at: String(message?.at || message?.received || "").slice(0, 40),
    from: message?.fromMe
      ? "Yan"
      : String(message?.from || message?.handle || message?.fromEmail || "").slice(0, 160),
    chat: String(message?.chat || message?.channel || message?.subject || "").slice(0, 180),
    text: String(message?.text || message?.body || message?.preview || "").slice(0, 2500),
  };
}

/**
 * @param {{
 *   source: string,
 *   messages: object[],
 *   thread?: object[],
 *   events?: object[],
 *   tombstones?: object[],
 *   skillText?: string,
 * }} pack
 */
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

export function buildOnDemandPrompt(pack) {
  const source = pack.source;
  const triggers = (pack.messages || []).map((item) =>
    clipPackMessage(source, item.message || item)
  );
  const thread = (pack.thread || [])
    .slice(-55)
    .map((row) => clipPackMessage(source, row));
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
  return [
    "Follow .cursor/skills/calendar-on-demand/SKILL.md and .cursor/skills/personal-calendar/SKILL.md.",
    "You are the realtime calendar agent for Yan (you@example.com). Local only. Never spawn a Cursor cloud agent. ",
    "One plan only: the event this message is about. Do not sweep the inbox, other chats, or the rest of the day for unrelated events.",
    "Jev only asked whether this message might be a plan. Jev is that classifier, not a person in the chat and not a guest. Never put Jev in the title, notes, or guest list. Name the event after the people in the thread. You still decide if it is calendar-worthy. Create nothing when it is not. Add an event he is actually showing up for. A named day helps. Look up the weekday on the list below. This Saturday is the first Saturday. Next Saturday is the second. Do not count days yourself. TBD venue is fine when the plan is real. Do not invent a clock. Skip college spam, including recruitment mail, Scoir, apply-now, and info sessions he did not register for. Skip the weekly EPS college-visit list unless Yan said he signed up for that visit. Skip education todos, homework, Canvas, due dates, and other dashboard items. Those stay on the education dashboard. The calendar is events. Also skip the EPS bell schedule, and EPS Ventures unless there is a signup confirmation.",
    "Weekdays in America/Los_Angeles, today first:",
    pacificWeekdayLines(pack.now instanceof Date ? pack.now : new Date()),
    "If a similar event is already on that day and this message moves the time, place, or link, update that event. If the old one is only a tombstone and the new time, place, or link differs, create the new one. If create prints skipped deleted-identical, stop. Do not pass --force unless Yan explicitly asked for that exact event back.",
    "Put a join or register URL on --location, --url, and a one-line --notes. PathIvy and Zoom registration links come from Mail.app message source when the body dropped the href.",
    `Trigger (${source}):`,
    JSON.stringify(triggers, null, 2),
    "Thread around it (may be empty):",
    JSON.stringify(thread, null, 2),
    "Calendar window (yesterday through about three weeks):",
    JSON.stringify(events, null, 2),
    "Deleted calendar fingerprints. Identical means similar title and the same start, end, location, and link. A new time, place, or link is a new event:",
    JSON.stringify(tombstones, null, 2),
    "Personal calendar skill:",
    String(pack.skillText || "").trim(),
  ].join("\n\n");
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
    skillText,
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
  return { thread, events, tombstones };
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
    queue.push({
      key,
      source: item.source,
      messages: slot.messages.slice(),
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
  let answer = deps.calendarAnswer;
  if (answer == null) {
    if (!typesafeConfig().configured && !deps.systemOne) {
      return { ok: false, skipped: "no-key" };
    }
    const run = deps.systemOne || systemOne;
    const result = await run({
      state: buildJevState(source, message),
      questions: { calendar: CALENDAR_SIGNAL_QUESTION },
    });
    answer = result?.answers?.calendar;
  }
  if (!calendarSignalYes(answer)) return { ok: true, skipped: "no-signal" };
  enqueueCalendarThread({ source, message }, deps);
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
  const sinceMs = Date.parse(state.lastAt) - OVERLAP_MS;
  const since = new Date(Math.max(0, sinceMs)).toISOString();
  const fetch =
    deps.fetchSchoolMessages ||
    (await import("./school-mail.js")).fetchSchoolMessages;
  let rows = [];
  try {
    rows = await fetch({ since, max: 25, includeBody: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[calendar-on-demand] school mail", msg);
    return { ok: false, error: msg };
  }
  const result = await ingestCalendarRows("school-mail", rows, deps);
  if (!result.errors) await saveStamp(path, nowIso);
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
  const sinceMs = Date.parse(state.lastAt) - OVERLAP_MS;
  const since = new Date(Math.max(0, sinceMs)).toISOString();
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
  if (!result.errors) await saveStamp(path, nowIso);
  return { ok: true, ...result };
}

export function startSchoolMailCalendarScheduler() {
  if (schoolTimer) return;
  if (!typesafeConfig().configured) {
    console.warn("[calendar-on-demand] TYPESAFE_API_KEY missing; school mail calendar off");
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
    console.warn("[calendar-on-demand] TYPESAFE_API_KEY missing; Teams channel calendar off");
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
