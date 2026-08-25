import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AGENT_RECAP_DRAFT_PATH,
  AGENT_RECAP_MODEL_SPEC,
  BRIEFING_NEWS_MODEL_SPEC,
  BRIEFING_UNSLOP_MODEL_SPEC,
  DEFAULT_COMPILE_HM,
  NEWS_DRAFT_PATH,
  NIGHTLY_STATUS_PATH,
  addDaysToDateKey,
  buildAgentRecapPrompt,
  buildNewsPrompt,
  buildUnslopPrompt,
  dueHm,
  isoOnDateKey,
  nextCompileAt,
  prefetchNightlyStatus,
  zonedLocalToUtc,
} from "./daily-briefing-agent.js";

const META = {
  timezone: "America/Chicago",
  compileLocalTime: "06:00",
  dueLocalTime: "07:00",
};

describe("daily briefing schedule", () => {
  it("defaults compile to 06:00", () => {
    assert.equal(DEFAULT_COMPILE_HM, "06:00");
  });

  it("reads due time from meta", () => {
    assert.equal(dueHm(META), "07:00");
    assert.equal(dueHm({}), "07:00");
  });

  it("next compile is 06:00 Chicago before LA switch", () => {
    const when = nextCompileAt(META, new Date("2026-08-16T12:00:00Z"));
    assert.equal(when.toISOString(), "2026-08-17T11:00:00.000Z");
  });
});

describe("isoOnDateKey", () => {
  it("matches calendar date in timezone", () => {
    assert.equal(
      isoOnDateKey("2026-08-22T06:10:35.000Z", "2026-08-22", "America/Chicago"),
      true
    );
    assert.equal(
      isoOnDateKey("2026-08-21T06:10:35.000Z", "2026-08-22", "America/Chicago"),
      false
    );
  });
});

describe("briefing model specs", () => {
  it("news uses grok-4.6 xhigh", () => {
    assert.equal(BRIEFING_NEWS_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(BRIEFING_NEWS_MODEL_SPEC.params, [
      { id: "effort", value: "xhigh" },
      { id: "fast", value: "false" },
    ]);
  });

  it("agent recap uses grok-4.6 high", () => {
    assert.equal(AGENT_RECAP_MODEL_SPEC.id, "grok-4.6");
    assert.deepEqual(AGENT_RECAP_MODEL_SPEC.params, [
      { id: "effort", value: "high" },
      { id: "fast", value: "false" },
    ]);
  });

  it("unslop uses composer-2.5 fast off", () => {
    assert.equal(BRIEFING_UNSLOP_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(BRIEFING_UNSLOP_MODEL_SPEC.params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("briefing phase prompts", () => {
  it("news phase writes draft only", () => {
    const prompt = buildNewsPrompt({
      dateKey: "2026-08-22",
      timezone: "America/Chicago",
      force: false,
      dueTime: "07:00",
    });
    assert.match(prompt, /daily-news skill/);
    assert.match(prompt, /Phase 1/);
    assert.match(prompt, new RegExp(NEWS_DRAFT_PATH.replace(/\//g, "\\/")));
    assert.match(prompt, /Do not write todo\.json/);
    assert.match(prompt, /Do not unslop/);
  });

  it("agent recap phase references status prefetch and recap draft", () => {
    const prompt = buildAgentRecapPrompt({
      dateKey: "2026-08-22",
      timezone: "America/Chicago",
    });
    assert.match(prompt, /agent-recap skill/);
    assert.match(prompt, new RegExp(NIGHTLY_STATUS_PATH.replace(/\//g, "\\/")));
    assert.match(prompt, new RegExp(AGENT_RECAP_DRAFT_PATH.replace(/\//g, "\\/")));
    assert.match(prompt, /URGENT/);
    assert.match(prompt, /noVote/);
  });

  it("unslop phase merges drafts into todo", () => {
    const prompt = buildUnslopPrompt({
      dateKey: "2026-08-22",
      timezone: "America/Chicago",
      force: true,
      dueTime: "07:00",
    });
    assert.match(prompt, /unslop skill/);
    assert.match(prompt, new RegExp(NEWS_DRAFT_PATH.replace(/\//g, "\\/")));
    assert.match(prompt, new RegExp(AGENT_RECAP_DRAFT_PATH.replace(/\//g, "\\/")));
    assert.match(prompt, /agent-recap first/);
    assert.match(prompt, /taste\.md/);
  });
});

describe("prefetchNightlyStatus", () => {
  it("writes structured agent list to nightly status path", async () => {
    const dateKey = "2026-08-22";
    const payload = await prefetchNightlyStatus(dateKey, "America/Chicago");
    const raw = await readFile(NIGHTLY_STATUS_PATH, "utf8");
    const parsed = JSON.parse(raw);

    assert.equal(parsed.dateKey, dateKey);
    assert.equal(parsed.timezone, "America/Chicago");
    assert.equal(parsed.journalKey, addDaysToDateKey(dateKey, -1));
    assert.ok(Array.isArray(parsed.agents));
    assert.equal(parsed.agents.length, 9);
    assert.ok(parsed.agents.every((a) => typeof a.name === "string"));
    assert.ok(parsed.agents.every((a) => typeof a.ran === "boolean"));
    assert.ok(parsed.agents.some((a) => a.name === "context-synthesis"));
    assert.ok(parsed.agents.some((a) => a.name === "canvas-sync"));
    assert.ok(parsed.agents.some((a) => a.name === "fact-check"));
    assert.ok(parsed.brainNotes && typeof parsed.brainNotes === "object");
    assert.equal(payload.dateKey, dateKey);
  });
});

describe("addDaysToDateKey", () => {
  it("steps calendar days", () => {
    assert.equal(addDaysToDateKey("2026-08-22", -1), "2026-08-21");
  });
});

describe("zonedLocalToUtc", () => {
  it("maps 06:00 Chicago on a summer date", () => {
    const when = zonedLocalToUtc("2026-08-22", "06:00", "America/Chicago");
    assert.equal(when.toISOString(), "2026-08-22T11:00:00.000Z");
  });
});
