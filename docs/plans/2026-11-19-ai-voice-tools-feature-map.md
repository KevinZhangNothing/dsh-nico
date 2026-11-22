# AI 语音工具功能调研 → nico 插件落地对照

> 调研对象：Wispr Flow、Superwhisper、Aqua Voice、BetterDictation、openclaw VoiceWake、vaani-voice、openensemble 等主流/代表性 AI 语音输入与助手工具（2025–2026）。
> 结论：nico 的定位是「按住说话 → AI 执行 → 语音回复」，与听写工具不完全重叠；下表列出各工具成熟特性在 nico 的落地状态。

## 特性对照表

| 特性 | 代表工具 | nico 状态 |
|---|---|---|
| 按住说话（push-to-talk） | 全部 | ✅ 已有（右⌘ hold，原生 tap） |
| 误触防护（无语音不触发） | energy VAD / smart endpointing | ✅ 2026-11-19 `lib/vad.mjs`：20ms 帧能量门控，全静音录音直接跳过 STT 与会话调用 |
| 首尾静音裁剪（防 STT 幻觉） | 能量 VAD 类 | ✅ 同上，`recognizeWav`/`transcribe` 送识别前裁剪 |
| 自定义词典/热词修正 | Superwhisper custom words、Wispr Flow dictionary | ✅ 2026-11-19 `lib/hotwords.mjs`：`corrections.json` + GUI 编辑（volatile leaf 镜像），transcribe 单一收口，长词优先 |
| 云端 ASR 失败回退 | Aqua（云）vs 本地混合 | ✅ 云失败逐 provider 回退 + 原因落盘 apply.log；本地 SenseVoice 兜底 |
| 多 provider 云 ASR | Aqua/Avalon | ✅ 候选 provider 逐个尝试（HTTP 失败 continue 而非中止） |
| 回复长度控制（语音契约） | 语音助手类 | ✅ 引导语契约 + `speakable()` 句界截断 |
| 播报打断（新任务静音旧播报） | barge-in | ✅ 新按下即 `stopSpeaking()` + generation 递增清队列 |
| 免提连续对话（hands-free） | vaani `voice.continuous`、openensemble | ✅ 2026-11-19 设置开关（volatile leaf）+ `NICO_HANDS_FREE=1`：回复播完自动重开录音，silencedetect 首个语音后静音窗（1s）自动提交 |
| 唤醒词（wake word） | openclaw VoiceWake、vaani | ⬜ 未做：常驻唤醒词识别耗电；SenseVoice 非流式不适合 always-on，需专用 KWS 模型 |
| 流式/实时转写（partial results） | Aqua、openclaw（overlay partials） | ⬜ 未做：SenseVoiceSmall 为离线整段模型；流式需换 streaming ASR 或分块伪流式 |
| 说话时自动暂停播报再续播 | openensemble 对话模式 | ⬜ 未做：当前为打断丢弃语义，续播需缓存未播队列 |
| 录音上限提示 | — | ✅ 2026-11-19 maxSec 触发时语音 + 气泡提示「录音时间到」（`voice.mjs` rec-capped 事件） |
| 文本规整（去填充词/标点） | Wispr Flow AI cleanup | ➖ nico 送 DSH 会话执行，LLM 已消化口语噪声，无需独立规整层 |
| 多语言 | Wispr Flow 100+ | ➖ SenseVoice auto 多语言已覆盖中英混合主场景 |

## 后续优先级建议

1. **录音上限语音提示**（小）：maxSec 触发时 TTS 提示「时间到」，或气泡窗提示。
2. **免提模式**（中）：设置开关 + 回复播完后延迟 0.3s 自动重开录音 + 静音超时断句；可复用 `lib/vad.mjs` 做断句检测。
3. **流式转写**（大）：换 sherpa-onnx streaming zipformer（中英）做伪流式，或保留 SenseVoice 整段但缩短感知延迟（按下即出气泡）。
4. **唤醒词**（大）：引入 openWakeWord/sherpa KWS 常驻进程，仅免提模式下启用。

## 本轮已落地（详见 git log 2026-11-19）

- 能量门控 + 静音裁剪（`lib/vad.mjs`、`lib/stt.mjs`）
- 热词修正表 + GUI 入口 + CLI `nico words`（`lib/hotwords.mjs`、`lib/client.js`、`bin/nico.js`）
- 云端 ASR 多 provider 续试 + 回退诊断（`lib/cloud-stt.mjs`、`lib/stt.mjs`）
