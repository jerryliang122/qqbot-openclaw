# `src/setup/` — 扫码登录与账号初始化

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：扫码登录全流程——取二维码、等扫码、派生账号 key、落配置、引导向导。
- **不做**：框架 setup 原语（`plugin-sdk/setup` 的 re-export 在 [`src/adapter/setup.ts`](../adapter/setup.ts)）；凭据读取与巡检口径（在 [`src/config.ts`](../config.ts)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `login.ts` | `startQrLogin` / `waitQrLogin` / `cancelQrLogin`——二维码登录；`parseChannelInput` 解析用户输入的频道 ID |
| `account-key.ts` | `resolveAccountKey`——由频道输入派生账号 key |
| `finalize.ts` | `finalizeQQBotSetup` / `applyAccountDefaults`——落配置与默认值 |
| `surface.ts` | `qqbotSetupWizard`——setup 向导 UI |

## 相关红线

- **凭据只在账号启动时读一次**——`resolveQQBotAccount` 是热路径，全程不读盘 → 根 [`AGENTS.md`](../../AGENTS.md) § Security
- **内联密钥与凭据文件强制互斥**——两者同时存在时内联优先、文件静默忽略；写入必须清掉另一个，注销要清 `clientSecretFile` → 根 [`AGENTS.md`](../../AGENTS.md) § Security
- **配置面与 manifest schema 同步** → [`docs/agents/config-and-credentials.md`](../../docs/agents/config-and-credentials.md)

## 本目录特有的坑

- **setup 阶段的凭据落盘与运行期读取是两条路径**——setup 写完后，运行时一律走「账号启动时读一次」，别在运行期再读一遍凭据文件（会阻塞事件循环）。
- **`applyAccountDefaults` 写入的字段要考虑与 manifest schema 一致**——schema 是 `additionalProperties:false` + `enum` 值校验，多写一个字段用户配置就会被拒收。
- **QR 登录依赖 `@tencent-connect/qqbot-connector`（1.2.0 精确钉版）**——它只用于 setup，不参与运行时发送。
- **`parseChannelInput` 的输入容错**——用户可能粘带空格 / 大小写不同的频道 ID，别在这里静默失败，给出可操作的提示。
