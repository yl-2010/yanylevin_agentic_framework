import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_URL,
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  buildWorkflow,
} from "./life-state-shortcut-build.js";

describe("Yan Life State Dock workflow", () => {
  it("POSTs intent and orientation with a bearer token", () => {
    const wf = buildWorkflow({
      token: TOKEN_PLACEHOLDER,
      url: URL_PLACEHOLDER,
    });
    const download = wf.WFWorkflowActions.find(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
    );
    assert.equal(download.WFWorkflowActionParameters.WFHTTPMethod, "POST");
    assert.equal(download.WFWorkflowActionParameters.WFURL, URL_PLACEHOLDER);
    assert.equal(URL_PLACEHOLDER, "__LIFE_STATE_INTENT_URL__");
    assert.equal(DEFAULT_URL.endsWith("/api/education/life-state-intent"), true);
    const headers = download.WFWorkflowActionParameters.WFHTTPHeaders.Value
      .WFDictionaryFieldValueItems;
    const auth = headers.find((item) => item.WFKey.Value.string === "Authorization");
    assert.equal(auth.WFValue.Value.string, `Bearer ${TOKEN_PLACEHOLDER}`);
    const jsonKeys = download.WFWorkflowActionParameters.WFJSONValues.Value
      .WFDictionaryFieldValueItems.map((item) => item.WFKey.Value.string);
    assert.deepEqual(jsonKeys, ["intent", "orientation"]);
    const vars = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.setvariable"
    );
    assert.deepEqual(
      vars.map((a) => a.WFWorkflowActionParameters.WFVariableName),
      ["Intent", "Orientation"]
    );
    assert.equal(
      wf.WFWorkflowActions.some(
        (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.comment"
      ),
      true
    );
    assert.equal(
      wf.WFWorkflowActions.some((a) =>
        String(a.WFWorkflowActionIdentifier).includes("homekit")
      ),
      false
    );
    const notify = wf.WFWorkflowActions.find(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.notification"
    );
    assert.equal(
      notify.WFWorkflowActionParameters.WFNotificationActionBody,
      "Dock intent did not reach the Mac."
    );
    const ifActions = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.conditional"
    );
    assert.deepEqual(
      ifActions.map((a) => a.WFWorkflowActionParameters.WFControlFlowMode),
      [0, 1, 2]
    );
  });
});
