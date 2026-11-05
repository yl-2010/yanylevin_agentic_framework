import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canvasIdBlocksMatch,
  computeDue,
  inferTag,
  folderDueConflicts,
  folderNameMatchesTodo,
} from "./canvas-hourly-apply.js";
import {
  canvasDueSoonCount,
  courseScores,
  formatCanvasAssignmentsMarkdown,
  canvasConfig,
  localDueParts,
  nextCanvasSyncAt,
  nextCanvasSyncRetryAt,
  lockPidIsAlive,
  canvasLockIsBlocking,
  CANVAS_LOCK_STALE_MS,
  CANVAS_LOCK_RETRY_MS,
  CANVAS_SYNC_MODEL_SPEC,
  CANVAS_HOURLY_MODEL_SPEC,
  dashboardClassMatchesCanvasCourse,
  snapshotHasDashboardClass,
  selectDashboardCanvasCourses,
  filterCanvasSnapshotToDashboard,
  buildCanvasSyncPrompt,
  buildCanvasNewAssignmentPrompt,
  newCanvasAssignments,
  normalizeAssignmentIds,
  nextCanvasWatchAt,
  canvasWatchChanged,
  CANVAS_WATCH_INTERVAL_MS,
  shouldSkipCanvasHourly,
  nextCanvasHourlyAt,
  canvasHourKey,
  applyPlannerOverrides,
  canvasHtmlToMarkdown,
  canvasDescriptionUpdate,
  formatAssignmentDescription,
} from "./canvas-sync.js";
import {
  contextSynthesisHm,
  chatTitleRefreshHm,
  lifeStateCleanupHm,
  nightlyAgentsHm,
  brainProjectionHm,
} from "./daily-briefing-agent.js";

describe("canvasDueSoonCount", () => {
  it("counts assignments in the next 48h", () => {
    const now = new Date("2026-08-16T18:00:00.000Z");
    const n = canvasDueSoonCount(
      {
        assignments: [
          { title: "Essay", dueAt: "2026-08-17T20:00:00.000Z" },
          { title: "Quiz", dueAt: "2026-08-20T20:00:00.000Z" },
          { title: "Old", dueAt: "2026-08-01T20:00:00.000Z" },
        ],
      },
      48,
      now
    );
    assert.equal(n, 1);
  });

  it("returns 0 without a snapshot", () => {
    assert.equal(canvasDueSoonCount(null), 0);
  });
});

describe("courseScores", () => {
  it("ignores final_score when Canvas current is still n/a", () => {
    const scores = courseScores({
      enrollments: [
        {
          type: "StudentEnrollment",
          grades: {
            current_score: null,
            current_grade: null,
            final_score: 12,
            final_grade: "F",
          },
        },
      ],
    });
    assert.equal(scores.currentScore, null);
    assert.equal(scores.grade, "");
  });

  it("keeps the current percent and does not fall through to final F", () => {
    const scores = courseScores({
      enrollments: [
        {
          type: "student",
          grades: {
            current_score: 100,
            current_grade: "A",
            final_score: 1.6,
            final_grade: "F",
          },
        },
      ],
    });
    assert.equal(scores.currentScore, 100);
    assert.equal(scores.grade, "A");
  });

  it("reads computed_current_score when grades is missing", () => {
    const scores = courseScores({
      enrollments: [
        {
          type: "student",
          computed_current_score: null,
          computed_final_score: 12,
          computed_current_grade: null,
          computed_final_grade: "F",
        },
      ],
    });
    assert.equal(scores.currentScore, null);
    assert.equal(scores.grade, "");
  });
});

describe("formatCanvasAssignmentsMarkdown", () => {
  it("lists assignments with canvas ids and does not copy done state", () => {
    const md = formatCanvasAssignmentsMarkdown(
      {
        updatedAt: "2026-08-16T18:00:00.000Z",
        timezone: "America/Chicago",
        assignments: [
          {
            id: 2,
            title: "Essay",
            dueAt: "2026-08-18T06:59:00.000Z",
            dueDate: "2026-08-18",
            dueTime: "01:59",
            course: "American Literature",
            htmlUrl: "https://canvas.instructure.com/courses/1/assignments/2",
          },
        ],
        courses: [{ id: 1, name: "American Literature", grade: "A" }],
      },
      { now: new Date("2026-08-16T18:00:00.000Z") }
    );
    assert.match(md, /Essay/);
    assert.match(md, /American Literature/);
    assert.match(md, /canvasId 2/);
    assert.match(md, /Never copy done/);
    assert.doesNotMatch(md, /Do not auto-create education todos/);
  });

  it("notes dropped enrollments that are not dashboard classes", () => {
    const md = formatCanvasAssignmentsMarkdown(
      {
        updatedAt: "2026-08-16T18:00:00.000Z",
        timezone: "America/Chicago",
        skippedCourseCount: 43,
        courses: [],
        assignments: [],
      },
      { now: new Date("2026-08-16T18:00:00.000Z") }
    );
    assert.match(md, /Dropped 43 Canvas enrollments/);
    assert.match(md, /\(none\)/);
  });
});

describe("localDueParts", () => {
  it("converts an ISO instant into a zoned date and time", () => {
    const parts = localDueParts("2026-08-18T06:59:00.000Z", "America/Chicago");
    assert.equal(parts.dueDate, "2026-08-18");
    assert.equal(parts.dueTime, "01:59");
  });
});

describe("canvasConfig", () => {
  it("is off without a token", () => {
    const prev = process.env.CANVAS_ACCESS_TOKEN;
    delete process.env.CANVAS_ACCESS_TOKEN;
    try {
      assert.equal(canvasConfig().configured, false);
    } finally {
      if (prev != null) process.env.CANVAS_ACCESS_TOKEN = prev;
    }
  });
});

describe("nextCanvasSyncAt", () => {
  it("schedules 01:00 in the briefing timezone", () => {
    const when = nextCanvasSyncAt(
      { timezone: "America/Chicago", nightlyAgentsLocalTime: "01:00" },
      new Date("2026-08-16T20:00:00-05:00")
    );
    assert.equal(when.toISOString(), "2026-08-17T06:00:00.000Z");
  });
});

describe("canvas lock", () => {
  it("treats a missing or dead pid as not alive", () => {
    assert.equal(lockPidIsAlive(""), false);
    assert.equal(lockPidIsAlive("0"), false);
    assert.equal(
      lockPidIsAlive("99999", () => {
        const err = new Error("no process");
        err.code = "ESRCH";
        throw err;
      }),
      false
    );
  });

  it("treats EPERM as alive", () => {
    assert.equal(
      lockPidIsAlive("1", () => {
        const err = new Error("denied");
        err.code = "EPERM";
        throw err;
      }),
      true
    );
    assert.equal(
      lockPidIsAlive("12", () => undefined),
      true
    );
    assert.equal(lockPidIsAlive(process.pid), true);
  });

  it("does not block on a dead pid even when mtime is fresh", () => {
    const now = 1_000_000;
    assert.equal(
      canvasLockIsBlocking({
        pid: "99999",
        mtimeMs: now,
        nowMs: now,
        pidAlive: false,
      }),
      false
    );
  });

  it("blocks a live pid until the lock is stale", () => {
    const now = 1_000_000;
    assert.equal(
      canvasLockIsBlocking({
        pid: "12",
        mtimeMs: now,
        nowMs: now,
        pidAlive: true,
      }),
      true
    );
    assert.equal(
      canvasLockIsBlocking({
        pid: "12",
        mtimeMs: now - CANVAS_LOCK_STALE_MS - 1,
        nowMs: now,
        pidAlive: true,
      }),
      false
    );
  });
});

describe("nextCanvasSyncRetryAt", () => {
  it("retries in 3 minutes after an in-flight skip", () => {
    const now = new Date("2026-09-18T08:00:00.000Z");
    const when = nextCanvasSyncRetryAt(
      { reason: "in-flight" },
      { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" },
      now
    );
    assert.equal(when.getTime() - now.getTime(), CANVAS_LOCK_RETRY_MS);
  });

  it("stays on the next 01:00 for other results", () => {
    const now = new Date("2026-09-18T08:05:00.000Z");
    const when = nextCanvasSyncRetryAt(
      { reason: "already-synced" },
      { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" },
      now
    );
    assert.equal(when.toISOString(), "2026-09-19T08:00:00.000Z");
  });
});

describe("canvas sync model", () => {
  it("uses grok-4.7 high with fast off", () => {
    assert.equal(CANVAS_SYNC_MODEL_SPEC.id, "grok-4.7");
    assert.deepEqual(CANVAS_SYNC_MODEL_SPEC.params, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });
});

describe("canvas hourly model", () => {
  it("uses composer-2.5 with fast off", () => {
    assert.equal(CANVAS_HOURLY_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(CANVAS_HOURLY_MODEL_SPEC.params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("shouldSkipCanvasHourly", () => {
  it("skips the 01:00 nightly window", () => {
    const meta = { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" };
    assert.equal(
      shouldSkipCanvasHourly(meta, new Date("2026-09-14T08:00:00.000Z")),
      true
    );
    assert.equal(
      shouldSkipCanvasHourly(meta, new Date("2026-09-14T07:50:00.000Z")),
      true
    );
    assert.equal(
      shouldSkipCanvasHourly(meta, new Date("2026-09-14T16:00:00.000Z")),
      false
    );
  });
});

describe("nextCanvasHourlyAt", () => {
  it("schedules the next round hour in the briefing timezone", () => {
    const meta = { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" };
    const when = nextCanvasHourlyAt(
      meta,
      new Date("2026-09-14T16:10:00.000Z")
    );
    assert.equal(when.toISOString(), "2026-09-14T17:00:00.000Z");
  });

  it("jumps past the 01:00 nightly slot", () => {
    const meta = { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" };
    const when = nextCanvasHourlyAt(
      meta,
      new Date("2026-09-14T07:30:00.000Z")
    );
    assert.equal(when.getUTCHours(), 9);
    assert.equal(when.getUTCMinutes(), 0);
  });
});

describe("nextCanvasWatchAt", () => {
  it("polls again in 30 seconds", () => {
    const meta = { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" };
    const now = new Date("2026-09-14T16:10:00.000Z");
    const when = nextCanvasWatchAt(meta, now);
    assert.equal(when.getTime() - now.getTime(), CANVAS_WATCH_INTERVAL_MS);
  });

  it("waits out the 01:00 nightly window", () => {
    const meta = { timezone: "America/Los_Angeles", nightlyAgentsLocalTime: "01:00" };
    const when = nextCanvasWatchAt(meta, new Date("2026-09-14T07:55:00.000Z"));
    assert.equal(shouldSkipCanvasHourly(meta, when), false);
    assert.ok(when.getTime() > new Date("2026-09-14T08:20:00.000Z").getTime());
  });
});

describe("canvasWatchChanged", () => {
  it("ignores score changes and notices a new assignment", () => {
    const prev = [{ id: 1, title: "HW 1", dueDate: "2026-10-01", dueTime: "13:50", htmlUrl: "https://x/1", pointsPossible: 5, types: ["online_upload"], score: 1 }];
    const scored = [{ ...prev[0], score: 4, workflowState: "graded" }];
    assert.equal(canvasWatchChanged(prev, scored), false);
    assert.equal(canvasWatchChanged(prev, [...prev, { id: 2, title: "HW 2" }]), true);
    assert.equal(canvasWatchChanged(prev, [{ ...prev[0], dueDate: "2026-10-02" }]), true);
  });
});

describe("canvasHourKey", () => {
  it("is a date plus hour in the briefing timezone", () => {
    const key = canvasHourKey(
      { timezone: "America/Los_Angeles" },
      new Date("2026-09-14T16:10:00.000Z")
    );
    assert.equal(key, "2026-09-14T09");
  });
});

describe("shared nightly clocks", () => {
  it("reads 01:00, 01:30, 02:30, and 03:00 from meta with fallbacks", () => {
    assert.equal(
      nightlyAgentsHm({ nightlyAgentsLocalTime: "01:00" }),
      "01:00"
    );
    assert.equal(
      chatTitleRefreshHm({ chatTitleRefreshLocalTime: "01:30" }),
      "01:30"
    );
    assert.equal(
      lifeStateCleanupHm({ lifeStateCleanupLocalTime: "01:30" }),
      "01:30"
    );
    assert.equal(
      contextSynthesisHm({ contextSynthesisLocalTime: "02:30" }),
      "02:30"
    );
    assert.equal(
      brainProjectionHm({ brainProjectionLocalTime: "03:00" }),
      "03:00"
    );
    assert.equal(nightlyAgentsHm({}), "01:00");
    assert.equal(chatTitleRefreshHm({}), "01:30");
    assert.equal(lifeStateCleanupHm({}), "01:30");
    assert.equal(contextSynthesisHm({}), "02:30");
    assert.equal(brainProjectionHm({}), "03:00");
    assert.equal(nightlyAgentsHm({ nightlyAgentsLocalTime: "nope" }), "01:00");
  });
});

describe("dashboardClassMatchesCanvasCourse", () => {
  it("matches a published junior-year title with a term suffix", () => {
    assert.equal(
      dashboardClassMatchesCanvasCourse(
        "American Literature",
        "American Literature (Fall) 2026-27:jsmith"
      ),
      true
    );
  });

  it("does not treat prior-year Calculus as Advanced Calculus", () => {
    assert.equal(
      dashboardClassMatchesCanvasCourse(
        "Advanced Calculus",
        "Calculus (Fall) 2025-26:mstearns"
      ),
      false
    );
  });

  it("does not treat Spanish 3 as Spanish 4", () => {
    assert.equal(
      dashboardClassMatchesCanvasCourse("Spanish 4", "Spanish 3 (Fall) 2025-26:eferguson"),
      false
    );
  });
});

describe("snapshotHasDashboardClass", () => {
  it("is false for the current pre-junior Canvas catalog", () => {
    assert.equal(
      snapshotHasDashboardClass(
        {
          courses: [
            { name: "Class of 2028" },
            { name: "EPS Library" },
            { name: "Graphic Design 1 (Fall) 2025-26:yhendrix" },
            { name: "Iceland EBC" },
            { name: "Calculus (Fall) 2025-26:mstearns" },
          ],
        },
        [
          "American Literature",
          "Physics",
          "Spanish 4",
          "Data Science 1",
          "United States History: The American Question",
          "Advanced Calculus",
        ]
      ),
      false
    );
  });
});

describe("filterCanvasSnapshotToDashboard", () => {
  const classNames = [
    "American Literature",
    "Physics",
    "Spanish 4",
    "Advanced Calculus",
  ];

  it("keeps a published junior-year course and drops prior-year shells", () => {
    const { keep, skip } = selectDashboardCanvasCourses(
      [
        { id: 1, name: "American Literature (Fall) 2026-27:jsmith" },
        { id: 2, name: "Calculus (Fall) 2025-26:mstearns" },
        { id: 3, name: "Class of 2028" },
        { id: 4, name: "EPS Library" },
      ],
      classNames
    );
    assert.deepEqual(
      keep.map((c) => c.id),
      [1]
    );
    assert.equal(skip.length, 3);
  });

  it("keeps a project-mapped course that is not a class", () => {
    const { keep, skip } = selectDashboardCanvasCourses(
      [
        { id: 1, name: "American Literature (Fall) 2026-27:jsmith" },
        { id: 3659529, name: "College Counseling 2028" },
        { id: 3, name: "Class of 2028" },
      ],
      classNames,
      [3659529]
    );
    assert.deepEqual(
      keep.map((c) => c.id),
      [1, 3659529]
    );
    assert.equal(skip.length, 1);
  });

  it("strips assignments and events for dropped courses", () => {
    const slim = filterCanvasSnapshotToDashboard(
      {
        courses: [
          { id: 10, name: "Physics (Fall) 2026-27:mtavarez" },
          { id: 11, name: "Spanish 3 (Fall) 2025-26:eferguson" },
        ],
        assignments: [
          { courseId: 10, title: "Lab" },
          { courseId: 11, title: "Old quiz" },
        ],
        events: [
          { courseId: 10, title: "Test" },
          { courseId: 11, title: "Concert" },
        ],
      },
      classNames
    );
    assert.equal(slim.skippedCourseCount, 1);
    assert.deepEqual(
      slim.courses.map((c) => c.id),
      [10]
    );
    assert.deepEqual(
      slim.assignments.map((a) => a.title),
      ["Lab"]
    );
    assert.deepEqual(
      slim.events.map((e) => e.title),
      ["Test"]
    );
  });
});

describe("buildCanvasSyncPrompt", () => {
  it("tells the agent to skip deleted.md rows", () => {
    const prompt = buildCanvasSyncPrompt({
      dateKey: "2026-08-25",
      timezone: "America/Chicago",
      force: false,
      deletedBlock:
        "Manually deleted objects (deleted.md).\n- deleted 2026-08-25 15:04 | todo | Essay | on 2026-09-12 | class:lit | was classes/lit/todos/essay",
    });
    assert.match(prompt, /personal-canvas/);
    assert.match(prompt, /class\.json canvasLink to that course gradebook/);
    assert.match(prompt, /project:college-prep/);
    assert.match(prompt, /Do not create a class for that course/);
    assert.match(prompt, /Do not recreate a todo or date that looks like a manually deleted\.md row/);
    assert.match(prompt, /classes\/lit\/todos\/essay/);
    assert.match(prompt, /last-hourly-sync/);
    assert.match(prompt, /Fix mistakes/);
    assert.match(prompt, /40440348/);
    assert.match(prompt, /40468349/);
    assert.match(prompt, /40476875/);
    assert.match(prompt, /stays HW/);
    assert.match(prompt, /2026-10-29 12:25/);
    assert.match(prompt, /comments-new\.md/);
    assert.match(prompt, /pages\.md/);
    assert.match(prompt, /40291676/);
    assert.match(prompt, /40291677/);
    assert.match(prompt, /2026-11-20 10:30/);
    assert.match(prompt, /Tag does not matter/);
    assert.match(prompt, /Pass 1:/);
    assert.match(prompt, /Pass 2:/);
    assert.match(prompt, /14 days out/);
    assert.match(prompt, /onenote-seen\.json/);
    assert.match(prompt, /personal-onenote/);
    assert.match(prompt, /signed-out status means run login/);
    assert.match(prompt, /2026-10-08/);
    assert.equal(/hunt for a todo/.test(prompt), false);
    assert.equal(/skip both passes/.test(prompt), false);
    assert.equal(/signed out or a notebook fails/.test(prompt), false);
    assert.match(prompt, /Do not run link-todos/);
    assert.match(prompt, /oneNote content-library/);
    assert.match(prompt, /Set main true on exactly one OneNote site/);
    assert.match(prompt, /add linkedFiles on this todo/);
    assert.match(prompt, /Do not copy the file/);
  });
});

describe("newCanvasAssignments", () => {
  it("returns only ids the watch has not seen", () => {
    const rows = [
      { id: 1, title: "Old" },
      { id: 2, title: "New" },
    ];
    assert.deepEqual(
      newCanvasAssignments(["1"], rows).map((row) => row.id),
      [2]
    );
    assert.equal(newCanvasAssignments(["1", "2"], rows).length, 0);
    assert.deepEqual(normalizeAssignmentIds([2, "2", 10, 1]), ["1", "2", "10"]);
  });
});

describe("buildCanvasNewAssignmentPrompt", () => {
  it("names only the new assignments and does not walk the snapshot", () => {
    const prompt = buildCanvasNewAssignmentPrompt({
      dateKey: "2026-09-14",
      hourKey: "2026-09-14T15",
      timezone: "America/Los_Angeles",
      assignments: [
        {
          id: 40440347,
          courseId: 3639000,
          course: "Advanced Calculus",
          title: "HW: Day 12 problem set",
          dueDate: "2026-10-21",
          dueTime: "09:55",
          htmlUrl: "https://canvas.instructure.com/courses/3639000/assignments/40440347",
          pointsPossible: 10,
          types: ["online_upload"],
          description: "<p>Do the set.</p>",
        },
      ],
    });
    assert.match(prompt, /new assignment pass/);
    assert.match(prompt, /40440347/);
    assert.match(prompt, /already created the todo/);
    assert.match(prompt, /Do not open snapshot\.json/);
    assert.match(prompt, /Do not run OneNote pass 1 or pass 2/);
    assert.match(prompt, /Do not rewrite onenote-seen\.json/);
    assert.match(prompt, /this todo only/);
    assert.match(prompt, /Do not look for new classes/);
    assert.match(prompt, /Do not edit course-map\.json/);
    assert.match(prompt, /Do not fold Canvas comments/);
    assert.match(prompt, /Do not run link-todos/);
    assert.equal(/Create todos only/.test(prompt), false);
    assert.equal(/For every snapshot assignment/.test(prompt), false);
  });
});

describe("applyPlannerOverrides", () => {
  it("keeps a checkoff that has aged out of the two-week planner feed", () => {
    const assignments = [
      { id: 40283613, title: "Indigenous America", plannerComplete: false, plannerOverrideId: "" },
      { id: 99, title: "still open", plannerComplete: false, plannerOverrideId: "" },
    ];
    const saved = applyPlannerOverrides(assignments, [
      {
        id: 39889256,
        plannable_type: "assignment",
        plannable_id: 40283613,
        marked_complete: true,
      },
      {
        id: 1,
        plannable_type: "announcement",
        plannable_id: 99,
        marked_complete: true,
      },
    ]);
    assert.equal(assignments[0].plannerComplete, true);
    assert.equal(assignments[0].plannerOverrideId, "39889256");
    assert.equal(assignments[1].plannerComplete, false);
    assert.deepEqual(saved, [["40283613", "39889256"]]);
  });

  it("clears plannerComplete when the override is unchecked", () => {
    const assignments = [
      { id: 5, plannerComplete: true, plannerOverrideId: "9" },
    ];
    applyPlannerOverrides(assignments, [
      {
        id: 9,
        plannable_type: "assignment",
        plannable_id: 5,
        marked_complete: false,
      },
    ]);
    assert.equal(assignments[0].plannerComplete, false);
    assert.equal(assignments[0].plannerOverrideId, "9");
  });
});

describe("inferTag", () => {
  it("uses the highest title tag and does not fall through to points", () => {
    assert.equal(
      inferTag({
        title: "[CW/HW] Breast Cancer Prediction",
        pointsPossible: 30,
        types: ["online_upload"],
      }),
      "HW"
    );
    assert.equal(
      inferTag({
        title: "CW/HW: Comparing Motion Diagrams",
        pointsPossible: 1,
        types: ["online_upload"],
      }),
      "HW"
    );
    assert.equal(
      inferTag({ title: "Lab report", pointsPossible: 20, types: [] }),
      "MA"
    );
    assert.equal(
      inferTag({
        id: 40468349,
        title: "SP1 presentation problem",
        pointsPossible: 0,
        types: [],
      }),
      "HW"
    );
    assert.equal(
      inferTag({
        id: 40476875,
        title: "Independent Research Project - Preliminary Data Collection and Analysis",
        pointsPossible: 20,
        types: ["online_upload"],
      }),
      "HW"
    );
  });
});

describe("computeDue", () => {
  it("keeps the physics symposium on the period H final", () => {
    assert.deepEqual(
      computeDue({ id: 40291677, dueDate: "", dueTime: "" }, "physics", null, null),
      { dueDate: "2026-11-20", dueTime: "10:30" }
    );
    assert.deepEqual(
      computeDue(
        {
          id: 40468349,
          dueDate: "2026-11-04",
          dueTime: "23:59",
          title: "SP1 presentation problem",
        },
        "advanced-calculus",
        null,
        null
      ),
      { dueDate: "2026-11-04", dueTime: "12:25" }
    );
  });
});

describe("canvas assignment identity", () => {
  const today = {
    name: "Read and annotate the chapter, pp. 5-31. See details.",
    dueDate: "2026-10-30",
    canvasId: 101,
  };
  const journal = {
    name: "Read and annotate the chapter pp. 90-97, and Journal Entry 2",
    dueDate: "2026-11-05",
    canvasId: 102,
  };
  const todayFolder = "HW Oct 30 Read and annotate the chapter, pp. 5-31. See details.";
  const journalFolder = "HW Nov 5 Read and annotate the chapter pp. 90-97, and Journal Entry 2";

  it("does not treat a shared title prefix as the same assignment", () => {
    assert.equal(folderNameMatchesTodo(todayFolder, journal), false);
    assert.equal(folderNameMatchesTodo(journalFolder, today), false);
  });

  it("still matches a folder to its own assignment", () => {
    assert.equal(folderNameMatchesTodo(todayFolder, today), true);
    assert.equal(folderNameMatchesTodo(journalFolder, journal), true);
  });

  it("treats a different due day on the folder as a different assignment", () => {
    assert.equal(folderDueConflicts(todayFolder, journal.dueDate), true);
    assert.equal(folderDueConflicts(journalFolder, today.dueDate), true);
    assert.equal(folderDueConflicts(todayFolder, today.dueDate), false);
  });

  it("refuses to move a todo onto a different canvas id", () => {
    assert.equal(canvasIdBlocksMatch({ canvasId: 101 }, 102), true);
    assert.equal(canvasIdBlocksMatch({ canvasId: 101 }, 101), false);
    assert.equal(canvasIdBlocksMatch({}, 102), false);
  });
});

describe("canvas assignment descriptions", () => {
  const walden = `<p><span>HW: Read and annotate Walden pp. 90-97 (Solitude chapter). </span><span>&nbsp;The annotations should again </span><span>be extensive.</span></p>
<p><strong>Entry 2: Focus on Sight</strong></p>
<p><strong>Task:</strong> Visit your area <strong>during the day</strong>.</p>
<ul><li>Take a picture.</li><li>Submit on Canvas.</li></ul>`;

  it("keeps paragraphs, bold, and lists", () => {
    const md = canvasHtmlToMarkdown(walden);
    assert.match(md, /^HW: Read and annotate Walden pp\. 90-97 \(Solitude chapter\)\. The annotations should again be extensive\./);
    assert.match(md, /\*\*Entry 2: Focus on Sight\*\*/);
    assert.match(md, /\*\*Task:\*\* Visit your area \*\*during the day\*\*\./);
    assert.match(md, /^- Take a picture\.\n- Submit on Canvas\./m);
    assert.equal(md.includes("<"), false);
  });

  it("pulls a bold marker back to the start of the word", () => {
    assert.equal(
      canvasHtmlToMarkdown("<p>Y<strong>ou are encouraged</strong> to bring notes.</p>"),
      "**You are encouraged** to bring notes."
    );
  });

  it("keeps the https link when Canvas jams an onenote url onto it", () => {
    const md = canvasHtmlToMarkdown(
      '<p>See <a href="https://example.com/doc&amp;end%20onenote:https://example.com/page">the book</a>.</p>'
    );
    assert.equal(md, "See [the book](https://example.com/doc).");
  });

  it("keeps links and does not flatten them", () => {
    const md = canvasHtmlToMarkdown(
      '<p>Complete the <a href="https://tinyurl.com/EPSAccommodations">scheduling form</a> at least two school days ahead.</p>'
    );
    assert.equal(
      md,
      "Complete the [scheduling form](https://tinyurl.com/EPSAccommodations) at least two school days ahead."
    );
  });

  it("keeps table cells", () => {
    const md = canvasHtmlToMarkdown(
      "<table><tr><th>Item</th><th>Points</th></tr><tr><td>Thesis</td><td>10</td></tr></table>"
    );
    assert.match(md, /\| Item \| Points \|/);
    assert.match(md, /\| Thesis \| 10 \|/);
  });

  it("turns a one-line copy into the formatted body", () => {
    const md = formatAssignmentDescription(walden);
    const flat = "HW: Read and annotate Walden pp. 90-97 (Solitude chapter). The annotations should again be extensive. Entry 2: Focus on Sight Task: Visit your area during the day. Take a picture. Submit on Canvas.";
    const next = canvasDescriptionUpdate(flat, md);
    assert.match(next, /\*\*Entry 2: Focus on Sight\*\*/);
    assert.match(next, /^- Take a picture\./m);
  });

  it("leaves a structured description that already has the Canvas sentences", () => {
    const md = "**Read** pp. 1 to 4.\n\nBring a pencil. This sentence is long enough to count as its own instruction.";
    const current = "**Read** pp. 1 to 4.\n\nBring a pencil. This sentence is long enough to count as its own instruction.\n\nLunstrum extended this by email.";
    assert.equal(canvasDescriptionUpdate(current, md), "");
  });

  it("keeps a unique sentence that shared a paragraph with the assignment", () => {
    const md =
      "This exam covers graphs of motion, constant acceleration, and forces. Bring a double-sided page of notes.";
    const current =
      "This exam covers graphs of motion, constant acceleration, and forces. The printed syllabus still says Oct 19 and 20.";
    const next = canvasDescriptionUpdate(current, md);
    assert.match(next, /graphs of motion/);
    assert.match(next, /printed syllabus still says Oct 19 and 20/);
  });

  it("restores missing Canvas text and keeps a line Canvas does not have", () => {
    const md = "Read pages 90 to 97 and annotate the solitude chapter in full.\n\n- Upload the photo.\n- Pitch it in class tomorrow morning.";
    const current = "**Short version.** Read pages 90 to 97.\n\nLunstrum extended this by email.";
    const next = canvasDescriptionUpdate(current, md);
    assert.match(next, /Upload the photo/);
    assert.match(next, /Lunstrum extended this by email/);
    assert.equal(next.includes("Short version"), false);
  });
});
