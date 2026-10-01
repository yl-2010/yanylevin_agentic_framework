/**
 * Sort Yan's life calendars into Personal, School/Work, and Family.
 * Moves stay inside one account. New events pick the account when they are created.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { choice, systemOne, typesafeConfig } from "./typesafe.js";
import { runCalendar } from "./calendar-cli.js";

const execFileAsync = promisify(execFile);
const CAL_DB = join(
  homedir(),
  "Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb"
);
const APPLE_EPOCH_MS = 978307200 * 1000;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CAL_DIR = join(ROOT, "education", "you@example.com", "calendar");
export const DECISIONS_PATH = join(CAL_DIR, "sort-decisions.jsonl");
export const PLAN_PATH = join(CAL_DIR, "sort-plan.json");

export const MIN_CONFIDENCE = 0.5;

const YAN_EMAILS = new Set([
  "you@example.com",
  "you@example.com",
  "you@icloud.com",
  "owner@school.example",
]);

const FAMILY_RE = [
  /\brajasi\b/i,
  /\bmama\b/i,
  /\bmommy\b/i,
  /\b(?<!['’]s )mom\b/i,
  /\bpapa\b/i,
  /\bdaddy\b/i,
  /\b(?<!['’]s )dad\b/i,
  /\bmichael\b/i,
  /\badi\b/i,
  /\bsunny boy\b/i,
  /\bsunny\b/i,
  /\bsb\b/i,
  /\brs\b/i,
];

const SCHOOL_RE = [
  /\bpathivy\b/i,
  /\bsockethr\b/i,
  /\bsocket\s*hr\b/i,
  /\beps\b/i,
  /\beastside prep\b/i,
  /\bdebate\b/i,
  /\bpsat\b/i,
  /\bsat\b/i,
  /\bcollege\b/i,
  /\buniversity\b/i,
  /\badvisor\b/i,
  /\badvisory\b/i,
  /\borientation\b/i,
  /\bhackathon\b/i,
  /\bprime factor\b/i,
  /\bbmc\b/i,
  /\binternship\b/i,
  /\bfafsa\b/i,
  /\bcss profile\b/i,
  /\bucas\b/i,
  /\bmilos\b/i,
  /\bgenai\b/i,
  /\bconference\b/i,
  /\bschool\b/i,
  /\bhusky\b/i,
  /\bparent\b/i,
  /\bguardian\b/i,
];

const FRIEND_RE = [/\bjype\b/i, /\bprasham\b/i, /\bjeffery\b/i, /\beverette\b/i];

const PERSONAL_RE = [
  /\bhaircut\b/i,
  /\bdentist\b/i,
  /\bgym\b/i,
  /\bpro club\b/i,
  /\bmariners\b/i,
  /\bseahawks\b/i,
];

const CATEGORIES = ["Personal", "School/Work", "Family"];

/** First title is the one to create when that slot is missing. Later titles are older names. */
const SLOT_TITLES = {
  iCloud: {
    Personal: ["iCloud Personal", "Personal", "Home"],
    "School/Work": ["iCloud School/Work", "School/Work", "Work"],
    Family: ["iCloud Family", "Family"],
  },
  Exchange: {
    Personal: ["Calendar", "Outlook Personal", "Personal"],
    "School/Work": ["Outlook School/Work", "School/Work"],
    Family: ["Outlook Family", "My Family", "Family"],
  },
  Google: {
    Personal: ["Google Personal", "you@example.com", "Personal"],
    "School/Work": ["Google School/Work", "School/Work"],
    Family: ["Google Family", "Family"],
  },
};

/**
 * @param {string} title
 * @returns {"Personal"|"School/Work"|"Family"|null}
 */
export function classifyTitle(title) {
  const text = String(title || "");
  if (FAMILY_RE.some((re) => re.test(text))) return "Family";
  const school = SCHOOL_RE.some((re) => re.test(text));
  const friend = FRIEND_RE.some((re) => re.test(text));
  const personal = PERSONAL_RE.some((re) => re.test(text));
  if (school && (friend || personal)) return null;
  if (school) return "School/Work";
  if (friend || personal) return "Personal";
  return null;
}

function emailOf(person) {
  return String(person?.email || "")
    .replace(/^mailto:/i, "")
    .trim()
    .toLowerCase();
}

function isYan(person) {
  if (!person) return false;
  if (person.self) return true;
  const email = emailOf(person);
  if (email && YAN_EMAILS.has(email)) return true;
  return false;
}

/** Someone else organized it, or another person is invited. A name in the title is not enough. */
export function involvesOthers(event) {
  const org = event?.organizer;
  if (org && !isYan(org)) {
    if (emailOf(org) || String(org.name || "").trim()) return true;
  }
  const attendees = Array.isArray(event?.attendees) ? event.attendees : [];
  return attendees.some((person) => !isYan(person));
}

export function accountOfSource(source) {
  const name = String(source || "").toLowerCase();
  if (name === "icloud") return "iCloud";
  if (name === "exchange") return "Exchange";
  if (name === "google") return "Google";
  return "";
}

/**
 * Which category slot a calendar title is, on that account.
 * Daily Schedule is in scope but is not a slot.
 * @param {string} account
 * @param {string} title
 * @returns {"Personal"|"School/Work"|"Family"|null}
 */
export function categoryOfCalendar(account, title) {
  const slots = SLOT_TITLES[account];
  if (!slots) return null;
  const name = String(title || "");
  for (const category of CATEGORIES) {
    if (slots[category].includes(name)) return category;
  }
  return null;
}

export function inScopeCalendar(account, title) {
  if (!account) return false;
  if (categoryOfCalendar(account, title)) return true;
  return account === "iCloud" && title === "Daily Schedule";
}

function preferredSlotTitle(account, category) {
  return SLOT_TITLES[account]?.[category]?.[0] || category;
}

function decisionKey(event) {
  const id = String(event.seriesId || event.id || "");
  return `${id}|${String(event.title || "")}`;
}

/**
 * @param {object[]} events
 * @param {object[]} calendars
 */
export function resolveSlots(calendars, events) {
  /** @type {Record<string, Record<string, string>>} */
  const slots = { iCloud: {}, Exchange: {}, Google: {} };
  const counts = new Map();
  for (const event of events) {
    const id = String(event.calendarId || "");
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  for (const account of Object.keys(slots)) {
    for (const category of CATEGORIES) {
      const titles = SLOT_TITLES[account][category];
      const matches = calendars.filter(
        (cal) =>
          accountOfSource(cal.source) === account &&
          titles.includes(cal.title) &&
          cal.allowModify !== false
      );
      if (!matches.length) continue;
      matches.sort(
        (a, b) => (counts.get(b.id) || 0) - (counts.get(a.id) || 0)
      );
      slots[account][category] = matches[0].id;
    }
  }
  return slots;
}

/**
 * @param {object[]} events expanded occurrences
 * @param {{
 *   mode: "nightly"|"cleanup",
 *   slots: Record<string, Record<string, string>>,
 *   decisions: Map<string, { category: string, title: string }>,
 *   classifyAmbiguous?: (events: object[]) => Promise<Map<string, { category: string, confidence: number }|null>>,
 * }} opts
 */
export async function planMoves(events, opts) {
  const mode = opts.mode === "cleanup" ? "cleanup" : "nightly";
  const groups = new Map();
  for (const event of events) {
    const account = accountOfSource(event.source);
    if (!inScopeCalendar(account, event.calendar)) continue;
    const key = decisionKey(event);
    const prev = groups.get(key);
    if (!prev || String(event.start || "") < String(prev.start || "")) {
      groups.set(key, event);
    }
  }

  const ambiguous = [];
  /** @type {object[]} */
  const rows = [];
  for (const event of groups.values()) {
    const account = accountOfSource(event.source);
    const current = categoryOfCalendar(account, event.calendar);
    const key = decisionKey(event);
    const prior = opts.decisions.get(key);
    if (prior && current && prior.category !== current && prior.title === event.title) {
      rows.push({
        event,
        account,
        category: current,
        action: "keep-manual",
      });
      continue;
    }
    if (prior && prior.title === event.title && CATEGORIES.includes(prior.category)) {
      rows.push({ event, account, category: prior.category, action: "remembered" });
      continue;
    }
    const ruled = classifyTitle(event.title);
    if (ruled) {
      rows.push({ event, account, category: ruled, action: "rule" });
      continue;
    }
    ambiguous.push(event);
    rows.push({ event, account, category: null, action: "ambiguous" });
  }

  if (ambiguous.length && opts.classifyAmbiguous) {
    const judged = await opts.classifyAmbiguous(ambiguous);
    for (const row of rows) {
      if (row.action !== "ambiguous") continue;
      const hit = judged.get(decisionKey(row.event));
      if (!hit || !CATEGORIES.includes(hit.category)) continue;
      if (Number(hit.confidence) < MIN_CONFIDENCE) continue;
      row.category = hit.category;
      row.action = "jev";
    }
  }

  /** @type {object[]} */
  const moves = [];
  /** @type {object[]} */
  const kept = [];
  for (const row of rows) {
    let category = row.category;
    if (!category) {
      if (mode === "cleanup") category = "Personal";
      else {
        kept.push({
          id: row.event.id,
          title: row.event.title,
          reason: "unsure",
          calendar: row.event.calendar,
          source: row.event.source,
        });
        continue;
      }
    }
    const fromAccount = row.account;
    const toAccount = fromAccount;
    const targetId = opts.slots[toAccount]?.[category];
    const samePlace =
      row.event.calendarId === targetId ||
      (toAccount === fromAccount &&
        categoryOfCalendar(fromAccount, row.event.calendar) === category &&
        row.event.calendar !== "Daily Schedule");
    const record = {
      key: decisionKey(row.event),
      id: row.event.id,
      seriesId: row.event.seriesId || "",
      title: row.event.title,
      start: row.event.start || "",
      from: row.event.calendar,
      fromSource: row.event.source,
      fromAccount,
      toAccount,
      category,
      toCalendarId: targetId || "",
      span: row.event.recurring ? "future" : "this",
      action: row.action,
      involvesOthers: involvesOthers(row.event),
    };
    if (row.action === "keep-manual" || samePlace || !targetId) {
      kept.push({ ...record, reason: !targetId ? "missing-calendar" : "already" });
      continue;
    }
    moves.push(record);
  }
  return { moves, kept };
}

export async function loadDecisions(path = DECISIONS_PATH) {
  /** @type {Map<string, { category: string, title: string }>} */
  const map = new Map();
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return map;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row.key || !row.category) continue;
      map.set(row.key, { category: row.category, title: String(row.title || "") });
    } catch {
      /* skip a bad line */
    }
  }
  return map;
}

export async function appendDecisions(rows, path = DECISIONS_PATH) {
  if (!rows.length) return;
  await mkdir(dirname(path), { recursive: true });
  const lines = rows
    .map((row) =>
      JSON.stringify({
        at: new Date().toISOString(),
        key: row.key,
        title: row.title,
        category: row.category,
        from: row.from,
        toAccount: row.toAccount,
      })
    )
    .join("\n");
  let prev = "";
  try {
    prev = await readFile(path, "utf8");
  } catch {
    prev = "";
  }
  const prefix = prev && !prev.endsWith("\n") ? "\n" : prev ? "" : "";
  await writeFile(path, `${prev}${prefix}${lines}\n`, "utf8");
}

async function classifyAmbiguous(events) {
  /** @type {Map<string, { category: string, confidence: number }|null>} */
  const out = new Map();
  if (!typesafeConfig().configured) return out;
  const batchSize = 12;
  for (let i = 0; i < events.length; i += batchSize) {
    const batch = events.slice(i, i + batchSize);
    /** @type {Record<string, object>} */
    const questions = {};
    const stateEvents = batch.map((event, index) => ({
      n: index + 1,
      title: String(event.title || "").slice(0, 180),
      calendar: event.calendar,
      account: event.source,
    }));
    batch.forEach((event, index) => {
      questions[`e${index + 1}`] = choice(
        `Event ${index + 1} in the state list. Personal is Yan's own life and friends such as JYPE, Alex, Example Friend, Example Neighbor. School/Work is school, EPS, work, college prep, PathIvy, ExampleCo, debate, college visits. Family is Rajasi, Michael, Adi, or Sunny, and family wins when they are involved. Which category?`,
        {
          Personal: "Yan's own plans or time with friends",
          "School/Work": "School, work, or college prep",
          Family: "Involves Rajasi, Michael, Adi, or Sunny",
        }
      );
      void event;
    });
    try {
      const result = await systemOne({
        state: { events: stateEvents },
        questions,
      });
      batch.forEach((event, index) => {
        const answer = result?.answers?.[`e${index + 1}`];
        out.set(decisionKey(event), {
          category: String(answer?.choice || ""),
          confidence: Number(answer?.confidence),
        });
      });
    } catch (err) {
      console.error("[calendar-sort] jev", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

async function ensureCalendars() {
  const listed = await runCalendar(["list"], { timeoutMs: 60_000 });
  const calendars = Array.isArray(listed?.calendars) ? listed.calendars : [];
  const has = (source, title) =>
    calendars.some(
      (cal) => accountOfSource(cal.source) === source && cal.title === title
    );

  const creates = [];
  for (const [account, categories] of Object.entries(SLOT_TITLES)) {
    for (const [category, titles] of Object.entries(categories)) {
      if (!titles.some((title) => has(account, title))) {
        creates.push([account, preferredSlotTitle(account, category)]);
      }
    }
  }
  for (const [source, title] of creates) {
    await runCalendar(
      ["create-calendar", "--title", title, "--source", source],
      { timeoutMs: 60_000 }
    );
  }
  const again = await runCalendar(["list"], { timeoutMs: 60_000 });
  return Array.isArray(again?.calendars) ? again.calendars : [];
}

async function loadLifeEvents() {
  // EventKit only returns a reliable set when the window is under four years.
  const byId = new Map();
  for (let year = 2010; year < 2032; year += 3) {
    const result = await runCalendar(
      [
        "events",
        "--from",
        `${year}-01-01T00:00:00Z`,
        "--to",
        `${year + 3}-01-01T00:00:00Z`,
      ],
      { timeoutMs: 120_000, maxBuffer: 64 * 1024 * 1024 }
    );
    for (const event of result?.events || []) {
      const key = `${event.id}|${event.start || ""}`;
      if (!byId.has(key)) byId.set(key, event);
    }
  }
  return [...byId.values()];
}

function isAccessDenied(err) {
  const message = [
    err instanceof Error ? err.message : String(err || ""),
    err && err.stdout,
    err && err.stderr,
  ].join("\n");
  return /access denied/i.test(message);
}

function loadLifeFromSqlite() {
  const db = new DatabaseSync(CAL_DB, { readOnly: true });
  const calRows = db
    .prepare(
      `SELECT s.name AS store, c.title AS title, c.ROWID AS rowid
       FROM Calendar c JOIN Store s ON s.ROWID = c.store_id`
    )
    .all();
  /** @type {object[]} */
  const calendars = [];
  /** @type {Map<number, {account: string, title: string, id: string, source: string}>} */
  const rowToCal = new Map();
  for (const row of calRows) {
    const account = accountOfSource(row.store);
    if (!inScopeCalendar(account, row.title)) continue;
    const id = `${account}|${row.title}`;
    calendars.push({
      id,
      title: row.title,
      source: row.store,
      allowModify: true,
    });
    rowToCal.set(row.rowid, {
      account,
      title: row.title,
      id,
      source: row.store,
    });
  }
  const items = db
    .prepare(
      `SELECT ROWID AS rowid, UUID AS uuid, summary, calendar_id AS calendarId,
              start_date AS startDate, has_recurrences AS recurring, hidden
       FROM CalendarItem WHERE hidden = 0`
    )
    .all();
  const parts = db
    .prepare(`SELECT owner_id AS ownerId, email, is_self AS isSelf FROM Participant`)
    .all();
  /** @type {Map<number, object[]>} */
  const byOwner = new Map();
  for (const part of parts) {
    if (!byOwner.has(part.ownerId)) byOwner.set(part.ownerId, []);
    byOwner.get(part.ownerId).push(part);
  }
  /** @type {object[]} */
  const events = [];
  for (const item of items) {
    const cal = rowToCal.get(item.calendarId);
    if (!cal || !item.uuid) continue;
    const attendees = (byOwner.get(item.rowid) || [])
      .filter((part) => part.email)
      .map((part) => {
        const email = String(part.email).toLowerCase();
        return { email, self: YAN_EMAILS.has(email) || part.isSelf === 1 };
      });
    const start =
      item.startDate == null
        ? ""
        : new Date(item.startDate * 1000 + APPLE_EPOCH_MS).toISOString();
    events.push({
      id: item.uuid,
      seriesId: item.uuid,
      title: item.summary || "",
      calendar: cal.title,
      calendarId: cal.id,
      source: cal.source,
      start,
      recurring: item.recurring === 1,
      attendees,
    });
  }
  db.close();
  return { calendars, events };
}

function appleQuote(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function applyAppleMoves(moves) {
  /** @type {object[]} */
  const applied = [];
  /** @type {object[]} */
  const failed = [];
  const batchSize = 12;
  for (let i = 0; i < moves.length; i += batchSize) {
    const batch = moves.slice(i, i + batchSize);
    const jobs = batch
      .map((move) => {
        const dest = String(move.toCalendarId || "").split("|").slice(1).join("|");
        return `{eventUid:"${appleQuote(move.id)}", fromCal:"${appleQuote(move.from)}", toCal:"${appleQuote(dest)}"}`;
      })
      .join(", ");
    const script = `
set jobList to {${jobs}}
set outLines to {}
tell application "Calendar"
  repeat with job in jobList
    set uidText to ""
    try
      set jobInfo to contents of job
      set uidText to eventUid of jobInfo
      set srcName to fromCal of jobInfo
      set dstName to toCal of jobInfo
      set e to event id uidText of calendar srcName
      set recNow to ""
      try
        set recNow to recurrence of e
      end try
      if recNow is not missing value and recNow is not "" then error "recurring series stays until yl-calendar can move it"
      set s to summary of e
      set sd to start date of e
      set ed to end date of e
      set isAll to allday event of e
      set props to {summary:s, start date:sd, end date:ed, allday event:isAll}
      try
        set noteText to description of e
        if noteText is not missing value then set props to props & {description:noteText}
      end try
      try
        set loc to location of e
        if loc is not missing value and loc is not "" then set props to props & {location:loc}
      end try
      try
        set u to url of e
        if u is not missing value and u is not "" then set props to props & {url:u}
      end try
      try
        set rec to recurrence of e
        if rec is not missing value and rec is not "" then set props to props & {recurrence:rec}
      end try
      tell calendar dstName
        make new event with properties props
      end tell
      delete e
      set end of outLines to "ok|" & uidText
    on error errMsg
      set end of outLines to "fail|" & uidText & "|" & errMsg
    end try
  end repeat
end tell
set AppleScript's text item delimiters to linefeed
return outLines as text
`;
    let text = "";
    try {
      const { stdout } = await execFileAsync("osascript", ["-e", script], {
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      text = String(stdout || "");
    } catch (err) {
      const stderr = err && err.stderr ? String(err.stderr) : "";
      const message = `${err instanceof Error ? err.message : String(err)}\n${stderr}`;
      for (const move of batch) failed.push({ ...move, error: message.slice(0, 500) });
      continue;
    }
    const byId = new Map(batch.map((move) => [move.id, move]));
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const [status, uid, ...rest] = line.split("|");
      const move = byId.get(uid);
      if (!move) continue;
      byId.delete(uid);
      if (status === "ok") applied.push(move);
      else failed.push({ ...move, error: rest.join("|").slice(0, 400) || "copy failed" });
    }
    for (const move of byId.values()) {
      failed.push({ ...move, error: "Calendar.app did not report this move" });
    }
  }
  return { applied, failed };
}

async function deleteDailyScheduleApple() {
  const script = `tell application "Calendar" to delete calendar "Daily Schedule"`;
  await execFileAsync("osascript", ["-e", script], { timeout: 60_000 });
}

/**
 * @param {{ mode?: "nightly"|"cleanup", dryRun?: boolean, decisionsPath?: string, planPath?: string }} [opts]
 */
async function runCalendarSortSqlite(opts) {
  const mode = opts.mode === "cleanup" ? "cleanup" : "nightly";
  const { calendars, events } = loadLifeFromSqlite();
  const slots = resolveSlots(calendars, events);
  const decisions = await loadDecisions(opts.decisionsPath || DECISIONS_PATH);
  const plan = await planMoves(events, {
    mode,
    slots,
    decisions,
    classifyAmbiguous,
  });
  const solo = [];
  const invited = [];
  for (const move of plan.moves) {
    if (move.involvesOthers) invited.push(move);
    else solo.push(move);
  }
  const payload = {
    at: new Date().toISOString(),
    mode,
    transport: "calendar-app",
    moveCount: plan.moves.length,
    soloCount: solo.length,
    invitedCount: invited.length,
    moves: plan.moves,
    kept: plan.kept.length,
  };
  await mkdir(CAL_DIR, { recursive: true });
  await writeFile(opts.planPath || PLAN_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  if (opts.dryRun) {
    return { ok: true, dryRun: true, ...payload, applied: [], failed: invited };
  }
  const result = await applyAppleMoves(solo);
  const failed = [
    ...result.failed,
    ...invited.map((move) => ({
      ...move,
      error: "Left in place. It has other people on it, and yl-calendar cannot move invites until Calendar access is on.",
    })),
  ];
  const decisionRows = [...result.applied];
  for (const row of plan.kept) {
    if (!row.key || !row.category || row.reason === "unsure") continue;
    decisionRows.push(row);
  }
  await appendDecisions(decisionRows, opts.decisionsPath || DECISIONS_PATH);
  let deletedDaily = false;
  if (mode === "cleanup") {
    const left = loadLifeFromSqlite().events.filter((event) => event.calendar === "Daily Schedule");
    if (!left.length) {
      try {
        await deleteDailyScheduleApple();
        deletedDaily = true;
      } catch (err) {
        failed.push({
          title: "Daily Schedule",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      failed.push({
        title: "Daily Schedule",
        error: `${left.length} events still on it, so it was not deleted`,
      });
    }
  }
  return {
    ok: failed.length === 0,
    mode,
    transport: "calendar-app",
    moveCount: plan.moves.length,
    applied: result.applied.length,
    failed,
    deletedDaily,
    moves: result.applied,
  };
}

/**
 * @param {{ mode?: "nightly"|"cleanup", dryRun?: boolean, decisionsPath?: string, planPath?: string, prompt?: boolean }} [opts]
 */
export async function runCalendarSort(opts = {}) {
  try {
    return await runCalendarSortEventKit(opts);
  } catch (err) {
    if (!isAccessDenied(err)) throw err;
    console.error("[calendar-sort] yl-calendar has no Calendar access. Solo events go through Calendar.app.");
    return runCalendarSortSqlite(opts);
  }
}

/**
 * @param {{ mode?: "nightly"|"cleanup", dryRun?: boolean, decisionsPath?: string, planPath?: string }} [opts]
 */
async function runCalendarSortEventKit(opts = {}) {
  const mode = opts.mode === "cleanup" ? "cleanup" : "nightly";
  const calendars = await ensureCalendars();
  const events = await loadLifeEvents();
  const slots = resolveSlots(calendars, events);
  const decisions = await loadDecisions(opts.decisionsPath || DECISIONS_PATH);
  const plan = await planMoves(events, {
    mode,
    slots,
    decisions,
    classifyAmbiguous,
  });
  const payload = {
    at: new Date().toISOString(),
    mode,
    moveCount: plan.moves.length,
    moves: plan.moves,
    kept: plan.kept.length,
  };
  await mkdir(CAL_DIR, { recursive: true });
  await writeFile(opts.planPath || PLAN_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  if (opts.dryRun) return { ok: true, dryRun: true, ...payload, applied: [], failed: [] };

  /** @type {object[]} */
  const applied = [];
  /** @type {object[]} */
  const failed = [];
  for (const move of plan.moves) {
    const args = ["update", "--id", move.id, "--calendar-id", move.toCalendarId];
    if (move.span === "future") args.push("--span", "future");
    try {
      const result = await runCalendar(args, { timeoutMs: 60_000 });
      if (!result?.ok) {
        failed.push({ ...move, error: result?.error || "update failed" });
        continue;
      }
      applied.push(move);
    } catch (err) {
      failed.push({
        ...move,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const decisionRows = [];
  for (const move of applied) decisionRows.push(move);
  for (const row of plan.kept) {
    if (!row.key || !row.category || row.reason === "unsure") continue;
    decisionRows.push(row);
  }
  await appendDecisions(decisionRows, opts.decisionsPath || DECISIONS_PATH);

  let deletedDaily = false;
  if (mode === "cleanup") {
    const daily = calendars.find(
      (cal) => accountOfSource(cal.source) === "iCloud" && cal.title === "Daily Schedule"
    );
    if (daily) {
      try {
        await runCalendar(
          ["delete-calendar", "--calendar-id", daily.id, "--source", "iCloud"],
          { timeoutMs: 60_000 }
        );
        deletedDaily = true;
      } catch (err) {
        failed.push({
          title: "Daily Schedule",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      deletedDaily = true;
    }
  }

  return {
    ok: failed.length === 0,
    mode,
    moveCount: plan.moves.length,
    applied: applied.length,
    failed,
    deletedDaily,
    moves: applied,
  };
}

const isCli =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isCli) {
  const cleanup = process.argv.includes("--cleanup");
  const dryRun = process.argv.includes("--dry-run");
  runCalendarSort({ mode: cleanup ? "cleanup" : "nightly", dryRun })
    .then((result) => {
      const summary = {
        ok: result.ok,
        mode: result.mode,
        dryRun: Boolean(result.dryRun),
        moveCount: result.moveCount,
        applied: result.applied,
        failed: result.failed,
        deletedDaily: result.deletedDaily,
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!result.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[calendar-sort]", err);
      process.exitCode = 1;
    });
}
