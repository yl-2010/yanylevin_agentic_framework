import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LIFE_STATE_KINDS,
  appendLifeStateGuess,
  assessLifeStateHeartbeat,
  completeLifeStateRecord,
  formatLifeStateLocal,
  isCurrentLifeStateFresh,
  parseLifeStateRecord,
  readCurrentLifeState,
  readLifeStateAt,
  readRecentLifeState,
  readLifeStateDay,
  relinkLifeStateSequence,
  rewriteLifeStateDay,
  summarizeLifeStateDay,
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

  it("collapses a day and flags a stale heartbeat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-sum-"));
    try {
      await appendLifeStateGuess(SAMPLE, {
        dir,
        now: new Date("2026-09-11T21:10:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      await appendLifeStateGuess(
        { ...SAMPLE, activity: "in Data Science, TMAC-007" },
        {
          dir,
          now: new Date("2026-09-11T21:15:00.000Z"),
          timeZone: "America/Los_Angeles",
        }
      );
      const day = await summarizeLifeStateDay("2026-09-11", dir);
      assert.equal(day.ok, true);
      assert.equal(day.sampleCount, 2);
      assert.equal(day.segments.length, 1);
      assert.equal(day.segments[0].kind, "in_class");
      const health = await assessLifeStateHeartbeat({
        dir,
        now: new Date("2026-09-11T22:00:00.000Z"),
        gps: {
          receivedAt: "2026-09-11T21:59:00.000Z",
          source: "periodic",
          device: { batteryLevel: 80, network: "wifi" },
        },
        snapshot: null,
      });
      assert.equal(health.ok, false);
      assert.ok(health.issues.some((i) => i.code === "life-state-stale"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not flag sitting-still iPhone GPS as an issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-gps-still-"));
    try {
      await appendLifeStateGuess(SAMPLE, {
        dir,
        now: new Date("2026-09-13T12:55:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const health = await assessLifeStateHeartbeat({
        dir,
        now: new Date("2026-09-13T13:00:00.000Z"),
        gps: {
          receivedAt: "2026-09-13T04:39:00.000Z",
          source: "periodic",
          device: { batteryLevel: 65, network: "wifi" },
        },
        snapshot: null,
      });
      assert.equal(
        health.issues.some((i) => i.code === "gps-stale"),
        false
      );
      assert.ok(health.gps.ageMinutes > 30);
      assert.equal(health.ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still flags missing iPhone GPS", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-gps-miss-"));
    try {
      await appendLifeStateGuess(SAMPLE, {
        dir,
        now: new Date("2026-09-13T12:55:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const health = await assessLifeStateHeartbeat({
        dir,
        now: new Date("2026-09-13T13:00:00.000Z"),
        gps: null,
        snapshot: null,
      });
      assert.equal(health.ok, false);
      assert.ok(health.issues.some((i) => i.code === "gps-missing"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("life-state rewrite-day", () => {
  const awake = {
    kind: "on_computer",
    activity: "on Mac Studio in office",
    place: "kirkland-home",
    placeLabel: "Home",
    confidence: 0.9,
    evidence: ["gps:home", "screen:cursor"],
    model: "composer-2.5",
  };

  it("fixes a flicker sleeping tick and relinks continued", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-rewrite-"));
    try {
      await appendLifeStateGuess(awake, {
        dir,
        now: new Date("2026-09-13T07:00:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const mid = await appendLifeStateGuess(
        {
          ...awake,
          kind: "sleeping",
          activity: "asleep in bed",
          evidence: ["gps:home", "home:bedroom-on"],
        },
        {
          dir,
          now: new Date("2026-09-13T07:05:00.000Z"),
          timeZone: "America/Los_Angeles",
        }
      );
      await appendLifeStateGuess(awake, {
        dir,
        now: new Date("2026-09-13T07:10:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const other = await appendLifeStateGuess(SAMPLE, {
        dir,
        now: new Date("2026-09-12T21:10:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const result = await rewriteLifeStateDay(
        "2026-09-13",
        {
          corrections: [
            {
              at: mid.at,
              kind: "on_computer",
              activity: "on Mac Studio in office, still awake",
              place: "kirkland-home",
              placeLabel: "Home",
              confidence: 0.86,
              evidence: ["gps:home", "screen:cursor", "imessage:from-me"],
              notes: "one-tick sleeping between awake samples",
            },
          ],
        },
        { dir }
      );
      assert.equal(result.ok, true);
      assert.equal(result.corrected, 1);
      const day = await readLifeStateDay("2026-09-13", dir);
      assert.equal(day.length, 3);
      assert.equal(day[1].kind, "on_computer");
      assert.equal(day[1].continued, true);
      assert.equal(day[1].since, day[0].since);
      assert.equal(day[1].model, "grok-4.6");
      assert.ok(day[1].evidence.includes("cleanup:corrected"));
      assert.equal(day[2].continued, true);
      const kept = await readLifeStateDay("2026-09-12", dir);
      assert.equal(kept[0].kind, other.kind);
      assert.equal(kept[0].activity, other.activity);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("no-ops on empty corrections and rejects an unknown at", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-rewrite-empty-"));
    try {
      await appendLifeStateGuess(awake, {
        dir,
        now: new Date("2026-09-13T07:00:00.000Z"),
        timeZone: "America/Los_Angeles",
      });
      const empty = await rewriteLifeStateDay("2026-09-13", { corrections: [] }, { dir });
      assert.equal(empty.ok, true);
      assert.equal(empty.corrected, 0);
      const day = await readLifeStateDay("2026-09-13", dir);
      assert.equal(day[0].kind, "on_computer");
      await assert.rejects(
        () =>
          rewriteLifeStateDay(
            "2026-09-13",
            [{ at: "2026-09-13T07:55:00.000Z", kind: "sleeping" }],
            { dir }
          ),
        /no sample at/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("relinkLifeStateSequence", () => {
  it("continues matching kinds from the previous sample", () => {
    const prev = parseLifeStateRecord({
      at: "2026-09-13T06:55:00.000Z",
      local: "2026-09-12T23:55:00-07:00",
      dateKey: "2026-09-12",
      since: "2026-09-13T06:00:00.000Z",
      continued: true,
      kind: "sleeping",
      activity: "asleep",
      place: "kirkland-home",
      placeLabel: "Home",
      confidence: 0.8,
      evidence: ["gps:home"],
      model: "composer-2.5",
    });
    const next = relinkLifeStateSequence(
      [
        parseLifeStateRecord({
          at: "2026-09-13T07:00:00.000Z",
          local: "2026-09-13T00:00:00-07:00",
          dateKey: "2026-09-13",
          since: "2026-09-13T07:00:00.000Z",
          continued: false,
          kind: "sleeping",
          activity: "asleep",
          place: "kirkland-home",
          placeLabel: "Home",
          confidence: 0.8,
          evidence: ["gps:home"],
          model: "composer-2.5",
        }),
      ],
      prev
    );
    assert.equal(next[0].continued, true);
    assert.equal(next[0].since, prev.since);
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
