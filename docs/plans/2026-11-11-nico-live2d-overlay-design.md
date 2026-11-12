# Nico Live2D Overlay 设计（2026-11-11）

## 背景与根因

现 overlay（`native/bubble.swift`）为 352×160 sprite 小窗，每次 `show()` 都调 `positionTopRight()`，拖动后下一次状态更新即被弹回右上角；形态与样图（人物贴底居中 + 气泡锚在头顶 + 状态化内容）不符。

## 目标

- 人物（Live2D）贴底居中，高约屏高 40%；气泡锚在人物头顶上方，随内容自适应。
- 气泡状态机：listening / thinking / start task / speaking / end（外加 fail）。
- 整窗可拖动，位置记忆到 `~/.dsh/nico/bubble_pos.json`，show 不再重置位置。
- 素材：`~/Desktop/Nothing/live2d-deepseek-whale-girl/cubism/`（Cubism 5 完整包）。

## 方案（A：WKWebView + Live2D Web SDK）

保留现有 NSPanel 壳与 stdin JSON 协议骨架，内容换为透明 WKWebView：

```
lib/index.js (cordis 寄生)              NicoOverlay（NSPanel 壳）
  voice 事件 → 状态机 → stdin JSON →     ├─ 窗口：透明、nonactivating、
  rec-start / transcript / thinking /      canJoinAllSpaces、贴底居中
  reply / tts-done                        ├─ WKWebView：透明背景，
                                           │  本地 overlay.html
                                           │  (pixi + pixi-live2d-display + Cubism Core)
                                           └─ performDrag / 位置记忆
```

- Swift 侧只做：窗口定位/尺寸、stdin 协议 → `evaluateJavaScript`、拖动。
- WebView 内：pixi-live2d-display 加载 `model3.json`；气泡为 DOM 层（HTML/CSS 还原样图：状态头 + 正文 + 辅助行）。
- 窗口 = 人物+气泡联合包围盒（非全屏），空闲淡出后整体隐藏，不常驻挡屏。

否决项：Cubism Native (C++)+Metal（集成成本高一个数量级）；离线序列帧（失去实时性，保留为终极降级）。

## 状态机映射

| 状态 | 触发（现有事件） | 气泡 | 人物 |
|---|---|---|---|
| listening | `rec-start` | 红点动画 Listening + 实时转写 + Release to send · Esc to cancel | idle motion（眨眼+呼吸），视线跟随鼠标 |
| thinking | transcript 后、reply 前（index.js 新增中间态） | spinner Thinking + 已识别文本 | f08_sleepy + 头微歪 |
| start task | reply 到达开始执行 | 音波 Starting the task… + 任务摘要 | Nod motion + f05_surprised→f02_smile |
| speaking | TTS 播放中 | 音波 Speaking + 回复文本 | LipSync：`ParamMouthOpenY` 假口型（节奏开合） |
| end | TTS 结束 | 淡出 | Bow motion + f02_smile → 窗口淡出 |
| fail | `rec-fail` / reply !ok | ⚠️ 提示 | Shake motion + f03_angry / f04_sad |

- 口型：假口型先上；后续 CosyVoice 流式路径成型后升级 RMS 驱动，直灌同一 LipSync 通道。
- 物理（头发/鲸鱼鳍摆动）、眨眼、呼吸均为模型自带，零代码。

## 协议

stdin 一行一 JSON，扩展为：

```json
{"op":"state","state":"listening","text":"…","hint":"…"}
```

旧 `{"op":"show","text","expr"}` 做兼容映射；`nico.js` 独立 daemon 分支共用。

## 素材部署

- `cubism/` 目录（11MB）整体拷到 `~/.dsh/nico/rt/live2d/`，`nico setup` 模式。
- pixi / pixi-live2d-display 的 JS 随插件打包，离线加载不出网。
- **Cubism Core 不随包分发**：`nico setup` 从 Live2D 官方渠道拉取 `live2dcubismcore.min.js` 放 `~/.dsh/nico/rt/`（与 sherpa-onnx 抽取模式一致）。
- 已知坑 1：model3.json 中 8 个 expression 的 `Name` 全为 "普通"（构建脚本写死）——部署时按文件序 f01..f08 引用，或部署脚本修正 Name。
- 降级链：webview/模型加载失败 → 回落现有 sprite 版 panel（native/bubble.swift 保留）。

## 交互

- 整窗 `performDrag` 可拖，位置记忆，show 不重置。
- HitAreas（头部/身体）模型已定义，"点人物切表情"留作后续增强，首发不做。

## 风险

1. WKWebView 透明背景需 `setValue(false, forKey:"drawsBackground")`，macOS 27 需实测（透明 NSPanel 已验证，webview 层为新增风险点）。
2. Cubism Web Core 许可条款需在分发时附带声明（自用无碍）。

## 涉及文件（预估）

- 改：`native/bubble.swift`（窗口壳 + webview + 协议扩展）、`lib/index.js`（状态机接线 + thinking 中间态 + 位置记忆配置）
- 新增：`native/overlay/overlay.html` + 打包的 pixi/live2d-display JS、`lib/setup` 部署步骤（素材拷贝 + Core 拉取 + expression Name 修正）
- 保留：sprite 版为降级路径
