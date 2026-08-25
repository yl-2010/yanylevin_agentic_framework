import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCATION_HISTORY_MODEL_SPEC,
  buildLocationHistoryPrompt,
  locationHistoryModelSpec,
  nextLocationHistoryAt,
  nextLocalHmAt,
} from "./location-history-agent.js";

const META = {
  timezone: "America/Chicago",
  timezoneAfter: {
    on: "2026-08-27",
    timezone: "America/Los_Angeles",
  },
  nightlyAgentsLocalTime: "01:00",
};

describe("location history model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(LOCATION_HISTORY_MODEL_SPEC.id, "composer-2.5");
    const spec = locationHistoryModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
    assert.doesNotMatch(spec.id, /fast/);
  });
});

describe("location history prompt", () => {
  it("points at the skill, Mail receipts, and stays local", () => {
    const prompt = buildLocationHistoryPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /location-history skill/);
    assert.match(prompt, /Mail\.app/);
    assert.match(prompt, /Seattle/);
    assert.match(prompt, /uber/i);
    assert.match(prompt, /robotaxi/i);
    assert.match(prompt, /ONLY when a new stay is outside/);
    assert.match(prompt, /Skip mail entirely at home/);
    assert.match(prompt, /already-specific stay names/);
    assert.doesNotMatch(prompt, /light search at home/);
    assert.doesNotMatch(prompt, /Do not git add/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
  });
});

describe("location history schedule", () => {
  it("prefers now+4h when that is before 01:00", () => {
    const now = new Date("2026-08-16T15:00:00.000Z");
    const next = nextLocationHistoryAt(META, now);
    assert.equal(next.toISOString(), "2026-08-16T19:00:00.000Z");
  });

  it("prefers 01:00 local when that is sooner than +4h", () => {
    const now = new Date("2026-08-17T04:30:00.000Z");
    const close = nextLocalHmAt(META, "01:00", now);
    const next = nextLocationHistoryAt(META, now);
    assert.equal(next.toISOString(), close.toISOString());
    assert.equal(close.toISOString(), "2026-08-17T06:00:00.000Z");
  });
});
