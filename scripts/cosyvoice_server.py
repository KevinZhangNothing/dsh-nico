#!/usr/bin/env python3
"""Minimal OpenAI-compatible TTS server over a local CosyVoice2 snapshot.

Endpoints:
  GET  /v1/models           → {"data":[{"id":"cosyvoice-2","object":"model"}]}
  GET  /v1/voices           → {"data":[{"id":"default","name":"default",...}, ...]}
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
import re
import signal
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch

STATE = {"cosyvoice": None, "sample_rate": 24000, "lock": threading.Lock(), "default_spk": "中文女", "warm": False}

# Fallback reference wav for voice cloning when spk2info.pt is absent
# (the ModelScope CosyVoice2-0.5B snapshot does not ship it).
PROMPT_WAV = None  # set in load_model()
ASSET_DIR = None   # set in load_model()

# Named voice → reference wav filename. Users select one via the GUI
# dropdown; the value is sent as the OpenAI `voice` field.
VOICE_MAP: dict[str, str] = {
    "default": "zero_shot_prompt.wav",
    "cross_lingual": "cross_lingual_prompt.wav",
}

# Human-readable voice descriptions shown in the GUI dropdown.
VOICE_DESC: dict[str, str] = {
    "default": "中文女（官方参考，适合中文播报）",
    "cross_lingual": "跨语言参考（英文/多语言音色）",
}

# AISHELL-3 reference wavs auto-discovered from ~/.dsh/nico/cosyvoice/voices/
# (SSB*.wav). Downloaded by the user from the AISHELL-3 HF dataset (Apache-2.0).
# Populated in load_model(); each entry adds a voice to the GUI dropdown.
VOICE_EXTRA: dict[str, str] = {}

# AISHELL-3 speaker metadata (gender / age group / accent) read from
# ~/.dsh/nico/cosyvoice/voices/spk-info.json (written by the download helper).
# The dataset ships no speaker names — only these three attributes — so the
# GUI label is built from them instead of the bare SSBxxxx id.
VOICE_META: dict[str, dict] = {}

_AGE_CN = {"A": "儿童", "B": "青年", "C": "中年", "D": "老年"}
_GENDER_CN = {"female": "女", "male": "男"}
_ACCENT_CN = {"north": "北方", "south": "南方", "others": "其他"}


def load_voice_meta(voices_dir: str) -> None:
    p = os.path.join(voices_dir, "spk-info.json")
    if not os.path.isfile(p):
        return
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print("spk-info.json unreadable: " + repr(exc), flush=True)
        return
    for vid, m in data.items():
        if not isinstance(m, dict):
            continue
        VOICE_META[vid] = {
            "gender": _GENDER_CN.get(m.get("gender"), m.get("gender") or "音色"),
            "age": _AGE_CN.get(m.get("age"), m.get("age") or ""),
            "accent": _ACCENT_CN.get(m.get("accent"), m.get("accent") or ""),
        }


def load_model(src: str, model_dir: str) -> None:
    sys.path.insert(0, src)
    sys.path.insert(0, src + "/third_party/Matcha-TTS")
    # M3 has 8 physical cores; torch CPU defaults to the logical count (16) which
    # oversubscribes. Cap to physical cores (env NICO_TORCH_THREADS to override).
    n_threads = int(os.environ.get("NICO_TORCH_THREADS", "8"))
    torch.set_num_threads(n_threads)
    print("torch threads set to " + str(n_threads), flush=True)
    from cosyvoice.cli.cosyvoice import CosyVoice2  # noqa: E402

    print("loading CosyVoice2 from " + model_dir, flush=True)
    t0 = time.time()
    model = CosyVoice2(model_dir)
    print("model loaded in %.1fs" % (time.time() - t0), flush=True)
    STATE["cosyvoice"] = model
    STATE["sample_rate"] = int(model.sample_rate)
    # Resolve the fallback reference wav for voice cloning (spk2info.pt is not
    # in the ModelScope snapshot, so inference_sft / zero_shot_spk_id would
    # KeyError). Prefers asset/zero_shot_prompt.wav inside the repo checkout.
    global PROMPT_WAV, ASSET_DIR
    # Locate the asset directory that holds the reference prompt wavs.
    for d in (os.path.join(src, "asset"), os.path.dirname(model_dir)):
        if os.path.isfile(os.path.join(d, "zero_shot_prompt.wav")):
            ASSET_DIR = d
            break
    if ASSET_DIR:
        PROMPT_WAV = os.path.join(ASSET_DIR, "zero_shot_prompt.wav")
        # Preload every fixed voice's reference features once: the official
        # frontend recomputes speech tokens (onnx) + speaker embedding (onnx) +
        # mel feats for the SAME prompt wav on every request (P0 item).
        for vid, fname in VOICE_MAP.items():
            try:
                register_voice(model, vid, os.path.join(ASSET_DIR, fname))
                print("voice registered: " + vid, flush=True)
            except Exception as exc:  # noqa: BLE001
                print("voice register failed " + vid + ": " + repr(exc), flush=True)
    # Auto-discover user-downloaded AISHELL-3 reference wavs (SSB*.wav) in
    # ~/.dsh/nico/cosyvoice/voices and register them as zero-shot voices.
    voices_dir = os.path.join(os.path.expanduser("~"), ".dsh", "nico", "cosyvoice", "voices")
    if os.path.isdir(voices_dir):
        load_voice_meta(voices_dir)
        for fname in sorted(os.listdir(voices_dir)):
            m = re.match(r"^(SSB\d+)\.wav$", fname)
            if not m:
                continue
            vid, p = m.group(1), os.path.join(voices_dir, fname)
            VOICE_EXTRA[vid] = p
            try:
                model.add_zero_shot_spk("", p, vid)
                # add_zero_shot_spk stores only the zero-shot keys (llm_embedding
                # etc.); the no-instruct SFT decode path reads 'embedding' via
                # frontend_sft and raises KeyError otherwise — the request then
                # 500s and the plugin silently falls back to `say` (observed:
                # every AISHELL-3 voice sounded identical). Mirror register_voice.
                mi = model.frontend.spk2info[vid]
                mi["embedding"] = mi["llm_embedding"]
                print("extra voice registered: " + vid, flush=True)
            except Exception as exc:  # noqa: BLE001
                print("extra voice register failed " + vid + ": " + repr(exc), flush=True)
    print("model ready, sample_rate=" + str(STATE["sample_rate"]) +
          (", asset_dir=" + ASSET_DIR if ASSET_DIR else ", NO asset dir (SFT only)"), flush=True)
    # Warmup: first inference pays the lazy onnx/modelscope frontend init. Do
    # it here so the user's first real request is not the slow one.
    try:
        t0 = time.time()
        synthesize("预热。", None, "default", 1.0)
        STATE["warm"] = True
        print("warmup done in %.1fs" % (time.time() - t0), flush=True)
    except Exception as exc:  # noqa: BLE001
        print("warmup failed: " + repr(exc), flush=True)


def _voice_label(vid: str) -> str:
    """Human-readable label for a SSB voice from its AISHELL-3 metadata.

    The dataset has no names, only gender / age / accent, so we show e.g.
    "女·青年·北方 (SSB0005)" instead of the bare id. Falls back to the id when
    metadata is missing.
    """
    m = VOICE_META.get(vid)
    if not m:
        return vid
    parts = [m["gender"]]
    if m["age"]:
        parts.append(m["age"])
    if m["accent"]:
        parts.append(m["accent"])
    return "·".join(parts) + " (" + vid + ")"


def _resolve_prompt_wav(voice: str | None) -> str | None:
    """Map a named voice to its reference wav path (falls back to default)."""
    if voice:
        p = VOICE_EXTRA.get(voice)
        if p and os.path.isfile(p):
            return p
        if ASSET_DIR:
            fname = VOICE_MAP.get(voice)
            if fname:
                p = os.path.join(ASSET_DIR, fname)
                if os.path.isfile(p):
                    return p
    return PROMPT_WAV


def register_voice(model, vid, wav):
    # Register a fixed voice once (features cached, not recomputed per request).
    # The upstream add_zero_shot_spk() stores only the zero-shot keys, but the
    # CosyVoice2 SFT decode (no-instruct path) reads the 'embedding' key that
    # frontend_sft expects — store both key sets. prompt_text='' keeps the LLM
    # prompt empty (SFT mode ignores the prompt fields).
    mi = model.frontend.frontend_zero_shot("", "", wav, model.sample_rate, "")
    mi["embedding"] = mi["llm_embedding"]
    model.frontend.spk2info[vid] = mi


def synth_chunks(text: str, instruct: str | None, voice: str | None, speed: float):
    """Yield tts_speech tensors as the model generates them (lock held throughout)."""
    model = STATE["cosyvoice"]
    with STATE["lock"]:
        pw = _resolve_prompt_wav(voice)
        # stream=True: model.tts overlaps LLM token generation with Flow+HiFT
        # decoding and yields audio as soon as the first token bucket is ready
        # (stream=False p.join()s the whole LLM run before any decode).
        # speed != 1.0 is only supported in non-stream mode (model.tts asserts),
        # so speed requests fall back to stream=False.
        stream = (speed == 1.0)
        if instruct:
            # instruct2 → zero_shot path. Pass the registered voice id (NOT
            # zero_shot_spk_id='') so frontend_instruct2 reuses the preloaded
            # prompt feats (P0 cache hit) instead of recomputing onnx
            # speech-token + spk-embedding + mel for the same prompt wav.
            spk_id = voice if (voice and voice in model.frontend.spk2info) else ""
            gen = model.inference_instruct2(text, instruct, pw, zero_shot_spk_id=spk_id, stream=stream, speed=speed)
        elif pw:
            # No built-in speaker (spk2info.pt missing) → voice-clone fallback.
            # Registered voice (preloaded features) wins over recomputation.
            gen = (model.inference_sft(text, voice, stream=stream, speed=speed) if voice and voice in model.frontend.spk2info
                   else model.inference_zero_shot(text, "", pw, stream=stream, speed=speed))
        else:
            spk = voice or STATE["default_spk"]
            gen = model.inference_sft(text, spk, stream=stream, speed=speed)
        for c in gen:
            yield c["tts_speech"]


def synthesize(text: str, instruct: str | None, voice: str | None, speed: float) -> bytes:
    speech = torch.cat(list(synth_chunks(text, instruct, voice, speed)), dim=1)
    if speech.shape[0] == 0:
        raise RuntimeError("synthesis produced no audio (voice=" + str(voice) + ")")
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
        p = self.path.rstrip()
        if p.endswith("/models"):
            self._send(200, json.dumps({"data": [{"id": "cosyvoice-2", "object": "model"}], "object": "list"}).encode())
        elif p.endswith("/voices"):
            voices = [{"id": k, "name": k, "object": "voice", "description": VOICE_DESC.get(k, k)} for k in VOICE_MAP]
            voices += [{"id": k, "name": _voice_label(k), "object": "voice", "description": "AISHELL-3 参考音色 " + _voice_label(k)} for k in VOICE_EXTRA]
            self._send(200, json.dumps({"data": voices, "object": "list"}).encode())
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
        if str(req.get("response_format") or "wav") == "pcm":
            self._send_pcm_stream(text, instruct, req.get("voice"), float(req.get("speed") or 1.0))
            return
        try:
            wav = synthesize(text, instruct, req.get("voice"), float(req.get("speed") or 1.0))
        except KeyError as exc:
            self._send(400, json.dumps({"error": "unknown speaker/instruct target: " + str(exc)}).encode())
            return
        except Exception as exc:
            self._send(500, json.dumps({"error": str(exc)}).encode())
            return
        self._send(200, wav, "audio/wav")

    def _send_pcm_stream(self, text: str, instruct: str | None, voice: str | None, speed: float) -> None:
        """Stream raw s16le mono PCM as the model generates it (close-delimited).

        Lets the client start playback on the FIRST chunk instead of waiting for
        the full synthesis (CPU rtf ≈ 2.3 → a 4s reply previously took ~9s
        before the first audible sample).
        """
        try:
            self.send_response(200)
            self.send_header("Content-Type", "audio/pcm;codec=s16le;rate=" + str(STATE["sample_rate"]))
            self.send_header("X-Sample-Rate", str(STATE["sample_rate"]))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            chunks = 0
            for speech in synth_chunks(text, instruct, voice, speed):
                pcm = (speech.numpy().flatten().clip(-1.0, 1.0) * 32767.0).astype(np.int16)
                self.wfile.write(pcm.tobytes())
                self.wfile.flush()
                chunks += 1
            print("pcm stream: chunks=" + str(chunks), flush=True)
        except (BrokenPipeError, ConnectionResetError):
            pass   # client hung up early; nothing to salvage
        except Exception as exc:
            print("pcm stream failed: " + repr(exc), flush=True)
            try:
                self.wfile.write(("ERROR " + repr(exc)).encode())
            except Exception:
                pass
        finally:
            self.close_connection = True
            try:
                self.wfile.flush()
            except Exception:
                pass

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
