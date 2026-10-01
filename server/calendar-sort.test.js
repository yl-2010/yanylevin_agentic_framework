import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { calendarSortHm } from "./daily-briefing-agent.js";
import {
  classifyTitle,
  involvesOthers,
  planMoves,
  categoryOfCalendar,
} from "./calendar-sort.js";

describe("calendar sort categories", () => {
  it("puts family ahead of school", () => {
    assert.equal(classifyTitle("PathIvy: Parent Consultation - Rajasi Saha"), "Family");
    assert.equal(classifyTitle("sb eye #2"), "Family");
    assert.equal(classifyTitle("Show mom sleep data"), "Family");
    assert.equal(
      classifyTitle("Sid's dad will pick you up from home for EMS (school dance)"),
      "School/Work"
    );
  });

  it("puts school and college prep on School/Work", () => {
    assert.equal(classifyTitle("PathIvy: PSAT & Merit Scholarships 101"), "School/Work");
    assert.equal(classifyTitle("ExampleCo coffee with Nikita"), "School/Work");
    assert.equal(classifyTitle("Speech & Debate Practice"), "School/Work");
  });

  it("puts friends and personal appointments on Personal", () => {
    assert.equal(classifyTitle("JYPE hangout"), "Personal");
    assert.equal(classifyTitle("Diana Haircut"), "Personal");
  });

  it("leaves mixed or vague titles unclassified", () => {
    assert.equal(classifyTitle("Not at EPS (JYPE, maybe)"), null);
    assert.equal(classifyTitle("Chad"), null);
  });

  it("treats Exchange Calendar as Personal and Daily Schedule as in scope only", () => {
    assert.equal(categoryOfCalendar("Exchange", "Calendar"), "Personal");
    assert.equal(categoryOfCalendar("Google", "you@example.com"), "Personal");
    assert.equal(categoryOfCalendar("iCloud", "Daily Schedule"), null);
  });
});

describe("calendar sort moves", () => {
  const slots = {
    iCloud: { Personal: "ic-p", "School/Work": "ic-s", Family: "ic-f" },
    Exchange: { Personal: "ex-p", "School/Work": "ex-s", Family: "ex-f" },
    Google: { Personal: "g-p", "School/Work": "g-s", Family: "g-f" },
  };

  it("keeps a solo Exchange event on Exchange and changes category", async () => {
    const { moves } = await planMoves(
      [
        {
          id: "1",
          seriesId: "s1",
          title: "PathIvy: PSAT 101",
          calendar: "Calendar",
          calendarId: "ex-p",
          source: "Exchange",
          start: "2026-09-06T23:00:00Z",
        },
      ],
      { mode: "cleanup", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toAccount, "Exchange");
    assert.equal(moves[0].toCalendarId, "ex-s");
  });

  it("keeps a solo Google event on Google and changes category", async () => {
    const { moves } = await planMoves(
      [
        {
          id: "2",
          seriesId: "s2",
          title: "Petya dinner",
          calendar: "Family",
          calendarId: "g-f",
          source: "Google",
          start: "2026-10-01T02:00:00Z",
        },
      ],
      { mode: "cleanup", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].category, "Personal");
    assert.equal(moves[0].toAccount, "Google");
    assert.equal(moves[0].toCalendarId, "g-p");
  });

  it("leaves an invited Google event on Google", async () => {
    const { moves } = await planMoves(
      [
        {
          id: "3",
          seriesId: "s3",
          title: "PathIvy: PSAT 101",
          calendar: "you@example.com",
          calendarId: "g-p",
          source: "Google",
          start: "2026-09-06T23:00:00Z",
          organizer: { name: "Calla", email: "calla@pathivy.com", self: false },
          attendees: [
            { email: "you@example.com", self: true },
            { email: "calla@pathivy.com", self: false },
          ],
        },
      ],
      { mode: "cleanup", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toAccount, "Google");
    assert.equal(moves[0].toCalendarId, "g-s");
    assert.equal(involvesOthers(moves[0]) || moves[0].involvesOthers, true);
  });

  it("does not change account on the nightly pass", async () => {
    const { moves } = await planMoves(
      [
        {
          id: "4",
          seriesId: "s4",
          title: "FAFSA Live workshop",
          calendar: "Family",
          calendarId: "g-f",
          source: "Google",
          start: "2026-10-11T22:00:00Z",
        },
      ],
      { mode: "nightly", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toAccount, "Google");
    assert.equal(moves[0].toCalendarId, "g-s");
  });

  it("moves Daily Schedule onto the iCloud category", async () => {
    const { moves } = await planMoves(
      [
        {
          id: "5",
          seriesId: "s5",
          title: "Debate Practice",
          calendar: "Daily Schedule",
          calendarId: "ic-daily",
          source: "iCloud",
          start: "2025-09-01T15:00:00Z",
          recurring: true,
        },
      ],
      { mode: "cleanup", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 1);
    assert.equal(moves[0].toCalendarId, "ic-s");
    assert.equal(moves[0].span, "future");
  });

  it("leaves an unsure nightly event where it is", async () => {
    const { moves, kept } = await planMoves(
      [
        {
          id: "6",
          seriesId: "s6",
          title: "Chad",
          calendar: "Calendar",
          calendarId: "ex-p",
          source: "Exchange",
          start: "2026-06-17T17:00:00Z",
        },
      ],
      { mode: "nightly", slots, decisions: new Map() }
    );
    assert.equal(moves.length, 0);
    assert.equal(kept[0].reason, "unsure");
  });

  it("does not fight a remembered category", async () => {
    const decisions = new Map([["s7|JYPE hangout", { category: "Personal", title: "JYPE hangout" }]]);
    const { moves } = await planMoves(
      [
        {
          id: "7",
          seriesId: "s7",
          title: "JYPE hangout",
          calendar: "Personal",
          calendarId: "ic-p",
          source: "iCloud",
          start: "2026-08-29T20:00:00Z",
        },
      ],
      { mode: "nightly", slots, decisions }
    );
    assert.equal(moves.length, 0);
  });
});

describe("calendar sort clock", () => {
  it("defaults to 01:15", () => {
    assert.equal(calendarSortHm({}), "01:15");
    assert.equal(calendarSortHm({ calendarSortLocalTime: "02:00" }), "02:00");
  });
});
