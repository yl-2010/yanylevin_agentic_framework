import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appleDateToIso,
  parseAttrs,
  parseExportXmlLines,
  sleepForDumpWindow,
  workoutActivityName,
  RECORD_TYPE_MAP,
} from "./health-apple-export.js";

const SAMPLE_XML = `
<HealthData locale="en_US">
 <ExportDate value="2026-08-20 15:22:23 -0500"/>
 <Record type="HKQuantityTypeIdentifierHeartRate" startDate="2026-03-21 10:00:00 -0500" endDate="2026-03-21 10:00:00 -0500" value="140"/>
 <Record type="HKQuantityTypeIdentifierStepCount" startDate="2026-03-21 10:00:00 -0500" endDate="2026-03-21 10:05:00 -0500" value="42"/>
 <Record type="HKQuantityTypeIdentifierWorkoutEffortScore" unit="appleEffortScore" startDate="2026-02-18 14:59:49 -0500" endDate="2026-02-18 16:59:24 -0500" value="3"/>
 <Record type="HKQuantityTypeIdentifierDistanceSwimming" unit="yd" startDate="2026-02-28 17:48:29 -0500" endDate="2026-02-28 17:49:50 -0500" value="25"/>
 <Record type="HKQuantityTypeIdentifierTimeInDaylight" unit="min" startDate="2026-03-21 10:03:57 -0500" endDate="2026-03-21 10:08:57 -0500" value="5"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" startDate="2026-03-20 23:00:00 -0500" endDate="2026-03-21 06:30:00 -0500" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierMindfulSession" startDate="2023-03-14 13:59:51 -0500" endDate="2023-03-14 14:00:51 -0500" value="HKCategoryValueNotApplicable"/>
 <Workout workoutActivityType="HKWorkoutActivityTypeRunning" duration="20" durationUnit="min" sourceName="Yan’s Apple Watch" startDate="2026-08-20 20:28:00 -0500" endDate="2026-08-20 20:48:00 -0500">
  <WorkoutStatistics type="HKQuantityTypeIdentifierHeartRate" average="171" unit="count/min"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierDistanceWalkingRunning" sum="1.65" unit="mi"/>
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="122" unit="Cal"/>
 </Workout>
</HealthData>
`.trim();

describe("Apple Health XML export parser", () => {
  it("parses Apple timestamps and workout names", () => {
    assert.equal(appleDateToIso("2026-03-21 10:03:57 -0500"), "2026-03-21T15:03:57.000Z");
    assert.equal(
      workoutActivityName("HKWorkoutActivityTypeTraditionalStrengthTraining"),
      "Traditional Strength Training"
    );
    assert.equal(parseAttrs('x="1" y="two"').y, "two");
    assert.ok(RECORD_TYPE_MAP.HKQuantityTypeIdentifierPhysicalEffort);
  });

  it("keeps mapped series, sleep, workouts; drops heart-rate beats", async () => {
    const { byYear, exportedAt, records, skippedHr } = await parseExportXmlLines(
      SAMPLE_XML.split("\n")
    );
    assert.equal(exportedAt, "2026-08-20T20:22:23.000Z");
    assert.equal(skippedHr, 1);
    assert.equal(records, 6);
    const y2026 = byYear.get("2026");
    const y2023 = byYear.get("2023");
    assert.ok(y2026);
    assert.equal(y2026.series.steps[0].value, 42);
    assert.equal(y2026.series.effortScore[0].value, 3);
    assert.equal(y2026.series.swimmingDistance[0].value, 25);
    assert.equal(y2026.series.timeInDaylight[0].value, 5);
    assert.equal(y2026.sleep[0].value, "Core");
    assert.equal(y2026.workouts[0].activity, "Running");
    assert.equal(y2026.workouts[0].avgHr, 171);
    assert.equal(y2026.workouts[0].distanceMi, 1.65);
    assert.equal(y2026.workouts[0].energyKcal, 122);
    assert.equal(y2023.series.mindful[0].value, 1);
    assert.equal(y2026.series.steps[0].end, "2026-03-21T15:05:00.000Z");
  });

  it("sleepOnly keeps sleep and skips series and workouts", async () => {
    const { byYear, records, skippedHr } = await parseExportXmlLines(
      SAMPLE_XML.split("\n"),
      { sleepOnly: true }
    );
    assert.equal(records, 1);
    assert.equal(skippedHr, 1);
    const y2026 = byYear.get("2026");
    assert.ok(y2026);
    assert.equal(y2026.sleep.length, 1);
    assert.equal(y2026.sleep[0].value, "Core");
    assert.equal(y2026.workouts.length, 0);
    assert.deepEqual(y2026.series, {});
    assert.equal(byYear.has("2023"), false);
  });

  it("sleepForDumpWindow keeps the old range unless includeNewer", () => {
    const all = [
      { start: "2026-08-16T01:00:00.000Z", value: "Core" },
      { start: "2026-08-18T09:00:00.000Z", value: "Deep" },
      { start: "2026-08-20T01:00:00.000Z", value: "REM" },
      { start: "2026-08-21T01:00:00.000Z", value: "Awake" },
    ];
    const existing = [
      { start: "2026-08-18T08:52:00.000Z" },
      { start: "2026-08-20T15:51:00.000Z" },
    ];
    const windowed = sleepForDumpWindow(all, existing);
    assert.deepEqual(
      windowed.map((s) => s.start),
      ["2026-08-18T09:00:00.000Z", "2026-08-20T01:00:00.000Z"]
    );
    const newest = sleepForDumpWindow(all, existing, { includeNewer: true });
    assert.deepEqual(
      newest.map((s) => s.start),
      ["2026-08-18T09:00:00.000Z", "2026-08-20T01:00:00.000Z", "2026-08-21T01:00:00.000Z"]
    );
  });
});
