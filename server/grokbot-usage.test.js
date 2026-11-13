import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dailyGrokBotSnapshots,
  grokBotUsageForIndex,
  ingestGrokBotSnapshot,
  normalizeGrokBotSnapshot,
} from "./grokbot-usage.js";
import { buildClumps, indexFromBound, isGrokBotModel, packUsageEvents, resolveRange, sourceParts } from "./usage-log.js";

const SEED = {
  at: "2026-11-13T01:20:00.000Z",
  plan: "Cursor Ultra",
  weekly: { percentUsed: 0.2, resetsAt: "2026-11-20T01:05:00.000Z" },
  onDemand: { usedDollars: 0, limitDollars: 200, resetsAt: "2026-12-12T21:16:00.000Z", sharedWithCursor: true },
  shares: [{ window: "last_7_days", by: "day", dayTimezone: "UTC", rows: [{ name: "2026-11-13", percent: 100 }] }],
};

describe("grokbot usage snapshots", () => {
  it("normalizes the seed snapshot", () => {
    const snap = normalizeGrokBotSnapshot(SEED);
    assert.equal(snap.weekly.percentUsed, 0.2);
    assert.equal(snap.onDemand.limitDollars, 200);
    assert.equal(snap.shares[0].rows[0].percent, 100);
  });

  it("rejects bad snapshots with a readable reason", () => {
    assert.throws(() => normalizeGrokBotSnapshot({ ...SEED, at: "yesterday" }), /at must be an ISO/);
    assert.throws(() => normalizeGrokBotSnapshot({ ...SEED, at: "2026-11-13T01:20:00" }), /offset/);
    assert.throws(() => normalizeGrokBotSnapshot({ ...SEED, weekly: undefined }), /weekly/);
    assert.throws(() => normalizeGrokBotSnapshot({ ...SEED, shares: [{ window: "today", by: "day", rows: [] }] }), /window/);
    assert.throws(
      () => normalizeGrokBotSnapshot({ ...SEED, shares: [{ window: "this_week", by: "day", rows: [{ name: "Nov 13", percent: 10 }] }] }),
      /YYYY-MM-DD/
    );
    assert.throws(
      () => normalizeGrokBotSnapshot({ ...SEED, shares: [{ window: "this_week", by: "routine", rows: [{ name: "x", percent: 120 }] }] }),
      /percent/
    );
  });

  it("appends to the jsonl once and keeps the newest per Pacific day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "grokbot-usage-"));
    const path = join(dir, "grokbot.jsonl");
    try {
      assert.equal((await ingestGrokBotSnapshot(SEED, { path })).wrote, 1);
      assert.equal((await ingestGrokBotSnapshot(SEED, { path })).wrote, 0);
      await ingestGrokBotSnapshot({ ...SEED, at: "2026-11-13T05:00:00Z", weekly: { ...SEED.weekly, percentUsed: 0.4 } }, { path });
      await ingestGrokBotSnapshot({ ...SEED, at: "2026-11-14T18:00:00Z", weekly: { ...SEED.weekly, percentUsed: 1.1 } }, { path });
      assert.equal((await readFile(path, "utf8")).trim().split("\n").length, 3);
      const index = await grokBotUsageForIndex({ path });
      // 01:20Z and 05:00Z on Nov 13 are both Nov 12 in Pacific; the later one wins.
      assert.deepEqual(index.snapshots.map((s) => s.weekly.percentUsed), [0.4, 1.1]);
      assert.equal(index.latest.weekly.percentUsed, 1.1);
      assert.deepEqual(dailyGrokBotSnapshots(index.snapshots, { fromMs: Date.parse("2026-11-14T00:00:00Z") }).length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("grokbot on the billing feed", () => {
  it("spots grok-bot models", () => {
    assert.equal(isGrokBotModel("grok-bot-default"), true);
    assert.equal(isGrokBotModel("grok-4.7-high"), false);
  });

  it("files grok-bot billing as Yan's Grok Bot, not Alex, and never matches a Cursor prompt", () => {
    const clumps = buildClumps([
      {
        id: "desk:mac:c1:b1",
        source: "desktop",
        at: "2026-11-13T01:06:00.000Z",
        person: "Yan",
        repo: "yanylevin",
        kind: "agent",
        model: "grok-4.7-high",
        prompt: "hi",
        threadId: "c1",
        composerId: "c1",
        bubbleId: "b1",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      },
      {
        id: "bill:g1",
        source: "billing",
        at: "2026-11-13T01:06:20.000Z",
        usageEventId: "g1",
        conversationId: "agent-1",
        model: "grok-bot-default",
        tokens: { input: 2, output: 121, cacheRead: 51803, cacheWrite: 3959, reasoning: 0 },
        chargedCents: 3.45,
      },
    ]);
    const bot = clumps.find((row) => row.model === "grok-bot-default");
    assert.equal(bot.person, "Yan");
    assert.equal(bot.kind, "grok-bot");
    assert.equal(bot.repo, "Grok Bot");
    assert.equal(bot.threadId, "agent-1");
    assert.equal(bot.chargedCents, 3.45);
    const desk = clumps.find((row) => row.threadId === "c1");
    assert.equal(desk.chargedCents || 0, 0);
  });
});

describe("usage source split", () => {
  const tok = (input) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

  it("keeps a one-source prompt whole", () => {
    const row = { model: "composer-2.5", tokens: tok(30), chargedCents: 3, calls: [{ model: "composer-2.5", tokens: tok(30), chargedCents: 3 }] };
    assert.deepEqual(sourceParts(row), [{ model: "composer-2.5", tokens: tok(30), chargedCents: 3 }]);
  });

  it("splits a Composer chat whose subagent ran on Claude", () => {
    const row = {
      at: "2026-11-12T22:00:00.000Z",
      person: "Yan",
      repo: "yanylevin",
      kind: "cursor-desktop",
      model: "composer-2.5",
      threadId: "t1",
      tokens: tok(70),
      chargedCents: 9,
      calls: [
        { model: "composer-2.5", tokens: tok(30), chargedCents: 2 },
        { model: "claude-opus-5-5-high", tokens: tok(40), chargedCents: 7 },
      ],
    };
    const parts = sourceParts(row);
    assert.deepEqual(parts.map((p) => [p.model, p.tokens.input, p.chargedCents]), [
      ["composer-2.5", 30, 2],
      ["claude-opus-5-5-high", 40, 7],
    ]);
    const packed = packUsageEvents([row]);
    assert.equal(packed.events.length, 2);
    assert.deepEqual(packed.events.map((e) => packed.dict.model[e[4]]), ["composer-2.5", "claude-opus-5-5-high"]);
  });

  it("uses the billed model when Auto picked a third-party model", () => {
    const row = { model: "default", tokens: tok(5), chargedCents: 1, calls: [{ model: "gpt-5.4-medium", tokens: tok(5), chargedCents: 1 }] };
    assert.deepEqual(sourceParts(row).map((p) => p.model), ["gpt-5.4-medium"]);
  });
});

describe("usage typed range", () => {
  it("resolves a custom range and clamps the end to now", async () => {
    const now = Date.parse("2026-11-13T01:30:00Z");
    const range = await resolveRange({ range: "custom", from: "2026-11-10T08:00:00.000Z", to: "2026-11-13T07:59:59.999Z" }, now);
    assert.equal(range.from, "2026-11-10T08:00:00.000Z");
    assert.equal(range.to, "2026-11-13T01:30:00.000Z");
    assert.equal(range.range, "custom");
  });

  it("widens the index for an older range, up to 400 days back", () => {
    const now = Date.parse("2026-11-13T00:00:00Z");
    const base = Date.parse("2026-10-14T00:00:00Z");
    assert.equal(indexFromBound(base, "2026-09-01T07:00:00Z", now), Date.parse("2026-09-01T07:00:00Z"));
    assert.equal(indexFromBound(base, "2026-11-01T00:00:00Z", now), base);
    assert.equal(indexFromBound(base, "2020-01-01T00:00:00Z", now), now - 400 * 86400000);
    assert.equal(indexFromBound(base, "nope", now), base);
  });
});
