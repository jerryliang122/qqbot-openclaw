# `src/adapter/` — 框架契约适配层

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：把框架侧期望翻译成本插件实现——runtime 契约探测、runtime adapters 解析、webhook 传输、配对 API、远程媒体下载、agent 工作区路径、setup 工具 re-export。
- **不做**：业务逻辑。发送在 [`src/outbound/`](../outbound/)，入站在 [`src/dispatch/`](../dispatch/)，中间件在 [`src/middleware/`](../middleware/)。

## 关键文件

| 文件 | 作用 |
|---|---|
| `contract.ts` | `verifyRuntimeContract`——启动期 runtime 契约探测（`register()` 阶段调用） |
| `resolve.ts` | `resolveRuntimeAdapters` / `getAdapters`——框架适配层（routing / session key / 发送等），一次 resolve 全程复用；`persistAuthConfig` |
| `webhook.ts` | `createPluginWebhookAdapter` / `dispatchOp0WithDetachedWork`——Gateway HTTP 路由 → SDK `WebhookServerAdapter`；op:0 detached 派发 |
| `media.ts` | `downloadRemoteMedia`——远程媒体下载（走 openclaw `saveRemoteMedia`） |
| `pairing.ts` | `getPairingApi`——配对 API（challenge / allowFrom store） |
| `workspace.ts` | `resolveAgentWorkspace`——agent 工作区目录解析 |
| `setup.ts` | `plugin-sdk/setup` 与 `plugin-sdk/setup-tools` 的 re-export |
| `lint.ts` | `npm run lint:runtime` 的实现（扫 `adapter/` 之外的直接 runtime 访问） |

## 相关红线

- **SDK 子路径被删 = 插件整体加载失败** → [`docs/agents/sdk-compat.md`](../../docs/agents/sdk-compat.md) §「SDK 子路径被删是运行时炸裂」
- **Runtime contract probe 的 `REQUIRED` 列表是空的** → [`docs/agents/sdk-compat.md`](../../docs/agents/sdk-compat.md) §「Runtime contract probe」
- **webhook op:0 必须挂 detached 准入根** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「webhook 模式的 op:0 派发」
- **session key 的 canonical / route 两道文法** → [`docs/agents/session-and-dispatch.md`](../../docs/agents/session-and-dispatch.md)

## 本目录特有的坑

- **`contract.ts` 不会 fail-fast**——`REQUIRED` 列表是空的，全部能力按 `OPTIONAL` 处理。别指望它拦住缺失能力。
- **`resolve.ts` 的 adapters 有缓存**（`_resetAdaptersCache`）。换 openclaw 版本后要确认缓存失效策略，否则拿到的是旧适配器。
- **`media.ts` / `workspace.ts` 用 `createRequire` 惰性 require**——CJS 产物走 `__filename` 锚定，ESM（tsx 直跑测试）下 `__filename` 不存在，退回 `process.cwd()`。**新增 require 别改成顶层 import**，会打断这个双模式。
- **`pairing.ts` 的 `approveCode` 走 CLI 而非 plugin-sdk**——`approveChannelPairingCode` 在任何 plugin-sdk 子路径里都不导出，只存在于内部 chunk 与 `openclaw pairing approve` CLI。
- **`lint.ts` 必须留在 `adapter/` 里**——lint 规则本身就禁止 `adapter/` 之外的直接 runtime 访问，它自己当然得在豁免区。
