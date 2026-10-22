import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computerUseCustomTools,
  diffTreeText,
  formatAppState,
  parseComputerUseArgs,
  treeUnchanged,
} from "./computer-use.js";

const textEdit = {
  path: "/System/Applications/TextEdit.app",
  bundleId: "com.apple.TextEdit",
  pid: 12,
  app: "TextEdit",
  window: "Untitled",
  imageWidth: 400,
  imageHeight: 300,
  elements: [
    {
      id: 0,
      depth: 0,
      role: "standard window",
      name: "Untitled",
      actions: ["Raise"],
    },
    {
      id: 2,
      depth: 1,
      parent: 0,
      role: "text entry area",
      name: "",
      value: "hello",
      valueType: "string",
      settable: true,
      focused: true,
      identifier: "First Text View",
    },
    {
      id: 4,
      depth: 1,
      parent: 0,
      role: "checkbox",
      name: "bold",
      value: "0",
      valueType: "number",
      settable: true,
      help: "Bold text",
    },
  ],
};

describe("computer use tree", () => {
  it("formats a numbered accessibility tree", () => {
    const text = formatAppState(textEdit);
    assert.match(text, /bundleID com\.apple\.TextEdit, pid 12/);
    assert.match(text, /Window: "Untitled"/);
    assert.match(text, /Screenshot: 400x300/);
    assert.match(text, /^0 standard window Untitled, Secondary Actions: Raise/m);
    assert.match(text, /^\t2 text entry area \(settable, string\), Value: hello, ID: First Text View/m);
    assert.match(text, /The focused UI element is 2 text entry area/);
  });

  it("returns a diff after the first tree", () => {
    const first = formatAppState(textEdit);
    const next = formatAppState({
      ...textEdit,
      elements: textEdit.elements.map((el) =>
        el.id === 4 ? { ...el, value: "1" } : el
      ),
    });
    assert.equal(diffTreeText("", first), first);
    assert.match(diffTreeText(first, first), /no change in the accessibility tree/);
    assert.equal(treeUnchanged(diffTreeText(first, first)), true);
    assert.equal(treeUnchanged(diffTreeText(first, next)), false);
    const diff = diffTreeText(first, next);
    assert.match(diff, /diff from the previous accessibility tree/);
    assert.match(diff, /- \t4 checkbox bold \(settable, number\), Value: 0/);
    assert.match(diff, /\+ \t4 checkbox bold \(settable, number\), Value: 1/);
  });
});

describe("computer use tools", () => {
  it("describes the actions and leaves judgment to the skill", () => {
    const tools = computerUseCustomTools();
    assert.match(tools.get_app_state.description, /accessibility tree/);
    assert.match(tools.click.description, /real cursor stays put/);
    assert.doesNotMatch(tools.click.description, /stopped|third click|Yan asked/);
    assert.equal(typeof tools.restore_front.execute, "function");
    assert.match(tools.restore_front.description, /in front before/);
  });
});

describe("computer use cli", () => {
  it("parses state, click, and type", () => {
    assert.equal(parseComputerUseArgs(["state", "TextEdit"]).app, "TextEdit");
    assert.equal(parseComputerUseArgs(["click", "2"]).id, 2);
    assert.equal(parseComputerUseArgs(["click", "--x", "4", "--y", "5", "--foreground"]).foreground, true);
    const typed = parseComputerUseArgs(["type", "2", "--text", "hello there"]);
    assert.equal(typed.id, 2);
    assert.equal(typed.text, "hello there");
  });
});
