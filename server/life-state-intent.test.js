import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLifeStateIntent,
  slimLifeStateIntent,
  writeLifeStateIntent,
  readLifeStateIntent,
  SHOWER_INTENT_TTL_MS,
} from "./life-state-intent.js";

describe("parseLifeStateIntent", () => {
  it("accepts going_to_shower and going_to_sleep", () => {
    assert.equal(
      parseLifeStateIntent({ intent: "going_to_shower", orientation: "portrait" }).kind,
      "going_to_shower"
    );
    assert.equal(
      parseLifeStateIntent({ intent: "going_to_sleep", orientation: "landscape" }).kind,
      "going_to_sleep"
    );
  });

  it("infers kind from orientation", () => {
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
