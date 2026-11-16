# `src/adapter/` — 框架契约适配层

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：把框架侧期望翻译成本插件实现——runtime 契约探测、runtime adapters 解析、webhook 传输、配对 API、远程媒体下载、agent 工作区路径、setup 工具 re-export。
- **不做**：业务逻辑。发送在 [`src/outbound/`](../outbound/)，入站在 [`src/dispatch/`](../dispatch/)，中间件在 [`src/middleware/`](../middleware/)。
- **注意**：这里的 `adapter/` 是**插件自己的适配层**，与 `src/` 根下的框架侧 `*-adapter.ts`（message / messaging / outbound / gateway / heartbeat / status / agent-prompt）**不是一回事**。

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

- **SDK 子路径被删 = 插件整体加载失败**（根级）→ 根 [`AGENTS.md`](../../AGENTS.md) §「SDK 依赖面」
- **Runtime contract probe 的 `REQUIRED` 列表是空的** → [`docs/agents/sdk-compat.md`](../../docs/agents/sdk-compat.md) §「Runtime contract probe」
- **webhook op:0 必须挂 detached 准入根** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「webhook 模式的 op:0 派发」
- **session key 的 canonical / route 两道文法**（根级）→ 根 [`AGENTS.md`](../../AGENTS.md) §「Session key 与投递」

## 本目录特有的坑

- **`contract.ts` 不会 fail-fast**——`REQUIRED` 列表是空的，全部能力按 `OPTIONAL` 处理。别指望它拦住缺失能力。
- **`resolve.ts` 的 adapters 有缓存**（`_resetAdaptersCache`）。换 openclaw 版本后要确认缓存失效策略，否则拿到的是旧适配器。
- **`media.ts` / `workspace.ts` 用 `createRequire` 惰性 require**——CJS 产物走 `__filename` 锚定，ESM（tsx 直跑测试）下 `__filename` 不存在，退回 `process.cwd()`。**新增 require 别改成顶层 import**，会打断这个双模式。
- **`pairing.ts` 的 `approveCode` 走 CLI 而非 plugin-sdk**——`approveChannelPairingCode` 在任何 plugin-sdk 子路径里都不导出，只存在于内部 chunk 与 `openclaw pairing approve` CLI。
- **`lint.ts` 必须留在 `adapter/` 里**——lint 规则本身就禁止 `adapter/` 之外的直接 runtime 访问（`runtime.channel.*`），它自己当然得在豁免区。加白用行内注释 `// @adapter-bypass: <理由>`。
- **webhook op:0 的 detached 准入根**——SDK `WebhookTransport.handleRequest` 对 op:0 是「先 ACK、后台 fire-and-forget 派发」，插件拿不到那条派发 promise；openclaw 对每个 HTTP 请求持一次 root-work 准入（路由 handler settle 即释放），后台派发链经 AsyncLocalStorage **继承的是这个已释放的请求根** → 框架 enqueue 处判 `current.released === true` → `GatewayDrainingError`（报错文案是四分支的兜底句「temporarily unavailable」，**网关并没有 drain**；websocket 模式的准入挂在常驻连接上故无恙）。修法：op:0 委托放进 `runDetachedWebhookWork` 回调，回调内**再等「本次委托派生的在途派发」全部落地才 settle**——detached 根只在回调挂起期间保持引用，而 SDK 的 fire-and-forget promise 不在回调的 AsyncWorkScope 里（scope 的 pending 集合只收显式注册的 promise），**不等的话 detached 根随 ACK 释放、bug 原样复现**。在途登记在 `src/features/webhook-dispatch-tracker.ts`。
- **`runDetachedWebhookWork` 子路径被删 = 插件整体加载失败**——`src/features/detached-webhook-work.ts` 的共享加载器在模块存在但**导出缺失时也要 WARN**，不静默失效。
