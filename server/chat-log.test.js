import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatChatLogBlock,
  formatPacificTime,
  isChatLogViewer,
  normalizeSessionId,
  parseChatLog,
  parseChatLogBlock,
  turnIndex,
  visitorApproxHash,
} from "./chat-log.js";

describe("formatPacificTime", () => {
  it("formats a known UTC instant in Pacific time", () => {
    // 2026-07-30T04:05:12.000Z → Wed Jul 29, 2026 evening PDT (UTC-7)
    const text = formatPacificTime(new Date("2026-07-30T04:05:12.000Z"));
    assert.match(text, /Wed,\s+Jul\s+29,\s+2026/);
    assert.match(text, /9:05:12\s+PM\s+PDT/);
  });
});

describe("normalizeSessionId", () => {
  it("shortens UUIDs for scannable headings", () => {
    assert.equal(
      normalizeSessionId("7f3a91c2-abcd-4ef0-8123-456789abcdef"),
      "7f3a91c2"
    );
  });

  it("rejects junk", () => {
    assert.equal(normalizeSessionId(""), "(none)");
    assert.equal(normalizeSessionId("no spaces allowed!"), "(none)");
  });
});

describe("visitorApproxHash", () => {
  it("is stable for the same signals", () => {
    const a = visitorApproxHash({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      acceptLanguage: "en-US",
      country: "US",
    });
    const b = visitorApproxHash({
      ip: "1.2.3.4",
      userAgent: "Mozilla/5.0",
      acceptLanguage: "en-US",
      country: "US",
    });
    assert.equal(a, b);
    assert.equal(a.length, 12);
  });

  it("changes when UA differs", () => {
    const a = visitorApproxHash({ ip: "1.2.3.4", userAgent: "A" });
    const b = visitorApproxHash({ ip: "1.2.3.4", userAgent: "B" });
    assert.notEqual(a, b);
  });
});

describe("formatChatLogBlock", () => {
  it("groups by session and includes Pacific time + visitorApprox", () => {
    const block = formatChatLogBlock({
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello" },
        { role: "user", content: "How old?" },
      ],
      assistantContent: "Sixteen.",
      model: "openai/gpt-oss-20b",
      ip: "9.9.9.9",
      userAgent: "TestBrowser/1.0",
      acceptLanguage: "en-US,en;q=0.9",
      country: "US",
      referer: "https://yanylevin.com/",
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      at: new Date("2026-07-30T04:05:12.000Z"),
    });

    assert.match(block, /## Session `aaaaaaaa` · Turn 2/);
    assert.match(block, /\*\*Wed,\s+Jul\s+29,\s+2026 · 9:05:12 PM PDT\*\*/);
    assert.match(block, /- session: `aaaaaaaa`/);
    assert.match(block, /- turn: 2/);
    assert.match(block, /- visitorApprox: `[0-9a-f]{12}`/);
    assert.match(block, /- ip: 9\.9\.9\.9/);
    assert.match(block, /- country: US/);
    assert.match(block, /How old\?/);
    assert.match(block, /Sixteen\./);
    assert.equal(turnIndex([{ role: "user" }, { role: "user" }]), 2);
  });
});

describe("isChatLogViewer", () => {
  it("allowlists Yan and Alex only", () => {
    assert.equal(isChatLogViewer("you@example.com"), true);
    assert.equal(isChatLogViewer("you@example.com"), true);
    assert.equal(isChatLogViewer("you@icloud.com"), true);
    assert.equal(isChatLogViewer("you@icloud.com"), true);
    assert.equal(isChatLogViewer("visitor@yanylevin.com"), false);
    assert.equal(isChatLogViewer(""), false);
  });
});

describe("parseChatLog", () => {
  it("parses session-format blocks and keeps order", () => {
    const md = formatChatLogBlock({
      messages: [{ role: "user", content: "Hello there" }],
      assistantContent: "Hi",
      model: "openai/gpt-oss-20b",
      ip: "1.1.1.1",
      country: "US",
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      at: new Date("2026-07-30T04:05:12.000Z"),
    });
    const entries = parseChatLog(md);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].session, "bbbbbbbb");
    assert.equal(entries[0].turn, 1);
    assert.equal(entries[0].user, "Hello there");
    assert.equal(entries[0].assistant, "Hi");
    assert.equal(entries[0].ip, "1.1.1.1");
    assert.equal(entries[0].country, "US");
    assert.match(entries[0].when, /Jul\s+29,\s+2026/);
  });

  it("parses legacy heading-only blocks", () => {
    const legacy = [
      "## Tue, Jul 21, 2026 · 4:42:11 PM PDT",
      "",
      "- model: test",
      "- ip: 127.0.0.1",
      "",
      "### User",
      "",
      "```",
      "smoke",
      "```",
      "",
      "### Assistant",
      "",
      "```",
      "ok",
      "```",
      "",
      "---",
      "",
    ].join("\n");
    const entry = parseChatLogBlock(legacy);
    assert.ok(entry);
    assert.equal(entry.user, "smoke");
    assert.equal(entry.assistant, "ok");
    assert.equal(entry.model, "test");
    assert.equal(entry.ip, "127.0.0.1");
  });
});
