import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  browserActorIsYan,
  formatSnapshotLines,
  isLoginUrl,
  isSensitiveUrl,
  parseArgs,
  sessionMayUseBrowser,
  YAN_EMAIL,
} from "./agent-browser.js";

describe("agent-browser parseArgs", () => {
  it("parses goto url", () => {
    const a = parseArgs(["goto", "https://example.com"]);
    assert.equal(a.cmd, "goto");
    assert.equal(a.url, "https://example.com");
  });

  it("parses click ref", () => {
    const a = parseArgs(["click", "4"]);
    assert.equal(a.cmd, "click");
    assert.equal(a.ref, 4);
  });

  it("parses fill text", () => {
    const a = parseArgs(["fill", "2", "--text", "secret"]);
    assert.equal(a.ref, 2);
    assert.equal(a.text, "secret");
  });
});

describe("agent-browser policy", () => {
  it("flags brokerage and apple id hosts", () => {
    assert.equal(isSensitiveUrl("https://oltx.fidelity.com/ftgw/fbc/ofsummary/defaultFlow"), true);
    assert.equal(isSensitiveUrl("https://appleid.apple.com/"), true);
    assert.equal(isSensitiveUrl("https://www.paypal.com/signin"), true);
    assert.equal(isSensitiveUrl("https://example.com/login"), false);
    assert.equal(isSensitiveUrl("https://four11.example.com/pdf"), false);
  });

  it("detects IdP login urls", () => {
    assert.equal(isLoginUrl("https://login.microsoftonline.com/common/oauth2"), true);
    assert.equal(isLoginUrl("https://example.com/calendar"), false);
  });

  it("allows Yan and JYPE, blocks other guests", () => {
    assert.equal(
      sessionMayUseBrowser({ email: YAN_EMAIL, guestCaller: null }),
      true
    );
    assert.equal(
      sessionMayUseBrowser({
        email: "you@example.com",
        guestCaller: null,
      }),
      true
    );
    assert.equal(
      sessionMayUseBrowser({
        email: "you@example.com",
        workspace: "jype",
        guestCaller: null,
      }),
      true
    );
    assert.equal(
      sessionMayUseBrowser({
        email: YAN_EMAIL,
        guestCaller: { slug: "alex-rivera", displayName: "Alex" },
      }),
      true
    );
    assert.equal(
      sessionMayUseBrowser({
        email: YAN_EMAIL,
        guestCaller: { slug: "sam-someone", displayName: "Sam" },
      }),
      false
    );
  });

  it("treats only Yan's own turn as allowed to open sensitive sites", () => {
    assert.equal(
      browserActorIsYan({ email: YAN_EMAIL, guestCaller: null }),
      true
    );
    assert.equal(
      browserActorIsYan({
        email: YAN_EMAIL,
        guestCaller: { slug: "alex-rivera" },
      }),
      false
    );
    assert.equal(
      browserActorIsYan({ email: "you@example.com", guestCaller: null }),
      false
    );
  });

  it("blocks sensitive urls before launching Chrome", async () => {
    const { navigate } = await import("./agent-browser.js");
    const result = await navigate("https://www.fidelity.com/", {
      allowSensitive: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /sensitive/);
  });
});

describe("agent-browser snapshot text", () => {
  it("formats refs for the model", () => {
    const text = formatSnapshotLines(
      [
        { ref: 1, role: "textbox", name: "Password", href: "" },
        { ref: 2, role: "button", name: "Sign in", href: "" },
      ],
      { url: "https://portal.example.com/", title: "Family" }
    );
    assert.match(text, /Family/);
    assert.match(text, /https:\/\/portal\.example\.com\//);
    assert.match(text, /\[1\] textbox Password/);
    assert.match(text, /\[2\] button Sign in/);
  });
});
