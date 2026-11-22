# 对标 nico.app → dsh-nico 差距分析

> 对标对象：https://nico.app/ （Mac 端 voice-to-action 个人助手，2026）。逐项比对其主页承诺的能力与 dsh-nico 现状，落地可行的补齐，其余明确记为「不做 / 暂不做」及理由。

## 能力对照

| nico.app 能力 | dsh-nico 现状 | 结论 |
|---|---|---|
| 按住右 ⌘ 说话，松键提交（从任意 app） | ✅ 核心能力（原生 tap + hold-to-talk） | 已对齐 |
| 说话时打断播报（barge-in，"cut in any time"） | ✅ 新按下即 stopSpeaking + generation 清队列 | 已对齐 |
| 本地优先、零数据保留、用你自己的 AI 订阅 | ✅ 本地 STT/TTS；模型路由走宿主 DSH 配置（用户自己的 key） | 已对齐（DSH 无中间服务器，更强） |
| 「说 this」屏幕感知：她看得见你正在用的窗口 | ✅ 落地：lib/screen.mjs 指令提及屏幕内容时自动截屏，会话 read_image 看图后回答；截图临时目录、回合结束即删 | 第一轮落地 |
| 「算了 / 改主意」不误触发任务（ramble / change your mind） | ✅ 落地：整句「算了/取消/不要了」本地拦截，轻声应答不进会话（lib/voice.mjs isCancelCommand） | 第一轮落地（部分：句中改口仍靠 LLM 消化） |
| 记忆：她记得你说过的话（计划/偏好/称呼），记忆是本地文件、可看可删可备份 | ✅ 落地：会话契约要求先读 ~/.dsh/nico/memory.md，「记住…」或值得记住的信息自动追加带日期记录，「清空记忆」删文件重忘（lib/dsh.mjs isClearMemoryCommand + --add-dir 授权沙箱读写） | 第二轮落地（比 nico.app 更直白：就是一份可编辑的 markdown） |
| 记忆之「主动提起」（到期日前她先开口） | ⬜ 未做：需要常驻调度与打断策略 | 暂不做（记忆文件已就位，可后续在 daemon 上加轮询提醒） |
| 文件拖到人物身上 / 结果以卡片拖出 | ⬜ 未做：overlay 为 NSPanel，需实现 drag-receive 与结果卡片；当前文件任务靠「路径口述」 | 暂不做（投入大，路径口述已可用） |
| 危险动作前先问（sends/submits/deletes/money 先确认） | ⬜ 未做：语音流程固定 --approval-policy never。实测 ask 模式在 headless 下审批请求 fail-closed（SANDBOX_ESCALATION_UNAVAILABLE，无 answerer 通道），语音确认回路需 DSH 核心提供审批应答通道 | 不做（需 DSH 核心支持，插件层无法补齐；README 已记为已知限制） |
| Watch 主动监听（邮箱/文件夹/网页/日历变化出声提醒） | ⬜ 未做：需要常驻轮询与打断策略 | 暂不做（可作后续方向：复用 daemon 常驻 + 轮询任务） |
| Mail / Calendar / Reminders 原生集成 | ⬜ 未做 | 不做（DSH 会话可经 shell/AppleScript 达成，插件无需内建） |
| 自带浏览器 / Chrome 扩展操作网页 | ➖ DSH 会话自带 web 工具与浏览器能力 | 已覆盖（形态不同） |
| 双 agent（前台应答 + 后台 Worker 干活时前台可继续聊） | ➖ 单会话串行；语音场景单任务排队可接受 | 不做（架构性差异，收益有限） |
| 首次引导 checklist（权限/称呼/账号） | ➖ nico setup + GUI 设置页已覆盖运行时准备 | 已覆盖（形态不同） |

## 第一轮落地（2026-11-19 上午）

- lib/screen.mjs：触发词判定（wantsScreen）、截屏（captureScreen，失败即纯文本退化）、提示注入（attachScreen）、事后清理（cleanupScreen）；挂进 lib/dsh.mjs runCommand 唯一收口，CLI 守护 / cordis 宿主 / nico chat 全部生效。
- lib/voice.mjs：整句口语取消拦截（isCancelCommand），轻声应答后照常免提续听。
- 端到端验证：真实截屏 → headless 会话 read_image → 正确读出屏幕右侧第三个文件夹名；回合后临时文件已删。

## 第二轮落地（2026-11-19 同日）

- **长期记忆**：lib/paths.mjs 增 MEMORY_FILE；lib/dsh.mjs 契约要求先读记忆文件、「记住…」追加带日期记录、--add-dir NICO_DIR 授权沙箱读写、isClearMemoryCommand 删文件重忘（与会话轮换互不干扰）；lib/client.js BUILTIN_GREETING 同步。
- **审批门结论（实证）**：headless --approval-policy ask 返回 SANDBOX_ESCALATION_UNAVAILABLE（审批已启用但无 answerer），fail-closed——交互式语音确认需 DSH 核心支持，不是插件能补的。
- 测试：test/memory.test.mjs 增 3 项（清空记忆正负样本、契约含记忆约定）；全套 71/71 通过。
- 端到端：「记住：我在筹备 12 月的东京旅行，预算三万」→ memory.md 出现「- 2026-11-19：Kevin 筹备 12 月东京旅行，预算三万。」；下一轮「我的旅行计划是什么？」正确召回；「清空记忆」后文件删除。

## 明确不追（与 nico.app 的定位差异）

nico.app 是独立商业产品的封闭体验；dsh-nico 的价值在「本地语音入口 → DSH 全能会话」，能力由 DSH 会话层持续获得，插件只做语音/感知/播报三件事。文件卡片、审批确认回路归 DSH 宿主演进，不在插件内重复建设。
