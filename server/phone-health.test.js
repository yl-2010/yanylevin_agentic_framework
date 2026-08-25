import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHealthPayload,
  normalizeWorkout,
  zipSeries,
  mergeWorkoutsMarkdown,
  formatWorkoutLine,
  writeHealthDump,
  hasUnprocessedHealthDumps,
  isShortcutHealthRawFile,
  readHealthState,
  writeHealthState,
  workoutKey,
  HEALTH_TIMEZONE,
  HEALTH_AUSTIN_TIMEZONE,
  healthTimezoneForIso,
  dedupeTwoHourWorkoutCopies,
  buildWorkoutsMarkdown,
  repairHealthSeattleTimezone,
} from "./phone-health.js";

describe("parseHealthPayload", () => {
  it("rejects empty junk", () => {
    assert.equal(parseHealthPayload(null), null);
    assert.equal(parseHealthPayload({}), null);
    assert.equal(parseHealthPayload("nope"), null);
  });

  it("keeps workouts, sleep, and series from object lists", () => {
    const h = parseHealthPayload({
      exportedAt: "2026-08-20T03:00:00.000Z",
      workouts: [
        {
          activity: "Running",
          start: "2026-08-20T01:13:00.000Z",
          end: "2026-08-20T01:21:00.000Z",
          durationMin: 8,
          distanceMi: 1,
          energyKcal: 120,
          avgHr: 148,
        },
      ],
      sleep: [
        {
          start: "2026-08-19T05:00:00.000Z",
          end: "2026-08-19T12:30:00.000Z",
          name: "Asleep",
        },
      ],
      steps: [{ start: "2026-08-19T12:00:00.000Z", value: 8421 }],
      restingHr: [{ start: "2026-08-19T12:00:00.000Z", value: 58 }],
    });
    assert.equal(h.workouts.length, 1);
    assert.equal(h.workouts[0].activity, "Running");
    assert.equal(h.workouts[0].avgHr, 148);
    assert.equal(h.sleep.length, 1);
    assert.equal(h.series.steps[0].value, 8421);
    assert.equal(h.series.restingHr[0].value, 58);
  });

  it("zips parallel arrays from the Shortcut", () => {
    const h = parseHealthPayload({
      workoutStarts: ["2026-08-19T18:00:00.000Z"],
      workoutNames: ["Traditional Strength Training"],
      workoutDurations: [55],
      workoutEnergies: [280],
      stepsStarts: ["2026-08-19T00:00:00.000Z", "2026-08-18T00:00:00.000Z"],
      stepsValues: [9000, 7500],
    });
    assert.equal(h.workouts[0].activity, "Traditional Strength Training");
    assert.equal(h.workouts[0].durationMin, 55);
    assert.equal(h.series.steps.length, 2);
    assert.equal(h.series.steps[1].value, 7500);
  });

  it("zips new series including State of Mind names", () => {
    const h = parseHealthPayload({
      timeInDaylightStarts: ["2026-08-20T18:00:00.000Z"],
      timeInDaylightValues: [42],
      stateOfMindStarts: ["2026-08-20T16:00:00.000Z"],
      stateOfMindValues: [0.6],
      stateOfMindNames: ["Happy"],
    });
    assert.equal(h.series.timeInDaylight[0].value, 42);
    assert.equal(h.series.stateOfMind[0].value, 0.6);
    assert.equal(h.series.stateOfMind[0].name, "Happy");
  });

  it("parses iPhone Shortcuts locale dates so workouts are not dropped", () => {
    const h = parseHealthPayload({
      workoutStarts: ["Aug 19, 2026 at 18:00"],
      workoutEnds: ["Aug 19, 2026 at 18:55"],
      workoutNames: ["Traditional Strength Training"],
      workoutDurations: [55],
      sleepStarts: ["Aug 20, 2026 at 08:51"],
      sleepEnds: ["Aug 20, 2026 at 08:55"],
      sleepValues: ["Core"],
      sleepNames: ["Health sample"],
    });
    assert.equal(h.workouts.length, 1);
    assert.equal(Number.isNaN(Date.parse(String(h.workouts[0].start))), false);
    assert.equal(h.workouts[0].durationMin, 55);
    assert.equal(h.sleep.length, 1);
    assert.equal(Number.isNaN(Date.parse(String(h.sleep[0].start))), false);
    assert.equal(Number.isNaN(Date.parse(String(h.sleep[0].end))), false);
    assert.equal(h.sleep[0].value, "Core");
  });
});

describe("normalizeWorkout", () => {
  it("requires a start time", () => {
    assert.equal(normalizeWorkout({ activity: "Run" }), null);
  });

  it("uses start and end when Actions sends duration in seconds", () => {
    const w = normalizeWorkout({
      name: "Walking",
      start: "2026-08-04T12:08:00.000Z",
      end: "2026-08-04T12:16:00.000Z",
      duration: 503,
    });
    assert.equal(w.durationMin, 8);
  });

  it("parses clock durations", () => {
    const w = normalizeWorkout({
      name: "Cycling",
      start: "2026-08-01T10:00:00.000Z",
      duration: "1:15",
      distance: "12 km",
    });
    assert.equal(w.durationMin, 75);
    assert.equal(w.distanceMi, 7.46);
  });

  it("reads Actions Find Workout field names", () => {
    const w = normalizeWorkout({
      workoutType: "Traditional Strength Training",
      startDate: "2026-08-19T18:00:00.000Z",
      endDate: "2026-08-19T19:00:00.000Z",
      duration: 55,
      activeCalories: 280,
      averageHeartRate: 142,
      sourceName: "Apple Watch",
      totalDistance: 0,
    });
    assert.equal(w.activity, "Traditional Strength Training");
    assert.equal(w.durationMin, 60);
    assert.equal(w.avgHr, 142);
    assert.equal(w.source, "Apple Watch");
  });
});

describe("zipSeries", () => {
  it("pairs starts with values", () => {
    const rows = zipSeries(
      ["2026-08-19T00:00:00.000Z"],
      [42],
      { unit: ["count"] }
    );
    assert.equal(rows[0].value, 42);
    assert.equal(rows[0].unit, "count");
  });
});

describe("workouts markdown", () => {
  it("formats a line and merges without wiping older days", () => {
    const tz = "America/Chicago";
    const line = formatWorkoutLine(
      {
        activity: "Running",
        start: "2026-08-20T01:13:00.000Z",
        end: "2026-08-20T01:21:00.000Z",
        durationMin: 8,
        distanceMi: 1,
        energyKcal: 120,
        avgHr: 148,
      },
      tz
    );
    assert.match(line, /\*\*Running\*\*/);
    assert.match(line, /20:13/);
    assert.match(line, /8m/);
    assert.match(line, /avg HR 148/);

    const existing = `# Workouts

## 2026-08-16

- **Traditional Strength Training** 18:00–18:45 (45m) — 280 kcal
`;
    const merged = mergeWorkoutsMarkdown(
      [
        {
          activity: "Running",
          start: "2026-08-20T01:13:00.000Z",
          durationMin: 8,
        },
      ],
      existing,
      tz
    );
    assert.match(merged, /2026-08-19/);
    assert.match(merged, /2026-08-16/);
    assert.match(merged, /Traditional Strength Training/);
    assert.equal(
      workoutKey({ activity: "Running", start: "2026-08-20T01:13:00.000Z" }),
      "2026-08-20T01:13:00|running"
    );
  });

  it("keeps the earlier copy of a two-hour Watch duplicate", () => {
    const kept = dedupeTwoHourWorkoutCopies([
      {
        activity: "Running",
        start: "2026-08-20T01:28:00.000Z",
        durationMin: 20,
        energyKcal: 122,
        avgHr: 171,
      },
      {
        activity: "Running",
        start: "2026-08-19T23:28:00.000Z",
        durationMin: 21,
        energyKcal: 122,
        avgHr: 171,
      },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].start, "2026-08-19T23:28:00.000Z");
  });

  it("shows evening swim team at 18:30 in Seattle, not 20:30 Chicago", () => {
    const w = {
      activity: "Swimming",
      start: "2024-10-10T01:31:28.000Z",
      end: "2024-10-10T03:17:00.000Z",
      durationMin: 106,
    };
    assert.match(formatWorkoutLine(w, HEALTH_TIMEZONE), /18:31/);
    assert.doesNotMatch(formatWorkoutLine(w, HEALTH_TIMEZONE), /20:31/);
    const md = buildWorkoutsMarkdown([w], HEALTH_TIMEZONE);
    assert.match(md, /2024-10-09/);
    assert.match(md, /18:31/);
  });

  it("uses Austin clock after 2026-08-12 and Seattle on Aug 12", () => {
    const austinRun = {
      activity: "Running",
      start: "2026-08-19T23:28:00.000Z",
      end: "2026-08-19T23:48:00.000Z",
      durationMin: 21,
    };
    assert.equal(healthTimezoneForIso(austinRun.start), HEALTH_AUSTIN_TIMEZONE);
    assert.match(formatWorkoutLine(austinRun), /18:28/);
    const seattleWalk = {
      activity: "Walking",
      start: "2026-08-13T01:43:53.000Z",
      end: "2026-08-13T02:09:00.000Z",
      durationMin: 26,
    };
    assert.equal(healthTimezoneForIso(seattleWalk.start), HEALTH_TIMEZONE);
    assert.match(formatWorkoutLine(seattleWalk), /18:43/);
    const md = buildWorkoutsMarkdown([austinRun, seattleWalk]);
    assert.match(md, /2026-08-19/);
    assert.match(md, /18:28/);
    assert.match(md, /2026-08-12/);
    assert.match(md, /18:43/);
  });
});

describe("writeHealthDump", () => {
  it("writes raw JSON, jsonl, workouts.md, and state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phone-health-"));
    try {
      const saved = await writeHealthDump(
        {
          workouts: [
            {
              activity: "Running",
              start: "2026-08-20T01:13:00.000Z",
              durationMin: 8,
              distanceMi: 1,
            },
          ],
        },
        { dir, timezone: "America/Chicago", git: false, source: "shortcut" }
      );
      assert.ok(saved.receivedAt);
      assert.equal(saved.workoutCount, 1);
      const raw = JSON.parse(
        await readFile(join(dir, saved.rawFile), "utf8")
      );
      assert.equal(raw.source, "shortcut");
      const md = await readFile(join(dir, "workouts.md"), "utf8");
      assert.match(md, /Running/);
      const state = await readHealthState(dir);
      assert.ok(state.lastIngestAt);
      assert.equal(await hasUnprocessedHealthDumps(dir), true);
      await writeHealthState(
        { ...state, lastTakeawaysAt: new Date(Date.now() + 1000).toISOString() },
        dir
      );
      assert.equal(await hasUnprocessedHealthDumps(dir), false);
      await mkdir(join(dir, "raw"), { recursive: true });
      await writeFile(
        join(dir, "raw", "apple-export-2026.json"),
        JSON.stringify({
          schemaVersion: 1,
          receivedAt: new Date(Date.now() + 60_000).toISOString(),
          workouts: [],
          sleep: [],
          series: { steps: [{ start: "2026-01-01T00:00:00.000Z", value: 1 }] },
        }),
        "utf8"
      );
      assert.equal(isShortcutHealthRawFile("apple-export-2026.json"), false);
      assert.equal(await hasUnprocessedHealthDumps(dir), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects an empty body", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phone-health-empty-"));
    try {
      await assert.rejects(
        () => writeHealthDump({ hello: 1 }, { dir, git: false }),
        /empty or invalid/
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("repairHealthSeattleTimezone", () => {
  it("shifts shortcut workouts back two hours and rebuilds Seattle markdown", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phone-health-seattle-"));
    try {
      await mkdir(join(dir, "raw"), { recursive: true });
      await writeFile(
        join(dir, "raw", "apple-export-2026.json"),
        `${JSON.stringify({
          timezone: "America/Chicago",
          workouts: [
            {
              activity: "Swimming",
              start: "2024-10-10T01:31:28.000Z",
              end: "2024-10-10T03:17:00.000Z",
              durationMin: 106,
              energyKcal: 200,
              avgHr: 140,
            },
          ],
        })}\n`,
        "utf8"
      );
      await writeFile(
        join(dir, "raw", "2026-08-20T180215Z.json"),
        `${JSON.stringify(
          {
            timezone: "America/Chicago",
            workouts: [
              {
                activity: "Swimming",
                start: "2024-10-10T03:31:28.000Z",
                end: "2024-10-10T05:17:00.000Z",
                durationMin: 106,
                energyKcal: 200,
                avgHr: 140,
              },
            ],
          },
          null,
          2
        )}\n`,
        "utf8"
      );
      const result = await repairHealthSeattleTimezone({ dir });
      assert.equal(result.shiftedWorkouts, 1);
      const shortcut = JSON.parse(
        await readFile(join(dir, "raw", "2026-08-20T180215Z.json"), "utf8")
      );
      assert.equal(shortcut.timezone, "America/Los_Angeles");
      assert.equal(shortcut.workouts[0].start, "2024-10-10T01:31:28.000Z");
      const exported = JSON.parse(
        await readFile(join(dir, "raw", "apple-export-2026.json"), "utf8")
      );
      assert.equal(exported.timezone, "America/Los_Angeles");
      const md = await readFile(join(dir, "workouts.md"), "utf8");
      assert.match(md, /18:31/);
      assert.equal((md.match(/Swimming/g) || []).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
