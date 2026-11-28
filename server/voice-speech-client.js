/**
 * Client for server/voice-speech.py on 127.0.0.1.
 * Parakeet is the line Grok hears when that text is back before the send.
 * Apple's caption is the line when Parakeet is late, down, or empty.
 * This file does not speak the first sound and does not call LM Studio.
 * Do not point it at a public host. There is no hosted speech API.
 */

export const SPEECH_HOST = "127.0.0.1";
export const SPEECH_PORT = 3016;
const TRANSCRIBE_MS = 20_000;

export function assertLocalSpeechUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw speechError("speech-url", "voice speech URL is not a URL");
  }
  if (url.protocol !== "http:" || url.hostname !== SPEECH_HOST) {
    throw speechError("speech-url", "voice speech stays on http://127.0.0.1");
  }
  if (url.username || url.password) {
    throw speechError("speech-url", "voice speech URL does not take credentials");
  }
  return url.origin;
}

export function speechUrl() {
  const raw =
    process.env.VOICE_SPEECH_URL ||
    `http://${SPEECH_HOST}:${process.env.VOICE_SPEECH_PORT || SPEECH_PORT}`;
  return assertLocalSpeechUrl(raw);
}

function speechError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function asTranscribeError(error) {
  if (error?.code === "speech-url") return error;
  if (error?.name === "TimeoutError" || error?.code === "parakeet-timeout") {
    return speechError("parakeet-timeout");
  }
  if (error?.code && error.code !== "ABORT_ERR") return error;
  return speechError("parakeet-down");
}

/**
 * PCM s16le, 16 kHz, mono. Returns Parakeet's text.
 * Throws when the process is down or the clip is still running at 20s.
 * That 20s cap only stops a hung socket. It is not a delay in front of the send.
 */
export async function transcribe(audio, { signal } = {}) {
  if (!audio || typeof audio.byteLength !== "number" || audio.byteLength < 2) {
    throw speechError("empty-audio");
  }
  if (audio.byteLength % 2 !== 0) {
    throw speechError("odd-pcm");
  }
  const body = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
  const res = await fetch(`${speechUrl()}/transcribe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Sample-Rate": "16000",
      "Content-Length": String(body.length),
    },
    body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TRANSCRIBE_MS)]) : AbortSignal.timeout(TRANSCRIBE_MS),
  }).catch((error) => {
    throw asTranscribeError(error);
  });
  const raw = await res.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }
  if (!res.ok) {
    throw speechError(data.error || "parakeet-down");
  }
  if (typeof data.text !== "string") {
    throw speechError("parakeet-down");
  }
  return data.text;
}

/**
 * Start Parakeet on the clip. Do not await `settled` before the first sound
 * or before starting the Grok send. `sendStarted` is read when Parakeet
 * answers. If it is already true, Apple's text is the one Grok hears.
 * `parakeetText` is still set when Parakeet did answer, so the caption can move.
 */
export function hearForGrok({ audio, appleText, sendStarted, signal } = {}) {
  const apple = typeof appleText === "string" ? appleText : "";
  const started = typeof sendStarted === "function" ? sendStarted : () => false;
  const settled = (async () => {
    try {
      const text = (await transcribe(audio, { signal })).trim();
      if (started()) {
        return {
          text: apple,
          source: "apple",
          reason: "send-already-out",
          parakeetText: text,
        };
      }
      if (text) {
        return { text, source: "parakeet", reason: "", parakeetText: text };
      }
      return { text: apple, source: "apple", reason: "empty", parakeetText: "" };
    } catch (error) {
      const wrapped = asTranscribeError(error);
      return {
        text: apple,
        source: "apple",
        reason: wrapped.code || "parakeet-down",
        parakeetText: "",
      };
    }
  })();
  return { settled, appleText: apple };
}

/**
 * Stream Kokoro af_heart at 24 kHz. Yields nothing when the process has no
 * audio. Throws `kokoro-not-loaded` when the model is down, which is the
 * cue to leave the system voice running.
 */
export async function* speak(text, { signal } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw speechError("empty-text");
  }
  const res = await fetch(`${speechUrl()}/speak`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });
  if (res.status === 503) {
    let code = "kokoro-not-loaded";
    try {
      const data = await res.json();
      if (data?.error) code = data.error;
    } catch {
      /* the status is enough */
    }
    throw speechError(code);
  }
  if (!res.ok || !res.body) {
    throw speechError("kokoro-failed");
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.event === "error") {
        throw speechError(event.error || "kokoro-failed");
      }
      if (event.event === "chunk" && event.audio) {
        yield {
          id: event.id,
          sampleRate: event.sampleRate,
          channels: event.channels,
          encoding: event.encoding,
          voice: event.voice,
          pcm: Buffer.from(event.audio, "base64"),
        };
      }
    }
  }
}

export async function cancelSpeak({ signal } = {}) {
  const res = await fetch(`${speechUrl()}/speak/cancel`, {
    method: "POST",
    headers: { "Content-Length": "0" },
    signal,
  });
  if (res.status !== 204 && !res.ok) {
    throw speechError("cancel-failed");
  }
}

export async function speechHealth({ signal } = {}) {
  const res = await fetch(`${speechUrl()}/health`, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(1500)])
      : AbortSignal.timeout(1500),
  }).catch((error) => {
    throw asTranscribeError(error);
  });
  if (!res.ok) throw speechError("parakeet-down");
  return res.json();
}
