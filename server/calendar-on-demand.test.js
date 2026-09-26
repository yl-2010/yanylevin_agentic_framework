import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyMailRow } from "./apple-mail-file.js";
import {
  buildOnDemandPrompt,
  calendarSignalYes,
  considerCalendarMessage,
  enqueueCalendarThread,
  ingestCalendarRows,
  pollSchoolMailCalendar,
  resetCalendarOnDemandForTests,
  rowEligible,
  CALENDAR_ON_DEMAND_MODEL_SPEC,
  CALENDAR_SIGNAL_THRESHOLD,
} from "./calendar-on-demand.js";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("calendar signal", () => {
  it("uses a recall-biased threshold", () => {
    assert.equal(CALENDAR_SIGNAL_THRESHOLD, 0.35);
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
      skillText: "meeting links",
    });
    assert.match(prompt, /Do not sweep the inbox/);
    assert.match(prompt, /deleted-identical/);
    assert.match(prompt, /Saturday 4:30/);
    assert.match(prompt, /meeting links/);
    assert.match(prompt, /composer|Composer|personal-calendar/i);
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
