# `src/dispatch/` — 入站 → OpenClaw 的组装与投递

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：把一条入站事件组装成 OpenClaw 能消费的 turn——正文装配（含群合批）、ctx 构造、envelope 构造、路由与 session key 解析、投递给框架。
- **不做**：中间件判定（在 [`src/middleware/`](../middleware/)）、发送（在 [`src/outbound/`](../outbound/)）、会话状态（在 [`src/features/`](../features/)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `dispatch.ts` | 主流程：`dispatchToOpenClaw`；`buildFallbackRouteSessionKey`（routing API 探测失败时的兜底 key）、`resolveDispatchPeerId` |
| `body-assembler.ts` | `assembleBody` / `assembleMergedGroupBody`——正文装配与群消息合并 |
| `ctx-builder.ts` | `buildCtxPayload`——构造框架 ctx |
| `envelope-builder.ts` | `buildEnvelope`——构造 OpenClaw 入站 envelope（`OpenClawInboundMessage`） |
| `index.ts` | re-export |

## 相关红线

- **canonical session key 文法是 10.x 硬门槛** → [`docs/agents/session-and-dispatch.md`](../../docs/agents/session-and-dispatch.md) §「canonical session key 文法」
- **route 文法是 canonical 之外的第二道门** → [`docs/agents/session-and-dispatch.md`](../../docs/agents/session-and-dispatch.md) §「session key 的 route 文法」
- **10.5 的 admission ticket 发生在 replyResolver 之前** → [`docs/agents/session-and-dispatch.md`](../../docs/agents/session-and-dispatch.md) §「10.5 指令/投递语义实测」
- **c2c 入站防抖合并 + 三类旁路** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「c2c 入站防抖合并」
- **群消息合并在插件侧做（框架 collect 对「同群不同人」无效）** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「群消息合并在插件侧做」
- **room_event 的三处裁决必须同源**（本目录是其中一处：入站分类）→ [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「room_event 完整支持」

## 本目录特有的坑

- **兜底路由必须用 `buildFallbackRouteSessionKey`**——不能用裸通道前缀 key 或含大写的 key，框架会抛 `SessionCanonicalKeyMigrationRequiredError`，该 session 一切读写瘫痪、dispatch 全部 outcome=error。
- **canonical 过了 ≠ 框架能反解出投递目标**——框架反解用 `parseSessionDeliveryRoute`，peer 段之后所有冒号分段都会被并进 peerId。兜底优先用框架原语 `runtime.channel.routing.buildAgentSessionKey`。
- **群 key 不含 accountId**——框架自身就不按账号隔离群会话，插件兜底也不该塞。
- **合并后的历史必须取「批前基线」**（最早成员的快照）——直接拼 N 条 agentBody 会让 history 块重复 N 份。
- **合并载体 = 按平台 timestamp 排序后最后一条消息的 ctx**——中间件链并发执行，入队顺序 ≠ 到达顺序。
- **所有 c2c 用户默认共享 `agent:main:main` 一个 session**——要多用户隔离得让用户配 `session.dmScope: "per-peer"`。
