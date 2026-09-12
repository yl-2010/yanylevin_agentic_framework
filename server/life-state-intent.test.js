import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLifeStateIntent,
  slimLifeStateIntent,
  writeLifeStateIntent,
  readLifeStateIntent,
  readLifeStateStore,
  readRecentLifeStateSignals,
  lifeStateSignalsLogPath,
  applyIntentToStore,
  SHOWER_INTENT_TTL_MS,
  DRIVING_FOCUS_RESUME_MS,
} from "./life-state-intent.js";

describe("parseLifeStateIntent", () => {
  it("accepts dock, plugged-in, unplug, driving, and tesla kinds", () => {
    assert.equal(
      parseLifeStateIntent({ intent: "going_to_shower", orientation: "portrait" }).kind,
      "going_to_shower"
    );
    assert.equal(
      parseLifeStateIntent({ intent: "going_to_sleep", orientation: "landscape" }).kind,
      "going_to_sleep"
    );
    assert.equal(parseLifeStateIntent({ intent: "plugged_in" }).kind, "plugged_in");
    assert.equal(parseLifeStateIntent({ intent: "unplugged" }).kind, "unplugged");
    assert.equal(parseLifeStateIntent({ intent: "driving_focus" }).kind, "driving_focus");
    assert.equal(parseLifeStateIntent({ intent: "tesla_bluetooth" }).kind, "tesla_bluetooth");
  });

  it("infers shower/sleep from orientation only when kind is missing", () => {
    assert.equal(parseLifeStateIntent({ orientation: "portrait" }).kind, "going_to_shower");
    assert.equal(parseLifeStateIntent({ orientation: "horizontal" }).kind, "going_to_sleep");
  });

  it("rejects an empty body", () => {
    assert.equal(parseLifeStateIntent({}), null);
  });
});

describe("slimLifeStateIntent", () => {
  it("drops a stale shower intent after the TTL", () => {
    const now = new Date("2026-09-12T06:00:00.000Z");
    const fresh = slimLifeStateIntent(
      {
        kind: "going_to_shower",
        at: "2026-09-12T05:30:00.000Z",
        orientation: "portrait",
      },
      now
    );
    assert.equal(fresh.kind, "going_to_shower");
    const stale = slimLifeStateIntent(
      {
        kind: "going_to_shower",
        at: new Date(now.getTime() - SHOWER_INTENT_TTL_MS - 1000).toISOString(),
        orientation: "portrait",
      },
      now
    );
    assert.equal(stale, null);
  });
});

describe("applyIntentToStore", () => {
  it("clears plugged_in on unplug and resumes driving focus inside the window", () => {
    const t0 = new Date("2026-09-12T06:00:00.000Z");
    let store = applyIntentToStore(
      { latest: null, byKind: {} },
      { kind: "plugged_in", orientation: null, source: "shortcut" },
      t0
    );
    assert.equal(store.byKind.plugged_in.kind, "plugged_in");
    store = applyIntentToStore(
      store,
      { kind: "unplugged", orientation: null, source: "shortcut" },
      new Date(t0.getTime() + 60_000)
    );
    assert.equal(store.byKind.plugged_in, undefined);
    assert.equal(store.byKind.unplugged.kind, "unplugged");

    store = applyIntentToStore(
      { latest: null, byKind: {} },
      { kind: "driving_focus", orientation: null, source: "shortcut" },
      t0
    );
    const since = store.byKind.driving_focus.since;
    store = applyIntentToStore(
      store,
      { kind: "driving_focus", orientation: null, source: "shortcut" },
      new Date(t0.getTime() + DRIVING_FOCUS_RESUME_MS - 1000)
    );
    assert.equal(store.byKind.driving_focus.since, since);
    assert.equal(store.byKind.driving_focus.resumed, true);
  });
});

describe("writeLifeStateIntent", () => {
  it("writes and reads a dock intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-intent-"));
    try {
      const now = new Date("2026-09-12T06:00:00.000Z");
      const saved = await writeLifeStateIntent(
        { intent: "going_to_sleep", orientation: "landscape" },
        { dir, now }
      );
      assert.equal(saved.kind, "going_to_sleep");
      const read = await readLifeStateIntent(dir, now);
      assert.equal(read.kind, "going_to_sleep");
      assert.equal(read.orientation, "landscape");
      const store = await readLifeStateStore(dir, now);
      assert.equal(store.signals.going_to_sleep.kind, "going_to_sleep");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends each send to signals JSONL without collapsing history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "life-state-intent-"));
    try {
      const t0 = new Date("2026-09-12T06:00:00.000Z");
      await writeLifeStateIntent(
        { intent: "going_to_sleep", orientation: "landscape" },
        { dir, now: t0 }
      );
      await writeLifeStateIntent(
        { intent: "unplugged" },
        { dir, now: new Date(t0.getTime() + 60_000) }
      );
      const log = await readFile(lifeStateSignalsLogPath(dir, t0.toISOString()), "utf8");
      const lines = log.trim().split("\n");
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).kind, "going_to_sleep");
      assert.equal(JSON.parse(lines[1]).kind, "unplugged");
      const recent = await readRecentLifeStateSignals(dir, new Date(t0.getTime() + 60_000));
      assert.equal(recent.length, 2);
      assert.equal(recent[0].kind, "going_to_sleep");
      assert.equal(recent[1].kind, "unplugged");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
