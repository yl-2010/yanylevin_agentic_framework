import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { choice, noul, score, typesafeConfig, getTypesafeClient } from "./typesafe.js";

describe("typesafeConfig", () => {
  it("is unconfigured without a key", () => {
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      const cfg = typesafeConfig();
      assert.equal(cfg.configured, false);
      assert.equal(cfg.defaultModel, "jev-latest");
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
    }
  });

  it("reads the key and optional model override", () => {
    const prevKey = process.env.TYPESAFE_API_KEY;
    const prevModel = process.env.TYPESAFE_DEFAULT_MODEL;
    process.env.TYPESAFE_API_KEY = "apikey_test_not_real";
    process.env.TYPESAFE_DEFAULT_MODEL = "jev-1.13.0";
    try {
      const cfg = typesafeConfig();
      assert.equal(cfg.configured, true);
      assert.equal(cfg.apiKey, "apikey_test_not_real");
      assert.equal(cfg.defaultModel, "jev-1.13.0");
    } finally {
      if (prevKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prevKey;
      if (prevModel === undefined) delete process.env.TYPESAFE_DEFAULT_MODEL;
      else process.env.TYPESAFE_DEFAULT_MODEL = prevModel;
    }
  });
});

describe("getTypesafeClient", () => {
  it("throws when the key is missing", () => {
    const prev = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    try {
      assert.throws(() => getTypesafeClient(), /TYPESAFE_API_KEY is missing/);
    } finally {
      if (prev === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prev;
    }
  });
});

describe("question helpers", () => {
  it("build noul, choice, and score questions", () => {
    assert.equal(noul("Is this spam?").type, "noul");
    const cat = choice("Which bucket?", { billing: "Payments", other: null });
    assert.equal(cat.type, "choice");
    assert.equal(cat.criteria.billing, "Payments");
    const urgency = score("How urgent?", ["Can wait", "Soon", "Now"]);
    assert.equal(urgency.type, "score");
    assert.equal(urgency.criteria.length, 3);
  });
});
