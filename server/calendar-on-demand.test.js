import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMailRow } from "./apple-mail-file.js";
import {
  buildOnDemandPrompt,
  pacificWeekdayLines,
  calendarSignalYes,
  considerCalendarMessage,
  enqueueCalendarThread,
  ingestCalendarRows,
  loadActionTodoIndex,
  pollSchoolMailCalendar,
  resetCalendarOnDemandForTests,
  rowEligible,
  CALENDAR_ON_DEMAND_MODEL_SPEC,
  CALENDAR_SIGNAL_QUESTION,
  CALENDAR_SIGNAL_THRESHOLD,
} from "./calendar-on-demand.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("calendar signal", () => {
  it("uses a recall-biased threshold", () => {
    assert.equal(CALENDAR_SIGNAL_THRESHOLD, 0.35);
    assert.match(String(CALENDAR_SIGNAL_QUESTION.instructions), /task he himself has to do/);
    assert.match(String(CALENDAR_SIGNAL_QUESTION.criteria.true), /fill out a form/);
    assert.match(String(CALENDAR_SIGNAL_QUESTION.criteria.false), /homework or Canvas/);
    assert.equal(calendarSignalYes({ noul: 0.35 }), true);
    assert.equal(calendarSignalYes({ noul: 0.34 }), false);
    assert.equal(calendarSignalYes({ probability: 0.9 }), true);
    assert.equal(CALENDAR_ON_DEMAND_MODEL_SPEC.id, "composer-2.5");
    assert.equal(CALENDAR_ON_DEMAND_MODEL_SPEC.params[0].value, "false");
  });

  it("skips tapbacks, empty text, and the agent footer", () => {
    assert.equal(rowEligible("imessage", { tapback: true, text: "liked" }), false);
    assert.equal(rowEligible("imessage", { text: "" }), false);
    assert.equal(
      rowEligible("imessage", { text: "ok\nSent by Yan's Personal Agent" }),
      false
    );
    assert.equal(rowEligible("imessage", { text: "Saturday at 4", fromMe: true }), true);
    assert.equal(rowEligible("teams", { messageType: "message", text: "meet at 3" }), true);
    assert.equal(rowEligible("apple-mail", { subject: "Dinner", body: "" }), true);
  });
});

describe("calendar on-demand queue", () => {
  it("coalesces one thread and runs a second thread after", async () => {
    resetCalendarOnDemandForTests();
    let active = 0;
    let max = 0;
    /** @type {object[]} */
    const ran = [];
    const runJob = async (job) => {
      active += 1;
      max = Math.max(max, active);
      await wait(30);
      active -= 1;
      ran.push(job);
    };
    const deps = { debounceMs: 25, runJob };
    enqueueCalendarThread(
      { source: "imessage", message: { chatId: "c1", text: "sat?", id: 1 } },
      deps
    );
    enqueueCalendarThread(
      { source: "imessage", message: { chatId: "c1", text: "4pm at my house", id: 2 } },
      deps
    );
    enqueueCalendarThread(
      { source: "imessage", message: { chatId: "c2", text: "Sunday noon", id: 3 } },
      deps
    );
    await wait(120);
    assert.equal(ran.length, 2);
    assert.equal(max, 1);
    const first = ran.find((job) => job.key.endsWith("c1"));
    assert.equal(first.messages.length, 2);
    resetCalendarOnDemandForTests();
  });

  it("queues only when Jev says the message might be a plan", async () => {
    resetCalendarOnDemandForTests();
    /** @type {object[]} */
    const ran = [];
    const deps = {
      debounceMs: 20,
      runJob: async (job) => ran.push(job),
      systemOne: async (req) => ({
        answers: {
          calendar: { noul: String(req.state.text).includes("Saturday") ? 0.8 : 0.1 },
        },
      }),
    };
    const yes = await considerCalendarMessage(
      "imessage",
      { id: 1, chatId: "room", text: "Saturday at 4" },
      deps
    );
    const no = await considerCalendarMessage(
      "imessage",
      { id: 2, chatId: "room", text: "lol" },
      deps
    );
    assert.equal(yes.queued, true);
    assert.equal(no.skipped, "no-signal");
    await wait(50);
    assert.equal(ran.length, 1);
    assert.equal(ran[0].messages.length, 1);
    resetCalendarOnDemandForTests();
  });

  it("does not ask Jev twice for the same row", async () => {
    resetCalendarOnDemandForTests();
    const dir = await mkdtemp(join(tmpdir(), "cal-seen-"));
    const seenPath = join(dir, "seen.json");
    let calls = 0;
    const deps = {
      seenPath,
      debounceMs: 1000,
      runJob: async () => {},
      systemOne: async () => {
        calls += 1;
        return { answers: { calendar: { noul: 0.1 } } };
      },
    };
    const row = { id: "m1", chatId: "room", text: "maybe Friday" };
    try {
      await ingestCalendarRows("teams", [row], deps);
      await ingestCalendarRows("teams", [row], deps);
      assert.equal(calls, 1);
    } finally {
      resetCalendarOnDemandForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("calendar on-demand prompt", () => {
  it("stays on the triggering plan and names the tombstone skip", () => {
    const prompt = buildOnDemandPrompt({
      source: "imessage",
      messages: [{ message: { text: "Saturday 4:30 location tbd", chat: "JYPE", fromMe: true } }],
      thread: [],
      events: [],
      tombstones: [],
      todos: [
        {
          name: "Reply to the form",
          dueDate: "2026-10-31",
          dueTime: "15:30",
          parent: "user-level",
          folder: "/tmp/todos/reply-to-the-form",
        },
      ],
      deletedTodos: "- deleted 2026-09-02 12:11 | todo | Old ask | on 2026-09-15 08:30 | user-level | was todos/old-ask",
      skillText: "meeting links",
    });
    assert.match(prompt, /Do not sweep the inbox/);
    assert.match(prompt, /deleted-identical/);
    assert.match(prompt, /Saturday 4:30/);
    assert.match(prompt, /meeting links/);
    assert.match(prompt, /composer|Composer|personal-calendar/i);
    assert.match(prompt, /calendar-worthy/);
    assert.match(prompt, /Create nothing when it is not/);
    assert.match(prompt, /Pick one/);
    assert.match(prompt, /Do not create both/);
    assert.match(prompt, /fill out a form/);
    assert.match(prompt, /dueDate/);
    assert.match(prompt, /College Prep/);
    assert.match(prompt, /Open todos you may update/);
    assert.match(prompt, /Reply to the form/);
    assert.match(prompt, /college spam/i);
    assert.match(prompt, /Do not move an existing event to another calendar/);
    assert.match(prompt, /signed up for that visit/);
    assert.match(prompt, /education todos/);
    assert.match(prompt, /Jev is that classifier, not a person/);
    assert.match(prompt, /Next Saturday is the second/);
    assert.match(prompt, /Look up the real start and end/);
    assert.doesNotMatch(prompt, /Do not invent a clock/);
    assert.match(prompt, /\d{4}-\d{2}-\d{2} (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    assert.doesNotMatch(prompt, /Bias is add/);
  });

  it("lists next Saturday as Oct 10 when today is Wed Sep 30", () => {
    const lines = pacificWeekdayLines(new Date("2026-09-30T21:00:00.000Z"));
    assert.match(lines, /^2026-09-30 Wednesday/);
    assert.match(lines, /2026-10-03 Saturday/);
    assert.match(lines, /2026-10-10 Saturday/);
    assert.match(lines, /2026-10-11 Sunday/);
    const prompt = buildOnDemandPrompt({
      source: "imessage",
      messages: [{ message: { text: "next sat", at: "2026-09-30T20:56:59Z" } }],
      now: new Date("2026-09-30T21:00:00.000Z"),
    });
    assert.match(prompt, /2026-10-10 Saturday/);
    assert.doesNotMatch(prompt, /Count the weekday/);
  });

  it("asks the mail filer and the calendar gate in one Jev call", async () => {
    let questions;
    const answer = await classifyMailRow(
      { from: "a@b.com", subject: "Saturday", body: "4pm" },
      {
        systemOne: async (req) => {
          questions = req.questions;
          return {
            answers: {
              bucket: { choice: "other", confidence: 0.9 },
              calendar: { noul: 0.2 },
            },
          };
        },
      }
    );
    assert.equal(answer.choice, "other");
    assert.equal(answer.calendar.noul, 0.2);
    assert.ok(questions.bucket);
    assert.ok(questions.calendar);
  });
});

describe("action todo index", () => {
  it("keeps open action todos and drops briefings, fixtures, and done rows", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-todos-"));
    const userTodos = join(dir, "todos");
    const collegeTodos = join(dir, "college");
    await mkdir(join(userTodos, "reply-to-sam"), { recursive: true });
    await mkdir(join(userTodos, "2026-10-31-daily-briefing"), { recursive: true });
    await mkdir(join(userTodos, "_example-buy-binder"), { recursive: true });
    await mkdir(join(userTodos, "already-done"), { recursive: true });
    await mkdir(join(collegeTodos, "ask-seeley"), { recursive: true });
    await writeFile(
      join(userTodos, "reply-to-sam", "todo.json"),
      JSON.stringify({
        name: "Reply to Sam",
        dueDate: "2026-10-31",
        dueTime: "15:30",
        done: false,
      })
    );
    await writeFile(
      join(userTodos, "2026-10-31-daily-briefing", "todo.json"),
      JSON.stringify({ name: "October 31st Daily Briefing", kind: "dailyBriefing", done: false })
    );
    await writeFile(
      join(userTodos, "_example-buy-binder", "todo.json"),
      JSON.stringify({ name: "Todo #5", dueDate: "2026-09-10", done: false })
    );
    await writeFile(
      join(userTodos, "already-done", "todo.json"),
      JSON.stringify({ name: "Send the form", done: true, dueDate: "2026-10-01" })
    );
    await writeFile(
      join(collegeTodos, "ask-seeley", "todo.json"),
      JSON.stringify({
        name: "Ask Seeley about AP Physics tests",
        dueDate: "2026-11-02",
        dueTime: "15:00",
        done: false,
      })
    );
    await writeFile(
      join(dir, "deleted.md"),
      [
        "# Manually deleted",
        "- deleted 2026-09-02 12:11 | todo | Old ask | on 2026-09-15 | user-level | was todos/old-ask",
        "- deleted 2026-09-05 18:40 | calendar | Mariners | on 2026-09-05 | Home | was abc",
      ].join("\n")
    );
    try {
      const index = await loadActionTodoIndex({
        userTodosDir: userTodos,
        collegeTodosDir: collegeTodos,
        deletedDir: dir,
      });
      assert.deepEqual(
        index.todos.map((row) => row.name),
        ["Reply to Sam", "Ask Seeley about AP Physics tests"]
      );
      assert.equal(index.todos[0].parent, "user-level");
      assert.equal(index.todos[1].parent, "project:college-prep");
      assert.match(index.deleted, /Old ask/);
      assert.doesNotMatch(index.deleted, /Mariners/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("school mail calendar poll", () => {
  it("writes a watermark and does not classify history", async () => {
    resetCalendarOnDemandForTests();
    const dir = await mkdtemp(join(tmpdir(), "cal-school-"));
    const statePath = join(dir, "state.json");
    let fetched = 0;
    try {
      const out = await pollSchoolMailCalendar({
        statePath,
        now: () => new Date("2026-09-26T19:00:00.000Z"),
        systemOne: async () => {
          throw new Error("should not classify on watermark");
        },
        fetchSchoolMessages: async () => {
          fetched += 1;
          return [];
        },
      });
      assert.equal(out.skipped, "watermark");
      assert.equal(fetched, 0);
    } finally {
      resetCalendarOnDemandForTests();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
