# `src/outbound/` — 出站发送管线

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：把框架的一次「回复/推送」变成 QQ 消息——文本分块、媒体投递、卡片渲染、流式分段、问题卡发送、目标解析。
- **不做**：配额窗口与锚点状态（在 [`src/features/`](../features/)）、中间件（在 [`src/middleware/`](../middleware/)）、事件入口（在 [`src/gateway/`](../gateway/)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `outbound-service.ts` | 发送主入口；`probePassiveAnchorAlive`、`registerGateway` / `unregisterGateway` |
| `deliver-pipeline.ts` | `deliverReply`——投递管线（媒体解析 → 分块 → 发送） |
| `streaming-controller.ts` | `StreamingController`——自研流式生命周期（段模型、final 承接判定、park） |
| `chunker.ts` | `chunkMarkdownPreservingTables` / `enforceChunkLimit` / `splitOversizedChunk` |
| `grapheme.ts` | `resolveFindGraphemeChunkEnd` / `localFindGraphemeChunkEnd`——字形簇安全切点 |
| `media-send.ts` | `sendMedia` / `resolveOutboundMediaKind`——媒体投递与格式降级 |
| `progress-card-publisher.ts` | `renderProgressCardText` / `normalizePlanSteps`——进度卡快照渲染 |
| `question-send.ts` | `sendQuestionMessage`——ask_user 问题卡（挂本轮显式锚点，锚点不可用时降级主动一次） |
| `presentation-buttons.ts` | `renderQQBotKeyboard` / `readQQQuestionContext`——键盘与呈现控件 |
| `local-file-router.ts` | `isLocalFilePath` / `validateLocalFile` / `getFileSize`——本地路径与 data URL 判定 |
| `target.ts` | `isQQBotTarget` / OpenID 与 scope 前缀解析 |
| `debounce.ts` | `DeliverDebouncer`——出站合并 |
| `sanitize.ts` | `sanitizeQQBotText`——富媒体 token 剥离 |
| `reply-limiter.ts` | `ReplyLimiter`——**独立的老工具类，与 quota-manager 无关** |

## 相关红线

- **出站锚点模型：显式锚点 or 主动** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「出站锚点模型」
- **反应式配额：本地不按次数阻断** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「反应式配额」
- **Progress card 先走被动回复、锚点失效降级主动** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「Progress Card 逐条快照」
- **QQ 语音投递口径以「体积」为准，不是「时长」** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「QQ 语音」
- **字形簇安全分块** → [`docs/agents/chunking.md`](../../docs/agents/chunking.md) §「字形簇安全分块」
- **结构上下文开销必须封顶** → [`docs/agents/chunking.md`](../../docs/agents/chunking.md) §「结构上下文开销必须封顶」
- **流式是自研生命周期；final 承接判定三态** → [`docs/agents/streaming.md`](../../docs/agents/streaming.md)

## 本目录特有的坑

- **被动发送的锚点只来自显式 `opts.msgId`**——`resolveOutboundAnchor` 不做池化选取；无锚点一律走主动发送。
- **`passiveOnly` 永不主动降级**——它返回 `{error:'passive-quota-exhausted'}` 且不触达网关；「卡片降级主动」是上层 `allowActiveFallback` 的事。
- **锚点失效的确定性拒绝才转主动**（40034005 / 40034128）；网络错（`httpStatus===0`，结果不明）**不重发**——有重复风险。
- **本地分块回退必须逐行对齐官方 `dist/grapheme-*.mjs`**——尤其 `avoidTrailingHighSurrogateBreak` 的 `end + 1` 兜底分支。
- **结构上下文开销 > 正文预算时整段放弃上下文**——info string 只取首个 token（超 32 字符视为没有语言标识）。
- **首刀不得落在围栏开栏行内部**——否则首块只剩一个孤零零的 ```js。
- **`streaming-controller.ts` 的 park ≠ 终态化**——终态化＝内容黑洞（此后 partial/flush/final 全被 `isTerminal` 守卫静默吞掉）。
- **static 模式 `sendStatic` 失败必须抛错**——吞错会把失败正文记为已投递。
- **note 形态截断必须字形簇安全**——复用 `grapheme.ts`，禁止按码元硬切。
