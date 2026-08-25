/**
 * EventKit CLI wrapper for Yan's Personal Agent + live context.
 * Compiles macos/YLCalendar/main.swift on first use.
 */

import { execFile } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

export async function ensureCalendarBin() {
  if (await binExists()) return BIN;
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
    maxBuffer: 2 * 1024 * 1024,
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

const isCli =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  runCalendar(process.argv.slice(2))
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
