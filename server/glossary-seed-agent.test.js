import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GLOSSARY_SEED_MODEL_SPEC,
  buildGlossarySeedPrompt,
  glossarySeedModelSpec,
} from "./glossary-seed-agent.js";

describe("glossary seed model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(GLOSSARY_SEED_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(glossarySeedModelSpec().params, [{ id: "fast", value: "false" }]);
  });
});

describe("glossary seed prompt", () => {
  it("reads a bounded set and writes through the lookup command", () => {
    const prompt = buildGlossarySeedPrompt({
      dateKey: "2026-10-03",
      timezone: "America/Los_Angeles",
    });
    assert.match(prompt, /schema\.md/);
    assert.match(prompt, /brain-glossary\.js add/);
    assert.match(prompt, /identity\.md/);
    assert.match(prompt, /newest 14 files/);
    assert.match(prompt, /class-schedule/);
    assert.match(prompt, /Skip people aliases/);
    assert.match(prompt, /Do not glob brain\/people\//);
    assert.match(prompt, /Skip full chat history and OneNote/);
    assert.match(prompt, /Do not git commit/);
    assert.match(prompt, /--check/);
    assert.match(prompt, /you@example.com/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
  });
});
