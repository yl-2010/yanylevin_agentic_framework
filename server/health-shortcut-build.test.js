import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SAMPLE_LOOKBACK_DAYS,
  SAMPLE_FIND_LIMIT,
  WORKOUT_FIND_LIMIT,
  SHORTCUT_EXCLUDED_LABELS,
  HEALTH_SAMPLE_SERIES,
  buildWorkflow,
} from "./health-shortcut-build.js";

describe("Yan Health Sync workflow", () => {
  it("uses Actions Find Workout and Find Health Samples for the rest", () => {
    const wf = buildWorkflow({
      token: "__HEALTH_INGEST_TOKEN__",
      url: "__HEALTH_INGEST_URL__",
    });
    const workoutFind = wf.WFWorkflowActions.find(
      (a) =>
        a.WFWorkflowActionIdentifier ===
        "com.sindresorhus.Actions.WorkoutAppEntity"
    );
    assert.ok(workoutFind);
    const wp = workoutFind.WFWorkflowActionParameters;
    assert.equal(wp.WFContentItemSortProperty, "startDate");
    assert.equal(wp.WFContentItemSortOrder, "Latest First");
    assert.equal(wp.WFContentItemLimitEnabled, true);
    assert.equal(wp.WFContentItemLimitNumber, WORKOUT_FIND_LIMIT);
    assert.equal(
      wp.AppIntentDescriptor.BundleIdentifier,
      "com.sindresorhus.Actions"
    );
    assert.equal(wp.AppIntentDescriptor.AppIntentIdentifier, "WorkoutAppEntity");
    const healthFinds = wf.WFWorkflowActions.filter(
      (a) =>
        a.WFWorkflowActionIdentifier ===
        "is.workflow.actions.filter.health.quantity"
    );
    assert.equal(
      healthFinds.some((a) => {
        const type =
          a.WFWorkflowActionParameters.WFContentItemFilter.Value
            .WFActionParameterFilterTemplates[0].Values.Enumeration.Value;
        return type === "Workouts";
      }),
      false
    );
    const typeOf = (action) =>
      action.WFWorkflowActionParameters.WFContentItemFilter.Value
        .WFActionParameterFilterTemplates[0].Values.Enumeration.Value;
    const daysOf = (action) =>
      action.WFWorkflowActionParameters.WFContentItemFilter.Value
        .WFActionParameterFilterTemplates[1].Values.Number;
    const unitOf = (action) =>
      action.WFWorkflowActionParameters.WFContentItemFilter.Value
        .WFActionParameterFilterTemplates[1].Values.Unit;
    const byType = Object.fromEntries(
      healthFinds.map((a) => [typeOf(a), daysOf(a)])
    );
    assert.equal(byType.Sleep, String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(SAMPLE_LOOKBACK_DAYS, 2);
    assert.equal(WORKOUT_FIND_LIMIT, 20);
    assert.equal(byType.Steps, String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Active Calories"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Exercise Time"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Stand Time"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Sleep Wrist Temperature"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Mindful Session"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Heart Rate Recovery, 1 min"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Walking Speed"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Step Length"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Double Support Time"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Walking Asymmetry"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Stair Speed: Up"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Stair Speed: Down"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Running Power"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Running Speed"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Running Stride Length"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Running Ground Contact Time"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Running Vertical Oscillation"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Environmental Audio Exposure"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Headphone Audio Exposure"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Swimming Distance"], String(SAMPLE_LOOKBACK_DAYS));
    assert.equal(byType["Cycling Distance"], String(SAMPLE_LOOKBACK_DAYS));
    for (const label of SHORTCUT_EXCLUDED_LABELS) {
      assert.ok(!(label in byType), label);
    }
    for (const series of HEALTH_SAMPLE_SERIES) {
      assert.equal(series.days, SAMPLE_LOOKBACK_DAYS, series.label);
      assert.equal(byType[series.label], String(SAMPLE_LOOKBACK_DAYS), series.label);
    }
    for (const action of healthFinds) {
      assert.equal(daysOf(action), String(SAMPLE_LOOKBACK_DAYS));
      assert.notEqual(daysOf(action), "14");
    }
    assert.ok(!("Time in Daylight" in byType));
    assert.ok(!("Physical Effort" in byType));
    assert.ok(!("Cycling Speed" in byType));
    assert.ok(!("Cycling Cadence" in byType));
    assert.ok(!("State of Mind" in byType));
    assert.ok(!("Cardio Recovery" in byType));
    assert.ok(!("Exercise Minutes" in byType));
    assert.ok(!("Stand Hours" in byType));
    assert.ok(!("Blood Oxygen" in byType));
    assert.ok(!("Weight" in byType));
    assert.ok(!("Wrist Temperature" in byType));
    assert.ok(!("Mindful Minutes" in byType));
    for (const action of healthFinds) {
      assert.equal(unitOf(action), 16);
      assert.equal(action.WFWorkflowActionParameters.WFContentItemLimitEnabled, true);
      assert.equal(
        action.WFWorkflowActionParameters.WFContentItemLimitNumber,
        SAMPLE_FIND_LIMIT
      );
    }
    assert.equal(
      wf.WFWorkflowActions.some(
        (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.properties"
      ),
      false
    );
    const workoutVars = wf.WFWorkflowActions.filter(
      (a) =>
        a.WFWorkflowActionIdentifier === "is.workflow.actions.setvariable" &&
        String(a.WFWorkflowActionParameters.WFVariableName).startsWith("workout") &&
        !String(a.WFWorkflowActionParameters.WFVariableName).startsWith("workoutEffort")
    );
    const aggProps = workoutVars.map(
      (a) =>
        a.WFWorkflowActionParameters.WFInput.Value.Aggrandizements[0]
          .PropertyName
    );
    assert.ok(aggProps.includes("Workout Type"));
    assert.ok(aggProps.includes("Start Date"));
    assert.ok(aggProps.includes("Active Calories (kcal)"));
    const download = wf.WFWorkflowActions.find(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
    );
    assert.equal(download.WFWorkflowActionParameters.WFHTTPMethod, "POST");
    assert.equal(
      download.WFWorkflowActionParameters.WFURL,
      "__HEALTH_INGEST_URL__"
    );
    const auth = download.WFWorkflowActionParameters.WFHTTPHeaders.Value
      .WFDictionaryFieldValueItems.find(
        (item) => item.WFKey.Value.string === "Authorization"
      );
    const jsonKeys = download.WFWorkflowActionParameters.WFJSONValues.Value
      .WFDictionaryFieldValueItems.map((item) => item.WFKey.Value.string);
    assert.ok(jsonKeys.includes("workouts"));
    assert.ok(jsonKeys.includes("workoutStarts"));
    assert.ok(jsonKeys.includes("sleepStarts"));
    assert.ok(jsonKeys.includes("cardioRecoveryStarts"));
    assert.ok(jsonKeys.includes("swimmingDistanceStarts"));
    assert.ok(jsonKeys.includes("cyclingDistanceStarts"));
    assert.ok(!jsonKeys.includes("effortScoreStarts"));
    assert.ok(!jsonKeys.includes("uvIndexStarts"));
    assert.ok(!jsonKeys.includes("stateOfMindStarts"));
    assert.ok(!jsonKeys.includes("cyclingSpeedStarts"));
    assert.ok(!jsonKeys.includes("cyclingCadenceStarts"));
    const notify = wf.WFWorkflowActions.find(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.notification"
    );
    assert.equal(
      notify.WFWorkflowActionParameters.WFNotificationActionBody,
      "Health dump did not reach the Mac."
    );
    assert.equal(
      wf.WFWorkflowActions.some(
        (a) =>
          a.WFWorkflowActionIdentifier === "is.workflow.actions.notification" &&
          a.WFWorkflowActionParameters.WFNotificationActionBody ===
            "Health dump sent to the Mac."
      ),
      false
    );
    const receivedValue = wf.WFWorkflowActions.find(
      (a) =>
        a.WFWorkflowActionIdentifier === "is.workflow.actions.getvalueforkey" &&
        a.WFWorkflowActionParameters.WFDictionaryKey === "received"
    );
    assert.ok(receivedValue);
    const ifActions = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
    );
    assert.deepEqual(
      ifActions.map((a) => a.WFWorkflowActionParameters.WFControlFlowMode),
      [0, 1, 2]
    );
    const ifStart = ifActions[0];
    assert.equal(ifStart.WFWorkflowActionParameters.WFCondition, 4);
    assert.equal(ifStart.WFWorkflowActionParameters.WFConditionalActionString, "yes");
    assert.equal(ifStart.WFWorkflowActionParameters.WFInput.Type, "Variable");
    assert.equal(ifStart.WFWorkflowActionParameters.WFConditions, undefined);
    const notifyIndex = wf.WFWorkflowActions.indexOf(notify);
    const otherwiseIndex = wf.WFWorkflowActions.indexOf(ifActions[1]);
    assert.ok(notifyIndex > otherwiseIndex);
  });
});
