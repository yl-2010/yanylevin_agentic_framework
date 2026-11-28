import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatHistoryMessages, persistChatHistory } from "./home-chat-history.js";
import {
  VOICE_ACK_SOCIAL,
  VOICE_COOLDOWN_MS,
  VOICE_HEARTBEAT_MS,
  VOICE_HEARTBEAT_MISSES,
  compressAgentReply,
  createVoiceBook,
  firstSentences,
  isSocialUtterance,
  parseSummaryBubbles,
  spokenLineAddsNoun,
} from "./voice-agent.js";

const YAN = "you@example.com";

function bookWith(overrides = {}) {
  let clock = 1_700_000_000_000;
  /** @type {{ fn: Function, at: number, cancelled: boolean }[]} */
  const timers = [];
  const session = overrides.session || { status: "idle", turnQueue: [], workingLabel: null };
  let writes = 0;
  /** @type {any} */
  let saved = null;
  const book = createVoiceBook({
    now: () => clock,
    schedule(fn, ms) {
      const row = { fn, at: clock + ms, cancelled: false };
      timers.push(row);
      return () => {
        row.cancelled = true;
      };
    },
    async startAgent() {
      return { sessionId: "voice-sess1" };
    },
    async messageAgent(_sid, _email, text) {
      overrides.heard = text;
      overrides.sends = (overrides.sends || 0) + 1;
      return { ok: true };
    },
    session: () => session,
    async sendSummary() {
      overrides.summarySends = (overrides.summarySends || 0) + 1;
      return overrides.summaryText || "not json";
    },
    async commitSummary(_call, bubbles) {
      writes += 1;
      saved = bubbles;
    },
    streamSpoken: overrides.streamSpoken,
    ...overrides.deps,
  });
  return {
    book,
    session,
    timers,
    get writes() {
      return writes;
    },
    get saved() {
      return saved;
    },
    overrides,
    setClock(ms) {
      clock = ms;
    },
    clock: () => clock,
    async flush() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    async fireDue() {
      const due = timers.filter((row) => !row.cancelled && row.at <= clock);
      for (const row of due) {
        row.cancelled = true;
        await row.fn();
      }
    },
  };
}

describe("voice social line", () => {
  it("treats hey, thanks, stop, and never mind as social", () => {
    assert.equal(isSocialUtterance("hey"), true);
    assert.equal(isSocialUtterance("Thanks!"), true);
    assert.equal(isSocialUtterance("stop"), true);
    assert.equal(isSocialUtterance("never mind"), true);
    assert.equal(isSocialUtterance("move my calc homework to Friday"), false);
  });

  it("does not start Grok for a social line", async () => {
    const harness = bookWith();
    await harness.book.start({ email: YAN, device: "phone" });
    const result = await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "never mind",
      clientUtteranceId: "u-social",
    });
    assert.equal(result.social, true);
    assert.equal(harness.overrides.sends || 0, 0);
    const call = harness.book.bySession.get("voice-sess1");
    assert.equal(call.turns[1].spoken, VOICE_ACK_SOCIAL);
  });
});

describe("spoken answer", () => {
  it("uses the first two sentences when LM Studio is down", async () => {
    const reply = "I filed the college mail. The scan is in the folder. Extra detail stays out.";
    const line = await compressAgentReply(reply, {
      streamSpoken: async () => {
        throw new Error("LM Studio down");
      },
    });
    assert.equal(line, firstSentences(reply, 2));
    assert.equal(line.includes("Extra"), false);
  });

  it("rejects a spoken line that adds a noun", () => {
    const reply = "I filed the college mail.";
    assert.equal(spokenLineAddsNoun(reply, "I filed the college mail."), false);
    assert.equal(spokenLineAddsNoun(reply, "I bought groceries today."), true);
  });
});

describe("one device and the summary wait", () => {
  it("refuses the other device until this one is dormant", async () => {
    const harness = bookWith();
    await harness.book.start({ email: YAN, device: "phone" });
    const padStart = await harness.book.start({ email: YAN, device: "pad" });
    assert.equal(padStart.claimed, false);
    assert.equal(padStart.activeDevice, "phone");
    await assert.rejects(
      harness.book.utterance({
        email: YAN,
        sessionId: "voice-sess1",
        device: "pad",
        text: "what is due",
        clientUtteranceId: "u-pad",
      }),
      (err) => err.status === 409
    );
    const blocked = await harness.book.resume({
      email: YAN,
      sessionId: "voice-sess1",
      device: "pad",
    });
    assert.equal(blocked.onOtherDevice, true);
    await harness.book.dormant({ email: YAN, sessionId: "voice-sess1", device: "phone" });
    const resumed = await harness.book.resume({
      email: YAN,
      sessionId: "voice-sess1",
      device: "pad",
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.activeDevice, "pad");
  });

  it("marks the session dormant after two missed heartbeats", async () => {
    const harness = bookWith();
    await harness.book.start({ email: YAN, device: "phone" });
    const started = harness.clock();
    harness.setClock(started + VOICE_HEARTBEAT_MS * VOICE_HEARTBEAT_MISSES - 1);
    harness.book.pulse();
    assert.equal(harness.book.bySession.get("voice-sess1").dormant, false);
    harness.setClock(started + VOICE_HEARTBEAT_MS * VOICE_HEARTBEAT_MISSES);
    harness.book.pulse();
    await harness.flush();
    assert.equal(harness.book.bySession.get("voice-sess1").dormant, true);
    assert.equal(harness.book.bySession.get("voice-sess1").activeDevice, null);
  });

  it("starts the minute when the agents go idle, not when he leaves", async () => {
    const harness = bookWith({
      streamSpoken: async () => "I filed the college mail.",
    });
    harness.session.status = "running";
    await harness.book.start({ email: YAN, device: "phone" });
    await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "file the college mail",
      clientUtteranceId: "u-work",
    });
    await harness.book.dormant({ email: YAN, sessionId: "voice-sess1", device: "phone" });
    await harness.flush();
    assert.equal(harness.book.bySession.get("voice-sess1").cooldownDeadline, null);
    harness.session.status = "idle";
    await harness.book.grokFinished({
      sessionId: "voice-sess1",
      utteranceId: "u-work",
      content: "I filed the college mail.",
    });
    const deadline = harness.book.bySession.get("voice-sess1").cooldownDeadline;
    assert.equal(deadline, harness.clock() + VOICE_COOLDOWN_MS);
  });

  it("cancels the summary if he picks the session back up", async () => {
    const harness = bookWith();
    await harness.book.start({ email: YAN, device: "phone" });
    await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "thanks",
      clientUtteranceId: "u-thanks",
    });
    await harness.book.dormant({ email: YAN, sessionId: "voice-sess1", device: "phone" });
    await harness.flush();
    assert.ok(harness.book.bySession.get("voice-sess1").cooldownDeadline);
    await harness.book.resume({ email: YAN, sessionId: "voice-sess1", device: "phone" });
    harness.setClock(harness.clock() + VOICE_COOLDOWN_MS + 1000);
    await harness.fireDue();
    assert.equal(harness.writes, 0);
    assert.equal(harness.book.bySession.get("voice-sess1").summarized, false);
  });

  it("does not write the chat when the summary JSON is bad", async () => {
    const harness = bookWith({ summaryText: "sure thing" });
    await harness.book.start({ email: YAN, device: "phone" });
    await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "hey",
      clientUtteranceId: "u-hey",
    });
    await harness.book.dormant({ email: YAN, sessionId: "voice-sess1", device: "phone" });
    await harness.flush();
    harness.setClock(harness.book.bySession.get("voice-sess1").cooldownDeadline);
    await harness.fireDue();
    assert.equal(harness.overrides.summarySends, 2);
    assert.equal(harness.writes, 0);
    assert.equal(harness.book.bySession.get("voice-sess1").summarized, false);
    assert.equal(harness.book.bySession.get("voice-sess1").summaryHold, true);
  });

  it("writes one summary bubble per turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "voice-summary-"));
    const bubbles = [
      { role: "user", text: "He asked to file the college mail." },
      { role: "assistant", text: "The agent filed the college mail." },
    ];
    const harness = bookWith({
      summaryText: JSON.stringify({ bubbles }),
      deps: {
        async commitSummary(call, rows) {
          await persistChatHistory({
            root,
            email: call.email,
            sessionId: call.sessionId,
            messages: rows.map((row) => ({
              role: row.role,
              content: row.text,
              at: "2026-11-27T20:00:00.000Z",
            })),
          });
        },
      },
    });
    try {
      await harness.book.start({ email: YAN, device: "phone" });
      await harness.book.utterance({
        email: YAN,
        sessionId: "voice-sess1",
        device: "phone",
        text: "thanks",
        clientUtteranceId: "u-sum",
      });
      await harness.book.dormant({ email: YAN, sessionId: "voice-sess1", device: "phone" });
      await harness.flush();
      harness.setClock(harness.book.bySession.get("voice-sess1").cooldownDeadline);
      await harness.fireDue();
      const markdown = await readFile(
        join(root, "home", YAN, ".chat-history", "voice-sess1.md"),
        "utf8"
      );
      const messages = parseChatHistoryMessages(markdown);
      assert.equal(messages.length, 2);
      assert.equal(messages[0].content, bubbles[0].text);
      assert.equal(messages[1].content, bubbles[1].text);
      assert.equal(messages[1].content.includes(VOICE_ACK_SOCIAL), false);
      assert.equal(parseSummaryBubbles("nope", [{ role: "user" }]), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
