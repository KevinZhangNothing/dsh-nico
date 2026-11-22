# dsh-nico

> Hold right-⌘, say a sentence, and a local AI runs your computer for you. A DSH cordis plugin: local speech recognition → DSH session execution → local neural TTS, with an optional Live2D whale-girl overlay.

[中文](README.md)

## Architecture

```
Hold right-⌘ ──► record ──► STT (local SenseVoice / cloud ASR)
                                 │
                                 ▼
                 DSH headless fixed session (multi-turn)
                                 │
                                 ▼
                 reply text ──► TTS service (resident CosyVoice2 process)
                                 ├─ server-side streaming: /speak (sounddevice/CoreAudio)
                                 ├─ fallback: whole-wav + afplay / macOS say
                                 └─ interruption: /interrupt (generation + queue clear)
                                 │
                                 ▼
                 Live2D overlay (character + frosted bubble + "New Session" button)
```

Two host modes share one voice loop (`lib/voice.mjs`):

1. **cordis plugin (default)**: installed into the DSH desktop/lark host process; the hotkey lives with the host.
2. **CLI daemon**: `nico daemon` standalone (`NicoDaemon.app` carries the TCC grant).

## Features

- **Local STT**: SenseVoice (ONNX int8, sherpa-onnx), 16k mono, fully offline; optional cloud ASR (endpoint/key read automatically from the host DSH model config).
- **Fixed session + active rotation**: voice commands land in a fixed headless session (multi-turn, `--approval-policy never`). Say "新会话 / new session / clear session" to rotate; the **"New Session" button** next to the character's head is equivalent (reliable when STT mishears homophones). Old sessions stay in the DSH session list.
- **Session greeting**: the voice-output contract sent when the session is first created (≤2 spoken sentences, never read back task output), extensible from the GUI; changes rebuild the session automatically.
- **Neural TTS**: resident CosyVoice2-0.5B service (model loaded once), **server-side streaming playback** — sentence-buffered synthesis, chunks pushed straight into a persistent `sounddevice.OutputStream` (CoreAudio); first audio in ~3-5s; graceful fallback chain (whole-wav + afplay → macOS `say`). A new task immediately interrupts in-flight playback (generation bump + queue clear = instant silence).
- **Emotion voices**: AISHELL-3 reference voices + CosyVoice2 instruct2 emotion directives (e.g. "say it happily"), picked in the GUI.
- **Live2D overlay**: dual NSPanels (character + frosted bubble) driven through seven states (listening/thinking/working/start/speaking/end/fail); persistent draggable character with position memory; the native "New Session" button pins next to the head.
- **Step-by-step progress**: the bubble's working state shows a numbered plan — step 1 does X, step 2 does Y (✓/●/○) — with a "step X of N" hint: not a progress bar, but where the task actually is. The plan comes from the session's `todo_write`; without one it falls back to the latest tool calls (run command / read file / edit file…). Events come from the headless `--json` stream; they are never spoken and never interrupt playback, and collapse when the task ends.
- **Screen awareness ("say this")**: when a command refers to what is on screen ("what is this error", "look at my screen", "close this window for me"), releasing the key captures one screenshot; the session reads it with `read_image` before answering — no describing which window you are in. The capture goes to a per-use temp dir and is deleted when the turn ends; it is never kept or uploaded. Without the host's Screen Recording permission it degrades to a text-only command.
- **Spoken cancellation**: a whole-utterance "算了 / 取消 / never mind" never reaches the session — she just answers "好的" (okay), so the fixed context stays clean.
- **Long-term memory**: the session contract requires reading `~/.dsh/nico/memory.md` before answering; say "记住…" (remember...) or mention plans, deadlines, preferences, or what to call you, and the session appends a dated one-line record. Expired memories get pruned. It is a plain local file — open it, change it, delete it. Say "清空记忆 / 忘掉之前的话" to wipe it; "清空会话" still rotates the session — the two never interfere.
- **Tier-1 skills**: file/shell tasks (organize desktop, find files, convert formats) with zero setup.

## Install

```sh
dsh plugin --profile headless add dsh-nico
# or
dsh plugin --profile headless add git+https://github.com/KevinZhangNothing/dsh-nico.git
```

One-time runtime prep:

```sh
nico setup                # extract sherpa-onnx from the DSH app.asar → ~/.dsh/nico/rt
node scripts/setup-overlay.mjs   # Live2D assets + overlay runtime (optional)
```

- The SenseVoice model (228M) is preinstalled by the DSH desktop app at `~/.dsh/speech-to-text/`.
- The native hotkey module (`hotkey_tap.node`) builds during install; failures fall back to the JXA backend.
- The first `nico say` / `nico daemon` creates the fixed session automatically.

## CosyVoice TTS service

Operate from the GUI "Nico 语音" tab: probe / deploy / start / stop; progress in `~/.dsh/nico/cosyvoice/deploy.log`.

**Deployment shapes** (auto-selected, see `scripts/setup-cosyvoice.mjs`):

| Priority | Shape | Notes |
|---|---|---|
| 1 | `cosyvoice/mps-{src,venv}` | [ZoneTwelve/CosyVoice-MPS](https://github.com/ZoneTwelve/CosyVoice-MPS) fork + torch 2.15, **RTF 1.6**, spectral QA passed |
| 2 | `cosyvoice/{src,venv}` | upstream source + torch 2.3.1, CPU, RTF ~3 |

> ⚠️ torch 2.3.1 MPS renders corrupt audio (saturated noise / digital silence — measured rms=0.000 or std=0.94); disabled. With torch ≥2.4, retry via `NICO_TTS_DEVICE=mps`. Reinstalling the MPS deployment's requirements would downgrade torch back to 2.3.1 — the deploy script skips that step.

**Streaming playback protocol** (`cosyvoice_server.py`):

- `POST /v1/audio/speak` — NDJSON events: `{"event":"accepted"}` → `{"event":"playing"}` (first chunk queued) → `{"event":"done","played":bool}`; sentence-buffered synthesis, chunks pushed into the persistent `sounddevice.OutputStream`;
- `POST /v1/audio/interrupt` — bumps the generation and clears the playback queue (instant silence); the stale inference stops at the next chunk boundary (logical interruption — MPS/CPU ops cannot be killed mid-flight);
- `POST /v1/audio/speech` — OpenAI-compatible whole-utterance synthesis (wav / pcm stream) for fallback and debugging.

Diagnostics: `~/.dsh/nico/cosyvoice/server.log` (per-chunk RTF, warmup, tracebacks).

## Session management

- The fixed session id lives in `~/.dsh/nico/session_id`; the bound cwd in `session_cwd` (dsh refuses cross-directory adoption, so the plugin passes the recorded cwd to every `dsh` spawn).
- Rotation triggers: a spoken new-session phrase / the "New Session" button / a greeting change / the session being adopted by another consumer (auto-retry).
- Rotation drops the id; the next command lazily rebuilds the session (greeting included). The button rebuilds **immediately** and confirms by voice.
- Greeting: built-in contract (conclusion first, ≤2 sentences, never read back task output) + custom text appended from the GUI; cached in `greeting.txt`; changes rebuild the session.

## Diagnostics

| File | Contents |
|---|---|
| `~/.dsh/nico/apply.log` | plugin lifecycle, raw transcripts, TTS forensics (pcm/sentences/wav/say paths, outcomes, timings) |
| `~/.dsh/nico/cosyvoice/server.log` | TTS service: per-chunk RTF, warmup, tracebacks |
| `~/.dsh/nico/cosyvoice/deploy.log` | deploy orchestration progress |
| `~/.dsh/nico/tap_events.log` | raw hotkey events (`NICO_TAP_DEBUG=1`, for mapping Bluetooth headset buttons) |

## CLI

```sh
nico record /tmp/mic.wav 20   # record 20s from mic
nico say /tmp/foo.wav         # one shot: STT → DSH → TTS playback
nico chat 你好                # send text directly (debug)
nico daemon                   # resident: hold right-⌘ to talk (needs Input Monitoring)
nico sid                      # show/create the fixed session
nico new                      # drop the fixed session (next command starts a new one)
nico setup                    # extract the sherpa-onnx runtime
```

## Configuration reference

| Env var | Default | Purpose |
|---|---|---|
| `NICO_HOME` | `~/.dsh/nico` | root of all state |
| `NICO_TTS_DEVICE` | `cpu` (fork source) | `mps` enables Apple GPU (torch ≥2.4 only) |
| `NICO_TORCH_THREADS` | `8` | torch thread count in the TTS service |
| `NICO_TTS_STREAM` | off | `1` enables the deprecated ffplay streaming experiment |
| `NICO_RT` / `NICO_RT_ROOT` | `~/.dsh/nico/rt` | sherpa-onnx / overlay runtime |
| `NICO_MODEL_DIR` | `~/.dsh/speech-to-text/...` | SenseVoice model directory |
| `NICO_SESSION_CWD` | `~` | session creation cwd |
| `NICO_BUBBLE_RADIUS/PAD_X/PAD_Y/ALPHA/GAP` | 22/14/10/0.7/12 | bubble appearance (injected at spawn) |
| `NICO_POS_FILE` | `~/.dsh/nico/bubble_pos.json` | character window position memory |
| `NICO_SPRITE_DIR` | rt/sprite | whale-girl sprite sheets |
| `NICO_LIVE2D_SRC` | sibling live2d repo | overlay asset source |
| `NICO_TAP_DEBUG` | off | `1` logs raw hotkey events |

## Cordis plugin contract

- Export **`name`** and **`apply(ctx)`** (not `activate`); `apply` returns a cleanup function;
- Use `ctx.get(...)` and `ctx.on(...)` for services/events — never `inject`;
- `package.json` `exports` must list every imported subpath explicitly (unlisted subpaths are blocked);
- The settings GUI may only write volatile leaves (runtime write-back goes through the loader event; the configEditor compose check is fatal);
- Re-apply de-dup: the module-level `live` slot is authoritative; redundant applies are skipped.

## Tests

```sh
node --test        # 88 tests: protocol / step progress / media / client registration / session rotation / TTS interrupt / wiring smoke
```

Host behaviors (overlay geometry, single-instance lock, real-key hold-to-talk) need manual verification (driver scripts `test/post-*.swift`).

## Known limitations

- The voice flow defaults to `--approval-policy never`: approval-gated operations execute or deny immediately, never suspend. Measured: headless `--approval-policy ask` cannot back a voice-confirmation loop either — approval requests fail closed (`SANDBOX_ESCALATION_UNAVAILABLE`; headless has no approval answerer channel). Interactive confirmation needs DSH core support and is out of the plugin's reach.
- Screen awareness needs the host's Screen Recording permission (DSH desktop app / NicoDaemon.app); without it the capture fails and the command runs text-only.
- The hotkey tap only sees standard HID events; vendor-proprietary headset buttons need `hidutil monitor`.
- Mouth movement is rhythm-faked; RMS-driven lip sync is future work.
- Overlay CDN downloads have no resume (the deploy is atomic — safe to interrupt and rerun).
- RTF is currently ~1.6 (MPS) / ~3 (CPU): long replies synthesize slower than they play — true realtime needs RTF<1 (a more mature torch MPS, or a faster engine).
