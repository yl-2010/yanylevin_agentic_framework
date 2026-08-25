import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildExtractionPrompt } from "./brain-extraction.js";

describe("brain extraction prompt", () => {
  it("keeps identity writes for Yan facts and denies person prose on the map", () => {
    const prompt = buildExtractionPrompt({
      userText: "Example Friend spelling is Example Friend only",
      assistantText: "Got it",
    });
    assert.match(prompt, /identity\.md/);
    assert.match(prompt, /facts about Yan himself/);
    assert.match(prompt, /Person spelling, emails, nicknames, phones/);
    assert.match(prompt, /never go on identity\.md as prose/);
    assert.match(prompt, /You may still edit identity\.md for Yan facts/);
  });
});
