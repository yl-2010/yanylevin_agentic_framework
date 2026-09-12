import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFE_STATE_INTERVAL_MS,
  LIFE_STATE_MODEL_SPEC,
  buildLifeStatePrompt,
  lifeStateModelSpec,
  msUntilNextLifeStateTick,
} from "./life-state-agent.js";

describe("life-state model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(LIFE_STATE_MODEL_SPEC.id, "composer-2.5");
    const spec = lifeStateModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
  });
});

describe("life-state tick alignment", () => {
  it("waits until the next :00/:05/:10 clock mark", () => {
    const onMidnight = Date.parse("2026-09-12T00:00:00.000Z");
    assert.equal(msUntilNextLifeStateTick(onMidnight), LIFE_STATE_INTERVAL_MS);

    const plus2 = Date.parse("2026-09-12T00:02:00.000Z");
    assert.equal(msUntilNextLifeStateTick(plus2), 3 * 60 * 1000);

    const plus4_30 = Date.parse("2026-09-12T00:04:30.000Z");
    assert.equal(msUntilNextLifeStateTick(plus4_30), 30 * 1000);

    const onFive = Date.parse("2026-09-12T00:05:00.000Z");
    assert.equal(msUntilNextLifeStateTick(onFive), LIFE_STATE_INTERVAL_MS);

    const plus7 = Date.parse("2026-09-12T00:07:00.000Z");
    assert.equal(msUntilNextLifeStateTick(plus7), 3 * 60 * 1000);
  });
});

describe("life-state prompt", () => {
  it("points at the skill, snapshot, and append CLI", () => {
    const prompt = buildLifeStatePrompt({
      dateKey: "2026-09-11",
      timezone: "America/Los_Angeles",
      snapshotPath: "/tmp/yanylevin-life-state-snapshot.json",
    });
    assert.match(prompt, /life-state skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /yanylevin-life-state-snapshot\.json/);
    assert.match(prompt, /life-state\.js append/);
    assert.match(prompt, /Do not git commit/);
    assert.match(prompt, /Do not open Mail/);
    assert.doesNotMatch(prompt, /Health sleep hours are real/);
  });
});
