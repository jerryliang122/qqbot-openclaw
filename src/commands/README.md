# `src/commands/` — `/bot-*` 斜杠命令

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：实现 `/bot-*` 斜杠命令的处理器——帮助、版本、群信息、配对、审批、日志导出、流式开关等。
- **不做**：命令注册本身（`index.ts` 的 `buildCommandList()`）；平台侧指令面板同步（在 [`src/features/command-panel.ts`](../features/command-panel.ts)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `index.ts` | `buildCommandList()`——**所有命令的注册入口**，新增命令在这里挂上 |
| `config-util.ts` | `checkCommandAuth` / `updateAccountConfig` / `updateGlobalConfig`——命令鉴权与配置写入 |
| `bot-help.ts` | `/bot-help` 命令清单 |
| `bot-version.ts` | `/bot-version`——插件与 openclaw 版本 |
| `bot-ping.ts` | `/bot-ping` 连通性自检 |
| `bot-me.ts` | `/bot-me`——当前会话身份 |
| `bot-group-info.ts` | `/bot-group-info`——查看该群的**推送模式**与**生效配置**（群级 / 按 agent / 全局三层） |
| `bot-group-always.ts` | `/bot-group-always`——群级 always 开关 |
| `bot-approve.ts` | `/bot-approve`——审批相关命令 |
| `bot-pairing.ts` | `/bot-pairing`——配对码 |
| `bot-logs.ts` | `/bot-logs`——导出本地日志文件 |
| `bot-clear-storage.ts` | `/bot-clear-storage`——清理存储 |
| `bot-streaming.ts` | `/bot-streaming`——流式开关 |

## 相关红线

- **日志脱敏**——`/bot-logs` 导出的是本地日志文件**原样**（不限级别），所以 INFO 以上日志不得落完整 openid / sessionKey → 根 [`AGENTS.md`](../../AGENTS.md) § Security
- **群消息优先级链**（`groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account 级 `defaultRequireMention` → `true`）→ [`docs/agents/config-and-credentials.md`](../../docs/agents/config-and-credentials.md) §「Group message priority chain」
- **群历史模式 `historyMode`** → [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「群历史模式 historyMode」
- **主动发送预算是每日 1000 条** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「出站锚点模型」

## 本目录特有的坑

- **一命令一文件**，新增时别把两个命令塞进同一个文件。
- **注册必须走 `buildCommandList()`**——绕过它注册的斜杠命令不会被框架的文本斜杠命令路由识别。
- **`config-util.ts` 改配置时注意 manifest schema**——改配置类型必须同步 `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`，否则用户配置被直接拒收 → [`docs/agents/config-and-credentials.md`](../../docs/agents/config-and-credentials.md) §「改配置面必须同步 manifest」。
- **`bot-logs.ts` 导出的是原始日志文件**——它不会替你脱敏，脱敏责任在写日志的地方。
- **命令鉴权走 `checkCommandAuth`**——不要在命令处理器里另写一套权限判断。
