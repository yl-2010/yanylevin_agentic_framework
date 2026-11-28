#!/usr/bin/env python3
"""Download Parakeet and Kokoro once, on the Mac Studio only.

Weights go to ~/Library/Application Support/yanylevin/voice-models/.
On his account that is
/Users/yanlevin/Library/Application Support/yanylevin/voice-models/.
They are not committed and they are not copied to the public mirror.

NVIDIA Parakeet TDT 0.6B v3, nvidia/parakeet-tdt-0.6b-v3, CC-BY-4.0.
https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3
Kokoro-82M, hexgrad/Kokoro-82M, Apache-2.0, voice af_heart only.
https://huggingface.co/hexgrad/Kokoro-82M

Any other machine, including this repo's cloud agents, exits without
touching the network.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
from pathlib import Path

PARAKEET_REPO = "nvidia/parakeet-tdt-0.6b-v3"
KOKORO_REPO = "hexgrad/Kokoro-82M"
PARAKEET_PAGE = "https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3"
VOICE = "af_heart"


def read_computer_name() -> str:
    if sys.platform != "darwin":
        return ""
    try:
        return subprocess.check_output(
            ["scutil", "--get", "ComputerName"],
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=2,
        ).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def is_mac_studio(platform=None, hostname=None, computer_name=None) -> bool:
    platform = sys.platform if platform is None else platform
    if platform != "darwin":
        return False
    if hostname is None:
        hostname = socket.gethostname()
    if computer_name is None:
        computer_name = read_computer_name()
    blob = f"{hostname}\n{computer_name}".lower()
    return "mac-studio" in blob or "mac studio" in blob


def weights_dir() -> Path:
    override = os.environ.get("VOICE_MODELS_DIR", "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / "Library" / "Application Support" / "yanylevin" / "voice-models"


def weights_ready(root: Path) -> bool:
    nemo = root / "parakeet" / "parakeet-tdt-0.6b-v3.nemo"
    checkpoint = root / "kokoro" / "kokoro-v1_0.pth"
    voice = root / "kokoro" / "voices" / f"{VOICE}.pt"
    config = root / "kokoro" / "config.json"
    try:
        return (
            nemo.is_file()
            and nemo.stat().st_size > 1_000_000_000
            and checkpoint.is_file()
            and checkpoint.stat().st_size > 100_000_000
            and voice.is_file()
            and voice.stat().st_size > 100_000
            and config.is_file()
        )
    except OSError:
        return False


def download(root: Path) -> None:
    if not is_mac_studio():
        raise SystemExit("refusing to download voice weights off the Mac Studio")
    from huggingface_hub import snapshot_download

    root.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=PARAKEET_REPO,
        local_dir=str(root / "parakeet"),
        allow_patterns=["parakeet-tdt-0.6b-v3.nemo", "README.md"],
    )
    snapshot_download(
        repo_id=KOKORO_REPO,
        local_dir=str(root / "kokoro"),
        allow_patterns=[
            "config.json",
            "kokoro-v1_0.pth",
            f"voices/{VOICE}.pt",
            "README.md",
        ],
    )
    manifest = {
        "parakeet": PARAKEET_REPO,
        "parakeetLicense": "CC-BY-4.0",
        "parakeetPage": PARAKEET_PAGE,
        "kokoro": KOKORO_REPO,
        "kokoroLicense": "Apache-2.0",
        "voice": VOICE,
    }
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Download local voice weights on the Mac Studio")
    parser.add_argument(
        "--check",
        action="store_true",
        help="Print whether a download would run. Never downloads.",
    )
    args = parser.parse_args(argv)
    if not is_mac_studio():
        print("download=no")
        print("reason=not-mac-studio")
        return 0
    root = weights_dir()
    if weights_ready(root):
        print("download=no")
        print("reason=already-present")
        print(f"path={root}")
        return 0
    if args.check:
        print("download=yes")
        print(f"path={root}")
        return 0
    download(root)
    print("download=done")
    print(f"path={root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
