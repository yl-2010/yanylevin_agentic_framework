import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  BRIEFING_LM_STUDIO_TARGETS,
  lmStudioModelLoaded,
  probeBriefingLmStudios,
} from "./lmstudio.js";

describe("lmStudioModelLoaded", () => {
  it("matches the exact id", () => {
    assert.equal(
      lmStudioModelLoaded(["openai/gpt-oss-20b"], "openai/gpt-oss-20b"),
      true
    );
  });

  it("matches the tail without an org prefix", () => {
    assert.equal(
      lmStudioModelLoaded(["gpt-oss-20b"], "openai/gpt-oss-20b"),
      true
    );
  });

  it("is false when the expected model is missing", () => {
    assert.equal(
      lmStudioModelLoaded(["orpheus-3b-0.1-ft"], "openai/gpt-oss-20b"),
      false
    );
    assert.equal(lmStudioModelLoaded([], "openai/gpt-oss-20b"), false);
  });
});

describe("probeBriefingLmStudios", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("covers ExampleCo and ExampleNotes", () => {
    assert.deepEqual(
      BRIEFING_LM_STUDIO_TARGETS.map((t) => t.id),
      ["sockethr", "notelms"]
    );
  });

  it("marks both down when LM Studio does not answer", async () => {
    globalThis.fetch = async () => {
      throw new Error("fetch failed");
    };
    const result = await probeBriefingLmStudios();
    assert.deepEqual(result.down, ["ExampleCo", "ExampleNotes"]);
    assert.equal(result.targets.length, 2);
    assert.ok(result.targets.every((t) => t.ok === false && t.modelLoaded === false));
  });

  it("marks both up when gpt-oss-20b is listed", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ data: [{ id: "openai/gpt-oss-20b" }] }),
      };
    };
    const result = await probeBriefingLmStudios();
    assert.equal(calls, 1);
    assert.deepEqual(result.down, []);
    assert.ok(result.targets.every((t) => t.ok && t.modelLoaded));
  });

  it("marks both down when a different model is loaded", async () => {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "orpheus-3b-0.1-ft" }] }),
    });
    const result = await probeBriefingLmStudios();
    assert.deepEqual(result.down, ["ExampleCo", "ExampleNotes"]);
    assert.ok(result.targets.every((t) => t.ok && t.modelLoaded === false));
  });
});
