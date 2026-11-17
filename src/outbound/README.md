# `src/outbound/` — 出站发送管线

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。
>
> 根级红线（被动/主动锚点模型、反应式配额）在 [`AGENTS.md`](../../AGENTS.md) § Key gotchas；本目录负责它们的**实现细节**。

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
| `sanitize.ts` | `sanitizeQQBotText`——剥离框架内部脚手架标签（`system-reminder` / `thinking` / `reasoning` 等），保留 Markdown 渲染 |

## 相关红线

- **出站锚点模型：显式锚点 or 主动**（根级）→ 根 [`AGENTS.md`](../../AGENTS.md) §「出站锚点与配额」
- **反应式配额：本地不按次数阻断**（根级）→ 根 [`AGENTS.md`](../../AGENTS.md) §「出站锚点与配额」
- **Progress Card 逐条快照** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md)
- **QQ 语音投递口径** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「QQ 语音」
- **字形簇安全分块 / 结构上下文开销封顶** → [`docs/agents/chunking.md`](../../docs/agents/chunking.md)
- **流式生命周期 / final 承接判定 / park** → [`docs/agents/streaming.md`](../../docs/agents/streaming.md)

## 本目录特有的坑

### 分块（`chunker.ts` + `grapheme.ts`）

- **框架 chunker 对无空白中文长串会在硬上限处截断**，切点落在 emoji（代理对 / ZWJ / 组合符号）中间就渲染成豆腐块；本地 GFM fallback 则是整块不切、超限消息被平台直接拒收（消息丢失）。`grapheme.ts` 用 `text-grapheme` 的 `findGraphemeChunkEnd` 做切点吸附，带能力探测 + 本地 `Intl.Segmenter` 等价回退。
- **本地回退必须逐行对齐官方 `dist/grapheme-*.mjs`**——尤其 `avoidTrailingHighSurrogateBreak` 的 `end + 1` 兜底分支（预算只剩 1 个码元且是代理对前半时，退到 `start` 会零进展、整块原样超限被拒收）。**官方契约允许「代理对安全的部分切」**——不要断言切点必须是簇边界。
- **结构上下文开销必须封顶**——围栏 info string 只取首个 token（超 32 字符视为没有语言标识）、降级路径逐级退（完整开栏行 → 裸 marker → 放弃）、上下文开销 > 正文预算时整段放弃上下文。此前两个漏洞叠在一起导致一条 5114 字消息被切成 5110 块且全部超限。
- **首刀不得落在围栏开栏行内部**，否则首块只剩一个孤零零的 ```js。

### 流式（`streaming-controller.ts`）

- **流式是自研生命周期**（QQ 无消息编辑 API，原地更新物理上做不到），**「已投递什么」只能插件自己记**——框架没有 final/流内对账兜底。任何新增流式行为都必须在 `StreamingController` 边界补测试。
- **一段 = 一条 QQ 消息**（= 一条 assistant 消息）。**长度启发式已废除**（同轮重发会让长度判断误判成新回复），**跨段截断拼接已废除**（QQ replace 模式已下发前缀不可变更，跨段截断在用户侧就是「草稿」）。段边界由框架 `onAssistantMessageStart` + 工具调用驱动。
- **final payload 承接判定是三态不是二值**：`identical`（纯去重）/ `extension`（增量，如 usage footer）/ `unrelated`（无关重写）。static 模式下 `unrelated` 必须**整段补发**（此前被折叠成空串，600+ 字正文静默消失且终态仍记 `done`）；stream 模式下 `unrelated` 有意维持丢弃（流内内容已可见，补发会重复）。**`phase: streaming → done (finalize:fallback)` 不等于正文已送达**——要看 `[stream-final] payload received chars=N`。
- **不要把 `finalize:fallback` 改成 `failed`**——static 模式下 `shouldSuppressFinalTailFallback` 恒 true，改成 `failed` 等于主动关闭唯一那层兜底。
- **流式提前收尾用 park、不终态化**——终态化＝内容黑洞（此后 partial/flush/final 全被 `isTerminal` 守卫静默吞掉，零日志零请求）。**park ≠ 失败**（`shouldFallbackToStatic` 仍为 false）。
- **取消信号必须进队列复查**（TOCTOU）：`onPartialReply`/`flushSegment`/`closeSegment` 全都接收 `signal` 并在实际执行时复查。
- **`/usage` footer 靠 final payload 文本投递**，流式必须差量补发——`onPartialReply` 增量产生于追加之前，永远不含 footer。static 模式 `sendStatic` 失败**必须抛错**（吞错会把失败正文记为已投递）。
- **ask_user 前置文本的 flush 必须 tolerant**——发送失败不终态化 controller，否则作答后的 partial/final 全被丢弃。

### 配额与锚点（实现细节）

- **被动发送的锚点只来自显式 `opts.msgId`**——`resolveOutboundAnchor` 不做池化选取；无锚点一律走主动发送。
- **锚点失效兜底**：被动发送被平台 **40034005**（过期）/ **40034128**（超限）确定性拒绝 → rollback + 驱逐 + 标记 dead → 同内容**转主动重发一次**。网络错（`httpStatus===0`，结果不明）**不重发**——有重复风险。`passiveOnly` 发送（progress card）**不做主动重发**。
- **`passiveOnly` 永不主动降级**——它返回 `{error:'passive-quota-exhausted'}` 且不触达网关；「卡片降级主动」是上层 `allowActiveFallback` 的事，别把 passiveOnly 读成「这条消息永不变主动」。
- **ask_user 问题卡必须挂本轮显式锚点**——走 `outbound-service.sendText` + 本轮 inbound 的 `envelope.messageId` ⇒ 被动回复；锚点不可用（TTL 过期 / 平台判死）时**降级主动一次**（`question-send.ts`，同 progress card 口径，降级**保留 keyboard**）。**红线：禁止改回 SDK 直发**；**不得**让网关 `retryOnDeadAnchor` 兜底——那条主动重发路径不携带 keyboard（用户看到题干却无从作答）。
- **Progress card 先走被动回复、锚点失效降级主动**（`passiveOnly` 首试；**锚点无存活（无 msg_id / TTL 过期 / 死锚点）或平台判死（40034005 / 40034128）⇒ 降级为主动发送**——卡片按「前置消息」处理，烧每日 1000 条主动预算但用户仍能看到进度；降级状态本轮记忆，后续快照直接走主动）。支持 checklist（`📋 进度 N/M`，框架自动计数行被抑制）与 note 双形态（markdown-only 卡片 → `📋 状态`，判定式 `steps=[] && explanation 非空；note 截断必须**字形簇安全**——复用 `grapheme.ts`，禁止按码元硬切切碎代理对；混合形态的 markdown 在框架投影层被丢弃——插件侧无解））。反应式配额下无本地次数门（`reserveQuota` 保槽配置已删除，残留会被 schema 拒收），唯一保险丝是 `maxPerTurn`。
- **typing 永不占用主动额度**——typing（msg_type=6）不占被动回复额度，但**绝不降级为「不带 msg_id 的主动形态」**：锚点不可用（TTL 过期 / 死锚点 / 平台 40034005·40034128 拒收）⇒ **本轮停发**。主动额度留给正文与前置消息，typing 不参与竞争。平台拒收 typing 时须 `invalidateMsgIdQuota` 标记死锚点（本轮后续消息一律不得走被动回复）。
- **QQ 语音投递口径以「体积」为准，不是「时长」**——平台文档里没有任何语音时长限制，「60 秒以内是语音条」是相关性错觉。格式只认 silk/mp3/wav/ogg 四种；超 20MB 软限制由 `resolveOutboundMediaKind` **显式**降级为文件投递。
