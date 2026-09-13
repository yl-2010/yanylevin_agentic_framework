import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  attachCanvasGrades,
  formatAssignmentWork,
  formatCourseScoreLabel,
  trimScore,
} from "./canvas-grades.js";

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
          { id: 9, score: 4, pointsPossible: 5, workflowState: "graded" },
        ],
      },
      { 1: "advanced-calculus" }
    );
    assert.equal(tree.classes[0].canvasScoreLabel, "97.5%");
    assert.equal(tree.classes[0].todos[0].canvasWork.display, "4/5");
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
});
