import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachCanvasComments,
  attachCanvasCompletion,
  attachCanvasGrades,
  assignmentLooksComplete,
  canvasCourseTerm,
  classGradebookCourse,
  courseMapTarget,
  formatAssignmentWork,
  formatCourseScoreLabel,
  trimScore,
} from "./canvas-grades.js";

describe("assignmentLooksComplete", () => {
  it("treats submitted, graded, excused, or a posted score as complete", () => {
    assert.equal(assignmentLooksComplete({ submittedAt: "2026-09-14T19:00:00Z" }), true);
    assert.equal(assignmentLooksComplete({ workflowState: "graded" }), true);
    assert.equal(assignmentLooksComplete({ excused: true }), true);
    assert.equal(assignmentLooksComplete({ score: 0 }), true);
    assert.equal(assignmentLooksComplete({ workflowState: "unsubmitted" }), false);
    assert.equal(assignmentLooksComplete({ plannerComplete: true }), true);
    assert.equal(assignmentLooksComplete({ markedComplete: true }), true);
  });
});

describe("attachCanvasCompletion", () => {
  it("overlays Canvas complete and incomplete, including uncheck", () => {
    const tree = {
      classes: [
        {
          id: "physics",
          todos: [
            { id: "lab", canvasId: 1, done: false },
            { id: "early", canvasId: 2, done: true, completedAt: "2026-09-10T01:00:00Z" },
            { id: "local", done: true, completedAt: "2026-09-10T01:00:00Z" },
          ],
        },
      ],
    };
    attachCanvasCompletion(tree, {
      assignments: [
        { id: 1, submittedAt: "2026-09-14T18:00:00Z", workflowState: "submitted" },
        { id: 2, workflowState: "unsubmitted" },
      ],
    });
    assert.equal(tree.classes[0].todos[0].done, true);
    assert.equal(tree.classes[0].todos[0].completedAt, "2026-09-14T18:00:00Z");
    assert.equal(tree.classes[0].todos[1].done, false);
    assert.equal(tree.classes[0].todos[1].completedAt, undefined);
    assert.equal(tree.classes[0].todos[2].done, true);
    assert.equal(tree.classes[0].todos[2].completedAt, "2026-09-10T01:00:00Z");
  });
});

describe("trimScore", () => {
  it("drops trailing zeros", () => {
    assert.equal(trimScore(8), "8");
    assert.equal(trimScore(8.5), "8.5");
    assert.equal(trimScore(94.25), "94.25");
  });
});

describe("formatCourseScoreLabel", () => {
  it("keeps decimals and adds a percent", () => {
    assert.equal(formatCourseScoreLabel(94.25), "94.25%");
    assert.equal(formatCourseScoreLabel(100), "100%");
    assert.equal(formatCourseScoreLabel(null), "");
  });
});

describe("formatAssignmentWork", () => {
  it("prefers a point fraction when graded", () => {
    assert.deepEqual(
      formatAssignmentWork({
        score: 8.5,
        pointsPossible: 10,
        workflowState: "graded",
      }),
      { display: "8.5/10", graded: true }
    );
  });

  it("falls back to percent, then letter", () => {
    assert.equal(
      formatAssignmentWork({ percent: 85, workflowState: "graded" }).display,
      "85%"
    );
    assert.equal(
      formatAssignmentWork({ grade: "A", workflowState: "graded" }).display,
      "A"
    );
  });

  it("shows /points when still open", () => {
    assert.deepEqual(formatAssignmentWork({ pointsPossible: 25 }), {
      display: "/25",
      graded: false,
    });
    assert.deepEqual(
      formatAssignmentWork({
        pointsPossible: 5,
        score: null,
        workflowState: "unsubmitted",
      }),
      { display: "/5", graded: false }
    );
  });

  it("keeps /points when Canvas says graded but posted no number", () => {
    assert.deepEqual(
      formatAssignmentWork({
        pointsPossible: 5,
        score: null,
        grade: "",
        workflowState: "graded",
      }),
      { display: "/5", graded: false }
    );
  });

  it("uses n/a when the assignment is worth nothing", () => {
    assert.deepEqual(formatAssignmentWork({ pointsPossible: 0 }), {
      display: "n/a",
      graded: false,
    });
    assert.deepEqual(formatAssignmentWork({}), {
      display: "n/a",
      graded: false,
    });
  });
});

describe("attachCanvasGrades", () => {
  it("paints class percent and todo work from snapshot ids", () => {
    const tree = {
      classes: [
        {
          id: "advanced-calculus",
          canvasLink: "https://canvas.instructure.com/courses/1/grades",
          todos: [
            {
              id: "hw-one",
              canvasId: 9,
              canvasLink:
                "https://canvas.instructure.com/courses/1/assignments/9",
            },
          ],
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [{ id: 1, currentScore: 97.5 }],
        assignments: [
          { id: 9, courseId: 1, score: 4, pointsPossible: 5, workflowState: "graded" },
        ],
      },
      { 1: "advanced-calculus" }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, "97.5%");
    assert.equal(tree.classes[0].todos[0].canvasWork.display, "4/5");
  });

  it("paints a project gradebook when the course map says project:", () => {
    const tree = {
      projects: [
        {
          id: "college-prep",
          todos: [{ id: "questionnaire", canvasId: 40394213 }],
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [{ id: 3659529, currentScore: 100 }],
        assignments: [
          {
            id: 40394213,
            courseId: 3659529,
            score: 10,
            pointsPossible: 10,
            workflowState: "graded",
          },
        ],
      },
      { 3659529: "project:college-prep" }
    );
    assert.equal(tree.projects[0].canvasScoreLabel, "100%");
    assert.equal(tree.projects[0].todos[0].canvasWork.display, "10/10");
    assert.deepEqual(courseMapTarget("project:college-prep"), {
      kind: "project",
      id: "college-prep",
    });
    assert.deepEqual(courseMapTarget("physics"), { kind: "class", id: "physics" });
  });

  it("hides a 0% course total when nothing is scored yet", () => {
    const tree = {
      classes: [{ id: "am-lit", canvasLink: "https://canvas.instructure.com/courses/2" }],
    };
    attachCanvasGrades(tree, {
      courses: [{ id: 2, currentScore: 0 }],
      assignments: [{ id: 1, courseId: 2, pointsPossible: 5, score: null }],
    });
    assert.equal(tree.classes[0].canvasScoreLabel, undefined);
  });

  it("hides a leftover final_score when Canvas current is still n/a", () => {
    const tree = {
      classes: [
        { id: "us-history", canvasLink: "https://canvas.instructure.com/courses/3" },
      ],
    };
    attachCanvasGrades(tree, {
      courses: [{ id: 3, currentScore: 12 }],
      assignments: [
        {
          id: 1,
          courseId: 3,
          score: 4,
          pointsPossible: 5,
          workflowState: "pending_review",
        },
      ],
    });
    assert.equal(tree.classes[0].canvasScoreLabel, undefined);
    assert.equal(tree.classes[0].canvasScore, undefined);
  });

  it("does not treat a null currentScore as 0%", () => {
    const tree = {
      classes: [
        { id: "us-history", canvasLink: "https://canvas.instructure.com/courses/3" },
      ],
    };
    attachCanvasGrades(tree, {
      courses: [{ id: 3, currentScore: null }],
      assignments: [
        { id: 1, courseId: 3, score: 4, pointsPossible: 5, workflowState: "graded" },
      ],
    });
    assert.equal(tree.classes[0].canvasScoreLabel, undefined);
  });

  it("uses only the current term for a year-long class grade", () => {
    const tree = {
      classes: [
        {
          id: "spanish-4",
          canvasLink: "https://canvas.instructure.com/courses/3638875/grades",
          todos: [
            {
              id: "fall-hw",
              canvasId: 11,
              canvasLink:
                "https://canvas.instructure.com/courses/3638875/assignments/11",
            },
            {
              id: "winter-hw",
              canvasId: 22,
              canvasLink:
                "https://canvas.instructure.com/courses/3638876/assignments/22",
            },
          ],
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [
          {
            id: 3638875,
            name: "Spanish 4 (Fall)",
            htmlUrl: "https://canvas.instructure.com/courses/3638875",
            currentScore: 97.44,
          },
          {
            id: 3638876,
            name: "Spanish 4 (Winter)",
            htmlUrl: "https://canvas.instructure.com/courses/3638876",
            currentScore: null,
          },
        ],
        assignments: [
          {
            id: 11,
            courseId: 3638875,
            score: 9,
            pointsPossible: 10,
            workflowState: "graded",
          },
          {
            id: 22,
            courseId: 3638876,
            score: null,
            pointsPossible: 10,
            workflowState: "unsubmitted",
          },
        ],
      },
      { 3638875: "spanish-4", 3638876: "spanish-4" },
      { term: "winter", termsByClass: { "spanish-4": ["year"] } }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, undefined);
    assert.equal(tree.classes[0].canvasScore, undefined);
    assert.equal(
      tree.classes[0].canvasLink,
      "https://canvas.instructure.com/courses/3638876/grades"
    );
    assert.equal(tree.classes[0].todos[0].canvasWork.display, "9/10");
    assert.equal(
      tree.classes[0].todos[0].canvasLink,
      "https://canvas.instructure.com/courses/3638875/assignments/11"
    );
    assert.equal(tree.classes[0].todos[1].canvasWork.display, "/10");
  });

  it("leaves the class grade blank when this term's course is not published", () => {
    const tree = {
      classes: [
        {
          id: "physics",
          canvasLink: "https://canvas.instructure.com/courses/3646086/grades",
          todos: [
            {
              id: "fall-lab",
              canvasId: 7,
              canvasLink:
                "https://canvas.instructure.com/courses/3646086/assignments/7",
            },
          ],
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [
          {
            id: 3646086,
            name: "Physics (Fall)",
            htmlUrl: "https://canvas.instructure.com/courses/3646086",
            currentScore: 98.58,
          },
        ],
        assignments: [
          {
            id: 7,
            courseId: 3646086,
            score: 18,
            pointsPossible: 20,
            workflowState: "graded",
          },
        ],
      },
      { 3646086: "physics" },
      { term: "winter", termsByClass: { physics: ["year"] } }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, undefined);
    assert.equal(tree.classes[0].canvasLink, undefined);
    assert.equal(tree.classes[0].todos[0].canvasWork.display, "18/20");
    assert.equal(
      tree.classes[0].todos[0].canvasLink,
      "https://canvas.instructure.com/courses/3646086/assignments/7"
    );
  });

  it("paints the winter percent once that course has a posted grade", () => {
    const tree = {
      classes: [
        {
          id: "american-literature",
          canvasLink: "https://canvas.instructure.com/courses/1/grades",
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [
          { id: 1, name: "American Literature (Fall)", currentScore: 96.91 },
          {
            id: 2,
            name: "American Literature (Winter)",
            htmlUrl: "https://canvas.instructure.com/courses/2",
            currentScore: 88,
          },
        ],
        assignments: [
          { id: 3, courseId: 1, score: 10, pointsPossible: 10, workflowState: "graded" },
          { id: 4, courseId: 2, score: 8, pointsPossible: 10, workflowState: "graded" },
        ],
      },
      { 1: "american-literature", 2: "american-literature" },
      { term: "winter", termsByClass: { "american-literature": ["year"] } }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, "88%");
    assert.equal(
      tree.classes[0].canvasLink,
      "https://canvas.instructure.com/courses/2/grades"
    );
  });

  it("does not retarget a trimester class that is out of season", () => {
    const tree = {
      classes: [
        {
          id: "data-science-1",
          canvasLink: "https://canvas.instructure.com/courses/3639020/grades",
        },
      ],
    };
    attachCanvasGrades(
      tree,
      {
        courses: [
          {
            id: 3639020,
            name: "Data Science 1 (Fall)",
            currentScore: 100,
          },
        ],
        assignments: [
          {
            id: 5,
            courseId: 3639020,
            score: 10,
            pointsPossible: 10,
            workflowState: "graded",
          },
        ],
      },
      { 3639020: "data-science-1" },
      { term: "winter", termsByClass: { "data-science-1": ["fall"] } }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, "100%");
    assert.equal(
      tree.classes[0].canvasLink,
      "https://canvas.instructure.com/courses/3639020/grades"
    );
  });
});

describe("classGradebookCourse", () => {
  it("reads the term out of the Canvas title", () => {
    assert.equal(canvasCourseTerm("United States History (Fall 2026)"), "fall");
    assert.equal(canvasCourseTerm("Spanish 4 (Winter)"), "winter");
    assert.equal(canvasCourseTerm("College Counseling 2028"), null);
  });

  it("skips a class that is not in this term", () => {
    const courses = [{ id: 1, name: "P.E. Yoga (US) (Fall)" }];
    assert.deepEqual(classGradebookCourse(courses, "winter", ["fall", "spring"]), {
      skip: true,
      absent: false,
      course: null,
    });
  });

  it("clears a year-long class until the current term's course exists", () => {
    const courses = [{ id: 1, name: "Physics (Fall)", currentScore: 98 }];
    assert.equal(classGradebookCourse(courses, "winter", ["year"]).absent, true);
    assert.equal(
      classGradebookCourse(
        [
          { id: 1, name: "Physics (Fall)" },
          { id: 2, name: "Physics (Winter)" },
        ],
        "winter",
        ["year"]
      ).course.id,
      2
    );
  });
});

describe("attachCanvasComments", () => {
  it("keeps teacher comments newest first and drops Yan's own", () => {
    const tree = {
      classes: [
        {
          todos: [
            {
              id: "lab",
              canvasId: 10,
              canvasComments: [{ id: 1, createdAt: "old", comment: "stale" }],
            },
            { id: "plain" },
          ],
        },
      ],
      todos: [
        {
          id: "link",
          canvasLink: "https://canvas.instructure.com/courses/1/assignments/20",
        },
      ],
    };
    attachCanvasComments(tree, [
      {
        id: 3,
        assignmentId: 10,
        own: false,
        createdAt: "2026-09-29T20:30:05Z",
        comment: "later",
      },
      {
        id: 2,
        assignmentId: 10,
        own: false,
        createdAt: "2026-09-28T20:30:05Z",
        comment: "earlier",
      },
      {
        id: 9,
        assignmentId: 10,
        own: true,
        createdAt: "2026-09-30T20:30:05Z",
        comment: "mine",
      },
      {
        id: 4,
        assignmentId: 10,
        own: false,
        createdAt: "2026-09-27T20:30:05Z",
        comment: "   ",
      },
      {
        id: 5,
        assignmentId: 20,
        own: false,
        createdAt: "2026-09-01T00:00:00Z",
        comment: "on link",
      },
    ]);
    assert.deepEqual(tree.classes[0].todos[0].canvasComments, [
      { id: 3, createdAt: "2026-09-29T20:30:05Z", visibleAt: "2026-09-29T20:30:05Z", comment: "later" },
      { id: 2, createdAt: "2026-09-28T20:30:05Z", visibleAt: "2026-09-28T20:30:05Z", comment: "earlier" },
    ]);
    assert.equal(tree.classes[0].todos[1].canvasComments, undefined);
    assert.deepEqual(tree.todos[0].canvasComments, [
      { id: 5, createdAt: "2026-09-01T00:00:00Z", visibleAt: "2026-09-01T00:00:00Z", comment: "on link" },
    ]);
  });

  it("keeps the release time when Canvas posted the comment after it was written", () => {
    const tree = {
      classes: [{ todos: [{ id: "qa", canvasId: 40264902 }] }],
    };
    attachCanvasComments(tree, [
      {
        id: 84942469,
        assignmentId: 40264902,
        own: false,
        createdAt: "2026-11-04T22:48:31Z",
        visibleAt: "2026-11-07T06:05:59Z",
        comment: "Nice work.",
      },
    ]);
    assert.deepEqual(tree.classes[0].todos[0].canvasComments, [
      {
        id: 84942469,
        createdAt: "2026-11-04T22:48:31Z",
        visibleAt: "2026-11-07T06:05:59Z",
        comment: "Nice work.",
      },
    ]);
  });

  it("keeps comments from both terms on the same class", () => {
    const tree = {
      classes: [
        {
          id: "spanish-4",
          todos: [
            {
              id: "fall-hw",
              canvasId: 11,
              canvasLink:
                "https://canvas.instructure.com/courses/3638875/assignments/11",
            },
            {
              id: "winter-hw",
              canvasId: 22,
              canvasLink:
                "https://canvas.instructure.com/courses/3638876/assignments/22",
            },
          ],
        },
      ],
    };
    attachCanvasComments(tree, [
      {
        id: 1,
        assignmentId: 11,
        courseId: 3638875,
        own: false,
        createdAt: "2026-11-01T18:00:00Z",
        comment: "fall note",
      },
      {
        id: 2,
        assignmentId: 22,
        courseId: 3638876,
        own: false,
        createdAt: "2026-12-02T18:00:00Z",
        comment: "winter note",
      },
    ]);
    assert.equal(tree.classes[0].todos[0].canvasComments[0].comment, "fall note");
    assert.equal(tree.classes[0].todos[1].canvasComments[0].comment, "winter note");
  });

  it("clears a stale comment when the live list no longer has it", () => {
    const tree = {
      classes: [
        {
          todos: [
            {
              id: "lab",
              canvasId: 10,
              canvasComments: [{ id: 1, createdAt: "x", comment: "gone" }],
            },
          ],
        },
      ],
    };
    attachCanvasComments(tree, []);
    assert.equal(tree.classes[0].todos[0].canvasComments, undefined);
  });
});
