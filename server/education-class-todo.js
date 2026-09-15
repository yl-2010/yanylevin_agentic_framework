/**
 * Class-page TODO vs Completed hold, and when a class todo/date folder
 * should be visible in Finder on OneDrive.
 */

import {
  addDaysParts,
  classesForDayParts,
  isSchoolDayParts,
  parseYmdParts,
  scheduleNowParts,
  timeToMinutes,
} from "./education-data.js";

/**
 * @param {object|null|undefined} cls
 * @returns {string}
 */
function classIdOf(cls) {
  return String(cls?.id || "").trim();
}

/**
 * Meetings of one class from fromKey through toKey (inclusive).
 * @param {object} cls
 * @param {object} schedule
 * @param {string} fromKey
 * @param {string} toKey
 */
export function classMeetingsBetween(cls, schedule, fromKey, toKey) {
  const id = classIdOf(cls);
  if (!id || !fromKey || !toKey || fromKey > toKey) return [];
  /** @type {{ dateKey: string, startMin: number, endMin: number, period: string }[]} */
  const out = [];
  let parts = parseYmdParts(fromKey);
  const end = parseYmdParts(toKey);
  if (!parts || !end) return [];
  for (let i = 0; i < 400; i++) {
    const dateKey = `${String(parts.y).padStart(4, "0")}-${String(parts.m).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    if (dateKey > toKey) break;
    if (isSchoolDayParts(parts, schedule)) {
      const day = {
        dateKey,
        weekday: parts.weekday,
        y: parts.y,
        m: parts.m,
        day: parts.day,
      };
      const meetings = classesForDayParts(schedule, [cls], day, new Set([id]));
      const hit = meetings.find((m) => m.classId === id);
      if (hit && hit.startMin != null && hit.endMin != null) {
        out.push({
          dateKey,
          startMin: hit.startMin,
          endMin: hit.endMin,
          period: hit.period,
        });
      }
    }
    parts = addDaysParts(parts, 1);
  }
  return out;
}

/**
 * Meeting that archives a checked-off class todo to Completed.
 * @param {object} todo
 * @param {object} cls
 * @param {object} schedule
 * @returns {{ dateKey: string, endMin: number }|null}
 */
export function classTodoArchiveMeeting(todo, cls, schedule) {
  const dueKey = String(todo?.dueDate || "").trim();
  const dueDay = parseYmdParts(dueKey);
  if (!dueDay || !cls) return null;
  const dueMinutes = timeToMinutes(todo.dueTime) ?? 0;
  const schoolStart = String(schedule?.schoolStart || dueKey);
  const schoolEnd = String(schedule?.schoolEnd || dueKey);
  const fromKey = schoolStart < dueKey ? schoolStart : dueKey;
  let toKey = schoolEnd > dueKey ? schoolEnd : dueKey;
  const extra = addDaysParts(dueDay, 90);
  const extraKey = `${String(extra.y).padStart(4, "0")}-${String(extra.m).padStart(2, "0")}-${String(extra.day).padStart(2, "0")}`;
  if (extraKey > toKey) toKey = extraKey;

  const meetings = classMeetingsBetween(cls, schedule, fromKey, toKey);
  const sameDay = meetings.find((m) => m.dateKey === dueKey);
  if (sameDay) {
    if (dueMinutes < sameDay.endMin) {
      return { dateKey: dueKey, endMin: sameDay.endMin };
    }
    return { dateKey: dueKey, endMin: dueMinutes };
  }
  const next = meetings.find((m) => m.dateKey > dueKey);
  if (!next) return null;
  return { dateKey: next.dateKey, endMin: next.endMin };
}

/**
 * True when a checked-off class todo belongs in the Completed box.
 * @param {object} todo
 * @param {object} cls
 * @param {object} schedule
 * @param {Date} [now]
 */
export function classTodoReadyForCompleted(todo, cls, schedule, now = new Date()) {
  if (!todo?.done) return false;
  const meeting = classTodoArchiveMeeting(todo, cls, schedule);
  if (!meeting) return true;
  const clock = scheduleNowParts(schedule, now);
  if (clock.dateKey > meeting.dateKey) return true;
  if (clock.dateKey < meeting.dateKey) return false;
  return meeting.endMin != null && clock.minutes >= meeting.endMin;
}

function tagOf(todo) {
  return String(todo?.tag || "").trim().toUpperCase();
}

function meetingsBeforeDue(todo, cls, schedule) {
  const tag = tagOf(todo);
  if (tag === "QA" || tag === "MA") return 2;
  return 1;
}

function dueInstant(todo) {
  const dueKey = String(todo?.dueDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueKey)) return null;
  return { dueKey, dueMinutes: timeToMinutes(todo.dueTime) ?? 0 };
}

/**
 * Start of the Nth class meeting before the due meeting, as a dateKey+startMin.
 * @param {object} todo
 * @param {object} cls
 * @param {object} schedule
 * @param {number} n
 */
export function todoVisibleFromMeeting(todo, cls, schedule, n) {
  const due = dueInstant(todo);
  if (!due || !cls || n < 1) return null;
  const schoolStart = String(schedule?.schoolStart || due.dueKey);
  const schoolEnd = String(schedule?.schoolEnd || due.dueKey);
  const extra = parseYmdParts(due.dueKey);
  const extraParts = extra ? addDaysParts(extra, 90) : null;
  const extraKey = extraParts
    ? `${String(extraParts.y).padStart(4, "0")}-${String(extraParts.m).padStart(2, "0")}-${String(extraParts.day).padStart(2, "0")}`
    : due.dueKey;
  const toKey = extraKey > schoolEnd ? extraKey : schoolEnd;
  const fromKey = schoolStart < due.dueKey ? schoolStart : due.dueKey;
  const meetings = classMeetingsBetween(cls, schedule, fromKey, toKey);
  let dueIndex = meetings.findIndex((m) => m.dateKey === due.dueKey);
  if (dueIndex < 0) {
    dueIndex = meetings.findIndex((m) => m.dateKey > due.dueKey);
  }
  if (dueIndex < 0) return null;
  const startIndex = Math.max(0, dueIndex - n);
  const start = meetings[startIndex];
  if (!start) return null;
  return { dateKey: start.dateKey, startMin: start.startMin };
}

function isOverdue(todo, schedule, now) {
  const due = dueInstant(todo);
  if (!due || todo?.done) return false;
  const clock = scheduleNowParts(schedule, now);
  if (clock.dateKey > due.dueKey) return true;
  if (clock.dateKey < due.dueKey) return false;
  return clock.minutes >= due.dueMinutes;
}

function atOrAfter(clock, when) {
  if (!when) return false;
  if (clock.dateKey > when.dateKey) return true;
  if (clock.dateKey < when.dateKey) return false;
  return clock.minutes >= (when.startMin ?? 0);
}

/**
 * Finder-visible class todo folders.
 * @param {object} todo
 * @param {object} cls
 * @param {object} schedule
 * @param {Date} [now]
 */
export function todoFolderShouldBeVisible(todo, cls, schedule, now = new Date()) {
  if (!todo) return false;
  if (todo.done && classTodoReadyForCompleted(todo, cls, schedule, now)) {
    return false;
  }
  if (!todo.done && isOverdue(todo, schedule, now)) return true;
  if (todo.folderRevealedAt) return true;
  if (todo.done) return true;
  const n = meetingsBeforeDue(todo, cls, schedule);
  const from = todoVisibleFromMeeting(todo, cls, schedule, n);
  if (!from) return false;
  return atOrAfter(scheduleNowParts(schedule, now), from);
}

/**
 * Date folders: visible from the day before through the date, or if opened.
 * Hidden after the date.
 * @param {object} dateObj
 * @param {object} schedule
 * @param {Date} [now]
 */
export function dateFolderShouldBeVisible(dateObj, schedule, now = new Date()) {
  if (!dateObj) return false;
  if (dateObj.folderRevealedAt) {
    const clock = scheduleNowParts(schedule, now);
    const key = String(dateObj.date || "").trim();
    if (!key) return true;
    return clock.dateKey <= key;
  }
  const key = String(dateObj.date || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const clock = scheduleNowParts(schedule, now);
  const startParts = parseYmdParts(key);
  if (!startParts) return false;
  const prev = addDaysParts(startParts, -1);
  const prevKey = `${String(prev.y).padStart(4, "0")}-${String(prev.m).padStart(2, "0")}-${String(prev.day).padStart(2, "0")}`;
  return clock.dateKey >= prevKey && clock.dateKey <= key;
}
