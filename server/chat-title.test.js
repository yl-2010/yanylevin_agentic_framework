import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { titleFromAgentReply, TITLE_PROMPT } from "./chat-title.js";

describe("titleFromAgentReply", () => {
  it("keeps a short title", () => {
    assert.equal(titleFromAgentReply("Cafe hunt near Juanita"), "Cafe hunt near Juanita");
  });

  it("strips quotes and trailing punctuation", () => {
    assert.equal(titleFromAgentReply('"Friday calc homework."'), "Friday calc homework");
  });

  it("uses keyword-style instructions", () => {
    assert.match(TITLE_PROMPT, /Keyword-style/);
    assert.match(TITLE_PROMPT, /24-36 characters/);
    assert.doesNotMatch(TITLE_PROMPT, /3 to 6 words/);
  });
});
