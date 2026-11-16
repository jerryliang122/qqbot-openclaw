# 持久化群聊入站（durable group ingress）

> 深度参考文档。改群聊入站缓冲 / 合批 / 排序 / 幂等前必读。
>
> 状态：**已落地**（本 PR）。取代 `docs/agents/group-and-room-event.md` §「群消息合并在插件侧做」里描述的**纯内存**合批模型；内存合批保留为**降级路径**。

## 1. 为什么改（三个真缺陷）

改造前的群聊入站缓冲是**纯内存**的插件侧合批（`src/features/group-merge.ts` + `createInboundDebouncer`），三个缺陷都是线上可复现的：

| 缺陷 | 现象 | 根因 |
|---|---|---|
| **批次错乱** | 同一批消息在模型眼里顺序与群里实际发言顺序不一致 | 合批按 `Date.parse(msg.timestamp)` 排序——那是**客户端发送时间**，群成员设备时钟不一致就排错 |
| **忙闲提前归零** | 群 agent 还在干活，新到的消息没被攒进批，散成一个个 turn | busy 信号挂在 `dispatchToOpenClaw` 的 promise 生命周期上；框架把 turn **defer**（仅入队）时 promise 就 resolve ⇒ busy 归零 |
| **重启即蒸发** | 攒到一半的批次随进程退出消失 | 缓冲只在内存里，没有任何持久化 |

框架的 followup 队列也救不了：它的 `collect` 合批对「同群不同人」无效（分组键含 `senderId`，遇第一个不同 key 就 break），且 `cap` 溢出时**丢弃最老的消息**。

## 2. 架构分层

对齐 openclaw 2026.11.4 的 Telegram L1–L5 架构，落在框架已有的通道入站抽象上（**不是**自造一套）：

| 层 | 职责 | 落点 |
|---|---|---|
| **L1 载荷** | 活上下文 → 纯数据快照（可 JSON 序列化，能落盘） | `src/features/ingress-payload.ts`（`buildIngressPayload` / `decodeIngressPayload` / `rebuildIngressMember`） |
| **L2 队列** | per-account 的持久化队列 + lane 键 + 租约 | `src/features/ingress-queue.ts`（`openChannelIngressQueue` / `openChannelIngressDrain`） |
| **L3 租约/心跳** | claim 所有权、stale claim 回收、deferred 心跳 | core 的 drain（`claimLeaseMs` / `adoptionStallTimeoutMs` / `deferredLaneOccupancy:'hold'`） |
| **L4 组批** | lane backlog 组批、容量裁剪、正文装配 | `src/features/ingress-batcher.ts`（`dispatchClaimedGroupEvent`） |
| **L5 幂等** | 批次指纹 + 持久化副作用守卫 | `createIngressEffectOnce`（`openclaw/plugin-sdk/ingress-effect-once`） |

**lane 键** = `qqbot:{accountId}:group:{groupOpenid}`——**按群不按人**（同群不同发言人可同批，这是插件侧合批存在的唯一理由，框架 collect 做不到）。**队列行 id** = `qqbot-group:{accountId}:{messageId}`——加前缀隔离跨账号撞号（OpenID 跨账号不通用但也不保证唯一）。

**排序权威 = 本地到达时刻 `receivedAtMs`**（`ingressPayloadOrderKey`）。平台 timestamp 只留档、不参与排序——群成员设备时钟不一致，用它排就是把批次排错。

## 3. 忙闲判定：durable lane claim

改造前的 busy 信号（`group-session-busy.ts`，per-群 in-flight 计数）已从群路径退役。新的判据是**lane 是否有在途 claim**（`drain.activeLaneKeys()`）：

- 队列里同一群的行，只有队首被 claim 时才会组批并派发；
- 队首行的所有权交给**回复车道**（`turnAdoptionLifecycle.onAdopted` ⇒ drain tombstone 该 claim）；
- turn 被 defer（仅入队框架队列）时 **claim 仍然持有** ⇒ 忙闲判定不提前归零（这正是原缺陷的修复点）。

`dispatch.ts` 侧新增 `ingressLifecycle` 选项：有它时 `turnAdoptionLifecycle` 改走框架原语 `bindIngressLifecycleToReplyOptions`（纯 1:1 映射：admission exclusive + `onAdopted`/`onDeferred`/`onDeferredHeartbeat`/`deferredHeartbeatIntervalMs`/`onAbandoned`/`abortSignal`）。**drain 钩子抛错必须隔离**——框架会 `await turnAdoptionLifecycle?.onAdopted()`，钩子抛错会冒泡成 turn 失败。

## 4. 组批与旁路

drain 领到队首行后：

1. **窗口收集**：在**合批窗口**内反复重读同 lane 的 pending 行（`lifecycle.readLaneBacklog`），逐行 `queue.claim` 领下**额外行**（领不到就跳过，不阻塞整批）；**收满（`maxBatchSize`）即发**，不等窗口走完；窗口耗尽 ⇒ 用当前批次派发。等待期间 claim 一直持有（租约 5 分钟），且可被 `abortSignal` 打断（退出 / drain dispose 立刻放行，不等满窗口）；
2. 按 `receivedAtMs` 排序；
3. 容量裁剪（沿用 `maxBatchSize` / `GROUP_MERGE_MAX_BODY_CHARS`，超限丢弃**较早**的并在前置一行 `[已丢弃 N 条…]`）；
4. 复用 `assembleMergedGroupBody` 装配正文（格式与改造前逐字一致）；
5. 派发（`dispatchToOpenClaw` + `ingressLifecycle`）。

### 4.1 合批窗口的来源（用户拍板 D-c）

窗口时长 = **框架 `resolveInboundDebounceMs(cfg,'qqbot')`**（`src/features/ingress-batcher.ts` 的 `resolveGroupMergeWindowMs`）：

- **不新增群专属配置键** ⇒ `openclaw.plugin.json` 的 `coalesce` 段（顶层 + `accounts.<id>` 两处）逐字不动 ⇒ `tests/manifest-config-schema.test.ts` 无需改动；
- 用户已有的 `messages.inbound.byChannel.qqbot.debounceMs`（或 `messages.inbound.debounceMs`）旋钮**直接生效**——此前群路径用的是插件内硬编码的 `DEFAULT_GROUP_MERGE_WINDOW_MS`（3000），该旋钮对群聊**完全无效**；
- ⚠️ 框架该原语**默认返回 0**（不读插件默认、不套 c2c 的 3000）⇒ 未配框架 `messages.inbound.*` 时窗口为 0 ⇒ 领到队首行**即刻派发**（零延迟，与改造前的「空闲时零延迟直发」一致）；
- 窗口上限 60s（框架 c2c 侧同款上限）——窗口过长会让「一条消息等窗口」变成用户可感知的延迟。

**旁路项不并入批次**（斜杠命令 / 控制命令 / ask_user keyed 答案 / stt·fallback 来源语音），必须单独成轮。判定在**入队时**做并**冻结进载荷**（`payload.bypass`）——合批发生在 claim 之后，那时已读不到活状态（pending question store 是进程内的、附件是活对象）。判定口径**共用** `group-merge.ts` 的 `isBypassGroupItem`（单一事实源，两处各写一份必然漂移）。

**批内任一条「在叫 bot」⇒ 整批按 `user_request` 投递**（否则「用户 @ 了 bot 却没回音」）。置位必须在**装配之后**——装配器按各成员自己的 mention 状态渲染 `(@you)`，先置位会把载体虚标成「叫了 bot」。

## 5. 幂等：批次指纹

指纹 = `sha256(laneKey | 最小 messageId | 最大 messageId | 条数)`。同一批消息无论被重投多少次、无论谁先谁后，集合相同 ⇒ 指纹相同 ⇒ `createIngressEffectOnce` 只放行一次副作用。

⚠️ **core 的 `createIngressEffectOnce` 自承 at-least-once**：「A process death after `run()` succeeds but before the claim commits can still execute the effect again on recovery」——崩溃点落在「副作用已执行、commit 未落盘」之间时，回复**可能**重复一次。这是框架契约，插件侧无法消除，只能靠指纹把「整批重投」收敛成「一次」。

指纹命名空间 `qqbot-group-batch` **跨版本必须稳定**——改了等于放过一次重复回复。

## 6. 降级路径（不可用时的行为）

core 的 loader 在部分路径下把 `openChannelIngressQueue` 打成 `unavailable(...)` stub（调用会抛）⇒ **必须探测**，不可用时回落：

```
enqueueDurableGroupInbound() → 'handled' | 'not_applicable' | 'unavailable'
```

| 结果 | 含义 | 调用方行为 |
|---|---|---|
| `handled` | 已持久化 | 后续由 drain 派发，**绝不直发** |
| `not_applicable` | 非群消息 / `coalesce.strategy !== 'plugin'`（用户显式交回框架队列） | 直发（legacy 语义不变） |
| `unavailable` | 队列 API 不可用或入队失败 | 回落内存合批（`enqueueGroupInboundMessage`），接不住再直发 |

**宁可失去耐久性，不可丢消息**——入队失败时必须回落而不是静默丢弃。

## 7. 硬边界（本 PR 锁死）

- **C2C 私聊零改动**：`src/features/inbound-debounce.ts` 与 `handleMessage` 的 `scope==='c2c'` 分支**一行不动**（`tests/ingress-boundary.test.ts` 源码级守卫）。
- **配置面零变更**：`openclaw.plugin.json` 的 `coalesce` 段（顶层 + `accounts.<id>` 两处）逐字不动 ⇒ 不新增群专属配置键，合批窗口复用框架 `resolveInboundDebounceMs(cfg,'qqbot')`。**改配置类型必须同步 manifest schema**（根 `AGENTS.md` 红线）。
- **`strategy:'framework'` 路径保持 legacy**：显式交回框架队列 ⇒ `not_applicable` ⇒ 直发，与改造前一致。
- **群聊 legacy `user_request` 语义不变**：被 @ 的那条在 room_event 群里仍然分类为 `user_request`（不被压成静默）——分类口径仍是 `classifyInboundEventKind`，输入是重建后的同一份 mention 状态。
- **合批窗口时长来源是框架旋钮**（D-c）——不得改回插件内硬编码常量（会让用户已有的 `messages.inbound.byChannel.qqbot.debounceMs` 旋钮再次失效），也不得新增群专属配置键。

## 8. 已知限制

- **副作用仍可能重复一次**（见 §5，core 契约）。
- **退出只保证「宽限内能跑完的 turn 把回复发完」**：`flushIngressQueues` 反复 `drainOnce` 后 `disposeIngressQueues` 停摆；deferred 的 turn 由框架队列在后台继续，无界等待会让 Ctrl+C 卡死（同 c2c 路径的取舍）。
- **claim 租约 5 分钟 / adoption stall 5 分钟**：超时的 claim 由 core 回收并重投；重投的批次指纹相同 ⇒ 不重复回复。
- **载荷版本不认识的行判为不可重试**（`NonRetryableIngressError`）：重投多少次都不会变，让它在重试队列里打转只会拖垮 drain。
