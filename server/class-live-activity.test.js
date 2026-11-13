import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignmentsForMeeting,
  classActivityDecision,
  unixAtMinutes,
} from "./class-live-activity.js";

const day = [
  { classId: "a", className: "English", period: "A", start: "08:30", end: "09:40", startMin: 8 * 60 + 30, endMin: 9 * 60 + 40, freePeriod: false },
  { classId: "b", className: "Math", period: "B", start: "09:55", end: "11:05", startMin: 9 * 60 + 55, endMin: 11 * 60 + 5, freePeriod: false },
  { classId: "c", className: "History", period: "C", start: "12:25", end: "13:35", startMin: 12 * 60 + 25, endMin: 13 * 60 + 35, freePeriod: false },
  { classId: "d", className: "Physics", period: "D", start: "13:50", end: "15:00", startMin: 13 * 60 + 50, endMin: 15 * 60, freePeriod: false },
];

describe("class activity day", () => {
  it("stays down until the first highlight", () => {
    const early = classActivityDecision(day, 8 * 60 + 19);
    assert.equal(early.phase, "idle");
    const lead = classActivityDecision(day, 8 * 60 + 20);
    assert.equal(lead.phase, "show");
    assert.equal(lead.meeting.period, "A");
  });

  it("keeps the next class up through passing and lunch", () => {
    const passing = classActivityDecision(day, 9 * 60 + 40);
    assert.equal(passing.phase, "show");
    assert.equal(passing.meeting.period, "B");
    const lunch = classActivityDecision(day, 11 * 60 + 30);
    assert.equal(lunch.phase, "show");
    assert.equal(lunch.meeting.period, "C");
    assert.equal(lunch.staleAtMin, 13 * 60 + 35);
  });

  it("holds the last class through the 15 minute buffer, then ends", () => {
    const buffer = classActivityDecision(day, 15 * 60);
    assert.equal(buffer.phase, "show");
    assert.equal(buffer.meeting.period, "D");
    const done = classActivityDecision(day, 15 * 60 + 15);
    assert.equal(done.phase, "end");
  });

  it("shows the next real class during a free period", () => {
    const withFree = [
      { classId: "free", className: "Free", period: "A", start: "08:30", end: "09:15", startMin: 8 * 60 + 30, endMin: 9 * 60 + 15, freePeriod: true },
      { classId: "b", className: "Math", period: "B", start: "09:25", end: "10:30", startMin: 9 * 60 + 25, endMin: 10 * 60 + 30, freePeriod: false },
    ];
    const before = classActivityDecision(withFree, 8 * 60 + 19);
    assert.equal(before.phase, "idle");
    const during = classActivityDecision(withFree, 8 * 60 + 40);
    assert.equal(during.phase, "show");
    assert.equal(during.meeting.classId, "b");
  });
});

describe("class activity assignments", () => {
  it("keeps same-day HW and timed work inside the meeting", () => {
    const tree = {
      todos: [
        { id: "hw", classId: "a", tag: "HW", name: "HW: Read", dueDate: "2026-11-12", done: false },
        { id: "cw", classId: "a", tag: "CW", name: "CW: Lab", dueDate: "2026-11-12", dueTime: "08:40", done: false },
        { id: "later", classId: "a", tag: "CW", name: "CW: Later", dueDate: "2026-11-12", dueTime: "12:00", done: false },
        { id: "other", classId: "b", tag: "HW", name: "Other", dueDate: "2026-11-12", done: false },
      ],
    };
    const { items, overflow } = assignmentsForMeeting(
      tree,
      { classId: "a", startMin: 8 * 60 + 30, endMin: 9 * 60 + 40 },
      "2026-11-12"
    );
    assert.equal(overflow, 0);
    assert.deepEqual(items.map((row) => row.todoId), ["cw", "hw"]);
    assert.equal(items.find((row) => row.todoId === "hw")?.name, "Read");
  });
});

describe("live activity unix time", () => {
  it("uses the schedule timezone", () => {
    const pst = unixAtMinutes("2026-11-12", 8 * 60 + 30, "America/Los_Angeles");
    assert.equal(pst, Date.UTC(2026, 10, 12, 16, 30) / 1000);
    const pdt = unixAtMinutes("2026-07-15", 8 * 60 + 30, "America/Los_Angeles");
    assert.equal(pdt, Date.UTC(2026, 6, 15, 15, 30) / 1000);
  });
});
