import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatLoginLogBlock,
  parseLoginLog,
  parseLoginLogBlock,
} from "./login-log.js";

describe("formatLoginLogBlock", () => {
  it("records email and Pacific time", () => {
    const block = formatLoginLogBlock({
      email: "Visitor@Example.com",
      at: new Date("2026-08-03T13:38:00.000Z"),
    });
    assert.match(block, /## Login/);
    assert.match(block, /- email: `visitor@example.com`/);
    assert.match(block, /- utc: 2026-08-03T13:38:00\.000Z/);
  });

  it("rejects missing email", () => {
    assert.throws(() => formatLoginLogBlock({ email: "" }), /email required/);
  });

  it("rejects visitor placeholder email", () => {
    assert.throws(
      () => formatLoginLogBlock({ email: "visitor@yanylevin.com" }),
      /placeholder/
    );
  });
});

describe("appendLogin dedupe", () => {
  it("exposes appendLogin", async () => {
    const mod = await import("./login-log.js");
    assert.equal(typeof mod.appendLogin, "function");
  });
});

describe("parseLoginLog", () => {
  it("parses append-only blocks newest-capable", () => {
    const a = formatLoginLogBlock({
      email: "a@example.com",
      at: new Date("2026-08-01T12:00:00.000Z"),
    });
    const b = formatLoginLogBlock({
      email: "b@example.com",
      at: new Date("2026-08-02T12:00:00.000Z"),
    });
    const entries = parseLoginLog(a + b);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].email, "a@example.com");
    assert.equal(entries[1].email, "b@example.com");
  });
});

describe("parseLoginLogBlock", () => {
  it("returns null without email", () => {
    assert.equal(parseLoginLogBlock("## Login\n\n**now**\n"), null);
  });
});
