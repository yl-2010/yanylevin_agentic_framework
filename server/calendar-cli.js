/**
 * EventKit CLI wrapper for Yan's Personal Agent + live context.
 * Compiles macos/YLCalendar/main.swift on first use.
 */

import { execFile } from "node:child_process";
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  findCreateBlock,
  loadCalendarTombstones,
  recordAgentEvent,
  tombstoneAgentEvent,
} from "./calendar-memory.js";
import { logCalendarCommand, splitVia } from "./agent-actions.js";

export { splitVia };

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "macos/YLCalendar/main.swift");
const BIN_DIR = join(ROOT, "macos/YLCalendar");
const APP = join(BIN_DIR, "yl-calendar.app");
const BIN = join(APP, "Contents/MacOS/yl-calendar");
const PLIST_SRC = join(BIN_DIR, "Info.plist");
const ENTITLEMENTS = join(BIN_DIR, "entitlements.plist");

const CACHE_MS = 60_000;
/** @type {{ at: number, lines: string[] }|null} */
let cache = null;
/** @type {Promise<string>|null} */
let compiling = null;

async function binExists() {
  try {
    await access(BIN);
    return true;
  } catch {
    return false;
  }
}

async function binNeedsCompile() {
  if (!(await binExists())) return true;
  try {
    const [binStat, srcStat, plistStat, entStat] = await Promise.all([
      stat(BIN),
      stat(SRC),
      stat(PLIST_SRC),
      stat(ENTITLEMENTS),
    ]);
    const newestSrc = Math.max(srcStat.mtimeMs, plistStat.mtimeMs, entStat.mtimeMs);
    return newestSrc > binStat.mtimeMs;
  } catch {
    return true;
  }
}

export async function ensureCalendarBin() {
  if (!(await binNeedsCompile())) return BIN;
  if (compiling) return compiling;
  compiling = (async () => {
    const macosDir = join(APP, "Contents/MacOS");
    await mkdir(macosDir, { recursive: true });
    await copyFile(PLIST_SRC, join(APP, "Contents/Info.plist"));
    await execFileAsync(
      "swiftc",
      [
        "-O",
        "-o",
        BIN,
        SRC,
        "-framework",
        "EventKit",
        "-framework",
        "Foundation",
      ],
      { cwd: BIN_DIR, timeout: 120_000 }
    );
    await execFileAsync(
      "codesign",
      [
        "--force",
        "--sign",
        "-",
        "--entitlements",
        ENTITLEMENTS,
        "--identifier",
        "com.yanylevin.yl-calendar",
        APP,
      ],
      { timeout: 15_000 }
    );
    return BIN;
  })().finally(() => {
    compiling = null;
  });
  return compiling;
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function runCalendar(args, opts = {}) {
  const bin = await ensureCalendarBin();
  const { stdout, stderr } = await execFileAsync(bin, args, {
    timeout: opts.timeoutMs || 45_000,
    maxBuffer: opts.maxBuffer || 8 * 1024 * 1024,
  });
  const text = String(stdout || "").trim();
  if (!text) {
    const err = String(stderr || "").trim();
    throw new Error(err || "yl-calendar produced no output");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`yl-calendar invalid JSON: ${text.slice(0, 200)}`);
  }
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/**
 * Local YYYY-MM-DD / HH:MM in `timeZone`.
 * @param {Date} date
 * @param {string} timeZone
 */
export function zonedParts(date, timeZone) {
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

function startOfLocalDay(dateKey, timeZone) {
  const guess = new Date(`${dateKey}T12:00:00Z`);
  for (let delta = -36; delta <= 36; delta += 1) {
    const candidate = new Date(guess.getTime() + delta * 3600_000);
    const parts = zonedParts(candidate, timeZone);
    if (parts.dateKey === dateKey && parts.hm === "00:00") return candidate;
  }
  return new Date(`${dateKey}T00:00:00`);
}

export function addLocalDays(dateKey, days) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Calendar-on-demand must not write the classifier's name onto an event.
 * @param {string} via
 * @param {string} cmd
 * @param {string} title
 * @param {string} [notes]
 * @returns {{ ok: false, skipped: string, error: string }|null}
 */
const FULL_DAY_MS = 20 * 60 * 60 * 1000;

/**
 * A timed event that lasts most of a day is not an all-day event.
 * Real all-day events pass --all-day. Everything else needs a real window.
 * @param {{ allDay?: boolean, start?: string, end?: string }|null|undefined} candidate
 * @returns {{ ok: false, skipped: string, error: string }|null}
 */
export function fullDayTimedRefusal(candidate) {
  if (!candidate || candidate.allDay) return null;
  const start = new Date(candidate.start || "");
  const end = new Date(candidate.end || "");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (end.getTime() - start.getTime() < FULL_DAY_MS) return null;
  return {
    ok: false,
    skipped: "full-day-timed",
    error:
      "This timed event lasts most of a day. Pass --all-day only if it really has no clock. Otherwise pass the real start and end.",
  };
}

export function jevTitleRefusal(via, cmd, title, notes) {
  if (String(via || "") !== "calendar-on-demand") return null;
  if (cmd !== "create" && cmd !== "update") return null;
  const blob = `${title || ""}\n${notes || ""}`;
  if (!/\bjev\b/i.test(blob)) return null;
  return {
    ok: false,
    skipped: "jev-title",
    error:
      "Jev is the classifier, not a person in the chat. Name the event after the people in the thread.",
  };
}

function formatEventLine(ev, timeZone) {
  const title = String(ev.title || "(no title)").trim() || "(no title)";
  const cal = String(ev.calendar || "").trim();
  const calBit = cal ? ` (${cal})` : "";
  if (ev.allDay) return `- all-day ${title}${calBit}`;
  const start = ev.start ? new Date(ev.start) : null;
  const hm = start && !Number.isNaN(start.getTime()) ? zonedParts(start, timeZone).hm : "??:??";
  return `- ${hm} ${title}${calBit}`;
}

/**
 * Today + tomorrow events for live context. Empty string if Calendar is unavailable.
 * @param {{ timeZone?: string, now?: Date }} [opts]
 */
export async function formatCalendarLiveLines(opts = {}) {
  const now = opts.now || new Date();
  const timeZone = opts.timeZone || "America/Los_Angeles";
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.lines;
  try {
    const today = zonedParts(now, timeZone).dateKey;
    const tomorrow = addLocalDays(today, 1);
    const from = startOfLocalDay(today, timeZone);
    const to = new Date(startOfLocalDay(addLocalDays(today, 2), timeZone).getTime() - 1);
    const result = await runCalendar([
      "events",
      "--from",
      from.toISOString(),
      "--to",
      to.toISOString(),
    ]);
    if (!result?.ok) {
      cache = { at: Date.now(), lines: [] };
      return [];
    }
    const events = Array.isArray(result.events) ? result.events : [];
    /** @type {string[]} */
    const lines = ["Apple Calendar (today + tomorrow):"];
    if (!events.length) {
      lines.push("- (no events)");
    } else {
      const todayEvents = [];
      const tomorrowEvents = [];
      for (const ev of events.slice(0, 24)) {
        const start = ev.start ? new Date(ev.start) : now;
        const key = ev.allDay
          ? String(ev.start || "").slice(0, 10)
          : zonedParts(start, timeZone).dateKey;
        const line = formatEventLine(ev, timeZone);
        if (key === tomorrow) tomorrowEvents.push(line);
        else todayEvents.push(line);
      }
      if (todayEvents.length) {
        lines.push(`Today (${today}):`);
        lines.push(...todayEvents.slice(0, 8));
      }
      if (tomorrowEvents.length) {
        lines.push(`Tomorrow (${tomorrow}):`);
        lines.push(...tomorrowEvents.slice(0, 6));
      }
      if (todayEvents.length + tomorrowEvents.length === 0) {
        lines.push("- (no events)");
      }
    }
    cache = { at: Date.now(), lines };
    return lines;
  } catch (err) {
    console.error("[calendar-cli]", err instanceof Error ? err.message : err);
    cache = { at: Date.now(), lines: [] };
    return [];
  }
}

function pullFlag(args, name) {
  const kept = [];
  let value = "";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === name) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
      continue;
    }
    kept.push(args[i]);
  }
  return { args: kept, value };
}

/**
 * EventKit cannot add guests. Calendar.app can, on the calendar id yl-calendar returns.
 * @param {{ calendarId: string, title: string, startIso: string, emails: string[] }} opts
 */
export async function addEventAttendees(opts) {
  const emails = (opts.emails || []).map((e) => String(e || "").trim()).filter(Boolean);
  if (!emails.length) return { ok: true, added: 0 };
  const start = new Date(opts.startIso);
  if (Number.isNaN(start.getTime())) {
    return { ok: false, error: "attendees need a start time" };
  }
  const title = String(opts.title || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const calendarId = String(opts.calendarId || "").replace(/"/g, "");
  if (!calendarId) return { ok: false, error: "attendees need a calendar id" };
  const lines = emails
    .map((email) => {
      const safe = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `make new attendee at end of attendees of theEvent with properties {email:"${safe}"}`;
    })
    .join("\n");
  const script = `
set targetDate to current date
set year of targetDate to ${start.getFullYear()}
set month of targetDate to ${start.getMonth() + 1}
set day of targetDate to ${start.getDate()}
set hours of targetDate to ${start.getHours()}
set minutes of targetDate to ${start.getMinutes()}
set seconds of targetDate to 0
set windowStart to targetDate - 2 * minutes
set windowEnd to targetDate + 2 * minutes
tell application "Calendar"
  tell (calendar id "${calendarId}")
    set matches to every event whose summary is "${title}" and start date ≥ windowStart and start date ≤ windowEnd
    if (count of matches) is 0 then error "event not found for attendees"
    set theEvent to item 1 of matches
    ${lines}
  end tell
end tell
`;
  try {
    await execFileAsync("osascript", ["-e", script], { timeout: 30_000 });
    return { ok: true, added: emails.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.slice(0, 400) };
  }
}

function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0 || i + 1 >= args.length) return "";
  const value = args[i + 1];
  if (value.startsWith("--")) return "";
  return value;
}

function allDayFromArgs(args) {
  if (!args.includes("--all-day")) return false;
  return flagValue(args, "--all-day") !== "0";
}

function candidateFromArgs(args) {
  const start = flagValue(args, "--start");
  let end = flagValue(args, "--end");
  const allDay = allDayFromArgs(args);
  if (!end && start && !allDay) {
    const parsed = new Date(start);
    if (!Number.isNaN(parsed.getTime())) {
      end = new Date(parsed.getTime() + 3600_000).toISOString();
    }
  }
  return {
    title: flagValue(args, "--title"),
    start,
    end,
    allDay,
    location: flagValue(args, "--location"),
    url: flagValue(args, "--url"),
    calendar: flagValue(args, "--calendar"),
  };
}

async function listNearbyEvents(candidate) {
  const start = new Date(candidate.start);
  if (Number.isNaN(start.getTime())) return [];
  const from = new Date(start.getTime() - 36 * 3600_000).toISOString();
  const to = new Date(start.getTime() + 36 * 3600_000).toISOString();
  const result = await runCalendar(["events", "--from", from, "--to", to]);
  return Array.isArray(result?.events) ? result.events : [];
}

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const split = splitVia(process.argv.slice(2));
  const via = split.via;
  const args = split.args;
  const cmd = args[0] || "";
  const force = args.includes("--force");
  const pulled = pullFlag(
    args.filter((arg) => arg !== "--force"),
    "--attendees"
  );
  const attendeeEmails = pulled.value
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  const swiftArgs = pulled.args;
  const finish = async () => {
    const jevBlock = jevTitleRefusal(
      via,
      cmd,
      flagValue(args, "--title"),
      flagValue(args, "--notes")
    );
    if (jevBlock) {
      console.log(JSON.stringify(jevBlock, null, 2));
      return;
    }
    if (cmd === "create" || cmd === "update") {
      const spanBlock = fullDayTimedRefusal(candidateFromArgs(args));
      if (spanBlock) {
        console.log(JSON.stringify(spanBlock, null, 2));
        return;
      }
    }
    if (cmd === "create" && !force) {
      const candidate = candidateFromArgs(args);
      const tombstones = await loadCalendarTombstones();
      const liveEvents = await listNearbyEvents(candidate);
      const block = findCreateBlock({ candidate, tombstones, liveEvents, force: false });
      if (block) {
        console.log(JSON.stringify({ ok: false, ...block }, null, 2));
        return;
      }
    }
    let prior = null;
    if (cmd === "delete") {
      const id = flagValue(swiftArgs, "--id");
      if (id) {
        try {
          const got = await runCalendar(["get", "--id", id]);
          if (got?.found && got.event) prior = got.event;
        } catch (err) {
          console.error("[calendar-cli] get before delete", err);
        }
      }
    }
    const result = await runCalendar(swiftArgs);
    if (cmd === "create" && result?.ok && result.event && attendeeEmails.length) {
      const added = await addEventAttendees({
        calendarId: result.event.calendarId,
        title: result.event.title,
        startIso: result.event.start,
        emails: attendeeEmails,
      });
      result.attendees = added;
    }
    console.log(JSON.stringify(result, null, 2));
    if ((cmd === "create" || cmd === "update") && result?.ok && result.event) {
      await recordAgentEvent(result.event);
    }
    if (cmd === "delete" && result?.ok && prior) {
      await tombstoneAgentEvent(prior, "cli-delete");
    }
    if (via && result?.ok && (cmd === "create" || cmd === "update" || cmd === "delete")) {
      try {
        await logCalendarCommand({
          via,
          cmd,
          event: result.event || prior || {},
        });
      } catch (err) {
        console.error("[agent-actions]", err instanceof Error ? err.message : err);
      }
    }
  };
  finish().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
