# 入站 custody（channelIngress admission evidence）

> 深度参考文档。改 `src/dispatch/ingress-evidence.ts` / `ctx-builder.ts` / `adapter/resolve.ts` 的 ingress probe、或任何「入站 context 构造 / 群合批」相关逻辑前必读。

- **背景（issue #116，2026-11-21）**：openclaw **2026.11.5** 起 core 给 `sessions_spawn` 加了 requester-provenance 派发守卫——带 requester 归属的子代理派发要求本轮运行持有「可信的进程内 Gateway 上下文」（**custody**），否则直接抛 `Requester provenance requires trusted in-process Gateway dispatch.`。QQ 渠道当时 100% 撞守卫（`subagent_runs` 表 2026-11-17 后零成功），Telegram 不受影响。守卫坐标（2026.11.6 npm 包 dist）：`subagent-spawn-gateway` / `in-process-gateway`；10.5 dist 全量无此检查。

## ⚠️ 生效前提与上游依赖（二轮评审 2026-11-22 坐实）

**本插件的 evidence → custody 转换目前被 core 侧两个前提卡死**；任一不满足时 evidence 被 core **静默丢弃**（binding 是 `#binding` 私有字段，插件无法探测失败、连降级日志都没有）。当前定位是「**上游依赖下的插件侧预备**」——机制/契约/映射/降级语义全部就位且被测试锁定，前提落地后即生效：

1. **owner 绑定面只发给受信安装**：registry 的 `resolveRecordChannelRuntime` 门禁——`origin === 'bundled' || trustedOfficialInstall === true` 才注入 owner 绑定的 ingress 与 evidence 包装的 buildContext；门禁外返回基础面（ingress 存在但无 owner ⇒ `recordChannelIngressResolution` 返回裸 result；buildContext 不包装 ⇒ `channelIngress` 入参被完全忽略）。自发布 npm 插件（openclaw-qqbot）默认两者皆否——**probe 成功、admission=dispatch 都会照常出现，但 evidence 无效且无告警**。Telegram 不受影响正因它是 bundled。
2. **plugin record id 必须等于 channel id**：core 按**插件 record id**（`registry: channelId: e.id`）建 owner，而 evidence handoff 校验（`scopedParticipantRef = JSON.stringify([channelId, accountId, rawPrincipalRef])`）要求 binding 的 channelId === buildContext 的 `channel`。id 不一致 ⇒ branding 要求传插件 id、handoff 要求传 channel id，**互斥无解**。**2026-11-22 起本插件已对齐**：manifest `id` 与 `package.json` `openclaw.id` 均改为 `"qqbot"`（webhook 路由的 `pluginId` 同步——`registerPluginHttpRoute` 按 `entry.id === params.pluginId` 查 record；npm 包名与内部自用字符串不迁移）。bundled Telegram 的插件 id 恰好就是 `telegram`，所以只有它工作。
   - 对齐路径（需主人决策）：① manifest `id` 改为 `"qqbot"`（连带 `package.json` 的 `openclaw.id`；影响已安装用户的插件身份）；② 向上游反馈 core 按 channel id 建 owner / 向非受信插件开放 owner 面。
3. **运维信号**：`resolveIngressEvidence` 首次成功挂载 evidence 时打一次性 INFO（注明「custody 仅在 owner 绑定面可用时生效」）——线上据此区分「修好了」和「evidence 被静默丢弃」。

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
| `src/dispatch/ingress-evidence.ts` | identity（`defineStableChannelIngressIdentity`：key `qqbot-openid` / verified / pii）、策略映射 `mapIngressPolicy`、多参与者**并发** resolve（共享截止时间）、core 上限 16 裁剪、错误脱敏 |
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
7. **数组多参与者**（core 原生支持，上限 16——`CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS`；插件在 `resolveIngressEvidence` 入口**硬裁剪到最新 16 个**，载体恒末位不受影响，被舍弃的最早参与者不触发 resolve）：**载体必须是数组末项**（末项 rawPrincipalRef 取 `sender.id`，非末项取各自 binding 的）；Telegram 先例就是传数组。合批去重 sender 正常 ≤ maxBatchSize(10)，裁剪是配置放宽/未来演进的保险。
8. **参与者并发 + 共享截止时间**：逐个串行 await 会让 N 个停滞参与者拖成 N×timeout（10 人批最坏 ~50s、群全程 busy）——所有参与者并发起跑（`Promise.all` 保序），每人只分得剩余预算，总等待恒 ≈ 一个 timeout。
9. **日志脱敏**：resolver 的 `err.message` 可能内嵌 openid / sessionKey——WARN 前用 `shortId()` / `sessionKeyDigest()`（`src/utils/redaction.ts`）替换原文（根级红线：INFO 以上日志不得落完整标识符，`/bot-logs` 原样导出）。

## 策略映射（`mapIngressPolicy`）——对齐 core `senderGateForDirect` 真实判定

| 插件语义（access-control 同源） | resolver 入参 | 说明 |
|---|---|---|
| c2c `open` | `dmPolicy:'open'` + **`allowFrom:['*']`** | ⚠️ core 的 dm `open` **不是「放行所有人」**（二轮评审坐实）：`senderGateForDirect` 对 open 仍要求名单带通配符或命中（空名单 ⇒ `dm_policy_not_allowlisted`）；只有**群** open 是无条件放行（`senderGateForGroup`）。「放行所有人」必须让 `hasWildcard` 成立 |
| c2c `allowlist` + 非空名单（无 `*`） | `'allowlist'` + entries | |
| c2c `allowlist` + 空名单 / 含 `*` | `'open'` + **`allowFrom:['*']`** | access-control 语义=放行所有人 ⇒ 折叠 open；**通配必须随行**——漏带即默认配置（allowlist+空名单）c2c 被判 not-allowlisted、静默丢 custody（二轮评审高危项） |
| c2c `pairing`（任意静态名单） | **恒 `'pairing'`** + entries（可空） | ⚠️ **永不折叠**（二轮评审坐实）：core 的 `mergeDmAllowFromSources` 在 dmPolicy 为 open/allowlist 时直接丢弃 pairing store——折叠会让「空静态名单的配对模式」（最常见配对配置）丢掉 store 命中。保留 'pairing' 让 store 与静态名单共同生效；插件 pairing 走框架 pairing store（与 resolver 默认 store 读取同库） |
| c2c `disabled` | 整体降级 | 理论上到不了 dispatch（access-control 已拦），防御处理 |
| 群（任意群配置） | **恒 `groupPolicy:'open'`、永不传 groupAllowFrom** | ⚠️ **语义错向坑（评审自查）**：插件 `groupAllowFrom` 是「哪些**群**被服务」的群 id 白名单（access-control 按 `groupOpenid` 匹配），core 的 `groupAllowFrom` 却是「群内哪些 **sender** 被允许」——直传会让每个 sender 判 not-allowlisted。插件在服务群内没有 sender 级限制（服务群集合由 access-control 在 dispatch 前裁决）。代价：`'open'` 下 `participantOutcomeAffecting` 为 false（wildcard 放行）——只影响 attribution 丰富度。**`groupMode`/`groupAllowFrom` 已从 `IngressAccessPolicyInput` 移除（二轮评审：读了不用的死参数）** |

不传 `route` descriptors、不传 `mentionFacts`（只影响 activation gate 诊断，不影响 allow 与 custody）、slash 命令不传 `event:{kind:'native-command'...}` 覆盖（QQ 是 text-slash、走框架命令检测；若将来命令归属需要 custody 再议）。

## 降级语义（全部「不传 channelIngress」，绝不阻断派发）

| 场景 | 行为 |
|---|---|
| probe 缺失（`adapters.resolveChannelMessageIngress` null） | 不传；行为=旧版（无 custody，11.5+ 上 spawn 失败但其余功能不受影响；10.x 无守卫无感） |
| resolve 抛错 / 超时（默认 5s **共享截止时间**，`timeoutMs` 可注入） | 该参与者丢弃 + WARN（错误信息经 shortId/sessionKeyDigest 脱敏）；迟到的 resolve 结果被丢弃（handoff 未消费，无核心侧副作用） |
| 决策未 allow（`admission !== 'dispatch'`） | 该参与者丢弃 + WARN（含 reasonCode，sender 以 shortId 记） |
| 参与者超过 core 上限 16 | 裁剪保留最新 16 个（载体末位不受影响）+ WARN；被舍弃者不触发 resolve |
| 非载体参与者失败 | 仅丢弃该项（剩余顺序不变、载体仍在末位） |
| **载体（末项）失败** | **整体降级 undefined**（末项必须匹配 `sender.id`，缺它数组必 invalid，不如不带） |
| 策略映射降级（c2c disabled） | 不调 resolver |
| participants 为空 | 不调 resolver |

## 版本面与守卫

- `openclaw/plugin-sdk/channel-ingress-runtime` 子路径 10.5/11.6 双侧存在，`tests/sdk-surface.test.ts` 按引号字面量自动纳入守卫（1 值导出 `defineStableChannelIngressIdentity`）——被删即红。
- 11.6 exports diff：+17 子路径、−1（`heartbeat-runtime`，插件未引用）——与本修复无关，见 `docs/agents/sdk-compat.md`。

## 测试索引

- `tests/ingress-evidence.test.ts`（30 例）：probe 哨兵（防绑错函数）、identity 形状（`{primary:{key,authentication,normalize,sensitivity}}`）、策略映射表驱动（含群语义错向防护）、单/多参与者契约（输出成员与顺序断言）、超时、**共享截止时间**（N 停滞参与者总耗时 ≈ 一个 timeout）、**16 上限裁剪**、**错误脱敏**（不落完整 openid/sessionKey）、全部降级路径、`buildIngressParticipants` 去重与载体末位。
- `tests/dispatch-lifecycle.test.ts`：全链路透传、**每 turn 证据新鲜度穿透到 buildContext**（identity 比对）、失败降级、旧 runtime 形态不变、**busy 窗口**（evidence 挂起期间 `isGroupBusy` 已标记）、**accountId 归一**、**多参与者数组透传**（成员顺序 + 载体=sender.id 末位）。
