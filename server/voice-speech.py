#!/usr/bin/env python3
"""Local speech process for the Personal Agent voice call.

Binds to 127.0.0.1 only. Parakeet and Kokoro load once and stay loaded.
Nothing in this process calls a hosted speech API.

The words Grok hears come from NVIDIA Parakeet TDT 0.6B v3,
nvidia/parakeet-tdt-0.6b-v3, CC-BY-4.0.
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
Attribution is required if those weights are shared. This app does not ship them.

The voice he hears is Kokoro-82M, hexgrad/Kokoro-82M, Apache-2.0, preset af_heart.
https://huggingface.co/hexgrad/Kokoro-82M

Weights live in ~/Library/Application Support/yanylevin/voice-models/.
On his account that is
/Users/yanlevin/Library/Application Support/yanylevin/voice-models/.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import sys
import threading
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

DEFAULT_PORT = 3016
BIND_HOST = "127.0.0.1"
SAMPLE_RATE = 16000
SPEAK_RATE = 24000
VOICE = "af_heart"
PARAKEET_REPO = "nvidia/parakeet-tdt-0.6b-v3"
KOKORO_REPO = "hexgrad/Kokoro-82M"
PARAKEET_PAGE = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"
MAX_PCM_BYTES = 2_500_000
MAX_SPEAK_CHARS = 4000
MAX_JSON_BYTES = 64_000


class SpeechError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SpeakGate:
    def __init__(self) -> None:
        self._gen = 0
        self._lock = threading.Lock()

    def begin(self) -> int:
        with self._lock:
            self._gen += 1
            return self._gen

    def cancel(self) -> None:
        self.begin()

    def cancelled(self, gen: int) -> bool:
        with self._lock:
            return gen != self._gen


def weights_dir() -> Path:
    override = os.environ.get("VOICE_MODELS_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Application Support" / "yanylevin" / "voice-models"


def force_offline() -> None:
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_DATASETS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"


def hypothesis_text(output) -> str:
    if output is None:
        return ""
    if isinstance(output, str):
        return output.strip()
    if isinstance(output, (list, tuple)):
        if not output:
            return ""
        head = output[0]
        if len(output) == 1 and isinstance(head, (list, tuple)):
            return hypothesis_text(head)
        return hypothesis_text(head)
    text = getattr(output, "text", None)
    if isinstance(text, str):
        return text.strip()
    return ""


def wav_to_pcm(data: bytes) -> bytes:
    try:
        with wave.open(BytesIO(data), "rb") as handle:
            channels = handle.getnchannels()
            width = handle.getsampwidth()
            rate = handle.getframerate()
            frames = handle.readframes(handle.getnframes())
    except wave.Error as exc:
        raise SpeechError("bad-wav") from exc
    if channels != 1 or width != 2 or rate != SAMPLE_RATE:
        raise SpeechError("bad-wav")
    return frames


def resolve_host(raw: str | None) -> str:
    host = (raw or os.environ.get("VOICE_SPEECH_HOST") or BIND_HOST).strip()
    if host != BIND_HOST:
        print(
            f"voice-speech binds to {BIND_HOST} only, not {host}",
            file=sys.stderr,
        )
        raise SystemExit(2)
    return host


class FakeEngine:
    """In-process stand-in for tests. The LaunchAgent never passes --fake."""

    fake = True

    def __init__(self) -> None:
        self.gate = SpeakGate()
        self.loading = False
        self.error = ""
        self.parakeet_ready = True
        self.kokoro_ready = True

    def transcribe(self, pcm: bytes) -> str:
        if not pcm:
            return ""
        return "from-parakeet"

    def speak_pcm(self, text: str, gen: int):
        if self.gate.cancelled(gen):
            return
        yield b"\x00\x00" * 480


class LocalEngine:
    fake = False

    def __init__(self, root: Path):
        self.root = root
        self.gate = SpeakGate()
        self.loading = True
        self.error = ""
        self.parakeet = None
        self.pipeline = None
        self._parakeet_lock = threading.Lock()
        self._kokoro_lock = threading.Lock()
        self.parakeet_ready = False
        self.kokoro_ready = False

    def load(self) -> None:
        force_offline()
        problems = []
        try:
            self._load_parakeet()
            self.parakeet_ready = True
        except Exception as exc:
            problems.append(f"parakeet: {exc}")
            print(f"parakeet load failed: {exc}", file=sys.stderr)
            traceback.print_exc()
        try:
            self._load_kokoro()
            self.kokoro_ready = True
        except Exception as exc:
            problems.append(f"kokoro: {exc}")
            print(f"kokoro load failed: {exc}", file=sys.stderr)
            traceback.print_exc()
        self.error = "; ".join(problems)
        self.loading = False
        print(
            "voice-speech models "
            f"parakeet={'yes' if self.parakeet_ready else 'no'} "
            f"kokoro={'yes' if self.kokoro_ready else 'no'}",
            flush=True,
        )

    def _load_parakeet(self) -> None:
        nemo_path = self.root / "parakeet" / "parakeet-tdt-0.6b-v3.nemo"
        if not nemo_path.is_file():
            raise FileNotFoundError(nemo_path)
        import nemo.collections.asr as nemo_asr

        try:
            model = nemo_asr.models.ASRModel.restore_from(
                restore_path=str(nemo_path),
                map_location="cpu",
            )
        except TypeError:
            model = nemo_asr.models.ASRModel.restore_from(str(nemo_path))
        model.freeze()
        model.eval()
        import numpy as np

        silence = np.zeros(SAMPLE_RATE // 5, dtype=np.float32)
        try:
            model.transcribe([silence], batch_size=1, verbose=False)
        except TypeError:
            model.transcribe([silence], batch_size=1)
        self.parakeet = model

    def _load_kokoro(self) -> None:
        root = self.root / "kokoro"
        config = root / "config.json"
        model_path = root / "kokoro-v1_0.pth"
        voice_path = root / "voices" / "af_heart.pt"
        for path in (config, model_path, voice_path):
            if not path.is_file():
                raise FileNotFoundError(path)
        import torch
        from kokoro import KModel, KPipeline

        device = "cpu"
        if os.environ.get("VOICE_SPEECH_DEVICE"):
            device = os.environ["VOICE_SPEECH_DEVICE"]
        elif torch.backends.mps.is_available():
            device = "mps"
        try:
            model = KModel(config=str(config), model=str(model_path)).to(device).eval()
        except Exception:
            if device == "cpu":
                raise
            print("kokoro mps load failed, using cpu", file=sys.stderr)
            device = "cpu"
            model = KModel(config=str(config), model=str(model_path)).to(device).eval()
        pipeline = KPipeline(lang_code="a", model=model, repo_id=KOKORO_REPO)
        pipeline.voices[VOICE] = torch.load(str(voice_path), weights_only=True)
        with torch.inference_mode():
            next(iter(pipeline("Okay.", voice=VOICE, speed=1.0)), None)
        self.pipeline = pipeline

    def transcribe(self, pcm: bytes) -> str:
        if not self.parakeet_ready or self.parakeet is None:
            raise SpeechError("parakeet-not-loaded")
        import numpy as np

        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        with self._parakeet_lock:
            try:
                outputs = self.parakeet.transcribe([audio], batch_size=1, verbose=False)
            except TypeError:
                outputs = self.parakeet.transcribe([audio], batch_size=1)
        return hypothesis_text(outputs)

    def speak_pcm(self, text: str, gen: int):
        if not self.kokoro_ready or self.pipeline is None:
            raise SpeechError("kokoro-not-loaded")
        import numpy as np
        import torch

        self._kokoro_lock.acquire()
        try:
            with torch.inference_mode():
                produced = self.pipeline(text, voice=VOICE, speed=1.0)
                for _gs, _ps, audio in produced:
                    if self.gate.cancelled(gen):
                        produced.close()
                        return
                    if hasattr(audio, "detach"):
                        audio = audio.detach().float().cpu().numpy()
                    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
                    clipped = np.clip(samples, -1.0, 1.0)
                    pcm = (clipped * 32767.0).astype("<i2").tobytes()
                    if pcm:
                        yield pcm
        finally:
            self._kokoro_lock.release()


def make_handler(engine, bound: dict):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args) -> None:
            sys.stderr.write("voice-speech " + (fmt % args) + "\n")

        def _local_client(self) -> bool:
            host = self.client_address[0]
            return host == BIND_HOST or host == "::1"

        def _read_body(self, limit: int) -> bytes | None:
            raw = self.headers.get("Content-Length")
            if raw is None:
                self._send_json(411, {"error": "length-required"})
                return None
            try:
                length = int(raw)
            except ValueError:
                self._send_json(400, {"error": "bad-length"})
                return None
            if length < 0 or length > limit:
                self._send_json(413, {"error": "too-large"})
                return None
            data = self.rfile.read(length)
            if len(data) != length:
                self._send_json(400, {"error": "short-body"})
                return None
            return data

        def _send_json(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _send_empty(self, status: int) -> None:
            self.send_response(status)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _reject_remote(self) -> bool:
            if self._local_client():
                return False
            self._send_json(403, {"error": "localhost-only"})
            return True

        def do_GET(self) -> None:
            if self._reject_remote():
                return
            path = self.path.split("?", 1)[0]
            if path != "/health":
                self._send_json(404, {"error": "not-found"})
                return
            self._send_json(
                200,
                {
                    "ok": True,
                    "host": BIND_HOST,
                    "port": bound["port"],
                    "loading": bool(engine.loading),
                    "parakeet": bool(engine.parakeet_ready),
                    "kokoro": bool(engine.kokoro_ready),
                    "parakeetModel": PARAKEET_REPO,
                    "kokoroModel": KOKORO_REPO,
                    "parakeetPage": PARAKEET_PAGE,
                    "voice": VOICE,
                    "fake": bool(engine.fake),
                    "reason": engine.error,
                },
            )

        def do_POST(self) -> None:
            if self._reject_remote():
                return
            path = self.path.split("?", 1)[0]
            if path == "/speak/cancel":
                engine.gate.cancel()
                self._send_empty(204)
                return
            if path == "/transcribe":
                self._transcribe()
                return
            if path == "/speak":
                self._speak()
                return
            self._send_json(404, {"error": "not-found"})

        def _pcm_from_request(self, data: bytes) -> bytes | None:
            kind = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if kind in ("audio/wav", "audio/wave", "audio/x-wav"):
                try:
                    return wav_to_pcm(data)
                except SpeechError:
                    self._send_json(400, {"error": "bad-wav"})
                    return None
            rate = self.headers.get("X-Sample-Rate")
            if rate is not None and rate.strip() != str(SAMPLE_RATE):
                self._send_json(400, {"error": "bad-sample-rate"})
                return None
            if len(data) % 2 != 0:
                self._send_json(400, {"error": "odd-pcm"})
                return None
            return data

        def _transcribe(self) -> None:
            data = self._read_body(MAX_PCM_BYTES)
            if data is None:
                return
            pcm = self._pcm_from_request(data)
            if pcm is None:
                return
            if not pcm:
                self._send_json(400, {"error": "empty-audio"})
                return
            try:
                text = engine.transcribe(pcm)
            except SpeechError as exc:
                self._send_json(503, {"error": exc.code})
                return
            except Exception:
                traceback.print_exc()
                self._send_json(500, {"error": "speech-failed"})
                return
            self._send_json(200, {"text": text})

        def _speak(self) -> None:
            data = self._read_body(MAX_JSON_BYTES)
            if data is None:
                return
            try:
                payload = json.loads(data.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                self._send_json(400, {"error": "bad-json"})
                return
            text = payload.get("text") if isinstance(payload, dict) else None
            if not isinstance(text, str) or not text.strip():
                self._send_json(400, {"error": "empty-text"})
                return
            if len(text) > MAX_SPEAK_CHARS:
                self._send_json(400, {"error": "text-too-long"})
                return
            gen = engine.gate.begin()
            produced = engine.speak_pcm(text.strip(), gen)
            try:
                first = next(produced, None)
            except SpeechError as exc:
                produced.close()
                self._send_json(503, {"error": exc.code})
                return
            except Exception:
                produced.close()
                traceback.print_exc()
                self._send_json(500, {"error": "speech-failed"})
                return
            self._start_chunked()
            count = 0
            try:
                if first and not engine.gate.cancelled(gen):
                    self._write_audio(first)
                    count = 1
                for pcm in produced:
                    if engine.gate.cancelled(gen):
                        break
                    if pcm:
                        self._write_audio(pcm)
                        count += 1
                self._write_event({"event": "done", "chunks": count, "voice": VOICE})
            except Exception:
                traceback.print_exc()
                self._write_event({"event": "error", "error": "speech-failed"})
            finally:
                produced.close()
                self._end_chunked()

        def _start_chunked(self) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Voice", VOICE)
            self.end_headers()

        def _write_event(self, payload: dict) -> None:
            raw = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
            self.wfile.write(f"{len(raw):X}\r\n".encode("ascii"))
            self.wfile.write(raw)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

        def _write_audio(self, pcm: bytes) -> None:
            self._write_event(
                {
                    "event": "chunk",
                    "id": secrets.token_hex(8),
                    "sampleRate": SPEAK_RATE,
                    "channels": 1,
                    "encoding": "pcm_s16le",
                    "voice": VOICE,
                    "audio": base64.b64encode(pcm).decode("ascii"),
                }
            )

        def _end_chunked(self) -> None:
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

    return Handler


def serve(host: str, port: int, engine) -> None:
    bound = {"port": port}
    httpd = ThreadingHTTPServer((host, port), make_handler(engine, bound))
    httpd.daemon_threads = True
    bound["port"] = httpd.server_address[1]
    print(f"voice-speech listening on {host}:{bound['port']}", flush=True)

    def stop(_signum, _frame) -> None:
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    import signal

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Local Parakeet and Kokoro on 127.0.0.1")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument(
        "--fake",
        action="store_true",
        help="Skip the real models. Tests only. Do not use this in the LaunchAgent.",
    )
    args = parser.parse_args(argv)
    host = resolve_host(args.host)
    force_offline()
    if args.fake:
        engine = FakeEngine()
    else:
        engine = LocalEngine(weights_dir())
        threading.Thread(target=engine.load, name="voice-load", daemon=True).start()
    serve(host, args.port, engine)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
