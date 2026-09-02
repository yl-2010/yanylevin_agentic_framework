import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canvasDueSoonCount,
  formatCanvasAssignmentsMarkdown,
  canvasConfig,
  localDueParts,
  nextCanvasSyncAt,
  CANVAS_SYNC_MODEL_SPEC,
  dashboardClassMatchesCanvasCourse,
  snapshotHasDashboardClass,
  selectDashboardCanvasCourses,
  filterCanvasSnapshotToDashboard,
  buildCanvasSyncPrompt,
} from "./canvas-sync.js";
import {
  contextSynthesisHm,
  chatTitleRefreshHm,
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

describe("canvas sync model", () => {
  it("uses grok-4.6 high with fast off", () => {
    assert.equal(CANVAS_SYNC_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(CANVAS_SYNC_MODEL_SPEC.params, [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
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
      contextSynthesisHm({ contextSynthesisLocalTime: "02:30" }),
      "02:30"
    );
    assert.equal(
      brainProjectionHm({ brainProjectionLocalTime: "03:00" }),
      "03:00"
    );
    assert.equal(nightlyAgentsHm({}), "01:00");
    assert.equal(chatTitleRefreshHm({}), "01:30");
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
  });
});
