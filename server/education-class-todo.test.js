import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classTodoReadyForCompleted,
  dateFolderShouldBeVisible,
  todoFolderShouldBeVisible,
  todoVisibleFromMeeting,
} from "./education-class-todo.js";
import { classPeriodOnDate } from "./education-data.js";

const schedule = {
  timezone: "America/Los_Angeles",
  schoolStart: "2026-09-02",
  schoolEnd: "2027-06-11",
  trimesters: {
    fall: { start: "2026-09-02", end: "2026-11-20" },
    winter: { start: "2026-12-01", end: "2027-03-05" },
    spring: { start: "2027-03-09", end: "2027-06-11" },
  },
  weekdayPeriods: {
    1: ["C"],
    2: ["C"],
    3: ["C"],
    4: ["C"],
    5: ["C"],
  },
  bells: [{ slot: 1, start: "08:30", end: "09:40" }],
  closedDates: [],
};

const cls = { id: "advanced-calculus", name: "Advanced Calculus", period: "C" };

function at(iso) {
  return new Date(iso);
}

describe("classPeriodOnDate", () => {
  it("uses the trimester letter map", () => {
    const history = {
      id: "us-history",
      period: { fall: "F", winter: "E", spring: "E" },
    };
    assert.equal(classPeriodOnDate(history, "2026-09-15", schedule), "F");
    assert.equal(classPeriodOnDate(history, "2027-01-12", schedule), "E");
    assert.equal(classPeriodOnDate(history, "2027-04-12", schedule), "E");
  });

  it("keeps a plain letter", () => {
    assert.equal(classPeriodOnDate(cls, "2026-09-15", schedule), "C");
  });
});

describe("todo folder visibility", () => {
  it("shows HW the period before it is due", () => {
    const todo = {
      id: "hw-one",
      tag: "HW",
      dueDate: "2026-09-15",
      dueTime: "08:30",
      done: false,
    };
    const from = todoVisibleFromMeeting(todo, cls, schedule, 1);
    assert.equal(from?.dateKey, "2026-09-14");
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-14T08:00:00-07:00")),
      false
    );
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-14T08:31:00-07:00")),
      true
    );
  });

  it("shows QA two periods before it is due", () => {
    const todo = {
      id: "qa-one",
      tag: "QA",
      dueDate: "2026-09-16",
      dueTime: "08:30",
      done: false,
    };
    const from = todoVisibleFromMeeting(todo, cls, schedule, 2);
    assert.equal(from?.dateKey, "2026-09-14");
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-14T08:31:00-07:00")),
      true
    );
  });

  it("keeps a checked-off todo visible until class-view Completed", () => {
    const todo = {
      id: "hw-one",
      tag: "HW",
      dueDate: "2026-09-15",
      dueTime: "08:30",
      done: true,
    };
    assert.equal(
      classTodoReadyForCompleted(todo, cls, schedule, at("2026-09-15T09:00:00-07:00")),
      false
    );
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T09:00:00-07:00")),
      true
    );
    assert.equal(
      classTodoReadyForCompleted(todo, cls, schedule, at("2026-09-15T09:40:00-07:00")),
      true
    );
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T09:40:00-07:00")),
      false
    );
  });

  it("keeps overdue open todos visible", () => {
    const todo = {
      id: "hw-late",
      tag: "HW",
      dueDate: "2026-09-08",
      dueTime: "08:30",
      done: false,
    };
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T12:00:00-07:00")),
      true
    );
  });

  it("reveals when the page has been opened", () => {
    const todo = {
      id: "ma-later",
      tag: "MA",
      dueDate: "2026-11-01",
      dueTime: "08:30",
      done: false,
      folderRevealedAt: "2026-09-15T16:00:00.000Z",
    };
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T12:00:00-07:00")),
      true
    );
  });

  it("shows a still-future todo early when it already has user files", () => {
    const todo = {
      id: "hw-later",
      tag: "HW",
      dueDate: "2026-11-01",
      dueTime: "08:30",
      done: false,
    };
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T12:00:00-07:00")),
      false
    );
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T12:00:00-07:00"), {
        hasUserFiles: true,
      }),
      true
    );
  });

  it("does not unhide a Completed todo just because it has files", () => {
    const todo = {
      id: "hw-one",
      tag: "HW",
      dueDate: "2026-09-15",
      dueTime: "08:30",
      done: true,
    };
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T09:40:00-07:00"), {
        hasUserFiles: true,
      }),
      false
    );
  });

  it("does not early-show an undated todo that has files", () => {
    const todo = { id: "hw-someday", tag: "HW", done: false };
    assert.equal(
      todoFolderShouldBeVisible(todo, cls, schedule, at("2026-09-15T12:00:00-07:00"), {
        hasUserFiles: true,
      }),
      false
    );
  });
});

describe("date folder visibility", () => {
  it("shows from the day before through the date", () => {
    const dateObj = { id: "exam", date: "2026-09-16" };
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-14T12:00:00-07:00")),
      false
    );
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-15T12:00:00-07:00")),
      true
    );
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-16T12:00:00-07:00")),
      true
    );
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-17T12:00:00-07:00")),
      false
    );
  });

  it("shows a still-future date early when it already has user files", () => {
    const dateObj = { id: "exam", date: "2026-11-01" };
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-15T12:00:00-07:00")),
      false
    );
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-15T12:00:00-07:00"), {
        hasUserFiles: true,
      }),
      true
    );
  });

  it("does not unhide a past date just because it has files", () => {
    const dateObj = { id: "exam", date: "2026-09-16" };
    assert.equal(
      dateFolderShouldBeVisible(dateObj, schedule, at("2026-09-17T12:00:00-07:00"), {
        hasUserFiles: true,
      }),
      false
    );
  });
});
