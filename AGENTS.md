# AGENTS.md — openclaw-qqbot

`openclaw-qqbot` — OpenClaw 通道插件，把 QQ Bot 官方 API 接入 OpenClaw framework。独立维护的 fork，自 v1.0.0 起独立发版（发版流程见 CHANGELOG.md，tag v* 触发 .github/workflows/release.yml）。

**构建基线：openclaw `2026.9.2`**（peer 范围 `>=2026.9.2`，devDependency 精确钉版 `2026.9.2`）。所有与 openclaw / `openclaw/plugin-sdk` 的交互以 2026.9.2 为最低兼容版本 —— 不得使用仅存在于更新版本中的 API，除非带能力探测与回退；升级钉版前必须重新评估兼容性（2026-09-07 升级：2026.9.2 为 registry `latest` stable；state DB schema 已到 15）。2026.9 系列带来的审批面变化：`ChannelApprovalKind` 新增 `"system-agent"`（OpenClaw 系统变更审批），插件已支持（eventKinds、`buildSystemAgentApprovalText`、button_data `approve:v2:system-agent:...`），且 `resolveApprovalOverGateway` 改用带 `approvalKind` 的规范重载（无 kind 的旧签名已 deprecated）。

## Commands

```bash
npm run build        # tsup → dist/index.cjs + dist/index.d.cts (CJS only, target node18)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit (currently passes)
npm run lint:runtime # 扫描 adapter/ 之外的直接 runtime 访问（src/adapter/lint.ts）
```

**No `npm test` script.** Tests are standalone scripts run with `tsx`:

```bash
npx tsx tests/<name>.test.ts          # run one file
npx tsx tests/*.test.ts 2>&1 | tail   # rough "all" run (no shared runner)
```

All tests use `node:assert` + a hand-rolled `test()` helper and run directly via `tsx`.

## Architecture

Entry: `index.ts` → re-exports `qqbotPlugin` from `src/channel.ts`. That file is the orchestrator; substantive logic lives in:

```
src/
  channel.ts            # ChannelPlugin definition, GFM table fallback chunker
  bot-instance.ts       # getBotForAccount(accountId) → QQBot SDK instance
  runtime.ts            # setQQBotRuntime() / getQQBotRuntime() + exit hooks
  config.ts             # account resolution, group config, tool policy
  gateway/              # WebSocket/Webhook lifecycle, event handlers, middleware wiring
  dispatch/             # inbound → OpenClaw: body-assembler, ctx-builder, envelope
  outbound/             # send pipeline: text, media, TTS, streaming, cron, debounce
  middleware/           # access-control, attachment, policy-injector
  commands/             # /bot-* slash commands (registered via SDK middleware)
  features/             # pairing, approval, ref-index, history, update-check, command-panel
  adapter/              # contract probe, media, resolve, webhook, workspace
  setup/                # QR login (start/wait), account-key, finalize, surface wizard
  tools/                # platform.ts (qqbot_platform_api), remind.ts, secret-input.ts (qqbot_secret_input)
  utils/                # logger, mention stripping, pkg-version, SSRF guard, STT
  openclaw-plugin-sdk.d.ts  # local type stubs for openclaw/plugin-sdk
```

Plugin exports include `qqbotPlugin`, `getBotForAccount`, `QQBotGateway`, `sendText`, `sendMedia`, `parseTarget`, `dispatchToOpenClaw`, `StreamingController`, `PersistedRefIndexStore`, `ReplyLimiter`, quota management functions, and typing lifecycle functions.

## Key gotchas

- **`tsup` post-build hook** (`tsup.config.ts:54`): rewrites `dist/index.cjs` to alias `new Function` → `new _F` (protobufjs pattern that triggers security scanners). Don't strip this — it's load-bearing.
- **`preload.cjs` symlink**: `openclaw` is a `peerDependency`. When installed via `openclaw plugins install`, the plugin ends up under `~/.openclaw/extensions/openclaw-qqbot/`, and `openclaw/plugin-sdk` must be resolvable from the plugin's `node_modules`. `preload.cjs` synchronously calls `ensurePluginSdkSymlink()` (see `scripts/link-sdk-core.cjs`) which creates a junction `node_modules/openclaw` → the global openclaw install. If you remove or rename `preload.cjs`, the plugin will fail to load when installed via the framework.
- **`package.json` `external`**: `openclaw` and `openclaw/plugin-sdk/**` are external — they are NOT bundled. `dist/index.cjs` does `require('openclaw/plugin-sdk/core')` at runtime. Local dev needs `node_modules/openclaw` as a real install (or symlink to it). Dev copy is exact-pinned to the baseline via devDependency `openclaw@2026.9.2` so typecheck validates against the oldest supported API surface — keep every `openclaw/plugin-sdk` usage compatible with 2026.9.2 (capability probe + fallback if a newer API is genuinely needed) and don't bump the pin without re-checking compatibility. Stable 2026.9.2 satisfies the peer range, so plain `npm install` works; `--legacy-peer-deps` is not required. Note `package-lock.json` is listed in `.gitignore` but is actually tracked — installs will produce a lockfile diff. **裸子路径 `openclaw/plugin-sdk`（无后缀）不在包 exports 里**：运行时 require 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`——本插件对它只有 `import type`（会被擦除），且类型由本地 ambient stub 提供；永远不要从裸路径做值导入。
- **`src/openclaw-plugin-sdk.d.ts`**: ambient type stubs for `openclaw/plugin-sdk` subpaths the package doesn't type. 2026-09-07 起包已为 `core` / `setup` / `setup-tools` / `question-gateway-runtime` / `webhook-ingress` 等子路径提供正式 `.d.ts`（原 `src/typings/openclaw-webhook-ingress.d.ts` 已删除），这些 stub 已移除、typecheck 直接验证真实 SDK 类型。当前 stub 只剩两段且**都是必需的**：(1) 裸入口 `openclaw/plugin-sdk`（包既无 exports 也无类型，且代码大量 `import type` 它）；(2) `text-utility-runtime`（包 files 列表仍排除其 `.d.ts`）。升级 openclaw 钉版时先删掉包已提供类型的 stub 段再跑 typecheck——ambient `declare module` 会遮蔽包内真实类型，留着等于没验证。
- **Runtime contract probe** (`src/adapter/contract.ts`): `REQUIRED` list is currently **empty**; all capabilities are `OPTIONAL`. The probe still runs on register but only logs degraded features; it will never throw unless someone adds a required entry. Don't rely on it to fail fast on missing APIs.
- **Multi-account**: top-level `channels.qqbot.appId/secret` is the `"default"` account; additional accounts go under `channels.qqbot.accounts.<id>`. Each account gets its own gateway and token cache. OpenIDs are **per-account** — a user OpenID from bot A cannot be used by bot B.
- **Group message priority chain**: `groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account-level `defaultRequireMention` → `true` (default). Same precedence applies to other group config fields (`ignoreOtherMentions/toolPolicy/name/prompt/historyLimit/historyMode/unmentionedInbound/coalesce` all use the same ??-cascade).
- **群聊三模式矩阵（2026-09-09 群聊架构改造）**: 群主把 bot 拉进群时选推送模式（**插件不可控、同账号各群混合**）：(1) **AT 纯模式**——仅被 @ 时收到 `GROUP_AT_MESSAGE_CREATE`；(2) **AT+最近N（≤10）**——@ 事件的 `msg_elements` 携带最近消息记录（`MsgElement` 含 per-element author、message_type 102=聊天记录；示例3 为预渲染文本 `=== 消息 N ===`）；(3) **全量模式**——每条消息推 `GROUP_MESSAGE_CREATE`。两事件共用 intent `GROUP_AND_C2C_EVENT`(1<<25)、SDK 映射为同一形态（仅 `rawEventType` 保留）、走同一条中间件链——插件**无需也不应按模式分流**，per-group 模式推断存于 `src/features/group-mode-store.ts`（模式变化打 `[group-mode]` INFO），`/bot-group-info` 命令展示推断+生效配置（排障"这群为什么没上下文"）。msg_elements 渲染在 body-assembler `buildMsgElementsContext`：预渲染文本直通（防 `=== 消息` 二次包裹）、quote 与其余元素并列渲染（quote.source==='msg_elements' 时跳过第 0 个元素）、元素级 attachments 渲染 `[附件]` 行。
- **群消息排队交给框架（coalesce.enabled）**: 消息**逐条立即 dispatch**，排队/合并由 openclaw followup 队列承担：dispatch 侧为群 turn 传 `replyOptions.queueModeOverride`（`coalesce.enabled=true`→`'collect'` 合并批处理；`false`→`'followup'` 排队不合并——尊重"关合并"意图且远比框架默认 steer 安全）。插件内建 coalescer 已删除（不再有 `strategy:'plugin'` 回退路径）。群 turn `admission` 从 `cancel-only` **修正为 `'exclusive'`**（框架约定 durable ingress 用 exclusive；cancel-only 是 gateway chat.send 的取消身份语义）且仍不传 abortSignal——"不打断正在处理的 turn"由框架队列保证（room_event/collect 均 `shouldSteer=false`）。session key 保留 `:coalescing` 后缀（纯历史遗留命名，框架侧无语义，保存量会话 lane 不断）。每进程首条群消息打 `[queue]` INFO 确认接管。
- **room_event 终态（全量群 opt-in，默认关）**: `groups.<gid>.unmentionedInbound: 'room_event'` 开启后——policyInjector 动态置 `requireMention=false`（mentionGate 放行全部并保留 wasMentioned 标记），dispatch 侧分类：`wasMentioned = mentionGate 判定(@) || detectWasMentioned(mentionPatterns 称呼唤醒) || quote 引用 bot(mentionGate isImplicitMention + ref-index)`；均未命中且非斜杠命令 → `InboundEventKind='room_event'` 写入 ctxPayload，replyOptions 附 `sourceReplyDeliveryMode:'message_tool_only'`——框架自动：最终文本不投递（结构性沉默，**连 NO_REPLY 指令都不注入**）、压 typing/流式、排队不 steer、只放行 `message` 工具主动发言。被 @/称呼/引用 → 正常 user_request（NO_REPLY 标签机制照旧，框架自动注入提示词）。**称呼唤醒**的 patterns 来自 `agents.list.<id>.groupChat.mentionPatterns`（如 `["沈处"]`，`resolveMentionPatterns` 解析）——SOUL.md 人设名**不会**自动生效，必须显式配置；仅全量群有效（AT 群平台不推未 @ 消息，room_event 自然退化）。**历史去重**：room_event 群 historyBuffer 的 groupKey 返回 undefined（每条消息已进框架持久化 transcript，插件快照会造成双份上下文），gateway 出站历史记录同步跳过。成本提示：每条消息一次推理 pass，collect 批量缓解；务必配 rateLimiter（见下）。**message 工具出站红线**：`channel.ts` 的 `qqbotThreadingAdapter.buildToolContext` 必须返回 `{currentChannelId, currentMessagingTarget}`（从 `context.To` 透传限定目标 `qqbot:group:{gid}` / `qqbot:c2c:{openid}`）——返回 undefined 会让 message_tool_only 的隐式当前来源发送落入框架 **internal-ui sink**（WebUI 显示 "Sent visible reply ... via internal-ui"，只进 openclaw 会话记录，QQ 侧无消息、无出站 HTTP 请求，2026-09-09 用户反馈事故；回归测试在 tests/room-event.test.ts）。
- **出站被动优先（保 1000 条/天主动预算）**: 全链路 msg_id 优先——(1) outbound 契约层 `resolvePassiveFirstReplyToId`（outbound-adapter.ts）：框架未给 `ctx.replyToId` 时从 msgid-cache 取最新未过期 msg_id（message 工具/框架直发路径由此走被动）；(2) 网关层 `attachMsgIdWithQuota`（qqbot-gateway.ts，替代裸 attachMsgId）：无显式 msgId 时挂缓存 msg_id 前**经 quota-manager 原子预检+扣减**，配额耗尽则不挂（降级主动，修复旧实现连续共用同一 msg_id 超限后平台 40034128 硬失败无兜底的问题），API 抛错 rollback。显式 opts.msgId 视为上游已记账（quotaReserved 链），网关不重复消费。残余主动发送按账号计数于 `src/features/proactive-budget.ts`（跨天重置，80% 告警，`/bot-group-info` 展示）。静群（>5min 无缓存，群 TTL 与平台被动窗口对齐）只能主动——这是平台约束不是 bug。
- **群历史模式 historyMode**: 默认 `clear`（回复后整清，"自上次回复以来的窗口"）；`rolling`——bot 出站也记入 historyBuffer（gateway `storeEntry` 附 `isBot:true` 条目），回复后 `trimGroupHistoryAfterLastBot` 裁剪到最后一条 bot 发言之后（对齐 telegram selectAfterLastSelf，AI 下次可见自己上次说到哪）。
- **三层限流已启用（默认开）**: middleware-setup 的 rateLimiter 不再无参挂载——默认 sender 20/min、group 60/min、global 300/min，触发打 `[rate-limit]` INFO（不自动回复，避免烧配额）；账号级 `channels.qqbot.rateLimit`（`{enabled,perSender,perGroup,global}`）覆盖，`{enabled:false}` 关闭。room_event 群务必保持启用。`member_role`（admin/owner）已从 raw.author 提取进 `sender.roles`（ctx-builder），供框架权限分级。
- **No secrets in repo code**: appid/secret is configured via `openclaw channels add --token "appid:secret"` or env vars `QQBOT_APPID` / `QQBOT_SECRET`. Never hardcode or log credentials.
- **`package-lock.json`**: listed in `.gitignore` but actually tracked in git — regenerate with `npm install` (see the `external` gotcha above) and expect a lockfile diff; don't `npm ci` against a fresh clone.
- **Quota management**: QQ Bot enforces passive reply limits (C2C: 4 replies/msg_id within 60min; Group: 5 replies/msg_id within 5min). The plugin automatically falls back to proactive messaging when quota is exhausted. Use `ReplyLimiter` (src/outbound/reply-limiter.ts) for custom quota handling. See `checkAndConsumePassiveReplyQuota()`（原子 check+consume+rollback）与纯探测 `checkPassiveReplyQuota()` in src/features/quota-manager.ts.
- **Typing renewal**: C2C typing indicator (`sendTyping`) automatically renews every 20s minimum (QPS constraint). When quota is exhausted, typing falls back to proactive mode (without msg_id). Typing also auto-renews after outbound messages (5s delay) to maintain the indicator during streaming/chain-of-thought. See `c2cTypingIndicator` middleware and `POST_MESSAGE_REFRESH_DELAY_MS` constant.
- **指令面板自动同步** (`src/features/command-panel.ts`, 挂载于 `initFeatures`): gateway ready 后把 openclaw **tier=essential 原生指令**注册到 QQ Bot 指令面板（`/v2/panels`，2026-08-12 平台新接口，经 SDK `bot.api` 通用网关调用，无需 SDK 类型化封装）。c2c/group 各一个面板（`target_type=all`），自家面板用 `panel.remark = "openclaw-qqbot:auto:<scope>"` 打标做幂等识别——**remark 不匹配的面板（用户手建的）绝不触碰**。平台约束：name ≤14 字符（`/export-session`、`/export-trajectory` 因此被跳过，最终 8 项）、desc ≤30、每面板 ≤20 项、POST 限 10 QPM。面板 `command` 项点击只是**把指令文本填入输入框**，用户发送后以普通文本进框架走文本斜杠指令路由——所以插件**不声明 `capabilities.nativeCommands`**（QQ 无结构化调用事件，声明反而与 `commands.text:false` 冲突）。配置门控 `channels.qqbot.commands.native`（默认 true）；每进程每账号只同步一次（防 `resumed` 重连重复触发，失败释放 guard 待重连重试）；失败只记日志绝不阻断启动。
- **入站事件守卫** (`src/middleware/inbound-guard.ts`, 挂载于 messageFilter 之后、policyInjector 之前): 拦截三类「非真实用户输入」的平台推送（2026-09-07 事故：AI 的后台 poll 任务被空内容推送反复 steer 打断，AI 回"没新消息…继续 poll"——AI 把这些事件误读成"QQ 系统回执 hook"）。(1) **出站回声**：SDK message-filter 注释明示 QQ 会把 bot 自身出站消息回投为入站事件（群聊按 `author.bot` 识别，c2c 无该标记）——`skipSelfEcho` 必须保持 `true`，c2c 回声由 `outbound-echo-store`（近期出站 `msg.id`，30min TTL，`wrapBotSendForRefIndex` 登记）比对兜底；若平台回声携带新 id 而非原 id，比对会 miss，由(2)(3)兜底。(2) **重复推送**：平台事件文档要求按 msg_seq/`message_scene.ext` 的 `msg_idx` 去重（"为确保消息可达，相同 msg_id 可能重复推送"，重连/重启后常见），SDK 内置窗口仅 5s，守卫补 30min 长窗口（键 `accountId:kind:msgId:msgIdx`，内存 Map，跨重启不保留）。(3) **空内容事件**：content 空白且无 attachments 且无 msg_elements 的推送直接丢弃；**带 msg_elements 的 103 引用/转发消息是真实用户操作，必须放行**（quoteRef 渲染引用块）。每次拦截打 INFO 日志（`[guard] dropped ...` 含 msgType/scene/payload 摘要）——这是入站事件唯一的非 DEBUG 级痕迹，事后取证靠它。网关另注册了 `bot.on('rawEvent')`（INFO 记录一切未被 SDK 映射的平台推送：入群申请、好友变动、reaction、media_upload_finish、未来新增类型）——此前这些被静默丢弃，是诊断盲区。排查入站问题记住：除 `[guard]`/`[rawEvent]` 外，所有能识别入站事件的日志都是 DEBUG 级（SDK `Dispatch event: t=... payload=...`）。
- **ask_user buttons**: single-question prompts render one inline keyboard (`qqbot:q:` button_data) resolved via `questionGatewayRuntime.resolveOption`. Multi-question prompts (2-3 questions) arrive **text-only** (the framework's v1 contract: no structured options in `channelData.askUser`); the plugin parses the prompt text (`parseMultiQuestionPrompt`), sends one card per question (`qqbot:qm:<recordId>:<qIdx>:<oIdx>`), and buffers taps in an in-memory store. When all questions are answered the plugin sends a **confirm card**: an instruction button (`action.type=2`, `enter: true`) whose data is the full keyed answer text (`"1: 3\n2: 1"`), which the QQ client emits as a **real user message** — the framework's native keyed-text claim then resolves the pending ask_user. A second `enter: false` button pre-fills the input for manual editing. **Never** submit multi-question answers programmatically: official openclaw has no multi-question submit API for channels (maintaining a fork costs more than it buys), and synthesizing an inbound user message fails because the framework steers it into the ask_user-suspended run without claiming the question (2026-08-24 incident). Inbound text is **never intercepted** for multi-question answering — real messages must reach the framework untouched. Parse failures (secret/malformed) fall back to plain text. Display: button labels are truncated (`buildButtonLabel`, ~12 CJK chars) with full options in the card body; rows auto-split when labels are wide. `isOther` questions (detected via the "Other: reply..." line) get a `✍️ 其他` **instruction button** (`action.type=2`, pre-fills `"N: "` in the client input box) so free-text answers are one tap + typing away.
- **Secret input flow** (`qqbot_secret_input` tool, c2c only): AI calls the tool with an env var `name` → plugin sends a card (with a `取消` instruction button) and registers a one-shot pending (`src/features/secret-input-store.ts`, TTL 10min, keyed `accountId:c2c:<openid>`) → the user's next c2c text message is **intercepted** by the `secretCapture` middleware (`src/middleware/secret-capture.ts`, mounted between slashCommand and groupMessageCoalescer) and executed via `openclaw secrets store set` (`src/features/secret-store-cli.ts`) — the message never reaches the framework (the secret must never enter the AI transcript). Kind is **always `env`** (agent-readable environment value, written via `--value`): openclaw 2026.9+ splits the store into agent-readable env vs protected write-only secrets, and a chat-card value is both already exposed in QQ history and needed readable by the AI afterwards — storing it as `secret` made it unusable (2026-08-30 user feedback). The executor's secret/stdin branch is retained as generic capability with no current callers. The plugin composes the command (spawn + args array, `shell` never used); the AI only supplies the name (validated `^[A-Z][A-Z0-9_]{0,127}$`). Cancel keywords (`取消`/`cancel`/`#cancel`/`/cancel`) abort; empty messages keep waiting. **Red line**: the capture middleware yields (passes through) whenever a multi-question ask_user is pending for the same conversation — ask_user answer messages must never be swallowed. After a successful write the plugin best-effort runs `openclaw secrets reload`. Known accepted trade-offs: (1) openclaw's plugin install scanner logs a *critical* `dangerous-exec` warning for the `node:child_process` spawn — local installs are NOT blocked (hard blocks are dependency-name denylist only); (2) the spawned CLI must be the **same openclaw install as the running gateway** — `resolveOpenClawCli()` resolves from `process.argv[1]`'s package root first, then `require.resolve('openclaw')`, then PATH. Never let it fall back to the repo's pinned dev copy when the gateway is the global install: state-DB schema is owned by the gateway's version and an older CLI refuses the write (2026-08-30 incident: dev copy 2026.8.1-beta.3/schema 9 refused the global 2026.9.1/schema 12 DB, exit 1); (3) secrets inevitably remain in the user's QQ chat history — the card copy warns about this.

## Skills (under `/skills/`)

- `qqbot-channel` — Guild/Channel API operations (notes/posts/schedules). Trigger: 用户提到「频道」「子频道」等.
- `qqbot-remind` — `qqbot_remind` tool for cron-based proactive messages.
- `qqbot-upgrade` — `/bot-upgrade` hot-update flow.

These are loaded by the host AI; they guide behavior, not build steps.

## Verification

Before claiming a change works:

```bash
npm run typecheck                   # tsc --noEmit
npm run build                       # ensure tsup post-build succeeds
npx tsx tests/<affected>.test.ts    # run the relevant test file(s)
```

For behavior changes in `src/gateway/`, `src/dispatch/`, or `src/outbound/`, at minimum run the matching `tests/*.test.ts` (e.g. `session-key.test.ts`, `body-assembler.test.ts`, `middleware-chain.test.ts`, `room-event.test.ts`, `dispatch-lifecycle.test.ts`).

## Misc

- Plugin IDs: `openclaw-qqbot` (plugin), `qqbot` (channel). Don't confuse them.
- Slash commands live in `src/commands/` — each is a separate file, registered via `buildCommandList()` in `src/commands/index.ts`.
- Default text chunk limit: 5000 chars (`TEXT_CHUNK_LIMIT` in `src/channel.ts`).
- Logging: use `createPluginLogger()` from `src/utils/plugin-logger.ts`. Don't use `console.*` directly except in early `register()` paths where the runtime logger isn't wired up yet.

## QQ Bot 平台能力 vs 其他 OpenClaw 通道

QQ Bot 跟 Telegram / Discord / Slack 等其他通道在平台 API 形态上差异较大,这些差异是不可消解的,设计时必须以此为前提。

### 底层依赖

- 完全依赖官方 Node.js SDK `@tencent-connect/qqbot-nodejs` (v1.0.4)。`@tencent-connect/qqbot-connector` (1.2.0, 精确钉版) 仅用于扫码登录 setup 流程。
- **SDK 版本滞后于平台文档**（2026-09 核查）: npm 上 SDK latest 仍是 1.0.4 (2026-07-14 发布)，未覆盖平台 2026-08-10 / 08-12 更新 —— 接口域名统一为 `api.bot.qq.com`、群禁言管理（查询/设置用户禁言）、入群申请审批（拉列表/审批）与自动审批策略、自定义菜单、指令面板、Markdown 新参数 `force_verify_image_resource`、入群申请事件。其中 REST 新接口**今天就可经 `qqbot_platform_api` 工具调用**（SDK `bot.api` 是任意 path 的通用网关，自动鉴权/重试），类型化封装等 SDK 发版；入群申请**事件**与 `force_verify_image_resource` 参数则依赖 SDK 更新。
- **API 域名现状**: 官方 2026-08-10 起统一为 `api.bot.qq.com`；旧域名 `api.sgroup.qq.com` 仍在服务、无下线公告，两域名已验证路由一致（同 path 返回相同业务错误码）。网关默认 baseUrl 仍指向旧域名（`src/gateway/qqbot-gateway.ts` 构造 `new QQBot({...})` 处），`QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` 环境变量可随时覆盖 —— 将来切换新域名只需改默认值，不需要等 SDK 发版（SSRF 白名单只拦插件自身的媒体/图片 fetch，不拦 SDK 的 API 调用）。
- SDK 自身是 `https://bot.q.qq.com/wiki/develop/api-v2/` 上公开的 HTTP REST + WebSocket Gateway 协议的薄封装 — 本插件不直接 hit `https://bots.qq.com` / `https://api.sgroup.qq.com` 任何 endpoint,所有进出都走 SDK。
- `bot-instance.ts` 用 `new QQBot({...})` 构造;所有 `sendText`/`sendMedia`/`sendTyping`/`openStream` 调用最终落到 SDK 的 `QQBot.ts` 内部方法。
- **不要在本仓库中绕过 SDK 直接 fetch QQ API** — 一旦绕过就脱离了 SDK 的 token 缓存、重连、事件路由、消息缓存等机制。

### 平台一级概念:没有的话题 / 频道 / Forum

- QQBot 平台**没有 Telegram 那种 DM topic / forum supergroup / Slack channel** — 全部会话只有两种 scope:
  - `c2c` (私聊,一对一)
  - `group` (群聊,@ 全员或 @ 单人)
- 另有一个独立的「频道/Guild」产品(笔记、子频道、时刻表),**插件基本不处理** — 频道有自己的 OpenAPI 域(`sgroup.qq.com`),与主通道不共享 session / dispatch / streaming 路径。如果以后要做频道,也是单独一个 skill / 独立模块,不要混进 c2c/group 的 dispatcher。
- 所以**别拿 Telegram 的 thread_id / topic / supergroup 之类概念来对齐 QQBot** — 写代码前先确认这个能力在 QQ 上压根不存在。

### 平台一级概念:同一个 API,通过参数切换"被动 / 主动 / 互动召回"

QQ 跟 Telegram 的最大差异在**回复机制**:

- **私聊和群聊都只有一个 HTTP 入口**:
  - 私聊:`POST /v2/users/{user_openid}/messages`(文档:`bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html`)
  - 群聊:`POST /v2/groups/{group_openid}/messages`(文档:`bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html`)
- **同一个 API,通过是否带 `msg_id` / `event_id` 区分"被动回复" vs "主动推送"** — 三者**互斥**:

| 模式 | 触发 | 配额 | 有效期 |
|------|------|------|--------|
| **被动回复** (passive) | `msg_id` 或 `event_id` 二选一 | 私聊 4 次/msg,群 5 次/msg | 私聊 60 min,群 5 min |
| **主动推送** (proactive) | 都不传 | 私聊 Bot 维度 10/qps(未认证 5/qps + 30/qpm),群 60/qpm;接收方 20/qpm,1 天最多 1000 条 | 无 |
| **互动召回** (wakeup) | `is_wakeup=true`,与 msg_id/event_id 互斥 | 30 天内 4 周期,每周期 1 条 | 30 天 |

- 接口级统一 QPS 上限 100。
- 错误码 `40034128` = 被动回复时间/次数超限;`40034100` = 主动消息超限;`40034122` = 互动召回达上限。

### "流式"是另一种发送通道,不是回复模式

- **不要把流式跟被动/主动混在一起** — 流式是**另一套** API:
  - `openStream` 创建流(仅 c2c,群不支持流式参数)
  - `session.update` 多次替换(已发送的 prefix 不可修改)
  - `session.complete` 收尾
- 流式**没有"流式配额"**,但流式通道里的回复消息(`session.update` 推送)仍走 C2C 被动回复配额(同上表,4 次/msg/60 min)。
- 见 `src/middleware/typing.ts`:`typing` 通知复用 `ReplyLimiter`(4/msg 配额),与真回复共享额度 — 防止 thinking 流把配额烧光。
- 见 `src/outbound/reply-limiter.ts`(`ReplyLimiter`,默认 4/msg_id,10k LRU,C2C TTL 60 min)。
- 见 `src/features/msgid-cache.ts`:C2C `msg_id` 缓存 30 分钟,群 5 分钟(主动消息场景 cron/proactive 用)。

### 平台一级概念:Markdown 渲染

- QQ Bot 客户端**原生支持 Markdown 渲染**,服务端通过 `msg_type` 字段区分。
- 在 `new QQBot({ markdownSupport: true })` 启用后,SDK 自动选 `markdown` msg_type,客户端按 Markdown 渲染。
- 没有 Telegram 那种 `parse_mode: 'HTML'` + 服务端 markdown→HTML 转换。**也没有 HTML parse 失败回退** — 写得越界的 Markdown 会被 QQ 客户端渲染异常,代码层没有像 `withTelegramHtmlParseFallback` 那样的兜底。
- `src/outbound/sanitize.ts` 仅做一层内部 scaffolding 标签剥离(`<system-reminder>` / `<thinking>` / `` `think`…`/think` ``),保留 Markdown 给 SDK。

### 平台一级概念:OpenID 命名空间

- 用户在 QQBot 平台唯一标识是 `openid`(32 字节 hex 或 UUID 字符串),不是数字 ID。
- **OpenID 跨账号不通用** — bot A 拿到的 user openid 在 bot B 上完全无意义。
- 这影响:
  - `Multi-account` 隔绝:`src/config.ts` 解析时 OpenID 在每个 `accountId` 命名空间下独立。
  - 跨账号会话假设不成立:不能共享 `allowFrom` / `pairing store` 等。
  - URL 路由:私聊 targetId 是字符串,不是数字 — `parseTarget` (`src/outbound/target.ts:51-63`) 接受 `qqbot:c2c:<openid>` 格式。

### 平台一级概念:WebSocket / Webhook 双传输

- SDK 默认 WebSocket 长连接,跟 Telegram polling 体验类似。
- 也支持 Webhook 模式(`transport: 'webhook'`)用于 HTTP 回调,见 `src/adapter/webhook.ts`。
- 两种模式对中间件、事件监听、消息发送 API 是一致的;**插件层无差异处理**。

### 与 Telegram 的能力映射(快速对照)

| 能力 | Telegram | QQBot |
|------|----------|-------|
| 私聊 | DM (`chat.type === 'private'`) | C2C (`scope === 'c2c'`) |
| 群 | group / supergroup / forum | group (`scope === 'group'`) |
| DM topic / forum / thread | `message_thread_id` | **不存在** |
| 频道/Guild | channel | 独立 QQ 频道产品(走 `qqbot-channel` skill) |
| Markdown 渲染 | 服务端 `parse_mode: HTML` | 客户端原生 `msg_type: markdown` |
| 引用回复 | `reply_to_message_id` / `reply_parameters` | `msg_id` 被动回复 |
| 编辑消息 | `editMessageText` 自由改 | `openStream` 多次 `session.update` 替换,prefix 不可修改 |
| Typing | `sendChatAction(action=typing)` | `sendTyping` (仅 c2c) |
| 流式 | editMessageText 多次 | `openStream` + `session.update/complete` (仅 c2c) |
| 配额 | 无 | 被动回复 4/hour/msg_id;主动发送每日配额 |
| 长连接 | long polling / webhook | WebSocket (默认) / Webhook |

### 平台对齐的"对齐"指什么

- 源码中大量出现 `// 对齐 telegram` 注释(`src/dispatch/dispatch.ts:29, 165, 227, 274, 282, 358, 401` 等;`src/middleware/typing.ts:60, 64`)— 指的是**用户体验层面**:typing、失败兜底、debounce、abort、per-user session 等行为,不是 API 调用一一对应。
- **不要试图把 QQ 的 `sendText`/`openStream`/msg_id 机制强行映射到 Telegram 的 `sendMessage`/`editMessageText`/`reply_to_message_id`** — 形态不同,语义相通。

### 文档 / 进一步阅读

- QQ Bot 官方: `https://bot.q.qq.com/wiki/develop/api-v2/`
- API 更新日志: `https://bot.q.qq.com/wiki/develop/api-v2/changelog.html`（注意：`/wiki/changelog/` 根路径是 2022 年的旧页面，别用）
- SDK 源码: `node_modules/@tencent-connect/qqbot-nodejs/src/QQBot.ts`(所有 methods 都在这)
- SDK README: `node_modules/@tencent-connect/qqbot-nodejs/README.md`
- 平台差异分析历史:见 `docs/` 下相关笔记。
