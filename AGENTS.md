# AGENTS.md — openclaw-qqbot

`openclaw-qqbot` — OpenClaw 通道插件，把 QQ Bot 官方 API 接入 OpenClaw framework。独立维护的 fork，自 v1.0.0 起独立发版（发版流程见 CHANGELOG.md，tag v* 触发 .github/workflows/release.yml）。

> **本文是「索引 + 红线」层**：只保留动手前必须知道的事（能踩的坑、必须守的约束、去哪查细节）。深度叙事在 `docs/agents/` 下按主题分文件，**改对应模块前先读该文件**——里面的「为什么」比本文的「是什么」更能防止你改出回归。
>
> 深度文档索引：
> | 文件 | 覆盖范围 | 何时必读 |
> |---|---|---|
> | [docs/agents/sdk-compat.md](docs/agents/sdk-compat.md) | openclaw 版本盯版、plugin-sdk 子路径增删、ambient stub、守卫测试 | 动 `openclaw/plugin-sdk/*` 引用、升级钉版 |
> | [docs/agents/session-and-dispatch.md](docs/agents/session-and-dispatch.md) | canonical session key 文法、route 文法、10.5 指令/投递语义 | 动 session key 构造、路由回退、指令处理 |
> | [docs/agents/config-and-credentials.md](docs/agents/config-and-credentials.md) | 配置面、凭据读取、通道能力声明、manifest schema | 改 `src/types.ts` 配置类型、凭据路径、`capabilities` |
> | [docs/agents/outbound-and-quota.md](docs/agents/outbound-and-quota.md) | 被动/主动配额、msg_id 锚点、媒体投递、progress card | 动发送路径、配额扣减、媒体策略 |
> | [docs/agents/chunking.md](docs/agents/chunking.md) | 字形簇安全分块、结构上下文开销封顶 | 动 `src/outbound/chunker.ts` / `grapheme.ts` |
> | [docs/agents/streaming.md](docs/agents/streaming.md) | 流式生命周期、段模型、final 承接判定、park 语义 | 动 `streaming-controller.ts` 或 dispatch 流式分支 |
> | [docs/agents/group-and-room-event.md](docs/agents/group-and-room-event.md) | 群三模式、room_event、合批、群历史窗口 | 动群聊策略、合批、唤醒判定 |
> | [docs/agents/inbound.md](docs/agents/inbound.md) | 入站防抖、白名单回告、事件守卫、语音转录、限流 | 动中间件链、入站分类、附件处理 |
> | [docs/agents/interaction.md](docs/agents/interaction.md) | ask_user 按钮卡片、Secret 输入、webhook detached 派发 | 动按钮卡片、凭据输入、webhook 传输 |
> | [docs/agents/platform-capabilities.md](docs/agents/platform-capabilities.md) | QQ 平台语义：被动/主动/互动、流式通道、Markdown、OpenID、双传输、Telegram 对照 | 拿 Telegram 直觉套 QQ、设计平台交互时 |

**构建基线：openclaw `2026.10.5`**（peer 范围 `>=2026.10.5`，devDependency 精确钉版 `2026.10.5`）。所有与 openclaw / `openclaw/plugin-sdk` 的交互以 2026.10.5 为最低兼容版本 —— 不得使用仅存在于更新版本中的 API，除非带能力探测与回退。抬地板判据、历史盯版实测与 2026.10.2/10.5 的子路径增删全量，见 [docs/agents/sdk-compat.md](docs/agents/sdk-compat.md)。

## Commands

```bash
npm run build        # tsup → dist/index.cjs + dist/index.d.cts (CJS only, target node18)
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit
npm run lint:runtime # 扫描 adapter/ 之外的直接 runtime 访问（src/adapter/lint.ts）
```

**No `npm test` script.** Tests are standalone scripts run with `tsx`：

```bash
npx tsx tests/<name>.test.ts          # run one file
```

All tests use `node:assert` + a hand-rolled `test()` helper and run directly via `tsx`.

**全量测试是 CI 的职责**：ci.yml 在每次 push / PR 跑全部测试文件（glob `tests/*.test.ts`，当前 60 个），本地不做全量跑（tsx 冷启动太慢）。本地只在调试单个用例时跑单文件（可选，非门禁）。**覆盖率同样只在 CI 统计**：Test 步骤经 `NODE_V8_COVERAGE` 收集 V8 profile，Coverage report 步骤用 `c8`（`--all --include 'src/**' --include 'index.ts'`）聚合，逐文件表格 + 总百分比写入 Actions run 的 Step Summary——本地不要跑覆盖率。

**守卫测试**（改动命中对应领域时，它们就是你的验收清单，不只是 CI 装饰）：

| 测试文件 | 守的是什么 |
|---|---|
| `tests/sdk-surface.test.ts` | plugin-sdk 子路径存在且能 require、ambient stub 新鲜度、钉版一致性、`dist/index.cjs` 可加载 |
| `tests/manifest-config-schema.test.ts` | manifest schema ↔ TS 配置类型逐字一致（改配置类型必红） |
| `tests/fallback-route-key.test.ts` | 兜底 session key 过 canonical + route 两道文法 |
| `tests/chunker-grapheme.test.ts` / `tests/chunker-context-overhead.test.ts` | 字形簇切点、结构上下文开销封顶 |
| `tests/streaming-parked-finalize.test.ts` | 流式 park / 取消 / 补发 / 媒体完整性 |

## 环境搭建与隔离（新环境 bootstrap，2026-09-21 约定）

新机器/新容器搭环境，与 CI 完全对齐（ci.yml：Node 24 + `npm install --no-fund --no-audit`）：

```bash
node --version                 # 期望 v24.x（tsup target node18 是产物目标，不限开发机版本）
npm install --no-fund --no-audit
npm run typecheck && npm run lint:runtime && npm run build   # 秒级自检，全绿即环境可用
```

**隔离规则**：

- 依赖只装项目内 `node_modules/`，**禁止任何全局安装**（`npm i -g`、改全局 npm 配置）；构建/测试一律 `npm run <script>` 或 `npx`（自动走项目内 `node_modules/.bin`）。
- **不要 `npm ci`**（fresh clone 一律 `npm install`，见下文 lockfile gotcha）。
- **npm 11 `allowScripts` 拦截是预期状态、保持不放行**：install 时 npm 会警告 5 个包的 install 脚本不在 `package.json` `allowScripts` 白名单（`openclaw` pre/postinstall、`koffi`、`tree-sitter-bash`、`protobufjs`、`@google/genai`）。刻意如此：openclaw 的 postinstall 会往用户目录写 bundled plugins（破坏环境隔离），且 CI 同样不执行这些脚本、测试照样全绿。白名单只保留 `esbuild`（tsup/tsx 的关键依赖，必须执行）——**不要 `npm install-scripts approve` 放行上述任何包**。
- **lockfile 零 diff 预期**：`package.json` 未改动时 fresh install 后 `git diff package-lock.json` 应为空（lockfile 与 npm 11 + 主流镜像同步，cn 区域常用腾讯镜像 `https://mirrors.tencent.com/npm/`）；出现意外 diff 说明 npm 版本或 registry 漂移，先排查再继续——确属依赖变更产生的 diff 才随 PR 提交（lockfile 虽在 `.gitignore` 但实际被 git 跟踪）。

## Git workflow（main 为保护分支）

- **禁止直接 push 到 main**（GitHub branch protection）。任何开发——功能、修复、文档——一律走 `分支 + PR`：
  1. 从最新 main 切分支，命名 `<type>/<短描述>`（如 `fix/room-event-echo`、`docs/agents-md`）
  2. 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `ci:` / `refactor:`，breaking change 加 `!`，如 `refactor!:`）——与仓库现有历史一致
  3. push 分支、开 PR；CI（ci.yml，push + pull_request 双触发）必须全绿（typecheck / lint:runtime / build / 全量测试）
  4. 合并后删除远端分支
- **PR 不自动合并（2026-09-10 约定）**：CI 全绿 ≠ 已授权合并——review 与合并由仓库主人决定。开完 PR、CI 全绿后即停，把 PR 链接交回并等待主人亲自合并或明确授权；打 `v*` tag 发版等下游动作同样必须等合并完成且主人确认后再执行。
- **PR 提请前本地自检（秒级）**：`npm run typecheck` + `npm run build`；**测试一律由 CI 执行**（本地全量太慢），PR 的 CI 全绿即测试通过——本地 `npx tsx tests/<file>.test.ts` 仅作单用例调试
- **发版不受分支保护影响**：release.yml 由 `v*` tag 触发，tag 打在已合并进 main 的提交上（`git tag v1.0.0 && git push origin v1.0.0`，branch protection 不拦 tag push）；完整流程见 CHANGELOG.md「发版操作手册」
- **gh CLI 注意**：本仓库 git remote 走代理（github.jerryliang.win），gh 无法从 remote 推断仓库，PR/issue 操作需显式 `--repo jerryliang122/qqbot-openclaw`

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
  features/             # pairing, approval, ref-index, history, command-panel
  adapter/              # contract probe, media, resolve, webhook, workspace
  setup/                # QR login (start/wait), account-key, finalize, surface wizard
  tools/                # platform.ts (qqbot_platform_api), remind.ts, secret-input.ts (qqbot_secret_input)
  utils/                # logger, mention stripping, pkg-version, SSRF guard, STT
  openclaw-plugin-sdk.d.ts  # local type stubs for openclaw/plugin-sdk
```

Plugin exports include `qqbotPlugin`, `getBotForAccount`, `QQBotGateway`, `sendText`, `sendMedia`, `parseTarget`, `dispatchToOpenClaw`, `StreamingController`, `PersistedRefIndexStore`, `ReplyLimiter`, quota management functions, and typing lifecycle functions.

## Key gotchas

以下每条都是**红线**（改错了会出线上事故）。括号里的文件是深度说明，含「为什么」与历史踩坑——动手前必读。

### SDK 依赖面（[详情](docs/agents/sdk-compat.md)）

- **SDK 子路径被删 = 插件整体加载失败，typecheck 不设防。** openclaw 删子路径时连 `.d.ts` 一起删，`dist/index.cjs` 加载期就抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，所有功能全灭且本地完全无声。守卫在 `tests/sdk-surface.test.ts`——**它按引号字面量取子路径全集，不解析 import 语句形态**（初版只认静态 `import`，漏掉动态 import / 字面量 require / re-export 四种承重用法，评审实测确认下版本子路径删除照样全绿放行）。豁免必须显式登记 `EXEMPT_SUBPATHS`，别靠「扫不到」。运行时断言必须放**子进程**（tsx 会 patch `Module._resolveFilename`，进程内直接 require 会误报 ESM-only 依赖缺失）。`import { fn, type Opts }` 的 inline `type` 要逐项判 type，否则守卫误报「缺少运行时值」把人引向不存在的缺陷。
- **裸子路径 `openclaw/plugin-sdk`（无后缀）不在包 exports 里**——运行时 require 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。本插件对它只有 `import type`，永远不要从裸路径做值导入。
- **ambient stub 会遮蔽包内真实类型，留着等于没验证。** `src/openclaw-plugin-sdk.d.ts` 当前只剩两段（裸入口 + `text-utility-runtime`），升级钉版时先删掉包已提供类型的 stub 段再跑 typecheck。
- **`preload.cjs` 不能删改名**——它同步建 `node_modules/openclaw` junction，删了插件在框架里加载失败。
- **`tsup` post-build 的 `sanitizeDist()` 是承重的**——把 `new Function` 改写成 `new _F`（protobufjs 模式触发安全扫描器），别剥。
- **钉版必须恒等于 peer 承诺的最低版本**——两者脱钩就测不出「误用旧版没有的 API」，虚假承诺只在用户运行时炸。
- **Runtime contract probe 的 `REQUIRED` 列表是空的**，全部能力按 `OPTIONAL` 处理，别指望它 fail-fast。

### 配置面与凭据（[详情](docs/agents/config-and-credentials.md)）

- **改配置类型必须同步 manifest schema，否则用户配置被直接拒收。** 唯一来源是 `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`（顶层 + `accounts.<id>` 两处逐字一致），框架走 `validatePluginSchemaValue`（`applyDefaults: true`，对 `additionalProperties:false` 和 `enum` 都做值校验）。typecheck 不设防——`tests/manifest-config-schema.test.ts` 是唯一防线，红了先补 manifest，不要绕过守卫。
- **`resolveQQBotAccount` 全程不读盘**——它是热路径（每次出站发送都解析一次账号），同步 `stat`/`readFileSync` 会阻塞事件循环。凭据文件只在账号启动时读一次。
- **内联密钥与凭据文件强制互斥**——两者同时存在时内联优先、文件静默忽略，写入时必须清掉另一个；注销要清 `clientSecretFile`。
- **`config.inspectAccount` 是只读巡检面，不 materialize 凭据**——`openclaw status` / doctor 不该为「描述配置」触发 token 交换或扫码。`secretStatus` 三态：`available` / `configured_unavailable` / `missing`。
- **`capabilities.tts.voice` 必须声明**，否则 TTS 被当普通音频文件发。本插件走 SILK 语音气泡，声明 `{ synthesisTarget: "voice-note", transcodesAudio: true, captionedFinalText: false }`——`captionedFinalText: false` 是必需的（QQ 语音不带文字说明，声明 true 会让终稿正文永不到达）。**`capabilities.nativeCommands` 刻意不声明**（QQ 指令面板是引导型 UI，声明会与 `commands.text=false` 冲突）。
- **`messaging.inferTargetChatType` 必须实现**——否则宿主只能走通用路由搜索，Gateway 一直报 `waiting for route`。其余一律 `undefined`（不猜）。

### Session key 与投递（[详情](docs/agents/session-and-dispatch.md)）

- **canonical session key 文法是 10.x 硬门槛**：key 必须满足 `agent:<agentId>:<rest>` 且全小写折叠形，裸通道前缀 key 或含大写的 key **直接拒写**（抛 `SessionCanonicalKeyMigrationRequiredError`，该 session 一切读写瘫痪、dispatch 全部 outcome=error）。生产路径走 `adapters.resolveAgentRoute` 天然合规；**兜底路由**（routing API 探测失败的安全网）必须用 `buildFallbackRouteSessionKey`。
- **canonical 过了不等于框架能反解出投递目标**——框架反解用 `parseSessionDeliveryRoute`，文法是 `<channel>[:<accountId>]:<peerKind>:<peerId>`，peer 段之后所有冒号分段都会被并进 peerId。兜底优先用框架原语 `runtime.channel.routing.buildAgentSessionKey`。
- **群 key 不含 accountId**（框架自身就不按账号隔离群会话），插件兜底也不该塞。
- **所有 c2c 用户默认共享 `agent:main:main` 一个 session**——要多用户隔离得让用户配 `session.dmScope: "per-peer"`。
- **10.5 的 admission ticket 发生在 replyResolver 之前**——忙碌会话里非 abort 类指令要等活动 turn 结束才被解释，「群里任务跑着发指令没反应」是预期排队语义，不是丢消息。

### 流式（[详情](docs/agents/streaming.md)）

- **流式是自研生命周期**（QQ 无消息编辑 API，原地更新物理上做不到），**「已投递什么」只能插件自己记**——框架没有 final/流内对账兜底。任何新增流式行为都必须在 `StreamingController` 边界补测试。
- **一段 = 一条 QQ 消息**（= 一条 assistant 消息）。**长度启发式已废除**（同轮重发会让长度判断误判成新回复），**跨段截断拼接已废除**（QQ replace 模式已下发前缀不可变更，跨段截断在用户侧就是「草稿」）。段边界由框架 `onAssistantMessageStart` + 工具调用驱动。
- **final payload 承接判定是三态不是二值**：`identical`（纯去重）/ `extension`（增量，如 usage footer）/ `unrelated`（无关重写）。static 模式下 `unrelated` 必须**整段补发**（此前被折叠成空串，600+ 字正文静默消失且终态仍记 `done`）；stream 模式下 `unrelated` 有意维持丢弃（流内内容已可见，补发会重复）。**`phase: streaming → done (finalize:fallback)` 不等于正文已送达**——要看 `[stream-final] payload received chars=N`。
- **不要把 `finalize:fallback` 改成 `failed`**——static 模式下 `shouldSuppressFinalTailFallback` 恒 true，改成 `failed` 等于主动关闭唯一那层兜底。
- **流式提前收尾用 park、不终态化**——终态化＝内容黑洞（此后 partial/flush/final 全被 `isTerminal` 守卫静默吞掉，零日志零请求）。**park ≠ 失败**（`shouldFallbackToStatic` 仍为 false）。
- **取消信号必须进队列复查**（TOCTOU）：`onPartialReply`/`flushSegment`/`closeSegment` 全都接收 `signal` 并在实际执行时复查。**ask_user 前置文本的 flush 必须 tolerant**（发送失败不终态化 controller，否则作答后的 partial/final 全被丢弃）。
- **`/usage` footer 靠 final payload 文本投递**，流式必须差量补发——`onPartialReply` 增量产生于追加之前，永远不含 footer。static 模式 `sendStatic` 失败**必须抛错**（吞错会把失败正文记为已投递）。

### 分块（[详情](docs/agents/chunking.md)）

- **框架 chunker 对无空白中文长串会在硬上限处截断**，切点落在 emoji（代理对 / ZWJ / 组合符号）中间就渲染成豆腐块；本地 GFM fallback 则是整块不切、超限消息被平台直接拒收（消息丢失）。`src/outbound/grapheme.ts` 用 `text-grapheme` 的 `findGraphemeChunkEnd` 做切点吸附，带能力探测 + 本地 `Intl.Segmenter` 等价回退。
- **本地回退必须逐行对齐官方 `dist/grapheme-*.mjs`**——尤其 `avoidTrailingHighSurrogateBreak` 的 `end + 1` 兜底分支（预算只剩 1 个码元且是代理对前半时，退到 `start` 会零进展、整块原样超限被拒收）。**官方契约允许「代理对安全的部分切」**——不要断言切点必须是簇边界。
- **结构上下文开销必须封顶**——围栏 info string 只取首个 token（超 32 字符视为没有语言标识）、降级路径逐级退（完整开栏行 → 裸 marker → 放弃）、上下文开销 > 正文预算时整段放弃上下文。此前两个漏洞叠在一起导致一条 5114 字消息被切成 5110 块且全部超限。
- **首刀不得落在围栏开栏行内部**，否则首块只剩一个孤零零的 ```js。

### 出站与配额（[详情](docs/agents/outbound-and-quota.md)）

- **出站锚点模型：显式锚点 or 主动（2026-11-03 移除池化选取）**——挂 msg_id 的被动消息在平台语义上是「对用户消息的回复」，锚点必须来自显式回复意图。网关 `resolveOutboundAnchor` 只透传显式 `opts.msgId`；**无显式锚点（message 工具不带 replyTo、remind/cron、框架直发）一律走主动发送**（烧每日预算）。**红线：禁止重新引入「从缓存挑 msg_id」的池化选取**——它会把回复引用挂到更早的错误消息上（历史演进 7a59a2c→bbed520→e3e2be7 为省预算引入，已按平台语义移除；代价：1000 条/天预算消耗、用户关「允许主动发送」时该类消息拒发）。
- **反应式配额（2026-11-03）：本地不按「次数」阻断被动发送**——探针实测平台**不执行**文档口径的 c2c 4 次/群 5 次 per msg_id 上限（同 msg_id 25 次全送达；typing 也不占额度）。本地只强制两个真实硬约束：TTL 窗口预检（c2c 60min/群 5min，40034005 确定性）与 msg_seq 单调发号（40054005）；count 仅观测（超文档上限打一次 INFO，**仅 logger 在场才置位**——否则标志会被无 logger 的消耗烧死；主出站路径须透传 logger）；**观测计数只升不降**——判死时不得回截 count（证据保全）。平台真拒绝时由网关死锚点兜底转主动。**禁止把 count 上限改回 preemptive 阻断**——那会逼正文白烧每日 1000 条主动预算、让进度卡被静默跳过。
- **锚点失效兜底**：被动发送被平台 **40034005**（过期）/ **40034128**（超限）确定性拒绝 → rollback + 驱逐 + 标记 dead → 同内容**转主动重发一次**。网络错（`httpStatus===0`，结果不明）**不重发**（有重复风险）。`passiveOnly` 发送（progress card）**不做主动重发**。
- **ask_user 问题卡必须挂本轮显式锚点（2026-11-05）**——问题卡（单题卡 / 多题卡 / 确认卡 / 状态回执）此前走 SDK 直发（请求体不带 `msg_id` ⇒ 平台按**主动消息**处理）：白烧每日 1000 条主动预算，且用户关「允许主动发送」时问题卡根本发不出去（模型空等 `ask_user` 超时）。现走 `outbound-service.sendText` + 本轮 inbound 的 `envelope.messageId` ⇒ 被动回复；锚点不可用（TTL 过期 / 平台判死）时**降级主动一次**（`src/outbound/question-send.ts`，同 progress card 口径）。**红线：禁止改回 SDK 直发**；**不得**让网关 `retryOnDeadAnchor` 兜底——那条主动重发路径不携带 keyboard（用户看到题干却无从作答），故降级必须由问题卡层自己做。
- **QQ 语音投递口径以「体积」为准，不是「时长」**——平台文档里没有任何语音时长限制，「60 秒以内是语音条」是相关性错觉。格式只认 silk/mp3/wav/ogg 四种；超 20MB 软限制由 `resolveOutboundMediaKind` **显式**降级为文件投递。
- **表情表态仅频道支持**（单聊/群聊 ❌），故 `capabilities.reactions: false` 是对的。
- **Progress card 先走被动回复、锚点失效降级主动**（`passiveOnly` 首试；**锚点无存活（无 msg_id / TTL 过期 / 死锚点）或平台判死（40034005 / 40034128）⇒ 降级为主动发送**——卡片按「前置消息」处理，烧每日 1000 条主动预算但用户仍能看到进度；降级状态本轮记忆，后续快照直接走主动），支持 checklist（`📋 进度 N/M`，框架自动计数行被抑制）与 note 双形态（markdown-only 卡片 → `📋 状态`，判定式 `steps=[] && explanation 非空`；note 截断必须**字形簇安全**——复用 `outbound/grapheme.ts`，禁止按码元硬切切碎代理对；混合形态的 markdown 在框架投影层被丢弃——插件侧无解）——反应式配额下无本地次数门（`reserveQuota` 保槽配置已删除，残留会被 schema 拒收），唯一保险丝是 `maxPerTurn`。
- **typing 永不占用主动额度（2026-11-03）**——typing（msg_type=6）不占被动回复额度，但**绝不降级为「不带 msg_id 的主动形态」**：锚点不可用（TTL 过期 / 死锚点 / 平台 40034005·40034128 拒收）⇒ **本轮停发**（turn 内中间件与心跳路径同口径）。主动额度（每日 1000 条）留给正文与前置消息，typing 不参与竞争。平台拒收 typing 时须 `invalidateMsgIdQuota` 标记死锚点（本轮后续消息一律不得走被动回复）。

### 群聊与 room_event（[详情](docs/agents/group-and-room-event.md)）

- **群聊三模式由平台决定，插件不可控**（AT 纯模式 / AT+最近N / 全量），**插件无需也不应按模式分流**——三事件共用 intent、SDK 映射同形态、走同一条中间件链。模式推断存 `src/features/group-mode-store.ts`，`/bot-group-info` 展示。
- **room_event 的三处裁决必须同源**——门控（policyInjector）、入站分类（dispatch）、历史缓冲跳过三处共用 `resolveGroupRoomEventPolicy` 的一份结论，**三处各算各的必然出事**（门控放行 + 分类成 user_request = 刷屏；门控拦掉 + 分类成 room_event = 永远收不到消息）。
- **回落链必须能区分「未配置」与「显式配置」**——靠 `ResolvedGroupConfig.unmentionedInboundExplicit`，否则框架级配置永远不生效。
- **可见回复模式按 turn 判定、且按会话类型隔离**——群/频道读 `messages.groupChat.visibleReplies`，非群只读 `messages.visibleReplies`。**群级 `message` 工具守卫的 allow 缺失/为空 + alsoAllow 非空 = 不限制**（core `unionAllow` 会合成 `["*", ...]` 隐式全放行，按排他白名单判会误降级）。确定不可用时该群降级回 user_request + 每群一条 WARN。
- **agent profile 不是阻塞项**——core 在 `message_tool_only` / `room_event` turn 会把 `message` 强制并入 profile 允许集。
- **群工具策略红线**：`resolveToolPolicy` 返回 `{allow: []}` = 什么都不允许（连 message 工具都被过滤）→ room_event 群彻底沉默。框架回调的 groupId 派生自 session key（**小写**），QQ openid 配置键原生**大写**——`lookupGroupEntry` 必须大小写不敏感查找，否则 adapter 路径永远落默认值。
- **群消息合并在插件侧做**——框架 collect 合批对「同群不同人」无效（分组键含 `senderId`，遇第一个不同 key 就 break）。插件自建 busy 信号 + `createInboundDebouncer` 合批，**批次键按群不按人**。合并内容不能直接拼 N 条 agentBody（history 块会重复 N 份），历史必须取**批前基线**（最早成员的快照）。
- **合并载体 = 按平台 timestamp 排序后最后一条消息的 ctx**——中间件链并发执行，入队顺序 ≠ 到达顺序。

### 入站（[详情](docs/agents/inbound.md)）

- **c2c 入站防抖合并**——配置优先级 `channels.qqbot.inboundDebounce.debounceMs`（0=关闭）→ 框架 `messages.inbound.byChannel.qqbot` → 默认 3000。**三类旁路必须在 `shouldDebounce` 内返回 false**（而非 enqueue 早退）：控制命令、斜杠命令、ask_user keyed 答案。**旁路不能被运行中的 turn 阻塞**——框架 enqueue 对旁路项会排队等 in-flight 任务链 settle，插嘴语义完全失效。
- **白名单拒绝必须回告，不能静默丢弃**——c2c 恒回告（带被拒者自己的 OpenID + 配置路径），群仅在被 @ / 引用 bot 时回告（群提示是公开广播）。**`disabled` 是管理员显式拉下的总闸，此时保持静默**。@/引用判定必须与 mentionGate 同源（`isQuoteOfBotMessage` 共用）。发送锚点取自 `ctx.replyTarget.msgId`（被拒消息自身，SDK 直发不占配额记账）——**保持 SDK 直发、不改走网关**（历史上池化时代网关会挑到更早的缓存锚点；池化已移除，但直发语义依旧正确）。
- **入站事件守卫**拦三类非真实用户输入：出站回声（`skipSelfEcho` 必须 true）、重复推送（补 30min 长窗口，SDK 内置仅 5s）、空内容事件（**带 msg_elements 的 103 引用/转发必须放行**）。
- **入站语音走框架转录管线**——配置只认框架 `tools.media.models`（**不是 `tools.media.audio.models`**），严格信框架：失败一律占位不回退平台转写。**平台转写来源的语音元数据整体静默**（正文已含全文，渲染会逐字重复）。`channels.qqbot.stt` 整块废弃被忽略。
- **三层限流默认开**——sender 20/min、group 60/min、global 300/min。room_event 群务必保持启用。
- **`#ROBOT1.0_<id>! ` 前缀是框架 `formatRoomEventLine` 把消息 id 合并进正文**，不是平台塞进 content。修复方向是改写格式（传 `AmbientTranscriptBody`）而非剥离入站正文。**刻意不设 `AmbientTranscriptWatermarkKey`**——那是 telegram 专属路径。

### 交互面（[详情](docs/agents/interaction.md)）

- **webhook 模式的 op:0 派发必须挂 detached 准入根**，且**光包 `runDetachedWebhookWork` 不够**——回调内还要等「本次委托派生的在途派发」全部落地才 settle，否则 detached 根随 ACK 释放、bug 原样复现。报错文案是四分支兜底句「temporarily unavailable」，**网关并没有 drain**。
- **多问题 ask_user 绝不能程序化提交**——官方无多问题提交 API，合成入站用户消息会因框架 steer 进 ask_user-suspended run 而不被认领。**多题问答进行中（c2c、多题 pending 武装期间）的入站文本一律本地暂存为当前题答案、不转发框架**（2026-11-11 红线再界定，issue #99 / PR #100）：平台无法区分「用户手打的普通消息」与「指令按钮代发的回调内容」——两者都是普通入站消息；中间态文本转发给框架只会撞上 `validateAnswers` 的 partial 拒收 + 重问循环（白烧一轮、两侧状态分裂），且靠中间态词汇猜意图必然失效。**全部答完后**才由插件把全量 keyed 答案作为**客户端代发的真实用户消息**（`type=2` + `enter=true`）送出，框架据此认领。**边界**：仅多题 pending 武装期间 + 仅 c2c；单题 pending / 无 pending 时文本照旧原样转发框架；斜杠命令（`/` 开头）照旧放行（逃生通道）。**分类只认形态**（回调载荷恒为插件生成的 keyed 形态 `"N: v"` × N 行，非 keyed 即用户手打），**不靠内容语义猜**。
- **ask_user 卡片由插件自渲染（单题 / 多题同构）**——渲染层在 `src/features/question-card.ts`：正文走插件自己的中文版式（去掉框架 3 行英文脚手架），按钮统一 `① ②` 前缀 + 截断。**单题文本反解失败 ⇒ 回退到「框架原文 + 旧键盘」**（不得产出半解析的卡片）。单题自由作答靠正文引导，**不加**「✍️ 其他」按钮（预填前缀会污染答案）。
- **单题作答不得被防抖合并污染**——单题卡发出后登记单问题 pending（**仅 c2c**），c2c 防抖与 secret-capture 在 pending 期间放行该会话文本；pending 清理：按钮 resolve 成功 / 卡片发送失败 / 该会话下一条入站消息 / TTL 兜底。
- **多题必须「整单提交」——「点一题解一题」在框架层不成立**——框架 `validateAnswers` 逐题要求非空（ask_user 归一化从不设 `allowEmpty`）⇒ 任何一次提交都要带齐全部题。**红线**：禁止程序化提交、禁止合成入站消息 ⇒ 提交只能靠**客户端代发的真实用户消息**（指令按钮 `type=2` + `enter=true`，data 写全量 keyed 文本）。
- **多题 c2c 走顺序发题，最后一题卡即提交点**——只发第 1 题，答完才发下一题；**最后一题的选项按钮是指令型**（携带全量 keyed 答案），确认卡因此消失。中间题选项仍是回调型（只收集）。**每题卡只有选项按钮**——**不挂「✏️ 改一改」**：想改前面的题，在最后一题点「✍️ 其他」（输入框会带上全部已答内容，改哪行都行）；卡片正文**必须**写清「想自己写答案怎么办」，但**只在按钮真实存在时**才提（不得指引不存在的按钮）。**群聊路径保持旧形态**（全部题卡 + 确认卡）——群里默认拿不到 `ask_user` 工具，多题在群里基本不会发生。
- **Secret input 的消息绝不进 AI transcript**——kind 恒为 `env`（agent 可读环境值）。**红线**：多问题 ask_user 待答时 capture 中间件必须放行。
- **互动事件只有 type 11/12 需要 ack**——其余类型回应无意义（type=14 误 ack code=0 会触发「会话已清空」小灰条）。**配置面板事件按 `data.type` 匹配且必须在类型路由分支之前检查。**

### 其他红线

- **No secrets in repo code**：appid/secret 经 `openclaw channels add --token "appid:secret"` 或环境变量 `QQBOT_APPID` / `QQBOT_SECRET` 配置。Never hardcode or log credentials.
- **群消息优先级链**：`groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account 级 `defaultRequireMention` → `true`（默认）。其他群配置字段（`ignoreOtherMentions/toolPolicy/name/prompt/historyLimit/historyMode/unmentionedInbound/coalesce`）同一 ??-cascade。
- **群历史模式 `historyMode`**：默认 `clear`（回复后整清）；`rolling`——bot 出站也记入 historyBuffer，回复后裁剪到最后一条 bot 发言之后。
- **10.5 会主动外发「💾 Learned:」通知**——非缺陷不修，规避用 `skills.workshop.autonomous.mode: "off"`。
- **openclaw 10.5 新增群话题（group thread）能力**——配置在**顶层 `cfg.broadcast["<channel>:<peerId>"]`**（不在 `channels.qqbot` 下），本插件尚未接入。
- **媒体 source 的 SSRF 防护是「假防护」**——只按小写 `http://`/`https://` 字面量前缀判定，`HTTP://` / `http:/` / 前导空格三种拼写可绕过（平台侧 URL 解析器会归一化）。**当前决定暂不加固**（触发前提是 agent 输出被污染，那一步成立时 agent 已有更强能力）。**触发器**：① 插件侧出现「先下载再上传」媒体路径；② 媒体 source 可信度假设从「可信」改为「不可信」；③ 出现提示注入可触达外部内容的部署形态。届时改用 `new URL(source)` 按 `url.protocol` 判定，并让 `resolveMediaSource` 用同一份解析结果决定 `{url}/{localPath}/{fileData}`。

## Skills (under `/skills/`)

- `qqbot-channel` — Guild/Channel API operations (notes/posts/schedules). Trigger: 用户提到「频道」「子频道」等.

These are loaded by the host AI; they guide behavior, not build steps.

## Verification

本地门禁只做秒级检查（2026-09-10 约定：全量测试太慢，一律交给 CI）：

```bash
npm run typecheck                   # tsc --noEmit
npm run build                       # ensure tsup post-build succeeds
```

**测试由 CI 执行**：push 分支 / 开 PR 后，以 ci.yml 的全量测试结果为准。行为改动（尤其 `src/gateway/`、`src/dispatch/`、`src/outbound/`）在 PR 描述里注明重点看哪些测试文件（如 `session-key.test.ts`、`body-assembler.test.ts`、`middleware-chain.test.ts`、`room-event.test.ts`、`dispatch-lifecycle.test.ts`、`streaming-parked-finalize.test.ts`），CI 全量都会跑到。

## Misc

- Plugin IDs: `openclaw-qqbot` (plugin), `qqbot` (channel). Don't confuse them.
- Slash commands live in `src/commands/` — each is a separate file, registered via `buildCommandList()` in `src/commands/index.ts`.
- Default text chunk limit: 5000 chars (`TEXT_CHUNK_LIMIT` in `src/constants.ts`).
- Logging: use `createPluginLogger()` from `src/utils/plugin-logger.ts`. Don't use `console.*` directly except in early `register()` paths where the runtime logger isn't wired up yet.

## QQ Bot 平台能力 vs 其他 OpenClaw 通道

QQ Bot 跟 Telegram / Discord / Slack 等其他通道在平台 API 形态上差异较大，这些差异是不可消解的，设计时必须以此为前提。**别拿 Telegram 的 thread_id / topic / supergroup 之类概念来对齐 QQBot**——写代码前先确认这个能力在 QQ 上压根不存在。

要点摘要（完整语义、被动/主动/互动配额表、Telegram 能力对照表见 [docs/agents/platform-capabilities.md](docs/agents/platform-capabilities.md)）：

- **底层依赖**：官方 Node.js SDK `@tencent-connect/qqbot-nodejs`（v1.0.4），`@tencent-connect/qqbot-connector`（1.2.0 精确钉版）仅用于扫码登录 setup。**SDK 版本滞后于平台文档**——REST 新接口今天就可经 `qqbot_platform_api` 工具调用（SDK `bot.api` 是任意 path 的通用网关），但入群申请**事件**与 `force_verify_image_resource` 参数依赖 SDK 更新。**不要在本仓库中绕过 SDK 直接 fetch QQ API**。
- **没有话题 / 频道 / Forum**——会话只有 `c2c` 与 `group` 两种 scope；频道是独立产品（有自己 OpenID 域，不共享 session / dispatch / streaming 路径），要做得单独开 skill / 模块。
- **同一个 API，通过是否带 `msg_id` / `event_id` 区分被动回复 / 主动推送 / 互动召回，三者互斥。** 被动：私聊 4 次/msg、群 5 次/msg（窗口私聊 60min、群 5min）；主动：私聊 Bot 维度 10/qps、接收方 20/qpm 且 1 天最多 1000 条；互动召回：30 天内 4 周期。错误码 `40034128` = 被动超限、`40034100` = 主动超限、`40034122` = 互动召回达上限。
- **「流式」是另一种发送通道，不是回复模式**——`openStream` / `session.update` / `session.complete`（**仅 c2c**），流式没有独立配额但其推送消息仍占 C2C 被动配额。已下发 prefix 不可修改（改了 40007）。
- **Markdown 由客户端原生渲染**（`msg_type: markdown`），**没有 Telegram 那种服务端 parse_mode 转换，也没有 HTML parse 失败回退**——写得越界的 Markdown 会渲染异常，代码层无兜底。
- **OpenID 跨账号不通用**——bot A 的 user openid 在 bot B 上完全无意义，影响 allowFrom / pairing store / URL 路由。
- **WebSocket（默认）/ Webhook 双传输**——插件层消息处理行为无差异；唯一例外是 webhook 模式专属的**准入跟踪**（见 Key gotchas 的 webhook 条目），那是对「HTTP 请求级准入 vs 常驻连接级准入」这一宿主差异的补偿，不是行为分叉。
- **「对齐 telegram」注释指的是用户体验层面**（typing、失败兜底、debounce、abort、per-user session），不是 API 调用一一对应。
