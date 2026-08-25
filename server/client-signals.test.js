import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractClientSignals } from "./client-signals.js";

describe("extractClientSignals", () => {
  it("prefers X-Yan-Client-* headers from the Vercel proxy", () => {
    const signals = extractClientSignals({
      headers: {
        "x-yan-client-ip": "203.0.113.9",
        "x-yan-client-ua": "Mozilla/5.0 (Test)",
        "x-yan-client-lang": "en-US",
        "x-yan-client-country": "us",
        "x-yan-client-referer": "https://yanylevin.com/",
        "x-forwarded-for": "10.0.0.1",
        "user-agent": "undici",
      },
      body: { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      ip: "127.0.0.1",
    });

    assert.equal(signals.ip, "203.0.113.9");
    assert.equal(signals.userAgent, "Mozilla/5.0 (Test)");
    assert.equal(signals.acceptLanguage, "en-US");
    assert.equal(signals.country, "US");
    assert.equal(signals.referer, "https://yanylevin.com/");
    assert.equal(signals.sessionId, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
  });

  it("falls back to standard headers", () => {
    const signals = extractClientSignals({
      headers: {
        "x-forwarded-for": "198.51.100.2, 10.0.0.1",
        "user-agent": "Safari",
        "accept-language": "fr-FR",
        "cf-ipcountry": "CA",
      },
      body: {},
      ip: "127.0.0.1",
    });

    assert.equal(signals.ip, "198.51.100.2");
    assert.equal(signals.userAgent, "Safari");
    assert.equal(signals.acceptLanguage, "fr-FR");
    assert.equal(signals.country, "CA");
  });
});
