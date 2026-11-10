#!/usr/bin/env python3
"""Minimal OpenAI-compatible TTS server over a local CosyVoice2 snapshot.

Endpoints:
  GET  /v1/models           → {"data":[{"id":"cosyvoice-2","object":"model"}]}
  POST /v1/audio/speech     → {"input","voice","speed","response_format"} → audio/wav

Emotion: an input of the form "<instruct><|endofprompt|><text>" is routed to
CosyVoice2.inference_instruct2 (the same format the nico plugin sends).

Run by dsh-nico's start action with the repo checkout and model snapshot paths.
CORS is open so the harness web GUI can probe /v1/models directly.
"""
import argparse
import io
import json
import os
import signal
import sys
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

STATE = {"cosyvoice": None, "sample_rate": 24000, "lock": threading.Lock(), "default_spk": "中文女"}


def load_model(src: str, model_dir: str) -> None:
    sys.path.insert(0, src)
    sys.path.insert(0, src + "/third_party/Matcha-TTS")
    from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

    print("loading CosyVoice2 from " + model_dir, flush=True)
    model = CosyVoice2(model_dir)
    STATE["cosyvoice"] = model
    STATE["sample_rate"] = int(model.sample_rate)
    print("model ready, sample_rate=" + str(STATE["sample_rate"]), flush=True)


def synthesize(text: str, instruct: str | None, voice: str | None, speed: float) -> bytes:
    model = STATE["cosyvoice"]
    spk = voice or STATE["default_spk"]
    with STATE["lock"]:
        if instruct:
            # zero_shot_spk_id hits spk2info.pt for built-in speakers; prompt_wav unused.
            chunks = model.inference_instruct2(text, instruct, None, zero_shot_spk_id=spk, speed=speed)
        else:
            chunks = model.inference_sft(text, spk, speed=speed)
        speech = torch.cat([c["tts_speech"] for c in chunks], dim=1)
    pcm = (speech.numpy().flatten().clip(-1.0, 1.0) * 32767.0).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(STATE["sample_rate"])
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip().endswith("/models"):
            self._send(200, json.dumps({"data": [{"id": "cosyvoice-2", "object": "model"}], "object": "list"}).encode())
        else:
            self._send(404, json.dumps({"error": "not found"}).encode())

    def do_POST(self) -> None:  # noqa: N802
        if not self.path.rstrip().endswith("/audio/speech"):
            self._send(404, json.dumps({"error": "not found"}).encode())
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(length) or b"{}")
        except Exception as exc:
            self._send(400, json.dumps({"error": "bad json: " + str(exc)}).encode())
            return
        raw = str(req.get("input") or "")
        if not raw:
            self._send(400, json.dumps({"error": "input is required"}).encode())
            return
        if "<|endofprompt|>" in raw:
            instruct, text = raw.split("<|endofprompt|>", 1)
            instruct = instruct.strip() or None
        else:
            instruct, text = None, raw
        try:
            wav = synthesize(text, instruct, req.get("voice"), float(req.get("speed") or 1.0))
        except KeyError as exc:
            self._send(400, json.dumps({"error": "unknown speaker/instruct target: " + str(exc)}).encode())
            return
        except Exception as exc:
            self._send(500, json.dumps({"error": str(exc)}).encode())
            return
        self._send(200, wav, "audio/wav")

    def log_message(self, fmt, *args) -> None:  # silence per-request stderr noise
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="CosyVoice repo checkout")
    ap.add_argument("--model-dir", required=True, help="CosyVoice2-0.5B snapshot dir")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", default="50000")
    ap.add_argument("--pid-file", default=None)
    args = ap.parse_args()
    pid_file = args.pid_file or os.path.join(os.path.expanduser("~"), ".dsh", "nico", "cosyvoice", "server.pid")
    # Own the pid file: written after boot args are parsed (model load is slow);
    # removed on SIGTERM so stop never kills a half-loaded boot.
    with open(pid_file, "w") as f:
        f.write(str(os.getpid()))
    def _bye(_sig, _frm):
        try:
            os.remove(pid_file)
        except OSError:
            pass
        sys.exit(0)
    signal.signal(signal.SIGTERM, _bye)
    load_model(args.src, args.model_dir)
    server = ThreadingHTTPServer((args.host, int(args.port)), Handler)
    print("listening on " + args.host + ":" + args.port, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
