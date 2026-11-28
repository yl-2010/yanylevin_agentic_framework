import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatHistoryMessages, persistChatHistory } from "./home-chat-history.js";
import {
  VOICE_CONVERSATION_PROMPT,
  VOICE_TURN_NOTE,
  VOICE_COOLDOWN_MS,
  VOICE_HEARTBEAT_MS,
  VOICE_HEARTBEAT_MISSES,
  compressAgentReply,
  createVoiceBook,
  firstSentences,
  modelSpeech,
  parseSummaryBubbles,
  readVoiceSide,
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

describe("voice turn note", () => {
  it("tells Composer it may start the hard subagent", () => {
    assert.match(VOICE_TURN_NOTE, /start the hard subagent/);
    assert.match(VOICE_TURN_NOTE, /normal chat answer/);
  });
});

describe("voice model judgment", () => {
  it("keeps speech and treats a tool line as the side channel", () => {
    assert.deepEqual(readVoiceSide("to"), { tools: false, speech: "", pending: true });
    assert.deepEqual(readVoiceSide("tool"), { tools: false, speech: "", pending: true });
    assert.deepEqual(readVoiceSide("tool\nLooking at Friday."), {
      tools: true,
      speech: "Looking at Friday.",
      pending: false,
    });
    assert.deepEqual(readVoiceSide("Hello there."), {
      tools: false,
      speech: "Hello there.",
      pending: false,
    });
    assert.equal(readVoiceSide("tool", true).tools, true);
    assert.equal(readVoiceSide("tool", true).speech, "");
    const harmony =
      "<|channel|>analysis<|message|>tool<|end|><|channel|>final<|message|>Looking at Friday. The mail can wait.";
    assert.equal(modelSpeech(harmony).includes("tool"), false);
    const side = readVoiceSide(harmony);
    assert.equal(side.tools, true);
    assert.match(side.speech, /Looking at Friday/);
    assert.match(side.speech, /mail can wait/);
    assert.equal(side.speech.includes("tool"), false);
  });

  it("has no hello list and no canned holding line", () => {
    assert.equal(/checking/i.test(VOICE_CONVERSATION_PROMPT), false);
    assert.equal(/one second/i.test(VOICE_CONVERSATION_PROMPT), false);
    assert.equal(/yeah/i.test(VOICE_CONVERSATION_PROMPT), false);
    assert.equal(/\bhello\b/i.test(VOICE_CONVERSATION_PROMPT), false);
    assert.match(VOICE_CONVERSATION_PROMPT, /keep going/);
    assert.match(VOICE_CONVERSATION_PROMPT, /line by itself that is exactly tool/);
  });

  it("stays on the voice model unless the side channel asks for tools", async () => {
    /** @type {string[][]} */
    const prompts = [];
    const harness = bookWith({
      deps: {
        async *streamVoice(messages) {
          prompts.push(messages.map((row) => row.content));
          const heard = messages.at(-1).content;
          if (heard === "thanks") yield "I'll take a look.\nThe folder is the one from yesterday.\ntool\n";
          else yield "Hey.\n";
        },
      },
    });
    await harness.book.start({ email: YAN, device: "phone" });
    const hello = await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "move my calc homework to Friday",
      clientUtteranceId: "u-stay",
    });
    await harness.flush();
    assert.equal(hello.route, "stay");
    assert.equal(hello.speak[0].kind, "voice");
    assert.equal(hello.speak[0].text, "Hey.");
    assert.equal(harness.overrides.sends || 0, 0);
    const call = harness.book.bySession.get("voice-sess1");
    assert.equal(call.turns.at(-1).spoken, "Hey.");
    const thanks = await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "thanks",
      clientUtteranceId: "u-agent",
    });
    assert.equal(thanks.route, "tool");
    assert.equal(thanks.speak[0].text, "I'll take a look.");
    assert.equal(thanks.speak[1].text, "The folder is the one from yesterday.");
    assert.equal(thanks.speak.every((chunk) => chunk.kind === "voice"), true);
    assert.equal(harness.overrides.sends, 1);
    assert.match(prompts[1].join("\n"), /Hey/);
    assert.equal(prompts[1].some((line) => line === "Checking."), false);
    assert.equal(prompts[1].some((line) => /one second/i.test(line)), false);
  });

  it("keeps speaking while the tool channel runs", async () => {
    let releaseSend;
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve;
    });
    let started = false;
    const harness = bookWith({
      streamSpoken: async () => "Calc is due tomorrow.",
      deps: {
        async messageAgent() {
          started = true;
          await sendGate;
          return { ok: true };
        },
        async *streamVoice() {
          yield "Looking at Friday.\nI filed the college mail.\ntool\n";
        },
      },
    });
    await harness.book.start({ email: YAN, device: "phone" });
    const pending = harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "what's due tomorrow",
      clientUtteranceId: "u-hold",
    });
    const result = await pending;
    assert.equal(started, true);
    assert.equal(result.route, "tool");
    assert.equal(result.speak.length, 2);
    assert.equal(result.speak[0].text, "Looking at Friday.");
    assert.equal(result.speak[1].text, "I filed the college mail.");
    assert.equal(result.speak.every((chunk) => chunk.kind === "voice"), true);
    await harness.book.grokFinished({
      sessionId: "voice-sess1",
      utteranceId: "u-hold",
      content: "Calc is due tomorrow.",
    });
    const call = harness.book.bySession.get("voice-sess1");
    assert.equal(call.speak.filter((chunk) => chunk.kind === "voice").length, 3);
    assert.equal(call.speak.some((chunk) => chunk.kind === "answer"), false);
    assert.equal(call.speak[0].text, "Looking at Friday.");
    assert.match(call.speak.at(-1).text, /Calc is due tomorrow/);
    releaseSend();
  });

  it("does not start Composer when the local model is missing", async () => {
    const harness = bookWith();
    await harness.book.start({ email: YAN, device: "phone" });
    const result = await harness.book.utterance({
      email: YAN,
      sessionId: "voice-sess1",
      device: "phone",
      text: "what's due tomorrow",
      clientUtteranceId: "u-down",
    });
    assert.equal(result.route, "stay");
    assert.equal(result.speak.length, 0);
    assert.equal(harness.overrides.sends || 0, 0);
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

  it("reset dormants the open call and starts a new session", async () => {
    let n = 0;
    let cancelled = "";
    const harness = bookWith({
      deps: {
        async startAgent() {
          n += 1;
          return { sessionId: `sess-${n}` };
        },
        async cancelTurn(sessionId) {
          cancelled = sessionId;
        },
      },
    });
    const first = await harness.book.start({ email: YAN, device: "phone" });
    assert.equal(first.sessionId, "sess-1");
    const second = await harness.book.reset({
      email: YAN,
      sessionId: first.sessionId,
      device: "phone",
    });
    assert.equal(second.claimed, true);
    assert.equal(second.sessionId, "sess-2");
    const old = harness.book.bySession.get("sess-1");
    assert.equal(old.dormant, true);
    assert.equal(old.activeDevice, null);
    assert.equal(cancelled, "sess-1");
    const again = await harness.book.start({ email: YAN, device: "phone" });
    assert.equal(again.sessionId, "sess-2");
  });

  it("reset with no call still starts one", async () => {
    let n = 0;
    const harness = bookWith({
      deps: {
        async startAgent() {
          n += 1;
          return { sessionId: `fresh-${n}` };
        },
      },
    });
    const started = await harness.book.reset({ email: YAN, device: "phone" });
    assert.equal(started.claimed, true);
    assert.equal(started.sessionId, "fresh-1");
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
        async *streamVoice() {
          yield "Sounds good.\n";
        },
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
      await harness.flush();
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
      assert.equal(messages[1].content.includes("Okay."), false);
      assert.equal(parseSummaryBubbles("nope", [{ role: "user" }]), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
