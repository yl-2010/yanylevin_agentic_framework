import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  HEALTH_TAKEAWAYS_MODEL_SPEC,
  buildHealthTakeawaysPrompt,
  healthTakeawaysModelSpec,
  nextHealthTakeawaysAt,
} from "./health-takeaways-agent.js";
import { nextLocalHmAt } from "./location-history-agent.js";

const META = {
  timezone: "America/Chicago",
  timezoneAfter: {
    on: "2026-08-27",
    timezone: "America/Los_Angeles",
  },
  nightlyAgentsLocalTime: "01:00",
};

describe("health takeaways model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(HEALTH_TAKEAWAYS_MODEL_SPEC.id, "composer-2.5");
    const spec = healthTakeawaysModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
    assert.doesNotMatch(spec.id, /fast/);
  });
});

describe("health takeaways prompt", () => {
  it("points at the skill, workouts, and takeaways.md", () => {
    const prompt = buildHealthTakeawaysPrompt({
      dateKey: "2026-08-20",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /health-takeaways skill/);
    assert.match(prompt, /education\/you@example.com\/health/);
    assert.match(prompt, /workouts\.md/);
    assert.match(prompt, /takeaways\.md/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /Do not invent diagnoses/);
    assert.match(prompt, /apple-export/);
  });
});

describe("health takeaways schedule", () => {
  it("fires at 01:00 local", () => {
    const now = new Date("2026-08-17T04:30:00.000Z");
    const close = nextLocalHmAt(META, "01:00", now);
    const next = nextHealthTakeawaysAt(META, now);
    assert.equal(next.toISOString(), close.toISOString());
    assert.equal(close.toISOString(), "2026-08-17T06:00:00.000Z");
  });
});
