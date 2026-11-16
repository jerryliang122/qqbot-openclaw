# `src/features/` — 会话状态与交互功能

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。
>
> 本目录 30 个文件，按职能分四簇。**先看簇，再看文件。**

## 职责边界

- **做**：进程内会话状态（配额窗口 / 合并缓冲 / 群模式 / 历史 / 引用索引）、用户交互（ask_user 问答卡 / 审批 / 配对 / Secret 输入）、主动发送与预算、webhook 派发跟踪。
- **不做**：发送管线（在 [`src/outbound/`](../outbound/)）、中间件链（在 [`src/middleware/`](../middleware/)）、事件入口（在 [`src/gateway/`](../gateway/)）。

## 关键文件

**配额与锚点**（`docs/agents/outbound-and-quota.md` 的实现层）

| 文件 | 作用 |
|---|---|
| `quota-manager.ts` | `PLATFORM_PASSIVE_WINDOW`、`registerMsgIdWindow`、`isAnchorDeadError` / `ANCHOR_DEAD_CODES` |
| `msgid-cache.ts` | `cacheMsgId` / `peekMsgIdReceivedAt`——**接收时刻登记表，不是锚点池** |
| `proactive-budget.ts` | `DAILY_PROACTIVE_LIMIT`、`recordProactiveSend`——每日主动预算记账 |
| `proactive.ts` | 主动发送与已知用户登记 |

**群与入站**

| 文件 | 作用 |
|---|---|
| `group-merge.ts` | 群消息合并（窗口 / 最大批量 / 最大持有时长 / 正文上限） |
| `group-session-busy.ts` | 群 turn 忙碌信号（`markGroupTurnStarted` / `onGroupIdle`） |
| `group-mode-store.ts` | `recordGroupEvent` / `getGroupModeFacts`——群三模式推断 |
| `room-event.ts` | room_event 策略结论：`resolveGroupRoomEventPolicy` 的那一份 |
| `inbound-debounce.ts` | c2c 防抖（`resolveC2CInboundDebounceMs` / `mergeAssembledBodies`） |
| `history-store.ts` | 群历史缓冲（`historyMode` = `clear` / `rolling`） |

**问答与交互**

| 文件 | 作用 |
|---|---|
| `question-card.ts` | 单题 / 多题卡片渲染（`① ②` 前缀、标签宽度估算） |
| `question-flow.ts` | `renderSequentialCard` / `sendSequentialQuestionCard` / `submitSequentialAnswers` |
| `question-helpers.ts` | 多题解析与运行时对接（`parseMultiQuestionPrompt` / `questionGatewayRuntime`） |
| `question-submit.ts` | `submitMultiQuestionAnswer`——走框架官方 `claimPendingAgentQuestionAnswer` 通道 |
| `approval-capability.ts` | SDK-native 审批能力声明（availability / presentation / transport 回调） |
| `approval-helpers.ts` | 审批目标解析与决策 |
| `command-panel.ts` | QQ Bot 指令面板自动同步（`/v2/panels`） |
| `access-notice.ts` | 访问控制拒绝回告（allowlist 命中失败时告诉用户原因） |
| `secret-input-store.ts` | Secret 输入 pending（TTL 10min，仅 c2c） |
| `secret-store-cli.ts` | `openclaw secrets store set` 调用与脱敏（`maskSecret` / `scrubSecret`） |

**其它**

| 文件 | 作用 |
|---|---|
| `ref-index-store.ts` | `PersistedRefIndexStore` / `isQuoteOfBotMessage`——消息引用索引 |
| `outbound-echo-store.ts` | 出站消息 ID 登记（自回声判定用） |
| `push-authorization-store.ts` | 推送授权事件事实 |
| `typing-refresh.ts` | 出站消息 → typing 续期信号 |
| `webhook-dispatch-tracker.ts` | `beginWebhookDispatchScope` / `settleWebhookDispatchScope`——detached 派发跟踪 |
| `detached-webhook-work.ts` | `loadDetachedWebhookGuards` / `withDetachedWebhookWork`——共享加载器与降级 |
| `credential-backup.ts` | 凭据备份读写 |

## 相关红线

- **出站锚点模型：显式锚点 or 主动** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「出站锚点模型」
- **反应式配额：本地不按次数阻断** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「反应式配额」
- **多题问答进行中的入站文本本地暂存、不转发框架** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「多题问答进行中」
- **Secret input 消息绝不进 AI transcript** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「Secret input flow」
- **群消息合并在插件侧做** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「群消息合并在插件侧做」
- **c2c 入站防抖合并 + 三类旁路** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「c2c 入站防抖合并」
- **webhook op:0 必须挂 detached 准入根** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「webhook 模式的 op:0 派发」

## 本目录特有的坑

- **`msgid-cache.ts` 不是锚点池**——它只登记「接收时刻」，供诚实重建窗口与死锚点簿记。**禁止重新引入「从缓存挑 msg_id」的池化选取**。
- **`quota-manager.ts` 的观测计数只升不降**——判死时不得回截 count（证据保全）。
- **`secret-store-cli.ts` 的 kind 恒为 `env`**——`secret` 存储会让 AI 读不到（2026-08-30 用户反馈）。
- **多题 pending 的两处查表都必须「含 resolving」**——`findPendingMultiQuestionByConversation` 排除 resolving 会同时击穿 secret-capture 让行红线与拦截层（文本泄漏回框架）。
- **`approval-capability.ts` 的日志一律 `shortId()`**——审批路径曾把点击者 openid 原样落盘（PR #102 修）。
- **`access-notice.ts` 只在 allowlist 拒绝分支回话**——`dmPolicy/groupPolicy: "disabled"` 是管理员显式拉下的总闸，此时保持静默。
- **`command-panel.ts` 有平台硬限**——面板项 name ≤14 字符、desc ≤30 字符、每面板 ≤20 项、每 bot ≤20 个面板；`POST /v2/panels` 限 10 QPM。
