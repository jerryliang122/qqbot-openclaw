# `src/gateway/` — 传输生命周期与事件入口

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：账号启停（WebSocket / Webhook 双传输）、平台事件入口（消息 / 互动）、中间件链装配。
- **不做**：事件判定逻辑（在 [`src/middleware/`](../middleware/)）、组装与投递（在 [`src/dispatch/`](../dispatch/)）、发送（在 [`src/outbound/`](../outbound/)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `qqbot-gateway.ts` | `QQBotGateway`——网关主体；`createInteractionDispatchListener`（互动事件派发监听）、`SendOptions` |
| `event-handlers.ts` | `handleMessage` / `handleInteraction`——平台事件入口 |
| `lifecycle.ts` | `startAccountWithCredentialRecovery` / `stopAccountGracefully` / `logoutAndClearCredentials` |
| `middleware-setup.ts` | `setupMiddlewares`——中间件链装配顺序；`buildMentionGateResolveConfig` |
| `index.ts` | re-export |

## 相关红线

- **SDK 子路径被删 = 插件整体加载失败** → [`docs/agents/sdk-compat.md`](../../docs/agents/sdk-compat.md)
- **webhook 模式的 op:0 派发必须挂 detached 准入根** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「webhook 模式的 op:0 派发」
- **入站事件守卫拦三类非真实用户输入**（出站回声 / 重复推送 / 空内容）→ [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「入站事件守卫」
- **互动事件只有 type 11/12 需要 ack** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md)
- **白名单拒绝必须回告** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「白名单拒绝必须回告」
- **三层限流默认开** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「三层限流已启用」

## 本目录特有的坑

- **`event-handlers.ts` 里凡是 openid 一律走 `shortId()`**——INFO 以上日志不得落完整 openid（`/bot-logs` 会导出本地日志文件原样）。sessionKey 一律记 sha256 前 8 位摘要。
- **`skipSelfEcho` 必须 true**——否则插件自己的出站会被当成入站回声再处理一遍。
- **重复推送窗口要补到 30min**——SDK 内置去重只有 5s。
- **互动事件只有 type 11/12 需要 ack**——其余类型回应无意义（type=14 误 ack code=0 会触发「会话已清空」小灰条）。**配置面板事件按 `data.type` 匹配且必须在类型路由分支之前检查。**
- **限流三层默认开**——sender 20/min、group 60/min、global 300/min（装配在 `middleware-setup.ts` 的 `rateLimit`）；room_event 群务必保持启用。
- **WebSocket 与 Webhook 的插件层行为无差异**——唯一例外是 webhook 模式专属的准入跟踪（补偿「HTTP 请求级准入 vs 常驻连接级准入」的宿主差异），不是行为分叉。
- **中间件装配顺序由 `middleware-setup.ts` 决定**——`secretCapture` 在 slashCommand 之后、`c2cTypingIndicator` 之前，别随手调序。
