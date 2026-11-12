# dsh-nico

> 按住右 ⌘ 说一句，本地 AI 替我操作电脑。DSH cordis 插件：本地语音识别 → DSH 会话执行 → 本地神经语音播报，可选 Live2D 鲸鱼娘悬浮窗。

[English](README.en.md)

## 架构总览

```
按住右⌘ ──► 录音 ──► STT（本地 SenseVoice / 云端 ASR）
                          │
                          ▼
              DSH headless 固定会话（多轮上下文）
                          │
                          ▼
              回复文本 ──► TTS 服务（CosyVoice2 常驻进程）
                              ├─ 服务端流式播放：/speak（sounddevice/CoreAudio）
                              ├─ 回退：整段 wav + afplay / macOS say
                              └─ 打断：/interrupt（generation 清队列）
                          │
                          ▼
              Live2D 悬浮窗（人物 + 毛玻璃气泡 + 「新会话」按钮）
```

两种宿主形态，共用同一套语音循环（`lib/voice.mjs`）：

1. **cordis 插件（默认）**：挂进 DSH 桌面/lark 宿主进程，热键随宿主存活；
2. **CLI 守护**：`nico daemon` 独立运行（`NicoDaemon.app` 承载 TCC 授权）。

## 功能

- **本地语音识别**：SenseVoice（ONNX int8，sherpa-onnx），16k mono，完全离线；可选云端 ASR（端点/密钥自动从宿主 DSH 模型配置读取）。
- **固定会话 + 主动轮换**：语音指令落在固定 headless 会话（多轮上下文，`--approval-policy never`）。说「新会话 / 新开一个对话 / 清空会话」即轮换；人物窗右上角**「新会话」按钮**点击等效（语音同音字误听时的可靠入口）。旧会话保留在 DSH 会话列表。
- **会话引导语**：首次建会话时发送的语音输出契约（回复不超过两句话、禁止复述任务输出等），GUI「Nico 语音」页可自定义追加内容，改后自动重建会话。
- **神经语音播报**：CosyVoice2-0.5B 常驻服务（模型只加载一次），**服务端流式播放**——按句合成、chunk 直推 `sounddevice.OutputStream`（CoreAudio），首声 ~3-5s；失败逐级回退（整段 wav + afplay → macOS `say`）。新任务进入即打断在途播报（generation 递增 + 清空队列，立即静音）。
- **情感音色**：AISHELL-3 参考音色 + CosyVoice2 instruct2 情感指令（如「用开心的语气说」），GUI 下拉选择。
- **Live2D 悬浮窗**：双 NSPanel（人物窗 + 毛玻璃气泡窗）驱动六态（listening/thinking/start/speaking/end/fail），人物常驻可拖动、位置记忆；「新会话」原生按钮钉在人物头部旁。
- **tier-1 能力**：文件/shell 操作（整理桌面、找文件、转格式）零安装。

## 安装

```sh
dsh plugin --profile headless add dsh-nico
# 或
dsh plugin --profile headless add git+https://github.com/KevinZhangNothing/dsh-nico.git
```

然后一次性准备运行时：

```sh
nico setup                # 从 DSH 桌面应用 app.asar 抽取 sherpa-onnx → ~/.dsh/nico/rt
node scripts/setup-overlay.mjs   # Live2D 素材 + overlay 运行库（可选）
```

- SenseVoice 模型（228M）由 DSH 桌面应用预装在 `~/.dsh/speech-to-text/`。
- 原生热键模块（`hotkey_tap.node`）安装时自动编译；失败自动回退 JXA 后端。
- 首次 `nico say` / `nico daemon` 自动创建固定会话。

## CosyVoice 语音服务

GUI「Nico 语音」页操作：检测 / 部署 / 启动 / 停止，进度见 `~/.dsh/nico/cosyvoice/deploy.log`。

**部署形态**（自动选择，见 `scripts/setup-cosyvoice.mjs`）：

| 优先级 | 形态 | 说明 |
|---|---|---|
| 1 | `cosyvoice/mps-{src,venv}` | [ZoneTwelve/CosyVoice-MPS](https://github.com/ZoneTwelve/CosyVoice-MPS) fork + torch 2.15，**RTF 1.6**，频谱 QA 通过 |
| 2 | `cosyvoice/{src,venv}` | 官方源码 + torch 2.3.1，CPU，RTF ~3 |

> ⚠️ torch 2.3.1 的 MPS 输出为损坏音频（饱和噪声/全零，实测 rms=0.000 或 std=0.94），已禁用；升级 torch ≥2.4 后可用 `NICO_TTS_DEVICE=mps` 重试。MPS 部署重装依赖会把 torch 降回 2.3.1——部署脚本已跳过该步骤。

**流式播放协议**（`cosyvoice_server.py`）：

- `POST /v1/audio/speak` — NDJSON 事件：`{"event":"accepted"}` → `{"event":"playing"}`（首包入队）→ `{"event":"done","played":bool}`；按句合成、chunk 直推常驻 `sounddevice.OutputStream`；
- `POST /v1/audio/interrupt` — generation 递增 + 清空播放队列，立即静音；旧推理在下个 chunk 边界发现过期即停（逻辑中断，不强杀 MPS/CPU 推理）；
- `POST /v1/audio/speech` — OpenAI 兼容整段合成（wav / pcm 流），供回退与调试。

诊断落盘：`~/.dsh/nico/cosyvoice/server.log`（合成 rtf、traceback）。

## 会话管理

- 固定会话 id 存 `~/.dsh/nico/session_id`，绑定 cwd 存 `session_cwd`（dsh 会话拒绝跨目录接管，插件对每次 `dsh` spawn 传记录的 cwd）。
- 轮换触发：语音新会话短语 / 「新会话」按钮 / 引导语变更 / 会话被其它消费者抢占（自动重试）。
- 轮换即删 id，下一条指令懒重建（含引导语）；按钮触发为**立即重建**并语音确认。
- 引导语：内置契约（结论先行、两句话内、禁复述任务输出）+ GUI 自定义追加；缓存于 `greeting.txt`，变更自动重建会话。

## 诊断

| 文件 | 内容 |
|---|---|
| `~/.dsh/nico/apply.log` | 插件生命周期、语音识别原文、TTS 结果取证（pcm/sentences/wav/say 各路径结果与耗时） |
| `~/.dsh/nico/cosyvoice/server.log` | TTS 服务：合成 rtf、warmup、traceback |
| `~/.dsh/nico/cosyvoice/deploy.log` | 部署编排进度 |
| `~/.dsh/nico/tap_events.log` | 热键原始事件（`NICO_TAP_DEBUG=1` 开启，用于映射蓝牙耳机按键） |

## CLI

```sh
nico record /tmp/mic.wav 20   # 录 20s 麦
nico say /tmp/foo.wav         # 一句话：STT → DSH → 播报
nico chat 你好                # 文本直发（调试）
nico daemon                   # 常驻：按住右⌘说话（需输入监控授权）
nico sid                      # 显示/创建固定会话
nico new                      # 丢弃固定会话（下一条指令开新会话）
nico setup                    # 抽取 sherpa-onnx 运行时
```

## 配置参考

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `NICO_HOME` | `~/.dsh/nico` | 全部状态根目录 |
| `NICO_TTS_DEVICE` | `cpu`（fork 源码） | `mps` 启用 Apple GPU（torch ≥2.4 才可用） |
| `NICO_TORCH_THREADS` | `8` | TTS 服务 torch 线程数 |
| `NICO_TTS_STREAM` | 关 | `1` 启用废弃的 ffplay 流式实验路径 |
| `NICO_RT` / `NICO_RT_ROOT` | `~/.dsh/nico/rt` | sherpa-onnx / overlay 运行时 |
| `NICO_MODEL_DIR` | `~/.dsh/speech-to-text/...` | SenseVoice 模型目录 |
| `NICO_SESSION_CWD` | `~` | 会话创建 cwd |
| `NICO_BUBBLE_RADIUS/PAD_X/PAD_Y/ALPHA/GAP` | 22/14/10/0.7/12 | 气泡外观（宿主 spawn 时注入） |
| `NICO_POS_FILE` | `~/.dsh/nico/bubble_pos.json` | 人物窗位置记忆 |
| `NICO_SPRITE_DIR` | rt/sprite | 鲸鱼娘表情立绘 |
| `NICO_LIVE2D_SRC` | 插件同级 live2d 仓库 | overlay 部署素材源 |
| `NICO_TAP_DEBUG` | 关 | `1` 记录热键原始事件 |

## Cordis 插件契约

- 导出 **`name`** 与 **`apply(ctx)`**（不是 `activate`），`apply` 返回清理函数；
- 设备/服务用 `ctx.get(...)` 与 `ctx.on(...)`，不用 `inject`；
- `package.json` 的 `exports` 显式列出实际被导入的子路径（未列出的会被挡）；
- 设置 GUI 只能写 volatile 叶子（运行时回写走 loader 事件，configEditor 组合校验是 fatal）；
- re-apply 去重：模块级 `live` 槽为权威，重复 apply 直接跳过。

## 测试与验证

```sh
node --test        # 44 项：协议/媒体/客户端注册/会话轮换/TTS 打断/接线冒烟
```

overlay 几何、单实例锁、真实按键 hold-to-talk 等宿主行为需人工验证（驱动脚本 `test/post-*.swift`）。

## 已知限制

- 语音流程默认 `--approval-policy never`：审批门操作直接执行/拒绝，不会挂起。
- 热键 tap 只能看到标准 HID 事件；厂商私有 report 的耳机按键需 `hidutil monitor` 抓取。
- 说话口型为节奏假口型；RMS 驱动留待接入音频分析。
- overlay 素材 CDN 下载无断点续传（脚本为原子部署，可中断重跑）。
- RTF 当前 ~1.6（MPS）/ ~3（CPU），长回复的播报总时长仍大于合成时长——真·实时需 RTF<1（等 torch MPS 进一步成熟或换更快的引擎）。
