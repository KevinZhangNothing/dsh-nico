# dsh-nico

Nico — 按住右⌘说一句，本地 AI 替我操作电脑。以 DSH cordis 插件形态发布。

## 能力
- **本地 STT**：SenseVoice (ONNX int8) via sherpa-onnx，16k mono，完全本地，不上传。
- **DSH 会话**：固定 headless 会话，多轮上下文，默认 `--approval-policy never`（语音流程不挂起）。会话引导语（首次建会话时发送、教会话如何理解语音指令）可在 GUI「Nico 语音」页自定义，留空用内置默认；改后删 `~/.dsh/nico/session_id` 重建会话生效。
- **语音输出**：macOS `say` 朗读回复；可选 CosyVoice2 本地部署（OpenAI 兼容 /v1/audio/speech），支持情感指令与自定义音色，失败自动回退 `say`。GUI「Nico 语音」页：检测 / 下载部署（detached 子进程跑完克隆+venv+权重后自动拉起服务，进度看 `~/.dsh/nico/cosyvoice/deploy.log`，断点可续）/ 停止；GUI 通过轮询服务探针观察就绪，插件运行时零配置回写（configEditor 组合校验是 fatal，不可承载运行时写入）。
- **右⌘ hotkey**（daemon）：按住录音、松开执行，Nico 风格。优先用原生 CGEventTap 子模块，回退 JXA。需 TCC 输入监控授权。
- **tier-1 能力**：文件/shell 操作（整理桌面、找文件、转格式）零安装。
- **云端 STT（可选）**：OpenAI 兼容 `/v1/audio/transcriptions`。端点与密钥**自动从宿主 DSH 模型配置读取**——先试 GUI「云端识别服务」下拉指定的 provider，再回退到当前推理模型所属 provider；无需手填 URL 或 key。
- **推理路由**：GUI 选的 provider/model 会生成 `dsh --patch` overlay（`agent-default-model` + 条件性 provider 块），端点同样来自宿主配置，不再写死任何地址。

## 文件
- `bin/nico.js` — 统一 CLI：`record` / `say` / `chat` / `daemon` / `sid` / `setup`。
- `bin/nico-daemon.js` — 常驻守护入口（薄壳，转调 `nico.js daemon`）。
- `lib/stt.mjs` — sherpa-onnx SenseVoice 包装（ESM）。
- `lib/dsh.mjs` — `dsh --profile headless` 会话粘合（创建/复用固定会话、发命令、取回复）。
- `lib/apikey.mjs` — 从 `~/.dsh/.credentials.yaml` 读取 `DEEPSEEK_API_KEY`（无 YAML 依赖）。
- `lib/recorder.mjs` — ffmpeg avfoundation 麦克风录音。
- `lib/hotkey.mjs` — 右⌘ CGEventTap 双后端：原生 `.node` 子模块（首选）+ JXA/osascript（回退）。
- `lib/paths.mjs` — 路径解析（状态在 `~/.dsh/nico/`，含 `session_id` / `session_cwd`）。
- `lib/index.js` — **cordis 插件入口**，导出 `name` + `apply(ctx)` 契约（见下）。
- `native/` — 原生 Obj-C++ 子模块源码（`hotkey_tap.mm`），编译出 `native/build/Release/hotkey_tap.node`。
- `NicoDaemon.app` — 签名壳 app，使 TCC 输入监控能授权到 `app.nico.daemon` bundle id。
- `scripts/setup-rt.mjs` — 从 `app.asar` 抽取 sherpa-onnx 到 `~/.dsh/nico/rt`（重启后仍在）。
- `cordis.patch.yml` — bundle patch（向 profile 层栈插入本插件）。

## Cordis 插件契约（关键）
本插件必须导出 **`name`** 与 **`apply(ctx)`**（**不是** `activate`），且 `apply` 返回清理函数。
- **不要**用 `inject` 导出 —— 改用 `ctx.get('session')`（在钩子内部）与 `ctx.on(event, cb)`。
- **不要**在 `package.json` 写 `exports` 映射：dsh 的 cordis 加载器按**显式文件路径**导入（`dsh-nico/lib/index.js`），`exports` 映射只含 `.`/`./stt` 会挡掉该路径 → `Package subpath './lib/index.js' is not defined by "exports"`。故**移除整个 `exports` 映射**。

## 会话绑定 cwd
dsh 把会话绑定到记录时的 cwd（`session … was recorded in "/Users/kevin", not "…"`）。
本插件在 `~/.dsh/nico/session_cwd` 存住该 cwd，并对**每次** `dsh` spawn 传 `cwd`，
因此可从任意目录运行。

## 原生 hotkey 子模块
`native/hotkey_tap.mm`（Obj-C++ NAPI）在**独立线程**装一个**被动** `CGEventTap`：
- 监听 `kCGEventFlagsChanged`，读 modifier 字段，右⌘位（`1<<23`）下降沿发 `down`、上升沿发 `up`。
- 线程用**堆分配 + `detach()`**（OS 退出时回收），避免静态 joinable 线程在 `cxa_finalize` 时 `std::terminate`（SIGABRT）。
- 构建：`npm run build`（即 `cd native && npx --yes node-gyp rebuild`）。
- `lib/hotkey.mjs` 先尝试加载 `native/build/{Release,Debug}/hotkey_tap.node`；缺失时回退 JXA/osascript。
- TCC 输入监控归属**责任父进程**：跑在签名 `NicoDaemon.app` 下归 `app.nico.daemon`；跑在 DSH daemon（`com.deepseek.dsh`）下时，DSH 已有输入监控，tap 直接可用。

## 安装
```sh
# 推荐：npm 安装（postinstall 会自动编译原生热键模块；编译失败自动回退 JXA 后端）
dsh plugin --profile headless add dsh-nico

# 或从 git 安装
dsh plugin --profile headless add git+https://github.com/KevinZhangNothing/dsh-nico.git
```
然后在 `~/.dsh/profiles/headless/package.json` 的 `dsh.profile.bundles` 数组里加一行 `"dsh-nico"`（若 bundle 机制需要）。

## 准备运行时（一次性）
```sh
nico setup       # 从 DSH 桌面应用的 app.asar 抽取 sherpa-onnx → ~/.dsh/nico/rt（重启后仍可用）
```
- 需要本机已安装 DSH 桌面应用（默认位置 `/Applications/DeepSeek Harness.app`，或 `~/Applications` 下同名）。
- 原生热键模块（hotkey_tap.node）已在 `dsh plugin add` 的 postinstall 中自动编译；缺失时热键回退 JXA 后端，无需手动 `npm run build`。
- SenseVoice 模型（228M）由 DSH 应用预装在 `~/.dsh/speech-to-text/`；缺失时本地 STT 不可用，可改 GUI 用云端识别服务。
首次 `nico say` / `nico daemon` 会按需创建固定会话 id（存于 `~/.dsh/nico/session_id` + `session_cwd`）。
API key 自动从 `~/.dsh/.credentials.yaml` 读取（records: DEEPSEEK_API_KEY）。

## 使用
```sh
nico say /tmp/foo.wav     # 一句话：STT → DSH → say 朗读
nico chat 你好             # 文本直发（调试）
nico record /tmp/mic.wav 20  # 录 20s 麦
nico daemon               # 常驻：按住右⌘说话（需先授予输入监控）
```

## TCC 授权（daemon 用）
1. 运行 `nico daemon`（或在签名 `NicoDaemon.app` 下运行）。
2. 系统设置 → 隐私与安全性 → **输入监控** → 添加并勾选运行本命令的终端/Node，或 `NicoDaemon.app`（`app.nico.daemon`）。
3. 重新运行 `nico daemon`。
- 跑在 DSH daemon（`com.deepseek.dsh`）内时，DSH 已带输入监控，无需额外授权。
- 辅助功能（AXIsProcessTrusted）对叶子进程不可靠，本插件**不**依赖它；以 tap 是否装上为准。

## 已知限制
- 语音流程默认 `--approval-policy never`，遇审批门操作不会挂起，但也**不会**弹审批（危险操作按策略直接执行/拒绝）。
- 合成 `CGEventPost` 事件从另一进程发出时，不保证经被动 HID tap 路由，故**真实按键**的 hold-to-talk 需人工验证。
- sherpa-onnx 模型（228M）位于 `~/.dsh/speech-to-text/…`，由 DSH 应用预装；若缺失需重新下载。
