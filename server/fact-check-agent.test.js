import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FACT_CHECK_MODEL_SPEC,
  buildFactCheckPrompt,
  factCheckModelSpec,
  shouldStartFactCheck,
} from "./fact-check-agent.js";

describe("fact-check model", () => {
  it("uses grok-4.6 with xhigh effort and Fast off", () => {
    assert.equal(FACT_CHECK_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(factCheckModelSpec().params, [
      { id: "effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);
  });
});

describe("fact-check prompt", () => {
  it("points at the skill, overnight writes, and speaker rules", () => {
    const prompt = buildFactCheckPrompt({
      dateKey: "2026-08-24",
      timezone: "America/Chicago",
      journalKey: "2026-08-23",
      force: false,
    });
    assert.match(prompt, /nightly-fact-check skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /you@example.com/);
    assert.match(prompt, /journal\/2026-08-23\.md/);
    assert.match(prompt, /who\/fromMe/);
    assert.match(prompt, /JSON at is UTC/);
    assert.match(prompt, /Mail claims/);
    assert.match(prompt, /timezoneAfter is not a boarding pass/);
    assert.match(prompt, /notes\.factCheck/);
    assert.match(prompt, /Do not compile news/);
    assert.match(prompt, /America\/Los_Angeles/);
    assert.match(prompt, /2026-08-26/);
  });
});

describe("fact-check start gate", () => {
  it("waits until both 03:00 agents have run", () => {
    assert.deepEqual(
      shouldStartFactCheck({
        locationBrainRan: false,
        healthBrainRan: false,
        factCheckRan: false,
      }),
      { start: false, reason: "waiting-for-brain" }
    );
    assert.deepEqual(
      shouldStartFactCheck({
        locationBrainRan: true,
        healthBrainRan: false,
        factCheckRan: false,
      }),
      { start: false, reason: "waiting-for-brain" }
    );
    assert.deepEqual(
      shouldStartFactCheck({
        locationBrainRan: false,
        healthBrainRan: true,
        factCheckRan: false,
      }),
      { start: false, reason: "waiting-for-brain" }
    );
  });

  it("starts once both projections are done", () => {
    assert.deepEqual(
      shouldStartFactCheck({
        locationBrainRan: true,
        healthBrainRan: true,
        factCheckRan: false,
      }),
      { start: true, reason: "projections-done" }
    );
  });

  it("skips when today's fact-check already ran", () => {
    assert.deepEqual(
      shouldStartFactCheck({
        locationBrainRan: true,
        healthBrainRan: true,
        factCheckRan: true,
      }),
      { start: false, reason: "already-ran" }
    );
  });
});
