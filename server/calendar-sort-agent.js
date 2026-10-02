/**
 * Nightly calendar sort is off.
 * Moving an existing event between calendars resends invites, including
 * on the same account. New events pick a calendar when they are created.
 */

import { pathToFileURL } from "node:url";

export async function sortRanOn() {
  return true;
}

export async function runCalendarSortJob() {
  return { ok: true, skipped: "disabled" };
}

export function startCalendarSortScheduler() {
  console.log("[calendar-sort] off. It does not move events.");
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
  console.log(JSON.stringify({ ok: true, skipped: "disabled" }));
}
