/**
 * Nightly calendar sort. 01:15 local. Moves events between Personal,
 * School/Work, and Family on the same account. Never changes account.
 */

import { open, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
  calendarSortHm,
  hmToMinutes,
} from "./daily-briefing-agent.js";
import { nextLocalHmAt } from "./location-history-agent.js";
import { YAN_EMAIL } from "./phone-location.js";
import { runCalendarSort } from "./calendar-sort.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-calendar-sort.lock";
const LOCK_STALE_MS = 30 * 60 * 1000;
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const STATE_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "calendar",
  "sort-state.json"
);

/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

async function readMeta() {
  try {
    return JSON.parse(await readFile(META_PATH, "utf8"));
  } catch {
    return { timezone: "America/Los_Angeles" };
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

export async function sortRanOn(dateKey) {
  const state = await readState();
  return state.lastDateKey === dateKey;
}

async function acquireLock() {
  try {
    const info = await stat(LOCK_PATH);
    if (Date.now() - info.mtimeMs < LOCK_STALE_MS) return null;
    await rm(LOCK_PATH, { force: true });
  } catch {
    /* no lock */
  }
  const handle = await open(LOCK_PATH, "wx");
  await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  return handle;
}

async function releaseLock(handle) {
  if (handle) await handle.close().catch(() => {});
  await rm(LOCK_PATH, { force: true }).catch(() => {});
}

export async function runCalendarSortJob(opts = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  if (!opts.force && (await sortRanOn(now.dateKey))) {
    return { ok: true, skipped: "already-ran", dateKey: now.dateKey };
  }
  const handle = await acquireLock();
  if (!handle) return { ok: true, skipped: "locked" };
  try {
    const result = await runCalendarSort({ mode: "nightly" });
    await mkdir(dirname(STATE_PATH), { recursive: true });
    await writeFile(
      STATE_PATH,
      `${JSON.stringify({ lastDateKey: now.dateKey, at: new Date().toISOString(), applied: result.applied }, null, 2)}\n`
    );
    return { ok: result.ok, dateKey: now.dateKey, ...result };
  } finally {
    await releaseLock(handle);
  }
}

async function maybeRunMissed() {
  try {
    const meta = await readMeta();
    const now = briefingNow(meta);
    if (now.minutes < hmToMinutes(calendarSortHm(meta))) return;
    if (await sortRanOn(now.dateKey)) return;
    console.log(`[calendar-sort] missed-job recovery for ${now.dateKey}`);
    await runCalendarSortJob();
  } catch (err) {
    console.error("[calendar-sort] missed-job recovery failed", err);
  }
}

function armTimer(meta) {
  if (timer) clearTimeout(timer);
  const when = nextLocalHmAt(meta, calendarSortHm(meta));
  const delay = Math.max(1000, when.getTime() - Date.now());
  const capped = Math.min(delay, 24 * 60 * 60 * 1000);
  console.log(
    `[calendar-sort] next run ${when.toISOString()} (in ${Math.round(capped / 60000)} min)`
  );
  timer = setTimeout(() => {
    runCalendarSortJob()
      .catch((err) => console.error("[calendar-sort] scheduled run failed", err))
      .finally(() => {
        readMeta()
          .then((m) => armTimer(m))
          .catch((err) => {
            console.error("[calendar-sort] reschedule failed", err);
            timer = setTimeout(() => startCalendarSortScheduler(), 60 * 60 * 1000);
          });
      });
  }, capped);
}

export function startCalendarSortScheduler() {
  readMeta()
    .then((meta) => {
      armTimer(meta);
      setTimeout(() => {
        maybeRunMissed().catch((err) =>
          console.error("[calendar-sort] missed recovery", err)
        );
      }, 20000);
    })
    .catch((err) => {
      console.error("[calendar-sort] scheduler start failed", err);
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
  const force = process.argv.includes("--force");
  runCalendarSortJob({ force })
    .then((result) => {
      console.log(
        JSON.stringify({
          ok: result.ok,
          skipped: result.skipped || "",
          dateKey: result.dateKey || "",
          applied: result.applied,
          failed: result.failed,
        })
      );
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[calendar-sort] failed", err);
      process.exitCode = 1;
    });
}
