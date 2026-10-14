import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isWhatsAppAgentPaused,
  PAUSE_PATH,
  pollWhatsAppAgentMentions,
} from "./whatsapp-agent-mentions.js";
import { writeFile, unlink } from "node:fs/promises";

describe("whatsapp mention poll", () => {
  async function clearPause() {
    await unlink(PAUSE_PATH).catch(() => {});
  }

  it("does nothing while the agent is off", async () => {
    const result = await pollWhatsAppAgentMentions({
      recentMessages: async () => {
        throw new Error("should not read");
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, "disabled");
    assert.equal(result.started, 0);
  });

  it("skips polling when paused", async () => {
    await writeFile(PAUSE_PATH, "paused\n", "utf8");
    try {
      const result = await pollWhatsAppAgentMentions({
        enabled: true,
        recentMessages: async () => {
          throw new Error("should not read");
        },
      });
      assert.equal(result.skipped, "paused");
      assert.ok(isWhatsAppAgentPaused());
    } finally {
      await unlink(PAUSE_PATH).catch(() => {});
    }
  });

  it("writes a watermark and starts nothing on the first poll", async () => {
    await clearPause();
    const dir = await mkdtemp(join(tmpdir(), "wa-mentions-"));
    const statePath = join(dir, "state.json");
    const result = await pollWhatsAppAgentMentions({
      enabled: true,
      statePath,
      recentMessages: async () => {
        throw new Error("should not read");
      },
      now: () => new Date("2026-10-13T19:00:00Z"),
    });
    assert.equal(result.skipped, "watermark");
    assert.equal(result.started, 0);
  });

  it("starts Yan and a guest, rate-limits, and does not retry a seen key", async () => {
    await clearPause();
    const dir = await mkdtemp(join(tmpdir(), "wa-mentions-"));
    const statePath = join(dir, "state.json");
    const now = () => new Date("2026-10-13T19:00:00Z");
    await pollWhatsAppAgentMentions({ enabled: true, statePath, now });

    const started = [];
    const limited = [];
    const rows = [
      {
        id: 1,
        guid: "yan",
        at: "2026-10-13T19:00:01Z",
        fromMe: true,
        text: "@agent",
        chat: "Birthday",
        chatJid: "123@g.us",
      },
      {
        id: 2,
        guid: "guest",
        at: "2026-10-13T19:00:02Z",
        fromMe: false,
        text: "@agent hi",
        chat: "Birthday",
        chatJid: "123@g.us",
        handle: "+15555550100",
        senderName: "Sam",
      },
      {
        id: 3,
        guid: "capped",
        at: "2026-10-13T19:00:03Z",
        fromMe: false,
        text: "@agent again",
        chat: "Birthday",
        chatJid: "123@g.us",
        handle: "+15555550199",
        senderName: "Pat",
      },
    ];
    const first = await pollWhatsAppAgentMentions({
      enabled: true,
      statePath,
      now,
      recentMessages: async () => rows,
      evaluateGuestMention: async ({ message }) => {
        if (message.guid === "capped") {
          return { action: "rate-limit", text: "hourly" };
        }
        return {
          action: "start",
          caller: { displayName: message.senderName, slug: "" },
        };
      },
      deliverGuestRateLimit: async (opts) => {
        limited.push(opts.message.guid);
        return { ok: true };
      },
      startFromMessage: async (message) => {
        started.push(message.guid);
      },
    });
    assert.equal(first.started, 2);
    assert.deepEqual(started, ["yan", "guest"]);
    assert.deepEqual(limited, ["capped"]);

    started.length = 0;
    const second = await pollWhatsAppAgentMentions({
      enabled: true,
      statePath,
      now: () => new Date("2026-10-13T19:00:10Z"),
      recentMessages: async () => rows,
      startFromMessage: async (message) => {
        started.push(message.guid);
      },
    });
    assert.equal(second.started, 0);
    assert.deepEqual(started, []);
  });
});
