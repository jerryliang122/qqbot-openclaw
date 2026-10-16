# AGENTS.md — openclaw-qqbot

`openclaw-qqbot` — OpenClaw 通道插件，把 QQ Bot 官方 API 接入 OpenClaw framework。独立维护的 fork，自 v1.0.0 起独立发版（发版流程见 CHANGELOG.md，tag v* 触发 .github/workflows/release.yml）。

**构建基线：openclaw `2026.9.1`**（peer 范围 `>=2026.9.1`，devDependency 精确钉版 `2026.9.1`）。所有与 openclaw / `openclaw/plugin-sdk` 的交互以 2026.9.1 为最低兼容版本 —— 不得使用仅存在于更新版本中的 API，除非带能力探测与回退；调整钉版前必须重新评估兼容性（2026-09-07 曾钉 2026.9.2——彼时 registry `latest` stable；2026-09-22 降回 2026.9.1，实测兼容：9.2 新增的 6 个 plugin-sdk 子路径——control-ui / feature-contract / feature-plugin / realtime-transcription-session / realtime-voice-provider / speech-provider——本插件均未使用，system-agent 审批面两版逐字一致，state DB schema 两版同为 15，typecheck / lint:runtime / build 全绿）。2026.9 系列的审批面变化：`ChannelApprovalKind` 新增 `"system-agent"`（OpenClaw 系统变更审批，2026.9.1 stable 起即存在），插件已支持（eventKinds、`buildSystemAgentApprovalText`、button_data `approve:v2:system-agent:...`），且 `resolveApprovalOverGateway` 改用带 `approvalKind` 的规范重载（无 kind 的旧签名已 deprecated，两版签名一致）。

**2026.10.x 盯版结论（2026-10-12 实测，基线仍钉 2026.9.1）**：openclaw `2026.10.2` **整体移除了 9 个 plugin-sdk 子路径**——`channel-message`、`channel-lifecycle`、`channel-reply-pipeline`、`command-auth`、`config-runtime`、`discord`、`infra-runtime`、`telegram-account`。本插件实际命中的**只有 `channel-message`**（唯一用法：progress card 的 `formatPlanChecklistLines`），其余 8 个均未引用（approval 侧被删的 `matchesApprovalRequestSessionFilter` / `resolveApprovalRequestAccountId` / `resolveApprovalRequestChannelAccountId` / `createChannelApprovalForwardingEvaluator` 本插件也都没用到）。修复方式是把该 import 迁到 **`openclaw/plugin-sdk/channel-outbound`**——该子路径 9.1 与 10.2 **都在**，`formatPlanChecklistLines` 签名两版一致（10.2 只是把 `plain` 选项标了 `@deprecated` 注明"retain until a breaking SDK release"，本插件未传该选项），故**对基线与新版本同时成立，无需动钉版与 peer 范围**。同批实测无碍：`ChannelApprovalKind`（两版均含 `"system-agent"`）、`replyOptions` 的 `onPlanUpdate` / `suppressDefaultToolProgressMessages` / `allowProgressCallbacksWhenSourceDeliverySuppressed` / `queueModeOverride` / `sourceReplyDeliveryMode`、`room_event` + `message_tool_only`、`resolveToolPolicy`、`appendUsageLine` 在 10.2 均原样存在；10.2 新增 `ChannelGatewayAdapterV2` / `ChannelGatewayContextV2` 是**可选的 gateway V2 契约**（`ChannelPluginForGatewayVersion` 按 `GatewayVersion extends 1|2 = 1` 分派），插件未声明 `apiVersion` 即仍走 V1，无需跟进。10.2 双跑 typecheck / lint:runtime / build / 全量 44 个测试文件全绿。**地板决策（2026-10-12 确认）：peer 与钉版一并保持 2026.9.1，不因新 stable 抬地板。**判据两条——(1) **钉版必须恒等于 peer 承诺的最低版本**，这是 typecheck 护栏与对外承诺之间的不变式；两者一旦脱钩（peer 还写 `>=9.1`、编译却在 10.2 上跑），我们就测不出"误用旧版没有的 API"，虚假承诺只在用户运行时炸，也正是 channel-message 事故的同类。(2) **只有适配真的切断了旧版本才抬地板**：适配若在新旧两版都成立（本次即如此——迁的是 `channel-outbound` 这个两版共有子路径，10.2 对 `channel-message` 是删除而非改签名，故可绕开），抬地板只会打断正在使用旧版的存量用户、换零能力收益。抬地板应只由这三个信号触发：上游明确放弃该旧版本 / 我们真要用新版独有 API 简化代码 / 存量用户归零。顺带：真抬地板时要一并考虑 openclaw 10.2 的 `engines` 已砍掉 Node 22（`>=24.16.0`），本包无 `engines` 字段故不会在安装期拦截，但会给 Node 22 用户埋运行时坑。**地板说谎的风险由 `tests/sdk-surface.test.ts` 兜底，不靠抬地板**——那才是验证强度。

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

**全量测试是 CI 的职责**：ci.yml 在每次 push / PR 跑全部 34 个测试文件，本地不做全量跑（34 个 tsx 冷启动太慢）。本地只在调试单个用例时跑单文件（可选，非门禁）。**覆盖率同样只在 CI 统计**：Test 步骤经 `NODE_V8_COVERAGE` 收集 V8 profile，Coverage report 步骤用 `c8`（`--all --include 'src/**' --include 'index.ts'`）聚合，逐文件表格 + 总百分比写入 Actions run 的 Step Summary——本地不要跑覆盖率。

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
- **npm 11 `allowScripts` 拦截是预期状态、保持不放行**：install 时 npm 会警告 5 个包的 install 脚本不在 `package.json` `allowScripts` 白名单（`openclaw` pre/postinstall、`koffi`、`tree-sitter-bash`、`protobufjs`、`@google/genai`）。刻意如此：openclaw 的 postinstall 会往用户目录写 bundled plugins（破坏环境隔离），且 CI 同样不执行这些脚本、34 个测试照样全绿。白名单只保留 `esbuild`（tsup/tsx 的关键依赖，必须执行）——**不要 `npm install-scripts approve` 放行上述任何包**。
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

- **`tsup` post-build hook** (`tsup.config.ts` 的 `sanitizeDist()`，由 `onSuccess` 触发): rewrites `dist/index.cjs` to alias `new Function` → `new _F` (protobufjs pattern that triggers security scanners). Don't strip this — it's load-bearing.
- **`preload.cjs` symlink**: `openclaw` is a `peerDependency`. When installed via `openclaw plugins install`, the plugin ends up under `~/.openclaw/extensions/openclaw-qqbot/`, and `openclaw/plugin-sdk` must be resolvable from the plugin's `node_modules`. `preload.cjs` synchronously calls `ensurePluginSdkSymlink()` (see `scripts/link-sdk-core.cjs`) which creates a junction `node_modules/openclaw` → the global openclaw install. If you remove or rename `preload.cjs`, the plugin will fail to load when installed via the framework.
- **`package.json` `external`**: `openclaw` and `openclaw/plugin-sdk/**` are external — they are NOT bundled. `dist/index.cjs` does `require('openclaw/plugin-sdk/core')` at runtime. Local dev needs `node_modules/openclaw` as a real install (or symlink to it). Dev copy is exact-pinned to the baseline via devDependency `openclaw@2026.9.1` so typecheck validates against the oldest supported API surface — keep every `openclaw/plugin-sdk` usage compatible with 2026.9.1 (capability probe + fallback if a newer API is genuinely needed) and don't bump the pin without re-checking compatibility. Stable 2026.9.1 satisfies the peer range, so plain `npm install` works; `--legacy-peer-deps` is not required. Note `package-lock.json` is listed in `.gitignore` but is actually tracked — installs will produce a lockfile diff. **裸子路径 `openclaw/plugin-sdk`（无后缀）不在包 exports 里**：运行时 require 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`——本插件对它只有 `import type`（会被擦除），且类型由本地 ambient stub 提供；永远不要从裸路径做值导入。
- **`src/openclaw-plugin-sdk.d.ts`**: ambient type stubs for `openclaw/plugin-sdk` subpaths the package doesn't type. 2026-09-07 起包已为 `core` / `setup` / `setup-tools` / `question-gateway-runtime` / `webhook-ingress` 等子路径提供正式 `.d.ts`（原 `src/typings/openclaw-webhook-ingress.d.ts` 已删除），这些 stub 已移除、typecheck 直接验证真实 SDK 类型。当前 stub 只剩两段且**都是必需的**：(1) 裸入口 `openclaw/plugin-sdk`（包既无 exports 也无类型，且代码大量 `import type` 它）；(2) `text-utility-runtime`（包 files 列表仍排除其 `.d.ts`）。升级 openclaw 钉版时先删掉包已提供类型的 stub 段再跑 typecheck——ambient `declare module` 会遮蔽包内真实类型，留着等于没验证。`tests/sdk-surface.test.ts` 的「ambient stub 新鲜度」用例会在包补上 `.d.ts` 时主动报错，不必靠人记。
- **SDK 子路径被删是运行时炸裂，typecheck 不设防 → `tests/sdk-surface.test.ts`（2026-10-12 新增）**：openclaw 删一个 plugin-sdk 子路径时**连 .d.ts 一起删**，tsc 只会报"找不到模块"，但真正致命的是**插件整体加载失败**——`dist/index.cjs` 在加载期就抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，所有功能全灭，且本地 typecheck 若没覆盖到该子路径就完全无声（2026-10-12 盯版：10.2 整体删了 9 个子路径，插件命中的 `channel-message` 即属此类）。该守卫测试把"插件引用的 SDK 依赖面"固化为可执行断言，**下一次**子路径消失会在 CI 就红：扫描 `src/**/*.ts` + `index.ts` 的全部 `openclaw/plugin-sdk/*` 引用 → 断言每个子路径都在已安装包的 `exports` 内 → 子进程用裸 node 断言每个子路径真能 require 出来（静态具名的值导入另查名级导出）→ 额外断言 `dist/index.cjs` 能被原生 CJS 加载器 require（复刻生产加载路径）。**扫描必须按引号字面量取子路径全集，不能解析 import 语句形态**：初版只匹配静态 `import {…} from`，评审实测确认漏掉四种同样承重的用法（`await import('…/approval-gateway-runtime')` 审批按钮 tap 核心路径、`import('…/question-gateway-runtime')` ask_user 问题流、`getReq()('…/health')` 一类字面量惰性 require、`export {…} from '…/setup-tools'`），下版本子路径删除照样全绿放行；形态会随代码演化增删，解析语句必然再次漏。**豁免要显式登记**（`EXEMPT_SUBPATHS`，默认空），别靠"扫不到"——`webhook-ingress` 虽是 `.catch()` 降级用法也不豁免，子路径被删时 `.catch` 会把故障吞成"webhook 静默失效"，比抛错更难发现。**写这类运行时断言必须放子进程**：openclaw 是 ESM 包、部分依赖（如 `unicorn-magic`）exports 只有 `import` 条件没有 `require` 条件，而 tsx 会 patch `Module._resolveFilename`，在 tsx 进程内直接 require 这些子路径会报 `No exports main defined in unicorn-magic`——那是加载器差异、**不是插件缺陷**，误判会让人去改本来没坏的代码。**具名子句要逐项判 `type`**：`import { fn, type Opts } from '…'` 的 inline `type` 若被剥掉后一律当值导出，接口在运行时不存在会让守卫误报"缺少运行时值"并把人引向不存在的 SDK 缺陷——inline `type` 是本仓库主流写法，扫描器必须支持。
- **Runtime contract probe** (`src/adapter/contract.ts`): `REQUIRED` list is currently **empty**; all capabilities are `OPTIONAL`. The probe still runs on register but only logs degraded features; it will never throw unless someone adds a required entry. Don't rely on it to fail fast on missing APIs.
- **Multi-account**: top-level `channels.qqbot.appId/secret` is the `"default"` account; additional accounts go under `channels.qqbot.accounts.<id>`. Each account gets its own gateway and token cache. OpenIDs are **per-account** — a user OpenID from bot A cannot be used by bot B.
- **Group message priority chain**: `groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account-level `defaultRequireMention` → `true` (default). Same precedence applies to other group config fields (`ignoreOtherMentions/toolPolicy/name/prompt/historyLimit/historyMode/unmentionedInbound/coalesce` all use the same ??-cascade).
- **群聊三模式矩阵（2026-09-09 群聊架构改造）**: 群主把 bot 拉进群时选推送模式（**插件不可控、同账号各群混合**）：(1) **AT 纯模式**——仅被 @ 时收到 `GROUP_AT_MESSAGE_CREATE`；(2) **AT+最近N（≤10）**——@ 事件的 `msg_elements` 携带最近消息记录（`MsgElement` 含 per-element author、message_type 102=聊天记录；示例3 为预渲染文本 `=== 消息 N ===`）；(3) **全量模式**——每条消息推 `GROUP_MESSAGE_CREATE`。两事件共用 intent `GROUP_AND_C2C_EVENT`(1<<25)、SDK 映射为同一形态（仅 `rawEventType` 保留）、走同一条中间件链——插件**无需也不应按模式分流**，per-group 模式推断存于 `src/features/group-mode-store.ts`（模式变化打 `[group-mode]` INFO），`/bot-group-info` 命令展示推断+生效配置（排障"这群为什么没上下文"）。msg_elements 渲染在 body-assembler `buildMsgElementsContext`：预渲染文本直通（防 `=== 消息` 二次包裹）、quote 与其余元素并列渲染（quote.source==='msg_elements' 时跳过第 0 个元素）、元素级 attachments 渲染 `[附件]` 行。
- **c2c 入站防抖合并（2026-10-14）**: 私聊除图片外文件与文字只能是两条独立消息（QQ 无"文件描述"附件窗口），而 c2c turn 可插嘴——后到的文字会直接 abort 正在处理的文件 turn（结构性缺陷，不只是体验问题）。`src/features/inbound-debounce.ts` 在 handleMessage 层把同发送者窗口内的连续消息合并为一次 dispatch，复用框架官方原语（`openclaw/plugin-sdk/channel-inbound` 的 `createInboundDebouncer` / `resolveInboundDebounceMs` / `shouldDebounceTextInbound`，telegram 通道同款；滑动窗口 + 框架硬上限 debounceMs×5）。配置优先级：`channels.qqbot.inboundDebounce.debounceMs`（0=关闭）→ 框架 `messages.inbound.byChannel.qqbot` / `messages.inbound.debounceMs` → 默认 3000。**红线**：(1) 合并载体 = **按平台 timestamp 排序后**最后一条消息的 ctx/msg（中间件链并发执行，附件下载慢的早到消息可能晚于快消息完成 enqueue——入队顺序 ≠ 到达顺序），`ctx.state.assembledBody` 与 `processedAttachments` 在载体 ctx 上**就地改写**（dispatch 侧唯一读取点；勿复制 ctx——上面挂着 bot/replyTarget 等原语）；(2) 纯附件消息必须防抖——与 telegram **相反**（telegram 默认 lane 媒体直发，`shouldDebounceTextInbound` 的 hasMedia 分支返回 false），本插件 hasMedia 刻意传 false、只借它的控制命令判定；(3) **三类旁路必须在 `shouldDebounce` 内返回 false**（而非 enqueue 早退）——控制命令（stop/esc/abort/exit）、斜杠命令（rawBody 以 `/` 开头，合并会破坏 buildCtxPayload 的命令标记）、多问题 ask_user keyed 答案（`findPendingMultiQuestionByConversation(accountId, 'c2c', peer)` 命中时，合并会改写 "1: 3\n2: 1" 使框架认领失败——**会话键含 accountId**，openid 是 per-account 的、跨账号同 targetId 不共享 pending，2026-10-14 Sourcery 评审发现 account-blind 键会让 A 账号的 pending 误命中 B 账号的旁路）——框架 debouncer 会先冲刷同 key pending buffer 再执行旁路项，顺序保持；enqueue 早退式旁路会绕过该序列化造成乱序；**且旁路不能被运行中的 turn 阻塞（2026-10-16 /stop 卡死修复）**——框架 enqueue 对旁路项在同 key 有 in-flight 任务链（keyChains）时会排队等其 settle，onFlush 若返回 `admission === completion`（completion 覆盖整个 turn run），任务 turn 运行期间到达的 /stop 就要等 turn 跑完才 dispatch，插嘴语义（c2c exclusive + abortSignal 取消旧 turn）完全失效，挂起 ask_user 的 keyed 答案更会被自己等待的 turn 死锁（框架实现 `dist/inbound-debounce-*.js` 的 enqueue keyChains 分支）；修法 = admission 与 completion 解耦：admission 在「turn 已入队框架 lane」（`dispatchToOpenClaw` 的 `onTurnSubmitted` 选项 = 框架 `turnAdoptionLifecycle` 的 onAdopted/onDeferred/onAbandoned 任一触发，**不是「inboundRun 已调用」**——框架 runChannelTurn 到真正入队还有 ingest/classify/preflight/resolveTurn 多个异步段，调用时放行会让 /stop 抢先入队而无处可取消，Sourcery 评审意见 2）时 resolve，completion settle 时兜底 admit，链永不悬挂；此后同 key 旁路必然晚于本 turn 入队，顺序确定。**跨窗口串行语义（2026-10-16 二轮评审显式拍板）**：放行在 lane 决策处的直接后果是**窗口外**的同发送者消息（如 10s 后再发的第二个文件）不再排队等运行中的 turn 跑完——turn B 以 exclusive 入场会放弃/abort 运行中的 turn A（v2.5.0–v2.6.0 因 admission === completion 的意外串行被放弃，c2c 恢复 pre-v2.5.0 的插嘴语义，对齐框架 `createInboundDebounceFlush` 在 adopted/deferred 即 markAdmitted 的契约；**窗口内合并——本特性的存在理由——不受影响**：连发文件+文字仍在窗口内并成单 turn）。刻意**不做**「只放旁路项插队」的收窄：那需要 enqueue 早退式旁路（红线 (3) 已否决）或对抗框架 debouncer 的链管理，且会让普通文字消息（改需求、追问）重现「等长任务跑完才 dispatch」的同款缺陷——/stop 只是这类消息里最典型的。退出冲刷两段式：flushKey 等 lane 决策、再等在途 completion（`activeCompletions`，宽限内能完成的 turn 把回复发完，Sourcery 意见 1），仍受 runtime.ts ≤1.5s 有界封顶。`DispatchToOpenClawOptions` 已随 `dispatchToOpenClaw` 在包根 index.ts 导出（Sourcery 意见 4）。回归测试 tests/inbound-debounce.test.ts「回归：旁路不被运行中的 turn 阻塞」（旧代码上该组用例复现 `1 !== 2`）；(4) **入队 await 语义（typing 续命）**：`enqueueC2CInboundMessage` 阻塞至该项所在 batch 的 dispatch 完成才 resolve（SDK `handleInboundMessage` 并发执行，held-open 的中间件链不阻塞其他消息），typing 中间件的续期 timer 据此活到 turn 结束；非载体项在 flush 开始时先 resolve（只留载体一个 typing 续期源）；**deferred 在 onError/onCancel 也必须 resolve，否则 handleMessage 永久挂起**；(5) 防抖中途被禁用（配置热更新）时必须先 `flushKey` 该发送者的 pending buffer 再返回 false 直发，否则旧 buffer 晚于新消息 flush 造成乱序 + 新 turn 被旧 turn 打断；(6) `entry.keys` 在 onFlush **同步前缀**里删除 batch 内 key（JS 单线程保证不与并发 enqueue 交错），防长期运行无限累积；(7) 框架 debouncer 的 `drain()` **不冲刷 pending buffer**（flush timer 是 unref 的，退出时永不触发）——退出冲刷必须对自跟踪的 key 逐个 `flushKey`（`flushAllC2CInboundDebouncers`）；SIGINT/SIGTERM 走有界等待（≤1.5s，runtime.ts shutdown），纯 exit 丢窗口内消息、无界等待会让 Ctrl+C 卡死；(8) 群聊恒不防抖（框架 collect 队列已承担合并，且 mention 门控语义要求逐条判定）；(9) 该配置在插件侧未实现前对 qqbot 是死配置（框架只在通道 ingress 主动消费 `messages.inbound.*`，外置插件的 inbound 路径无自动拦截）。**测试红线**：框架 flush timer 是 unref() 的——裸测试环境（无 WS 心跳等长活定时器）里依赖 flush timer 的 await 会让事件循环空转、进程带着未决 await 静默退出（表现为测试"挂起"无报错），必须用 ref'd 心跳保活（`keepAlive` helper）；keyed 旁路测试必须用独立 senderId——pending 多问题记录 TTL 内留在注册表，同默认 sender 会让后续用例的消息误命中旁路（跨测试污染）。回归测试 tests/inbound-debounce.test.ts（31 用例：配置矩阵 / 合并纯函数 / 窗口内合并 / 三类旁路保序 / 到达排序 / typing-hold / 滑动窗口 / 中途禁用保序 / 退出冲刷 / 运行中 turn 不阻塞旁路与 keyed 答案 / 放行取 lane 决策时点 / dispatch 失败不悬挂 / 退出冲刷两段式 / 跨窗口消息插嘴语义）。。
- **白名单拒绝必须回告，不能静默丢弃（2026-10-14）**: `dmPolicy/groupPolicy: "allowlist"` 未命中时，`dynamicAccessControl` 此前直接 `ctx.stop('access:not_allowlisted')`，用户侧零反馈——bot 挂了 / 装睡 / 配置写错三态无法区分，而 OpenID 是 per-account 的、配错本身就是高频操作。现由 `src/features/access-notice.ts` 在 stop 前发一条诊断消息：**c2c 恒回告**（文案带出被拒者自己的 OpenID + 配置路径，**命名账号的主路径必须是 `accounts.<id>.allowFrom`**，顶层键只属 default 账号、让用户改顶层会白改）、**群仅在被 @ / 引用 bot 时回告**（群提示是公开广播，bot 被拉进陌生群时逐条回「本群不在白名单」等于对外广播该 bot 配了白名单，全量推送群里还会变刷屏；命名账号在群里**只给「同名键在 `accounts.<accountId>` 下」的泛化指引、不得出现真实 accountId**）。**边界**：`disabled` 是管理员显式拉下的总闸，此时回话等于架空该开关，保持静默；`pairing` 模式本就已有配对挑战文案。**@/引用判定必须与 mentionGate 同源**：四路优先级 `rawEventType === GROUP_AT_MESSAGE_CREATE` → `mentions[].is_you` → content `<@!appId>` → 引用 bot 出站消息（`ref-index-store` 导出的 `isQuoteOfBotMessage`，**middleware-setup 的 isImplicitMention 与 access-notice 共用此函数**——两处各查一遍 ref-index 必然漂移，隐式引用语义一改就会在「以为被点名」与「实际没点名」之间错位）。**节流**：同一被拒实体（c2c = 发送者 openid / 群 = groupOpenid）10 分钟冷却 + 每账号每日 50 条上限（进程内存态，与既有 `proactive-budget` / SDK rateLimiter 同惯例——重启清零是可接受的防松紧度，非正确性约束）；`reserveAccessNotice` **预留即写表，`release()` 必须校验 token 才回滚**（一次发送挂起超过冷却窗口后同实体的**新**预留已就位，旧请求的迟到失败若无条件 delete key 会抹掉新冷却、用户紧接着再收一条重复诊断）；容量控制**宁可临时超出上限也不淘汰未过期条目**（淘汰会让节流形同虚设；条目寿命即冷却窗口，稳态规模自然封顶）。**发送路径有意不走网关、锚点取自 `ctx.replyTarget.msgId`（2026-10-14 二轮评审纠错）**：SDK 在 `handleInboundMessage` 里先 `deriveReplyTarget(raw)` 把入站 `messageId` 挂到 replyTarget、再 `createMiddlewareContext`、最后才组链（`chain = [...middlewares, downstream]`，`downstream` 是 emit("message")），故**中间件运行前 `ctx.replyTarget.msgId` 已就位**，`sendText` 见 msgId 即下发 `body.msg_id` 走被动回复。**关键反直觉点：被拒消息的 msg_id 并不在 msgid-cache 里**——插件的 `cacheMsgId` 挂在 `bot.on('message')`（链尾 downstream，经 `handleMessage` 调用），而 `ctx.stop()` 不调 `next()` 会让 `runMiddlewareChain` 在 `ctx.stopped` 分支直接 return，downstream 根本不执行（首轮曾误按「cacheMsgId 在链前」驳回 Sourcery 同款意见，二轮经源码核实推翻）。**故提示绝不能改走网关 `attachMsgIdWithQuota`**——它从 msgid-cache 选锚点，会挑到更早的缓存 msg_id 或无候选时降级主动，等于把每日主动预算暴露给刷屏者。已知残余：不走 `attachMsgIdWithQuota` 即不预扣被动配额、不受控发号（SDK 准随机 msg_seq），锚点已死时平台报 40034005/40034128 直接失败不转主动重发——对诊断消息而言这是可接受的保守方向。**发送必须套本地超时**（8s，默认值；`dynamicAccessControl` 的 `noticeTimeoutMs` 仅供测试注入短值）：请求挂住就永远走不到 `ctx.stop`、被拒消息一直悬着。**超时与确定性失败区别对待**：超时 = 结果不明（平台可能已投递）→ **保留冷却不回滚**，避免紧接着再发一条重复诊断；只有确定性失败才 `release()`。回归测试 `tests/access-notice.test.ts`（33 例）。
- **群消息排队交给框架（coalesce.enabled）**: 消息**逐条立即 dispatch**，排队/合并由 openclaw followup 队列承担：dispatch 侧为群 turn 传 `replyOptions.queueModeOverride`（`coalesce.enabled=true`→`'collect'` 合并批处理；`false`→`'followup'` 排队不合并——尊重"关合并"意图且远比框架默认 steer 安全）。插件内建 coalescer 已删除（不再有 `strategy:'plugin'` 回退路径）。群 turn `admission` 从 `cancel-only` **修正为 `'exclusive'`**（框架约定 durable ingress 用 exclusive；cancel-only 是 gateway chat.send 的取消身份语义）且仍不传 abortSignal——"不打断正在处理的 turn"由框架队列保证（room_event/collect 均 `shouldSteer=false`）。session key 保留 `:coalescing` 后缀（纯历史遗留命名，框架侧无语义，保存量会话 lane 不断）。每进程首条群消息打 `[queue]` INFO 确认接管。
- **room_event 终态（全量群 opt-in，默认关）**: `groups.<gid>.unmentionedInbound: 'room_event'` 开启后——policyInjector 动态置 `requireMention=false`（mentionGate 放行全部并保留 wasMentioned 标记），dispatch 侧分类：`wasMentioned = mentionGate 判定(@) || detectWasMentioned(mentionPatterns 称呼唤醒) || quote 引用 bot(mentionGate isImplicitMention + ref-index)`；均未命中且非斜杠命令 → `InboundEventKind='room_event'` 写入 ctxPayload，replyOptions 附 `sourceReplyDeliveryMode:'message_tool_only'`——框架自动：最终文本不投递（结构性沉默，**连 NO_REPLY 指令都不注入**）、压 typing/流式、排队不 steer、只放行 `message` 工具主动发言。被 @/称呼/引用 → 正常 user_request（NO_REPLY 标签机制照旧，框架自动注入提示词）。**称呼唤醒**的 patterns 来自 `agents.entries.<id>.groupChat.mentionPatterns`（如 `["沈处"]`，`resolveMentionPatterns` 解析，2026-10-06 起兼容 `agents.entries`（对象，现行）/`agents.list`（数组，旧形态）——只读 list 时 entries 配置下称呼唤醒全部失效，2026-10-06 线上事故）——SOUL.md 人设名**不会**自动生效，必须显式配置；仅全量群有效（AT 群平台不推未 @ 消息，room_event 自然退化）。**历史去重**：room_event 群 historyBuffer 的 groupKey 返回 undefined（每条消息已进框架持久化 transcript，插件快照会造成双份上下文），gateway 出站历史记录同步跳过。成本提示：每条消息一次推理 pass，collect 批量缓解；务必配 rateLimiter（见下）。**message 工具出站红线**：`channel.ts` 的 `qqbotThreadingAdapter.buildToolContext` 必须返回 `{currentChannelId, currentMessagingTarget}`（从 `context.To` 透传限定目标 `qqbot:group:{gid}` / `qqbot:c2c:{openid}`）——返回 undefined 会让 message_tool_only 的隐式当前来源发送落入框架 **internal-ui sink**（WebUI 显示 "Sent visible reply ... via internal-ui"，只进 openclaw 会话记录，QQ 侧无消息、无出站 HTTP 请求，2026-09-09 用户反馈事故；回归测试在 tests/room-event.test.ts）。**群工具策略红线（2026-10-06 线上事故，openclaw 2026.9.6+）**：框架会把 `qqbotGroupsAdapter.resolveToolPolicy` 的返回值作为会话工具策略**真正应用到 run 的工具集**——`{allow: []}` 空允许清单 = 什么都不允许（连 message 工具都被过滤）→ room_event 群彻底沉默（message_tool_only 下发言唯一通道被切断；≤9.5 框架不应用该返回值，旧 `restricted→{allow:[]}` 映射当时无害）。**工具策略来源已重构为配置驱动（2026-10-06）**：用户可通过 `channels.qqbot.groups.<groupId>.tools.allow` 声明自定义工具白名单，插件直接透传（支持 alsoAllow/deny 合并、toolsBySender 按发送者精细控制）。未声明 tools 时按 toolPolicy 兜底：full→undefined；restricted（默认）→ 插件内置默认工具集（message/web_search/web_fetch/x_search/session_status/heartbeat_respond/view_image/tts/cron/qqbot_remind）；none→显式全禁。且框架回调 adapter 的 groupId 派生自 session key（**小写**），QQ openid 配置键原生**大写**——`resolveGroupConfigFromAccount` 必须大小写不敏感查找（`lookupGroupEntry`，对齐框架 `resolveScopeKeyCaseInsensitive`），否则 adapter 路径永远落默认值。线上应急：给群配置**同时配大写与小写两个键**（或仅小写键）`toolPolicy: "full"`。回归测试 tests/group-tool-policy.test.ts。
- **出站被动优先（保 1000 条/天主动预算）**: 被动锚点的**选取/消耗/发号收敛到网关 `attachMsgIdWithQuota`（qqbot-gateway.ts）单点**（outbound-adapter 旧的 `resolvePassiveFirstReplyToId` 缓存兜底已删除）——(1) 显式 `opts.msgId`（quotaReserved 链，dispatch/deliver 显式锚点）直接透传，`msgSeq` 一并透传不重复消费；(2) 无显式锚点时（message 工具/框架直发）`selectMsgIdForPassiveReply`（msgid-cache）按接收时间**从旧到新**取第一条「平台窗口未过期且剩余额度>0」的候选（**旧配额先用先耗尽**，为最新消息保留完整额度做它自己 turn 的回复锚点），选中经 quota-manager 原子预检+扣减并发号 `msg_seq`（per-(account,msgId) 单调、从 1 起、失败只回滚 count 不回退 seq；经 `bot.send` 的 `extra.msg_seq` 显式下发，替代 SDK 准随机注入——SDK 仅在 body.msg_seq undefined 时注入；markdownSupport 分支与 `bot.sendText` 等价，`sendRaw` 自动补 msg_type），配额耗尽/无候选不挂（降级主动，修复旧实现连续共用同一 msg_id 超限后平台 40034128 硬失败无兜底的问题）。入站 `cacheMsgId`（event-handlers）以**平台事件 timestamp**（`Date.parse`，NaN 回退本地时钟）登记并 `registerMsgIdWindow` 预注册配额窗口（幂等，防重复推送重置；过期窗口自接收时刻起算——窗口**起点**锚定平台时间，比对仍用本地时钟，本地与平台若有偏差 Δ 会等量放宽/收紧判定，并非时钟无关），msgid-cache TTL 与配额层共用 `PLATFORM_PASSIVE_WINDOW`（c2c 60min/group 5min）。配额缓存容量控制：超限**先清扫过期条目**（含窗口已过的 dead 锚点）再按插入序 FIFO 淘汰，消耗/探测触达把活跃条目沉到队尾（LRU）——防止稳态下 FIFO 优先淘汰「最旧且窗口未过」的活跃锚点；条目被淘汰后消耗侧重建窗口时以 msgid-cache 登记的真实接收时刻为准（`checkAndConsume` 的 `receivedAt` 参数，**诚实重建**，不再无声以当下起算；无从得知接收时间时退回 now+TTL 并打 DEBUG；重建会使 seq 归零，锚点失效兜底自愈）。**锚点失效兜底**：被动发送被平台 **40034005（msg_id 已过期）/40034128（超限）**确定性拒绝（`ApiError.bizCode`）→ rollback + `evictMsgId` + `invalidateMsgIdQuota`（置 `dead` 标记，rollback 不得复活）→ 同内容**转主动重发一次**（计入每日预算）；网络错（`httpStatus===0` 结果不明，重发有重复风险）与其他业务码不重发；**`passiveOnly` 发送（progress card）不做主动重发**——清理死锚点后原错误上抛由上游丢弃。残余主动发送按账号计数于 `src/features/proactive-budget.ts`（跨天重置，80% 告警，`/bot-group-info` 展示）。静群（>5min 无缓存）只能主动——这是平台约束不是 bug。**msg_seq 已知残余**：媒体路径（SDK sendMedia 无 seq 透传位）与 **typing**（SDK sendInputNotify 同样无透传位，c2c 每 20s 续期+出站后 5s 补发）仍走 SDK 准随机 seq——同 msg_id 上小概率与插件单调序号碰撞（单次 ~4/65536，失败回滚下次自愈），且 typing 消耗会让计数器跳号（无害，唯一性不受影响）；排障时勿按「seq 已完全受控」假设推断。
- **流式是自研生命周期（QQ 无消息编辑 API），"已投递什么"只能插件自己记**: 框架有规范通道流式契约 `ChannelStreamingConfig`（`mode: "off"|"partial"|"block"|"progress"` + `nativeTransport`），其中 `partial` 的定义是 **"update one preview in place"（原地更新同一条消息）**——telegram 有编辑 API、slack 另有原生 `chat.startStream/appendStream/stopStream`，两者都能满足；**QQ 没有消息编辑 API，原地更新物理上做不到**，框架自身也把 QQBot 原生流式传输标为 unsupported（`openclaw doctor --fix` 会删掉 `streaming.nativeTransport` / `c2cStreamApi`，提示迁移到 `streaming.mode`）。故本插件 `streaming.mode: 'partial' | 'off'` 是**沿用旧 `nativeTransport` 时代的键名、语义与实现全自研**（`'stream'` 走 QQ 流式打印机只接受前缀增长 / `'static'` 走分段 flush + finalize 补发），`shouldUseStreaming()` 只判断 `mode !== 'off'`，与框架 `resolveChannelPreviewStreamMode()` 无交互、不存在双重驱动。**关键推论：QQ 这条路上「final 与已投递内容是否对账」没有框架兜底，账本在插件手里**——telegram 侧由框架持有可终结 draft 生命周期（`createFinalizableDraftStreamControls` / `deliverFinalizableDraftPreview`）并做 final/流内对账（`resolveTranscriptBackedChannelFinalText` → `selectLongerFinalText` / `isPotentialTruncatedFinal`，`channel-message` 与 `channel-outbound` 均导出，后者 9.1/10.2 都在，**引入它无需抬地板**）。因此流式类 bug 在本插件是**结构性重复出现的**（issue #8 首分片后静默 → `/usage` footer 差量补发 → issue #44 末段正文静默丢失），不是偶发：**任何新增流式行为都必须在 `StreamingController` 边界补测试**。
- **final payload 承接判定是三态，不是二值（issue #44 红线）**: `matchFinalText()` 返回 `identical`（已完全承接，纯去重）/ `extension`（final 是已承接内容的扩展，增量即 usage footer，静态并入缓冲、流式推入会话）/ `unrelated`（**final 与已承接内容毫无关系**）。`computeUnsentRemainder()` 是它的薄封装，**对外空串语义不变**（非 extension 一律 `''`）——但**内层必须用三态**：`unrelated` 在 static 模式 = 本段一条 partial 都没流出（此前被折叠进空串，导致 600+ 字最终正文既不进缓冲、差量又算不出，正文静默消失且终态仍记 `done`），现由 `absorbFinalText()` **整段补发**并推进账本（推进后 dispatch 末尾 `[stream-final]` 自动归零，不会两层各发一遍）；`unrelated` 在 stream 模式 = 模型重写，**有意维持丢弃**（流内内容已可见，补发会重复），仅 INFO 留痕。补发前置四条件全满足才动手：static 通道可用 / **缓冲为空**（缓冲非空说明本段已流出，属重写）/ 至少已发一段 / 未走外部投递通道。**排障红线：`phase: streaming → done (finalize:fallback)` 不等于正文已送达**——它只说明收尾时缓冲为空；补发成功走 `finalize:rescued`。又 **不要把 `finalize:fallback` 改成 `failed` 想让上层兜底**：static 模式下 `shouldSuppressFinalTailFallback` 恒 `true`，改成 `failed` 等于主动关闭唯一那层兜底（issue #44 原建议已被实测证伪）。排障取证的决定性事实是 dispatch 侧 `[stream-final] payload received chars=N`（framework 确实投了 final 文本）；**没有这条**说明框架根本没投 final 文本，属另一类问题、补发救不了。
- **群历史模式 historyMode**: 默认 `clear`（回复后整清，"自上次回复以来的窗口"）；`rolling`——bot 出站也记入 historyBuffer（gateway `storeEntry` 附 `isBot:true` 条目），回复后 `trimGroupHistoryAfterLastBot` 裁剪到最后一条 bot 发言之后（对齐 telegram selectAfterLastSelf，AI 下次可见自己上次说到哪）。
- **入站语音走框架转录管线（2026-10 重构；2026-10-04 起硬编码两分支、无插件级开关）**: 转录委托 `openclaw/plugin-sdk/media-understanding-runtime` 的 `transcribeAudioFile`（2026.9.1 基线内已有该子路径），STT 配置只认框架 **`tools.media.models`**（条目须显式 `capabilities: ["audio"]`，CLI/provider 两形态；**不是 `tools.media.audio.models`**——schema 中 audio 块不含 models 键，v2.0.0 曾误读该无效路径致探测恒 false、框架转录分支成死代码，2026-10-04 已修复；无标签条目有意不认——保守漏判只降级平台转写，误判在严格模式下会彻底无转写）。两分支：**未配置**（无 audio 条目或 `tools.media.audio.enabled: false`）→ 平台转写 `asr_refer_text` 直接作为唯一来源（不下载、零外部调用），无平台转写 → `[Voice message - transcription unavailable]` 占位；**已配置** → 下载（voice_wav_url 优先）+ SILK→WAV + 框架转录，**严格信框架**——失败/为空/下载失败一律 `[Voice message - transcription failed]` 占位、不回退平台转写、transcript 不携带 asrReferText（`- ASR:` 行只在平台转写为来源时渲染）。`channels.qqbot.stt` 整块废弃被忽略（凭证 4 键 + 历史 enabled/asrFallback，2026-10-04 连开关一并移除），检测到任何键打一次性迁移提示。判定函数两件套在 `src/utils/stt.ts`（`isFrameworkSttConfigured`/`hasLegacySttConfig`），管线在 `src/middleware/attachment.ts` `processVoiceAttachment`；SILK→WAV 转码与 `sttDirectFormats` 不变。回归测试 `tests/voice-transcript.test.ts`（20 用例锁新协议）。
- **三层限流已启用（默认开）**: middleware-setup 的 rateLimiter 不再无参挂载——默认 sender 20/min、group 60/min、global 300/min，触发打 `[rate-limit]` INFO（不自动回复，避免烧配额）；账号级 `channels.qqbot.rateLimit`（`{enabled,perSender,perGroup,global}`）覆盖，`{enabled:false}` 关闭。room_event 群务必保持启用。`member_role`（admin/owner）已从 raw.author 提取进 `sender.roles`（ctx-builder），供框架权限分级。
- **No secrets in repo code**: appid/secret is configured via `openclaw channels add --token "appid:secret"` or env vars `QQBOT_APPID` / `QQBOT_SECRET`. Never hardcode or log credentials.
- **`package-lock.json`**: listed in `.gitignore` but actually tracked in git — regenerate with `npm install` (see the `external` gotcha above) and expect a lockfile diff; don't `npm ci` against a fresh clone.
- **Quota management**: QQ Bot enforces passive reply limits (C2C: 4 replies/msg_id within 60min; Group: 5 replies/msg_id within 5min). The plugin automatically falls back to proactive messaging when quota is exhausted. Use `ReplyLimiter` (src/outbound/reply-limiter.ts) for custom quota handling. See `checkAndConsumePassiveReplyQuota()`（原子 check+consume+rollback）与纯探测 `checkPassiveReplyQuota()` in src/features/quota-manager.ts.
- **Typing renewal**: C2C typing indicator (`sendTyping`) automatically renews every 20s minimum (QPS constraint). When quota is exhausted, typing falls back to proactive mode (without msg_id). Typing also auto-renews after outbound messages (5s delay) to maintain the indicator during streaming/chain-of-thought. See `c2cTypingIndicator` middleware and `POST_MESSAGE_REFRESH_DELAY_MS` constant.
- **/usage footer 靠 final payload 文本投递，流式必须差量补发（2026-10-07 修复）**: 框架 `/usage off|tokens|full` 的 usage 行（`Usage: X in / Y out · cache … `，或 `messages.usageTemplate` 自定义模板渲染结果）是在**模型输出完成后**由框架 `appendUsageLine` 追加到 final payload 文本尾部的——`onPartialReply` 流式增量产生于追加之前，**永远不含 footer**。非流式路径整段发送 final 文本天然带上；c2c 开启流式后 dispatch 的流式分支会丢弃 final payload（"已由流式发过"去重），footer 随之丢失（telegram 用 final 文本整体收尾所以正常，2026-10-07 用户反馈 QQ 侧 `/usage tokens` 不显示）。修复（v2.2.2 起并入同一条消息）：`StreamingController.absorbFinalText` 在 final payload 到达、收尾 complete **之前**把未流出尾巴并入流式通道——stream 模式作为前缀增长推入当前会话（与普通 token 增长同形态，平台无感知）、static 模式拼进待发缓冲随 sendStatic 一条发出（顺带省一条独立 sendText 的被动配额槽）；合并经 `mergeSegmentBoundary`（基座右去空白、空基座去尾巴前导空白，对齐 final 文本的分隔边界，防双空行）；并入后推进差量基准防重复。isError payload 不吸收（默认路径整段重发会重复）；合并 signal 已中止不吸收且**信号传入 absorb、入队回调内重查**（dispatch 守卫与回调执行之间的 TOCTOU 窗口）——已取消的回复不得继续增长（finalize 仍关闭会话，只是不追加内容）。吸收不了的残余场景（tool payload 已提前 finalize 成终态、stream 无会话、static 缓冲已 flush）由 dispatch 末尾 `[stream-final]` 兜底单独补发；兜底抑制条件是 `shouldSuppressFinalTailFallback`——**仅「正文确定未送达」或「结果不明」才抑制**：static sendStatic 失败（正文整段未投递）、stream 无任何已接受分片、stream update 网络层失败（SDK ApiError `httpStatus===0`，平台可能已应用仅 ack 丢失——补发恐与流内内容重复，宁缺毋滥；`httpStatus>0` 为平台明确拒绝、确定未应用，正文已可见时照常兜底）。stream update 失败时对**已有已接受文本**的会话补发 DONE 收尾（`completeSession('update_failed')`），防用户端流式状态永久悬挂；无已接受文本的空会话不收尾（避免落空消息）。合并 signal 中止同样抑制。`lastDeliveredSegmentText` 记录最后已流出段落全文，`computeUnsentRemainder`（前缀扩展→增量；多段 final 拼全部段落→仅在**行首边界**命中最后一段之后切出，防旧段内嵌重写文本的伪匹配；归一化空白兜底须按 token 序列取**原始结束偏移**切片，防 footer 截断；完全不匹配→维持丢弃去重）。static 模式 `sendStatic` 失败必须**抛错**——吞错会让 controller 把失败正文记为已投递、照常收尾，用户只见 footer 不见正文。room_event 群（message_tool_only）final 本就不投递，footer 缺席属结构性沉默、非本问题。回归测试 tests/stream-usage-footer.test.ts。
- **Progress Card 逐条快照（2026-10-08 新增）**: agent 的 `progress_card` 工具（会话级 checklist，整体替换式更新）每次成功更新 → 框架 plan 事件 → dispatch 的 `replyOptions.onPlanUpdate`（telegram 同款契约）→ `ProgressCardPublisher`（src/outbound/progress-card-publisher.ts）渲染 checklist 快照（`📋 进度 N/M` 头 + ✅/▸/▢ 行，复用 SDK 共享渲染器 `formatPlanChecklistLines`，`openclaw/plugin-sdk/channel-outbound`——**注意 2026-10.2 已整体移除 `openclaw/plugin-sdk/channel-message`，该 import 必须走 channel-outbound**（两版都在，见基线段与 tests/sdk-surface.test.ts））作为**独立 QQ 消息**逐条发送——QQ 无消息编辑 API（telegram 是单条 draft 反复 edit），流式 update 只接受前缀增长、checklist 状态变化必然改行，做不到合并。**配额红线**：卡片**只走被动回复**——发送前 `getPassiveReplyQuotaRemaining`（quota-manager 纯探测，2026-10-08 新增）剩余 ≤ `reserveQuota`（默认 1，为最终回复保槽）即丢弃；outbound `sendText` 新增 `passiveOnly` 参数兜探测→发送竞态（配额不可用返回 `{error:'passive-quota-exhausted'}`，**不降级主动**——普通调用不受影响，只有卡片走 passiveOnly；**死锚点被平台 40034005/40034128 拒绝同样不转主动**——passiveOnly 透传网关，剔除死锚点后原错误上抛）。发送失败=丢弃（WARN，不重试、不计入「用户是否收到可见回复」判据）。**回调解锁标志**：`replyOptions.suppressDefaultToolProgressMessages: true`——verbose 关闭时 onPlanUpdate 转发的必要条件（quiet channel-owned progress；该标志本身不抑制任何东西，抑制框架默认计划状态消息的是另一个标志 `suppressToolProgressMessages`，刻意不传保持 verbose 现状）；room_event 群不传 `allowProgressCallbacksWhenSourceDeliverySuppressed` → 框架不转发 plan 回调 → 结构性无卡片。**停止时机**：deliverHandler 收到首个非 `kind='tool'` 投递（final/媒体/ask_user；`'tool'` 是 verbose 状态通知不算）即 `stop()` + `await drain()`（等 in-flight 发送落地再放行正文，防「卡片晚于答案」），dispatch 末尾 `dispose()`。**防抖语义（Sourcery #37 评审后）**：`minIntervalMs` 窗口内跳过的最新快照记 pending 由尾随定时器补发（stop/dispose/清卡会取消）——agent 更新完就不管时用户也能看到最新进度；**发送结果未知的失败**（平台报错/网络异常，消息可能已落地）记为已发送防重发且计入 maxPerTurn（保守计数），`passive-quota-exhausted`（本地拦截确定未发出）不记、同状态可重试；**清卡重置去重**（恢复同文本 checklist 重新发布）；**配额探测账号必须经 `resolveQuotaAccountId`**（含单账号回退，与 sendText 记账同键——否则回退场景探测乐观错位）。**时序陷阱**：mock dispatchReply 立即返回会先触发 dispose——测试必须在 dispatchReply mock 内部触发 onPlanUpdate/deliver（模拟 run 进行中），见 tests/progress-card.test.ts 的 midRun 手法。配置 `channels.qqbot.progressCard`（enabled/scope/minIntervalMs/maxPerTurn/maxLines/reserveQuota，默认 c2c 启用、群关、1500ms 防抖、每 turn 3 条、8 行、保 1 槽）；restricted 群默认工具集已含 `progress_card`。**Adoption 提醒**：纯通道 Gateway 框架不注入 progress_card reminder——要 agent 主动用卡，需在其 AGENTS.md/SOUL.md 自行引导。回归测试 tests/progress-card.test.ts（29 用例）。
- **指令面板自动同步** (`src/features/command-panel.ts`, 挂载于 `initFeatures`): gateway ready 后把 openclaw **tier=essential 原生指令**注册到 QQ Bot 指令面板（`/v2/panels`，2026-08-12 平台新接口，经 SDK `bot.api` 通用网关调用，无需 SDK 类型化封装）。c2c/group 各一个面板（`target_type=all`），自家面板用 `panel.remark = "openclaw-qqbot:auto:<scope>"` 打标做幂等识别——**remark 不匹配的面板（用户手建的）绝不触碰**。平台约束：name ≤14 字符（`/export-session`、`/export-trajectory` 因此被跳过，最终 8 项）、desc ≤30、每面板 ≤20 项、POST 限 10 QPM。面板 `command` 项点击只是**把指令文本填入输入框**，用户发送后以普通文本进框架走文本斜杠指令路由——所以插件**不声明 `capabilities.nativeCommands`**（QQ 无结构化调用事件，声明反而与 `commands.text:false` 冲突）。配置门控 `channels.qqbot.commands.native`（默认 true）；每进程每账号只同步一次（防 `resumed` 重连重复触发，失败释放 guard 待重连重试）；失败只记日志绝不阻断启动。
- **入站事件守卫** (`src/middleware/inbound-guard.ts`, 挂载于 messageFilter 之后、policyInjector 之前): 拦截三类「非真实用户输入」的平台推送（2026-09-07 事故：AI 的后台 poll 任务被空内容推送反复 steer 打断，AI 回"没新消息…继续 poll"——AI 把这些事件误读成"QQ 系统回执 hook"）。(1) **出站回声**：SDK message-filter 注释明示 QQ 会把 bot 自身出站消息回投为入站事件（群聊按 `author.bot` 识别，c2c 无该标记）——`skipSelfEcho` 必须保持 `true`，c2c 回声由 `outbound-echo-store`（近期出站 `msg.id`，30min TTL，`wrapBotSendForRefIndex` 登记）比对兜底；若平台回声携带新 id 而非原 id，比对会 miss，由(2)(3)兜底。(2) **重复推送**：平台事件文档要求按 msg_seq/`message_scene.ext` 的 `msg_idx` 去重（"为确保消息可达，相同 msg_id 可能重复推送"，重连/重启后常见），SDK 内置窗口仅 5s，守卫补 30min 长窗口（键 `accountId:kind:msgId:msgIdx`，内存 Map，跨重启不保留）。(3) **空内容事件**：content 空白且无 attachments 且无 msg_elements 的推送直接丢弃；**带 msg_elements 的 103 引用/转发消息是真实用户操作，必须放行**（quoteRef 渲染引用块）。每次拦截打 INFO 日志（`[guard] dropped ...` 含 msgType/scene/payload 摘要）——这是入站事件唯一的非 DEBUG 级痕迹，事后取证靠它。网关另注册了 `bot.on('rawEvent')`（INFO 记录一切未被 SDK 映射的平台推送：入群申请、好友变动、reaction、media_upload_finish、未来新增类型）——此前这些被静默丢弃，是诊断盲区。排查入站问题记住：除 `[guard]`/`[rawEvent]` 外，所有能识别入站事件的日志都是 DEBUG 级（SDK `Dispatch event: t=... payload=...`）。
- **互动事件扩展类型路由（2026-10-10，PR #39）**: 官方 2026-07 把 `INTERACTION_CREATE` 扩容为统一「互动事件」（type 11–20），`handleInteraction`（`src/gateway/event-handlers.ts`）按**外层 type** 路由：仅 11（消息按钮）/12（快捷菜单）走按钮回调链（ack + question/approval）；13（消息反馈）、14/15/16（QQ 官方智能体平台事件，自建 bot 正常收不到）、未来未知类型仅 INFO 留痕；18/19/20（用户/群主动推送授权）留痕 + 记入 `src/features/push-authorization-store.ts`（内存、peer 维度=group_openid/user_openid、账号隔离）。**勿把 ack 加回去**：官方文档明确仅 11/12 需要 `PUT /interactions/{id}` 回应，其余类型回应无意义（type=14 误 ack code=0 会触发「会话已清空」小灰条）。**配置面板事件（data.type=2001/2002）按 data.type 匹配而非外层 type**，且必须在类型路由分支**之前**检查——顺序回归有测试锁定（tests/interaction-extended-types.test.ts）。授权事件 payload **不携带授权结果（开/关）**（`AuthorizeData` 只有 opt_scene/scope），store 只做「最近一次授权操作」观测；乱序防护按事件自身 timestamp（`lastEventAt` 排序基准，缺时间戳的事件应用字段但**不清空基准**）；`/bot-group-info` 展示群维度事实，c2c 维度仅日志排障。观测日志中标识符统一截断前 8 字符（`shortId`，`/bot-logs` 可导出日志给 c2c 用户且默认授权开放，不落完整他人 openid）——既有 `[guard]`/`[rawEvent]`/`[approval]` 等日志的同类暴露是待决的独立整改项。
- **ask_user buttons**: single-question prompts render one inline keyboard (`qqbot:q:` button_data) resolved via `questionGatewayRuntime.resolveOption`. Multi-question prompts (2-3 questions) arrive **text-only** (the framework's v1 contract: no structured options in `channelData.askUser`); the plugin parses the prompt text (`parseMultiQuestionPrompt`), sends one card per question (`qqbot:qm:<recordId>:<qIdx>:<oIdx>`), and buffers taps in an in-memory store. When all questions are answered the plugin sends a **confirm card**: an instruction button (`action.type=2`, `enter: true`) whose data is the full keyed answer text (`"1: 3\n2: 1"`), which the QQ client emits as a **real user message** — the framework's native keyed-text claim then resolves the pending ask_user. A second `enter: false` button pre-fills the input for manual editing. **Never** submit multi-question answers programmatically: official openclaw has no multi-question submit API for channels (maintaining a fork costs more than it buys), and synthesizing an inbound user message fails because the framework steers it into the ask_user-suspended run without claiming the question (2026-08-24 incident). Inbound text is **never intercepted** for multi-question answering — real messages must reach the framework untouched. Parse failures (secret/malformed) fall back to plain text. Display: button labels are truncated (`buildButtonLabel`, ~12 CJK chars) with full options in the card body; rows auto-split when labels are wide. `isOther` questions (detected via the "Other: reply..." line) get a `✍️ 其他` **instruction button** (`action.type=2`, pre-fills `"N: "` in the client input box) so free-text answers are one tap + typing away.
- **Secret input flow** (`qqbot_secret_input` tool, c2c only): AI calls the tool with an env var `name` → plugin sends a card (with a `取消` instruction button) and registers a one-shot pending (`src/features/secret-input-store.ts`, TTL 10min, keyed `accountId:c2c:<openid>`) → the user's next c2c text message is **intercepted** by the `secretCapture` middleware (`src/middleware/secret-capture.ts`, mounted after slashCommand、before c2cTypingIndicator — 旧邻接的 groupMessageCoalescer 已随内建 coalescer 删除) and executed via `openclaw secrets store set` (`src/features/secret-store-cli.ts`) — the message never reaches the framework (the secret must never enter the AI transcript). Kind is **always `env`** (agent-readable environment value, written via `--value`): openclaw 2026.9+ splits the store into agent-readable env vs protected write-only secrets, and a chat-card value is both already exposed in QQ history and needed readable by the AI afterwards — storing it as `secret` made it unusable (2026-08-30 user feedback). The executor's secret/stdin branch is retained as generic capability with no current callers. The plugin composes the command (spawn + args array, `shell` never used); the AI only supplies the name (validated `^[A-Z][A-Z0-9_]{0,127}$`). Cancel keywords (`取消`/`cancel`/`#cancel`/`/cancel`) abort; empty messages keep waiting. **Red line**: the capture middleware yields (passes through) whenever a multi-question ask_user is pending for the same conversation — ask_user answer messages must never be swallowed. After a successful write the plugin best-effort runs `openclaw secrets reload`. Known accepted trade-offs: (1) openclaw's plugin install scanner logs a *critical* `dangerous-exec` warning for the `node:child_process` spawn — local installs are NOT blocked (hard blocks are dependency-name denylist only); (2) the spawned CLI must be the **same openclaw install as the running gateway** — `resolveOpenClawCli()` resolves from `process.argv[1]`'s package root first, then `require.resolve('openclaw')`, then PATH. Never let it fall back to the repo's pinned dev copy when the gateway is the global install: state-DB schema is owned by the gateway's version and an older CLI refuses the write (2026-08-30 incident: dev copy 2026.8.1-beta.3/schema 9 refused the global 2026.9.1/schema 12 DB, exit 1); (3) secrets inevitably remain in the user's QQ chat history — the card copy warns about this.

## Skills (under `/skills/`)

- `qqbot-channel` — Guild/Channel API operations (notes/posts/schedules). Trigger: 用户提到「频道」「子频道」等.

These are loaded by the host AI; they guide behavior, not build steps.

## Verification

本地门禁只做秒级检查（2026-09-10 约定：全量测试太慢，一律交给 CI）：

```bash
npm run typecheck                   # tsc --noEmit
npm run build                       # ensure tsup post-build succeeds
```

**测试由 CI 执行**：push 分支 / 开 PR 后，以 ci.yml 的全量测试结果为准。行为改动（尤其 `src/gateway/`、`src/dispatch/`、`src/outbound/`）在 PR 描述里注明重点看哪些测试文件（如 `session-key.test.ts`、`body-assembler.test.ts`、`middleware-chain.test.ts`、`room-event.test.ts`、`dispatch-lifecycle.test.ts`），CI 全量都会跑到。

## Misc

- Plugin IDs: `openclaw-qqbot` (plugin), `qqbot` (channel). Don't confuse them.
- Slash commands live in `src/commands/` — each is a separate file, registered via `buildCommandList()` in `src/commands/index.ts`.
- Default text chunk limit: 5000 chars (`TEXT_CHUNK_LIMIT` in `src/constants.ts`).
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
- 见 `src/features/msgid-cache.ts`:C2C `msg_id` 缓存 60 分钟、群 5 分钟——与 quota-manager 共用 `PLATFORM_PASSIVE_WINDOW`（平台被动回复窗口），条目时间戳为平台事件时间。

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
  - URL 路由:私聊 targetId 是字符串,不是数字 — `parseTarget` (`src/outbound/target.ts`) 接受 `qqbot:c2c:<openid>` 格式。

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

- 源码中大量出现 `// 对齐 telegram` 注释(`src/dispatch/dispatch.ts` 多处、`src/gateway/middleware-setup.ts`、`src/outbound/streaming-controller.ts`、`src/types.ts` 等)— 指的是**用户体验层面**:typing、失败兜底、debounce、abort、per-user session 等行为,不是 API 调用一一对应。行号易漂移,以全仓 grep `对齐 telegram` 为准。
- **不要试图把 QQ 的 `sendText`/`openStream`/msg_id 机制强行映射到 Telegram 的 `sendMessage`/`editMessageText`/`reply_to_message_id`** — 形态不同,语义相通。

### 文档 / 进一步阅读

- QQ Bot 官方: `https://bot.q.qq.com/wiki/develop/api-v2/`
- API 更新日志: `https://bot.q.qq.com/wiki/develop/api-v2/changelog.html`（注意：`/wiki/changelog/` 根路径是 2022 年的旧页面，别用）
- SDK 源码: `node_modules/@tencent-connect/qqbot-nodejs/src/QQBot.ts`(所有 methods 都在这)
- SDK README: `node_modules/@tencent-connect/qqbot-nodejs/README.md`
- 平台差异分析历史:见 `docs/` 下相关笔记。
