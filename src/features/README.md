# `src/features/` — 会话状态与交互功能

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。
>
> 本目录 30 个文件，按职能分四簇。**先看簇，再看文件。**

## 职责边界

- **做**：进程内会话状态（配额窗口 / 合并缓冲 / 群模式 / 历史 / 引用索引）、用户交互（ask_user 问答卡 / 审批 / 配对 / Secret 输入）、主动发送与预算、webhook 派发跟踪。
- **不做**：发送管线（在 [`src/outbound/`](../outbound/)）、中间件链（在 [`src/middleware/`](../middleware/)）、事件入口（在 [`src/gateway/`](../gateway/)）。

## 关键文件

**配额与锚点**（根级「出站锚点与配额」红线的实现层）

| 文件 | 作用 |
|---|---|
| `quota-manager.ts` | `PLATFORM_PASSIVE_WINDOW`、`registerMsgIdWindow`、`isAnchorDeadError` / `ANCHOR_DEAD_CODES` |
| `msgid-cache.ts` | `cacheMsgId` / `peekMsgIdReceivedAt`——**接收时刻登记表，不是锚点池** |
| `proactive-budget.ts` | `DAILY_PROACTIVE_LIMIT`、`recordProactiveSend`——每日主动预算记账 |
| `proactive.ts` | 主动发送与已知用户登记 |

**群与入站**

| 文件 | 作用 |
|---|---|
| `group-merge.ts` | 群消息合并（窗口 / 最大批量 / 最大持有时长 / 正文上限）——**现为持久化入站不可用时的回落路径**；`isBypassGroupItem` 是旁路判定的**单一事实源** |
| `ingress-payload.ts` | 持久化入站载荷（schema v1）：活上下文 → 纯数据快照 / 反向重建 ctx·msg / `receivedAtMs` 排序键 |
| `ingress-queue.ts` | 持久化入站队列：per-account queue+drain 单例、lane 键、三态入队入口（`handled`/`not_applicable`/`unavailable`）、退出冲刷 |
| `ingress-batcher.ts` | 持久化入站组批：lane backlog 组批、容量裁剪、批次指纹、`createIngressEffectOnce` 幂等、派发 |
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

- **出站锚点模型 / 反应式配额**（根级）→ 根 [`AGENTS.md`](../../AGENTS.md) §「出站锚点与配额」
- **群合批必须在载体 ctx.state 写 `ingressParticipants`**（到达序去重、载体 sender 末位；`group-merge.ts` / `ingress-batcher.ts` 两个组批路径同构，单成员批不写）——那是 channelIngress 多参与者证据的唯一来源 → [`docs/agents/ingress-custody.md`](../../docs/agents/ingress-custody.md) §「插件实现」
- **多题问答进行中的入站文本本地暂存、不转发框架** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「多题问答进行中」
- **Secret input 消息绝不进 AI transcript** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「Secret input flow」
- **群消息合并在插件侧做** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「群消息合并在插件侧做」
- **room_event 完整支持** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md)
- **群历史模式 historyMode** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「群历史模式 historyMode」
- **c2c 入站防抖合并 + 三类旁路** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「c2c 入站防抖合并」
- **群聊持久化入站（排序 / 忙闲 / 幂等 / 降级）** → [`docs/agents/durable-group-ingress.md`](../../docs/agents/durable-group-ingress.md)

## 本目录特有的坑

### 群聊与 room_event

- **群聊三模式由平台决定，插件不可控**（AT 纯模式 / AT+最近N / 全量），**插件无需也不应按模式分流**——三事件共用 intent、SDK 映射同形态、走同一条中间件链。模式推断存 `group-mode-store.ts`，`/bot-group-info` 展示。
- **room_event 的三处裁决必须同源**——门控（`middleware/policy-injector.ts`）、入站分类（`dispatch/`）、历史缓冲跳过三处共用 `resolveGroupRoomEventPolicy` 的一份结论，**三处各算各的必然出事**（门控放行 + 分类成 user_request = 刷屏；门控拦掉 + 分类成 room_event = 永远收不到消息）。
- **回落链必须能区分「未配置」与「显式配置」**——靠 `ResolvedGroupConfig.unmentionedInboundExplicit`，否则框架级配置永远不生效。
- **可见回复模式按 turn 判定、且按会话类型隔离**——群/频道读 `messages.groupChat.visibleReplies`，非群只读 `messages.visibleReplies`。**群级 `message` 工具守卫的 allow 缺失/为空 + alsoAllow 非空 = 不限制**（core `unionAllow` 会合成 `["*", ...]` 隐式全放行，按排他白名单判会误降级）。确定不可用时该群降级回 user_request + 每群一条 WARN。
- **agent profile 不是阻塞项**——core 在 `message_tool_only` / `room_event` turn 会把 `message` 强制并入 profile 允许集。
- **群工具策略红线**：`resolveToolPolicy` 返回 `{allow: []}` = 什么都不允许（连 message 工具都被过滤）→ room_event 群彻底沉默。框架回调的 groupId 派生自 session key（**小写**），QQ openid 配置键原生**大写**——`lookupGroupEntry` 必须大小写不敏感查找，否则 adapter 路径永远落默认值。
- **群消息合并在插件侧做**——框架 collect 合批对「同群不同人」无效（分组键含 `senderId`，遇第一个不同 key 就 break）。**当前实现是持久化入站队列**（`ingress-queue.ts` + `ingress-batcher.ts`），内存合批（`group-merge.ts`）降级为回落路径。合并内容不能直接拼 N 条 agentBody（history 块会重复 N 份），历史必须取**批前基线**（最早成员的快照）。
- **排序权威 = 本地到达时刻 `receivedAtMs`，不是平台 timestamp**——QQ timestamp 是**客户端发送时间**，群成员设备时钟不一致 ⇒ 按它排序就是排错（旧实现的真缺陷）。
- **合批窗口时长来源 = 框架 `resolveInboundDebounceMs(cfg,'qqbot')`**（用户拍板 D-c）——**默认返回 0** ⇒ 领到队首行即刻派发（零延迟）；用户配了 `messages.inbound.byChannel.qqbot.debounceMs` 才进入窗口收集。**不得改回插件内硬编码常量**（会让该旋钮对群聊再次失效），**不得新增群专属配置键**。
- **忙闲判据 = durable lane claim，不是 dispatch promise 生命周期**——框架把 turn **defer**（仅入队）时 promise 就 resolve ⇒ 旧 busy 口径提前归零 ⇒ 合批散架。
- **drain 钩子抛错必须隔离**——框架 `await turnAdoptionLifecycle?.onAdopted()`，钩子抛错会冒泡成 turn 失败。
- **旁路判定必须入队时冻结**（`payload.bypass`）——合批发生在 claim 之后，那时读不到活状态（pending question store 是进程内的、附件是活对象）；口径共用 `group-merge.ts` 的 `isBypassGroupItem`，**禁止另写一份**。
- **批次指纹的命名空间跨版本必须稳定**——`qqbot-group-batch` 改了等于放过一次重复回复。
- **单条批次必须走「不合并」特判**（`kept.length === 1 && dropped === 0`）——否则正文多出 `[消息 1/1]` 分节头、webBody 的 from 从发送者变成群 openid（内存路径 `group-merge.ts` 有同条件特判，durable 路径必须对齐）。
- **日志里的群标识一律走 `shortId()`**（唯一事实源 `src/utils/redaction.ts`）——core 的 drain 内部日志还会内嵌 lane key（含群 openid）⇒ `onLog` 桥接处必须过 `redactIngressLog()`。
- **群历史模式 `historyMode`**：默认 `clear`（回复后整清）；`rolling`——bot 出站也记入 historyBuffer，回复后裁剪到最后一条 bot 发言之后。

### 入站防抖与回告

- **c2c 入站防抖合并**——配置优先级 `channels.qqbot.inboundDebounce.debounceMs`（0=关闭）→ 框架 `messages.inbound.byChannel.qqbot` → 默认 3000。**三类旁路必须在 `shouldDebounce` 内返回 false**（而非 enqueue 早退）：控制命令、斜杠命令、ask_user keyed 答案。**旁路不能被运行中的 turn 阻塞**——框架 enqueue 对旁路项会排队等 in-flight 任务链 settle，插嘴语义完全失效。
- **白名单拒绝必须回告，不能静默丢弃**——c2c 恒回告（带被拒者自己的 OpenID + 配置路径），群仅在被 @ / 引用 bot 时回告（群提示是公开广播）。**`disabled` 是管理员显式拉下的总闸，此时保持静默**。@/引用判定必须与 mentionGate 同源（`isQuoteOfBotMessage` 共用）。发送锚点取自 `ctx.replyTarget.msgId`（被拒消息自身，SDK 直发不占配额记账）——**保持 SDK 直发、不改走网关**（历史上池化时代网关会挑到更早的缓存锚点；池化已移除，但直发语义依旧正确）。
- **单题作答不得被防抖合并污染**——单题卡发出后登记单问题 pending（**仅 c2c**），c2c 防抖与 secret-capture 在 pending 期间放行该会话文本；pending 清理：按钮 resolve 成功 / 卡片发送失败 / 该会话下一条入站消息 / TTL 兜底。

### 问答（ask_user）

- **多问题 ask_user 的红线是「禁止代替用户作答」，不是「禁止程序化提交」**（2026-11-11 再界定，issue #99 / PR #100）——**答案值必须来自用户的真实输入**（按钮点选 / 手打文本），插件只负责**搬运与组合**；**禁止合成入站消息**（合成消息会被框架 steer 进 ask_user-suspended run，2026-08-24 事故）。提交通道 = 框架官方 `claimPendingAgentQuestionAnswer({ sessionKey, text })`（`openclaw/plugin-sdk/agent-harness-runtime`）——它与框架自己的入站认领走**同一套解析与校验**（`buildAgentHarnessUserInputAnswers` / `validateAnswers`）⇒ 插件组合的文本与用户手打的文本在框架侧等价。
- **多题问答进行中（c2c、多题 pending 武装期间）的入站文本一律本地暂存为当前题答案、不转发框架**——平台无法区分「用户手打的普通消息」与「指令按钮代发的回调内容」；中间态文本转发给框架只会撞上 `validateAnswers` 的 partial 拒收 + 重问循环（白烧一轮、两侧状态分裂），且靠中间态词汇猜意图必然失效。**边界**：仅多题 pending 武装期间 + 仅 c2c + 仅 `sequential` 形态；单题 pending / 无 pending 时文本照旧原样转发框架；斜杠命令（`/` 开头）照旧放行（逃生通道）。**分类只认形态**（整单 / 形态错误 / 本题答案），**不靠内容语义猜**。
- **多题必须「整单提交」——「点一题解一题」在框架层不成立**——框架 `validateAnswers` 逐题要求非空（ask_user 归一化从不设 `allowEmpty`）⇒ 任何一次提交都要带齐全部题。**红线**：禁止代替用户作答、禁止合成入站消息 ⇒ 提交只能走框架官方认领通道，值全部来自用户真实作答。**空值行必须插件先拦下**（框架的 keyed 正则要求值至少一个字符，空值行会被行序兜底捡成字面量 `"N:"` **静默收下**）。
- **多题 c2c 走顺序发题，全部答齐即提交**——只发第 1 题，答完才发下一题；**末题选项是回调型（type=1，与中间题同构）**，点选只记答案；**全部答齐后由插件组合整单文本并直提**（`question-submit.ts`）⇒ 用户聊天里**不再出现** `1: 1\n2: …` 的机器气泡，确认卡与「✅ 提交」按钮一并消失。中间题只有选项按钮（不挂预填按钮——框架要求整单齐备）；**末题的预填按钮恒存在**（指令型 `enter=false`，把「全部已答 + 本题空位」填进输入框但**不自动发送**，用户改完手动发送 → 命中拦截层的「整单形态」⇒ 覆盖全部答案 ⇒ 提交）：题面带 `Other:` 行显示「✍️ 其他」、否则显示「📝 填写模板」；卡片正文**必须**写清「想自己写答案怎么办」，且**按按钮实际标签写**（不得指引不存在的按钮）。**群聊路径保持旧形态**（全部题卡 + 确认卡 + 客户端代发）——**两套机制并存，别全局替换**。
- **多题文本拦截层的三形态（`planSequentialTextCapture`）**——**整单**（行数=题数、题号 1..N、每行 `N: 值`，分隔符同框架认 `:`/`=`/`-`）⇒ 覆盖全部答案 ⇒ 答齐即提交；**形态错误**（含题号行但不合整单）⇒ 回执格式错误 + **保持武装**；**本题答案**（不含题号行）⇒ 记当前题 ⇒ 末题则提交、否则续卡。三种都**不转发框架**。**pending 终态后不得再拦截**（文本照旧转发框架）；**提交进行中（resolving）不得放行**（消费文本 + 回执「正在提交，请稍候」——既不能当答案收，也绝不转发框架）；**末题点选在 pending 终态后静默忽略**（平台会重推 interaction 事件，回执会刷屏）。**带附件的消息不捕获**（捕获会让附件凭空消失——附件价值高于「把它当答案」）；**斜杠命令 / 纯附件照旧放行**。
- **提交失败的语义（pending 保持武装）**——`claimPendingAgentQuestionAnswer` 抛 INVALID_REQUEST ⇒ 答案非法（回执「答案格式不对」）；抛其它异常 ⇒ 传输/运行时失败（回执「提交失败」）；**20s 超时**（认领挂死 ⇒ 锁必须释放，否则该会话既进不了拦截层也重试不了 ⇒ 问卷卡死）⇒ 回执「提交失败」；子路径不可用 ⇒ `unsupported`（回执「提交失败」）。前四种都**保持 pending 武装** ⇒ 用户可再次点选或重新打字重试；`claim` 返回 false ⇒ 框架侧无挂起记录/已终态 ⇒ pending 终态 + 回执「该问题已提交、已过期或已由框架处理」。**SDK 子路径被删 = 插件整体加载失败**（`tests/sdk-surface.test.ts` 的 `mustCover` 已锁 `agent-harness-runtime`）。**日志里不得出现完整 sessionKey**（见根 [`AGENTS.md`](../../AGENTS.md) § Security）。
- **多题 pending 的归属与生命周期（红线）**——**归属校验**：按钮回调只按 `questionId` 找 pending 会让**转发出去的卡片被点击者作答**（别人的点选记进原用户答案、甚至把原用户的问题 resolve 掉）⇒ 记录/提交前必须核对 **账号 + scope + 对端** 三者与 pending 一致（`handleMultiQuestionTap`）。**旧单退役**：同一会话注册新一单时**上一单必须退役**——提交通道只带 `sessionKey`（框架按 session 查挂起记录）不带 questionId ⇒ 旧卡片若仍可用，点它会用旧答案 resolve **新**问题。**questionId 复用**：同一 id 被注册到别的会话时，旧会话的映射必须清掉 + 查询时校验条目归属（否则答案串会话）。**用户没看到卡片时**（turn 在登记 pending 后、发首卡前被取消 / 首卡发送失败）**必须退役 pending**，否则他后续的普通消息会被当成「没见过的那个问题」的答案。
- **提交进行中（resolving）的窗口——两处查表都必须是「含 resolving」的**——`findPendingMultiQuestionByConversation` 排除 resolving ⇒ ① secret-capture 的「多题让行红线」失效 ⇒ 用户的普通消息被写进密钥库；② **拦截层失效 ⇒ 文本泄漏回框架**（框架侧挂起记录还在，会拿这条文本去认领 ⇒ `validateAnswers` partial 拒收 + 重问循环——正是本机制要消灭的场景）。⇒ 两处都必须改用**含 resolving** 的查表（`hasPendingMultiQuestionForConversation` / `findMultiQuestionEntryByConversation`）。**拦截层命中 resolving 时的动作**：这一单正在提交（答案已定稿）⇒ 既不能当答案收、也**绝不转发框架** ⇒ **消费该文本 + 回执「正在提交，请稍候」**（用户稍后重发即可；窗口最长 20s = 认领超时上限）。**按钮点选同口径**：`recordSequentialAnswer` / `recordSequentialTextAnswer` 在 resolving 时返回 `resolving`（不记答案、不推进 cursor）⇒ 回执「正在提交，请稍候」，不得静默吞掉。
- **ask_user 卡片由插件自渲染（单题 / 多题同构）**——渲染层在 `question-card.ts`：正文走插件自己的中文版式（去掉框架 3 行英文脚手架），按钮统一 `① ②` 前缀 + 截断。**单题文本反解失败 ⇒ 回退到「框架原文 + 旧键盘」**（不得产出半解析的卡片）。单题自由作答靠正文引导，**不加**「✍️ 其他」按钮（预填前缀会污染答案）。

### 配额与其它

- **`msgid-cache.ts` 不是锚点池**——它只登记「接收时刻」，供诚实重建窗口与死锚点簿记。**禁止重新引入「从缓存挑 msg_id」的池化选取**。
- **`quota-manager.ts` 的观测计数只升不降**——判死时不得回截 count（证据保全）。
- **`secret-store-cli.ts` 的 kind 恒为 `env`**——`secret` 存储会让 AI 读不到（2026-08-30 用户反馈）。
- **`approval-capability.ts` 的日志一律 `shortId()`**——审批路径曾把点击者 openid 原样落盘（PR #102 修）。
- **`access-notice.ts` 只在 allowlist 拒绝分支回话**——`dmPolicy/groupPolicy: "disabled"` 是管理员显式拉下的总闸，此时保持静默。
- **`command-panel.ts` 有平台硬限**——面板项 name ≤14 字符、desc ≤30 字符、每面板 ≤20 项、每 bot ≤20 个面板；`POST /v2/panels` 限 10 QPM。
