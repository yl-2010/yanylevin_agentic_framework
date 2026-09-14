import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFE_STATE_CLEANUP_MODEL_SPEC,
  buildLifeStateCleanupPrompt,
  lifeStateCleanupModelSpec,
  nextLifeStateCleanupAt,
} from "./life-state-cleanup-agent.js";

const META = {
  timezone: "America/Chicago",
  timezoneAfter: {
    on: "2026-08-27",
    timezone: "America/Los_Angeles",
  },
  nightlyAgentsLocalTime: "01:00",
  chatTitleRefreshLocalTime: "01:30",
  lifeStateCleanupLocalTime: "01:30",
  contextSynthesisLocalTime: "02:30",
};

describe("life-state cleanup model", () => {
  it("uses grok-4.6 xhigh with Fast off", () => {
    assert.equal(LIFE_STATE_CLEANUP_MODEL_SPEC.id, "grok-4.6");
    const spec = lifeStateCleanupModelSpec();
    assert.equal(spec.id, "grok-4.6");
    assert.deepEqual(spec.params, [
      { id: "effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);
    assert.doesNotMatch(spec.id, /fast/);
  });
});

describe("life-state cleanup prompt", () => {
  it("points at the skill, dump, sources, and rewrite CLI", () => {
    const prompt = buildLifeStateCleanupPrompt({
      dateKey: "2026-09-14",
      timezone: "America/Los_Angeles",
      journalKey: "2026-09-13",
      force: false,
    });
    assert.match(prompt, /life-state-cleanup skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /you@example.com/);
    assert.match(prompt, /2026-09-13/);
    assert.match(prompt, /yanylevin-life-state-cleanup-day\.json/);
    assert.match(prompt, /Screen Time/);
    assert.match(prompt, /iMessage/);
    assert.match(prompt, /school Teams/);
    assert.match(prompt, /rewrite-day 2026-09-13/);
    assert.match(prompt, /yanylevin-life-state-cleanup\.json/);
    assert.doesNotMatch(prompt, /Health-app sleep is real/);
    assert.doesNotMatch(prompt, /Force: re-clean/);
  });

  it("marks force reruns", () => {
    const prompt = buildLifeStateCleanupPrompt({
      dateKey: "2026-09-14",
      timezone: "America/Los_Angeles",
      journalKey: "2026-09-13",
      force: true,
    });
    assert.match(prompt, /Force: re-clean/);
  });
});

describe("life-state cleanup schedule", () => {
  it("schedules 01:30 in the briefing timezone", () => {
    const now = new Date("2026-08-16T20:00:00-05:00");
    const when = nextLifeStateCleanupAt(META, now);
    assert.equal(when.toISOString(), "2026-08-17T06:30:00.000Z");
  });
});
