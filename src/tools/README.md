# `src/tools/` — 向 agent 注册的插件工具

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：注册插件工具——QQ 平台 API 透传、定时提醒、Secret 输入。
- **不做**：工具产物的发送实现（在 [`src/outbound/`](../outbound/)）；ask_user 卡片渲染（在 [`src/features/question-card.ts`](../features/question-card.ts)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `platform.ts` | `registerPlatformTool`——`qqbot_platform_api`：任意 path 的 QQ 开放平台 REST 透传 |
| `remind.ts` | `registerRemindTool`——定时提醒（remind / cron 投递） |
| `secret-input.ts` | `registerSecretInputTool`——`qqbot_secret_input`：引导用户在聊天里回填密钥 |
| `tool-session.ts` | `resolveToolSessionRoute`——工具执行时定位当前会话（多账号 / 群聊场景） |

## 相关红线

- **不要在本仓库中绕过 SDK 直接 fetch QQ API** → [`docs/agents/platform-capabilities.md`](../../docs/agents/platform-capabilities.md) §「底层依赖」
- **SDK 版本滞后于平台文档**——REST 新接口今天就可经 `qqbot_platform_api` 调用（SDK `bot.api` 是任意 path 的通用网关），但入群申请**事件**与 `force_verify_image_resource` 参数依赖 SDK 更新 → [`docs/agents/platform-capabilities.md`](../../docs/agents/platform-capabilities.md) §「底层依赖」
- **Secret input 的消息绝不进 AI transcript**（kind 恒为 `env`）→ [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「Secret input flow」
- **无显式锚点的发送一律走主动发送**（remind / cron 属此列，烧每日 1000 条预算）→ [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「出站锚点模型」

## 本目录特有的坑

- **`remind.ts` 的投递是主动发送**——没有本轮入站锚点可挂，按平台语义走每日主动预算；用户关「允许主动发送」时这类消息会被平台拒发。
- **`secret-input.ts` 只支持 c2c**——群聊里回填密钥不成立（消息是公开的）。
- **Secret 的 kind 恒为 `env`**——写成 `secret` 会让 AI 之后读不到该值。
- **`tool-session.ts` 的会话定位不要绕过框架的路由解析**——多账号下 `accountId` 派生错会导致工具投递到别的账号。
- **新增工具要考虑它落在「被动」还是「主动」**——这决定它烧不烧每日主动预算，是配额敏感的决策点。
