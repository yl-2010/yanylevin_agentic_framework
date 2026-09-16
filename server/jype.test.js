import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalizeJypeEmail,
  isJypeMember,
  jypeEmailForSlug,
  jypeGivenName,
  originIsJypeThread,
} from "./jype.js";

describe("jype identity", () => {
  it("maps school and iCloud aliases onto the Gmail members", () => {
    assert.equal(isJypeMember("you@example.com"), true);
    assert.equal(isJypeMember("you@example.com"), true);
    assert.equal(isJypeMember("xujeffery9@gmail.com"), true);
    assert.equal(isJypeMember("everettedeng@gmail.com"), true);
    assert.equal(isJypeMember("edeng@school.example"), true);
    assert.equal(isJypeMember("jxu28@school.example"), true);
    assert.equal(canonicalizeJypeEmail("friend@school.example"), "you@example.com");
    assert.equal(jypeGivenName("xujeffery9@gmail.com"), "Example Friend");
    assert.equal(jypeEmailForSlug("example-neighbor"), "everettedeng@gmail.com");
    assert.equal(isJypeMember("stranger@gmail.com"), false);
  });

  it("treats JYPE iMessage and Teams labels as the shared thread", () => {
    assert.equal(originIsJypeThread({ chat: "JYPE" }), true);
    assert.equal(originIsJypeThread({ to: "jype" }), true);
    assert.equal(originIsJypeThread({ threadLabel: "JYPE Teams" }), true);
    assert.equal(originIsJypeThread({ chat: "Class of 2028" }), false);
  });
});
