import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCATION_BRAIN_MODEL_SPEC,
  buildLocationBrainPrompt,
  locationBrainModelSpec,
  nextLocationBrainAt,
} from "./location-brain-agent.js";

const META = {
  timezone: "America/Chicago",
  nightlyAgentsLocalTime: "01:00",
  contextSynthesisLocalTime: "02:30",
  brainProjectionLocalTime: "03:00",
};

describe("location brain model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(LOCATION_BRAIN_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(locationBrainModelSpec().params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("location brain prompt", () => {
  it("points at the skill, write scope, and 14-day backfill", () => {
    const prompt = buildLocationBrainPrompt({
      dateKey: "2026-08-20",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /location-brain skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /brain\/places/);
    assert.match(prompt, /places\.md/);
    assert.match(prompt, /schema\.md/);
    assert.match(prompt, /\[GPS\]/);
    assert.match(prompt, /Do not edit places\.md/);
    assert.match(prompt, /backfill the last 14 days/);
    assert.match(prompt, /Leon Street Flats/);
    assert.match(prompt, /you@example.com/);
  });
});

describe("location brain schedule", () => {
  it("schedules 03:00 in the briefing timezone", () => {
    const when = nextLocationBrainAt(
      META,
      new Date("2026-08-16T20:00:00-05:00")
    );
    assert.equal(when.toISOString(), "2026-08-17T08:00:00.000Z");
  });
});
