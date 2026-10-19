import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
  buildCanvasHourlyPrompt,
  shouldSkipCanvasHourly,
  nextCanvasHourlyAt,
  canvasHourKey,
  applyPlannerOverrides,
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
  it("uses grok-4.7 xhigh with fast off", () => {
    assert.equal(CANVAS_SYNC_MODEL_SPEC.id, "grok-4.7");
    assert.deepEqual(CANVAS_SYNC_MODEL_SPEC.params, [
      { id: "context", value: "256k" },
      { id: "reasoning_effort", value: "xhigh" },
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
    assert.match(prompt, /Do not recreate a todo or date that looks like a manually deleted\.md row/);
    assert.match(prompt, /classes\/lit\/todos\/essay/);
    assert.match(prompt, /last-hourly-sync/);
    assert.match(prompt, /Fix mistakes/);
    assert.match(prompt, /comments-new\.md/);
    assert.match(prompt, /pages\.md/);
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
    assert.match(prompt, /add linkedFiles on this todo/);
    assert.match(prompt, /Do not copy the file/);
  });
});

describe("buildCanvasHourlyPrompt", () => {
  it("stays on mapped classes and does not hunt for new ones", () => {
    const prompt = buildCanvasHourlyPrompt({
      dateKey: "2026-09-14",
      hourKey: "2026-09-14T15",
      timezone: "America/Los_Angeles",
      deletedBlock: "Manually deleted objects (deleted.md).",
    });
    assert.match(prompt, /hourly pass/);
    assert.match(prompt, /Do not look for new classes/);
    assert.match(prompt, /Do not edit course-map\.json/);
    assert.match(prompt, /NEVER write done/);
    assert.match(prompt, /Do not fold Canvas comments/);
    assert.match(prompt, /Do not run link-todos/);
    assert.match(prompt, /Do not edit linkedFiles/);
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
