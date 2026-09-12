import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_URL,
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  SHORTCUT_SPECS,
  buildWorkflow,
} from "./life-state-shortcut-build.js";

function jsonOf(action) {
  return Object.fromEntries(
    action.WFWorkflowActionParameters.WFJSONValues.Value.WFDictionaryFieldValueItems.map(
      (item) => [item.WFKey.Value.string, item.WFValue.Value.string]
    )
  );
}

describe("Yan life-state Shortcuts", () => {
  it("ships two plugged_in copies first, then shower and sleep", () => {
    const wf = buildWorkflow({
      token: TOKEN_PLACEHOLDER,
      url: URL_PLACEHOLDER,
    });
    const downloads = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
    );
    assert.equal(downloads.length, 4);
    assert.equal(
      wf.WFWorkflowActions.some(
        (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.setvariable"
      ),
      false
    );
    assert.deepEqual(downloads.map(jsonOf), [
      { intent: "plugged_in" },
      { intent: "plugged_in" },
      { intent: "going_to_shower", orientation: "portrait" },
      { intent: "going_to_sleep", orientation: "landscape" },
    ]);
    const pluggedIds = downloads.slice(0, 2).map((a) => a.WFWorkflowActionParameters.UUID);
    assert.equal(pluggedIds[0] !== pluggedIds[1], true);
    for (const download of downloads) {
      assert.equal(download.WFWorkflowActionParameters.WFHTTPMethod, "POST");
      assert.equal(download.WFWorkflowActionParameters.WFURL, URL_PLACEHOLDER);
    }
    assert.equal(DEFAULT_URL.endsWith("/api/education/life-state-intent"), true);
  });

  it("ships one-shot unplug, driving focus, and tesla shortcuts", () => {
    const kinds = SHORTCUT_SPECS.slice(1).map((spec) => {
      const wf = buildWorkflow({ spec, token: TOKEN_PLACEHOLDER, url: URL_PLACEHOLDER });
      const downloads = wf.WFWorkflowActions.filter(
        (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
      );
      assert.equal(downloads.length, 1);
      return jsonOf(downloads[0]).intent;
    });
    assert.deepEqual(kinds, ["unplugged", "driving_focus", "tesla_bluetooth"]);
  });
});
