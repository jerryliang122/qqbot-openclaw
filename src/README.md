# `src/` 根级文件 — 编排、配置与框架适配

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../docs/agents/) 对应文件里，**改这些文件前先读那篇**——本文件不复制正文，只做指针。
>
> 这里的文件都不属于任何子目录，但它们是**框架契约与配置面**的落点——改配置类型、改能力声明、改账号解析都从这几个文件进。

## 职责边界

- **做**：插件编排（`channel.ts`）、账号与配置解析（`config.ts` / `types.ts`）、SDK 实例与运行时（`bot-instance.ts` / `runtime.ts`）、框架侧通道适配层（`*-adapter.ts`）、请求级上下文、常量与类型。
- **不做**：具体业务流程——发送在 [`src/outbound/`](outbound/)，入站在 [`src/dispatch/`](dispatch/)，中间件在 [`src/middleware/`](middleware/)。

## 关键文件

| 文件 | 作用 |
|---|---|
| `channel.ts` | `qqbotPlugin` 定义——插件入口、能力声明、GFM 表格 fallback chunker |
| `config.ts` | 账号解析（`resolveQQBotAccount`）、群配置、工具策略；`inspectAccount` 只读巡检面 |
| `types.ts` | 配置类型与 `capabilities` 声明的 TS 侧定义（**改它必须同步 manifest schema**） |
| `constants.ts` | `TEXT_CHUNK_LIMIT`（5000 字）、语音软限制等常量 |
| `bot-instance.ts` | `getBotForAccount(accountId)` → QQBot SDK 实例 |
| `runtime.ts` | `setQQBotRuntime()` / `getQQBotRuntime()` + 退出钩子 |
| `request-context.ts` | AsyncLocalStorage 请求级上下文——并发消息下工具取会话信息不串 |
| `typing-lifecycle.ts` | typing 指示的出站侧生命周期（与 `src/middleware/typing.ts` 同口径） |
| `plugin-base.ts` | 插件基类 / 公共装配 |
| `openclaw-plugin-sdk.d.ts` | `openclaw/plugin-sdk` 的 ambient 类型 stub（**只剩裸入口 + `text-utility-runtime` 两段**） |
| `message-adapter.ts` / `messaging-adapter.ts` / `outbound-adapter.ts` / `gateway-adapter.ts` / `heartbeat-adapter.ts` / `status-adapter.ts` / `agent-prompt-adapter.ts` | **框架侧通道适配层**——把框架的 channel 契约翻译成 QQ Bot 侧行为。它们与 [`src/adapter/`](adapter/) 目录（插件自己的 probe / media / webhook / workspace）**不是一回事** |

## 相关红线

- **改配置类型必须同步 manifest schema，否则用户配置被直接拒收** → [`docs/agents/config-and-credentials.md`](../docs/agents/config-and-credentials.md) §「改配置面必须同步 manifest」
- **`config.inspectAccount` 是只读巡检面，不 materialize 凭据** → [`docs/agents/config-and-credentials.md`](../docs/agents/config-and-credentials.md) §「`config.inspectAccount` 是只读巡检面」
- **`capabilities.tts.voice` 必须声明；`capabilities.nativeCommands` 刻意不声明** → [`docs/agents/config-and-credentials.md`](../docs/agents/config-and-credentials.md) §「`capabilities.tts.voice` 必须声明」
- **`messaging.inferTargetChatType` 必须实现** → [`docs/agents/config-and-credentials.md`](../docs/agents/config-and-credentials.md) §「`messaging.inferTargetChatType` 必须实现」
- **群消息优先级链** → [`docs/agents/config-and-credentials.md`](../docs/agents/config-and-credentials.md) §「Group message priority chain」
- **SDK 子路径被删 = 插件整体加载失败** → [`docs/agents/sdk-compat.md`](../docs/agents/sdk-compat.md)
- **ambient stub 会遮蔽包内真实类型** → [`docs/agents/sdk-compat.md`](../docs/agents/sdk-compat.md) §「`src/openclaw-plugin-sdk.d.ts`」
- **`agentPrompt.questionInputMode` 必须声明 `"buttons"`** → [`docs/agents/interaction.md`](../docs/agents/interaction.md) §「`agentPrompt.questionInputMode` 必须声明为 `"buttons"`」
- **凭据互斥 / 热路径不读盘 / 只读巡检** → 根 [`AGENTS.md`](../AGENTS.md) § Security

## 本目录特有的坑

- **改 `types.ts` 前先看 manifest**——唯一来源是 `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`（顶层 + `accounts.<id>` 两处逐字一致）。框架走 `validatePluginSchemaValue`（`applyDefaults: true`，对 `additionalProperties:false` 和 `enum` 都做值校验），**typecheck 不设防**——`tests/manifest-config-schema.test.ts` 是唯一防线，红了先补 manifest，不要绕过守卫。
- **`capabilities.tts.voice` 的 `captionedFinalText` 必须是 `false`**——QQ 语音不带文字说明，声明 true 会让终稿正文永不到达。声明整个形态：`{ synthesisTarget: "voice-note", transcodesAudio: true, captionedFinalText: false }`（走 SILK 语音气泡；不声明则 TTS 被当普通音频文件发）。
- **`capabilities.nativeCommands` 刻意不声明**——QQ 指令面板是引导型 UI，声明会与 `commands.text=false` 冲突。
- **`agentPrompt.questionInputMode` 必须声明 `"buttons"`，且不能删**——openclaw 2026.11.5 起 core 按频道能力发放 `ask_user`（读 `questionInputMode`，缺省 `"none"` ⇒ `ask_user` 不进工具目录 ⇒ agent 静默改用纯文本提问，issue #113）。**删掉不会有任何编译 / 运行期信号**，只有线上静默降级 ⇒ 声明处有类型层断言，守卫测试见 [`tests/message-adapter-capabilities.test.ts`](../tests/message-adapter-capabilities.test.ts)。叙事见 [`docs/agents/interaction.md`](../docs/agents/interaction.md)。
- **`messaging.inferTargetChatType` 必须实现**——否则宿主只能走通用路由搜索，Gateway 一直报 `waiting for route`。其余能力一律 `undefined`（不猜）。
- **`resolveQQBotAccount` 是热路径，全程不读盘**——每次出站发送都会解析一次账号，同步 `stat`/`readFileSync` 会阻塞事件循环。凭据文件只在账号启动时读一次。
- **`inspectAccount` 不能 materialize 凭据**——`openclaw status` / doctor 不该为「描述配置」触发 token 交换或扫码。`secretStatus` 三态：`available` / `configured_unavailable` / `missing`。
- **内联密钥与凭据文件强制互斥**——两者同时存在时内联优先、文件静默忽略；写入必须清掉另一个，注销要清 `clientSecretFile`。
- **群消息优先级链**：`groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account 级 `defaultRequireMention` → `true`（默认）。其他群配置字段（`ignoreOtherMentions/toolPolicy/name/prompt/historyLimit/historyMode/unmentionedInbound/coalesce`）同一 ??-cascade。
- **`openclaw-plugin-sdk.d.ts` 只留两段**（裸入口 + `text-utility-runtime`）——升级钉版时先删掉包已提供类型的 stub 段再跑 typecheck，否则**遮蔽包内真实类型，留着等于没验证**。
- **框架侧 `*-adapter.ts` 与 `src/adapter/` 目录别混**——前者是框架契约适配（7 个文件，散在 src 根），后者是插件自己的 probe / media / webhook / workspace / lint。
