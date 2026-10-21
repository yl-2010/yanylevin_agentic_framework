import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildClumps, filterClumps, kindFromPrefix, personFromEmail, summarizeClumps, tokensFromUsage } from "./usage-log.js";

describe("usage clumps", () => {
  it("names the account and maps nightly prefixes", () => {
    assert.equal(personFromEmail("you@example.com"), "Yan");
    const second = personFromEmail("you@icloud.com");
    if (second !== "Yan") assert.equal(second, "Alex");
    assert.equal(personFromEmail("friend@example.com"), "Example Friend");
    assert.equal(kindFromPrefix("location-history"), "location-compose");
    assert.equal(kindFromPrefix("daily-briefing-news"), "daily-briefing");
    assert.equal(kindFromPrefix("test"), "unspecified");
  });

  it("keeps an SDK prompt and does not also show its billing event as Other", () => {
    const clumps = buildClumps([
      {
        id: "sdk:req-1",
        source: "sdk",
        at: "2026-10-20T18:00:00.000Z",
        startedAt: "2026-10-20T17:59:00.000Z",
        endedAt: "2026-10-20T18:00:00.000Z",
        person: "Alex",
        repo: "yanylevin-agents",
        kind: "teams-agent",
        model: "grok-4.7-high",
        prompt: "what is due",
        threadId: "chat-1",
        requestId: "req-1",
        tokens: tokensFromUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1 }),
      },
      {
        id: "bill:req-1",
        source: "billing",
        at: "2026-10-20T17:59:30.000Z",
        usageEventId: "req-1",
        conversationId: "conv",
        model: "grok-4.7-high",
        tokens: tokensFromUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 9, cacheWriteTokens: 2 }),
      },
      {
        id: "bill:other",
        source: "billing",
        at: "2026-10-20T19:00:00.000Z",
        usageEventId: "other",
        conversationId: "laptop",
        model: "composer-2.5",
        tokens: tokensFromUsage({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 3 }),
        chargedCents: 12.5,
      },
    ]);
    assert.equal(clumps.length, 2);
    const teams = clumps.find((row) => row.kind === "teams-agent");
    assert.equal(teams.person, "Alex");
    assert.equal(teams.repo, "yanylevin-agents");
    assert.equal(teams.tokens.cacheRead, 9);
    assert.equal(teams.tokens.cacheWrite, 2);
    const other = clumps.find((row) => row.person === "Other");
    assert.equal(other.repo, "Other");
    assert.equal(other.prompt, "");
    assert.equal(other.tokens.input, 50);
    assert.equal(other.chargedCents, 12.5);
    assert.equal(summarizeClumps(clumps).cents, 12.5);
  });

  it("splits one desktop thread across prompts and can filter", () => {
    const clumps = buildClumps([
      desktop("a", 0, "2026-10-20T18:00:00.000Z"),
      desktop("b", 1, "2026-10-20T18:10:00.000Z"),
      bill("e1", "2026-10-20T18:01:00.000Z", 10),
      bill("e2", "2026-10-20T18:11:00.000Z", 40),
    ]);
    assert.equal(clumps.length, 2);
    const first = clumps.find((row) => row.id.endsWith(":a"));
    const second = clumps.find((row) => row.id.endsWith(":b"));
    assert.equal(first.tokens.input, 10);
    assert.equal(second.tokens.input, 40);
    assert.equal(first.prompt, "first");
    const filtered = filterClumps(clumps, { repo: "sockethr" });
    assert.equal(filtered.length, 2);
    const summary = summarizeClumps(filtered);
    assert.equal(summary.totals.input, 50);
    assert.equal(summary.byPerson[0].name, "Yan");
  });

  it("rolls a linked subagent into the parent prompt", () => {
    const clumps = buildClumps([
      desktop("a", 0, "2026-10-20T18:00:00.000Z"),
      {
        ...desktop("child", 0, "2026-10-20T18:01:00.000Z"),
        id: "desk:studio:child:c",
        composerId: "child",
        threadId: "child",
        kind: "subagent",
        parentComposerId: "comp",
        prompt: "hidden",
        tokens: tokensFromUsage({ inputTokens: 1, outputTokens: 1 }),
        usageUuids: ["sub"],
      },
      {
        id: "bill:sub",
        source: "billing",
        at: "2026-10-20T18:01:00.000Z",
        usageEventId: "sub",
        conversationId: "child",
        model: "grok-4.7-high",
        tokens: tokensFromUsage({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 1 }),
      },
      {
        ...desktop("orphan", 0, "2026-10-20T18:02:00.000Z"),
        id: "desk:studio:orphan:o",
        composerId: "orphan",
        threadId: "orphan",
        kind: "subagent",
        prompt: "still here",
      },
    ]);
    assert.equal(clumps.some((row) => row.id.endsWith(":c")), false);
    const parent = clumps.find((row) => row.id.endsWith(":a"));
    assert.equal(parent.tokens.input, 8);
    assert.equal(parent.tokens.cacheRead, 4);
    assert.equal(clumps.some((row) => row.prompt === "still here"), true);
  });
});

function desktop(bubbleId, index, at) {
  return {
    id: `desk:studio:comp:${bubbleId}`,
    source: "desktop",
    at,
    person: "Yan",
    repo: "sockethr",
    kind: "agent",
    model: "",
    prompt: index === 0 ? "first" : "second",
    threadId: "comp",
    composerId: "comp",
    bubbleId,
    index,
    usageUuids: [],
    tokens: tokensFromUsage({ inputTokens: 1, outputTokens: 1 }),
  };
}

function bill(id, at, input) {
  return {
    id: `bill:${id}`,
    source: "billing",
    at,
    usageEventId: id,
    conversationId: "comp",
    model: "composer-2.5",
    tokens: tokensFromUsage({ inputTokens: input, outputTokens: 2, cacheReadTokens: 4 }),
  };
}
