/**
 * Model steps for the daily AP packet: align (school context to topic hints),
 * write (plan to packet.json), grade (ink crops to grade.json).
 * Each runs a local Cursor agent in the day folder and reads back one JSON file.
 */

import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";

export const AP_STUDY_MODEL = {
  id: "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

/**
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
 */
function modelSelection(spec) {
  return { id: spec.id, params: (spec.params || []).map((p) => ({ id: p.id, value: p.value })) };
}

/**
 * @param {string} apiKey
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
 */
async function resolveModelSelection(apiKey, spec) {
  const fallback = modelSelection(spec);
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    const listed = models?.find((m) => m?.id === fallback.id);
    if (!listed) return fallback;
    const variant = (listed.variants || []).find((v) =>
      fallback.params.every((w) => (v?.params || []).some((p) => p.id === w.id && p.value === w.value))
    );
    return variant?.params?.length ? modelSelection({ id: listed.id, params: variant.params }) : fallback;
  } catch (err) {
    console.warn("[ap-study] model catalog lookup failed", err instanceof Error ? err.message : err);
    return fallback;
  }
}

/**
 * Pull the first JSON object out of model text.
 * @param {string} text
 */
export function parseJsonLoose(text) {
  const s = String(text || "").trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {{ prefix: string, cwd: string, prompt: string, outFile: string }} opts
 */
export async function runJsonAgent({ prefix, cwd, prompt, outFile }) {
  await reloadCursorApiKeyFromEnv();
  const model = await resolveModelSelection(requireCursorApiKey(), AP_STUDY_MODEL);
  await rm(join(cwd, outFile), { force: true });
  const outcome = await promptWithAuthRetry({
    prefix,
    prompt,
    model,
    cwd,
    laterDelaysMs: [],
    usage: { person: "Yan", kind: "ap-study", prompt: prompt.slice(0, 4000) },
  });
  if (outcome.transientFailed || outcome.aborted) {
    const err = new Error(`${prefix}: model unavailable (${outcome.authFailed ? "auth" : outcome.capacityFailed ? "capacity" : "error"})`);
    err.transient = true;
    throw err;
  }
  let raw = null;
  try {
    raw = JSON.parse(await readFile(join(cwd, outFile), "utf8"));
  } catch {
    raw = parseJsonLoose(typeof outcome.result?.result === "string" ? outcome.result.result : "");
  }
  if (!raw) throw new Error(`${prefix}: model did not write ${outFile}`);
  return { raw, model: outcome.model?.id || model.id, usedFallback: Boolean(outcome.usedFallback) };
}

// ---------------------------------------------------------------- align

/**
 * @param {{ date: string, contextFile: string, topicsFile: string }} o
 */
export function buildAlignPrompt(o) {
  return `You map Yan's school classes onto his AP study plan for ${o.date}.

Read ${o.contextFile}. It lists his class assignments and tests from about 10 days back to 10 days ahead (from the class todo folders), the class syllabi outlines, and today's calendar. Read ${o.topicsFile}. It lists every AP topic key with its name and whether it has been introduced yet.

Write align.json in this folder and nothing else:

{
  "heavyDay": false,
  "heavyReason": "",
  "exams": {
    "<exam id>": {
      "reinforce": ["<topic key>"],
      "preview": ["<topic key>"],
      "avoid": ["<topic key>"],
      "schoolTest": false,
      "note": "one line"
    }
  }
}

Rules:
- Exam ids: physics-2, physics-c-mech, us-history, lit, calc-bc. School classes map like this. US History is us-history. American Lit is lit. Advanced Calculus is calc-bc. Physics is physics-c-mech, and also physics-2 when the class covers fluids, thermo, E&M, optics, or modern physics.
- reinforce: AP topics the class covered in the last 10 days. The planner reviews these sooner.
- preview: AP topics the class will cover in the next 10 days. The planner teaches these first.
- avoid: topics the class will teach in the next 3 days, only when a cold AP version first would confuse things. Usually empty.
- schoolTest: true when that class has a test or major assessment (tag MA, TE, or a name with test, exam, quiz, or final) today or tomorrow.
- heavyDay: true when today or tomorrow has two or more tests or major assessments across all classes, or a final exam. Then today's packet is review only.
- Use only topic keys from ${o.topicsFile}. Leave lists empty when nothing matches. Do not guess.
- Skip exams with nothing to say.`;
}

/**
 * @param {any} raw
 * @param {Record<string, any>} index topicIndex
 */
export function normalizeAlign(raw, index) {
  const out = { heavyDay: Boolean(raw?.heavyDay), heavyReason: String(raw?.heavyReason || ""), exams: {} };
  for (const [exam, row] of Object.entries(raw?.exams || {})) {
    /** @param {any} list */
    const keys = (list) => (Array.isArray(list) ? list.map(String).filter((k) => index[k]?.exam === exam) : []);
    out.exams[exam] = {
      reinforce: keys(row?.reinforce),
      preview: keys(row?.preview),
      avoid: keys(row?.avoid),
      schoolTest: Boolean(row?.schoolTest),
      note: String(row?.note || ""),
    };
  }
  return out;
}

// ---------------------------------------------------------------- write

const PACKET_SCHEMA = `{
  "title": "Tue Nov 24 · Physics 2 focus",
  "date": "YYYY-MM-DD",
  "subtitle": "one line on what today covers",
  "sections": [
    {
      "exam": "<exam id from plan>",
      "kind": "learn | review | checkpoint | diagnostic | exam-practice",
      "heading": "Physics 2 · Ideal gases",
      "minutes": 20,
      "learn": [
        {
          "topic": "<topic key>",
          "title": "short title",
          "body": "teaching text. Paragraphs split by blank lines. **bold**, *italic*. Math in \\\\( \\\\) or $$ $$",
          "example": { "prompt": "worked example question", "solution": "full worked solution" },
          "figureSvg": "<svg ...>optional simple diagram</svg>"
        }
      ],
      "items": [
        {
          "id": "q1",
          "topic": "<topic key>",
          "type": "mcq | short | frq | essay | graph | derivation | rating",
          "prompt": "question text",
          "passageTitle": "optional",
          "passage": "optional source text, one line per line",
          "lineNumbers": true,
          "figureSvg": "optional",
          "choices": ["A text", "B text", "C text", "D text"],
          "parts": [
            { "label": "a", "prompt": "part text", "points": 2, "workLines": 6, "grid": false, "answer": "full answer" }
          ],
          "points": 1,
          "workLines": 4,
          "grid": false,
          "estMinutes": 3,
          "answer": "full answer or correct letter plus why",
          "rubric": "how points are earned, AP style",
          "ratings": [{ "unitId": "1", "label": "Unit 1 name" }]
        }
      ]
    }
  ]
}`;

/**
 * @param {{ date: string, planFile: string, contextFile: string }} o
 */
export function buildWritePrompt(o) {
  return `You write Yan's daily AP study packet for ${o.date}. He prints nothing. He writes on the PDF pages in OneNote with a stylus, so every answer needs space on the page.

Read ${o.planFile} first. It is the plan the code already picked: which exam gets the focus block, which topics to teach, which to review, and minutes per block. Do not change the topics or the minutes. Then read ${o.contextFile}. It has his mastery and past mistakes per topic, insights about how he learns each subject, recent feedback, what his school classes are doing, and his preferences.

Write packet.json in this folder and nothing else. Schema:

${PACKET_SCHEMA}

How to build it:
- One section per plan block, same order, same exam, same kind, same minutes.
- Sum of estMinutes in a section should match that block's minutes within about 2 minutes. A 20 minute learn block with one topic is about 6 minutes of reading and 14 of problems. Two topics split that.
- Learn topics (block kind learn, topic mode learn): one learn card each, then at least 2 graded items on that topic. The card teaches the idea from scratch in under 250 words with one worked example. Short-version topics (short: true) get a card under 120 words and 1 to 2 items.
- Learn topics with mode review are things his school class already taught. Skip the long card. Give a 3 to 5 line refresher card, then items.
- Review topics: items only, about 2.5 minutes each. Aim at his past mistakes from the context file.
- Checkpoint blocks: one mixed set covering the listed topics, AP difficulty, no learn cards.
- Diagnostic blocks: one item per unit that tests the core idea of that unit, easiest units first, then one rating item listing every unit (type rating, ratings with unitId and label, prompt can be empty). Cap at 30 minutes total. Tell him in the subtitle that it is fine to skip what he has never seen.
- Exam-practice blocks: AP free-response or a full-length MCQ set in real exam format and timing. When a block has released: true, adapt a released College Board FRQ only if you know it exactly. Otherwise write an original one in the same style and say so in the heading.
- Every item gets a topic key from the plan, an answer, and a rubric for anything over 1 point. MCQ answers start with the letter.
- Item ids are q1, q2, q3 in order across the whole packet.
- Write space: workLines is lines of about 30px. Short answer 4 to 6, physics or calc parts 6 to 10, an SAQ part 4, a thesis 3, an LEQ or DBQ paragraph 14, a full Lit essay 40. Use grid: true for graphs and free-body diagrams.

Subject notes:
- Physics: AP science practices. Mix calculation, deriving symbolic answers, translating between graphs and equations, and paragraph-length reasoning. Use SI units. Physics C problems use calculus. Physics 2 is algebra-based.
- Calc BC: AP style. Say "No calculator" or "Calculator allowed" in the prompt when it matters. Show the setup in every answer.
- US History: use real primary sources with author and year, quoted accurately and briefly. Practice the skills on their own: sourcing (HIPP), contextualization, thesis, evidence, complexity. SAQs have parts a, b, c.
- Literature: passages must be public domain (published before 1929) and quoted exactly. Set lineNumbers true for poems and prose excerpts. Questions follow the AP Lit skill categories: character, setting, structure, narration, figurative language, literary argument.

Formatting:
- Math in \\\\( \\\\) for inline or $$ $$ for display. Never single dollar signs.
- SVG figures: plain black lines and text, width at most 600, no scripts, no external images.
- No emojis. Straight quotes.`;
}

/**
 * Check a written packet against the plan. Returns warnings, keeps the packet.
 * @param {any} packet normalized
 * @param {any} plan
 */
export function checkPacketAgainstPlan(packet, plan) {
  const warnings = [];
  const keys = new Set((plan.blocks || []).flatMap((b) => (b.topics || []).map((t) => t.key)));
  for (const s of packet.sections || []) {
    for (const it of s.items || []) {
      if (it.type === "rating") continue;
      if (!it.topic) warnings.push(`${it.id}: no topic`);
      else if (keys.size && !keys.has(it.topic)) warnings.push(`${it.id}: topic ${it.topic} not in plan`);
    }
  }
  for (const key of keys) {
    const hit = (packet.sections || []).some((s) => (s.items || []).some((it) => it.topic === key));
    if (!hit) warnings.push(`plan topic ${key} has no item`);
  }
  const est = (packet.sections || []).flatMap((s) => s.items || []).reduce((sum, it) => sum + (Number(it.estMinutes) || 0), 0);
  if (est > 36) warnings.push(`estMinutes total ${est} is over 30`);
  return warnings;
}

// ---------------------------------------------------------------- grade

/**
 * @param {{ date: string, packetFile: string, cropsFile: string, planFile: string }} o
 */
export function buildGradePrompt(o) {
  return `You grade Yan's AP study packet from ${o.date}. He wrote on the pages with a stylus in OneNote.

Read ${o.packetFile}. It has every question with the answer and rubric. Read ${o.planFile} for planned minutes. Read ${o.cropsFile}. It lists one image per answer box with the stroke count drawn in it. Open each image with a nonzero stroke count and read his handwriting. ink/ has full pages with his ink drawn on them if a crop cuts something off. Boxes named _start and _finish hold the clock times he started and finished. _rating is a 1 to 5 strip where he circled how the day went. _notes is a free note to you.

Write grade.json in this folder and nothing else:

{
  "date": "${o.date}",
  "startTime": "4:10 PM or empty",
  "finishTime": "4:42 PM or empty",
  "minutesSpent": 32,
  "feeling": 4,
  "notes": "what he wrote in the notes box, or empty",
  "learnTopicsSeen": ["<topic key of each learn card he worked from>"],
  "selfRatings": [{ "exam": "<exam id>", "unitId": "1", "rating": 3 }],
  "items": [
    {
      "id": "q1",
      "part": "",
      "topic": "<topic key>",
      "points": 2,
      "earned": 1.5,
      "score": 0.75,
      "skipped": false,
      "readAs": "short transcription of what he wrote",
      "errorTags": ["units"],
      "feedback": "2 to 3 sentences to him. What was right, the exact mistake, how to fix it next time."
    }
  ],
  "insights": { "<exam id>": "1 to 3 sentences on patterns in how he works this subject. Only if today shows something new." },
  "summary": "2 sentences for the top of tomorrow's key page"
}

Rules:
- One entry per question. Grade multi-part questions as one entry with points and earned summed over parts. Put each part's result in the feedback.
- score = earned / points, from 0 to 1. Grade like an AP reader with the rubric. Partial credit counts.
- skipped: true when the box has no ink or only stray marks. Do not grade skipped items and do not guess what he meant.
- MCQ: he circles or writes a letter. Read which one.
- errorTags: short kebab-case tags for the kind of mistake (sign-error, units, wrong-formula, setup, algebra, misread-question, thesis-not-defensible, no-evidence, summary-not-analysis, timeline, vocab). Reuse tags across days. Empty when correct.
- learnTopicsSeen: a learn card counts as seen when he attempted at least one item on that topic.
- selfRatings: only from rating items. Read the circled 1 to 5 for each unit row.
- minutesSpent: finish minus start when both are readable, else 0.
- Write feedback to him directly ("you"), plain and specific. No praise padding.`;
}

/**
 * @param {any} raw
 * @param {any} packet normalized
 * @param {Record<string, any>} index topicIndex
 * @param {{ item: string, part: string, strokes: number }[]} crops
 */
export function normalizeGrade(raw, packet, index, crops) {
  const items = [];
  const byId = new Map();
  for (const s of packet.sections || []) for (const it of s.items || []) byId.set(it.id, { ...it, exam: s.exam });
  const inkFor = (id) => crops.filter((c) => c.item === id).reduce((n, c) => n + c.strokes, 0);
  const seen = new Set();
  for (const row of Array.isArray(raw?.items) ? raw.items : []) {
    const id = String(row?.id || "");
    const src = byId.get(id);
    if (!src || src.type === "rating" || seen.has(id)) continue;
    seen.add(id);
    const points = Number(row.points) || Number(src.points) || 1;
    const earned = Math.max(0, Math.min(points, Number(row.earned) || 0));
    const skipped = inkFor(id) === 0 || Boolean(row.skipped);
    const topic = index[String(row.topic)] ? String(row.topic) : src.topic;
    items.push({
      id,
      topic,
      exam: src.exam,
      points,
      earned: skipped ? 0 : earned,
      score: skipped ? 0 : Math.max(0, Math.min(1, Number.isFinite(Number(row.score)) ? Number(row.score) : earned / points)),
      skipped,
      readAs: String(row.readAs || "").slice(0, 600),
      errorTags: Array.isArray(row.errorTags) ? row.errorTags.map((t) => String(t).toLowerCase().replace(/[^a-z0-9-]+/g, "-")).filter(Boolean).slice(0, 6) : [],
      feedback: String(row.feedback || ""),
    });
  }
  for (const [id, src] of byId) {
    if (src.type === "rating" || seen.has(id)) continue;
    items.push({ id, topic: src.topic, exam: src.exam, points: Number(src.points) || 1, earned: 0, score: 0, skipped: true, readAs: "", errorTags: [], feedback: "" });
  }
  const learnKeys = new Set((packet.sections || []).flatMap((s) => (s.learn || []).map((l) => l.topic)));
  const attempted = new Set(items.filter((i) => !i.skipped).map((i) => i.topic));
  const learnTopicsSeen = [...learnKeys].filter((k) => attempted.has(k));
  const selfRatings = (Array.isArray(raw?.selfRatings) ? raw.selfRatings : [])
    .map((r) => ({ exam: String(r?.exam || ""), unitId: String(r?.unitId || ""), rating: Number(r?.rating) }))
    .filter((r) => r.exam && r.unitId && r.rating >= 1 && r.rating <= 5);
  return {
    date: String(raw?.date || packet.date || ""),
    status: items.some((i) => !i.skipped) || selfRatings.length ? "graded" : "skipped",
    startTime: String(raw?.startTime || ""),
    finishTime: String(raw?.finishTime || ""),
    minutesSpent: Math.max(0, Number(raw?.minutesSpent) || 0),
    feeling: Number(raw?.feeling) >= 1 && Number(raw?.feeling) <= 5 ? Number(raw.feeling) : null,
    notes: String(raw?.notes || ""),
    learnTopicsSeen,
    selfRatings,
    items,
    insights: Object.fromEntries(
      Object.entries(raw?.insights || {})
        .filter(([, v]) => String(v || "").trim())
        .map(([k, v]) => [k, String(v).trim()])
    ),
    summary: String(raw?.summary || ""),
  };
}
