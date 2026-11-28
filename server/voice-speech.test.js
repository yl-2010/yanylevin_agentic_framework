import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SPEECH_PORT,
  assertLocalSpeechUrl,
  speechUrl,
  hearForGrok,
  speak,
  cancelSpeak,
  speechHealth,
} from "./voice-speech-client.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PY = join(REPO, "server", "voice-speech.py");
const DOWNLOAD = join(REPO, "server", "download-voice-models.py");
const savedUrl = process.env.VOICE_SPEECH_URL;
const savedPort = process.env.VOICE_SPEECH_PORT;

afterEach(() => {
  if (savedUrl === undefined) delete process.env.VOICE_SPEECH_URL;
  else process.env.VOICE_SPEECH_URL = savedUrl;
  if (savedPort === undefined) delete process.env.VOICE_SPEECH_PORT;
  else process.env.VOICE_SPEECH_PORT = savedPort;
});

function pcm(bytes = 3200) {
  return Buffer.alloc(bytes);
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("voice speech URL", () => {
  it("stays on 127.0.0.1 and the default port", () => {
    delete process.env.VOICE_SPEECH_URL;
    delete process.env.VOICE_SPEECH_PORT;
    assert.equal(SPEECH_PORT, 3016);
    assert.equal(speechUrl(), "http://127.0.0.1:3016");
    assert.equal(assertLocalSpeechUrl("http://127.0.0.1:3016/health"), "http://127.0.0.1:3016");
  });

  it("rejects a public host, https, and 0.0.0.0", () => {
    assert.throws(() => assertLocalSpeechUrl("https://api.yanylevin.com/voice"), /127\.0\.0\.1/);
    assert.throws(() => assertLocalSpeechUrl("http://0.0.0.0:3016"), /127\.0\.0\.1/);
    assert.throws(() => assertLocalSpeechUrl("http://localhost:3016"), /127\.0\.0\.1/);
    process.env.VOICE_SPEECH_URL = "http://example.com:3016";
    assert.throws(() => speechUrl(), /127\.0\.0\.1/);
  });
});

describe("hearForGrok", () => {
  it("uses Parakeet when the send has not started", async () => {
    const { server, url } = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "  moved practice  " }));
    });
    process.env.VOICE_SPEECH_URL = url;
    try {
      const heard = hearForGrok({
        audio: pcm(),
        appleText: "move practice",
        sendStarted: () => false,
      });
      const decision = await heard.settled;
      assert.equal(decision.source, "parakeet");
      assert.equal(decision.text, "moved practice");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps Apple's text when the send is already out", async () => {
    const { server, url } = await listen((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ text: "parakeet line" }));
      }, 40);
    });
    process.env.VOICE_SPEECH_URL = url;
    try {
      let sent = false;
      const heard = hearForGrok({
        audio: pcm(),
        appleText: "apple line",
        sendStarted: () => sent,
      });
      sent = true;
      const decision = await heard.settled;
      assert.equal(decision.source, "apple");
      assert.equal(decision.text, "apple line");
      assert.equal(decision.reason, "send-already-out");
      assert.equal(decision.parakeetText, "parakeet line");
    } finally {
      await closeServer(server);
    }
  });

  it("keeps Apple's text when Parakeet is empty or down", async () => {
    const empty = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ text: "   " }));
    });
    process.env.VOICE_SPEECH_URL = empty.url;
    const blank = await hearForGrok({
      audio: pcm(),
      appleText: "apple line",
      sendStarted: () => false,
    }).settled;
    assert.equal(blank.source, "apple");
    assert.equal(blank.reason, "empty");
    await closeServer(empty.server);

    const down = await listen((req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "parakeet-not-loaded" }));
    });
    process.env.VOICE_SPEECH_URL = down.url;
    const missed = await hearForGrok({
      audio: pcm(),
      appleText: "apple line",
      sendStarted: () => false,
    }).settled;
    assert.equal(missed.text, "apple line");
    assert.equal(missed.source, "apple");
    assert.equal(missed.reason, "parakeet-not-loaded");
    await closeServer(down.server);

    const closed = await listen((_req, res) => {
      res.end();
    });
    const closedPort = new URL(closed.url).port;
    await closeServer(closed.server);
    process.env.VOICE_SPEECH_URL = `http://127.0.0.1:${closedPort}`;
    const refused = await hearForGrok({
      audio: pcm(),
      appleText: "apple line",
      sendStarted: () => false,
    }).settled;
    assert.equal(refused.source, "apple");
    assert.equal(refused.reason, "parakeet-down");
  });

  it("does not call out when the URL is public", async () => {
    process.env.VOICE_SPEECH_URL = "https://speech.example/v1";
    const decision = await hearForGrok({
      audio: pcm(),
      appleText: "apple line",
      sendStarted: () => false,
    }).settled;
    assert.equal(decision.source, "apple");
    assert.equal(decision.reason, "speech-url");
  });
});

describe("speak client", () => {
  it("throws when Kokoro is not loaded and streams a chunk when it is", async () => {
    const down = await listen((req, res) => {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "kokoro-not-loaded" }));
    });
    process.env.VOICE_SPEECH_URL = down.url;
    await assert.rejects(async () => {
      for await (const _chunk of speak("Checking.")) {
        /* unused */
      }
    }, (err) => err.code === "kokoro-not-loaded");
    await closeServer(down.server);

    const up = await listen((req, res) => {
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const line = JSON.stringify({
        event: "chunk",
        id: "abc",
        sampleRate: 24000,
        channels: 1,
        encoding: "pcm_s16le",
        voice: "af_heart",
        audio: Buffer.from([0, 1, 0, 1]).toString("base64"),
      });
      res.write(`${line}\n`);
      res.end(`${JSON.stringify({ event: "done", chunks: 1 })}\n`);
    });
    process.env.VOICE_SPEECH_URL = up.url;
    const chunks = [];
    for await (const chunk of speak("Checking.")) chunks.push(chunk);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].sampleRate, 24000);
    assert.equal(chunks[0].voice, "af_heart");
    assert.equal(chunks[0].encoding, "pcm_s16le");
    assert.deepEqual([...chunks[0].pcm], [0, 1, 0, 1]);
    await closeServer(up.server);
  });
});

describe("voice-speech.py", () => {
  it("refuses to bind anything except 127.0.0.1", () => {
    const result = spawnSync(
      "python3",
      [PY, "--fake", "--host", "0.0.0.0", "--port", "0"],
      { encoding: "utf8" }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /127\.0\.0\.1/);
  });

  it("serves Parakeet text and a Kokoro chunk on localhost", async () => {
    const child = spawn("python3", [PY, "--fake", "--host", "127.0.0.1", "--port", "0"], {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready\n${stderr}\n${buf}`)), 5000);
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const match = buf.match(/voice-speech listening on 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}\n${stderr}\n${buf}`));
      });
    });
    const url = `http://127.0.0.1:${port}`;
    try {
      process.env.VOICE_SPEECH_URL = url;
      const health = await speechHealth();
      assert.equal(health.host, "127.0.0.1");
      assert.equal(health.port, port);
      assert.equal(health.parakeet, true);
      assert.equal(health.kokoro, true);
      assert.equal(health.voice, "af_heart");
      assert.equal(health.fake, true);
      assert.equal(health.parakeetModel, "nvidia/parakeet-tdt-0.6b-v3");

      const odd = await fetch(`${url}/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: Buffer.from([0, 1, 2]),
      });
      assert.equal(odd.status, 400);

      const heard = await hearForGrok({
        audio: pcm(),
        appleText: "apple line",
        sendStarted: () => false,
      }).settled;
      assert.equal(heard.source, "parakeet");
      assert.equal(heard.text, "from-parakeet");

      const chunks = [];
      for await (const chunk of speak("Hi there")) chunks.push(chunk);
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].sampleRate, 24000);
      assert.equal(chunks[0].voice, "af_heart");
      assert.equal(chunks[0].pcm.length, 960);

      const otherVoice = await fetch(`${url}/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Hi", voice: "af_bella" }),
      });
      const body = await otherVoice.text();
      assert.match(body, /"voice":"af_heart"/);
      assert.doesNotMatch(body, /af_bella/);

      await cancelSpeak();
      const missing = await fetch(`${url}/v1/chat/completions`, { method: "POST" });
      assert.equal(missing.status, 404);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", () => resolve()));
    }
  });

  it("stays up with Apple as the fallback when the weights are absent", async () => {
    const empty = mkdtempSync(join(tmpdir(), "yl-voice-missing-"));
    const child = spawn("python3", [PY, "--host", "127.0.0.1", "--port", "0"], {
      cwd: REPO,
      env: { ...process.env, VOICE_MODELS_DIR: empty, HF_HUB_OFFLINE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ready\n${buf}`)), 5000);
      child.stdout.on("data", (chunk) => {
        buf += chunk.toString();
        const match = buf.match(/voice-speech listening on 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`exited ${code}\n${buf}`));
      });
    });
    try {
      process.env.VOICE_SPEECH_URL = `http://127.0.0.1:${port}`;
      let health;
      for (let i = 0; i < 20; i += 1) {
        health = await speechHealth();
        if (!health.loading) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal(health.loading, false);
      assert.equal(health.parakeet, false);
      assert.equal(health.kokoro, false);
      const decision = await hearForGrok({
        audio: pcm(),
        appleText: "apple line",
        sendStarted: () => false,
      }).settled;
      assert.equal(decision.source, "apple");
      assert.equal(decision.text, "apple line");
      assert.equal(decision.reason, "parakeet-not-loaded");
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", () => resolve()));
    }
  });

  it("checks hypothesis text and wav decoding without loading models", () => {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util
import io, os, wave
from pathlib import Path
spec = importlib.util.spec_from_file_location("speech", ${JSON.stringify(PY)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
class H:
    def __init__(self, text):
        self.text = text
assert mod.hypothesis_text([H(" Hello ")]) == "Hello"
assert mod.hypothesis_text(" hi ") == "hi"
assert mod.hypothesis_text(None) == ""
assert mod.hypothesis_text([]) == ""
assert mod.hypothesis_text(([H("A")],)) == "A"
buf = io.BytesIO()
with wave.open(buf, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(b"\\x00\\x01" * 10)
assert mod.wav_to_pcm(buf.getvalue()) == b"\\x00\\x01" * 10
bad = io.BytesIO()
with wave.open(bad, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(8000)
    w.writeframes(b"\\x00\\x00")
try:
    mod.wav_to_pcm(bad.getvalue())
    raise SystemExit("bad rate should fail")
except mod.SpeechError as exc:
    assert exc.code == "bad-wav"
pcm = b"\\x00\\x01" * 5000
parts = list(mod.iter_pcm_frames(pcm, mod.FRAME_SAMPLES))
assert b"".join(parts) == pcm
assert len(parts) > 1
assert len(parts[0]) == mod.FRAME_SAMPLES * 2
assert all(len(part) % 2 == 0 for part in parts)
assert list(mod.iter_pcm_frames(b"", 4)) == []
try:
    list(mod.iter_pcm_frames(b"\\x00", 4))
    raise SystemExit("odd pcm should fail")
except mod.SpeechError as exc:
    assert exc.code == "odd-pcm"
print("ok")
`,
      ],
      { encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /ok/);
  });
});

describe("download-voice-models.py", () => {
  it("does not download off the Mac Studio", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "yl-voice-")), "should-not-exist");
    const check = spawnSync("python3", [DOWNLOAD, "--check"], {
      encoding: "utf8",
      env: { ...process.env, VOICE_MODELS_DIR: dir },
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);
    assert.match(check.stdout, /download=no/);
    assert.match(check.stdout, /reason=not-mac-studio/);
    assert.equal(existsSync(dir), false);

    const probe = spawnSync(
      "python3",
      [
        "-c",
        `
import importlib.util, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("dl", ${JSON.stringify(DOWNLOAD)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
assert mod.is_mac_studio(platform="linux", hostname="x", computer_name="") is False
assert mod.is_mac_studio(platform="darwin", hostname="Yan-Mac-Studio.local", computer_name="") is True
assert mod.is_mac_studio(platform="darwin", hostname="MacBook-Pro", computer_name="MacBook Pro") is False
assert mod.is_mac_studio(platform="darwin", hostname="foo", computer_name="Mac Studio") is True
import tempfile
root = Path(tempfile.mkdtemp(prefix="yl-voice-ready-"))
assert mod.weights_ready(root) is False
(root / "parakeet").mkdir(parents=True)
(root / "kokoro" / "voices").mkdir(parents=True)
nemo = root / "parakeet" / "parakeet-tdt-0.6b-v3.nemo"
ckpt = root / "kokoro" / "kokoro-v1_0.pth"
voice = root / "kokoro" / "voices" / "af_heart.pt"
cfg = root / "kokoro" / "config.json"
for path, size in ((nemo, 1_000_000_001), (ckpt, 100_000_001), (voice, 100_001)):
    path.touch()
    os.truncate(path, size)
cfg.write_text("{}", encoding="utf-8")
assert mod.weights_ready(root) is True
voice.unlink()
assert mod.weights_ready(root) is False
suffix = mod.weights_dir()
os.environ.pop("VOICE_MODELS_DIR", None)
default = str(mod.weights_dir())
assert default.endswith("/Library/Application Support/yanylevin/voice-models")
print("ok")
`,
      ],
      { encoding: "utf8", env: { ...process.env, VOICE_MODELS_DIR: dir } }
    );
    assert.equal(probe.status, 0, probe.stderr || probe.stdout);
    assert.match(probe.stdout, /ok/);
    const py = readFileSync(PY, "utf8");
    assert.match(py, /nvidia\/parakeet-tdt-0\.6b-v3/);
    assert.match(py, /https:\/\/huggingface\.co\/nvidia\/parakeet-tdt-0\.6b-v3/);
    assert.match(py, /DEFAULT_PORT = 3016/);
    assert.match(py, /af_heart/);
  });
});
