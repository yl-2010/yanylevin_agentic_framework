import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_URL,
  TOKEN_PLACEHOLDER,
  URL_PLACEHOLDER,
  buildWorkflow,
} from "./life-state-shortcut-build.js";

function jsonOf(action) {
  return Object.fromEntries(
    action.WFWorkflowActionParameters.WFJSONValues.Value.WFDictionaryFieldValueItems.map(
      (item) => [item.WFKey.Value.string, item.WFValue.Value.string]
    )
  );
}

describe("Yan Life State Dock workflow", () => {
  it("ships two finished POSTs, shower then sleep, with no variables", () => {
    const wf = buildWorkflow({
      token: TOKEN_PLACEHOLDER,
      url: URL_PLACEHOLDER,
    });
    const downloads = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl"
    );
    assert.equal(downloads.length, 2);
    assert.equal(
      wf.WFWorkflowActions.some(
        (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.setvariable"
      ),
      false
    );
    const shower = jsonOf(downloads[0]);
    const sleep = jsonOf(downloads[1]);
    assert.equal(shower.intent, "going_to_shower");
    assert.equal(shower.orientation, "portrait");
    assert.equal(sleep.intent, "going_to_sleep");
    assert.equal(sleep.orientation, "landscape");
    for (const download of downloads) {
      assert.equal(download.WFWorkflowActionParameters.WFHTTPMethod, "POST");
      assert.equal(download.WFWorkflowActionParameters.WFURL, URL_PLACEHOLDER);
      const auth = download.WFWorkflowActionParameters.WFHTTPHeaders.Value
        .WFDictionaryFieldValueItems.find(
          (item) => item.WFKey.Value.string === "Authorization"
        );
      assert.equal(auth.WFValue.Value.string, `Bearer ${TOKEN_PLACEHOLDER}`);
    }
    assert.equal(DEFAULT_URL.endsWith("/api/education/life-state-intent"), true);
    const notify = wf.WFWorkflowActions.filter(
      (a) => a.WFWorkflowActionIdentifier === "is.workflow.actions.notification"
    );
    assert.equal(notify.length, 2);
    assert.equal(
      notify[0].WFWorkflowActionParameters.WFNotificationActionBody,
      "Dock intent did not reach the Mac."
    );
  });
});
