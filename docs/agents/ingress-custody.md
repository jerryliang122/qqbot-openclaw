# 入站 custody（channelIngress admission evidence）

> 深度参考文档。改 `src/dispatch/ingress-evidence.ts` / `ctx-builder.ts` / `adapter/resolve.ts` 的 ingress probe、或任何「入站 context 构造 / 群合批」相关逻辑前必读。

- **背景（issue #116，2026-11-21）**：openclaw **2026.11.5** 起 core 给 `sessions_spawn` 加了 requester-provenance 派发守卫——带 requester 归属的子代理派发要求本轮运行持有「可信的进程内 Gateway 上下文」（**custody**），否则直接抛 `Requester provenance requires trusted in-process Gateway dispatch.`。QQ 渠道当时 100% 撞守卫（`subagent_runs` 表 2026-11-17 后零成功），Telegram 不受影响。守卫坐标（2026.11.6 npm 包 dist）：`subagent-spawn-gateway` / `in-process-gateway`；10.5 dist 全量无此检查。

## 证据链（为什么缺 `channelIngress` 会全灭）

```
sessions_spawn（带 requester）
  → 守卫：要求 custody
    → agent-runner-admission：readChannelContextGatewayContextResolver(sessionCtx) 读 resolver
      → resolver 由 buildContext 内的 evidence 绑定写入（registry 包装：
        createHostChannelInboundEventContextBuilder(builder, owner)）
        → prepareHostChannelContextAdmissionEvidence({ingress: params.channelIngress, owner, ...})
          ingress === undefined → entries=[] → valid=false → resolver=undefined
          → custody 缺失 → 撞守卫
```

**关键事实：修复所需的插件侧 API 不是 11.5 新增的**。`channel.inbound.ingress.{createResolver,resolve,resolveStable}`（owner 绑定，core registry 的 `createHostChannelIngressRuntime(owner)` 注入）与 `plugin-sdk/channel-ingress-runtime` 子路径（`defineStableChannelIngressIdentity` 等值导出）**自 10.5 起就存在**（10.5 dist `registry-*.mjs:3307/3313` 同一套装配）；11.5 的新增物只是 core 侧守卫。因此本修复跨 10.5–11.6 工作，**无需抬 peer 地板**（peer 恒 `>=2026.10.5`）。

**owner 同源性（issue 里「需实测确认」的点，已从源码坐实）**：registry 把 owner 绑定的 ingress runtime 与 evidence 包装的 buildContext 装在**同一个 owner 对象**下——插件从同一个 runtime 对象上 probe 到的两者天然通过 `ownerMatches`（`s?.owner === e.owner`）校验。不要分别从不同来源拿这两个能力。

## 插件实现（三个模块 + 一个不变量）

| 位置 | 职责 |
|---|---|
| `src/adapter/resolve.ts` | probe `['channel','inbound','ingress','resolve']` → `adapters.resolveChannelMessageIngress`（Capability Probe 模式，与 buildContext 同款） |
| `src/dispatch/ingress-evidence.ts` | identity（`defineStableChannelIngressIdentity`：key `qqbot-openid` / verified / pii）、策略映射 `mapIngressPolicy`、多参与者逐个 resolve（`resolveIngressEvidence`）、有界等待 |
| `src/dispatch/ctx-builder.ts` | 把 `channelIngress` 与 `message.inboundEventKind` 透传进 `buildInboundContext` 入参 |
| `src/dispatch/dispatch.ts` | 编排：只**启动** evidence promise（不 await）→ 群 busy 标记 → try 内 await + `buildCtxPayload` |

**写入侧**（跨发言人合批的参与者清单）：`src/features/group-merge.ts` 的 `buildMergedCarrier` 与 `src/features/ingress-batcher.ts` 的多成员分支在**载体 ctx.state** 写 `ingressParticipants`（`buildIngressParticipants`：到达序去重、载体 sender 强制末位）；单成员批不写，dispatch 侧缺省回退 `[envelope.senderId]`。

### 红线：群 busy 不变量（评审 #4 的教训）

`dispatchToOpenClaw` **入口 → `markGroupTurnStarted` 之间必须零 await**（单线程下保证 busy 窗口内无入站消息被处理，2026-10-23 评审修复的语义）。因此 evidence resolve 在上游**只启动 promise、不等待**，结果在 `markGroupTurnStarted` 之后、try 块内 await；`buildCtxPayload` 也在 try 内构建——构建抛错时 finally 的 busy 归零仍配对执行。**新增任何需要 await 的逻辑，必须放到 markGroupTurnStarted 之后。**

## 逐字段契约（错一个字段 evidence 就**静默降级**、守卫依旧触发）

core 的 `contextHandoffMatches` / `bindParticipants` 逐字段校验（admission-evidence / host-context-builder，10.5 与 11.6 同款）：

1. **binding 四元组**：`contextBinding.{agentId, sessionKey, messageId, inboundEventKind}` 必须与 buildContext 入参的 `route.agentId ?? 'default'` / `route.routeSessionKey`（插件不传 dispatchSessionKey）/ `messageId` / `message.inboundEventKind ?? "user_request"` **逐字相等**。⚠️ `message.inboundEventKind` 必须作为 buildContext **入参**传入——构建后再补 `ctxPayload.InboundEventKind` 对 evidence 检查无效（检查发生在 builder 内部、读的是入参；后置赋值保留只为兼容其他消费方）。
2. **accountId 三处同源**：resolver 的 accountId === buildContext 的 `route.accountId` === 顶层 `accountId`。dispatch 侧用 `routeAccountId = route.accountId ?? account.accountId` 归一后两侧同传（评审 #1：route 缺 accountId 时两侧各自归一会失配被拒）。
3. **conversation 同形**：resolver 传 `{kind, id: peerId}`，与 ctx-builder 的 conversation 完全一致（无 parentId/threadId——插件本就不传）。
4. **subject / rawPrincipalRef**：末项的 `subject.stableId` === buildContext 的 `sender.id`（= 载体 sender）。
5. **决策必须 allow**：`ingress.admission === 'dispatch'` 只在最终决策 allow 时出现——策略映射必须让 resolution 得出 allowed（到达 dispatch 的消息都已被 access-control 放行，映射如实反射即可）。
6. **单次移交**：每个 resolved 对象 `handoff.consumed` 只能消费一次、数组内引用重复判 invalid ⇒ **每参与者每次独立新鲜 resolve**，绝不跨消息/跨 turn 复用。
7. **数组多参与者**（core 原生支持，上限 16；合批去重 sender ≤ maxBatchSize=10）：**载体必须是数组末项**（末项 rawPrincipalRef 取 `sender.id`，非末项取各自 binding 的）；Telegram 先例就是传数组。

## 策略映射（`mapIngressPolicy`）与「语义错向」坑

| 插件语义（access-control 同源） | resolver 入参 | 说明 |
|---|---|---|
| c2c `open` | `dmPolicy:'open'` | |
| c2c `allowlist` + 非空名单（无 `*`） | `'allowlist'` + entries | |
| c2c `allowlist` + 空名单 / 含 `*` | `'open'` | access-control 语义=放行所有人；直传空表会被判 `dm_policy_not_allowlisted` 拿不到 custody（**语义折叠，不是放宽**——那条消息本来就被放行了） |
| c2c `pairing` + 名单 | `'pairing'` + entries | 插件 pairing 走框架 pairing store（`adapter/pairing.ts` 的 readChannelAllowFromStore），与 resolver 默认 store 读取**同库**，已配对用户可命中 |
| c2c `disabled` | 整体降级 | 理论上到不了 dispatch（access-control 已拦），防御处理 |
| 群（任意 groupMode/groupAllowFrom） | **恒 `groupPolicy:'open'`、永不传 groupAllowFrom** | ⚠️ **语义错向坑（评审自查）**：插件 `groupAllowFrom` 是「哪些**群**被服务」的群 id 白名单（access-control 按 `groupOpenid` 匹配），core 的 `groupAllowFrom` 却是「群内哪些 **sender** 被允许」——直传会让每个 sender 判 not-allowlisted，恰好让配置了群白名单的群全部拿不到 custody。插件在服务群内没有 sender 级限制（服务群集合由 access-control 在 dispatch 前裁决）。代价：`'open'` 下 `participantOutcomeAffecting` 为 false（wildcard 放行）——只影响 attribution 丰富度，不影响 custody。 |

不传 `route` descriptors、不传 `mentionFacts`（只影响 activation gate 诊断，不影响 allow 与 custody）、slash 命令不传 `event:{kind:'native-command'...}` 覆盖（QQ 是 text-slash、走框架命令检测；若将来命令归属需要 custody 再议）。

## 降级语义（全部「不传 channelIngress」，绝不阻断派发）

| 场景 | 行为 |
|---|---|
| probe 缺失（`adapters.resolveChannelMessageIngress` null） | 不传；行为=旧版（无 custody，11.5+ 上 spawn 失败但其余功能不受影响；10.x 无守卫无感） |
| resolve 抛错 / 超时（默认 5s，`timeoutMs` 可注入） | 该参与者丢弃 + WARN；迟到的 resolve 结果被丢弃（handoff 未消费，无核心侧副作用） |
| 决策未 allow（`admission !== 'dispatch'`） | 该参与者丢弃 + WARN（含 reasonCode） |
| 非载体参与者失败 | 仅丢弃该项（剩余顺序不变、载体仍在末位） |
| **载体（末项）失败** | **整体降级 undefined**（末项必须匹配 `sender.id`，缺它数组必 invalid，不如不带） |
| 策略映射降级（c2c disabled） | 不调 resolver |
| participants 为空 | 不调 resolver |

## 版本面与守卫

- `openclaw/plugin-sdk/channel-ingress-runtime` 子路径 10.5/11.6 双侧存在，`tests/sdk-surface.test.ts` 按引号字面量自动纳入守卫（1 值导出 `defineStableChannelIngressIdentity`）——被删即红。
- 11.6 exports diff：+17 子路径、−1（`heartbeat-runtime`，插件未引用）——与本修复无关，见 `docs/agents/sdk-compat.md`。

## 测试索引

- `tests/ingress-evidence.test.ts`（27 例）：probe 哨兵（防绑错函数）、identity 形状（`{primary:{key,authentication,normalize,sensitivity}}`）、策略映射表驱动（含群语义错向防护）、单/多参与者契约、超时、全部降级路径、`buildIngressParticipants` 去重与载体末位。
- `tests/dispatch-lifecycle.test.ts`：全链路透传、每 turn 新鲜 resolve、失败降级、旧 runtime 形态不变、**busy 窗口**（evidence 挂起期间 `isGroupBusy` 已标记）、**accountId 归一**、**多参与者数组透传**（载体=sender.id 末位）。
