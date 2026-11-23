import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DAILY_MINUTES,
  DIAGNOSTIC_DAYS,
  EXAM_IDS,
  addDays,
  applyGrade,
  applyPriors,
  markKnown,
  buildCalendar,
  ensureTopic,
  isIntroduced,
  loadCalendarSpec,
  loadCurricula,
  newModel,
  nextInterval,
  paceCheck,
  planDay,
  topicIndex,
  updateTopic,
  weekday,
} from "./ap-study-model.js";
import { decodeTrace, parseInkml, strokesInBox, strokesOnImage, HIMETRIC_TO_PX, splitInkMultipart } from "./onenote-ink.js";
import { normalizePacket, sanitizeSvg, richText } from "./ap-study-render.js";
import { checkPacketAgainstPlan, normalizeAlign, normalizeGrade, parseJsonLoose } from "./ap-study-agents.js";
import { fallbackAlign, insertApStudyCapsule, looksLikeTest, shortDate } from "./ap-study.js";

const curricula = loadCurricula();
const spec = loadCalendarSpec();
const calendar = buildCalendar(curricula, spec);
const index = topicIndex(curricula);

describe("calendar", () => {
  it("schedules every topic of every exam by the gate", () => {
    assert.deepEqual(calendar.errors, []);
    assert.equal(Object.keys(calendar.topics).length, Object.keys(index).length);
    for (const [key, c] of Object.entries(calendar.topics)) {
      assert.ok(c.teachBy <= spec.end, `${key} teachBy ${c.teachBy}`);
      assert.ok(c.teachBy >= spec.start, `${key} teachBy ${c.teachBy}`);
    }
  });

  it("keeps buffer weeks free of new teaching deadlines", () => {
    const buffers = new Set(calendar.weeks.filter((w) => w.buffer).map((w) => w.sunday));
    for (const c of Object.values(calendar.topics)) assert.ok(!buffers.has(c.teachBy));
  });

  it("places checkpoints in the last days of each teaching month", () => {
    assert.ok(calendar.checkpoints.length >= 4 * 5);
    for (const cp of calendar.checkpoints) assert.ok(EXAM_IDS.includes(cp.exam));
  });
});

describe("learner model", () => {
  it("grows review intervals on good scores and resets on bad ones", () => {
    assert.equal(nextInterval(0, 0.9), 2);
    assert.equal(nextInterval(2, 0.9), 4);
    assert.equal(nextInterval(10, 0.9), 22);
    assert.equal(nextInterval(10, 0.6), 12);
    assert.equal(nextInterval(10, 0.2), 1);
  });

  it("moves mastery toward the score, faster for the first attempts", () => {
    const model = newModel();
    const t = ensureTopic(model, "physics-2:9.2");
    const start = t.mastery;
    updateTopic(t, { score: 1, date: "2026-12-01", errorTags: [] });
    const first = t.mastery - start;
    assert.ok(Math.abs(first - 0.45 * (1 - start)) < 1e-9);
    for (let i = 0; i < 3; i++) updateTopic(t, { score: 1, date: addDays("2026-12-01", i + 1), errorTags: [] });
    const before = t.mastery;
    updateTopic(t, { score: 0, date: "2026-12-10", errorTags: ["units"] });
    assert.ok(Math.abs(before - t.mastery - 0.3 * before) < 1e-9);
    assert.equal(t.errorTags.units, 1);
    assert.equal(t.lastScore, 0);
  });

  it("counts a topic introduced after a learn page and two graded items", () => {
    const model = newModel();
    const key = "physics-2:9.2";
    const g = (date, extra = {}) => ({ status: "graded", items: [{ topic: key, score: 0.7, errorTags: [] }], ...extra });
    applyGrade(model, curricula, calendar, "2026-12-01", g("2026-12-01", { learnTopicsSeen: [key] }));
    assert.equal(isIntroduced(model.topics[key], "learn"), false);
    applyGrade(model, curricula, calendar, "2026-12-02", g("2026-12-02"));
    assert.equal(isIntroduced(model.topics[key], "learn"), true);
    assert.equal(model.topics[key].introducedAt, "2026-12-02");
  });

  it("applies a graded day once", () => {
    const model = newModel();
    const grade = { status: "graded", items: [{ topic: "lit:2.FIG", score: 1, errorTags: [] }] };
    assert.equal(applyGrade(model, curricula, calendar, "2026-12-03", grade).applied, true);
    assert.equal(applyGrade(model, curricula, calendar, "2026-12-03", grade).applied, false);
    assert.equal(model.topics["lit:2.FIG"].graded, 1);
  });

  it("blends self ratings only into ungraded topics", () => {
    const model = newModel();
    applyGrade(model, curricula, calendar, "2026-11-24", {
      status: "graded",
      items: [{ topic: "physics-2:9.1", score: 0, errorTags: [] }],
      selfRatings: [{ exam: "physics-2", unitId: "9", rating: 5 }],
    });
    assert.equal(model.topics["physics-2:9.1"].graded, 1);
    assert.ok(model.topics["physics-2:9.2"].mastery > 0.3);
  });

  it("applies priors by unit and by topic range", () => {
    const model = newModel();
    applyPriors(model, curricula, [
      { exam: "calc-bc", select: "U:6", mastery: 0.8 },
      { exam: "calc-bc", select: "T:6.11-6.13", mastery: 0.5 },
    ]);
    assert.equal(model.topics["calc-bc:6.1"].mastery, 0.8);
    assert.equal(model.topics["calc-bc:6.12"].mastery, 0.5);
  });
});

describe("planner", () => {
  const model = newModel();
  applyPriors(model, curricula, [{ exam: "calc-bc", select: "U:1", mastery: 0.8 }]);

  it("never plans more than 30 minutes, every day from Nov 24 to May 10", () => {
    const history = [];
    for (let d = "2026-11-24"; d <= "2027-05-10"; d = addDays(d, 1)) {
      const plan = planDay({ date: d, curricula, calendar, model, history });
      assert.ok(plan.minutes <= DAILY_MINUTES + 0.5, `${d} planned ${plan.minutes}`);
      history.unshift(plan);
      if (history.length > 14) history.pop();
    }
  });

  it("runs one diagnostic per exam in the first week", () => {
    const seen = DIAGNOSTIC_DAYS.map((d) => planDay({ date: d.date, curricula, calendar, model }));
    assert.deepEqual(new Set(seen.map((p) => p.focusExam)), new Set(EXAM_IDS));
    for (const p of seen) assert.equal(p.mode, "diagnostic");
  });

  it("splits a normal day into one focus block and review", () => {
    const plan = planDay({ date: "2026-12-02", curricula, calendar, model, history: [] });
    assert.equal(plan.mode, "learn");
    assert.equal(plan.blocks[0].kind, "learn");
    assert.ok(plan.blocks[0].minutes >= 15);
    assert.ok(plan.blocks.slice(1).every((b) => b.kind === "review"));
  });

  it("turns a heavy school day into review only", () => {
    const plan = planDay({ date: "2026-12-09", curricula, calendar, model, align: { heavyDay: true } });
    assert.equal(plan.mode, "review-only");
    assert.ok(plan.blocks.every((b) => b.kind === "review"));
  });

  it("skips dates Yan blocked", () => {
    const plan = planDay({ date: "2026-12-09", curricula, calendar, model, prefs: { skipDates: ["2026-12-09"] } });
    assert.equal(plan.mode, "skip");
    assert.equal(plan.minutes, 0);
  });

  it("does not pile up missed days", () => {
    const fresh = planDay({ date: "2027-01-20", curricula, calendar, model, history: [] });
    assert.ok(fresh.minutes <= DAILY_MINUTES + 0.5);
    assert.ok(fresh.blocks.length <= 5);
  });

  it("uses the final week for the nearest exam", () => {
    const plan = planDay({ date: "2027-04-28", curricula, calendar, model });
    assert.equal(plan.mode, "final-week");
    assert.equal(plan.focusExam, "physics-c-mech");
  });

  it("stops after the last exam", () => {
    assert.equal(planDay({ date: "2027-05-11", curricula, calendar, model }).mode, "done");
  });
});

describe("pace check", () => {
  it("moves 15 minutes toward an exam that is behind", () => {
    const model = newModel();
    const pace = paceCheck(calendar, model, "2027-01-17");
    const behind = EXAM_IDS.filter((e) => pace.exams[e].behindWeeks > 0);
    assert.ok(behind.length > 0);
    const total = EXAM_IDS.reduce((s, e) => s + pace.exams[e].minutes, 0);
    const base = EXAM_IDS.reduce((s, e) => s + calendar.weeklyMinutes[e], 0);
    assert.equal(total, base);
    for (const e of EXAM_IDS) assert.ok(pace.exams[e].minutes >= calendar.floorMinutes);
  });

  it("is a Sunday job", () => {
    assert.equal(weekday("2026-11-29"), 0);
  });
});

describe("ink", () => {
  it("decodes explicit and difference-encoded traces", () => {
    assert.deepEqual(decodeTrace("10 20, 12 24, 15 30"), [[10, 20], [12, 24], [15, 30]]);
    assert.deepEqual(decodeTrace("10 20, '2 '4, '1 '1"), [[10, 20], [12, 24], [13, 25]]);
    assert.deepEqual(decodeTrace("0 0, '1 '1, \"0 \"0"), [[0, 0], [1, 1], [2, 2]]);
  });

  it("maps himetric strokes onto a placed page image and into a box", () => {
    const himetric = (px) => Math.round(px / HIMETRIC_TO_PX);
    const inkml = `<inkml:ink><inkml:definitions><inkml:brush xml:id="b1"><inkml:brushProperty name="width" value="26"/><inkml:brushProperty name="color" value="#000000"/></inkml:brush><inkml:brush xml:id="w"><inkml:brushProperty name="color" value="#FFFFFF"/></inkml:brush></inkml:definitions>
<inkml:trace brushRef="#b1">${himetric(148)} ${himetric(296)}, ${himetric(158)} ${himetric(300)}</inkml:trace>
<inkml:trace brushRef="#w">${himetric(148)} ${himetric(296)}, ${himetric(158)} ${himetric(300)}</inkml:trace></inkml:ink>`;
    const { traces } = parseInkml(inkml);
    assert.equal(traces.length, 1);
    const image = { left: 48, top: 96, width: 816, height: 1056 };
    const strokes = strokesOnImage(traces, image);
    assert.equal(strokes.length, 1);
    assert.ok(Math.abs(strokes[0].points[0][0] - 100) < 0.1);
    assert.ok(Math.abs(strokes[0].points[0][1] - 200) < 0.1);
    assert.equal(strokesInBox(strokes, { x: 90, y: 190, width: 40, height: 20 }).length, 1);
    assert.equal(strokesInBox(strokes, { x: 300, y: 190, width: 40, height: 20 }).length, 0);
  });

  it("splits the multipart page body", () => {
    const body = `--b1\r\nContent-Type: text/html\r\n\r\n<html>x</html>\r\n--b1\r\nContent-Type: application/inkml+xml\r\n\r\n<inkml:ink/>\r\n--b1--`;
    const { html, inkml } = splitInkMultipart(body, 'multipart/mixed; boundary="b1"');
    assert.equal(html, "<html>x</html>");
    assert.equal(inkml, "<inkml:ink/>");
  });
});

describe("packet", () => {
  const raw = {
    title: "T",
    sections: [
      {
        exam: "physics-2",
        kind: "learn",
        learn: [{ topic: "physics-2:9.2", title: "Gas law", body: "x" }],
        items: [
          { id: "q1", topic: "physics-2:9.2", type: "mcq", prompt: "p", choices: ["a", "b"], answer: "A" },
          { id: "q2", topic: "physics-2:9.2", type: "frq", prompt: "p", parts: [{ label: "a", prompt: "x", points: 2, answer: "y" }] },
        ],
      },
    ],
  };

  it("normalizes items and strips scripts from SVG", () => {
    const p = normalizePacket(raw);
    assert.equal(p.sections[0].items.length, 2);
    assert.equal(p.sections[0].items[1].parts[0].label, "a");
    assert.ok(!sanitizeSvg('<svg><script>alert(1)</script><line onload="x()"/></svg>').includes("script"));
    assert.ok(!sanitizeSvg('<svg><line onload="x()"/></svg>').includes("onload"));
    assert.ok(richText("**b** and *i*").includes("<strong>b</strong>"));
  });

  it("flags plan topics the writer missed", () => {
    const plan = { blocks: [{ topics: [{ key: "physics-2:9.2" }, { key: "physics-2:9.3" }] }] };
    const warnings = checkPacketAgainstPlan(normalizePacket(raw), plan);
    assert.deepEqual(warnings, ["plan topic physics-2:9.3 has no item"]);
  });

  it("marks items with no ink as skipped no matter what the grader said", () => {
    const packet = normalizePacket(raw);
    const grade = normalizeGrade(
      {
        items: [
          { id: "q1", points: 1, earned: 1, score: 1 },
          { id: "q2", points: 2, earned: 2, score: 1 },
        ],
      },
      packet,
      index,
      [
        { item: "q1", part: "", strokes: 4 },
        { item: "q2", part: "a", strokes: 0 },
      ]
    );
    assert.equal(grade.status, "graded");
    assert.equal(grade.items.find((i) => i.id === "q1").score, 1);
    assert.equal(grade.items.find((i) => i.id === "q2").skipped, true);
    assert.deepEqual(grade.learnTopicsSeen, ["physics-2:9.2"]);
  });

  it("parses JSON out of fenced model text", () => {
    assert.deepEqual(parseJsonLoose('Here:\n```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLoose('x {"b":2} y'), { b: 2 });
    assert.equal(parseJsonLoose("nope"), null);
  });
});

describe("school alignment", () => {
  it("drops topic keys that do not belong to the exam", () => {
    const a = normalizeAlign({ heavyDay: 1, exams: { lit: { reinforce: ["lit:2.FIG", "calc-bc:1.1", "lit:nope"] } } }, index);
    assert.equal(a.heavyDay, true);
    assert.deepEqual(a.exams.lit.reinforce, ["lit:2.FIG"]);
  });

  it("tells tests from homework", () => {
    assert.equal(looksLikeTest({ tag: "MA", name: "60 minute in-class exam" }), true);
    assert.equal(looksLikeTest({ tag: "QA", name: "Reading Quiz #4" }), true);
    assert.equal(looksLikeTest({ tag: "HW", name: "Review for Final Exam" }), false);
    assert.equal(looksLikeTest({ tag: "MA", name: "Motion Research Symposium" }), false);
  });

  it("calls two tests in two days a heavy day without the model", () => {
    const todos = {
      a: { exams: ["us-history"], todos: [{ due: "2026-12-10", tag: "QA", name: "Quiz 5" }] },
      b: { exams: ["calc-bc"], todos: [{ due: "2026-12-11", tag: "MA", name: "Unit test" }] },
    };
    const a = fallbackAlign(todos, "2026-12-10");
    assert.equal(a.heavyDay, true);
    assert.equal(a.exams["us-history"].schoolTest, true);
  });

  it("formats short dates", () => {
    assert.equal(shortDate("2026-11-24"), "Tue Nov 24");
  });
});

describe("overrides", () => {
  it("marks a topic he already knows as introduced", () => {
    const model = newModel();
    markKnown(model, "calc-bc:10.1", "2026-12-01");
    assert.equal(model.topics["calc-bc:10.1"].introducedAt, "2026-12-01");
    assert.ok(model.topics["calc-bc:10.1"].mastery >= 0.85);
    assert.equal(model.topics["calc-bc:10.1"].reviewsAfterIntro, 2);
  });

  it("gives a boosted exam the focus block", () => {
    const date = "2026-12-08";
    const boosted = planDay({
      date,
      curricula,
      calendar,
      model: newModel(),
      prefs: { boost: { exam: "lit", until: "2026-12-31" } },
    });
    assert.equal(boosted.focusExam, "lit");
  });

  it("inserts the briefing card after the recap", () => {
    const todo = { capsules: [{ id: "agent-recap" }, { id: "story" }, { id: "ap-study", body: "old" }] };
    assert.equal(insertApStudyCapsule(todo, { id: "ap-study", body: "new" }), true);
    assert.deepEqual(
      todo.capsules.map((c) => c.id),
      ["agent-recap", "ap-study", "story"]
    );
    assert.equal(todo.capsules[1].body, "new");
  });
});
