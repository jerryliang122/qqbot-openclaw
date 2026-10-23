# 更新日志 (Changelog)

本项目（GitHub 仓库 `jerryliang122/qqbot-openclaw`，npm 包 `@jerryliang122/openclaw-qqbot`）自 **v1.0.0** 起按自己的发版机制独立发版，版本号与上游旧版本（`tencent-connect/openclaw-qqbot` 2.x）**完全脱钩**：1.0.0 是本仓库独立维护后的第一个正式版本，其内容 = 上游 2.1.0 基础上的大量功能重构 + v1.0.0 的全面兼容性清理。

- 发版流程：推送 `v*` tag → GitHub Actions 自动校验版本一致性、跑全量检查、构建产物 → **自动发布 npm**（`@jerryliang122/openclaw-qqbot`，OIDC Trusted Publishing 免 token）→ 创建 GitHub Release 并附 `npm pack` 产物
- 版本规则：语义化版本（SemVer）。Major 位变更意味着存在 Breaking Change（配置格式 / 运行要求 / 公开 API）
- 运行要求：**OpenClaw >= 2026.10.5**（peer 依赖硬性要求，见 package.json）

---

## [Unreleased]

### 变更

- **群消息合并改为插件侧实现：agent 忙时到达的群消息攒成一批，turn 结束后一次性发给框架（可跨发言人合并）**。此前群消息合并完全交给框架 followup 队列的 `collect` 模式，但**框架的 collect 合批对「同群不同发言人」无效**——它的分组键含 `execution.senderId`（core 的 `resolveFollowupAuthorizationKey` → `resolveFollowupDeliveryStorageKey` → `prepareNextDeliveryGroup`），且该函数**遇到第一个 key 不同就 break** ⇒ 只有「连续同 key」的消息才成一批。群里几个人同时问、bot 忙完一次性回（群聊最常见的诉求）因此永远做不到：每条消息各自成轮、各自回一次。
  - **忙碌信号由插件自建**：框架没有向通道插件暴露「某会话是否正在工作」的查询 API（SDK 导出面已逐一核对），但插件自己知道——`dispatchToOpenClaw` 里 `await adapters.inboundRun!(...)` 覆盖整个 turn（提交到结束才 resolve；typing 中间件与 c2c 防抖都依赖这一点）。新增 `src/features/group-session-busy.ts` 维护 per-群 in-flight 计数，`finally` 归零（ingest 丢弃 / dispatch 抛错 / adapters 缺失都不会让批次被永久压住）。
  - **合批原语用框架现成的**：复用 `openclaw/plugin-sdk/channel-inbound` 的 `createInboundDebouncer`（与 c2c 防抖同款）——`shouldHoldFlush` 在静默期到点后再检查、true 则继续压住并重排定时器（**无限期持有**），`flushKey` 是**显式冲刷、绕过 hold 检查**。turn 结束（计数归零）→ 显式冲刷 ⇒ 攒下的消息一次性发出。批次键**按群**（不是按人）⇒ 同群不同发言人可同批。
  - **合并内容逐条归属 + 单份历史**：新增 `assembleMergedGroupBody`（`src/dispatch/body-assembler.ts`）。不能直接拼 N 条现成 agentBody——`buildAgentBody` 在「群被@且有历史」时给**每条**各加一份 `[Chat history begins]…`，拼起来历史会重复 N 份；改为整批共享**最新成员**的历史快照 + 每条一段 `[消息 i/N]` 与各条自带的 `[sender (openid)]` 前缀。合批允许混入不同发言人，模型必须能分清每条是谁说的。
  - **批内 turn 语义**：只要批内有一条是「在叫 bot」（@ / 引用 bot / 称呼唤醒），整批按 `user_request` 投递（载体消息的 mention 标志置位，让 dispatch 走同一条分类路径）；全是被动消息则按 `room_event`。否则「用户 @ 了 bot 却没回音」。
  - **旁路不合并**（立即直发，框架 debouncer 保证先冲刷同 key 的 pending buffer 再执行，顺序保持）：控制命令（stop/esc/abort/exit）、斜杠命令（合并会破坏 `buildCtxPayload` 的命令标记）、多问题 `ask_user` 的 keyed 答案文本（合并会改写答案导致认领失败）、含语音的 turn（对齐框架 `requiresIndividualCollectDrain` 的 `currentInboundAudio` 约束）。
  - **容量与丢弃**：默认最多 10 条（`maxBatchSize`）。超出时**丢弃较早的消息**（保留最新 10 条），并在合并正文前置一行 `[已丢弃 N 条较早的群消息（批次上限 10）]`——与框架 `[Queue overflow] Dropped N messages due to cap.` 同样式，避免模型静默缺内容；丢弃时打 INFO 留痕。
  - **空闲零延迟**：群空闲时消息立即直发（不缓冲、不等待窗口），与合批前的行为一致。
  - **安全阀（对「直到 turn 结束才一次性全发」的显式偏离）**：框架 debouncer 的 `maxWaitMs` 兜底——持有超过 `maxHoldMs`（默认 5 分钟）后强制冲刷。turn 永久挂起时批次会滞留内存且随进程重启丢失。`maxHoldMs: 0` = 永不强制（只在 turn 结束时发）。
  - **配置面**：`channels.qqbot.groupCoalesce` / `groups.<id>.coalesce`（账号段同形）扩展 `strategy`（`'plugin'` 默认 / `'framework'` 回退到框架队列）、`maxBatchSize`、`maxHoldMs`；manifest schema 同步（`additionalProperties: false` 下少一个字段 = 用户配了被拒）。
  - **守卫**：新增 `tests/group-merge.test.ts`（18 例）——忙碌信号计数与归零回调、配置回落链、合批装配（逐条归属 + 单份历史 + 丢弃说明）、集成（空闲直发 / 跨发言人合批 / 容量丢弃 / 旁路保序 / 跨群隔离 / 前缀归位 / 失败不丢批 / 退出冲刷）；`tests/group-c2c-differential.test.ts` 中「插件内建 coalescer 已删除」的断言改为「插件侧合批存在且 strategy 双档可切换」；`tests/manifest-config-schema.test.ts` 补 `groups.<id>.coalesce` 嵌套块的逐字段守卫。

### 修复

- **群消息正文头部不再出现 `#ROBOT1.0_<id>! ` 前缀（消息 id 与正文本是分开的，混进正文的是框架而非平台）**。现场：Web UI 上群消息气泡正文形如 `#ROBOT1.0_chM80PvMt-…! 土豆马铃薯: 大肥鱼`——消息 id 被打头拼进正文。
  - **根因不在插件、也不在 QQ 平台**：官方《群消息（全量模式）》的事件体里，消息 id 是独立的 `id` 字段（被动回复锚点 `msg_id` 同形），`content` 字段的定义**不含**任何 id 前缀；QQ SDK 原样透传 `ev.content`，插件与框架都没有注入过这个前缀。真正的注入点是 **openclaw 框架的 `formatRoomEventLine`**（core：`prefix = [messageId ? \`#${messageId}\` : undefined, sender].join(" ")` → `` `${prefix}: ${body}` ``）——它把 room_event 的 transcript 正文渲染成「id + 发送者 + 正文」一行。
  - **修复方向是改写格式而非剥离入站正文**（入站 content 里本来就没有它，剥是剥错地方）：插件经 ctxPayload 的 `extra` 传入 `AmbientTranscriptBody` / `AmbientTranscriptMessageId` / `AmbientTranscriptTimestampMs`（框架 `buildChannelInboundEventContextValue` 末尾的 `...params.extra` 会展开进 ctx；core 的 `resolveRoomEventTranscriptBody` 优先取 `ctx.AmbientTranscriptBody`）⇒ room_event 的 transcript 行改用插件自定义正文（`[sender (openid)] 正文`，合批时是合并正文），**不再含 id**；消息 id 仍由 `AmbientTranscriptMessageId` 保留可追溯。
  - **未改动 ambient watermark 机制**：框架的 ambient transcript watermark 是 telegram 专属路径（`bot-message` 里 `resolveAmbientTranscriptWatermarkKey({channel: "telegram", …})` 硬编码），generic channel 路径不设这些字段 ⇒ 插件侧同样**不设** `AmbientTranscriptWatermarkKey`（设了会把一条 telegram 口径的去重路径激活到 qqbot 上，副作用未知），保持现状不变。

- **合批正文里批次自身的消息不再被说两遍（群侧 + c2c 侧，评审发现）**。SDK 的 `historyBuffer` 暴露的 `ctx.state.history` 是「**不含当前消息、但含此前所有消息**」的快照 ⇒ 批次内**非最后一条**成员会同时出现在历史块与自己的分节里（消息被说两遍），且历史块重复 N 份。
  - **群侧**：合并正文的历史改为取**批前基线**（最早成员的快照，恰好是「批次开始之前」的群历史），而非最新成员的快照。
  - **c2c 侧（既有缺陷，本次一并修）**：`mergeAssembledBodies` 只保留第 1 条的那份历史块，其余的剥掉（`[Current message]` 标记保留）。
  - 触发面：非 room_event 群（默认 `unmentionedInbound: user_request`）在忙时攒批即命中——是默认路径，不是边角。

- **群 turn 的「正在工作」计数不再泄漏（评审发现，中危）**。busy 标记早前放在 `dispatchToOpenClaw` 入口、与归零的 `finally` 隔着数百行同步代码——其中任一处同步抛错都会让异常直接传播出该函数、`finally` 根本不执行 ⇒ 该群 busy **永久为 1** ⇒ 之后所有群消息全部进批、只能靠 `maxHoldMs` 兜底放出（系统性延迟 5 分钟，且只有一行 dispatch error 日志可循）。现将标记挪到 `try` 之前（与 `finally` 紧贴）：该处到 `try` 之间全是同步代码（无顶层 await），单线程下不会有别的入站消息在此窗口被处理 ⇒ 行为等价且泄漏窗口消失。

- **合批正文字数上限落地（评审发现：原为死常量）**。`GROUP_MERGE_MAX_BODY_CHARS`（8000）此前只声明未接线，注释承诺的「防上下文膨胀」是空的。一批 10 条各接近 QQ 单条 5000 字上限时，agentBody 可膨胀到数万字。现按**条数 + 正文字数**双上限裁剪（保留最新、丢弃较早并留说明）；单条超限仍保留（不因超限而整批丢弃）。

- **合批载体不再被虚标 `(@you)`（评审发现）**。此前「批内有人叫 bot ⇒ 整批按 user_request」的置位发生在**装配之前**，装配器读到的载体 mention 已被污染 ⇒ 载体（最后一条）被挂上 `(@you)`，而实际叫 bot 的是批内更早的成员（对模型是归因误导）。现改为**装配后再置位**：正文已定，置位只影响 dispatch 侧的入站分类。

- **「@bot /cmd」这类消息的命令语义在合批中不丢（评审发现）**。旁路判定原先只看**原始** content 的首字符，而单条路径的 agentBody 直通用的是**清洗后**的 userContent（`body-assembler` 的 `buildAgentBody`）⇒ 原文以 `@` 开头、清洗后以 `/` 开头的成员会被当成普通文本埋进 `[消息 i/N]`。现旁路同时看原始与清洗后两份文本。

### 已知限制

- **busy 信号在被框架「排队」的 turn 上失真（评审发现）**。框架在同 session 已有活动 turn 时会把新 turn **defer**（core `agent-runner-run-*.mjs` 的 `activeRunQueueAction === "enqueue-followup"` 分支：`enqueueFollowupRun` + `scheduleFollowupDrain` 后直接 return，turn 的实际执行由 drain 调度器**脱离该 promise 链**）⇒ `await inboundRun` 在**仅入队**时就 resolve，busy 提前归零。影响面：旁路项（控制命令 / 斜杠命令 / keyed 答案 / 语音）在忙时直发却被框架排队时，其 promise 提前 resolve → 那一小段窗口内到达的群消息**不会**被插件合批。⇒ 这是**行为退化而非正确性破坏**（消息仍全部送达、顺序不变，由框架队列保证），只是没被合成一轮。要根治需框架暴露 drain 完成的观测信号，当前 openclaw 未提供（成本另议）。已在源码注释与 README 中明示，并有回归用例固化该退化。

---


### 修复

- **stream 模式：同一轮拆出的多条消息不再内容重叠——第一条不再是缝合残段（issue #67，根因修复）**。现场（bot2，C2C，2026-10-22 18:24 / 18:29）：同一轮回复在 QQ 端收到**两条**消息——第一条是两次尝试被「截断拼接」缝合出来的残段，第二条才是完整内容；两条消息的**收尾帧与开流帧只隔 343ms / 386ms**（用户观感 =「同一条回复被重发了一遍」，且第一条是第二条的一部分）。**修复后仍是两条消息**（每段一条，中间文本保持分开投递），但第一条是**完整的一段原文**、与第二条互不重叠。
  - **根因**：stream 模式的控制器**没有「段」概念**，用**文本长度**猜「是不是新回复」，并把「前缀不匹配的新文本」截断后拼到已发文本后面（`prefix retry` 支）。同一轮内的第二次模型调用（工具调用续写 / provider 断流后 core 的 visible-answer fallback 重试 / 其他内部重试）的文本**必然与前段无公共前缀** ⇒ 先命中拼接支产出缝合体，再因「缝合体比新块长」命中 `new reply` 支 ⇒ `complete()` 旧流 + `openStream()` 新流 ⇒ 两条消息。当日频次：`prefix retry` 51 次、`new reply` 110 次，而 provider 断流仅 4 次 ⇒ **主因是「同轮第二次模型调用」，provider 断流只是其中一类**。
  - **修复后的契约**：**一段（= 一条 assistant 消息）= 一条 QQ 流式消息**，各段内容**原样送达、互不重叠**（对齐 telegram 的「每个 assistant 消息一条气泡」；中间文本各自独立，**不合并成一条**）。段边界改由框架 `onAssistantMessageStart`（`beginSegment()`）+ 工具调用（`closeSegment('tool_call')`）驱动，**长度启发式两个分支整体删除**（旧的长度判定对「新段比旧段长」完全失效——那种情况会走拼接支）。
  - **跨段截断拼接废除**：旧实现把「前缀不匹配的新文本」截断后拼到已发文本后面，产出两次尝试缝合的「草稿」（用户看到的第一条消息是第二条的一部分）。平台硬约束是 QQ 流式 replace 模式「已下发前缀不可变更」（否则 40007），新段因此必须**原样另起一条消息**，不得拼接。
  - **顺带修掉「工具调用后整段正文静默丢失」**：stream 模式此前在 `deliver(kind:'tool')` 时 `finalize()`，把「段结束」变成了「整轮结束」，工具返回后的正文既不进缓冲又算不出差量 → 整段消失。现在工具调用只**封口当前段**（收尾这条消息），工具后的正文另起一条完整送达。
  - **终稿必达**：终稿与已流出内容无关且**本段从未流出**时，整段补发（普通消息），不再静默丢弃；同段内模型改写尾段的「不重复补发」语义保留（流内内容即答案，补发会造成重复）。
  - **守卫**：新增 `tests/streaming-segment-model.test.ts`（12 例）——把 issue #67 的两个现场（现场 A 同轮第二次模型调用 / 现场 B provider 断流重试）等比构造为回归用例，断言「每段各自一条消息 + 内容原样送达 + 无跨段截断缝合体 + 工具后正文不丢」；另补 dispatch 级端到端用例。`tests/streaming-controller.test.ts` / `tests/stream-usage-footer.test.ts` 中固化旧（错误）语义的断言同步更新为新契约；**其余既有语义（含 static 模式、usage footer 补发）保持不变**。

## [3.0.0] - 2026-10-22

### 变更（Breaking：运行要求）

- **OpenClaw 最低版本抬至 `2026.10.5`**（peer `>=2026.10.5`，devDependency 精确钉版 `2026.10.5`；此前基线 2026.9.1）。触发信号：上游 10.x 系列语义代差（10.2 删除 9 个 plugin-sdk 子路径、10.5 重构投递/会话语义）使「同时支持 9.x 与 10.x」的兼容成本超过收益，且主要部署环境已切 10.x。按 SemVer 规则这属运行要求变更（发版时建议升 major）。换版后 typecheck / lint:runtime / build / sdk-surface 守卫（38 用例）/ dispatch 系与 c2c 防抖系单测全绿。

### 修复

- **兜底路由 sessionKey 改用 canonical 文法（10.x 硬门槛，实测复现）**。openclaw 2026.10.x 的 state worker 对 session 写入做 canonical 校验：key 必须满足 `agent:<agentId>:<rest>` 文法且等于其全小写折叠形，否则抛 `SessionCanonicalKeyMigrationRequiredError`、该会话一切读写瘫痪。插件旧兜底（runtime 缺 `channel.routing.resolveAgentRoute` 时的安全网）拼的是 `qqbot:<account>:...` 形状——在 10.x 下等于把「路由 API 缺失」从可见错误放大成全量静默瘫痪。现改为 `buildFallbackRouteSessionKey()`（`agent:<agentId>:<channel>[:<accountId>]:<peerKind>:<peerId>` 文法 + 全小写），并由 `tests/fallback-route-key.test.ts` 用**已安装 openclaw 的真实解析/折叠函数**（`parseAgentSessionKey` / `normalizeStoreSessionKey`）锁定——不靠形状猜测。

- **兜底 sessionKey 同时满足框架的 route 文法（评审修复）**。canonical 校验只保证「key 能被写进 state DB」，**不保证「框架能反解出投递目标」**：框架反解用的是 `parseSessionDeliveryRoute`，文法为 `<channel>[:<accountId>]:<peerKind>:<peerId>`，peer 段之后的冒号分段都会被并进 peerId。上一版兜底 `agent:main:qqbot:group:<acct>:<peer>:coalescing` 过了 canonical 校验，却被解析成 peerId = `<acct>:<peer>:coalescing`（accountId 与历史遗留 `:coalescing` 后缀一起混进 peer 段）→ 框架自发回复 / 投递恢复 / 子代理路由全部指向不存在的 peer；私聊兜底同理（peerId = `<acct>:<peer>`），且与框架默认 `dmScope="main"`（全体 c2c 共享 `agent:main:main`）的会话粒度也不一致。现改为：**优先用框架原语 `runtime.channel.routing.buildAgentSessionKey`**（与 `resolveAgentRoute` 同源，文法永远跟随上游），框架原语缺失时才退到本地等价镜像；群 key 不含 accountId（框架自身即不按账号隔离群会话），作用域（dmScope / groupScope）取自 `cfg.session`，与主路径同形。兜底 route 的 `agentId` 同步为框架默认 `'main'`——此前 key 的 agent 段是 `main`、turn 却按 `'default'` 走，两边不自洽。

- **兜底 sessionKey 守卫升级为三层差分（评审修复）**。`tests/fallback-route-key.test.ts` 此前只断言 canonical 两条规则——那个「过了校验却解不出 peer」的 key 同样能过，守卫形同虚设。现补三层：① **差分**——本地镜像与框架 `buildAgentPeerSessionKey` 在 dmScope × groupScope 全矩阵上逐字相同（上游改文法即变红）；② canonical（用 state worker 同款的 `normalizeStoreSessionKey` + `parseAgentSessionKey`）；③ route（`parseSessionDeliveryRoute` 解出的 peerId 就是目标 peer，不含 accountId 污染）。断言全部走**已安装 openclaw 的真实函数**（子进程加载 dist 内部模块，按具名导出探测，不硬编码带哈希的文件名）。

- **旧的 `tests/session-key-fallback.test.ts` 改为断言真实代码（评审修复）**。该文件此前自带一份「影子实现」（`qqbot:${accountId}:${peerId}`）却宣称「导入真实代码而不是重新实现」——生产兜底形状改过两轮后，它断言的形状在代码库里已不存在，且永远绿。现改为直接 import `resolveDispatchPeerId` / `buildFallbackRouteSessionKey`，保留原回归意图（群聊用 groupId 而非 senderId、同群同 key、群聊缺 groupId 降级 senderId），并按框架 dmScope 语义补齐私聊分流断言。

- **`text-grapheme` 纳入 SDK 守卫（评审修复）**。该子路径此前登记在 `tests/sdk-surface.test.ts` 的 `EXEMPT_SUBPATHS` 里（理由「9.1 基线不存在」），地板抬至 10.5 后前提消失——现纳入正常守卫：子路径被删即变红。因它是字面量 require（扫描器看不到属性访问），另补一条名级断言兜住 `findGraphemeChunkEnd`；`src/outbound/grapheme.ts` 的能力探测 + 本地等价回退保留（守住「加载期不炸」这条底线）。

### 调查结论（不改行为的实证记录）

- **openclaw 2026.10.5 的命令层与本插件 dispatch 契约完全兼容**（harness 驱动真实 10.5 dist 实测）：空闲会话 `/status` 正常解释并经 `dispatcherOptions.deliver`（返回 void 的旧契约形状）送达；忙碌会话 `/stop` 走 dispatch 层 fast-abort（`tryFastAbortFromMessage`，先于 admission ticket）约 4 秒中止活动 turn 并回复 `⚙️ Agent was aborted.`。生产上若复现「/stop 停不掉、/status 无回复」，应优先排查部署侧（已装插件版本、网关日志、`commands.ownerAllowFrom`/`commands.allowFrom` 授权名单），而非框架兼容性。
- **10.5 忙碌会话语义变化**：admission ticket 现在发生在 replyResolver 之前（实测 `wait_admission_ticket` 9.9s）——活动 turn 期间到达的非 abort 类指令会排队等待，turn 结束后才解释执行（这是预期行为，不是丢消息）。
- **9.1 与 10.5 对 qqbot 的 `resolveAgentRoute` 输出完全一致**（c2c → `agent:main:main`，群 → `agent:main:qqbot:group:<id>`）：升级不改变会话 key 形状、不产生遗留行迁移需求。另实测确认框架 `dmScope` 默认 `"main"`（两版相同）：所有 c2c 用户共享 `agent:main:main` 一个会话（与 CLI 主会话同 key），需要按用户隔离请配 `session.dmScope: "per-peer"`。

## [2.8.1] - 2026-10-22

### 变更

- **移除 `streaming.sendMode: "stream-all"` 双道流式模式（v2.8.0 引入，回退）**。QQ 平台对单个 `stream_msg_id` 的续写窗口实测约 **10 分钟（600s）**：stream-all 的滚动道把整个 turn（多工具 + 终稿）汇入同一条流式消息，工具链一长必然超窗——超窗后**续写与收尾帧一并被平台 400 拒收**（「同一流式消息发送超过时间限制」，错误码未在官方文档登记），且控制器的静态兜底条件 `sentChunkCount === 0` 在已发出若干片后不成立，**整轮正文从头到尾未送达用户**（表现为「机器人没回复」，日志无明显错误信号）。平台约束与该模式的根本设计冲突，无平台侧规避手段，故整体移除（详见 [jerryliang122/openclaw-qqbot#11](https://github.com/jerryliang122/openclaw-qqbot/issues/11)）。
  - **配置迁移（Breaking）**：已配置 `"sendMode": "stream-all"` 的用户升级后该值会被配置校验直接拒绝（schema enum 已同步移除）——请改回 `"stream"`（流式打印机）或 `"static"`（整条发送）。
  - 移除范围：`sendMode` 联合类型与 manifest schema 两处 enum（顶层 + `accounts` 段）、`StreamingController` 的滚动道/终稿道实现（held 块轮转、`onTextBlock` / `onToolItem` / `handleFinalDeliver`、终稿道失败兜底）、dispatch 的 stream-all 拦截段与 `disableBlockStreaming:false` / `forceToolResultProgress` / `suppressDefaultToolProgressMessages` / `onItemEvent` 旗标组合、`tests/stream-all.test.ts`（19 例）、README 的 stream-all 章节。
  - **保留**：v2.8.0 同批合入的 manifest 配置 schema（其余 30+ 字段）、schema 守卫测试（`tests/manifest-config-schema.test.ts` 的枚举值级对照**动态读取 TS 联合类型**，自动随本次收窄，无需改动）、「改配置面必须同步 manifest schema」的纪律条目（事故教训仍成立）。`stream` / `static` 两种下发模式不受影响。
  - 后续：QQ 流式会话的 10 分钟窗口对长 turn 的 `stream` 模式同样存在理论风险（issue #11 的期望 2「接近临界时主动重开 stream_msg_id」），待平台侧或后续版本单独处理。

## [2.8.0] - 2026-10-22

### 修复

- **`groups.<id>` schema 漏 `tools` / `roomEventRequireMessageTool`——room_event 的核心配置面被自己的 schema 拒掉（2026-10-21 三 PR 合并审查发现）**。#57 给 `GroupConfig` 新增了 `tools`（群级工具白名单）与 `roomEventRequireMessageTool`（是否强制 message 工具可用），但 #59 的 manifest schema 在 `groups` 段（顶层与 `accounts.<id>.groups` 两处）只列了 9 个旧字段且 `additionalProperties: false`——用户照插件 room_event 降级 WARN 的第一条修法（`channels.qqbot.groups.<id>.tools.allow` 加 `message`）去配，会被 `validatePluginSchemaValue` 直接拒掉（与 Control UI 保存配置同一条校验路径），实测报 `must not have additional properties: "tools"`。修复：两处 groups 各补齐这两个字段（`tools` 为 `allow`/`alsoAllow`/`deny` 三数组，与 `GroupToolPolicy` 一致）；测试侧补上逃逸的根源——「嵌套子字段逐项对照 TS 接口」清单原本不含 `GroupConfig`（groups 的字段藏在 `additionalProperties.properties` 一层），现新增 3 例对照 + 1 例**真实校验器**回归锚点（正向：room_event 群的 tools 配置可过；反向：groups 条目内未知键仍被拒）。
- **`capabilities.inlineButtons` 是无消费方的死配置面——从 schema 移除**。schema 声明该键（`off`/`dm`/`group`/`all`/`allowlist`，「与 Telegram 同款语义」），但插件 src 无任何读取（`messageToolCapabilities` 静态返回 `['inlineButtons']`），框架里该 scope 解析只走 Telegram 账号路径（`resolveTelegramInlineButtonsScope*`）——用户设 `off` 期待关按钮，按钮照发、系统提示照旧宣称可用。这正是 #59 自己要修的「配了被静默忽略」问题，方向相反：schema 声明了没人读。若未来实现按钮作用域开关，应连 `renderPresentation` 的 scope 过滤与 `messageToolCapabilities` 的动态化一起做，届时再恢复该键。
- **`truncateUtf8` 的代理对保护是死代码（两个分支相同）**。`src/outbound/presentation-buttons.ts` 的截断函数里低代理分支写的是 `end -= 1`（与普通分支相同，「避免切碎代理对」的检查完全失效）：完整 emoji 对占 4 字节、孤儿高代理编码成 U+FFFD 占 3 字节，当 URL/指令 data 总字节数恰为上限 +1 且末尾是完整 emoji 时，返回以孤儿高代理结尾的截断串（尾部损坏）。修复为 `end -= 2`（连同其高代理整对移除），并补 2 例边界用例（已验证新用例在修复前能精准抓到旧 bug）。
- **`renderPresentation` 在 fallback 模式下回填被框架剥离的正文（防御层）**。框架在 `presentationTextMode === "fallback"` 且 presentation 含交互块时，会把 `payload.text` 置空后再调通道的 `renderPresentation`（期待通道自行合成文本——Telegram 参照实现即 `currentText || fallbackText`），本插件此前直接透传。经逐流核实当前 9.1 **没有**能触发的路径（ask_user 被 dispatch 的 deliverHandler 拦截、`/status` 纯数据块走框架早退分支保留文本、审批走插件原生 runtime），但一旦未来某条流把 fallback 模式的交互 presentation 送进通道适配器，就会发出「空文本 + 裸按钮」或被框架按 `no_visible_payload` 吞掉。新增 `backfillQQBotPresentationFallbackText`：fallback 模式且 text 为空时用 `renderMessagePresentationFallbackText` 从（已按 QQ 能力适配过的）presentation 回填正文，另补 3 例单元测试。
- **`hasRoster` 判定与框架 `hasAgentRosterProperty` 语义分歧（空 entries 对象）**。`src/features/room-event.ts` 此前要求 `agents.entries` **非空**才算有 roster；框架按「属性存在且值非 undefined」判定（空对象 `{}` 也算）。`agents: { entries: {}, defaults: { tools: { allow: [非 message] } } }` 形态下框架不应用 `agents.defaults.tools`，插件却会应用 → room_event 的 message 工具守卫得出与框架相反的结论、误降级。对齐为属性存在语义，补 2 例用例（空 entries 不应用 defaults / 完全无 roster 时 defaults 照常生效）。
- **私聊（C2C）能力声明与平台真实语义对齐**：模型在 QQ 上生成的按钮此前**落地不了**。
  `src/agent-prompt-adapter.ts` 无条件向模型声明 `inlineButtons`，框架据此在 system prompt 里告知「可以用按钮」；但插件侧**没有**提供框架的 `presentationCapabilities` / `renderPresentation` 钩子（该契约由框架在 `deliver-prepare` 装配，Telegram 是全框架唯一提供方），模型的按钮块在出站时被通用降级路径（`materializeMessagePresentationFallback`）压成**纯文本列表**——用户看到的是「- 选项A」而不是可点的按钮。这正是「声明了但落地不了」的错配。
  修复按**官方文档**落地（此前「QQ 内联按钮需平台审核、只能配模板消息」的判断有误）：`keyboard` 是发送接口的**一等字段**，与 `markdown` / `content` 平级，`keyboard.content.rows[].buttons[]` 可直接自定义。新增 `src/outbound/presentation-buttons.ts` 把框架的可移植 presentation 映射为 QQ 原生 keyboard，映射范围**刻意收窄**：
  - `url` → `action.type=0`（跳转链接）｜`command` → `action.type=2`（指令型，客户端自动填入 `@bot` + 指令）｜`approval` → `action.type=1`（复用既有 `approve:v2:` 解析）｜`question` → `action.type=1`（复用既有 `qqbot:q:` 解析，经 payload 的 `channelData.askUser` 把选项文本换回索引）
  - `callback` / `web-app` / `model-picker` → **丢弃控件、保留文本**（QQ 无按钮点击回流通道、无 web app、无模型选择器；发一个点了没人处理的事件比不发更糟）
  出站侧新增 `sendPayload`（框架对含 `channelData` 的 payload 走该路径）与网关的 keyboard 下发 + **平台拒收时降级为不带键盘重发**（正文绝不能因按钮失败而丢失）。**声明保留 `inlineButtons`**，但注释与测试明确登记了上述能力边界。
- **按钮权限语义写反（真 bug）**：`src/types.ts` 的 `action.permission.type` 注释此前是「0=全体 1=管理员 2=按钮指定 3=身份组」，**与官方定义完全相反**（官方为 **0=指定用户 1=管理员 2=所有人**）。按错误注释理解的下游代码把 `type: 2` 误当成「仅指定用户可见」，实际下发的是**「所有人可见可点」**——群聊里的审批卡片因此对全群可见。修正注释并把 8 处裸数字改为具名常量（`KEYBOARD_PERMISSION_EVERYONE` 等），语义显式化。
  **行为未改**：框架的 approval request 只带 `turnSourceTo`（会话目标）、**不含发起者 openid**，按钮渲染阶段拿不到「谁触发了这次审批」；若下发 `specify_user_ids` 就必须猜一个 openid，猜错会导致**目标用户也看不到按钮**（比越权更严重：审批卡片直接失效）。故维持「所有人可见」，实际越权面由**点击时的操作者鉴权**兜底（`authorizeActorAction` 按 `allowFrom` 校验点击者）。待框架在 approval request 中提供发起者标识后再收窄。
- **`tests/sdk-surface.test.ts` 的具名导入扫描正则跨语句误匹配**：`{...}` 的匹配体原为 `[\s\S]*?`，惰性匹配且允许跨越 `}`，会从一个 `import {` 一直吃到后面某个 `} from 'openclaw/plugin-sdk/…'`，把**中间其它 import 语句的具名子句误记到本子路径名下**。实测触发过：`src/outbound-adapter.ts` 里 `import { checkAndConsumePassiveReplyQuota, … } from './features/quota-manager.js'` 的三个名字被算到 `openclaw/plugin-sdk/interactive-runtime` 头上，守卫误报「子路径缺少运行时值」，把人引去查一个并不存在的 SDK 缺陷。改为 `[^}]*` 后匹配体不再越过本条 import 语句自己的闭合花括号。

### 新增

- **`streaming.sendMode: "stream-all"`——双道块驱动流式：滚动进度道 + 独立终稿打字机**（PR #61）。`stream` / `static` 之外的第三种下发模式：turn 的全部中间态（工具调用之间的每段正文 + 每个工具执行的 `🔧 <title>` 标题行）以 markdown 分隔线隔开、离散追加进**一条滚动消息**；全部工具结束后，模型终稿以**另一条打字机消息**（约 64 字 / 90ms 分片）独立下发（含 usage footer）。无工具单段 turn 自动退化为单条终稿打字机，配置形态不变（`{"streaming": {"mode": "partial", "sendMode": "stream-all"}}`）。
  - 数据面：文本段经 `deliver(kind:'block')` 按完成段到达、工具标题行经 `onItemEvent`（`forceToolResultProgress` 解锁 verbose 关闭时的投递）、终稿经 `deliver(kind:'final')`；token 级 `onPartialReply` 不注册。**显式传 `disableBlockStreaming: false` 开启 block streaming**——框架的启用条件是显式 false 或用户配置 `agents.defaults.blockStreamingDefault: "on"`（默认未设），不显式开启时滚动道将收不到任何正文（分支评审发现的缺陷，已修）。
  - **held 块轮转**：块到达时无法定性（终稿的身份是回溯性的），先扣住；后继块 / 工具事件 / 新段开始（`onAssistantMessageStart`）证明其为中间段才提交。final deliver 时按**前缀包含性**定性：终稿段恒为终稿文本的前缀（footer 追加在尾部）→ 取代丢弃（终稿道原样重新呈现，无需差量对账）；不是前缀（块投递被 SDK coalescer 拖到 final 之后、held 扣的是工具前文本）→ 提交进滚动道防内容彻底丢失（时序倒置为已知残留）。
  - **✓/✗ 收尾标记**受 QQ 流式「前缀不可回改」约束：仅当标题行仍是滚动道末尾时可补，成功 `✓`、失败 `✗`。item 去重按强弱 id 分层：`itemId` / `toolCallId` 优先，强 id 未命中即视为新 item、不回退 `title` 别名（否则同名工具的后续调用被折叠、滚动道缺行）；exec 的 tool/command 双 item 仍按共享 `toolCallId` 去重为一行。
  - 失败语义：终稿道**首片即失败** → 终稿整段回落普通消息补发（滚动道保持可见）；**中途失败**（首片已落地、后续分片被拒）→ 已接受前缀收尾可见，未接受尾巴复用 stream 模式的 `[stream-final]` 前缀差量补发（结果不明的网络层失败照旧抑制补发，防与流内内容重复）。
  - 测试：`tests/stream-all.test.ts` 19 例（含同名调用不折叠 / exec 双 item 去重 / 中途失败尾部差量 / 迟到块防丢失 / ✗ 标记）。

- **声明 `live.capabilities.nativeStreaming`（QQ 私聊原生流式）**：`src/message-adapter.ts` 此前**未声明**该能力，框架不会把 QQ 的原生流式当作通道能力。`draftPreview` **保持 false**（**不是漏声明**）：该能力在框架语义下是「先发一条可编辑的草稿消息占位」（Telegram 的 edit-preview 模型），而 QQ 私聊原生流式是 `openStream → update(前缀增长) → complete` 的**单消息流式**，平台约束「已下发文本的前缀不可变更」，没有「草稿占位 + 原地改写为终稿」的两阶段结构。`nativeStreaming` 是通道级声明而 QQ 流式**仅 C2C 开放**（SDK `openStream` 对非 c2c 直接 throw），群聊实际走进度卡片——真正的 scope 判断仍由插件内 `StreamingController` 把关。
- **回归测试**：`tests/presentation-buttons.test.ts`（22 例：框架 action → QQ `action.type` 映射 / 不可落地控件丢弃保留文本 / `presentationCapabilities` 取值 / id 唯一 / 拆行 / label 截断 / ask_user 上下文解析）、`tests/message-adapter-capabilities.test.ts`（9 例：能力声明取值 + **「声明 inlineButtons 则必须存在落地实现」的一致性守卫**）、`tests/keyboard-permission-semantics.test.ts`（5 例：权限常量取值与官方一致 / 全仓不再有裸数字权限值 / `specify_user_ids` 当前未使用）。`tests/sdk-surface.test.ts` 另加**能力声明与实现一致性**分组（2 例）。

- **补齐 manifest 的 `channels.qqbot` 配置 schema（Control UI 配置表单）**。`channels.qqbot` 段的配置 schema **只能**来自 `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`——框架的 registry 只从 manifest 采集通道 schema（`manifest-registry` 的 `buildRecord` → `collectChannelSchemaMetadataWithOwnership` → `prepareChannelConfigSchema`）；插件运行时的 `plugin.configSchema` 走的是**插件级** `plugins.<id>` 段，管不到 `channels.qqbot`。
  此前 manifest 只声明了 `appId` / `clientSecret`，而插件实际读取的配置项有 **27 个**（`QQBotAccountConfig`）：`dmPolicy` / `allowFrom` / `groupPolicy` / `groupAllowFrom` / `groups`（含 `requireMention` / `toolPolicy` / `historyMode` / `unmentionedInbound` 等子项）/ `rateLimit`（三层限流）/ `transport` / `webhook` / `markdownSupport` / `audioFormatPolicy` / `urlDirectUpload` / `defaultRequireMention` / `groupCoalesce` / `deliverDebounce` / `typing` / `inboundDebounce` / `commands` / `streaming` / `progressCard` / `userAgentSuffix` / `clientSecretFile` 等。结果是 **Control UI 的 QQ 配置表单只有两个字段**——用户想配群策略、白名单、限流、流式、进度卡片等，只能手写 JSON。
  现补齐：
  - **schema 顶层 30 个字段** + **`accounts` 段 27 个字段**（逐字段列举而非 catchall，好让 UI 渲染出对应控件），`additionalProperties: false`（与 Telegram 一致，作用是**挡住拼错的字段**而非放行）
  - **24 条 `uiHints`**（label + help），覆盖私聊准入、群策略、群配置、限流、传输方式、流式、进度卡片、防抖、指令面板、多账号等，help 文本写明默认值与 QQ 平台的特殊约束（如「群主在客户端选的推送模式插件不可控」「openid 按账号隔离」「防抖窗口钳制范围 [0, 60000]」「卡片只走被动回复不烧主动预算」）
  - `capabilities.inlineButtons` 声明为与 Telegram 同款语义（`off` / `dm` / `group` / `all` / `allowlist`）——**注意**：配置侧 `capabilities` 在框架语义下是「只增不减」的并集项，插件侧的 `messageToolCapabilities` 才是提示词侧的实际开关，故该字段目前是**声明位**而非生效开关（生效开关见上方「私聊（C2C）能力声明与平台真实语义对齐」的插件侧实现）
  - 新增 `tests/manifest-config-schema.test.ts`（15 例）——锁定「manifest 能被框架 `loadPluginManifest` 解析」「schema 覆盖 `QQBotAccountConfig` 的**全部**键（顶层 + accounts 段）」「**嵌套配置块的子字段**与对应 TS 接口逐项一致」「顶层与 accounts 段的嵌套 schema 逐字一致」「**框架真实的通道配置校验路径**能接受 setup 产出的配置」「uiHints 每条都有 label + help」。
- **修正 manifest schema 的四处不匹配（Sourcery 评审发现）**。`additionalProperties: false` 下 schema 与真实配置结构的偏差会**直接拒掉用户的配置**（框架的通道配置校验走 `validatePluginSchemaValue`，与 Control UI 打开/保存配置同一条路径），故以下四处不是「描述不准」而是**功能缺陷**：
  - **`deliverDebounce` 的子字段名写错**：schema 写的是 `debounceMs`，运行时实际读 `windowMs` / `maxWaitMs` / `separator`（`DeliverDebounceConfig`）。用户按 schema 配 `windowMs` 会被拒，按 schema 配 `debounceMs` 会被静默忽略。
  - **`progressCard` 漏 `maxLines` / `reserveQuota`**：这两个字段是实打实在用的（`maxLines` 控制 checklist 渲染行数，`reserveQuota` 为最终回复保留被动配额槽），漏了就没法配。
  - **漏 `mediaMaxMb`**：`src/setup/finalize.ts` 的 `applyAccountDefaults` **自己**就会往配置里写 `mediaMaxMb: 200`（扫码/手动登录流程都会调用），schema 不认它 → **用户跑完 setup 就得到一份 schema 拒绝的配置**。
  - **`accounts` 段的嵌套字段全是裸壳**（`{"type": "object"}`）：UI 渲染不出子控件，且拼错的键被接受。现改为与顶层**逐字一致**的完整定义。
  相应的测试也加严了：字段覆盖检查从「顶层键在不在」扩展到「**嵌套子字段**逐项对照 TS 接口」+「顶层与 accounts 段逐字一致」+「用框架**真实**的 `validatePluginSchemaValue` 验证 setup 产出的配置可被接受」+ 一条**反向断言**（确认该校验路径对 `additionalProperties: false` 确实敏感，否则上面的「通过」是假的）。**注**：不能用 `validateJsonSchemaValue` 做这件事——它只校验 schema 本身的形状，不做实例值校验，对 `additionalProperties: false` 完全不敏感，测出来的「通过」是假的。

### 变更

- **插件键盘类型与 QQ SDK 结构对齐**：`src/types.ts` 的 `KeyboardButton.render_data` / `.action` 与 `KeyboardAction.data` / `.permission` 改为**必填**（此前可选，导致本插件的键盘类型无法直接交给 SDK 的 `bot.send({ keyboard })`，只能在边界处做强制转换）。
- **`capabilities.unsend: false` 的原因订正**：该字段表达的是「**本插件已实现该动作**」而非「平台是否支持」。QQ 平台**确实支持**撤回（`DELETE /v2/users/{openid}/messages/{msg_id}`，限 2 分钟内、仅限机器人自己发的消息，SDK 也已封装 `bot.recallMessage()`），但本插件**未实现** message 工具的 `unsend` 动作处理器，故如实声明为 false。`edit: false` 则是**平台真的不支持**（QQ 无编辑消息接口）——两者原因不同，注释已分开表述。
- **`capabilities.reply: true` 补充实际表现说明**：QQ 支持引用回复，但分两条路径——被动回复用 `msg_id` 锚定；SDK 在**非 markdown 模式**（`msg_type=0` 纯文本）下额外下发 `message_reference` 字段渲染引用块，markdown 模式（`msg_type=2`，插件默认）下只有锚定回复。

---

## [2.7.0] - 2026-10-20

### 新增

- **接入 openclaw 10.5 的通道插件契约（地板不动，peer 与钉版仍为 2026.9.1）**。逐子路径 diff 实测：9.1 → 10.5 的 `plugin-sdk` **净增 29 个子路径 / 净删 9 个**（删的 9 个在 10.2 已删，10.2–10.5 无新增删除），而**本插件用到的 26 个子路径中，19 个的导出面逐字未变**——即 10.5 官方文档里的绝大部分「通道插件最佳实践」在 9.1 就已存在，**不抬地板也能吃到 10.5 的能力**。本次落地四项：
  - **`messaging.inferTargetChatType`**（`src/messaging-adapter.ts` + `src/outbound/target.ts` 的 `inferQQBotChatType`）：宿主做「隐式 owner 心跳投递」时依赖通道**直接给出目标对应的会话类型分类**，通道不提供时宿主只能走通用路由搜索，Gateway 状态会一直报 `waiting for route`。语义：`qqbot:c2c:*` / 裸 openid → `direct`，`qqbot:group:*` → `group`，**其余一律 `undefined`（不猜）**——QQ 频道（`qqbot:channel:*`）本插件不支持，猜成 `direct` 会把路由带偏。
  - **`config.inspectAccount`**（`src/config.ts` 的 `inspectQQBotAccount`）：补上 10.5 官方推荐的**只读账户巡检面**。`resolveAccount` 是运行期路径、允许快速失败；而 `openclaw status` / `openclaw channels status` / doctor / config 修复等只读命令路径不该为了「描述配置」而触发 token 交换或扫码登录。巡检只描述状态（`appIdSource` / `appIdStatus` / `secretSource` / `secretStatus`），且**全程不读盘、不 materialize 凭据**——凭据来源已配置但当前只读路径取不到时上报 `configured_unavailable`，而非谎报「未配置」或直接抛错。
  - **`capabilities.tts.voice` 声明**：`{ synthesisTarget: "voice-note", transcodesAudio: true, captionedFinalText: false }`。此前**未声明** → 框架把 QQ 的 TTS 当普通音频文件（`audio-file`）投递，而不是语音气泡；且 `captionedFinalText: false` 是必需的——QQ 语音消息不带文字说明，声明为 true 会让框架把终稿正文 defer 成语音附注文本（`shouldDeferFinalTtsText`）而正文永不到达。**刻意仍不声明 `capabilities.nativeCommands`**——QQ「指令面板」是「点面板把指令文本填进输入框」的引导型 UI，不是框架意义上的 provider-native slash command，声明它会与 `commands.text=false` 的文本斜杠指令路由语义冲突。
  - **字形簇安全分块**（`src/outbound/grapheme.ts` + `src/outbound/chunker.ts`）：接 openclaw 10.5 新增的 `openclaw/plugin-sdk/text-grapheme`（`findGraphemeChunkEnd`）。此前框架 `chunkMarkdownText` 按「换行/空白」断点切块，**中文长句没有空白时会在硬上限处直接截断**，切点落在 emoji（代理对 / ZWJ 序列 / 组合符号）中间就把字形切碎、QQ 侧渲染成豆腐块；而本地 GFM 表格 fallback 则是**整块不切**，超限消息被平台直接拒收（消息丢失）。现对**仍超限**的块做二次切分（优先换行断点 → 空格断点 → 字形簇边界），保证每块 ≤ 上限且不切碎 emoji；**续段补回结构上下文**（代码围栏包裹 / 表格表头），并把上下文开销计入切分上限（否则补完反而超限）。该子路径**9.1 基线不存在、且发布包不带 `.d.ts`**，故按「能力探测 + 本地 `Intl.Segmenter` 等价回退」实现（懒调用 + try/catch，子路径缺失不影响插件加载与分块行为），并在 `tests/sdk-surface.test.ts` 的 `EXEMPT_SUBPATHS` **显式登记豁免**（理由与 `webhook-ingress` 的「静默失效」本质不同：回退路径功能等价，且有行为测试兜底）。本地回退实现**逐行对齐官方 `dist/grapheme-*.mjs`** 并用差分测试锁定（20 个用例的期望值由官方实跑产出）——对齐过程中修掉两处真 bug：官方 `avoidTrailingHighSurrogateBreak` 的 `end + 1` 兜底分支缺失会导致「文本以 emoji 开头且预算很小时切分零进展、整块原样超限被平台拒收」；以及官方契约允许「预算内放不下完整字形簇时的代理对安全部分切」，本地实现一度把切点强行吸附到簇边界、与官方行为分叉。
- **回归测试**：`tests/channel-contract-10-5.test.ts`（14 例：会话类型推断四类目标 / 只读巡检三态 / 凭据文件「不读盘 + 启动时materialize + 互斥」/ capabilities 声明）与 `tests/chunker-grapheme.test.ts`（19 例：与 openclaw 10.5 官方实现的**差分测试**（20 个用例，期望值由官方实跑产出）/ 代理对与 ZWJ 序列不被切开 / 超限块必被切开且内容不丢 / 续段补回代码围栏与表头且表格不被切在行中间 / 能力探测回退路径行为正确）。

### 修复

- **结构上下文开销未封顶：一条超限消息会炸成上千条垃圾消息（分支评审发现）**
  `src/outbound/chunker.ts` 的续段要补回围栏包裹 / 表格表头，这部分开销要从切分预算里扣。此前两个漏洞叠在一起：
  - **围栏 info string 取整行**——`line.slice(m[1].length).trim()` 把 marker 之后的**整行**当成语言标识。LLM 常输出的超长单行（行内 JSON / 行内代码）整行都是 payload，重开前缀直接膨胀到超限；顺带该切法在**有前导空白**时还会把 marker 的头几个字符误当成 info string 的一部分。
  - **负预算被钳成 1**——`Math.max(1, limit - overhead)` 把「前缀本身已超限」的事实掩盖成「每段只剩 1 字符」。

  实测复现：5114 字的超长单行围栏被切成 **5110 块、其中 5109 块各 5120 字（全部超限 → 平台拒收）**。修复照抄框架 `resolveFenceReopenLine` 的**逐级降级**：完整开栏行放得下就用 → 否则降级为裸 marker → 再放不下放弃围栏上下文；info string **只取首个 token**（语言标识，超过 32 字符视为没有语言标识）；表头上下文另加**预算规则**——上下文开销 > 正文预算（overhead > limit/2）时整段放弃上下文按纯文本切。另补**首刀不得落在围栏开栏行内部**（框架同义约束 `minProgressIdx`），否则首块只剩一个孤零零的 ```js。
  修复后同一输入切成 **2 块（5000 + 124）、零超限**，与框架路径同形。**框架路径本身无此问题**（`rt.channel.text.chunkMarkdownText` 自带封顶），受影响的是本地 GFM fallback 这条安全网。新增 `tests/chunker-context-overhead.test.ts`（11 例）锁定——末例是**伪随机不变量测试**（固定种子、300 轮）：每块 ≤ 上限、内容不丢、块数不爆炸（命中围栏前缀 106 次 / 表头前缀 105 次，非空转）。
- **`enforceChunkLimit` 注释覆盖面收敛**：该函数只处理**严格超限**（`length > limit`）的块；框架 chunker 对无空白中文长串会切出**恰好等于 limit** 的块，其切点只受代理对级保护，切点落在 ZWJ 序列或组合符号中间时仍会切碎字形——该残留**在框架路径上依然存在**，注释改为准确表述并在 AGENTS.md 记录边界（真修需在切点处重锚定，成本另议，暂不处理）。

- **`clientSecretFile` 是「声明了但从不读取」的死配置**。`resolveQQBotAccount` 此前只把 `secretSource` 标成 `"file"` 却把 `clientSecret` 留空——于是 `resolveDefaultQQBotAccountId` 认为该账号「可运行」（`accountShapeRunnable` 的 `hasSecretSource` 含 `clientSecretFile`）并把它选为默认账号，但网关启动时又因 `clientSecret` 为空直接放弃（`gateway/lifecycle.ts`），用户表现为「配了文件凭据却静默起不来」，且 `openclaw status` 会把它误报成未配置。
  修复按「读盘只发生在该发生的地方」重新组织：
  - `resolveQQBotAccount` **全程不读盘**——它是热路径（每次出站发送都解析一次账号），同步 `stat`/`readFileSync` 会阻塞事件循环（网络挂载上可能卡死整机）；凭据文件改为在**账号启动时读一次**（`materializeQQBotAccountSecret`）
  - **内联密钥与凭据文件强制互斥**——两者同时存在时内联优先、文件被**静默忽略**（用户表现为「配了文件凭据却还在用旧密钥」），写入时清掉另一个
  - **注销同时清 `clientSecretFile`**——只清内联的话账号仍能用同一份文件凭据起来，等于没注销
  - **`isConfigured` 语义三处对齐**（config 适配器 / setup finalize / 只读巡检）：`secretSource === "file"` 且配了 `appId` 即视为已配置，否则已配好文件凭据的账号会被误判为未配置、被拉去重新扫码
  - 读盘缓存按 `mtimeMs + size + ino` 判定——只看 mtime 会在「轮转密钥但沿用旧 mtime」（备份还原 / `cp -p` / 某些挂载的时间精度）时读到旧值
- **语音（语音条）投递口径与 QQ 平台对齐（2026-10-20 核实官方文档）**
  官方《富媒体消息概述》的富媒体限制是**体积制、不是时长制**：`file_type` 3 语音（silk）**软限制 20MB / 硬限制 200MB**，「超过软限制会降级为文件类型上传，超过硬限制会报错」；平台只把 **silk/mp3/wav/ogg** 渲染成语音条。**平台文档里没有任何语音时长（秒）限制**——「60 秒以内是语音条」是体积与时长的相关性错觉（TTS 语音通常只有几百 KB～1 MB）。
  我们代码侧此前有两处与平台不一致：
  - `inferMediaKind` 把 `.amr` / `.flac` / `.aac` / `.m4a` 也判成 `voice`——平台不认这些格式，会隐式降级成文件卡片，还丢掉我们设的文件名。现只认平台明确的 4 种格式，其余按文件投递（结果一致、行为可预期）。
  - 语音**不做体积检查**，纯靠平台隐式降级。现抽出 `resolveOutboundMediaKind`，语音超 20MB 软限制时**显式**降级为文件投递并打 WARN 日志。
  另核实：官方《消息类型》页明确**表情表态仅频道支持**（单聊/群聊 ❌），故 `capabilities.reactions: false` 与平台一致。

### 变更

- **openclaw 2026.10.5 起，框架会在后台复盘改动 skill 后，向触发它的那次会话主动发一条「💾 Learned: updated `xxx` (…). Say "undo" to revert this skill change.」通知**（**行为变更说明，非缺陷，本插件未做任何改动**）。
  这是 openclaw 10.5 新增的 Skill Workshop（自学习）功能。逐版本核对 dist 确认：**9.1 与 10.1–10.4 都有后台复盘，但都没有「外发通知」这一步**（10.5 才加的 `postWorkshopChangeNotice`），所以升级到 10.5 后才会看到这条消息。
  - **默认就是开的**：`skills.workshop.autonomous.mode` 的默认值就是 `"auto"`（不配即开）。
  - **群聊同样会收到**：投递判定只有「渠道可投递 + 有 target.to」两条，**没有「是不是群」的条件**；而且这是框架**主动外发**的出站消息，不经过入站中间件链 → 群里的「仅被 @ 才响应」（`requireMention`）对它**无效**。
  - **在 QQ 侧按主动消息发送**：该通知的 payload 只有 `{text}`、不带 `replyToId` → 不消耗被动回复配额，走 QQ 主动消息通道（受其频率/风控限制）。
  - **不需要时**配 `skills.workshop.autonomous.mode: "off"` 关掉自动复盘（`skill_workshop` 工具本身仍在，agent 主动 `/learn` 与手改 skill 不受影响）；也可用 tool policy 按**群 / 发送者维度**单独禁 `skill_workshop`（准入检查在 `prepareSkillExperienceReviewCandidate`，policy 链含 `groupPolicy` / `senderPolicy`）。

### 文档

- **AGENTS.md 补 2026.10.5 盯版结论**：子路径增删全量、审批面「10.5 重构了 native 审批 runtime」说法的实测纠正（`createChannelApprovalNativeRuntimeAdapter` 工厂签名两版一致；`presentation.buildPendingPayload` 与 `transport.*` 的参数属性集逐项相同，10.5 只是把内联对象类型重组成具名 context，**通道侧回调签名一字不改**，故审批功能无需返工）、TTS 配置 schema 两版逐字相同（`config-contracts` 新增的 `TtsMode` / `TtsPersonaConfig` / `TtsPersonaFallbackPolicy` 只是 9.1 就存在类型的重新导出，`SessionResetMode` 是会话重置策略、与 TTS 无关）、群话题（group thread）是 10.5 全新能力且配置在顶层 `cfg.broadcast["<channel>:<peerId>"]`、29 个新子路径里 20 个对 TS 消费方等于「无类型」需补 ambient stub、`feature-contract` / `feature-plugin` 是 typebox 的插件功能 RPC 契约而非「通道能力声明」。

---

## [2.6.1] - 2026-10-16

### 修复

- **任务 turn 运行期间，`/stop` 等旁路消息被排队阻塞，c2c 插嘴语义失效**（v2.5.0 引入防抖合并后的回归，含两轮 Sourcery 评审闭环）。用户报告：任务执行中发送 `/stop` 无法及时送达 openclaw，总要等任务跑完命令才被 dispatch 进框架。根因在插件与框架 debouncer 的配合方式：防抖 `onFlush` 返回 `admission === completion`（同一个 promise，覆盖整个 turn run），而框架 debouncer（`dist/inbound-debounce-*.js`）的 `enqueue` 对旁路项（控制命令 / 斜杠命令 / keyed 答案）在**同 key 存在 in-flight 任务链时会排队等其 settle**——于是任务 turn 不结束，同发送者的 `/stop` 就进不了 dispatch，`exclusive + abortSignal` 的插嘴取消完全失效；更隐蔽的是挂起 ask_user 的 keyed 答案走同一旁路，会被**自己正在等待的 turn** 死锁（答案永远送不进去）。修复：**admission（放行）与 completion（typing 续命）解耦**——`dispatchToOpenClaw` 新增 `onTurnSubmitted` 选项，从框架 `turnAdoptionLifecycle` 的 `onAdopted` / `onDeferred` / `onAbandoned`（= turn 已入 lane 队列）触发，防抖据此提前放行同 key 任务链，completion settle 时兜底（ingest 丢弃 / dispatch 抛错 / adapters 缺失等路径链不悬挂）；typing 续命语义不变（`enqueueC2CInboundMessage` 仍等到 batch dispatch 完成才 resolve）。信号刻意取 lane 决策而非「inboundRun 已调用」：框架 `runChannelTurn` 到真正入队还有 ingest → classify → preflight → resolveTurn 多个异步段，调用时放行会让 `/stop` 抢在前一批次入队前到达 lane、无处可取消（Sourcery 二轮意见）；此后同 key 旁路必然晚于本 turn 入队，顺序确定。
- **退出冲刷丢已提交 turn 的回复**（Sourcery 首轮意见 1）。admission 提前放行后，SIGINT/SIGTERM 的 `flushAllC2CInboundDebouncers` 会在 lane 决策处即返回，shutdown handler 随即 `forceExit`——退出宽限（≤1.5s）内本可跑完、把回复发完的 turn 被杀。修复：退出冲刷改**两段式**——第一段逐 key `flushKey` 等 lane 决策，第二段等全部在途 completion（`activeCompletions` 登记簿，settle 自移除）；仍在 runtime.ts ≤1.5s 有界封顶内，不会无界等 turn（Ctrl+C 卡死是刻意拒绝的）。
- **跨窗口串行语义显式拍板**（二轮评审发现）。放行在 lane 决策处的直接后果：**窗口外**的同发送者消息（如 10 秒后再发的第二个文件）不再排队等运行中的 turn 跑完——turn B 以 exclusive 入场会 abort 运行中的 turn A。v2.5.0–v2.6.0 因 `admission === completion` 意外获得的「全部同发送者消息串行」就此放弃，c2c 恢复 pre-v2.5.0 插嘴语义（对齐框架 `createInboundDebounceFlush` 在 adopted/deferred 即 markAdmitted 的契约）；**窗口内合并（防抖特性的存在理由）不受影响**。刻意不做「只放旁路项插队」的收窄：那需要设计红线已否决的 enqueue 早退式旁路或对抗框架 debouncer，且会让普通文字消息（改需求、追问）重现「等长任务跑完才 dispatch」的同款缺陷。该决策连同理由已写入 AGENTS.md 红线与模块头。
- **包根类型导出缺失**（Sourcery 意见 4）：`DispatchToOpenClawOptions` 随 `dispatchToOpenClaw` 在包根 `index.ts` 导出，TypeScript 消费方可按名导入。
- 回归测试 `tests/inbound-debounce.test.ts` 26 → **33 用例**：新增「运行中 turn 不阻塞 `/stop` / 控制词」「放行取 lane 决策时点（入队前不抢先）」「dispatch 失败不悬挂、不卡同 key 后续旁路」「退出冲刷两段式」「挂起 ask_user 的 keyed 答案立即 dispatch（死锁类钉子）」「跨窗口消息插嘴语义」六组钉子，全部经反向验证（对 v2.6.0 代码转红）；AGENTS.md 防抖红线同步更新（含此前用例计数 25 的欠账修正）。

---

## [2.6.0] - 2026-10-14

### 新增

- **白名单未命中不再静默丢弃：被拒用户收到可操作的诊断提示**。`dmPolicy` / `groupPolicy` 为 `allowlist`（默认）时，发送者不在 `allowFrom` / `groupAllowFrom` 的消息此前被 `dynamicAccessControl` 直接 `ctx.stop('access:not_allowlisted')` 丢弃，用户侧**零反馈**——「bot 挂了」「bot 装睡」「allowFrom 配错了」三种情况完全无法区分，只能翻服务端日志。而 OpenID 是 per-account 的（bot A 拿到的 openid 在 bot B 上无意义），配错本身就是高频误配。现新增 `src/features/access-notice.ts`，在拦截前发一条诊断消息：**私聊恒回告**，文案带出**被拒者自己的 OpenID** 与准确配置路径，用户可直接复制粘贴后热更新生效，无需另跑 `/bot-me`；文案**绝不回显白名单内容**，不向陌生人泄露配置。**群场景仅在被 @ / 引用 bot 时回告**：群提示是公开广播，bot 被拉进陌生群时逐条回「本群不在白名单」等于对外广播该 bot 配了白名单，全量推送群里还会变刷屏；只有明确点名 bot（`GROUP_AT_MESSAGE_CREATE` / `mentions[].is_you` / 内容 `<@!appId>` 标记 / 引用 bot 出站消息）时对方才可能在等回复。@/引用判定与 `mentionGate` **同源**——隐式引用逻辑收敛为 `ref-index-store` 导出的 `isQuoteOfBotMessage`，由 `middleware-setup` 的 `isImplicitMention` 回调与本提示共用，杜绝两处各查一遍 ref-index 导致的语义漂移。**节流**：同一被拒实体（私聊 = 发送者 openid / 群 = groupOpenid）10 分钟冷却 + 每账号每日 50 条上限，防陌生人把 bot 当回声板。**发送走被动回复、不吃每日主动预算**：SDK 的 `deriveReplyTarget` 已把当前入站 `messageId` 挂在 `ctx.replyTarget.msgId` 上，`sendText` 见 msgId 即下发 `body.msg_id`；被拒消息没有 turn，不存在跟别的 turn 抢配额，而绕网关锚点选取反而可能在死锚点时降级主动——**把每日预算暴露给刷屏者**。已知残余：不预扣插件侧被动配额、不受控发号（SDK 准随机 msg_seq），锚点已死时平台直接拒绝而不转主动重发——对诊断消息是保守方向。**保持原样的边界**：`disabled` 是管理员显式拉下的总闸（此时回话等于架空该开关，仍静默）；`pairing` 模式本就有配对挑战文案。回归测试 `tests/access-notice.test.ts`（33 例：文案 / @ 判定四路 / 冷却与每日上限 / 中间件端到端，含发送失败回滚、发送超时、群静默分支、迟到失败竞态）。

### 修复

- **拒绝提示的五个边界缺陷**（Sourcery 评审第 1 轮：9 条意见，6 条采纳 / 3 条经代码核实驳回）。(1) **命名账号的主配置路径此前指向错误层级**：文案恒把顶层 `channels.qqbot.allowFrom` 当主路径，而该键只属于 default 账号——命名账号的用户照着改会被 `resolveQQBotAccount` 忽略、拒绝依旧；现命名账号主路径改为 `accounts.<id>.allowFrom`。(2) **群提示泄露内部 accountId**：`accountHint` 原样拼出真实账号名，群成员触发一次即可看到；现群场景改为泛化指引「同名键在 `channels.qqbot.accounts.<accountId>` 下」，不出现真实账号名。(3) **发送挂死会拖住拦截**：中间件 await 的是裸 SDK 发送，请求不 settle 就永远走不到 `ctx.stop`，被拒消息的处理一直悬着（占住 c2c 防抖槽位）；现加 8s 本地超时（`dynamicAccessControl` 的 `noticeTimeoutMs` 仅供测试注入短值）。(4) **超时与确定性失败混为一谈**：超时属结果不明（平台可能已投递），回滚冷却会让下一条被拒消息立刻再发一条、用户收到重复诊断；现超时保留冷却不 `release()`，只有确定性失败才回滚。(5) **`release()` 会抹掉更新的预留**：一次发送挂起超过冷却窗口后同实体的新预留已就位，旧请求的迟到失败若无条件 `delete key` 会连新冷却一起清掉；现 `release()` 校验 token，仅在本次预留仍是持有者时回滚。另修容量控制淘汰未过期冷却条目的问题（淘汰会让节流形同虚设）——改为**宁可临时超出上限也不淘汰**，条目寿命即冷却窗口，稳态规模自然封顶。**驳回的三条**：①「`ctx.bot.sendText` 绕过 `QQBotGateway` 的锚点选取与配额记账」——不成立，SDK `deriveReplyTarget`（`QQBot.js:722/725`）已把入站 `messageId` 作为显式锚点挂在 `ctx.replyTarget.msgId`，`sendText` 见 msgId 即走被动回复；且绕网关会在死锚点时降级主动重发，等于把每日预算暴露给刷屏者，方向相反。②「被拒消息因 `ctx.stop` 早于 `cacheMsgId` 而没有锚点」——**首轮此条驳回理由有误，二轮经源码核实纠正**：插件的 `cacheMsgId` 挂在 `bot.on('message')`（链尾 downstream，经 `handleMessage` 调用），而 `ctx.stop()` 不调 `next()` 会让 `runMiddlewareChain` 在 `ctx.stopped` 分支直接 return，downstream 不执行——被拒消息确实进不了 msgid-cache，Sourcery 的前提成立。驳回结论之所以仍成立，是因为提示根本不用 msgid-cache：SDK 在组链之前就 `deriveReplyTarget(raw)` 把入站 `messageId` 挂到了 `ctx.replyTarget.msgId` 上。这条反直觉的结构事实已同步写入 `access-notice.ts` 头注释与 AGENTS.md——**若后续维护者据错误论证把提示改走网关 `attachMsgIdWithQuota`，会挑到更早的缓存 msg_id 或降级主动，恰是本设计明确避开的路径**。③「冷却与每日计数应持久化以跨重启/多实例共享」——本插件一个 accountId 对应一个网关进程，内存态与既有 `proactive-budget` / SDK rateLimiter 同惯例，重启清零只放宽防松紧度、不涉及正确性，落盘属过度设计。

---

## [2.5.0] - 2026-10-14

### 新增

- **私聊入站消息防抖合并：文件 + 伴随文字组成单个 turn**（含三轮 Sourcery 评审闭环）。QQ 私聊除图片外，文件与文字只能是两条独立消息（QQ 无「文件描述」附件窗口），而 c2c turn 可插嘴——先发的文件 turn 会被随后到达的文字**直接打断**（exclusive + abortSignal，文件处理半途而废），这是结构性缺陷而非体验问题。新模块 `src/features/inbound-debounce.ts` 在 handleMessage 层把同一发送者在防抖窗口内的连续消息合并为一次 dispatch，复用框架官方防抖原语（`openclaw/plugin-sdk/channel-inbound` 的 `createInboundDebouncer` / `resolveInboundDebounceMs` / `shouldDebounceTextInbound`，telegram 通道同款；滑动窗口——每条新消息重置计时，框架硬上限 `debounceMs × 5` 防连珠炮无限延期）。合并语义：按**平台事件 timestamp 稳定排序**（中间件链并发执行，附件下载慢的早到消息可能晚于快消息完成 enqueue，入队顺序 ≠ 到达顺序），载体 = 最新到达消息的 ctx/msg（被动回复锚点 / 请求上下文取自它），`assembledBody` 加 `[消息 i/N]` 分节头拼接、`processedAttachments.media` 按序 concat（保住框架正规媒体通道的 media facts，文件 localPath 进 MediaPaths）。三类旁路在 `shouldDebounce` 内返回 false（经框架序列化：先冲刷同 key pending buffer 再执行，顺序保持）：控制命令（stop/esc/abort/exit）、斜杠命令（rawBody 以 `/` 开头，合并会破坏命令标记）、多问题 ask_user keyed 答案（合并会改写 `1: 3\n2: 1` 使框架认领失败、ask_user 挂起）。**入队 await 语义（typing 续命）**：enqueue 阻塞至 batch dispatch 完成才 resolve——SDK 并发处理消息、held-open 中间件链不阻塞其他消息，typing 续期 timer 据此活到 turn 结束（与防抖前行为一致）；非载体项在 flush 开始先 resolve，只留载体一个续期源。防抖中途被禁用（配置热更新）先 `flushKey` 该发送者 pending buffer 再直发（保序，防旧 buffer 晚于新消息 flush 造成乱序 + turn 打断）。退出冲刷：框架 `drain()` 不冲刷 pending buffer（flush timer 是 unref 的，退出时永不触发），对自跟踪 key 逐个 `flushKey`，SIGINT/SIGTERM 有界等待（≤1.5s）——无界等 turn 会让 Ctrl+C 卡死、纯 exit 丢窗口内消息，有界等待取中。与 telegram 刻意相反：**纯附件消息必须防抖**（telegram 默认 lane 媒体直发——`shouldDebounceTextInbound` 的 hasMedia 分支返回 false——本插件场景正是要 hold 住文件等伴随文字，故 hasMedia 刻意传 false、仅借它的控制命令判定）。**注意默认开启**：每条私聊消息的 dispatch 固定延后一个窗口（3000ms），这是合并的固有代价；配置优先级 `channels.qqbot.inboundDebounce.{enabled, debounceMs}`（`0`/`false` 关闭）→ 框架 `messages.inbound.byChannel.qqbot` / `messages.inbound.debounceMs` → 默认 3000（钳制 [0, 60000]）。群聊恒不防抖（框架 followup 队列已承担合并，且 mention 门控语义要求逐条判定）。实现过程中修复的 CI 事故：runtime.ts 静态导入 inbound-debounce 形成环 `plugin-logger → runtime → inbound-debounce → dispatch → plugin-logger`，dispatch 图内模块顶层求值撞上未初始化的 plugin-logger（tsx/esbuild 下 `__name is not a function`、三个测试文件加载期崩溃），exit hook 改动态 import 断环。回归测试 `tests/inbound-debounce.test.ts`（26 用例：配置矩阵 / 合并纯函数 / 窗口合并 / 三类旁路保序 / 到达排序 / typing-hold / 滑动窗口 / 中途禁用保序 / 跨账号隔离 / 退出冲刷）；`tests/sdk-surface.test.ts` 守卫自动纳管 `channel-inbound` 子路径（两版 SDK 均在，无需抬地板）。

### 修复

- **多问题 ask_user pending 会话键 account-blind**（Sourcery 评审第三轮发现）。`question-helpers` 的 `pendingByConversation` 会话键原为 `${scope}:${targetId}`——QQ openid 是 per-account 的（bot A 与 bot B 的同字符串 targetId 指向不同用户），不带账号维度会让 A 账号的 pending 多问题误命中 B 账号同 targetId 的会话：secret-capture 的「多问题红线放行」误触发、防抖 keyed 旁路误旁路（文件+文字被拆开直发，文字打断文件 turn）。修复：accountId 纳入会话键第一维（`${accountId}:${scope}:${targetId}`），`registerPendingMultiQuestion` / `findPendingMultiQuestionByConversation` 全链路补 accountId 必填首参，dispatch（投递登记）/ secret-capture（红线放行）/ inbound-debounce（keyed 旁路）三个生产调用点同步传插件账号 ID。

---

## [2.4.1] - 2026-10-12

### 修复

- **static 流式模式下长回复的最终正文被静默丢弃（issue #44）**。配置 `channels.qqbot.streaming = { mode: "partial", sendMode: "static" }`，agent 长回复（600+ 字符）且中途调用工具时，QQ 侧只收到若干段碎片，**最终那段完整总结正文完全没送达，且全程无任何错误提示**。根因在 `computeUnsentRemainder()`：它以「最后一段已承接文本」为前缀基准计算 final payload 的未流出增量，而当 final 文本是**另一段从未流出过的内容**（末段一条 partial 都没到达）时，前缀 / 行首边界 / 空白归一化前缀全部失配，差量返回空串——于是「已被承接」与「从未承接」两种语义被折叠进同一个空串，控制器与 dispatch 的两层兜底同时空转；`handleFinalize()` 随后把空缓冲收尾记为 `done (finalize:fallback)`，终态是 `done` 又让失败兜底块不触发，正文就此静默消失。修复：把二值差量升级为**三态匹配**（新增 `FinalTextMatch` 与 `matchFinalText()`，判定规则与旧实现逐条一致，`computeUnsentRemainder()` 退化为薄封装、对外空串语义不变），并在 `absorbFinalText()` 增加补发分支——**static 模式下若当前缓冲为空（即本段一条 partial 都没流出）且 final 与已承接段完全无关，判定「本段从未承接」，立即用 `sendStatic` 把 final 文本整段补发一条**，同时推进差量账本使 dispatch 末尾的 `[stream-final]` 兜底自动归零（不会两层各发一遍）。补发前置四条件（static 通道可用 / 缓冲为空 / 至少已发一段 / 未走外部投递通道）全部成立才动手，因此 footer 合并、多段拼接增量、`ask_user` 外部投递等既有路径行为不变。**stream 模式有意不改**：「final 与流内内容无关」在 stream 下对应「模型重写」，流内内容已对用户可见，补发会造成重复，仅新增一条 INFO 留痕。issue 中建议的「把 `finalize:fallback` 改成 `failed` 让上层兜底」**经实测证伪且会更糟**：static 模式下 `shouldSuppressFinalTailFallback` 恒为 `true`，改成 `failed` 等于主动关闭唯一的那层兜底，正文照样发不出。可观测性同步补齐：终态原因新增 `finalize:rescued` 与静默的 `finalize:fallback` 区分开（后者不等于「正文已送达」），补发 / 丢弃各留 INFO 日志，dispatch 侧新增 `[stream-final] payload received chars=N`——没有这条即证明框架未投递 final 文本，属于另一类问题。回归测试 `tests/streaming-static.test.ts`（新增 12 例）与 `tests/stream-usage-footer.test.ts`（新增 Part 3 端到端 5 例）；`tests/dispatch-error-notify.test.ts` 的 fixture 一并修正——该用例注释写「final 与流式内容一致」，实际文本却与流内毫不相关，等于在断言本 bug 的丢失行为，现按其本意改为已流出段落的精确复现，继续守住 issue #8 的去重早退不变式。

---

## [2.4.0] - 2026-10-12

### 修复

- **openclaw 2026.10.2 盯版：SDK 子路径被删致插件加载失败**。openclaw `2026.10.2` **整体移除了 9 个 `openclaw/plugin-sdk` 子路径**（`channel-message`、`channel-lifecycle`、`channel-reply-pipeline`、`command-auth`、`config-runtime`、`discord`、`infra-runtime`、`telegram-account`）。本插件实际命中的**只有 `channel-message`**——progress card 渲染器 `formatPlanChecklistLines` 的唯一来源。该子路径被删时 `.d.ts` 一并消失，tsc 只报"找不到模块"，但**真正的后果是 `dist/index.cjs` 在加载期直接抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，整个插件所有功能全灭**（不是某个功能降级）。修复：把该 import 迁到 `openclaw/plugin-sdk/channel-outbound`——**9.1 与 10.2 都在**，`formatPlanChecklistLines` 签名两版一致（10.2 仅将 `plain` 选项标注 `@deprecated`，本插件未传该选项），故**基线钉版 2026.9.1 与 peer 范围 `>=2026.9.1` 均无需改动**，对老版本用户零影响。同批复核确认未受影响：其余 8 个被删子路径与 approval 侧被删的 `matchesApprovalRequestSessionFilter` / `resolveApprovalRequestAccountId` / `resolveApprovalRequestChannelAccountId` / `createChannelApprovalForwardingEvaluator` 本插件均未引用；`ChannelApprovalKind`（两版均含 `"system-agent"`）、`replyOptions` 的 `onPlanUpdate` / `suppressDefaultToolProgressMessages` / `allowProgressCallbacksWhenSourceDeliverySuppressed` / `queueModeOverride` / `sourceReplyDeliveryMode`、`room_event` + `message_tool_only`、`resolveToolPolicy`、`appendUsageLine` 在 10.2 原样存在。10.2 新增的 `ChannelGatewayAdapterV2` / `ChannelGatewayContextV2` 是**可选的 gateway V2 契约**（`ChannelPluginForGatewayVersion` 按 `GatewayVersion extends 1|2 = 1` 分派），插件未声明 `apiVersion` 仍走 V1，无需跟进。10.2 与基线 9.1 双跑 typecheck / lint:runtime / build / 全量测试全绿。

### 新增

- **被动回复配额锚点改造：旧配额优先消耗 + 平台时钟窗口 + msg_seq 显式发号 + 锚点失效兜底**（含两轮评审闭环）。出站被动锚点的选取/消耗/发号统一收敛到网关 `attachMsgIdWithQuota` 单点（此前 adapter 侧另有缓存兜底，两处口径可能不一致）：
  - **选取策略**：无显式锚点的出站从「只取最新 msg_id」改为**旧配额先用先耗尽**（`selectMsgIdForPassiveReply` 按接收时间旧→新，跳过窗口已过/额度耗尽候选）——为最新消息保留完整额度做它自己 turn 的回复锚点，**节省每日主动发送预算**。
  - **过期窗口对齐平台时钟**：入站登记时以**平台事件 timestamp**（`Date.parse`，NaN 回退本地时钟）幂等预注册配额窗口，替代旧「首次消耗时刻起算」的错误算法（真实过期时间是锚点**接收时刻**起算，不是消耗时刻）；msgid-cache 的 c2c TTL 30→60min，与配额层共用 `PLATFORM_PASSIVE_WINDOW`。
  - **msg_seq 显式单调发号**：替代 SDK 的准随机注入（可产生 0，且同 msg_id 下存在碰撞），插件自持 per-(account,msgId) 计数器从 1 起、经 `bot.send` 的 `extra.msg_seq` 显式下发，失败只回滚 count 不回退 seq。
  - **锚点失效兜底**：被动发送被平台 **40034005（msg_id 已过期）/ 40034128（回复次数超限）** 确定性拒绝时，剔除死锚点 + 回滚配额 + **同内容转主动重发一次**（此前这类失败会直接硬失败、无兜底，重复发锚点极易触发超限）；网络错（结果不明）与其他业务码不重发以免重复。
  - **评审闭环一**：progress card 等 `passiveOnly` 发送的死锚点**不转主动重发**（原错误上抛、不计每日预算——卡片绝不烧主动预算）；死锚点置 `dead` 标记防回滚复活（主动重发也失败时补偿回滚不得把 count 减回 limit 以下、死锚点被再次挂接）。
  - **评审闭环二**：配额缓存容量控制从纯 FIFO 改为**先清扫过期条目（含窗口已过的死锚点）、仍超限才 FIFO**，并让消耗/探测触达把活跃条目沉到队尾（LRU）——旧纯 FIFO 在稳态下淘汰的恰是「最旧且窗口未过」的活跃锚点（即旧配额优先要用的），淘汰后窗口被静默搬到当下 → 平台 40034005 → 烧每日主动预算；条目重建改用 msgid-cache 登记的**真实接收时刻**（诚实重建）而非 now+TTL。
  - 已知残余：媒体路径（SDK `sendMedia`）与 typing（SDK `sendInputNotify`）无 seq 透传位，仍走准随机 seq，单次碰撞概率约 4/65536，失败回滚可自愈；排障时勿按「seq 已完全受控」推断。回归测试 `tests/quota-manager.test.ts`、`tests/passive-anchor-selection.test.ts`。

- **SDK 依赖面守卫测试**（`tests/sdk-surface.test.ts`，盯版常态化）：把「插件引用的 `openclaw/plugin-sdk/*` 依赖面」固化为可执行断言，让**下一次**子路径消失在 CI 就红，而不是发版后炸。扫描 `src/**/*.ts` + `index.ts` 的全部 SDK 引用 → 断言每个子路径都在已安装包的 `exports` 内 → 用**裸 node 子进程**断言每个子路径都能 require 出来、且静态具名导入的值导出确实存在 → 额外断言 `dist/index.cjs` 能被 Node 原生 CJS 加载器 require（复刻生产加载路径）；并守住两条既有约定：ambient stub（`src/openclaw-plugin-sdk.d.ts`）声明的模块必须**确实仍无官方 `.d.ts`**（包一旦补上，ambient `declare module` 会遮蔽真实类型，typecheck 等于没验证），以及 devDependency 钉版必须精确钉在 peer 范围允许的最低版本。**扫描按引号字面量取子路径全集，不解析 import 语句形态**——初版只匹配静态 `import {…} from`，漏掉了四种同样承重的用法，评审实测确认下一版本子路径删除仍会全绿放行：`await import('…/approval-gateway-runtime')`（审批按钮 tap 核心路径）、`import('…/question-gateway-runtime')`（ask_user 问题流）、`getReq()('…/health')` 这类字面量惰性 require（workspace / pairing / media）、`export {…} from '…/setup-tools'`（adapter/setup.ts）；形态会随代码演化增删，解析语句必然再次漏，引号字面量才是稳定全集。**豁免必须显式登记**（`EXEMPT_SUBPATHS`，默认空）：`webhook-ingress` 虽在 adapter/webhook.ts 是 `.catch()` 降级用法，但刻意不豁免——子路径被删时 `.catch` 会把故障吞成"webhook 入站静默失效"，比直接抛错更难发现，这正是守卫最该管的场景。另有两处**防守卫自身失效**的自检：ambient stub 的 `.d.ts` 探测路径用"确定存在的 core 子路径"校准（初版路径拼接多了一层 `plugin-sdk/`，探测目标恒不存在，断言永久空转永不报警），以及扫描器覆盖度自检把六条非常规形态引用的子路径钉死（扫描器一旦退化回只认静态 import 立即报错）。**具名子句的值/类型分类也必须逐项判**：`import { fn, type Opts } from '…'` 的 inline `type` 标记若被剥掉后一律当值导出，接口在运行时不存在会让守卫误报"缺少运行时值"，把人引去查一个并不存在的 SDK 缺陷——而 inline `type` 是本仓库主流写法（当前 SDK 引用恰好都没用它，属侥幸）；该分类已抽成纯函数并用合成用例单测钉死，同时保留整条 `import type` 的类型计数（否则 `typeOnly` 退化为死字段、用例标题里的类型数恒为 0 而无人察觉）。**运行时断言必须放子进程**是本测试的另一处关键设计：openclaw 是 ESM 包、部分依赖（如 `unicorn-magic`）exports 只有 `import` 条件没有 `require` 条件，而 tsx 会 patch `Module._resolveFilename`，在 tsx 进程内直接 require 这些子路径会误报 `No exports main defined in unicorn-magic`——那是加载器差异、不是插件缺陷，误判会让人去改本来没坏的代码。

- **平台互动事件扩展类型观测**：官方 `INTERACTION_CREATE` 2026-07 扩容为统一「互动事件」（type 11–20），此前插件只认按钮（11/12）与配置面板（data.type 2001/2002），其余类型掉进 approval 分支被无意义 ack 后静默丢弃。现 `handleInteraction` 按外层 type 路由：仅 11/12 走按钮回调链（ack + question/approval）；13=消息反馈、14/15/16=QQ 官方智能体平台事件仅 INFO 留痕；18/19/20（用户/群主动推送授权）留痕并记入新增 `push-authorization-store`（内存、peer 维度、跨重启不保留）——平台事件不携带授权结果（开/关），存储只做「最近一次授权操作」的可观测记录；`/bot-group-info` 新增「推送授权事件」行，与主动消息用量排障关联（群主动推送平台侧默认关闭，群主不开开关主动消息送不达）。未来未知类型留痕不猜测、不 ack。类型层 `InteractionEvent` 注释与 resolved 字段对齐官方文档（`feedback_opt`/`checked`/`action`/`message_scene`/`authorize_data`/`application_id`）。经 Sourcery 评审两条意见闭环：(1) 观测 INFO 日志中的 operator/peer/消息标识符截断为前 8 字符（`/bot-logs` 可导出日志给 c2c 用户，默认授权开放，不落完整他人标识符）；(2) 授权事件按事件自身时间戳防乱序——网关重连补发的旧事件仅累计计数，不回退最新事实（缺时间戳退化为到达顺序）。回归测试 `tests/interaction-extended-types.test.ts`（15 用例）。

---

## [2.3.0] - 2026-10-08

### 新增

- **Progress Card（进度卡片）**（PR #37）：agent 的 `progress_card` 工具（会话级多步 checklist，整体替换式更新）每次成功更新时，插件把 checklist 快照作为**独立 QQ 消息**发送——QQ 无消息编辑 API（telegram 是同一条 draft 消息反复 edit；流式 update 只接受前缀增长，checklist 状态变化必然改行），只能逐条发。渲染复用框架共享渲染器 `formatPlanChecklistLines`（`openclaw/plugin-sdk/channel-message`，与 telegram 文本模式同源）：`📋 进度 N/M` 头 + `✅`/`▸`/`▢` 步骤行，超过 8 步自动压缩为 `✅ N/M done` 头 + 完成尾部 + 当前步 + 待办尾部。挂接 `replyOptions.onPlanUpdate`（telegram 同款契约）并传 `suppressDefaultToolProgressMessages: true` 解锁 verbose 关闭时的回调转发。**配额红线**：卡片只走被动回复——发送前 `getPassiveReplyQuotaRemaining`（quota-manager 新增纯探测）剩余 ≤ `reserveQuota`（默认 1，为最终回复保槽）即丢弃，探测账号经 `resolveQuotaAccountId`（含单账号回退，与 sendText 记账同键）；`sendText` 新增 `passiveOnly` 参数兜探测→发送竞态（配额不可用返回 `passive-quota-exhausted`，不降级主动——现有调用方不受影响），**绝不烧每日主动消息预算**。发送结果未知的失败（平台报错/网络异常）记为已发送防重发且计入 maxPerTurn；防抖窗口（1500ms）内跳过的最新快照由尾随定时器补发；deliverHandler 首个非 `tool` 投递（final/媒体/ask_user）即 `stop()` + `await drain()`——等 in-flight 发送落地再放行正文，卡片永不晚于答案；清卡重置去重状态。配置 `channels.qqbot.progressCard`（`enabled`/`scope`/`minIntervalMs`/`maxPerTurn`/`maxLines`/`reserveQuota`，c2c 默认启用、群显式 `scope: 'group'|'both'` 开启——群被动配额仅 5 条/5min）；room_event 群结构性无卡片（框架不转发 plan 回调）；restricted 群默认工具集加入 `progress_card`。注意：纯通道 Gateway 框架不注入 progress_card 使用提醒，要 agent 主动用卡需在其 AGENTS.md/SOUL.md 自行引导（README 已注明）。经 Sourcery 评审六条意见闭环（5 修 1 说明保留既有语义）。回归测试 `tests/progress-card.test.ts`（37 用例）。

---


## [2.2.2] - 2026-10-07

### 修复

- **`/usage` footer 并入正文同一条消息**（PR #35，2.2.1 用户反馈单独成条）：v2.2.1 把 footer 作为独立消息补发（QQ 无消息编辑 API，正文发出后不可追加）；但 final payload 到达时流式会话尚未 complete，尾巴可以并入——新增 `StreamingController.absorbFinalText`：stream 模式在收尾前把未流出尾巴作为前缀增长推入当前会话（与普通 token 增长同形态，平台无感知，footer 直接显示在流式消息末尾）、static 模式拼进待发缓冲随 `sendStatic` 一条发出（顺带省一条独立 sendText 的被动配额槽）；合并经 `mergeSegmentBoundary` 对齐 final 文本的分隔边界（防双空行）。吸收不了的残余场景（终态/无会话/缓冲已 flush）由 `[stream-final]` 兜底单独补发。经 Sourcery 四轮评审加固（9 条意见全部闭环）：isError payload 不吸收；合并 signal 中止不吸收且**信号传入 absorb、入队回调内重查**（TOCTOU 窗口）——已取消的回复不得继续增长；兜底抑制精确化为 `shouldSuppressFinalTailFallback`（仅「正文确定未送达」或「结果不明」抑制：static sendStatic 失败 / stream 无已接受分片 / update 网络层失败（ApiError `httpStatus===0`，平台可能已应用仅 ack 丢失，防重复宁缺毋滥；`httpStatus>0` 明确拒绝则照常兜底））；stream update 失败时对已有已接受文本的会话补发 DONE 收尾（防用户端流式状态永久悬挂）。回归测试 `tests/stream-usage-footer.test.ts`（26 用例）。

---

## [2.2.1] - 2026-10-07

### 修复

- **c2c 流式下 `/usage` footer 丢失**（PR #33，2026-10-07 用户反馈）：框架 `/usage off|tokens|full` 的 usage 行（`Usage: X in / Y out · cache … `）由框架在**模型输出完成后**追加到 final payload 文本尾部，`onPartialReply` 流式增量永远不含它——非流式路径整段发送 final 文本天然带上，但 c2c 开启 `channels.qqbot.streaming` 后 dispatch 的流式分支丢弃 final payload（"已由流式发过"去重），footer 随之丢失（telegram 用 final 文本整体收尾所以正常显示）。修复：`StreamingController` 记录最后已流出段落全文（`lastDeliveredSegmentText`），dispatch 流式分支暂存 final 文本，收尾 finalize 后 `computeUnsentRemainder` 按前缀差量把未流出尾巴作为独立消息补发（`[stream-final]`）。评审收紧（Sourcery 4 条）：仅在行首/串首边界认定多段拼接命中（防旧段内嵌重写文本误发）；归一化空白匹配按 token 序列取**原始结束偏移**切片（防 footer 截断）；static 模式 `sendStatic` 失败改抛错对齐 controller 契约且 failed 终态不补发（防"只见 footer 不见正文"）；补发 guard 改用合并中止信号（ctx.signal 中止同样抑制）。room_event 群 final 本就不投递，不受影响。回归测试 `tests/stream-usage-footer.test.ts`（16 用例）。

### 杂项

- 补同步 `package-lock.json` 根部 version 字段（v2.2.0 发版时遗漏，元数据停在 2.1.0）。

---

## [2.2.0] - 2026-10-06

> 版本号说明：含配置行为变更（工具策略来源从硬编码改为配置驱动），严格按 SemVer 应为 Major；因 `RESTRICTED_GROUP_TOOL_ALLOWLIST` 是代码内部常量而非用户配置，旧配置行为不变（无 tools 配置时走原 fallback），主人决定按 minor 处理。

### 修复

- **群配置大小写不敏感查找**（PR #30）：`lookupGroupEntry` 原来用 `Object.hasOwn(groups, groupOpenid)` 做精确匹配，框架传入的小写 session-key groupId 永远匹配不上用户配置的大写 openid，导致全部落到默认值 `restricted → { allow: [] }` → openclaw 9.6+ 把所有工具过滤 → room_event 群彻底沉默。改为精确命中 > lowercase 等值扫描。

- **resolveMentionPatterns 兼容 agents.entries（现行形态）**（PR #30）：`findAgentEntry` 原来只读 `agents.list`（数组，旧形态），但配置用的是 `agents.entries`（对象，2026.9.x 现行）→ 称呼唤醒（`mentionPatterns`）永远解析为空 → room_event 群"沈处"等唤醒词失效，该回的也不回。改为 entries 优先、list 保底。

- **RESTRICTED_GROUP_TOOL_ALLOWLIST 初始化含 message / cron / qqbot_remind**（PR #30）：插件首次返回非空白名单，保证旧配置升级后不会落到空名单导致群沉默。

- **setGroupRequireMention 写入前先解析现有键**（PR #31）：交互面板修改 `requireMention` 时直接按事件原始大小写写 `groups[groupOpenid]`，若事件大小写与配置键不一致会制造同一群的第二个变体键，与读取侧精确优先语义冲突。现改为写入前先调用 `resolveGroupConfigKey` 找到现有键再原地更新。

### 增强

- **群工具策略改为配置驱动**（PR #31）：`resolveToolPolicy` 不再硬编码工具白名单，改为先检查用户是否在 `channels.qqbot.groups.<groupId>.tools` 中显式声明了工具列表——有则透传，无则按 `toolPolicy` 字符串 fallback：`full`→undefined，`none`→显式全禁，`restricted`→`RESTRICTED_DEFAULT_TOOLS` 兜底（message/web_search/web_fetch/x_search/session_status/heartbeat_respond/view_image/tts/cron/qqbot_remind）。用户可通过 `groups.<id>.tools.allow` 自定义白名单（支持 alsoAllow/deny 合并、toolsBySender 按发送者精细控制）。对齐 Telegram 的配置驱动模式，从根本上消除「插件替用户决定哪些工具安全」的评审争议。

- **restricted 白名单移除隐私敏感工具**（PR #31）：移除 memory_search、memory_get、sessions、sessions_list、sessions_history、sessions_search、conversations_list、presence、get_goal、suggest_task、dismiss_task（跨会话数据读取/操作，群里被其他用户触发即为信息泄露）。配置驱动模式下，用户如需这些工具可在自己的 `tools.allow` 中显式声明。

---

## [2.1.0] - 2026-10-04

> 版本号说明：本版含配置键移除与失败路径行为变更，严格按 SemVer 应为 Major；因 `asrFallback`/`enabled` 仅存在于 v2.0.0（2026-10-04 当天发布，实际存活不足一天），主人决定按 minor 处理（2.1.0），视为"从未真正发布过的键"。

### 变更（Breaking）

- **移除 `channels.qqbot.stt` 行为开关，语音转录硬编码为两分支（平台转写仅在框架 STT 未配置时使用）**：`asrFallback` 与 `enabled` 两个插件级开关删除，`channels.qqbot.stt` 整块不再有任何生效键——检测到任何键（凭证 4 键 + `enabled`/`asrFallback`）打一次性迁移提示（`hasLegacySttCredentials` 改名 `hasLegacySttConfig` 并把两个历史开关纳入检测）。新策略：**框架 STT 已配置**（`tools.media.models` 存在 `capabilities` 含 `"audio"` 的条目，且 `tools.media.audio.enabled !== false`）→ 下载（`voice_wav_url` 优先 / SILK→WAV）提交框架转录，**严格信框架**——转录失败/为空/下载失败一律 `[Voice message - transcription failed]` 占位、不回退平台转写；**未配置** → 平台转写 `asr_refer_text` 直接作为唯一来源（零下载零外部调用），无平台转写 → `[Voice message - transcription unavailable]` 占位。连带语义：stt/fallback transcript 不再携带 `asrReferText`，`- ASR:` 元数据行仅在平台转写即来源时渲染。

### 修复

- **框架 STT 配置探测路径错误（v2.0.0 引入）**：`isFrameworkSttConfigured` 读的是 `tools.media.audio.models`，但 openclaw 2026.9.1 schema 中该路径不存在（`audio` 块类型为 `Omit<…, "models">`、无 models 键；类型注释原文「Models live only in tools.media.models」）——探测恒为 false，「框架 STT 已配置 → 下载提交转录」分支自 v2.0.0 起为死代码，所有安装实际都在走平台转写。现改为规范路径 `tools.media.models` + 显式 `capabilities` 含 `"audio"` 过滤（与框架 entry-capabilities 匹配语义一致）；无标签条目有意不认——保守漏判只是降级走平台转写，误判在严格模式下会变成彻底无转写（无标签 provider 条目框架会从 provider 注册表推断能力，插件侧无法廉价复刻）。README 双语配置示例同步修正为规范路径（CLI 形态 + `capabilities: ["audio"]` 标签，并注明 provider 形态）。`tests/voice-strict-mode.test.ts` 重写更名为 `tests/voice-transcript.test.ts`（20 用例锁新协议：探测边界含旧错误路径、遗留键不影响、下载失败严格占位、`- ASR:` 行渲染）。

---

## [2.0.0] - 2026-10-04

### 变更（Breaking）

- **语音转录迁移到框架音频理解管线，平台转写（asr_refer_text）转为默认兜底**：转录调用从插件自带的 OpenAI 兼容 HTTP fetch（`transcribeAudio`）改为框架官方 `openclaw/plugin-sdk/media-understanding-runtime` 的 `transcribeAudioFile`（2026.9.1 基线内即有此子路径，provider 注册表/附件缓存/SSRF 策略/错误语义由框架维护），STT 凭证只认框架级 `tools.media.audio.models`——与内置 Telegram 通道一致。**平台转写语义反转**：QQ 平台对语音消息自动 STT 并随事件 JSON 下发 `asr_refer_text`，现默认参与——框架 STT 未配置时**直接作为唯一来源**（无需下载、零外部调用），已配置时作为转录失败/为空的兜底；`channels.qqbot.stt.asrFallback: false` 恢复严格模式（所有场景丢弃平台转写，即 2026-08-17 起的旧行为）。**插件级 STT 凭证键 `provider`/`baseUrl`/`apiKey`/`model`（`channels.qqbot.stt`）废弃并被忽略**——检测到仍配置时打一次性 INFO 迁移提示，请把凭证迁移到 `tools.media.audio.models`（`enabled: false` / `asrFallback` 行为开关保留）。SILK→WAV 转码、`voice_wav_url` 优先下载、`sttDirectFormats`、`transcribed` media facts 语义均不变。`tests/voice-strict-mode.test.ts` 重写锁定新判定协议（22 用例：三态开关、框架配置探测、旧凭证检测、集成链路含下载失败兜底、`- ASR:` 行渲染）。

---

## [1.0.9] - 2026-09-23

### 修复

- **工具会话路由双层解析——修复延迟 turn 中 `qqbot_secret_input` 报「无法获取当前会话目标」**（PR #24）：三个 qqbot 工具（`qqbot_secret_input` / `qqbot_platform_api` / `qqbot_remind`）此前仅靠请求级 AsyncLocalStorage（`src/request-context.ts`，`handleMessage → dispatch` 异步子树内有效）解析当前会话目标。openclaw 框架经常把 agent turn **延迟到该子树之外**执行——活动 turn 之后排队的 followup / collect 批处理（群消息排队交给框架后的常态路径）、框架自有定时器驱动的队列 drain——此时工具执行处 ALS 为空，`qqbot_secret_input` 直接失败（2026-09-23 事故：LLM 调用工具保存 `OC_MIMO_BILLING` 报 `{"error": "无法获取当前会话目标，此工具仅支持在 QQ Bot 消息会话中使用"}`；空闲时立即执行的 turn ALS 恰好存活，故此前时好时坏）。修复：三个工具改用框架官方**工厂注册形式** `api.registerTool((ctx) => tool, { name })`——框架调用工厂时携带当次 run 的 `deliveryContext`（按当前 run 的 sessionCtx 派生的可信投递路由 `{channel:'qqbot', to, accountId}`，工具描述符缓存键含 deliveryContext 不会跨会话复用），新增 `src/tools/tool-session.ts` `resolveToolSessionRoute()` 双层解析：请求级 ALS 优先（逐消息精确），缺失时回退 run 级 deliveryContext，两者皆无（cron / 框架内部 run）返回可操作的明确报错。配套：secret-input 的 pending 改为登记在**实际发送账号**名下（`resolveGatewayForSend`，含单账号回退，与出站路径 issue #15 约定一致）——捕获中间件按其网关 accountId 查询 pending，键必须一致；**频道目标显式拒绝**（Sourcery 复审）：`parseTarget` 会把 `qqbot:channel:*` 归一化为 c2c，频道会话的延迟 turn 若不在 parseTarget 之前拦截会骗过「仅支持私聊」检查、把频道 ID 当 c2c openid 发卡，现 scope 从原始 route.target 显式判定，群/频道一律拒绝（`resolveToolSessionRoute` 保持接受 channel 路由——`qqbot_platform_api` 的频道 API 是合法用途）；`src/openclaw-plugin-sdk.d.ts` stub 补 `PluginToolFactoryContext` 与工厂版 `registerTool` 签名（真实 SDK 2026.9.1 已支持，stub 对齐）。新增 `tests/tool-session.test.ts`（12 用例：ALS 优先级、deliveryContext 回退复现延迟 turn 场景、群/频道目标拒绝、双缺失报错、工厂注册断言、remind 投递目标、pending 登记账号）。

---

## [1.0.8] - 2026-09-22

### 兼容性

- **构建基线与运行要求下调至 openclaw `2026.9.1`**（PR #22）：peer 范围从 `>=2026.9.2` 放宽为 `>=2026.9.1`——插件现可安装在 2026.9.1 网关上；devDependency 钉版同步降至 `2026.9.1`（typecheck 继续对最老支持面验证）。兼容性经两版已发布包逐项实测：2026.9.2 新增的 6 个 plugin-sdk 子路径（control-ui / feature-contract / feature-plugin / realtime-transcription-session / realtime-voice-provider / speech-provider）本插件均未使用；system-agent 审批面两版逐字一致（`ChannelApprovalKind`、`PendingApprovalView`、`resolveApprovalOverGateway` 双重载）；state DB schema 两版同为 `PRAGMA user_version = 15`，网关从 9.2 降回 9.1 打开现有 DB 不会被拒。**运行时行为零变化**（src 改动仅注释与错误文案），README 双语徽章与运行要求、AGENTS.md 基线段落同步更新。

---

## [1.0.7] - 2026-09-22

### 修复

- **入站消息不再携带自引用 `reply_to_id` 假签名**（PR #20）：`ctx-builder` 此前把 `reply.replyToId` 与 `supplemental.quote.id` 填成**当前消息自身 ID**（`envelope.messageId`），openclaw 框架把 `ctx.ReplyToId` 渲染为模型可见 Conversation info 的 `reply_to_id` 字段——于是每条消息都呈现 `message_id == reply_to_id`，被上层 agent 的 AGENTS 规则判为「内部回灌、非新指令」而拒绝响应。已观测症状：模型反复回复「这是 OpenClaw 内部上下文块——message_id == reply_to_id，是回灌，不重复响应」「这条 envelope 是 08:25:51 消息的第四次回灌」「这条 envelope 是我自己刚发的回复的回灌」「OpenClaw 系统级反射，疑似之前我的 reply 没被 ACK」等（「第 N 次回灌」为模型对会话记忆回放的计数误判，非真实重复投喂——插件 inbound-guard 30min 去重 / runId 幂等 / collect 队列一次性 drain 均核实无重复路径）。现对齐 telegram 原生通道契约语义：ReplyToId = 当前消息**回复(引用)的那条消息**的真实 ID（ref-index 命中时来自 `quote.entry.messageId`），无引用 / msg_elements 兜底解析拿不到 ID 时为 undefined，并加防御守卫——任何路径（含上游异常输入）不允许再现自引用值。QQ 被动回复锚点不受影响：`deliverCtx.replyToId`、msgid-cache 兜底（`resolvePassiveFirstReplyToId`）、`attachMsgIdWithQuota`、typing 均独立取值，threading `resolveReplyToMode: 'off'` 阻断框架隐式回复线程。新增 `tests/inbound-replyto-id.test.ts`（8 用例，含 Sourcery 复审补齐的 `supplemental.quote.id` 红线断言）。
  - **升级后配套（重要）**：删除 agent 层 AGENTS.md 中「message_id == reply_to_id 即回灌」类规则——它是被此假签名逼出的 workaround，修复后 `reply_to_id` 只在真正引用消息时出现（且指向被引用消息），该规则永久失配。

---

## [1.0.6] - 2026-09-21

### 修复

- **`message` 工具主动发送不再报 `Bot "default" not running`**（issue #15，PR #17）：openclaw 框架的 `message` 工具在后台任务 / bootstrap 兜底注册表上下文会经 jiti 二次加载产生插件的**另一个模块实例**，旧实现的 gateway 注册表是模块级 `Map`——第二实例的注册表为空，`getGateway("default")` 恒 miss，所有框架侧主动发送（媒体尤甚）失败；而会话回复走同实例直连不受影响，表现为「文本正常流出、kind=image 从未出现、`[tx]` 网关日志零条目」。三层修复：
  - **gateway 注册表桥接 `globalThis`**（`Symbol.for`，主修复）——所有模块实例共享同一份注册表，双实例场景下按 accountId 精确路由到真正运行的网关；
  - **发送路径单账号回退**——gateway 查找 miss 且注册表恰有一个运行中账号时回退发送（打一次 INFO 便于取证）；0 个或多个运行中账号时不盲路由（OpenID 跨账号不通用），错误信息附运行中账号列表，多账号排障不再盲猜；
  - **`resolveDefaultQQBotAccountId` 可运行性感知**——只在 default 账号「可运行」（配置内 appId + 任一凭证来源 + enabled）时返回 `default`，否则回落到第一个可运行的命名账号；凭证备份只补 secret 不补存在性（appId 必须在配置内，保证「被选中 ⇒ 可被枚举启动」的一致性）。完整顶层配置（常规单账号形态）行为不变。
- **回退发送的被动配额按实际发送账号记账**（Sourcery 复审）：平台配额按「真实发送账号 × msg_id」计，回退场景此前记在请求键下会绕过或误伤限额；`resolveGatewayForSend` 现返回 `{gw, accountId, fallbackFrom}`，配额预留/回滚统一用实际发送账号。
- **`unregisterGateway` 所有权守卫**（Sourcery 复审）：共享注册表后，旧模块实例延迟执行的 stop 不再可能删掉新实例已注册的替代网关（带 gateway 引用做身份比对；登出路径保持无条件删除）。

### 加固

- `outbound-service` 模块级 logger 改惰性创建——该模块处于 `bot-instance → outbound-service → plugin-logger → runtime → bot-instance` 循环依赖环上，顶层求值会在环半初始化状态下崩溃。
- 新增 `tests/proactive-account-fallback.test.ts`（18 用例）：globalThis 桥存在性与 dist 产物读写契约（子进程验证）、单账号回退（文本+媒体）、多账号不盲路由、回退配额记账键（同 msg_id 第 5 次降级主动）、默认账号解析全形态、注销所有权守卫。

---

## [1.0.5] - 2026-09-14

### 修复

- **ask_user 卡片投递后不再误报 "Agent run failed"**（issue #11，PR #12）：模型未流式输出文本直接调用 `ask_user` 工具时，卡片通过 `bot.sendTextWithKeyboard()` 成功投递给用户，但 `StreamingController` 的 `sentChunkCount` 仍为 0，turn 结束时 `finalize()` 走 `finalize:fallback` 路径，框架 `replyResolver` 将其解读为投递失败，Web UI 误显 "Agent run failed"。新增 `markDeliveredExternally()` 方法，插件在 ask_user 卡片发送成功后调用，`handleFinalize` 检测到外部投递后走 `finalize`（成功）而非 `finalize:fallback`（失败）。

---

## [1.0.4] - 2026-09-14

### 修复

- **流式会话中 agent run 失败不再静默**（issue #8，PR #9）：c2c 流式已启动且首分片已送达后模型失败（如空闲超时），框架经 deliver 回调投递的 `isError` 失败通知 payload 此前被 deliverHandler 的流式去重早退吞掉——「final 已由流式发过」的假设对失败文案不成立（它从未进入流式通道），用户只见首分片后静默，WebUI ⚠️ 是唯一失败信号；插件自身的 `FAILURE_FALLBACK` 兜底也不触发（dispatch 正常 resolve + 已有可见回复）。现 `payload.isError === true`（框架 `markAgentRunFailureReplyPayload` 必置）绕过去重早退、落到默认路径静态发出（stream 模式先收尾打字机流再发）；非 error payload 的去重行为不变。`mode:'partial'+sendMode:'static'`（生产形态）、`partial/stream`、`mode:'off'` 三种配置全覆盖，回归测试 `tests/dispatch-error-notify.test.ts`（5 用例）钉住。

---

## [1.0.3] - 2026-09-11

### 移除的功能

- **移除 `qqbot-remind` skill**（PR #7）：删除 `skills/qqbot-remind/` 目录（SKILL.md 引导文档存在问题，不再随 npm 包分发），`openclaw.plugin.json` 的 `skills` 清单同步移除注册。**`qqbot_remind` 工具本身保留**（`src/tools/remind.ts` 与 `contracts.tools` 注册不变），宿主 AI 仍可经工具描述直接发现与调用，仅少了引导文档；`qqbot-channel` skill 不受影响。已安装用户升级后该 skill 自动消失，无需任何配置迁移。

---

## [1.0.2] - 2026-09-10

### 可观测性补全（日志全链路覆盖，PR #5）

纯日志与防御性 catch，**无任何业务逻辑 / 中间件链 / 发送行为变化**。修复日志覆盖审计发现的系统性盲区——INFO 级别下插件工作状态全程可见：

#### 出站链路

- **出站成功统一 `[tx] sent` INFO**：在 `wrapBotSendForRefIndex` 包装层打点（kind/scope/target/msgId/passive/contentLen）——gateway 五个 send 方法与中间件 `bot.sendText` 直调的单一卡点，此前成功发送插件层零日志、只能靠 SDK 状态行倒推。
- **框架契约出站路径接入 logger**（`[outbound]`）：框架直发 / `message` 工具 / cron announce 路径的配额降级 INFO 与回滚 DEBUG 此前因不传 log 是死代码；媒体消息配额降级补 INFO（此前完全无日志）。
- `qqbot_secret_input` 工具：卡片发送失败 ERROR、pending 登记成功 INFO。

#### 命令与交互审计

- **`/bot-*` 命令执行审计**：全部 11 个内置命令每次调用打 `[cmd]` INFO（命令/执行者/scope/raw 截断 80 字符），越权尝试打 WARN——含 `/bot-clear-storage`（删存储）、`/bot-approve`（安全相关）；配置 persist 失败 WARN。
- **审批交互留痕**：授权通过的按钮点击 `[approval] tap` INFO、resolve 成功 `[approval] resolved` INFO（此前仅越权 WARN / 失败 ERROR，合法成功的审批不留痕）；审批卡投递成功/失败日志。
- 单问题 ask_user resolve 结果 DEBUG→INFO（与多问题流程对齐）；四处交互初始 ack 失败静默 catch 补 DEBUG。

#### 静默吞错与裸 promise 加固

- 配对审批 CLI（`approveViaCli`）：收集 stderr 尾部（≤500 字符），spawn 失败与非零退出打 WARN——区分「CLI 坏了」与「配对码无效」。
- webhook ingress 管线动态 import 失败打 WARN（此前整条请求路径静默降级 handleSimple 无痕迹）。
- access-control 配对挑战回复 / secret-capture 被动+主动回复失败由 `.catch(()=>{})` 改为 WARN。
- **消除 unhandledRejection 风险**：debounce 定时器 flush、typing 续期定时器经 `.catch` 封口；`notifyOutboundMessageSent` 监听器逐个隔离（单个坏订阅方不再能炸掉发送成功路径）；history-store 异步 append 兜底。

#### 低优先补全

- 账号启动 INFO（accountId/appId/enabled/secretSource/transport——secret 只打来源不打值）。
- webhook 每请求 DEBUG 访问日志；签名全不匹配 401 升 WARN（与管线路径对齐）。
- `qqbot_platform_api` 工具每调用 INFO（method/path/耗时），失败 WARN（status/bizCode）。
- quota-manager 拒绝路径（无 msgId/过期/耗尽）DEBUG 留痕；setup 手动绑定路径补 `rt.log`。

#### 测试与不变项

- 新增 `tests/command-audit.test.ts`（7 用例：注册完整 / 返回值透传 / INFO 字段 / raw 截断 / authorized 通过与拒绝 / SDK 可选方法形态 / 数组别名）。
- **入站消息追踪维持 DEBUG 级**（设计决策不变）：INFO 级别下正常流量保持安静，只看异常与拦截（`[guard]`/`[rawEvent]`）。
- `setup/login.ts` 的 QR 终端输出保留（用户界面非日志）；`ssrf-guard` 的 console.warn 保留（纯 util，caller 已有日志）。

---

## [1.0.1] - 2026-09-10

### 移除的功能

- **移除「命令自动更新插件」功能**：删除 `/bot-upgrade` 指令、npm 版本检查器（`src/features/update-checker.ts`）与 `qqbot-upgrade` 技能（原宿主 AI 自动执行 `openclaw plugins install` + `openclaw gateway restart`）。插件不再访问 npm registry，`/bot-version` 只显示当前已安装版本与框架版本。
  - 配置字段 `channels.qqbot.upgradeUrl` 一并移除；已配置该字段的用户无需操作，多余字段会被忽略（schema `additionalProperties: true`，不会报错）。
  - 今后的升级方式：在宿主机手动执行 `openclaw plugins install @jerryliang122/openclaw-qqbot`，然后 `openclaw gateway restart`（见 README「快速开始」）。

---

## [1.0.0] - 2026-09-09

### 1. 与上游旧版本（2.x）的差异总览

以下能力为本仓库在长期使用中重构/新增，上游版本（含 2.1.0）不具备或行为不同：

#### 群聊架构

- **群聊三模式矩阵**：同时支持群主可选的三种推送模式——AT 纯模式（仅被 @ 收到事件）、AT+最近 N 条（`msg_elements` 携带上下文，≤10 条，含 per-element 作者与 message_type=102 聊天记录识别）、全量模式（每条消息推送 `GROUP_MESSAGE_CREATE`）。两事件共用同一 intent 与中间件链，插件按 per-group 推断实际模式（`src/features/group-mode-store.ts`），模式变化打 INFO 日志。
- **群消息排队完全交给框架**：消息逐条立即 dispatch，排队/合并由 OpenClaw followup 队列承担（`coalesce.enabled=true` → `collect` 合并批处理；`false` → `followup` 排队不合并）。群 turn 使用 `exclusive` admission 且不传 abortSignal——进行中的 turn 结构性不可被打断。
- **room_event 房间事件**（`unmentionedInbound: 'room_event'`，默认关）：全量模式群里未被唤醒的消息作为被动房间事件进框架——AI 只读上下文、最终文本不投递（结构性沉默）、只能通过主动 `message` 工具发言；被 @/称呼/引用时恢复正常回复。
- **三种唤醒方式**：@提及（事件/mentions.is_you/内容标记）、称呼唤醒（`agents.list.<id>.groupChat.mentionPatterns`，如 `["沈处"]`）、引用 bot 出站消息（ref-index 隐式提及）。
- **群历史模式 historyMode**：`clear`（回复后整清）与 `rolling`（bot 出站计入历史，裁剪到最后一条 bot 发言之后，对齐 telegram selectAfterLastSelf）。
- **群级配置 ??-级联**：`groups.{gid}` > `groups."*"` > 账号级默认 > 内置默认，覆盖 requireMention / ignoreOtherMentions / toolPolicy / name / prompt / historyLimit / historyMode / unmentionedInbound / coalesce。

#### 出站与配额

- **被动优先出站**：全链路 msg_id 优先，保护主动消息每日 1000 条预算。挂载 msg_id 前经 quota-manager **原子预检+扣减**（群 5 次/msg_id/5min，c2c 4 次/60min），配额耗尽自动降级主动发送，API 失败自动 rollback——彻底消除平台 40034128 硬失败无兜底的问题。
- **主动预算计量**（`src/features/proactive-budget.ts`）：按账号按天计数、跨天重置、80% 告警，`/bot-group-info` 可查。
- **msgid-cache**：c2c 30min / 群 5min（与平台被动窗口对齐），静群（窗口内无消息）只能主动发送——平台约束。
- **typing 配额感知**：typing 通知与回复共享被动配额，耗尽自动降级主动；20s QPS 约束自动钳制；出站消息后 5s 自动续期。

#### 可靠性与观测

- **入站事件守卫**（inbound-guard）：拦截出站回声（群按 author.bot、c2c 按 outbound-echo-store 比对）、重复推送（msg_seq/msg_idx 30min 长窗口去重）、空内容事件；带 msg_elements 的引用/转发消息放行。每次拦截打 INFO `[guard]` 日志。
- **rawEvent 观测**：未被 SDK 映射的平台推送（入群申请、好友变动、reaction、media_upload_finish、未来新增类型）统一 INFO 记录，消除静默丢弃盲区。
- **三层限流默认开启**：sender 20/min、group 60/min、global 300/min 滑动窗口，`channels.qqbot.rateLimit` 可覆盖或关闭；room_event 群强烈建议保持开启。
- **member_role 提取**：admin/owner 从 raw.author 提取进 `sender.roles`，供框架权限分级。
- **凭证备份**（credential-backup）：gateway 启动后写凭证快照，热更新被打断时自动恢复。

#### 平台能力

- **指令面板自动同步**：gateway ready 后把 openclaw essential 原生指令注册到 QQ Bot 指令面板（`/v2/panels`，经 SDK 通用网关），c2c/group 各一个面板，remark 打标幂等，用户手建面板绝不触碰；`channels.qqbot.commands.native` 门控（默认 true）。
- **ask_user 交互**：单问题 → inline 按钮键盘（`questionGatewayRuntime.resolveOption` 认领）；多问题（2-3 题）→ 每题一张带按钮的卡片 + 答案缓冲 + 指令按钮确认卡（客户端以真实用户消息发出，走框架原生 keyed 文本认领）；isOther 题有「✍️ 其他」预填按钮。**绝不程序化提交多问题答案**、**绝不拦截真实入站消息**。
- **密钥输入**（`qqbot_secret_input` 工具，c2c）：AI 发卡片 → 用户下一条消息被中间件拦截 → `openclaw secrets store set`（恒为 `env` kind，AI 可读）→ 消息绝不进入 AI 转录。多问题 ask_user 挂起时红线放行。
- **`qqbot_platform_api` 工具**：任意 path 的平台 REST 调用（自动鉴权/重试），覆盖 SDK 未封装的新接口（群禁言、入群审批、自定义菜单等）。
- **`qqbot_remind` 工具**：cron 主动消息提醒。
- **域名切换能力**：默认仍走旧域名 `api.sgroup.qq.com`，`QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` 环境变量随时切换 `api.bot.qq.com`，无需等 SDK 发版。
- **SSRF 防护**：插件自身媒体/图片 fetch 经白名单与私网拦截（media-runtime 不可用时不再降级裸 fetch）。

#### 工程与构建

- 构建基线钉版 openclaw `2026.9.2`（devDependency 精确钉版，typecheck 对最老支持面验证）；peer `>=2026.9.2`。
- tsup CJS 产物 + `new Function` 别名改写（规避安全扫描误报）；`preload.cjs` 同步保证 plugin-sdk 可解析。
- 全部测试统一 `node:assert` + `tsx` 直跑风格，无外部测试框架依赖。
- `npm run lint:runtime`：扫描 adapter/ 之外的直接 runtime 访问。

### 2. v1.0.0 移除的兼容性功能（Breaking Changes）

与上游断开后，**所有针对旧环境的兼容层一次性清除**。从上游 2.x（或本仓库更早状态）升级到 1.0.0 前请核对：

#### 运行时兼容（openclaw < 2026.9.2 的探测/回退）

- 删除 `channel.turn.run`、`reply.finalizeInboundContext`、`reply.formatInboundEnvelope`、顶层 `getConfig`/`config.loadConfig`、`writeConfigFile` 及裸写 `~/.openclaw/openclaw.json` 等全部旧 API 回退（src/adapter/resolve.ts）
- 删除 dispatch 的「无 inbound.run 时手动 session + dispatchReply 直调」低版本整条分支
- 删除 setup/media/workspace/pairing/question-helpers 各子路径加载失败的降级实现；media 不再降级裸 fetch（安全考虑）
- 配对审批（`/bot-pairing approve`）改为 spawn 与网关同源的 `openclaw pairing approve` CLI（`approveChannelPairingCode` 无稳定导出）
- `preload.cjs` 删除旧 tsc `.js` 产物回退，只加载 `dist/index.cjs`

#### 用户配置兼容

| 移除项 | 替代写法 |
|---|---|
| `streaming: true/false`（布尔旧格式） | `streaming: { "mode": "partial", "sendMode": "stream" }` |
| 环境变量 `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET` | `QQBOT_APPID` / `QQBOT_SECRET` |
| `voiceDirectUploadFormats` | `audioFormatPolicy.uploadDirectFormats` |
| `processingTimeoutMs`（早已无效的死配置） | 无（并发控制由框架 session lane 承担） |
| `coalesce.strategy: "plugin"` 与 `maxBuffer` | 无——插件内合并器已删除，排队完全交给框架；只保留 `coalesce.enabled` |
| `OPENCLAW_PROCESSING_TIMEOUT_MS` 环境变量 | 无 |
| 审批目标解析的 `qqbot:direct:` 旧 scope | `qqbot:c2c:`（框架实际产生的格式） |

#### 死代码与旧生态

- 删除 onboarding 适配器（2026.9.2 SDK 已无该概念，引导入口统一为 setupWizard）
- 删除 `bin/qqbot-cli.js`（其 install/upgrade 安装的是**旧上游包** `@tencent-connect/openclaw-qqbot`，对本仓库完全错误）
- 删除 `scripts/cleanup-legacy-plugins.sh`、`upgrade-via-npm.sh`、`upgrade-via-npm.ps1`、`upgrade-via-source.sh`、`set-markdown.sh` 与 `docs/UPGRADE_GUIDE*.md`（全部指向旧上游 URL / clawdbot 生态）
- 清除全部 clawdbot / moltbot 残留（日志发现、CLI 名单、dev 脚本、版本探测）
- 删除孤儿模块 `tts-provider.ts`、`cron-scheduler.ts`、`image-size.ts`
- `getOpenclawVersion` 裁剪为直接读 `PluginRuntime.version`
- 本地 SDK 类型 stub 裁剪（onboarding 类型组、deprecated 成员、旧版 rt.log 声明）

#### API 变化（插件导出面）

- 移除导出：`qqbotOnboardingAdapter`、`consumePassiveReplyQuota`、`stripMentionText`/`detectWasMentioned`/`TEXT_CHUNK_LIMIT` 的兼容 re-export（内部请直接 import 源模块）
- `checkPassiveReplyQuota` 语义改为纯探测（不消耗配额）；需要消耗请用原子 API `checkAndConsumePassiveReplyQuota`（含 rollback）
- `/bot-pairing approve` 返回 `{approved}` 布尔语义

### 3. 升级到 1.0.0

```bash
# 从旧版本升级（含上游 2.x 装机）
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git#v1.0.0

# 或源码安装
git clone https://github.com/jerryliang122/qqbot-openclaw.git
cd openclaw-qqbot && npm install && npm run build
openclaw plugins install .
```

- 先确认 OpenClaw 框架 >= 2026.9.2（`openclaw --version`）
- 按上表迁移配置项；旧 key 会被静默忽略（不再有迁移逻辑）
- 群会话 lane 不受影响：session key 的 `:coalescing` 后缀保留，存量会话连续

---

## 发版操作手册

1. 更新 `CHANGELOG.md` 新版本段落
2. `package.json` 的 `version` 改为目标版本，并同步 `package-lock.json` 根部两处 `version` 字段（`version` 与 `packages."".version`，只改字段不重装依赖——v1.0.3 曾遗漏导致 lock 元数据停在 1.0.2）
3. 以上改动经 PR 合并进 main（**main 为保护分支，禁止直接 push**），然后在合并提交上打 tag：`git tag v1.0.0 && git push origin v1.0.0`（branch protection 不拦 tag push）
4. GitHub Actions（`.github/workflows/release.yml`）自动：校验 tag 与 package.json 一致 → typecheck / lint / build / 全量测试 → **`npm publish`（发布 `@jerryliang122/openclaw-qqbot`，OIDC Trusted Publishing）** → `npm pack` → 创建 GitHub Release 并附 tarball

**npm 发布前置（一次性配置，OIDC 免 token）**：

1. **首发引导**：npm 无 pending publisher 机制，全新包不能用 OIDC 首发——在已 `npm login` 的本机手动发布第一个版本一次（`npm run build && npm publish --access public`）。发版 workflow 检测到该版本已存在会自动跳过 publish、照常创建 GitHub Release。
2. **关联 Trusted Publisher**：npmjs.com → 包 `@jerryliang122/openclaw-qqbot` → Settings → Trusted publishing → 添加 GitHub Actions：`jerryliang122` / `qqbot-openclaw` / workflow 文件名 `release.yml`（大小写敏感，可留空 Environment）。
3. 之后所有版本由 CI 经 OIDC 自动发布，无需任何 npm token（建议随后在包设置中开启「Require 2FA and disallow tokens」彻底封死 token 发布）。
   - 要求：Node ≥ 22.14 / npm ≥ 11.5.1（workflow 已用 Node 24）；`package.json` 的 `repository.url` 必须与 GitHub 仓库一致（已一致）。

---

<details>
<summary><strong>上游历史版本记录（v2.1.0 及以前，来自 tencent-connect/openclaw-qqbot，仅供溯源）</strong></summary>

# Changelog (upstream lineage)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [2.1.0] - 2026-08-17

### Changed

- **`asrFallback` semantics tightened**: QQ's built-in platform transcript (`asr_refer_text`) is now discarded in **all** cases unless `channels.qqbot.stt.asrFallback` is explicitly set to `true` — including when STT is not configured at all. Previously, unconfigured STT silently fell back to the platform transcript. Voice messages without any transcript source now render as `[Voice message - transcription unavailable]` (the audio URL is still referenced via the `- Voice:` line).
- The `asrFallback` flag is now read directly from the raw config, independent of whether STT credentials resolve — `stt: { "asrFallback": true }` alone restores the legacy platform-transcript behavior.

### Fixed

- `src/adapter/media.ts` no longer throws at import time under ESM (tsx): the `createRequire` anchor is now resolved lazily (`__filename` under CJS bundles, cwd under ESM).

## [2.0.1] - 2026-08-09

### Improved

- Enhanced message dispatch stability with better handling and logging for skipped dispatches.
- Relaxed runtime capability checks for broader OpenClaw version compatibility.

### Fixed

- Fixed the `/bot-upgrade` upgrade guide link.

## [2.0.0] - 2026-07-13

### Added

- **Modular Layered Architecture**: Refactored codebase into 12 sub-modules (adapter / dispatch / gateway / middleware / outbound / transport, etc.) for better maintainability and extensibility.
- **Runtime Adapter**: New runtime adaptation layer supporting automatic multi-version OpenClaw SDK compatibility, including older OpenClaw versions.
- **Outbound Pipeline**: Unified outbound delivery pipeline (TTS voice → media → text debounce) with streaming controller, reply rate limiter, and outbound text sanitization (strips thinking tags).
- **Middleware Layer**: Three new middlewares — access control, attachment processing, and policy injection — with flexible composition support.
- **New Slash Command**: `/bot-pairing` (QR code pairing).

### Changed

- Build switched to `tsup` pre-compilation (`dist/index.cjs`) for faster loading.
- `qqbot_channel_api` tool renamed to `qqbot_platform_api`.
- Dependency upgrades: `@tencent-connect/qqbot-connector` 1.2.0, added `@tencent-connect/qqbot-nodejs ^1.0.3`.

</details>
