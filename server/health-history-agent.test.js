import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SUMMER_START,
  formatDayLine,
  ingestHealthPayload,
} from "./health-history-digest.js";
import { ARCHIVE_ONLY_SERIES } from "./health-shortcut-build.js";
import {
  buildHistoryPatternsPrompt,
  buildSummerTakeawaysPrompt,
  healthHistoryModelSpec,
} from "./health-history-agent.js";

describe("health history digest", () => {
  it("keeps shortcut series and drops archive-only on the summer pass", () => {
    const summer = new Map();
    ingestHealthPayload(
      {
        workouts: [
          {
            activity: "Swimming",
            start: "2026-06-10T22:00:00.000Z",
            durationMin: 46,
            distanceMi: 1.1,
            avgHr: 140,
          },
        ],
        sleep: [
          {
            start: "2026-06-10T08:00:00.000Z",
            end: "2026-06-10T14:30:00.000Z",
            value: "Core",
          },
        ],
        series: {
          steps: [{ start: "2026-06-10T18:00:00.000Z", value: 8000 }],
          swimmingDistance: [{ start: "2026-06-10T22:10:00.000Z", value: 500 }],
          physicalEffort: [{ start: "2026-06-10T18:00:00.000Z", value: 2.2 }],
          timeInDaylight: [{ start: "2026-06-10T18:00:00.000Z", value: 40 }],
          uvIndex: [{ start: "2026-06-10T18:00:00.000Z", value: 7 }],
        },
      },
      summer,
      {
        timezone: "America/Chicago",
        startDate: SUMMER_START,
        seriesAllow: ["steps", "swimmingDistance"],
        seriesDeny: ARCHIVE_ONLY_SERIES,
      }
    );
    const row = summer.get("2026-06-10");
    assert.ok(row);
    assert.equal(row.sums.steps, 8000);
    assert.equal(row.sums.swimmingDistance, 500);
    assert.equal(row.sums.physicalEffort, undefined);
    assert.equal(row.sums.timeInDaylight, undefined);
    assert.equal(row.sums.uvIndex, undefined);
    const line = formatDayLine("2026-06-10", row);
    assert.match(line, /Swimming 46m/);
    assert.doesNotMatch(line, /daylight/);
  });
});

describe("health history prompts", () => {
  it("uses composer-2.5 with Fast off", () => {
    const spec = healthHistoryModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
  });

  it("points patterns at the digest and forbids yearly JSON", () => {
    const prompt = buildHistoryPatternsPrompt({ timezone: "America/Chicago" });
    assert.match(prompt, /health-history skill/);
    assert.match(prompt, /digest-history\.md/);
    assert.match(prompt, /history-patterns\.md/);
    assert.match(prompt, /Do not open raw\/apple-export/);
  });

  it("matches nightly takeaways granularity for the summer backfill", () => {
    const prompt = buildSummerTakeawaysPrompt({
      dateKey: "2026-08-20",
      timezone: "America/Chicago",
      start: "2026-06-10",
      end: "2026-08-20",
    });
    assert.match(prompt, /health-takeaways skill/);
    assert.match(prompt, /digest-summer-shortcut\.md/);
    assert.match(prompt, /2026-06-10/);
    assert.match(prompt, /short prose per day/);
    assert.match(prompt, /UV Index/);
    assert.match(prompt, /Workout Effort Score/);
    assert.doesNotMatch(prompt, /raw\/apple-export-\*\.json\. That is the compact/);
  });
});
