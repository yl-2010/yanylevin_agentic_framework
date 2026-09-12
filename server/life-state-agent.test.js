import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFE_STATE_MODEL_SPEC,
  buildLifeStatePrompt,
  lifeStateModelSpec,
} from "./life-state-agent.js";

describe("life-state model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(LIFE_STATE_MODEL_SPEC.id, "composer-2.5");
    const spec = lifeStateModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
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
