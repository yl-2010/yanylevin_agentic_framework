import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFE_STATE_KINDS,
  appendLifeStateGuess,
  completeLifeStateRecord,
  formatLifeStateLocal,
  isCurrentLifeStateFresh,
  parseLifeStateRecord,
  readCurrentLifeState,
  readLifeStateAt,
  readRecentLifeState,
} from "./life-state.js";

const SAMPLE = {
  kind: "in_class",
  activity: "in Data Science, TMAC-007",
  place: "eastside-preparatory-school",
  placeLabel: "EPS",
  confidence: 0.9,
  evidence: ["gps:eps", "schedule:period-A"],
  notes: "bathroom fan still on from earlier; not showering",
  model: "composer-2.5",
};

describe("life-state schema", () => {
  it("accepts a complete record and drops unknown keys", () => {
    const rec = parseLifeStateRecord({
      at: "2026-09-11T21:10:00.000Z",
      local: "2026-09-11T14:10:00-07:00",
      dateKey: "2026-09-11",
      since: "2026-09-11T15:30:00.000Z",
      continued: false,
      uuid: "secret",
      ...SAMPLE,
    });
    assert.equal(rec.kind, "in_class");
    assert.equal(rec.place, "eastside-preparatory-school");
    assert.equal(rec.confidence, 0.9);
    assert.equal(rec.uuid, undefined);
    assert.deepEqual(rec.evidence, ["gps:eps", "schedule:period-a"]);
  });

  it("rejects a bad kind or missing evidence", () => {
    assert.equal(
      parseLifeStateRecord({
        at: "2026-09-11T21:10:00.000Z",
        local: "2026-09-11T14:10:00-07:00",
        dateKey: "2026-09-11",
        since: "2026-09-11T21:10:00.000Z",
        ...SAMPLE,
        kind: "in-the-shower",
      }),
      null
    );
    assert.equal(
      parseLifeStateRecord({
        at: "2026-09-11T21:10:00.000Z",
        local: "2026-09-11T14:10:00-07:00",
        dateKey: "2026-09-11",
        since: "2026-09-11T21:10:00.000Z",
        ...SAMPLE,
        evidence: ["Home UUID abc"],
      }),
      null
    );
  });

  it("lists the v1 kind enum", () => {
    assert.ok(LIFE_STATE_KINDS.includes("showering"));
    assert.ok(LIFE_STATE_KINDS.includes("school_lunch"));
    assert.ok(LIFE_STATE_KINDS.includes("sleeping"));
  });

  it("strips em dashes from activity", () => {
    const rec = parseLifeStateRecord({
      at: "2026-09-11T21:10:00.000Z",
      local: "2026-09-11T14:10:00-07:00",
      dateKey: "2026-09-11",
      since: "2026-09-11T21:10:00.000Z",
      continued: false,
      ...SAMPLE,
      activity: "on Mac Studio in office — Cursor",
    });
    assert.equal(rec.activity, "on Mac Studio in office, Cursor");
  });
});

describe("completeLifeStateRecord", () => {
  it("fills clock fields and continues a matching kind", () => {
    const now = new Date("2026-09-11T21:15:00.000Z");
    const prev = parseLifeStateRecord({
      at: "2026-09-11T21:10:00.000Z",
      local: "2026-09-11T14:10:00-07:00",
      dateKey: "2026-09-11",
      since: "2026-09-11T15:30:00.000Z",
      continued: false,
      ...SAMPLE,
    });
    const rec = completeLifeStateRecord(SAMPLE, {
      now,
      timeZone: "America/Los_Angeles",
      previous: prev,
    });
    assert.equal(rec.at, "2026-09-11T21:15:00.000Z");
    assert.equal(rec.dateKey, "2026-09-11");
    assert.equal(rec.continued, true);
    assert.equal(rec.since, "2026-09-11T15:30:00.000Z");
    assert.match(rec.local, /2026-09-11T14:15:00/);
  });

  it("resets since when kind changes", () => {
    const now = new Date("2026-09-11T21:15:00.000Z");
    const prev = parseLifeStateRecord({
      at: "2026-09-11T21:10:00.000Z",
      local: "2026-09-11T14:10:00-07:00",
      dateKey: "2026-09-11",
      since: "2026-09-11T15:30:00.000Z",
      continued: true,
      ...SAMPLE,
    });
    const rec = completeLifeStateRecord(
      { ...SAMPLE, kind: "free_period", activity: "free B, TMAC 2nd" },
      { now, timeZone: "America/Los_Angeles", previous: prev }
    );
    assert.equal(rec.kind, "free_period");
    assert.equal(rec.continued, false);
    assert.equal(rec.since, now.toISOString());
  });
});

describe("life-state log IO", () => {
  it("appends JSONL, current.json, and finds nearest sample", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-"));
    try {
      const first = await appendLifeStateGuess(SAMPLE, {
        dir,
        now: new Date("2026-09-11T21:10:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      assert.equal(first.kind, "in_class");
      const second = await appendLifeStateGuess(
        { ...SAMPLE, activity: "still Data Science" },
        {
          dir,
          now: new Date("2026-09-11T21:15:00.000Z"),
          timeZone: "America/Los_Angeles",
        }
      );
      assert.equal(second.continued, true);
      const current = await readCurrentLifeState(dir);
      assert.equal(current.activity, "still Data Science");
      const recent = await readRecentLifeState(dir, 3);
      assert.equal(recent.length, 2);
      const at = await readLifeStateAt("2026-09-11T21:12:00.000Z", dir);
      assert.equal(at.at, first.at);
      const log = await readFile(
        join(dir, "log-2026-09.jsonl"),
        "utf8"
      );
      assert.equal(log.trim().split("\n").length, 2);
      assert.equal(isCurrentLifeStateFresh(current, 50 * 365 * 24 * 3600 * 1000), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatLifeStateLocal", () => {
  it("emits a parseable offset local time", () => {
    const { dateKey, local } = formatLifeStateLocal(
      new Date("2026-09-11T21:10:00.000Z"),
      "America/Los_Angeles"
    );
    assert.equal(dateKey, "2026-09-11");
    assert.ok(Number.isFinite(Date.parse(local)));
  });
});
