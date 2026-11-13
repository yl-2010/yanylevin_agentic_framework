import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  LIFE_STATE_INTERVAL_MS,
  LIFE_STATE_MODEL,
  buildLifeStatePrompt,
  lifeStateModelId,
  msUntilNextLifeStateTick,
  parseLifeStateGuessText,
} from "./life-state-agent.js";

describe("life-state model", () => {
  it("uses local gpt-oss", () => {
    assert.equal(LIFE_STATE_MODEL, "openai/gpt-oss-20b");
    assert.equal(lifeStateModelId(), "openai/gpt-oss-20b");
  });
});

describe("life-state tick alignment", () => {
  it("waits until the next :00/:05/:10 clock mark", () => {
    const onMidnight = Date.parse("2026-09-12T00:00:00.000Z");
    assert.equal(msUntilNextLifeStateTick(onMidnight), LIFE_STATE_INTERVAL_MS);

    const plus2 = Date.parse("2026-09-12T00:02:00.000Z");
    assert.equal(msUntilNextLifeStateTick(plus2), 3 * 60 * 1000);

    const plus4_30 = Date.parse("2026-09-12T00:04:30.000Z");
    assert.equal(msUntilNextLifeStateTick(plus4_30), 30 * 1000);

    const onFive = Date.parse("2026-09-12T00:05:00.000Z");
    assert.equal(msUntilNextLifeStateTick(onFive), LIFE_STATE_INTERVAL_MS);

    const plus7 = Date.parse("2026-09-12T00:07:00.000Z");
    assert.equal(msUntilNextLifeStateTick(plus7), 3 * 60 * 1000);
  });
});

describe("life-state prompt", () => {
  it("tells gpt-oss not to copy the last sample or invent a drive", () => {
    const prompt = buildLifeStatePrompt();
    assert.match(prompt, /one JSON object only/);
    assert.match(prompt, /gpt-oss-20b/);
    assert.match(prompt, /Screen sessions in this snapshot win/);
    assert.match(prompt, /Do not copy the previous activity/);
    assert.match(prompt, /Do not pick driving/);
  });

  it("parses the first JSON object", () => {
    const parsed = parseLifeStateGuessText('sure\n{"kind":"at_home","activity":"home"}\n');
    assert.equal(parsed.kind, "at_home");
    assert.equal(parseLifeStateGuessText("no json"), null);
  });
});
