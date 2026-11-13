/**
 * One class Live Activity for the school day.
 * The card stays up from the first highlight through 15 minutes after the last bell.
 * Passing, lunch, and free periods show the next real class.
 */

import {
  CLASS_HIGHLIGHT_LEAD_MINUTES,
  addDaysParts,
  classesForDayParts,
  isMeetingHighlighted,
  isSchoolDayParts,
  meetingHighlightStartMin,
  readEducationTree,
  scheduleNowParts,
} from "./education-data.js";

export const SCHOOL_DAY_END_BUFFER_MINUTES = 15;
export const LIVE_ACTIVITY_MAX_MS = 8 * 60 * 60 * 1000;
export const LIVE_ACTIVITY_HANDOFF_MS = 7 * 60 * 60 * 1000 + 40 * 60 * 1000;

const TAGS = new Set(["CW", "HW", "MA", "QA"]);

/**
 * @param {string} raw
 */
function stripTagPrefix(raw) {
  const trimmed = String(raw || "").trim();
  const stripped = trimmed
    .replace(/^(CW|HW|QA|MA)(?:\s*:\s*|\s+)/i, "")
    .trim();
  return stripped || trimmed;
}

/**
 * @param {object} todo
 */
function todoTag(todo) {
  const raw = String(todo?.tag || todo?.type || "").trim().toUpperCase();
  return TAGS.has(raw) ? raw : "";
}

/**
 * @param {object} todo
 */
function dueDateOf(todo) {
  if (todo?.dueDate) return String(todo.dueDate);
  const due = String(todo?.due || "");
  return due.length >= 10 ? due.slice(0, 10) : "";
}

/**
 * @param {object} todo
 */
function dueTimeOf(todo) {
  if (todo?.dueTime) return String(todo.dueTime);
  const due = String(todo?.due || "");
  if (due.length < 16) return "";
  const slice = due.slice(11, 16);
  return slice.includes(":") ? slice : "";
}

/**
 * @param {string|null|undefined} t
 */
function timeToMinutes(t) {
  const match = String(t || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * @param {object} tree
 */
function flattenTodos(tree) {
  /** @type {object[]} */
  const out = [];
  for (const todo of tree?.todos || []) out.push(todo);
  for (const cls of tree?.classes || []) {
    for (const todo of [...(cls.todos || []), ...(cls.classOnlyTodos || [])]) {
      out.push({ ...todo, classId: todo.classId || cls.id });
    }
  }
  for (const project of tree?.projects || []) {
    for (const todo of project.todos || []) {
      out.push({ ...todo, projectId: todo.projectId || project.id });
    }
  }
  return out;
}

/**
 * Open HW for that class that day, plus CW / MA / QA whose due time falls in the meeting.
 * @param {object} tree
 * @param {{ classId: string, startMin?: number|null, endMin?: number|null }} meeting
 * @param {string} dateKey
 * @param {number} [limit]
 */
export function assignmentsForMeeting(tree, meeting, dateKey, limit = 4) {
  const rows = flattenTodos(tree).filter((todo) => {
    const tag = todoTag(todo);
    if (!tag) return false;
    if (String(todo.classId || "") !== String(meeting.classId || "")) return false;
    if (dueDateOf(todo) !== dateKey) return false;
    if (tag === "HW") return true;
    const dueMin = timeToMinutes(dueTimeOf(todo));
    if (dueMin == null) return true;
    if (meeting.startMin == null || meeting.endMin == null) return true;
    return dueMin >= meeting.startMin && dueMin < meeting.endMin;
  });
  rows.sort((a, b) => {
    const aDone = a.done === true;
    const bDone = b.done === true;
    if (aDone !== bDone) return aDone ? 1 : -1;
    const aKey = `${dueDateOf(a)}T${dueTimeOf(a) || "99:99"}`;
    const bKey = `${dueDateOf(b)}T${dueTimeOf(b) || "99:99"}`;
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  const shown = rows.slice(0, limit).map((todo) => ({
    todoId: String(todo.id || ""),
    classId: todo.classId ? String(todo.classId) : null,
    tag: todoTag(todo),
    name: stripTagPrefix(todo.name || todo.title || todo.id || "").slice(0, 80),
    done: todo.done === true,
    scoreLabel: String(todo.canvasWork?.label || "").trim().slice(0, 24),
  }));
  return { items: shown, overflow: Math.max(0, rows.length - shown.length) };
}

/**
 * @param {object[]} meetings
 * @param {number} minutes
 */
export function classActivityDecision(meetings, minutes) {
  const list = (Array.isArray(meetings) ? meetings : []).filter(
    (row) => row && row.startMin != null && row.endMin != null
  );
  const real = [];
  for (let i = 0; i < list.length; i++) {
    if (!list[i].freePeriod) real.push({ meeting: list[i], index: i });
  }
  if (!real.length) {
    return {
      phase: "idle",
      meeting: null,
      staleAtMin: null,
      dayStartMin: null,
      dayEndMin: null,
      lastBellMin: null,
    };
  }
  const lastBellMin = list.reduce((max, row) => Math.max(max, row.endMin), 0);
  const dayEndMin = lastBellMin + SCHOOL_DAY_END_BUFFER_MINUTES;
  let dayStartMin = meetingHighlightStartMin(list, real[0].index, CLASS_HIGHLIGHT_LEAD_MINUTES);
  for (let i = 0; i < real[0].index; i++) {
    const highlight = meetingHighlightStartMin(list, i, CLASS_HIGHLIGHT_LEAD_MINUTES);
    if (highlight != null && (dayStartMin == null || highlight < dayStartMin)) {
      dayStartMin = highlight;
    }
  }
  const base = {
    meeting: null,
    staleAtMin: null,
    dayStartMin,
    dayEndMin,
    lastBellMin,
  };
  if (dayStartMin == null || minutes < dayStartMin) {
    return { ...base, phase: "idle" };
  }
  if (minutes >= dayEndMin) {
    return { ...base, phase: "end" };
  }
  for (const row of real) {
    if (isMeetingHighlighted(list, row.index, minutes, CLASS_HIGHLIGHT_LEAD_MINUTES)) {
      return {
        ...base,
        phase: "show",
        meeting: row.meeting,
        staleAtMin: row.meeting.endMin,
      };
    }
  }
  const upcoming = real.find((row) => row.meeting.endMin > minutes);
  if (upcoming) {
    return {
      ...base,
      phase: "show",
      meeting: upcoming.meeting,
      staleAtMin: upcoming.meeting.endMin,
    };
  }
  const last = real[real.length - 1].meeting;
  return {
    ...base,
    phase: "show",
    meeting: last,
    staleAtMin: dayEndMin,
  };
}

/**
 * Unix seconds for a wall-clock minute on dateKey in the schedule timezone.
 * ActivityKit push dates are seconds since 1970.
 * @param {string} dateKey
 * @param {number} minutes
 * @param {string} timezone
 */
export function unixAtMinutes(dateKey, minutes, timezone) {
  const match = String(dateKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(minutes)) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const tz = timezone || "America/Los_Angeles";
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  for (let i = 0; i < 4; i++) {
    const parts = fmt.formatToParts(new Date(guess));
    const pick = (type) => Number(parts.find((part) => part.type === type)?.value);
    const got = Date.UTC(pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute"));
    const want = Date.UTC(y, m - 1, d, hour, minute);
    const delta = want - got;
    if (delta === 0) break;
    guess += delta;
  }
  return Math.floor(guess / 1000);
}

/**
 * @param {object} meeting
 * @param {string} dateKey
 * @param {string} timezone
 * @param {string} scoreLabel
 * @param {{ items: object[], overflow: number }} assignments
 */
export function contentStateForMeeting(meeting, dateKey, timezone, scoreLabel, assignments) {
  return {
    classId: String(meeting.classId || ""),
    className: String(meeting.className || meeting.classId || ""),
    period: String(meeting.period || ""),
    start: String(meeting.start || ""),
    end: String(meeting.end || ""),
    startDate: unixAtMinutes(dateKey, meeting.startMin, timezone),
    endDate: unixAtMinutes(dateKey, meeting.endMin, timezone),
    scoreLabel: String(scoreLabel || ""),
    assignments: assignments.items,
    overflowCount: assignments.overflow,
  };
}

/**
 * @param {object} state
 */
export function contentSignature(state) {
  if (!state) return "";
  return JSON.stringify({
    classId: state.classId,
    start: state.startDate,
    end: state.endDate,
    score: state.scoreLabel,
    overflow: state.overflowCount,
    items: (state.assignments || []).map((row) => [row.todoId, row.done, row.scoreLabel, row.name]),
  });
}

/**
 * @param {string} email
 * @param {Date} [now]
 */
export async function classActivitySnapshot(email, now = new Date()) {
  const tree = await readEducationTree(email);
  const schedule = tree?.schedule || {};
  const clock = scheduleNowParts(schedule, now);
  const timezone = clock.timezone || schedule.timezone || "America/Los_Angeles";
  const school = isSchoolDayParts(
    { y: clock.y, m: clock.m, day: clock.day, weekday: clock.weekday },
    schedule
  );
  const allowedRaw = tree?.activeClassIdsByDate?.[clock.dateKey];
  const allowed = Array.isArray(allowedRaw) ? new Set(allowedRaw) : null;
  const meetings = school
    ? classesForDayParts(
        schedule,
        tree?.classes || [],
        { dateKey: clock.dateKey, weekday: clock.weekday },
        allowed
      )
    : [];
  const decision = classActivityDecision(meetings, clock.minutes);
  const dayId = `school-day-${clock.dateKey}`;
  let contentState = null;
  let staleUnix = null;
  if (decision.phase === "show" && decision.meeting) {
    const cls = (tree?.classes || []).find((row) => row.id === decision.meeting.classId);
    const assignments = assignmentsForMeeting(tree, decision.meeting, clock.dateKey);
    contentState = contentStateForMeeting(
      decision.meeting,
      clock.dateKey,
      timezone,
      cls?.canvasScoreLabel || "",
      assignments
    );
    staleUnix = unixAtMinutes(clock.dateKey, decision.staleAtMin, timezone);
  }
  const dayStartUnix =
    decision.dayStartMin == null
      ? null
      : unixAtMinutes(clock.dateKey, decision.dayStartMin, timezone);
  let wakeUnix = null;
  if (decision.phase === "end" || (decision.phase === "idle" && dayStartUnix == null)) {
    wakeUnix = nextSchoolDayStartUnix(schedule, tree, clock, timezone);
  }
  return {
    email,
    dateKey: clock.dateKey,
    timezone,
    minutes: clock.minutes,
    dayId,
    phase: decision.phase,
    contentState,
    signature: contentSignature(contentState),
    staleUnix,
    dayStartUnix,
    wakeUnix,
    dayEndUnix:
      decision.dayEndMin == null
        ? null
        : unixAtMinutes(clock.dateKey, decision.dayEndMin, timezone),
    lastBellUnix:
      decision.lastBellMin == null
        ? null
        : unixAtMinutes(clock.dateKey, decision.lastBellMin, timezone),
  };
}

/**
 * First highlight on the next school day, so a Friday night tick can sleep until Monday.
 * @param {object} schedule
 * @param {object} tree
 * @param {{ y: number, m: number, day: number, weekday: number }} clock
 * @param {string} timezone
 */
function nextSchoolDayStartUnix(schedule, tree, clock, timezone) {
  let cursor = addDaysParts(clock, 1);
  for (let i = 0; i < 14; i++) {
    if (
      isSchoolDayParts(
        { y: cursor.y, m: cursor.m, day: cursor.day, weekday: cursor.weekday },
        schedule
      )
    ) {
      const dateKey = `${cursor.y}-${String(cursor.m).padStart(2, "0")}-${String(cursor.day).padStart(2, "0")}`;
      const dayAllowedRaw = tree?.activeClassIdsByDate?.[dateKey];
      const dayAllowed = Array.isArray(dayAllowedRaw) ? new Set(dayAllowedRaw) : null;
      const meetings = classesForDayParts(
        schedule,
        tree?.classes || [],
        { dateKey, weekday: cursor.weekday },
        dayAllowed
      );
      const decision = classActivityDecision(meetings, -1);
      if (decision.dayStartMin != null) {
        return unixAtMinutes(dateKey, decision.dayStartMin, timezone);
      }
    }
    cursor = addDaysParts(cursor, 1);
  }
  return null;
}

/**
 * Milliseconds until the next content change, capped so a new token is noticed.
 * @param {Awaited<ReturnType<typeof classActivitySnapshot>>} snap
 * @param {number} [nowMs]
 */
export function msUntilNextClassPush(snap, nowMs = Date.now()) {
  const cap = 30 * 60 * 1000;
  /** @type {number[]} */
  const times = [];
  if (snap.phase === "idle" && snap.dayStartUnix) times.push(snap.dayStartUnix * 1000);
  if (snap.phase === "show" && snap.staleUnix) times.push(snap.staleUnix * 1000);
  if (snap.wakeUnix) times.push(snap.wakeUnix * 1000);
  const ahead = times.map((at) => at - nowMs).filter((ms) => ms > 1000);
  if (!ahead.length) return 30 * 60 * 1000;
  return Math.min(cap, ...ahead);
}
