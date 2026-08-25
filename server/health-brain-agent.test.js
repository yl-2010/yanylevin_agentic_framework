import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_BRAIN_MODEL_SPEC,
  buildHealthBrainPrompt,
  healthBrainModelSpec,
  nextHealthBrainAt,
} from "./health-brain-agent.js";

const META = {
  timezone: "America/Chicago",
  nightlyAgentsLocalTime: "01:00",
  contextSynthesisLocalTime: "02:30",
  brainProjectionLocalTime: "03:00",
};

describe("health brain model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(HEALTH_BRAIN_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(healthBrainModelSpec().params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("health brain prompt", () => {
  it("points at the skill, write scope, and standing facts", () => {
    const prompt = buildHealthBrainPrompt({
      dateKey: "2026-08-20",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /health-brain skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /brain\/health\.md/);
    assert.match(prompt, /takeaways\.md/);
    assert.match(prompt, /history-patterns\.md/);
    assert.match(prompt, /apple-export/);
    assert.match(prompt, /Do not edit patterns\.md/);
    assert.match(prompt, /No diagnoses/);
    assert.match(prompt, /distill history-patterns\.md/);
    assert.match(prompt, /you@example.com/);
  });
});

describe("health brain schedule", () => {
  it("schedules 03:00 in the briefing timezone", () => {
    const when = nextHealthBrainAt(
      META,
      new Date("2026-08-16T20:00:00-05:00")
    );
    assert.equal(when.toISOString(), "2026-08-17T08:00:00.000Z");
  });
});
