import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMentionState,
  parseMentionState,
  pollTeamsAgentMentions,
  saveMentionState,
} from "./teams-agent-mentions.js";

describe("teams-agent-mentions poller", () => {
  it("parses empty state as no watermark", () => {
    const state = parseMentionState({});
    assert.equal(state.lastAt, "");
    assert.deepEqual(state.seenIds, []);
  });

  it("first poll only writes a watermark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "teams-agent-"));
    const statePath = join(dir, "state.json");
    let fetched = false;
    const result = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:00.000Z"),
      fetchRecent: async () => {
        fetched = true;
        return [
          {
            fromMe: true,
            text: "@agent old",
            id: "old",
            chatId: "c1",
            at: "2026-09-09T17:30:00Z",
          },
        ];
      },
      startFromMessage: async () => {
        throw new Error("should not start on watermark");
      },
    });
    assert.equal(result.skipped, "watermark");
    assert.equal(fetched, false);
    const saved = await loadMentionState(statePath);
    assert.equal(saved.lastAt, "2026-09-09T17:36:00.000Z");
  });

  it("starts a session for a new fromMe @agent and ignores repeats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "teams-agent-"));
    const statePath = join(dir, "state.json");
    await saveMentionState(
      { lastAt: "2026-09-09T17:30:00.000Z", seenIds: [] },
      statePath
    );
    /** @type {object[]} */
    const started = [];
    const hit = {
      id: "G9",
      fromMe: true,
      text: "@Agent what's next",
      at: "2026-09-09T17:36:10Z",
      chat: "Alex",
      chatId: "19:abc",
      messageType: "message",
    };
    const first = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:12.000Z"),
      fetchRecent: async (opts) => {
        assert.ok(opts.since);
        return [
          hit,
          { ...hit, fromMe: false, id: "other", text: "@agent ignore me" },
          { ...hit, id: "plain", text: "no mention" },
        ];
      },
      evaluateGuestMention: async () => ({ action: "ignore" }),
      startFromMessage: async (message) => {
        started.push(message);
        return { sessionId: "sid" };
      },
    });
    assert.equal(first.started, 1);
    assert.equal(started.length, 1);
    assert.equal(started[0].id, "G9");

    const second = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:20.000Z"),
      fetchRecent: async () => [hit],
      evaluateGuestMention: async () => ({ action: "ignore" }),
      startFromMessage: async (message) => {
        started.push(message);
      },
    });
    assert.equal(second.started, 0);
    assert.equal(started.length, 1);
  });

  it("stays quiet when Teams is not signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "teams-agent-"));
    const statePath = join(dir, "state.json");
    await saveMentionState(
      { lastAt: "2026-09-09T17:30:00.000Z", seenIds: [] },
      statePath
    );
    const result = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:20.000Z"),
      fetchRecent: async () => {
        throw new Error("no saved school Teams session");
      },
      startFromMessage: async () => {
        throw new Error("should not start");
      },
    });
    assert.equal(result.skipped, "not-signed-in");
    assert.equal(result.started, 0);
  });

  it("stays quiet on Teams 401", async () => {
    const dir = await mkdtemp(join(tmpdir(), "teams-agent-"));
    const statePath = join(dir, "state.json");
    await saveMentionState(
      { lastAt: "2026-09-09T17:30:00.000Z", seenIds: [] },
      statePath
    );
    const err = new Error("Teams API 401: User is not authorized.");
    err.status = 401;
    const result = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:20.000Z"),
      fetchRecent: async () => {
        throw err;
      },
      startFromMessage: async () => {
        throw new Error("should not start");
      },
    });
    assert.equal(result.skipped, "not-signed-in");
    assert.equal(result.started, 0);
  });

  it("starts a guest Teams 1:1 and ignores unauthorized groups", async () => {
    const dir = await mkdtemp(join(tmpdir(), "teams-agent-"));
    const statePath = join(dir, "state.json");
    await saveMentionState(
      { lastAt: "2026-09-09T17:30:00.000Z", seenIds: [] },
      statePath
    );
    /** @type {object[]} */
    const started = [];
    const hit = {
      id: "g1",
      fromMe: false,
      text: "@agent hi",
      at: "2026-09-09T17:36:10Z",
      chat: "Sam",
      chatId: "19:sam",
      chatType: "oneOnOne",
      messageType: "message",
      from: "Sam Classmate",
      fromEmail: "sam@school.example",
    };
    const first = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:36:12.000Z"),
      fetchRecent: async () => [hit],
      evaluateGuestMention: async () => ({
        action: "start",
        caller: {
          displayName: "Sam",
          slug: "",
          platform: "teams",
          model: { id: "composer-2.5", params: [{ id: "fast", value: "false" }] },
        },
      }),
      startFromMessage: async (message) => {
        started.push(message);
      },
    });
    assert.equal(first.started, 1);
    assert.equal(started[0].guestCaller.displayName, "Sam");

    await saveMentionState(
      { lastAt: "2026-09-09T17:40:00.000Z", seenIds: [] },
      statePath
    );
    const group = {
      ...hit,
      id: "g2",
      chatType: "group",
      chat: "Class GC",
      at: "2026-09-09T17:40:10Z",
    };
    const second = await pollTeamsAgentMentions({
      statePath,
      now: () => new Date("2026-09-09T17:40:12.000Z"),
      fetchRecent: async () => [group],
      evaluateGuestMention: async () => ({ action: "ignore" }),
      startFromMessage: async (message) => {
        started.push(message);
      },
    });
    assert.equal(second.started, 0);
    assert.equal(started.length, 1);
  });
});
