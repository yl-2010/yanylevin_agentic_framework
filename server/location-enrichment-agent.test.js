import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LOCATION_ENRICHMENT_MODEL_SPEC,
  buildLocationEnrichmentPrompt,
  locationEnrichmentModelSpec,
  nextLocationEnrichmentAt,
} from "./location-enrichment-agent.js";

const META = {
  timezone: "America/Chicago",
  nightlyAgentsLocalTime: "01:00",
  contextSynthesisLocalTime: "02:30",
};

describe("location enrichment model", () => {
  it("uses grok-4.6 high with Fast off", () => {
    assert.equal(LOCATION_ENRICHMENT_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(locationEnrichmentModelSpec().params, [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });
});

describe("location enrichment prompt", () => {
  it("points at the skill and context sources", () => {
    const prompt = buildLocationEnrichmentPrompt({
      dateKey: "2026-08-16",
      timezone: "America/Chicago",
      force: false,
    });
    assert.match(prompt, /location-enrichment skill/);
    assert.match(prompt, /places\.md/);
    assert.match(prompt, /trips\.md is unfinished/);
    assert.match(prompt, /generic car/i);
    assert.match(prompt, /iMessage/);
    assert.match(prompt, /Mail\.app/);
    assert.match(prompt, /Calendar/);
    assert.match(prompt, /\.chat-history\//);
    assert.match(prompt, /past-chats/);
    assert.match(prompt, /Chat history is a required source/);
    assert.match(prompt, /Exchange Inbox/);
    assert.match(prompt, /tesla\.com/);
    assert.match(prompt, /INBOX/);
    assert.match(prompt, /uber/i);
    assert.match(prompt, /robotaxi/i);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /backfill the last 14 days/);
    assert.match(prompt, /already named a stay/);
  });
});

describe("location enrichment schedule", () => {
  it("schedules 01:00 in the briefing timezone", () => {
    const when = nextLocationEnrichmentAt(
      META,
      new Date("2026-08-16T20:00:00-05:00")
    );
    assert.equal(when.toISOString(), "2026-08-17T06:00:00.000Z");
  });
});
