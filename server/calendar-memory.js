/**
 * Remember calendar events this CLI created. A manual delete becomes a
 * tombstone. An identical recreate is refused. A new time, place, or link
 * is not the same event.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { namesAreSimilar } from "./education-match.js";

import { YAN_EDUCATION_DIR } from "./onedrive-projects.js";

const USER_ROOT = YAN_EDUCATION_DIR;

export const AGENT_CREATED_PATH = join(USER_ROOT, "calendar/agent-created.jsonl");
export const DELETED_EVENTS_PATH = join(USER_ROOT, "calendar/deleted-events.jsonl");
export const DELETED_MD_PATH = join(USER_ROOT, "deleted.md");
export const RECONCILE_STATE_PATH = "/tmp/yanylevin-calendar-reconcile.json";
export const RECONCILE_MS = 120_000;
export const MISS_BEFORE_TOMBSTONE = 2;
export const CALENDAR_TZ = "America/Los_Angeles";

/** @type {ReturnType<typeof setInterval>|null} */
let reconcileTimer = null;
let reconciling = false;

function pacificParts(date, timeZone = CALENDAR_TZ) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const map = {};
  for (const p of fmt.formatToParts(date)) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    dateKey: `${map.year}-${map.month}-${map.day}`,
    hm: `${map.hour}:${map.minute}`,
  };
}

/**
 * @param {string} path
 */
async function readJsonl(path) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  /** @type {object[]} */
  const rows = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* skip a torn line */
    }
  }
  return rows;
}

/**
 * @param {string} path
 * @param {object} row
 */
async function appendJsonl(path, row) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, "utf8");
}

/**
 * Last line for each event id wins.
 * @param {object[]} rows
 */
export function latestById(rows) {
  /** @type {Map<string, object>} */
  const map = new Map();
  for (const row of rows || []) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

export function normalizeDetail(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\/+$/, "")
    .replace(/\s+/g, " ");
}

/**
 * @param {object|null|undefined} event
 */
export function eventStamp(event, which) {
  if (!event) return "";
  const preset = which === "end" ? event.endStamp : event.startStamp;
  if (preset) return String(preset);
  const raw = which === "end" ? event.end : event.start;
  if (!raw) return "";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return "";
  const parts = pacificParts(date);
  return event.allDay ? parts.dateKey : `${parts.dateKey} ${parts.hm}`;
}

function stampsCompatible(a, b) {
  if (!a || !b) return true;
  return a === b;
}

/**
 * Similar title, same Pacific start, same end, same location, same URL.
 * A missing end on either side does not by itself make them different.
 * All-day and timed are different. A new time, place, or link is not identical.
 * @param {object} a
 * @param {object} b
 */
export function eventsAreIdentical(a, b) {
  if (!a || !b) return false;
  if (!namesAreSimilar(a.title, b.title)) return false;
  if (Boolean(a.allDay) !== Boolean(b.allDay)) return false;
  const startA = eventStamp(a, "start");
  const startB = eventStamp(b, "start");
  if (!startA || startA !== startB) return false;
  if (!stampsCompatible(eventStamp(a, "end"), eventStamp(b, "end"))) return false;
  if (normalizeDetail(a.location) !== normalizeDetail(b.location)) return false;
  if (normalizeDetail(a.url) !== normalizeDetail(b.url)) return false;
  return true;
}

/**
 * Same Pacific start and a similar title. Used to refuse a second event
 * in a slot that is already on the calendar.
 * @param {object} a
 * @param {object} b
 */
export function sameStartSlot(a, b) {
  if (!a || !b) return false;
  if (!namesAreSimilar(a.title, b.title)) return false;
  if (Boolean(a.allDay) !== Boolean(b.allDay)) return false;
  const startA = eventStamp(a, "start");
  const startB = eventStamp(b, "start");
  return Boolean(startA) && startA === startB;
}

/**
 * @param {{
 *   candidate: object,
 *   tombstones?: object[],
 *   liveEvents?: object[],
 *   force?: boolean,
 * }} opts
 */
export function findCreateBlock(opts) {
  if (opts?.force) return null;
  const candidate = opts?.candidate;
  if (!candidate) return null;
  const tomb = (opts.tombstones || []).find((row) => eventsAreIdentical(candidate, row));
  if (tomb) {
    return {
      skipped: "deleted-identical",
      reason:
        "This matches a calendar event Yan deleted. A different time, place, or link is still allowed.",
      tombstone: { id: tomb.id || "", title: tomb.title || "", start: tomb.start || tomb.startStamp || "" },
    };
  }
  const live = (opts.liveEvents || []).find((row) => sameStartSlot(candidate, row));
  if (live) {
    return {
      skipped: "already-on-calendar",
      reason:
        "A similar title is already on the calendar at this start. Update that event if the details moved.",
      event: { id: live.id || "", title: live.title || "", start: live.start || "" },
    };
  }
  return null;
}

/**
 * Calendar rows in deleted.md, for deletes that happened before the jsonl log.
 * Location and URL are unknown, so only an empty location and URL can match.
 * @param {string} text
 */
export function tombstonesFromDeletedMarkdown(text) {
  /** @type {object[]} */
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const match = line.match(
      /^\s*-\s+deleted\s+.+?\|\s*calendar\s*\|\s*(.+?)\s*\|\s*on\s+([^|]+?)\s*\|[^|]*\|\s*was\s+(\S+)/i
    );
    if (!match) continue;
    const on = match[2].trim();
    const timed = on.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    const day = on.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!day) continue;
    out.push({
      id: match[3].trim(),
      title: match[1].trim(),
      allDay: !timed,
      startStamp: timed ? `${timed[1]} ${timed[2]}` : day[1],
      endStamp: "",
      location: "",
      url: "",
      calendar: "",
    });
  }
  return out;
}

/**
 * @param {object} event
 */
export function normalizeLoggedEvent(event) {
  return {
    id: String(event?.id || "").trim(),
    title: String(event?.title || "").trim(),
    start: String(event?.start || "").trim(),
    end: String(event?.end || "").trim(),
    allDay: Boolean(event?.allDay),
    location: String(event?.location || "").trim(),
    url: String(event?.url || "").trim(),
    calendar: String(event?.calendar || "").trim(),
    at: new Date().toISOString(),
  };
}

/**
 * @param {object} event
 * @param {{ createdPath?: string }} [opts]
 */
export async function recordAgentEvent(event, opts = {}) {
  const row = normalizeLoggedEvent(event);
  if (!row.id) return null;
  await appendJsonl(opts.createdPath || AGENT_CREATED_PATH, row);
  return row;
}

function deletedRow(event, now = new Date()) {
  const when = pacificParts(now);
  const start = event.start ? new Date(event.start) : null;
  let on = event.startStamp || "";
  if (!on && start && !Number.isNaN(start.getTime())) {
    const parts = pacificParts(start);
    on = event.allDay ? parts.dateKey : `${parts.dateKey} ${parts.hm}`;
  }
  const title = String(event.title || "Untitled").replace(/\|/g, "/");
  const calendar = String(event.calendar || "Home").replace(/\|/g, "/");
  return `- deleted ${when.dateKey} ${when.hm} | calendar | ${title} | on ${on} | ${calendar} | was ${event.id}`;
}

/**
 * @param {object} event
 * @param {string} [reason]
 * @param {{ tombstonePath?: string, deletedMdPath?: string, now?: Date }} [opts]
 */
export async function tombstoneAgentEvent(event, reason = "missing", opts = {}) {
  const row = {
    ...normalizeLoggedEvent(event),
    reason,
    deletedAt: (opts.now || new Date()).toISOString(),
  };
  if (event?.startStamp) row.startStamp = event.startStamp;
  if (event?.endStamp) row.endStamp = event.endStamp;
  if (!row.id && !row.title) return null;
  const tombstonePath = opts.tombstonePath || DELETED_EVENTS_PATH;
  const existing = await readJsonl(tombstonePath);
  if (row.id && existing.some((item) => item.id === row.id)) return row;
  await appendJsonl(tombstonePath, row);
  const deletedMdPath = opts.deletedMdPath || DELETED_MD_PATH;
  let prior = "";
  try {
    prior = await readFile(deletedMdPath, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  if (row.id && prior.includes(`was ${row.id}`)) return row;
  const line = deletedRow(row, opts.now);
  const next = prior.trim()
    ? `${prior.replace(/\s*$/, "")}\n${line}\n`
    : `# Manually deleted\n\n## Items\n\n${line}\n`;
  await mkdir(dirname(deletedMdPath), { recursive: true });
  await writeFile(deletedMdPath, next, "utf8");
  return row;
}

/**
 * @param {{ tombstonePath?: string, deletedMdPath?: string }} [opts]
 */
export async function loadCalendarTombstones(opts = {}) {
  const fromLog = await readJsonl(opts.tombstonePath || DELETED_EVENTS_PATH);
  let markdown = "";
  try {
    markdown = await readFile(opts.deletedMdPath || DELETED_MD_PATH, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  return [...fromLog, ...tombstonesFromDeletedMarkdown(markdown)];
}

/**
 * @param {{ createdPath?: string }} [opts]
 */
export async function loadAgentCreated(opts = {}) {
  const rows = await readJsonl(opts.createdPath || AGENT_CREATED_PATH);
  return [...latestById(rows).values()];
}

async function loadReconcileState(path) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    const misses =
      raw && typeof raw.misses === "object" && raw.misses ? raw.misses : {};
    return { misses };
  } catch {
    return { misses: {} };
  }
}

/**
 * @param {{
 *   createdPath?: string,
 *   tombstonePath?: string,
 *   deletedMdPath?: string,
 *   statePath?: string,
 *   getEvent?: (id: string) => Promise<{ ok?: boolean, found?: boolean, event?: object|null, error?: string }>,
 *   now?: Date,
 * }} [opts]
 */
export async function reconcileAgentCalendar(opts = {}) {
  const statePath = opts.statePath || RECONCILE_STATE_PATH;
  const created = await loadAgentCreated({ createdPath: opts.createdPath });
  const tombstones = await readJsonl(opts.tombstonePath || DELETED_EVENTS_PATH);
  const gone = new Set(tombstones.map((row) => String(row.id || "")).filter(Boolean));
  const state = await loadReconcileState(statePath);
  /** @type {Record<string, number>} */
  const misses = { ...state.misses };
  const getEvent = opts.getEvent;
  if (!getEvent) return { ok: false, skipped: "no-get" };
  let tombstoned = 0;
  const now = opts.now || new Date();
  const cutoff = now.getTime() - 2 * 24 * 3600_000;
  for (const row of created) {
    if (!row.id || gone.has(row.id)) continue;
    const endMs = Date.parse(row.end || row.start || "");
    if (Number.isFinite(endMs) && endMs < cutoff) continue;
    let got;
    try {
      got = await getEvent(row.id);
    } catch (err) {
      console.error(
        "[calendar-memory] get",
        row.id,
        err instanceof Error ? err.message : err
      );
      continue;
    }
    if (!got || got.ok === false) continue;
    if (got.found && got.event) {
      delete misses[row.id];
      const fresh = normalizeLoggedEvent(got.event);
      const changed =
        fresh.title !== row.title ||
        fresh.start !== row.start ||
        fresh.end !== row.end ||
        fresh.location !== row.location ||
        fresh.url !== row.url ||
        Boolean(fresh.allDay) !== Boolean(row.allDay);
      if (changed) {
        await recordAgentEvent(got.event, { createdPath: opts.createdPath });
      }
      continue;
    }
    if (got.found === false) {
      const next = (Number(misses[row.id]) || 0) + 1;
      misses[row.id] = next;
      if (next >= MISS_BEFORE_TOMBSTONE) {
        await tombstoneAgentEvent(row, "missing", {
          tombstonePath: opts.tombstonePath,
          deletedMdPath: opts.deletedMdPath,
          now,
        });
        delete misses[row.id];
        gone.add(row.id);
        tombstoned += 1;
        console.log(`[calendar-memory] tombstone ${row.title || row.id}`);
      }
    }
  }
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, `${JSON.stringify({ misses }, null, 2)}\n`, "utf8");
  return { ok: true, tombstoned, watching: created.length };
}

async function defaultGetEvent(id) {
  const { runCalendar } = await import("./calendar-cli.js");
  return runCalendar(["get", "--id", String(id)]);
}

export function startCalendarReconcileScheduler(opts = {}) {
  if (reconcileTimer) return;
  const run = () => {
    if (reconciling) return;
    reconciling = true;
    reconcileAgentCalendar({ getEvent: opts.getEvent || defaultGetEvent })
      .catch((err) => console.error("[calendar-memory] reconcile", err))
      .finally(() => {
        reconciling = false;
      });
  };
  reconcileTimer = setInterval(run, RECONCILE_MS);
  reconcileTimer.unref?.();
  run();
}
