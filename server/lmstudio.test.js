import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lmStudioModelLoaded,
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

