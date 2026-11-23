/**
 * AP study core: CED curricula, the Dec-Mar coverage calendar, the learner
 * model, the Sunday pace check, and the daily 30-minute planner. No I/O
 * except loadCurricula. Everything here is deterministic so it can be
 * tested; models only write and grade packets.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CURRICULUM_DIR = join(dirname(fileURLToPath(import.meta.url)), "ap-curriculum");
export const EXAM_IDS = ["physics-2", "physics-c-mech", "us-history", "lit", "calc-bc"];
export const DAILY_MINUTES = 30;
export const FOCUS_MINUTES = 20;
export const REVIEW_MINUTES = 10;
export const DIAGNOSTIC_DAYS = [
  { date: "2026-11-24", exam: "physics-2" },
  { date: "2026-11-25", exam: "us-history" },
  { date: "2026-11-26", exam: "physics-c-mech" },
  { date: "2026-11-27", exam: "lit" },
  { date: "2026-11-28", exam: "calc-bc" },
];
export const LEARN_TOPIC_MINUTES = 10;
export const SHORT_TOPIC_MINUTES = 7;
export const REVIEW_TOPIC_MINUTES = 2.5;
export const REVIEW_ITEM_MINUTES = 2.5;
export const ON_TRACK_MASTERY = 0.6;
export const PULL_AHEAD_MASTERY = 0.75;

// ---------------------------------------------------------------- dates

/** @param {string} key */
function toUtc(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** @param {number} ms */
function fromUtc(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** @param {string} key @param {number} n */
export function addDays(key, n) {
  return fromUtc(toUtc(key) + n * 86400000);
}

/** Days from a to b. @param {string} a @param {string} b */
export function dayDiff(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / 86400000);
}

/** 0 = Sunday. @param {string} key */
export function weekday(key) {
  return new Date(toUtc(key)).getUTCDay();
}

/** Monday of the week (Mon-Sun) holding this date. @param {string} key */
export function weekMonday(key) {
  const dow = weekday(key);
  return addDays(key, dow === 0 ? -6 : 1 - dow);
}

/** @param {string} key */
export function monthKey(key) {
  return key.slice(0, 7);
}

// ---------------------------------------------------------------- curricula

/**
 * @typedef {{ id: string, name: string, bc?: boolean }} Topic
 * @typedef {{ id: string, name: string, weight: [number, number], topics: Topic[], bc?: boolean }} Unit
 * @typedef {{ exam: string, name: string, short: string, examDate: string, ced: string, format: string, units: Unit[] }} Curriculum
 */

/**
 * @param {string} [dir]
 * @returns {Record<string, Curriculum>}
 */
export function loadCurricula(dir = CURRICULUM_DIR) {
  /** @type {Record<string, Curriculum>} */
  const out = {};
  for (const exam of EXAM_IDS) {
    out[exam] = JSON.parse(readFileSync(join(dir, `${exam}.json`), "utf8"));
  }
  return out;
}

/** @param {string} [dir] */
export function loadCalendarSpec(dir = CURRICULUM_DIR) {
  return JSON.parse(readFileSync(join(dir, "calendar-spec.json"), "utf8"));
}

/** @param {string} exam @param {string} id */
export function topicKey(exam, id) {
  return `${exam}:${id}`;
}

/** @param {string} key */
export function splitTopicKey(key) {
  const at = key.indexOf(":");
  return { exam: key.slice(0, at), id: key.slice(at + 1) };
}

/**
 * Exam-skill units (Physics "FRQ types", USH "Writing", Lit "Essays and MCQ
 * pacing") have letter ids. CED content units are numbered.
 * @param {{ id: string }} unit
 */
export function isSkillUnit(unit) {
  return !/^\d+$/.test(String(unit?.id || ""));
}

/**
 * Flat topic index with per-topic exam weight (unit midpoint / topic count).
 * @param {Record<string, Curriculum>} curricula
 */
export function topicIndex(curricula) {
  /** @type {Record<string, { key: string, exam: string, id: string, name: string, unitId: string, unitName: string, weight: number, order: number }>} */
  const out = {};
  let order = 0;
  for (const exam of EXAM_IDS) {
    const c = curricula[exam];
    if (!c) continue;
    for (const unit of c.units) {
      const mid = (unit.weight[0] + unit.weight[1]) / 2;
      const each = unit.topics.length ? mid / unit.topics.length : 0;
      for (const t of unit.topics) {
        const key = topicKey(exam, t.id);
        out[key] = {
          key,
          exam,
          id: t.id,
          name: t.name,
          unitId: unit.id,
          unitName: unit.name,
          weight: each,
          order: order++,
        };
      }
    }
  }
  return out;
}

/**
 * @param {string} selector "U:9" or "T:10.1-10.3"
 * @param {Curriculum} curriculum
 * @returns {string[]} topic ids in curriculum order
 */
export function resolveSelector(selector, curriculum) {
  const [kind, rest] = [selector.slice(0, 2), selector.slice(2)];
  if (kind === "U:") {
    const unit = curriculum.units.find((u) => u.id === rest);
    if (!unit) throw new Error(`${curriculum.exam}: no unit ${rest}`);
    return unit.topics.map((t) => t.id);
  }
  if (kind === "T:") {
    const dash = rest.indexOf("-");
    const first = dash > 0 ? rest.slice(0, dash) : rest;
    const last = dash > 0 ? rest.slice(dash + 1) : rest;
    for (const unit of curriculum.units) {
      const ids = unit.topics.map((t) => t.id);
      const a = ids.indexOf(first);
      const b = ids.indexOf(last);
      if (a >= 0 && b >= a) return ids.slice(a, b + 1);
    }
    throw new Error(`${curriculum.exam}: bad range ${rest}`);
  }
  throw new Error(`bad selector ${selector}`);
}

// ---------------------------------------------------------------- calendar

/**
 * Teaching and buffer weeks between spec.start and spec.end.
 * A week's month is its Thursday's month, clamped to spec.end.
 * @param {{ start: string, end: string, bufferWeeks: string[] }} spec
 */
export function calendarWeeks(spec) {
  /** @type {{ monday: string, sunday: string, month: string, buffer: boolean }[]} */
  const weeks = [];
  const buffers = new Set(spec.bufferWeeks || []);
  for (let monday = weekMonday(spec.start); monday <= spec.end; monday = addDays(monday, 7)) {
    const thursday = addDays(monday, 3);
    const month = monthKey(thursday > spec.end ? spec.end : thursday);
    const sunday = addDays(monday, 6);
    weeks.push({
      monday,
      sunday: sunday > spec.end ? spec.end : sunday,
      month,
      buffer: buffers.has(monday),
    });
  }
  return weeks;
}

/**
 * Split an ordered topic list across n weeks by cumulative weight.
 * @param {{ key: string, weight: number }[]} topics
 * @param {number} n
 */
export function spreadAcrossWeeks(topics, n) {
  const total = topics.reduce((s, t) => s + (t.weight || 1), 0) || 1;
  let run = 0;
  return topics.map((t) => {
    run += t.weight || 1;
    const frac = run / total;
    return Math.min(n - 1, Math.max(0, Math.ceil(frac * n - 1e-9) - 1));
  });
}

/**
 * @param {Record<string, Curriculum>} curricula
 * @param {any} spec calendar-spec.json
 */
export function buildCalendar(curricula, spec) {
  const index = topicIndex(curricula);
  const weeks = calendarWeeks(spec);
  /** @type {Record<string, { exam: string, month: string, mode: "learn"|"review", teachBy: string, week: string }>} */
  const topics = {};
  /** @type {string[]} */
  const errors = [];
  for (const [month, perExam] of Object.entries(spec.months || {})) {
    const monthWeeks = weeks.filter((w) => w.month === month && !w.buffer);
    if (!monthWeeks.length) {
      errors.push(`${month}: no teaching weeks`);
      continue;
    }
    for (const exam of EXAM_IDS) {
      const plan = /** @type {any} */ (perExam)[exam];
      if (!plan) continue;
      for (const mode of /** @type {const} */ (["learn", "review"])) {
        const keys = [];
        for (const sel of plan[mode] || []) {
          for (const id of resolveSelector(sel, curricula[exam])) keys.push(topicKey(exam, id));
        }
        const rows = keys.map((key) => ({ key, weight: index[key]?.weight || 1 }));
        const slots = spreadAcrossWeeks(rows, monthWeeks.length);
        rows.forEach((row, i) => {
          if (topics[row.key]) {
            errors.push(`${row.key} scheduled twice (${topics[row.key].month}, ${month})`);
            return;
          }
          const w = monthWeeks[slots[i]];
          topics[row.key] = { exam, month, mode, teachBy: w.sunday, week: w.monday };
        });
      }
    }
  }
  for (const key of Object.keys(index)) {
    if (!topics[key]) errors.push(`${key} not on the calendar`);
  }

  /** @type {{ date: string, exam: string }[]} */
  const checkpoints = [];
  for (const month of Object.keys(spec.months || {})) {
    const teach = weeks.filter((w) => w.month === month && !w.buffer);
    if (!teach.length) continue;
    const last = teach[teach.length - 1].sunday;
    EXAM_IDS.forEach((exam, i) => {
      checkpoints.push({ date: addDays(last, i - (EXAM_IDS.length - 1)), exam });
    });
  }

  return {
    version: 1,
    builtAt: new Date().toISOString(),
    start: spec.start,
    end: spec.end,
    weeks,
    weeklyMinutes: spec.weeklyMinutes,
    floorMinutes: spec.floorMinutes ?? 15,
    topics,
    checkpoints,
    errors,
  };
}

// ---------------------------------------------------------------- learner model

/**
 * @typedef {{
 *   exam: string, mastery: number, graded: number, correct: number,
 *   learnPageAt?: string, introducedAt?: string, reviewsAfterIntro: number,
 *   lastSeen?: string, lastScore?: number, intervalDays: number, dueAt?: string,
 *   learnRate?: number, timeRatio?: number, fast?: boolean,
 *   source: string, errorTags: Record<string, number>, short?: boolean
 * }} TopicState
 */

export function newModel() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    /** @type {Record<string, TopicState>} */
    topics: {},
    /** @type {Record<string, string>} */
    appliedDays: {},
    /** @type {Record<string, { lastTouched?: string }>} */
    exams: {},
  };
}

/** @param {number} n */
function clamp01(n) {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

/**
 * @param {ReturnType<typeof newModel>} model
 * @param {string} key
 */
export function ensureTopic(model, key) {
  if (!model.topics[key]) {
    model.topics[key] = {
      exam: splitTopicKey(key).exam,
      mastery: 0.05,
      graded: 0,
      correct: 0,
      reviewsAfterIntro: 0,
      intervalDays: 0,
      source: "none",
      errorTags: {},
    };
  }
  return model.topics[key];
}

/**
 * Yan said he already knows this topic. Counts as introduced, with two reviews
 * banked, so the planner stops teaching it and only brings it back when due.
 * @param {ReturnType<typeof newModel>} model
 * @param {string} key
 * @param {string} date
 * @param {number} [mastery]
 */
export function markKnown(model, key, date, mastery = 0.85) {
  const t = ensureTopic(model, key);
  t.mastery = Math.max(t.mastery, clamp01(mastery));
  t.learnPageAt = t.learnPageAt || date;
  t.introducedAt = t.introducedAt || date;
  t.reviewsAfterIntro = Math.max(t.reviewsAfterIntro, 2);
  t.lastSeen = date;
  t.dueAt = addDays(date, 6);
  t.intervalDays = Math.max(t.intervalDays, 6);
  if (t.source === "none") t.source = "told";
  return t;
}

/**
 * Starting scores from known grades. priors: [{ exam, select, mastery, note }].
 * @param {ReturnType<typeof newModel>} model
 * @param {Record<string, Curriculum>} curricula
 * @param {{ exam: string, select: string, mastery: number, note?: string }[]} priors
 */
export function applyPriors(model, curricula, priors) {
  for (const key of Object.keys(topicIndex(curricula))) ensureTopic(model, key);
  for (const p of priors || []) {
    for (const id of resolveSelector(p.select, curricula[p.exam])) {
      const t = ensureTopic(model, topicKey(p.exam, id));
      if (t.graded > 0) continue;
      t.mastery = clamp01(p.mastery);
      t.source = `prior${p.note ? `: ${p.note}` : ""}`;
    }
  }
  return model;
}

/**
 * Next review interval in days.
 * @param {number} prev
 * @param {number} score 0..1
 */
export function nextInterval(prev, score) {
  if (score >= 0.8) return prev > 0 ? Math.max(prev + 1, Math.round(prev * 2.2)) : 2;
  if (score >= 0.5) return Math.max(1, Math.round((prev || 1) * 1.2));
  return 1;
}

/**
 * @param {TopicState} t
 * @param {"learn"|"review"|undefined} mode
 */
export function isIntroduced(t, mode) {
  if (mode === "review") return t.graded >= 1;
  return Boolean(t.learnPageAt) && t.graded >= 2;
}

/** @param {TopicState} t */
export function reviewsNeeded(t) {
  return t.fast ? 1 : 2;
}

/**
 * @param {TopicState} t
 * @param {"learn"|"review"|undefined} mode
 */
export function isCovered(t, mode) {
  return isIntroduced(t, mode) && t.reviewsAfterIntro >= reviewsNeeded(t);
}

/**
 * One graded attempt on one topic.
 * @param {TopicState} t
 * @param {{ score: number, date: string, timeRatio?: number, errorTags?: string[], mode?: "learn"|"review" }} r
 */
export function updateTopic(t, r) {
  const score = clamp01(r.score);
  const before = t.mastery;
  const alpha = t.graded < 3 ? 0.45 : 0.3;
  const firstTry = t.graded === 0;
  t.mastery = clamp01(before + alpha * (score - before));
  const gain = t.mastery - before;
  t.graded += 1;
  if (score >= 0.8) t.correct += 1;
  t.learnRate = t.learnRate == null ? gain : 0.7 * t.learnRate + 0.3 * gain;
  if (Number.isFinite(r.timeRatio) && /** @type {number} */ (r.timeRatio) > 0) {
    t.timeRatio = t.timeRatio == null ? r.timeRatio : 0.7 * t.timeRatio + 0.3 * /** @type {number} */ (r.timeRatio);
  }
  if (firstTry && score >= 0.9 && (r.timeRatio ?? 1) < 1) t.fast = true;
  for (const tag of r.errorTags || []) t.errorTags[tag] = (t.errorTags[tag] || 0) + 1;
  const wasIntroduced = Boolean(t.introducedAt);
  if (wasIntroduced && r.date > /** @type {string} */ (t.introducedAt)) t.reviewsAfterIntro += 1;
  if (!wasIntroduced && isIntroduced(t, r.mode)) t.introducedAt = r.date;
  t.intervalDays = nextInterval(t.intervalDays, score);
  t.dueAt = addDays(r.date, t.intervalDays);
  t.lastSeen = r.date;
  t.lastScore = Math.round(score * 100) / 100;
  if (t.source === "none" || t.source.startsWith("prior")) t.source = "graded";
  return t;
}

/**
 * Apply one graded day. Idempotent per date.
 * grade: { status, timeRatio, items: [{ topic, score, skipped, errorTags }],
 *          learnTopicsSeen: [keys], selfRatings: [{ exam, unitId, rating }] }
 * @param {ReturnType<typeof newModel>} model
 * @param {Record<string, Curriculum>} curricula
 * @param {any} calendar
 * @param {string} date
 * @param {any} grade
 */
export function applyGrade(model, curricula, calendar, date, grade) {
  if (model.appliedDays[date]) return { applied: false, reason: "already applied" };
  if (!grade || grade.status === "skipped") {
    model.appliedDays[date] = "skipped";
    return { applied: true, skipped: true };
  }
  for (const key of grade.learnTopicsSeen || []) {
    const t = ensureTopic(model, key);
    if (!t.learnPageAt) t.learnPageAt = date;
  }
  const index = topicIndex(curricula);
  for (const r of grade.selfRatings || []) {
    const rating = Number(r.rating);
    if (!(rating >= 1 && rating <= 5)) continue;
    const self = (rating - 1) / 4;
    for (const [key, row] of Object.entries(index)) {
      if (row.exam !== r.exam || row.unitId !== String(r.unitId)) continue;
      const t = ensureTopic(model, key);
      if (t.graded > 0) continue;
      t.mastery = clamp01(0.5 * t.mastery + 0.5 * self * 0.85);
      t.source = "self-rating";
    }
  }
  /** @type {Set<string>} */
  const touched = new Set();
  for (const item of grade.items || []) {
    if (!item || item.skipped || !item.topic) continue;
    const key = String(item.topic);
    if (!index[key]) continue;
    const t = ensureTopic(model, key);
    updateTopic(t, {
      score: Number(item.score),
      date,
      timeRatio: Number(grade.timeRatio) || undefined,
      errorTags: Array.isArray(item.errorTags) ? item.errorTags : [],
      mode: calendar?.topics?.[key]?.mode,
    });
    touched.add(t.exam);
  }
  for (const exam of touched) {
    model.exams[exam] = { ...(model.exams[exam] || {}), lastTouched: date };
  }
  model.appliedDays[date] = "graded";
  return { applied: true, skipped: false, exams: [...touched] };
}

// ---------------------------------------------------------------- pace

/**
 * Sunday pace check. Moves up to 15 min/week toward exams that are behind.
 * @param {any} calendar
 * @param {ReturnType<typeof newModel>} model
 * @param {string} asOf
 */
export function paceCheck(calendar, model, asOf) {
  const teachingWeeks = calendar.weeks.filter((w) => !w.buffer).length || 1;
  /** @type {Record<string, any>} */
  const exams = {};
  for (const exam of EXAM_IDS) {
    const rows = Object.entries(calendar.topics).filter(([, c]) => c.exam === exam);
    const perWeek = rows.length / teachingWeeks || 1;
    let scheduled = 0;
    let introduced = 0;
    let overdue = 0;
    let ahead = 0;
    let onTrackMiss = 0;
    for (const [key, c] of rows) {
      const t = model.topics[key];
      const intro = t ? isIntroduced(t, c.mode) : false;
      if (c.teachBy < asOf) {
        scheduled += 1;
        if (!intro) overdue += 1;
      } else if (intro) {
        ahead += 1;
      }
      if (intro) introduced += 1;
      if (t?.introducedAt && dayDiff(t.introducedAt, asOf) >= 14 && t.mastery < ON_TRACK_MASTERY) {
        onTrackMiss += 1;
      }
    }
    exams[exam] = {
      topics: rows.length,
      scheduled,
      introduced,
      overdue,
      ahead,
      onTrackMiss,
      behindWeeks: Math.round((overdue / perWeek) * 10) / 10,
      minutes: calendar.weeklyMinutes[exam] || 0,
      bufferPriority: false,
    };
  }
  const floor = calendar.floorMinutes ?? 15;
  const behind = EXAM_IDS.filter((e) => exams[e].behindWeeks > 0).sort(
    (a, b) => exams[b].behindWeeks - exams[a].behindWeeks
  );
  for (const exam of behind) {
    const donor = EXAM_IDS.filter((e) => e !== exam && exams[e].behindWeeks === 0)
      .sort((a, b) => exams[b].ahead - exams[a].ahead || exams[b].minutes - exams[a].minutes)
      .find((e) => exams[e].minutes - 15 >= floor);
    if (donor) {
      exams[donor].minutes -= 15;
      exams[exam].minutes += 15;
    }
    if (exams[exam].behindWeeks > 1) exams[exam].bufferPriority = true;
  }
  return { asOf, exams };
}

/**
 * Month-end rule: low-weight topics left in the month get the short version.
 * @param {any} calendar
 * @param {ReturnType<typeof newModel>} model
 * @param {Record<string, Curriculum>} curricula
 * @param {string} date
 */
export function shortVersionTopics(calendar, model, curricula, date) {
  const month = monthKey(date);
  const teach = calendar.weeks.filter((w) => w.month === month && !w.buffer);
  if (!teach.length) return [];
  const lastSunday = teach[teach.length - 1].sunday;
  if (dayDiff(date, lastSunday) > 7) return [];
  const index = topicIndex(curricula);
  /** @type {string[]} */
  const out = [];
  for (const exam of EXAM_IDS) {
    const left = Object.entries(calendar.topics)
      .filter(([key, c]) => c.exam === exam && c.month <= month && !isIntroduced(model.topics[key] || /** @type {any} */ ({ graded: 0 }), c.mode))
      .map(([key]) => key);
    const remainingMinutes = left.length * LEARN_TOPIC_MINUTES;
    const daysLeft = Math.max(1, dayDiff(date, lastSunday) + 1);
    const budget = ((calendar.weeklyMinutes[exam] || 0) / 7) * daysLeft;
    if (remainingMinutes <= budget) continue;
    const weights = left.map((k) => index[k]?.weight || 0).sort((a, b) => a - b);
    const median = weights[Math.floor(weights.length / 2)] ?? 0;
    for (const key of left) if ((index[key]?.weight || 0) <= median) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------- planner

/**
 * @param {Record<string, Curriculum>} curricula
 * @param {string} date
 */
export function upcomingExams(curricula, date) {
  return EXAM_IDS.filter((e) => curricula[e].examDate >= date).sort(
    (a, b) => curricula[a].examDate.localeCompare(curricula[b].examDate)
  );
}

/**
 * Minutes each exam already got this week, from earlier plans.
 * @param {{ date: string, blocks: { exam: string, minutes: number }[] }[]} history
 * @param {string} date
 */
export function minutesThisWeek(history, date) {
  const monday = weekMonday(date);
  /** @type {Record<string, number>} */
  const used = Object.fromEntries(EXAM_IDS.map((e) => [e, 0]));
  for (const p of history || []) {
    if (!p || p.date < monday || p.date >= date) continue;
    for (const b of p.blocks || []) used[b.exam] = (used[b.exam] || 0) + (Number(b.minutes) || 0);
  }
  return used;
}

/**
 * @param {{ date: string, blocks: { exam: string }[] }[]} history
 * @param {ReturnType<typeof newModel>} model
 * @param {string} exam
 */
function lastTouched(history, model, exam) {
  let last = model.exams?.[exam]?.lastTouched || "";
  for (const p of history || []) {
    if ((p.blocks || []).some((b) => b.exam === exam) && p.date > last) last = p.date;
  }
  return last;
}

/**
 * @param {{
 *   date: string,
 *   curricula: Record<string, Curriculum>,
 *   calendar: any,
 *   model: ReturnType<typeof newModel>,
 *   pace?: any,
 *   history?: any[],
 *   align?: any,
 *   prefs?: any,
 * }} ctx
 */
export function planDay(ctx) {
  const { date, curricula, calendar, model } = ctx;
  const history = ctx.history || [];
  const align = ctx.align || {};
  const prefs = ctx.prefs || {};
  const index = topicIndex(curricula);
  const upcoming = upcomingExams(curricula, date);
  /** @param {string} key @param {any} extra */
  const topicRow = (key, extra = {}) => ({
    key,
    id: index[key].id,
    name: index[key].name,
    unit: index[key].unitName,
    mode: calendar.topics[key]?.mode || "learn",
    ...extra,
  });

  if ((prefs.skipDates || []).includes(date)) {
    return finalize({ date, mode: "skip", blocks: [] }, curricula);
  }
  if (!upcoming.length) return finalize({ date, mode: "done", blocks: [] }, curricula);

  const diag = DIAGNOSTIC_DAYS.find((d) => d.date === date);
  if (diag && !prefs.skipDiagnostics) {
    const c = curricula[diag.exam];
    const keyed = (u) => u.topics.map((t) => ({ key: `${diag.exam}:${t.id}`, name: t.name }));
    return finalize(
      {
        date,
        mode: "diagnostic",
        focusExam: diag.exam,
        blocks: [
          {
            exam: diag.exam,
            kind: "diagnostic",
            minutes: DAILY_MINUTES,
            units: c.units.filter((u) => !isSkillUnit(u)).map((u) => ({ id: u.id, name: u.name, topics: keyed(u) })),
            skills: c.units.filter(isSkillUnit).flatMap(keyed),
            topics: [],
          },
        ],
      },
      curricula
    );
  }

  const heavy = Boolean(align.heavyDay);
  const weekRow = calendar.weeks.find((w) => w.monday === weekMonday(date));
  const inBuffer = Boolean(weekRow?.buffer);
  const examMode = date > calendar.end;
  const finalExam = upcoming.find((e) => dayDiff(date, curricula[e].examDate) <= 7);
  const short = new Set(shortVersionTopics(calendar, model, curricula, date));
  const firstTeach = calendar.weeks.find((w) => !w.buffer);
  const month = weekRow
    ? weekRow.month
    : date < calendar.start
      ? firstTeach?.month || monthKey(calendar.start)
      : monthKey(date);
  const exams = upcoming;

  /** @param {string} key */
  const state = (key) => model.topics[key] || /** @type {TopicState} */ ({ mastery: 0.05, graded: 0, reviewsAfterIntro: 0, errorTags: {} });

  // ------------------------------------------------------ candidates to teach
  /** @param {string} exam */
  function learnCandidates(exam) {
    const avoid = new Set(align.exams?.[exam]?.avoid || []);
    const preview = new Set(align.exams?.[exam]?.preview || []);
    const rows = Object.entries(calendar.topics)
      .filter(([key, c]) => c.exam === exam && !isIntroduced(state(key), c.mode) && !avoid.has(key))
      .map(([key, c]) => ({ key, c }));
    let current = rows.filter((r) => r.c.month <= month);
    if (!current.length) {
      const introducedThisMonth = Object.entries(calendar.topics).filter(
        ([key, c]) => c.exam === exam && c.month === month && model.topics[key]?.introducedAt
      );
      const avg = introducedThisMonth.length
        ? introducedThisMonth.reduce((s, [key]) => s + state(key).mastery, 0) / introducedThisMonth.length
        : 0;
      if (avg >= PULL_AHEAD_MASTERY) current = rows.filter((r) => r.c.month > month).slice(0, 3);
    }
    return current
      .sort((a, b) => {
        const ao = a.c.teachBy < date ? 0 : 1;
        const bo = b.c.teachBy < date ? 0 : 1;
        if (ao !== bo) return ao - bo;
        const ap = preview.has(a.key) ? 0 : 1;
        const bp = preview.has(b.key) ? 0 : 1;
        if (ap !== bp) return ap - bp;
        return a.c.teachBy.localeCompare(b.c.teachBy) || index[a.key].order - index[b.key].order;
      })
      .map((r) => r.key);
  }

  /** @param {string} exam */
  function need(exam) {
    let n = 0;
    for (const [key, row] of Object.entries(index)) {
      if (row.exam !== exam) continue;
      if (isCovered(state(key), calendar.topics[key]?.mode)) continue;
      n += row.weight * (1 - state(key).mastery);
    }
    return n;
  }

  /** @param {string} exam @param {number} minutes */
  function fillLearn(exam, minutes) {
    const out = [];
    let left = minutes;
    for (const key of learnCandidates(exam)) {
      const mode = calendar.topics[key]?.mode || "learn";
      const isShort = short.has(key);
      const cost = mode === "review" ? REVIEW_TOPIC_MINUTES : isShort ? SHORT_TOPIC_MINUTES : LEARN_TOPIC_MINUTES;
      if (cost > left + 0.01) {
        if (!out.length) {
          out.push(topicRow(key, { short: true }));
          left = 0;
        }
        break;
      }
      out.push(topicRow(key, isShort ? { short: true } : {}));
      left -= cost;
      if (left < REVIEW_TOPIC_MINUTES) break;
    }
    return out;
  }

  // ------------------------------------------------------ review picks
  /** @param {string[]} excludeExams @param {number} minutes */
  function pickReviews(excludeExams, minutes) {
    const reinforce = new Set(EXAM_IDS.flatMap((e) => align.exams?.[e]?.reinforce || []));
    const slots = Math.max(1, Math.floor(minutes / REVIEW_ITEM_MINUTES));
    const seen = Object.entries(model.topics).filter(
      ([key, t]) => index[key] && t.graded > 0 && exams.includes(t.exam) && !excludeExams.includes(t.exam)
    );
    const stale = exams.filter(
      (e) => !excludeExams.includes(e) && (!lastTouched(history, model, e) || dayDiff(lastTouched(history, model, e), date) >= 2)
    );
    const ranked = seen
      .map(([key, t]) => {
        const overdueDays = t.dueAt ? dayDiff(t.dueAt, date) : 0;
        let score = 0;
        if (overdueDays >= 0) score += 10 + Math.min(overdueDays, 10);
        if (reinforce.has(key)) score += 8;
        if (stale.includes(t.exam)) score += 6;
        score += (1 - t.mastery) * 5;
        return { key, exam: t.exam, score };
      })
      .sort((a, b) => b.score - a.score);
    /** @type {string[]} */
    const picked = [];
    /** @type {Set<string>} */
    const examsPicked = new Set();
    for (const exam of stale) {
      const hit = ranked.find((r) => r.exam === exam && !picked.includes(r.key));
      if (hit && picked.length < slots) {
        picked.push(hit.key);
        examsPicked.add(exam);
      }
    }
    for (const r of ranked) {
      if (picked.length >= slots) break;
      if (picked.includes(r.key)) continue;
      if (!examsPicked.has(r.exam) && examsPicked.size >= 3) continue;
      picked.push(r.key);
      examsPicked.add(r.exam);
    }
    /** @type {Record<string, string[]>} */
    const byExam = {};
    for (const key of picked) (byExam[index[key].exam] ||= []).push(key);
    // Stale exams with nothing graded yet get a warm-up on their next topic.
    for (const exam of stale) {
      if (byExam[exam] || picked.length >= slots) continue;
      const next = learnCandidates(exam)[0];
      if (next) {
        byExam[exam] = [next];
        picked.push(next);
      }
    }
    return Object.entries(byExam).map(([exam, keys]) => ({
      exam,
      kind: "review",
      minutes: Math.round(keys.length * REVIEW_ITEM_MINUTES * 10) / 10,
      topics: keys.map((k) => topicRow(k, { review: true })),
    }));
  }

  /** @param {string} exam */
  function checkpointBlock(exam) {
    const introduced = Object.entries(model.topics)
      .filter(([key, t]) => index[key] && t.exam === exam && t.graded > 0)
      .sort(([, a], [, b]) => a.mastery - b.mastery)
      .slice(0, 6)
      .map(([key]) => topicRow(key, { review: true }));
    return { exam, kind: "checkpoint", minutes: REVIEW_MINUTES, topics: introduced };
  }

  // ------------------------------------------------------ choose mode
  /** @type {any[]} */
  let blocks = [];
  let mode = "learn";
  let focusExam = "";

  if (heavy) {
    mode = "review-only";
    blocks = pickReviews([], DAILY_MINUTES);
  } else if (finalExam) {
    mode = "final-week";
    focusExam = finalExam;
    const weakest = Object.entries(index)
      .filter(([, r]) => r.exam === finalExam)
      .sort(([a], [b]) => state(a).mastery - state(b).mastery || index[b].weight - index[a].weight)
      .slice(0, 4)
      .map(([key]) => topicRow(key, { review: true }));
    blocks.push({ exam: finalExam, kind: "exam-practice", minutes: FOCUS_MINUTES, topics: weakest });
    blocks.push(...pickReviews([finalExam], REVIEW_MINUTES));
  } else if (examMode) {
    mode = "exam";
    const priority = exams
      .map((e) => ({
        exam: e,
        p: need(e) / Math.max(1, dayDiff(date, curricula[e].examDate)),
      }))
      .sort((a, b) => b.p - a.p);
    focusExam = priority[0].exam;
    const weak = Object.entries(index)
      .filter(([key, r]) => r.exam === focusExam && (state(key).mastery < ON_TRACK_MASTERY || !state(key).introducedAt))
      .sort(([a], [b]) => index[b].weight * (1 - state(b).mastery) - index[a].weight * (1 - state(a).mastery))
      .slice(0, 3)
      .map(([key]) => topicRow(key, { review: true }));
    blocks.push({ exam: focusExam, kind: "exam-practice", minutes: FOCUS_MINUTES, released: true, topics: weak });
    blocks.push(...pickReviews([focusExam], REVIEW_MINUTES));
  } else {
    const used = minutesThisWeek(history, date);
    const pace = ctx.pace?.exams || {};
    const remaining = Object.fromEntries(
      exams.map((e) => [e, (pace[e]?.minutes ?? calendar.weeklyMinutes[e] ?? 0) - (used[e] || 0)])
    );
    const withWork = exams.filter((e) => learnCandidates(e).length);
    const testWeek = new Set(exams.filter((e) => align.exams?.[e]?.schoolTest));
    const pool = inBuffer
      ? withWork.filter((e) => pace[e]?.bufferPriority || learnCandidates(e).some((k) => calendar.topics[k].teachBy < date))
      : withWork.filter((e) => !testWeek.has(e));
    if (inBuffer) mode = "buffer";
    if (pool.length) {
      const boost =
        prefs.boost?.exam && (!prefs.boost.until || date <= prefs.boost.until) ? prefs.boost.exam : "";
      focusExam = pool
        .map((e) => ({
          e,
          r: remaining[e] + (pace[e]?.bufferPriority ? 30 : 0) + (e === boost ? 40 : 0),
          n: need(e),
        }))
        .sort((a, b) => b.r - a.r || b.n - a.n)[0].e;
      const focusMinutes = inBuffer ? 15 : FOCUS_MINUTES;
      const topics = fillLearn(focusExam, focusMinutes);
      blocks.push({ exam: focusExam, kind: "learn", minutes: focusMinutes, topics });
    }
    const checkpoint = (calendar.checkpoints || []).find((c) => c.date === date && exams.includes(c.exam));
    const reviewMinutes = DAILY_MINUTES - blocks.reduce((s, b) => s + b.minutes, 0);
    if (checkpoint && !inBuffer) {
      blocks.push(checkpointBlock(checkpoint.exam));
      if (reviewMinutes > REVIEW_MINUTES) blocks.push(...pickReviews([focusExam, checkpoint.exam], reviewMinutes - REVIEW_MINUTES));
    } else {
      const reviews = pickReviews(focusExam ? [focusExam] : [], reviewMinutes);
      blocks.push(...reviews);
      const got = reviews.reduce((s, b) => s + b.minutes, 0);
      if (focusExam && got < reviewMinutes - 2) {
        const extra = fillLearn(focusExam, reviewMinutes - got).filter(
          (t) => !blocks[0].topics.some((x) => x.key === t.key)
        );
        if (extra.length) {
          blocks[0].topics.push(...extra);
          blocks[0].minutes += reviewMinutes - got;
        } else {
          blocks[0].minutes += reviewMinutes - got;
        }
      }
    }
  }

  blocks = blocks.filter((b) => b.topics?.length || b.kind === "diagnostic");
  const total = blocks.reduce((s, b) => s + b.minutes, 0);
  if (total > DAILY_MINUTES) {
    const scale = DAILY_MINUTES / total;
    for (const b of blocks) b.minutes = Math.round(b.minutes * scale * 10) / 10;
  }
  return finalize({ date, mode, focusExam, heavyDay: heavy, blocks }, curricula);
}

/**
 * @param {any} plan
 * @param {Record<string, Curriculum>} curricula
 */
function finalize(plan, curricula) {
  plan.minutes = Math.round((plan.blocks || []).reduce((s, b) => s + (b.minutes || 0), 0));
  plan.summary = planSummary(plan, curricula);
  return plan;
}

/**
 * "Physics 2 focus + US History/Lit review, 30 min"
 * @param {any} plan
 * @param {Record<string, Curriculum>} curricula
 */
export function planSummary(plan, curricula) {
  const short = (e) => curricula[e]?.short || e;
  if (plan.mode === "skip") return "AP: skipped today";
  if (plan.mode === "done") return "AP: all exams done";
  const focus = plan.blocks.find((b) => b.kind !== "review");
  const others = [...new Set(plan.blocks.filter((b) => b !== focus).map((b) => short(b.exam)))];
  const head =
    plan.mode === "diagnostic"
      ? `${short(plan.focusExam)} diagnostic`
      : focus
        ? `${short(focus.exam)} ${focus.kind === "checkpoint" ? "checkpoint" : focus.kind === "exam-practice" ? "exam practice" : "focus"}`
        : "Mixed review";
  const tail = others.length ? ` + ${others.join("/")} review` : "";
  return `AP: ${head}${tail}, ${plan.minutes || DAILY_MINUTES} min`;
}

/**
 * Topics still needing attention on Mar 31: not introduced or under 0.6.
 * @param {any} calendar
 * @param {ReturnType<typeof newModel>} model
 */
export function aprilPriorityList(calendar, model) {
  return Object.entries(calendar.topics)
    .filter(([key, c]) => {
      const t = model.topics[key];
      return !t || !isIntroduced(t, c.mode) || t.mastery < ON_TRACK_MASTERY;
    })
    .map(([key]) => key);
}
