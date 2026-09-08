import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMentionState,
  parseMentionState,
  pollIMessageAgentMentions,
  saveMentionState,
} from "./imessage-agent-mentions.js";

describe("imessage-agent-mentions poller", () => {
  it("parses empty state as no watermark", () => {
    const state = parseMentionState({});
    assert.equal(state.lastAt, "");
    assert.deepEqual(state.seenIds, []);
  });

  it("first poll only writes a watermark", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imessage-agent-"));
    const statePath = join(dir, "state.json");
    let fetched = false;
    const result = await pollIMessageAgentMentions({
      statePath,
      now: () => new Date("2026-09-08T17:36:00.000Z"),
      recentMessages: async () => {
        fetched = true;
        return [
          {
            fromMe: true,
            text: "@agent old",
            guid: "old",
            at: "2026-09-08 17:30:00",
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
    assert.equal(saved.lastAt, "2026-09-08T17:36:00.000Z");
  });

  it("starts a session for a new fromMe @agent and ignores repeats", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imessage-agent-"));
    const statePath = join(dir, "state.json");
    await saveMentionState(
      { lastAt: "2026-09-08T17:30:00.000Z", seenIds: [] },
      statePath
    );
    /** @type {object[]} */
    const started = [];
    const hit = {
      id: 9,
      guid: "G9",
      fromMe: true,
      text: "@Agent what's next",
      at: "2026-09-08 17:36:10",
      chat: "JYPE",
      chatId: "chat123",
      handle: "+14255550100",
    };
    const first = await pollIMessageAgentMentions({
      statePath,
      now: () => new Date("2026-09-08T17:36:12.000Z"),
      recentMessages: async (opts) => {
        assert.ok(opts.since);
        assert.equal(opts.previewStills, 0);
        return [
          hit,
          { ...hit, fromMe: false, guid: "other", text: "@agent ignore me" },
          { ...hit, guid: "plain", text: "no mention" },
        ];
      },
      findChatGuid: async (q) =>
        q === "chat123" ? "iMessage;+;chat123" : "",
      startFromMessage: async (message) => {
        started.push(message);
        return { sessionId: "sid" };
      },
    });
    assert.equal(first.started, 1);
    assert.equal(started.length, 1);
    assert.equal(started[0].guid, "G9");
    assert.equal(started[0].chatGuid, "iMessage;+;chat123");

    const second = await pollIMessageAgentMentions({
      statePath,
      now: () => new Date("2026-09-08T17:36:20.000Z"),
      recentMessages: async () => [hit],
      startFromMessage: async (message) => {
        started.push(message);
      },
    });
    assert.equal(second.started, 0);
    assert.equal(started.length, 1);
  });
});
