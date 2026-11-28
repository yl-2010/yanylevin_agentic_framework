/**
 * Voice session on the agent worker.
 * One Personal Agent session per call. Scratch until the summary is written.
 * One device listens. Dormant is not the summary. The summary waits until the
 * session is dormant and every agent turn and spoken line is finished, then
 * one more minute.
 *
 * Speech goes through voice-speech-client.js, which talks to
 * server/voice-speech.py on 127.0.0.1:3016. Port 1234 stays LM Studio.
 * This file does not expose either port.
 */

import { randomUUID } from "node:crypto";
import { hearForGrok, speak } from "./voice-speech-client.js";
import { readdir, readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { extractHarmonyChannels } from "./chat-theme.js";
import { chatHistoryAbsDir, PRASHAM_EMAIL, YAN_EMAIL } from "./onedrive-projects.js";
import { streamChatCompletions } from "./lmstudio.js";

export const VOICE_COOLDOWN_MS = 60_000;
export const VOICE_HEARTBEAT_MS = 5_000;
export const VOICE_HEARTBEAT_MISSES = 2;
export const VOICE_PARAKEET_BUDGET_MS = 1500;
/** How long the utterance post waits for the first spoken sentence. Not a measured model time. */
export const VOICE_ANSWER_CUTOFF_MS = 1500;
export const VOICE_ANSWER_HARD_MS = 8000;
export const VOICE_SPEAK_WORDS = 12;
export const VOICE_SUMMARY_MAX_TOKENS = 80;
export const VOICE_TALK_MAX_TOKENS = 120;

export const VOICE_TURN_NOTE =
  "This request was spoken. The work is the same as a typed turn. The final text is a normal chat answer. If the task is really hard, start the hard subagent. A normal question stays on this turn.";

/**
 * The local model stays in the call. The first word is its judgment.
 * That word is not spoken. There is no phrase list in this file.
 */
export const VOICE_CONVERSATION_PROMPT = [
  "You are the voice on this phone call. You stay in the conversation. Talk in short spoken sentences.",
  "The first word of each reply is stay or agent. That word is not spoken.",
  "agent means this turn needs tools or the Personal Agent. That includes mail, files, the calendar, todos, the brain, and anything you have to look up or change. After that word, say one short sentence in your own words, then stop. Do not answer the request.",
  "stay means you can answer from this conversation. After that word, speak the reply. Do not start the Personal Agent.",
].join(" ");

const SPOKEN_STOP = new Set(
  `a an the and or but if then so to of in on for at by with from as is are was were be been being it this that these those i you he she we they me him her us them my your his its our their not no nor do does did doing done have has had having will would can could should may might must about into over after before up down out off than too very just also only own same than`.split(
    /\s+/
  )
);

/** @type {Map<string, { text: string, sent: boolean, bag: any }>} */
const utteranceSlots = new Map();

/**
 * @param {unknown} raw
 * @returns {"phone"|"pad"|""}
 */
export function normalizeVoiceDevice(raw) {
  const d = String(raw || "")
    .trim()
    .toLowerCase();
  if (d === "phone" || d === "pad") return d;
  return "";
}

/**
 * Text the voice model has actually said so far.
 * gpt-oss sometimes streams a Harmony analysis channel first. That channel is not speech.
 * @param {unknown} raw
 */
export function modelSpeech(raw) {
  const text = String(raw || "");
  if (text.includes("<|")) {
    const channels = extractHarmonyChannels(text);
    const finals = channels.filter((row) => row.channel === "final");
    if (!finals.length) return "";
    return finals[finals.length - 1].body
      .replace(/<\|[^|>]*$/g, "")
      .replace(/<\|[^|>]{0,120}\|>/g, "");
  }
  return text.replace(/<\|[^|>]*$/g, "");
}

/**
 * The model's first word is the route. It is not spoken.
 * `agent` starts Composer. Anything else, including a reply with no marker, stays on this model.
 * A prefix of the marker stays pending until the word is finished.
 * @param {unknown} speech
 * @param {boolean} [flush]
 * @returns {{ route: "agent"|"stay"|null, speech: string, pending: boolean }}
 */
export function readVoiceRoute(speech, flush = false) {
  const body = String(speech || "").replace(/^\s+/, "");
  if (!body) return { route: null, speech: "", pending: !flush };
  const match = body.match(/^([A-Za-z]+)([\s\S]*)$/);
  if (!match) return { route: "stay", speech: body, pending: false };
  const word = match[1].toLowerCase();
  const after = match[2];
  const isRoute = word === "agent" || word === "stay";
  const isPrefix = !isRoute && ("agent".startsWith(word) || "stay".startsWith(word));
  if ((isPrefix || isRoute) && after === "" && !flush) {
    return { route: null, speech: "", pending: true };
  }
  if (isRoute && (after === "" || /^[\s.!?]/.test(after))) {
    const spoken = after.replace(/^[.!?]+\s*/, "").replace(/^\s+/, "");
    return { route: word, speech: spoken, pending: false };
  }
  return { route: "stay", speech: body, pending: false };
}

/**
 * @param {string} text
 * @param {number} [count]
 */
export function firstSentences(text, count = 2) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  const parts = src.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, count)
    .join(" ");
}

/**
 * Pull one speakable piece off the front of a streaming buffer.
 * A sentence if one is finished, otherwise about twelve words.
 * @param {string} buffer
 * @param {boolean} flush
 * @returns {{ piece: string, rest: string }|null}
 */
export function splitSpeakable(buffer, flush) {
  const text = String(buffer || "");
  const sentence = text.match(/^[\s\S]*?[.!?]+(?=\s|$)/);
  if (sentence && sentence[0].trim()) {
    return { piece: sentence[0].trim(), rest: text.slice(sentence[0].length) };
  }
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= VOICE_SPEAK_WORDS) {
    const piece = words.slice(0, VOICE_SPEAK_WORDS).join(" ");
    const at = text.indexOf(words[VOICE_SPEAK_WORDS - 1]);
    const rest = at >= 0 ? text.slice(at + words[VOICE_SPEAK_WORDS - 1].length) : "";
    return { piece, rest };
  }
  if (flush && text.trim()) return { piece: text.trim(), rest: "" };
  return null;
}

/**
 * @param {string} turn
 * @param {string} text
 */
export function replaceVoiceUserText(turn, text) {
  const marker = "\nUser:\n";
  const src = String(turn || "");
  const at = src.lastIndexOf(marker);
  if (at < 0) return src;
  return src.slice(0, at + marker.length) + text;
}

/**
 * True when the spoken line names something the agent reply did not.
 * Imperfect on purpose. A shared stem still counts as inside.
 * @param {string} reply
 * @param {string} spoken
 */
export function spokenLineAddsNoun(reply, spoken) {
  const known = new Set(contentWords(reply));
  for (const word of contentWords(spoken)) {
    if (!known.has(word)) return true;
  }
  return false;
}

/**
 * @param {string} text
 */
function contentWords(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !SPOKEN_STOP.has(w));
}

/**
 * @param {string} id
 * @param {string} text
 */
export function openUtteranceSlot(id, text) {
  const slot = { text: String(text || ""), sent: false, bag: null };
  utteranceSlots.set(id, slot);
  return slot;
}

/**
 * @param {string} id
 * @param {{ turnOpts?: object, userMessage?: object }} bag
 */
export function bindVoiceUtterance(id, bag) {
  const slot = utteranceSlots.get(id);
  if (!slot) return;
  slot.bag = bag || null;
}

/**
 * @param {string} id
 * @param {object} row
 */
export function attachVoiceUserMessage(id, row) {
  const slot = utteranceSlots.get(id);
  if (slot?.bag) slot.bag.userMessage = row;
}

/**
 * Parakeet may replace the line until agent.send.
 * @param {string} id
 * @param {string} text
 */
export function offerVoiceTranscript(id, text) {
  const slot = utteranceSlots.get(id);
  const next = String(text || "").trim();
  if (!slot || slot.sent || !next) return false;
  slot.text = next;
  if (slot.bag?.turnOpts) {
    slot.bag.turnOpts.bubble = next;
    if (slot.bag.turnOpts.promptPlan) {
      slot.bag.turnOpts.promptPlan.turn = replaceVoiceUserText(
        slot.bag.turnOpts.promptPlan.turn,
        next
      );
    }
  }
  if (slot.bag?.userMessage) slot.bag.userMessage.content = next;
  return true;
}

/**
 * Marks the send as gone. Returns the text Grok should hear.
 * @param {string} id
 */
export function takeVoiceTextBeforeSend(id) {
  const slot = utteranceSlots.get(id);
  if (!slot) return "";
  slot.sent = true;
  const text = String(slot.text || "");
  if (slot.bag?.userMessage && text) slot.bag.userMessage.content = text;
  return text;
}

/**
 * One or two spoken sentences from the agent reply.
 * If no sentence arrives inside the cutoff, the first two sentences of the reply.
 * @param {string} reply
 * @param {{ streamSpoken?: (reply: string, signal: AbortSignal) => Promise<string> }} [deps]
 */
export async function compressAgentReply(reply, deps = {}) {
  const fallback = firstSentences(reply, 2);
  const streamSpoken = deps.streamSpoken || streamSpokenAnswer;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VOICE_ANSWER_HARD_MS);
  let line = "";
  try {
    line = await Promise.race([
      streamSpoken(reply, ac.signal),
      rejectAfter(VOICE_ANSWER_CUTOFF_MS),
    ]);
  } catch {
    line = "";
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  const spoken = firstSentences(String(line || ""), 2).trim();
  if (!spoken) return fallback;
  if (spokenLineAddsNoun(reply, spoken)) return fallback;
  return spoken;
}

/**
 * @param {number} ms
 */
function rejectAfter(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("spoken cutoff")), ms);
  });
}

/**
 * @param {string} reply
 * @param {AbortSignal} signal
 */
async function streamSpokenAnswer(reply, signal) {
  const messages = [
    {
      role: "system",
      content: [
        "Turn the agent reply into one or two spoken sentences.",
        "Say only what the agent text says.",
        "Do not add a fact, a name, or a result that is not in the reply.",
        "Do not claim a result the reply does not state.",
      ].join(" "),
    },
    { role: "user", content: String(reply || "") },
  ];
  let buffer = "";
  const gen = streamChatCompletions({
    messages,
    maxTokens: VOICE_SUMMARY_MAX_TOKENS,
    temperature: 0.2,
    signal,
  });
  for await (const delta of gen) {
    buffer += delta;
    const split = splitSpeakable(buffer, false);
    if (!split) continue;
    if (spokenLineAddsNoun(reply, split.piece)) return "";
    const second = splitSpeakable(split.rest, false);
    if (second && !spokenLineAddsNoun(reply, second.piece)) {
      return `${split.piece} ${second.piece}`;
    }
    return split.piece;
  }
  const tail = splitSpeakable(buffer, true);
  if (tail && !spokenLineAddsNoun(reply, tail.piece)) return tail.piece;
  return "";
}

/**
 * @param {string} raw
 * @param {{ role: string }[]} turns
 * @returns {{ role: "user"|"assistant", text: string }[]|null}
 */
export function parseSummaryBubbles(raw, turns) {
  const src = String(raw || "").trim();
  if (!src || !Array.isArray(turns) || !turns.length) return null;
  const stripped = src
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  let data;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  const bubbles = data?.bubbles;
  if (!Array.isArray(bubbles) || bubbles.length !== turns.length) return null;
  /** @type {{ role: "user"|"assistant", text: string }[]} */
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const bubble = bubbles[i];
    const role = bubble?.role === "assistant" || bubble?.role === "user" ? bubble.role : "";
    const text = String(bubble?.text || bubble?.content || "").trim();
    if (!text || role !== turns[i].role) return null;
    out.push({ role, text });
  }
  return out;
}

/**
 * @param {{ role: string, text: string, spoken?: string, full?: string, at?: string }[]} turns
 */
export function summaryPrompt(turns) {
  const lines = [
    "Write the chat bubbles for a voice conversation that already happened.",
    "Return JSON only. No tools. Do not edit files. Do not call tools.",
    'Shape: {"bubbles":[{"role":"user"|"assistant","text":"..."}]}',
    `There are ${turns.length} turns. Return one bubble per turn, same order, same roles.`,
    "Each bubble is a short summary of that turn. Not a verbatim line. Not a transcript of the audio.",
    "A user bubble summarizes what he said. An assistant bubble summarizes what the agent answered, including the result.",
    "Do not paste the full tool answer. Do not keep only the short sentence that was spoken.",
    "",
    "Turns:",
  ];
  turns.forEach((turn, i) => {
    lines.push(`${i + 1}. ${turn.role} at ${turn.at || ""}`);
    lines.push(String(turn.text || ""));
    if (turn.role === "assistant" && turn.spoken && turn.spoken !== turn.text) {
      lines.push(`Spoken aloud: ${turn.spoken}`);
    }
    if (turn.role === "assistant" && turn.full && turn.full !== turn.text) {
      lines.push(`Full answer: ${turn.full}`);
    }
  });
  return lines.join("\n");
}

export function summaryRetryPrompt(turns) {
  return `${summaryPrompt(turns)}\n\nThe last reply was not one JSON bubble per turn. Return JSON only.`;
}

function httpError(status, message) {
  const err = new Error(message);
  /** @type {any} */ (err).status = status;
  return err;
}


/**
 * @param {object} deps
 */
export function createVoiceBook(deps) {
  /** @type {Map<string, any>} */
  const bySession = new Map();
  /** @type {Map<string, string>} */
  const byEmail = new Map();
  const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const schedule =
    deps.schedule ||
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return () => clearTimeout(t);
    });

  function findEmailCall(email) {
    const sid = byEmail.get(email);
    return sid ? bySession.get(sid) : null;
  }

  async function save(call) {
    if (typeof deps.saveLedger !== "function") return;
    await deps.saveLedger(call.email, ledgerSnapshot(call)).catch(() => {});
  }

  function clearTimer(call) {
    if (call.cancelTimer) call.cancelTimer();
    call.cancelTimer = null;
  }

  async function idle(call) {
    if (call.pendingSpeak?.size > 0 || call.compressing || call.voicing) return false;
    const session = deps.session ? deps.session(call.sessionId) : null;
    if (session) {
      if (session.status === "running") return false;
      if ((session.turnQueue || []).length > 0) return false;
    }
    if (typeof deps.runningHas === "function") {
      const ids = await deps.runningHas(call.email);
      if (Array.isArray(ids) && ids.includes(call.sessionId)) return false;
    }
    return true;
  }

  async function arm(call) {
    if (call.summarized || call.summarizing) return;
    if (!call.dormant) return;
    const quiet = await idle(call);
    if (call.summaryHold) {
      if (quiet && (call.sawBusy || call.sawLive)) {
        call.summaryHold = false;
        call.sawBusy = false;
        call.sawLive = false;
      } else {
        if (!quiet) call.sawBusy = true;
        return;
      }
    }
    if (!quiet) {
      call.sawBusy = true;
      if (call.cooldownDeadline) {
        call.cooldownDeadline = null;
        clearTimer(call);
        await save(call);
      }
      return;
    }
    const t = now();
    if (!call.cooldownDeadline) {
      call.cooldownDeadline = t + VOICE_COOLDOWN_MS;
      await save(call);
    }
    clearTimer(call);
    const wait = Math.max(0, call.cooldownDeadline - t);
    call.cancelTimer = schedule(
      () => fireSummary(call).catch((err) => console.error("[voice] summary", err)),
      wait
    );
  }

  function markDormant(call) {
    if (call.summarized || call.dormant) return;
    call.dormant = true;
    call.activeDevice = null;
    call.dormantAt = now();
    void save(call);
    void arm(call);
  }

  async function fireSummary(call) {
    if (call.summarized || call.summarizing || !call.dormant) return;
    if (call.cooldownDeadline && now() + 5 < call.cooldownDeadline) return;
    if (!(await idle(call))) {
      call.cooldownDeadline = null;
      await arm(call);
      return;
    }
    if (!call.turns.length) {
      call.cooldownDeadline = null;
      await save(call);
      return;
    }
    call.summarizing = true;
    call.cooldownDeadline = null;
    clearTimer(call);
    await save(call);
    let bubbles = null;
    try {
      const first = await deps.sendSummary(call, summaryPrompt(call.turns));
      bubbles = parseSummaryBubbles(first, call.turns);
      if (!bubbles) {
        const second = await deps.sendSummary(call, summaryRetryPrompt(call.turns));
        bubbles = parseSummaryBubbles(second, call.turns);
      }
    } catch (err) {
      console.error("[voice] summary send", err);
      bubbles = null;
    }
    if (!bubbles) {
      call.summarizing = false;
      call.summaryHold = true;
      call.sawBusy = false;
      call.sawLive = false;
      await save(call);
      return;
    }
    await deps.commitSummary(call, bubbles);
    call.summarizing = false;
    call.summarized = true;
    call.summarySaved = true;
    call.phaseNote = "saved";
    if (byEmail.get(call.email) === call.sessionId) byEmail.delete(call.email);
    await save(call);
    if (typeof deps.onSaved === "function") {
      try {
        deps.onSaved(call);
      } catch {
        /* phone haptic is not this process */
      }
    }
  }

  function requireCall(sessionId, email) {
    const call = bySession.get(sessionId);
    if (!call || call.email !== email) throw httpError(404, "voice session not found");
    return call;
  }

  function stateOf(call, session) {
    const phase = call.summarizing
      ? "working"
      : call.speaking
        ? "composing"
        : call.voicing || call.compressing
          ? "working"
          : session?.status === "running"
            ? "searching"
            : call.dormant || !call.activeDevice
              ? "breathing"
              : "listening";
    return {
      ok: true,
      sessionId: call.sessionId,
      phase,
      caption: call.speakingText || call.caption || "",
      agentStatus: session?.status || "idle",
      workingLabel: session?.status === "running" ? session.workingLabel || null : null,
      activeDevice: call.activeDevice,
      dormant: call.dormant,
      summarizing: call.summarizing,
      summarized: call.summarized,
      summarySaved: Boolean(call.summarySaved),
      speak: call.speak,
    };
  }

  function pushSpeak(call, text, kind, utteranceId) {
    const id = randomUUID();
    const chunk = { id, text, kind, audioId: null, utteranceId: utteranceId || "" };
    call.speak.push(chunk);
    if (call.speak.length > 40) call.speak.splice(0, call.speak.length - 40);
    if (kind === "voice") notifyVoiceLine(call);
    if (typeof deps.synthesize === "function" && text) {
      deps
        .synthesize(text)
        .then((audio) => {
          if (!audio?.bytes?.length) return;
          const audioId = randomUUID();
          call.audio.set(audioId, audio);
          chunk.audioId = audioId;
        })
        .catch(() => {});
    }
    return chunk;
  }

  return {
    bySession,
    async start({ email, device }) {
      const who = String(email || "").trim();
      const dev = normalizeVoiceDevice(device);
      if (!who) throw httpError(400, "email required");
      if (!dev) throw httpError(400, "device required");
      const existing = findEmailCall(who);
      if (existing && !existing.summarized) {
        if (existing.activeDevice && existing.activeDevice !== dev && !existing.dormant) {
          return {
            ok: true,
            sessionId: existing.sessionId,
            activeDevice: existing.activeDevice,
            claimed: false,
            dormant: false,
          };
        }
        existing.dormant = false;
        existing.activeDevice = dev;
        existing.lastHeartbeatAt = now();
        existing.sawLive = true;
        clearTimer(existing);
        existing.cooldownDeadline = null;
        existing.summaryHold = false;
        await save(existing);
        return {
          ok: true,
          sessionId: existing.sessionId,
          activeDevice: dev,
          claimed: true,
          dormant: false,
        };
      }
      const started = await deps.startAgent(who);
      const sessionId = started.sessionId;
      const call = {
        sessionId,
        email: who,
        activeDevice: dev,
        dormant: false,
        lastHeartbeatAt: now(),
        dormantAt: null,
        cooldownDeadline: null,
        summaryHold: false,
        summarizing: false,
        summarized: false,
        summarySaved: false,
        sawBusy: false,
        sawLive: false,
        pendingSpeak: new Set(),
        compressing: false,
        voicing: false,
        voiceFor: "",
        voiceAbort: null,
        voiceLineDone: null,
        voiceRoute: "",
        voiceMemory: [],
        speaking: false,
        speakingText: "",
        caption: "",
        turns: [],
        speak: [],
        audio: new Map(),
        seen: new Map(),
        cancelTimer: null,
      };
      bySession.set(sessionId, call);
      byEmail.set(who, sessionId);
      await save(call);
      return { ok: true, sessionId, activeDevice: dev, claimed: true, dormant: false };
    },

    async utterance({ email, sessionId, text, clientUtteranceId, interrupt, device, audioBase64 }) {
      const dev = normalizeVoiceDevice(device);
      if (!dev) throw httpError(400, "device required");
      const call = requireCall(String(sessionId || ""), String(email || ""));
      if (call.summarized) throw httpError(409, "voice session already saved");
      if (call.summarizing) throw httpError(409, "voice session is saving");
      if (!call.activeDevice || call.dormant || call.activeDevice !== dev) {
        throw httpError(409, "session is on the other device");
      }
      const id = String(clientUtteranceId || "").trim();
      const said = String(text || "").trim();
      if (!id || !said) throw httpError(400, "clientUtteranceId and text required");
      if (call.seen.has(id)) return { ...call.seen.get(id), duplicate: true };
      call.lastHeartbeatAt = now();
      const at = new Date(now()).toISOString();
      openUtteranceSlot(id, said);
      call.caption = said;
      call.turns.push({ role: "user", text: said, at, utteranceId: id });
      call.pendingSpeak.add(id);
      call.voicing = true;
      call.voiceRoute = "";
      const record = {
        ok: true,
        sessionId: call.sessionId,
        clientUtteranceId: id,
        text: said,
        activeDevice: call.activeDevice,
        route: "",
        speak: [],
      };
      call.seen.set(id, record);
      stopVoice(call);
      const hearing = transcribeSwap(call, id, audioBase64, deps.transcribe);
      const wait = armVoiceWait(call);
      const task = runVoiceTurn(
        call,
        id,
        said,
        Boolean(interrupt),
        deps,
        now,
        (text, kind) => pushSpeak(call, text, kind, id)
      );
      const settled = task.then(() => save(call));
      if (typeof deps.streamVoice === "function") {
        const gate = sleep(VOICE_ANSWER_CUTOFF_MS);
        await Promise.race([wait, settled, gate.promise]);
        gate.cancel();
      } else {
        await settled;
      }
      void hearing;
      record.route = call.voiceRoute || "";
      record.speak = call.speak.filter((chunk) => chunk.utteranceId === id);
      await save(call);
      return record;
    },

    async grokFinished({ sessionId, utteranceId, content, dropped }) {
      const call = bySession.get(sessionId);
      if (!call || call.summarized) return;
      // The voice model is done talking. The spoken answer is the agent's text.
      stopVoice(call);
      const turn = call.turns.find((row) => row.utteranceId && row.utteranceId === utteranceId);
      if (dropped) {
        if (turn) {
          const idx = call.turns.indexOf(turn);
          if (idx >= 0) call.turns.splice(idx, 1);
        }
        call.pendingSpeak.delete(utteranceId);
        await arm(call);
        return;
      }
      const full = String(content || "").trim();
      const user = [...call.turns].reverse().find((row) => row.utteranceId === utteranceId);
      if (user) user.fullHeard = takeVoiceTextBeforeSend(utteranceId) || user.text;
      call.compressing = true;
      let spoken = "";
      try {
        spoken = await compressAgentReply(full, deps);
      } catch {
        spoken = firstSentences(full, 2);
      }
      call.compressing = false;
      call.turns.push({
        role: "assistant",
        text: full,
        full,
        spoken,
        at: new Date(now()).toISOString(),
        utteranceId,
      });
      if (spoken) rememberVoice(call, "assistant", spoken);
      if (user && user.fullHeard && user.fullHeard !== user.text) {
        user.text = user.fullHeard;
        call.caption = user.fullHeard;
      }
      call.speaking = true;
      call.speakingText = spoken;
      const parts = [];
      let rest = spoken;
      while (rest) {
        const split = splitSpeakable(rest, true);
        if (!split) break;
        parts.push(split.piece);
        rest = split.rest;
        if (parts.length >= 2) break;
      }
      for (const piece of parts) pushSpeak(call, piece, "answer");
      call.speaking = false;
      call.speakingText = "";
      call.pendingSpeak.delete(utteranceId);
      await save(call);
      await arm(call);
    },

    state({ email, sessionId, after }) {
      const call = requireCall(String(sessionId || ""), String(email || ""));
      const session = deps.session ? deps.session(call.sessionId) : null;
      const body = stateOf(call, session);
      const cursor = String(after || "");
      if (cursor) {
        const idx = body.speak.findIndex((chunk) => chunk.id === cursor);
        body.speak = idx >= 0 ? body.speak.slice(idx + 1) : body.speak;
      }
      return body;
    },

    audio({ email, sessionId, chunkId }) {
      const call = requireCall(String(sessionId || ""), String(email || ""));
      const id = String(chunkId || "");
      const hit = call.audio.get(id);
      if (!hit) return null;
      return {
        ok: true,
        mime: hit.mime || "audio/pcm",
        sampleRate: hit.sampleRate || 24000,
        audioBase64: Buffer.from(hit.bytes).toString("base64"),
      };
    },

    async dormant({ email, sessionId, device }) {
      const call = requireCall(String(sessionId || ""), String(email || ""));
      const dev = normalizeVoiceDevice(device);
      if (dev && call.activeDevice && call.activeDevice !== dev && !call.dormant) {
        return stateOf(call, deps.session ? deps.session(call.sessionId) : null);
      }
      markDormant(call);
      await save(call);
      return stateOf(call, deps.session ? deps.session(call.sessionId) : null);
    },

    async resume({ email, sessionId, device }) {
      const dev = normalizeVoiceDevice(device);
      if (!dev) throw httpError(400, "device required");
      const call = requireCall(String(sessionId || ""), String(email || ""));
      if (call.summarized) {
        return { ok: true, resumed: false, summarized: true, sessionId: call.sessionId };
      }
      if (call.summarizing) {
        return { ok: true, resumed: false, summarizing: true, sessionId: call.sessionId };
      }
      if (call.activeDevice && call.activeDevice !== dev && !call.dormant) {
        return {
          ok: true,
          resumed: false,
          activeDevice: call.activeDevice,
          onOtherDevice: true,
          sessionId: call.sessionId,
        };
      }
      call.dormant = false;
      call.activeDevice = dev;
      call.lastHeartbeatAt = now();
      call.sawLive = true;
      call.summaryHold = false;
      call.cooldownDeadline = null;
      clearTimer(call);
      await save(call);
      return {
        ok: true,
        resumed: true,
        activeDevice: dev,
        sessionId: call.sessionId,
        dormant: false,
      };
    },

    async heartbeat({ email, sessionId, device }) {
      const dev = normalizeVoiceDevice(device);
      const call = requireCall(String(sessionId || ""), String(email || ""));
      if (!dev || call.dormant || call.activeDevice !== dev) {
        return stateOf(call, deps.session ? deps.session(call.sessionId) : null);
      }
      call.lastHeartbeatAt = now();
      return stateOf(call, deps.session ? deps.session(call.sessionId) : null);
    },

    pulse(at) {
      const t = typeof at === "number" ? at : now();
      for (const call of bySession.values()) {
        if (call.summarized || call.dormant || !call.activeDevice) continue;
        const stale = t - call.lastHeartbeatAt;
        if (stale >= VOICE_HEARTBEAT_MS * VOICE_HEARTBEAT_MISSES) markDormant(call);
      }
    },

    restore(raw) {
      if (!raw || raw.summarized || !raw.sessionId || !raw.email) return;
      if (bySession.has(raw.sessionId)) return;
      const call = {
        sessionId: raw.sessionId,
        email: raw.email,
        activeDevice: null,
        dormant: true,
        lastHeartbeatAt: Number(raw.lastHeartbeatAt) || 0,
        dormantAt: Number(raw.dormantAt) || now(),
        cooldownDeadline: Number(raw.cooldownDeadline) || null,
        summaryHold: Boolean(raw.summaryHold),
        summarizing: false,
        summarized: false,
        summarySaved: false,
        sawBusy: false,
        sawLive: false,
        pendingSpeak: new Set(),
        compressing: false,
        voicing: false,
        voiceFor: "",
        voiceAbort: null,
        voiceLineDone: null,
        voiceRoute: "",
        voiceMemory: Array.isArray(raw.voiceMemory)
          ? raw.voiceMemory
          : memoryFromTurns(raw.turns),
        speaking: false,
        speakingText: "",
        caption: raw.caption || "",
        turns: Array.isArray(raw.turns) ? raw.turns : [],
        speak: [],
        audio: new Map(),
        seen: new Map(),
        cancelTimer: null,
      };
      bySession.set(call.sessionId, call);
      if (!byEmail.has(call.email)) byEmail.set(call.email, call.sessionId);
      if (call.dormant) void arm(call);
    },

    async armCall(sessionId) {
      const call = bySession.get(sessionId);
      if (call) await arm(call);
    },
  };
}

function stopVoice(call) {
  if (!call) return;
  if (call.voiceAbort) {
    call.voiceAbort.abort();
    call.voiceAbort = null;
  }
  call.voiceFor = "";
  notifyVoiceLine(call);
}

function armVoiceWait(call) {
  let done = () => {};
  const promise = new Promise((resolve) => {
    done = resolve;
  });
  call.voiceLineDone = () => {
    call.voiceLineDone = null;
    done();
  };
  return promise;
}

function notifyVoiceLine(call) {
  if (typeof call?.voiceLineDone === "function") call.voiceLineDone();
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  let timer;
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/**
 * @param {any} call
 * @param {string} role
 * @param {string} content
 */
function rememberVoice(call, role, content) {
  const text = String(content || "").trim();
  if (!text) return;
  if (!Array.isArray(call.voiceMemory)) call.voiceMemory = [];
  call.voiceMemory.push({ role, content: text });
  if (call.voiceMemory.length > 24) {
    call.voiceMemory.splice(0, call.voiceMemory.length - 24);
  }
}

/**
 * @param {{ role?: string, text?: string, spoken?: string }[]} turns
 */
function memoryFromTurns(turns) {
  if (!Array.isArray(turns)) return [];
  return turns
    .map((turn) => ({
      role: turn?.role === "assistant" ? "assistant" : "user",
      content: String(turn?.spoken || turn?.text || "").trim(),
    }))
    .filter((turn) => turn.content);
}

/**
 * One local model for the whole call. It speaks as soon as a sentence exists.
 * Composer starts only when that model says the turn needs tools.
 * @param {any} call
 * @param {string} id
 * @param {string} said
 * @param {boolean} interrupt
 * @param {object} deps
 * @param {() => number} now
 * @param {(text: string, kind: string) => void} push
 */
async function runVoiceTurn(call, id, said, interrupt, deps, now, push) {
  const ac = new AbortController();
  call.voiceAbort = ac;
  call.voiceFor = id;
  call.voicing = true;
  rememberVoice(call, "user", said);
  if (typeof deps.streamVoice !== "function") {
    call.pendingSpeak.delete(id);
    call.voicing = false;
    call.voiceRoute = "stay";
    if (interrupt && typeof deps.cancelTurn === "function") {
      void Promise.resolve(deps.cancelTurn(call.sessionId, call.email)).catch(() => {});
    }
    notifyVoiceLine(call);
    return;
  }
  const messages = [
    { role: "system", content: VOICE_CONVERSATION_PROMPT },
    ...call.voiceMemory.slice(0, -1).slice(-24),
    { role: "user", content: said },
  ];
  let raw = "";
  let route = "";
  let routed = false;
  let sentSpeech = "";
  let pendingBuf = "";
  let spokenCount = 0;
  let spokenText = "";
  let agentStarted = false;

  function startAgent() {
    if (agentStarted || call.voiceFor !== id) return;
    agentStarted = true;
    if (typeof deps.messageAgent !== "function") return;
    void Promise.resolve(
      deps.messageAgent(call.sessionId, call.email, said, id, interrupt)
    ).catch((err) => {
      console.error("[voice] agent", err);
      call.pendingSpeak.delete(id);
    });
  }

  function emit(piece) {
    const line = String(piece || "").trim();
    if (!line || call.voiceFor !== id) return;
    spokenCount += 1;
    spokenText = spokenText ? `${spokenText} ${line}` : line;
    push(line, "voice");
  }

  function drain(flush) {
    const limit = route === "agent" ? 1 : 4;
    while (spokenCount < limit) {
      const split = splitSpeakable(pendingBuf, false);
      if (!split) break;
      pendingBuf = split.rest;
      emit(split.piece);
    }
    if (flush && spokenCount < limit) {
      const tail = splitSpeakable(pendingBuf, true);
      if (tail?.piece) {
        pendingBuf = tail.rest;
        emit(tail.piece);
      }
    }
    if (route === "agent" && spokenCount >= 1) ac.abort();
  }

  function pump(flush) {
    if (call.voiceFor !== id) return;
    const judged = readVoiceRoute(modelSpeech(raw), flush);
    if (judged.pending) return;
    if (!routed) {
      routed = true;
      route = judged.route || "stay";
      call.voiceRoute = route;
      if (route === "agent") startAgent();
      else if (interrupt && typeof deps.cancelTurn === "function") {
        void Promise.resolve(deps.cancelTurn(call.sessionId, call.email)).catch(() => {});
      }
    }
    const full = judged.speech || "";
    const extra = full.startsWith(sentSpeech) ? full.slice(sentSpeech.length) : full;
    if (full.startsWith(sentSpeech)) sentSpeech = full;
    else sentSpeech += extra;
    if (extra) pendingBuf += extra;
    drain(flush);
  }

  try {
    const gen = deps.streamVoice(messages, ac.signal);
    for await (const delta of gen) {
      if (ac.signal.aborted || call.voiceFor !== id) break;
      raw += delta;
      pump(false);
      if (route === "agent" && spokenCount >= 1) break;
    }
    if (call.voiceFor === id && !ac.signal.aborted) pump(true);
  } catch {
    /* aborted, or the local model is down. No canned line, and no Composer without a judgment. */
  }
  if (call.voiceFor !== id) return;
  if (!routed) {
    route = "stay";
    call.voiceRoute = "stay";
    if (interrupt && typeof deps.cancelTurn === "function") {
      void Promise.resolve(deps.cancelTurn(call.sessionId, call.email)).catch(() => {});
    }
  }
  if (route === "agent") {
    if (spokenText) rememberVoice(call, "assistant", spokenText);
  } else {
    call.pendingSpeak.delete(id);
    if (spokenText) {
      call.turns.push({
        role: "assistant",
        text: spokenText,
        spoken: spokenText,
        at: new Date(now()).toISOString(),
        utteranceId: id,
      });
      rememberVoice(call, "assistant", spokenText);
    }
  }
  call.voicing = false;
  if (call.voiceAbort === ac) call.voiceAbort = null;
  notifyVoiceLine(call);
}

/**
 * gpt-oss on LM Studio. Same model the short lines already used.
 * @param {Array<{role: string, content: string}>} messages
 * @param {AbortSignal} [signal]
 */
async function* streamVoiceModel(messages, signal) {
  yield* streamChatCompletions({
    messages,
    maxTokens: VOICE_TALK_MAX_TOKENS,
    temperature: 0.4,
    signal,
  });
}

/**
 * @param {any} call
 * @param {string} id
 * @param {string} audioBase64
 * @param {(audioBase64: string) => Promise<string>} [transcribe]
 */
async function transcribeSwap(call, id, audioBase64, transcribe) {
  if (!audioBase64) return;
  if (typeof transcribe === "function") {
    try {
      const text = await transcribe(audioBase64);
      if (!text || !offerVoiceTranscript(id, text)) return;
      call.caption = text;
      const user = call.turns.find((row) => row.utteranceId === id);
      if (user) user.text = text;
    } catch {
      /* Apple's line stays */
    }
    return;
  }
  let pcm;
  try {
    pcm = Buffer.from(String(audioBase64), "base64");
  } catch {
    return;
  }
  if (pcm.length < 2 || pcm.length % 2 !== 0) return;
  const apple = call.turns.find((row) => row.utteranceId === id)?.text || "";
  const heard = hearForGrok({
    audio: pcm,
    appleText: apple,
    sendStarted: () => utteranceSlots.get(id)?.sent === true,
  });
  try {
    const result = await heard.settled;
    const parakeet = String(result?.parakeetText || "").trim();
    if (parakeet) call.caption = parakeet;
    if (result?.source === "parakeet" && result.text && offerVoiceTranscript(id, result.text)) {
      const user = call.turns.find((row) => row.utteranceId === id);
      if (user) user.text = result.text;
    }
  } catch {
    /* Apple's line stays */
  }
}

async function synthesizeClip(text) {
  const parts = [];
  let sampleRate = 24000;
  try {
    for await (const piece of speak(text)) {
      if (piece?.pcm?.length) parts.push(piece.pcm);
      if (piece?.sampleRate) sampleRate = piece.sampleRate;
    }
  } catch {
    return null;
  }
  if (!parts.length) return null;
  return { mime: "audio/pcm", sampleRate, bytes: Buffer.concat(parts) };
}

function ledgerSnapshot(call) {
  return {
    sessionId: call.sessionId,
    email: call.email,
    dormant: call.dormant,
    dormantAt: call.dormantAt,
    lastHeartbeatAt: call.lastHeartbeatAt,
    cooldownDeadline: call.cooldownDeadline,
    summaryHold: call.summaryHold,
    summarized: call.summarized,
    caption: call.caption,
    turns: call.turns,
    voiceMemory: call.voiceMemory || [],
  };
}

/** @type {ReturnType<typeof createVoiceBook>|null} */
let live = null;
let restoreStarted = null;
/** @type {ReturnType<typeof setInterval>|null} */
let pulseTimer = null;

function productionDeps() {
  return {
    now: () => Date.now(),
    async startAgent(email) {
      const { startAgent } = await import("./personal-agent.js");
      return startAgent(email, { skipFocus: true, voice: true });
    },
    async messageAgent(sessionId, email, text, utteranceId, interrupt) {
      const { messageAgent } = await import("./personal-agent.js");
      return messageAgent(
        sessionId,
        email,
        text,
        [],
        {
          client: "ios",
          view: "voice",
          title: "Voice",
          voiceUtteranceId: utteranceId,
        },
        interrupt
      );
    },
    async cancelTurn(sessionId, email) {
      const { cancelVoiceAgentTurn } = await import("./personal-agent.js");
      return cancelVoiceAgentTurn(sessionId, email);
    },
    session(sessionId) {
      return liveSession(sessionId);
    },
    async runningHas(email) {
      const { getRunningAgents } = await import("./personal-agent.js");
      const result = await getRunningAgents(email);
      return (result?.agents || []).map((row) => row.sessionId);
    },
    async sendSummary(call, prompt) {
      const { sendVoiceSummaryTurn } = await import("./personal-agent.js");
      const result = await sendVoiceSummaryTurn(call.sessionId, call.email, prompt);
      return result?.text || "";
    },
    async commitSummary(call, bubbles) {
      const { commitVoiceSummary } = await import("./personal-agent.js");
      await commitVoiceSummary(call.sessionId, call.email, bubbles);
      await deleteLedger(call.email, call.sessionId);
    },
    async saveLedger(email, snapshot) {
      await writeLedger(email, snapshot);
    },
    synthesize: synthesizeClip,
    streamSpoken: streamSpokenAnswer,
    streamVoice(messages, signal) {
      return streamVoiceModel(messages, signal);
    },
  };
}

/** @type {Map<string, any>|null} */
let sessionPeek = null;

function liveSession(sessionId) {
  if (!sessionPeek) return null;
  return sessionPeek.get(sessionId) || null;
}

export function registerVoiceSessions(map) {
  sessionPeek = map;
}

function liveBook() {
  if (!live) {
    live = createVoiceBook(productionDeps());
    if (!pulseTimer) {
      pulseTimer = setInterval(() => live?.pulse(), 2000);
      pulseTimer.unref?.();
    }
    restoreStarted = restoreLedgers(live);
  }
  return live;
}

async function restoreLedgers(book) {
  for (const email of [YAN_EMAIL, PRASHAM_EMAIL]) {
    const dir = chatHistoryAbsDir(email);
    if (!dir) continue;
    let names = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".voice.json")) continue;
      try {
        const raw = JSON.parse(await readFile(join(dir, name), "utf8"));
        book.restore(raw);
      } catch {
        /* skip a bad sidecar */
      }
    }
  }
}

function ledgerPath(email, sessionId) {
  const dir = chatHistoryAbsDir(email);
  if (!dir || !sessionId) return "";
  return join(dir, `${sessionId}.voice.json`);
}

async function writeLedger(email, snapshot) {
  const path = ledgerPath(email, snapshot.sessionId);
  if (!path) return;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(snapshot), "utf8");
}

async function deleteLedger(email, sessionId) {
  const path = ledgerPath(email, sessionId);
  if (!path) return;
  await rm(path, { force: true }).catch(() => {});
}

async function ready() {
  const book = liveBook();
  if (restoreStarted) await restoreStarted;
  return book;
}

export async function startVoiceSession(email, opts = {}) {
  const book = await ready();
  return book.start({ email, device: opts?.device });
}

export async function voiceUtterance(email, opts = {}) {
  const book = await ready();
  return book.utterance({
    email,
    sessionId: opts?.sessionId,
    text: opts?.text,
    clientUtteranceId: opts?.clientUtteranceId,
    interrupt: opts?.interrupt,
    device: opts?.device,
    audioBase64: opts?.audioBase64,
  });
}

export async function voiceState(email, opts = {}) {
  const book = await ready();
  return book.state({
    email,
    sessionId: opts?.sessionId,
    after: opts?.after,
  });
}

export async function voiceAudio(email, opts = {}) {
  const book = await ready();
  return book.audio({
    email,
    sessionId: opts?.sessionId,
    chunkId: opts?.chunkId,
  });
}

export async function voiceDormant(email, opts = {}) {
  const book = await ready();
  return book.dormant({
    email,
    sessionId: opts?.sessionId,
    device: opts?.device,
  });
}

export async function voiceResume(email, opts = {}) {
  const book = await ready();
  return book.resume({
    email,
    sessionId: opts?.sessionId,
    device: opts?.device,
  });
}

export async function voiceHeartbeat(email, opts = {}) {
  const book = await ready();
  return book.heartbeat({
    email,
    sessionId: opts?.sessionId,
    device: opts?.device,
  });
}

/**
 * @param {{ sessionId: string, utteranceId: string, content: string }} info
 */
export function onVoiceGrokFinished(info) {
  const book = liveBook();
  void book.grokFinished({
    sessionId: info.sessionId,
    utteranceId: info.utteranceId,
    content: info.content,
    dropped: false,
  });
}

/**
 * @param {string} sessionId
 * @param {string} utteranceId
 */
export function onVoiceUtteranceDropped(sessionId, utteranceId) {
  const book = liveBook();
  void book.grokFinished({
    sessionId,
    utteranceId,
    content: "",
    dropped: true,
  });
}
