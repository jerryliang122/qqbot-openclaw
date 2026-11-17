# AGENTS.md — openclaw-qqbot

OpenClaw 通道插件：把 QQ Bot 官方 API 接入 OpenClaw framework（独立维护的 fork，自 v1.0.0 起独立发版）。

> **本文是「索引 + 根级红线」层**：只保留动手前必须知道的事（能踩的坑、必须守的约束、去哪查细节）。模块级内容在对应源码目录的 `README.md`，跨模块概念的深度叙事在 `docs/agents/`——**改对应模块前先读那两处**，里面的「为什么」比本文的「是什么」更能防止你改出回归。
>
> 文档分两层：**主题层** = `docs/agents/`（跨模块概念的完整叙事，一概念一篇）；**模块层** = 各源码目录下的 `README.md`（就近速查：职责边界 / 关键文件 / 红线指针 / 本目录特有的坑）。模块层只做**指针**，不复制主题层正文——避免同一事实两处维护、迟早对不上。模块层索引见 [Project layout](#project-layout) § 模块文档层。

## 文档维护约定

- **改哪个模块，内容写进哪个目录**：模块级实现约束、关键文件、本目录特有的坑 → 写进 `src/<module>/README.md`。**不要写进根 AGENTS.md**——根文件只放根级红线与索引，否则同一事实两处维护、迟早对不上。
- **跨模块概念才写进 `docs/agents/`**：一概念一篇完整叙事（为什么 + 历史踩坑）。AGENTS.md 与模块 README 都只做**指针跳转**，不复制正文。
- **根级红线留在根 AGENTS.md**：判据是**约束是否横跨 ≥2 个模块**，或是否属于框架/平台契约（SDK 子路径、session key 文法、被动/主动模型、平台语义）。
- **同一事实只写一处**：其余位置一律 `→ 指向` 跳转（带小节名），不复制正文。
- **新增模块目录 = 新增 `README.md`**，并登记进 [§ 模块文档层](#模块文档层) 索引表。
- **改一条红线要同时看两处**：结论层（AGENTS.md 根级红线 或 对应模块 README）+ 叙事层（`docs/agents/` 对应篇）。只改其一是回归。

**深度文档索引**：
| 文件 | 覆盖范围 | 何时必读 |
|---|---|---|
| [docs/agents/sdk-compat.md](docs/agents/sdk-compat.md) | openclaw 版本盯版、plugin-sdk 子路径增删、ambient stub、守卫测试 | 动 `openclaw/plugin-sdk/*` 引用、升级钉版 |
| [docs/agents/session-and-dispatch.md](docs/agents/session-and-dispatch.md) | canonical session key 文法、route 文法、10.5 指令/投递语义 | 动 session key 构造、路由回退、指令处理 |
| [docs/agents/config-and-credentials.md](docs/agents/config-and-credentials.md) | 配置面、凭据读取、通道能力声明、manifest schema | 改 `src/types.ts` 配置类型、凭据路径、`capabilities` |
| [docs/agents/outbound-and-quota.md](docs/agents/outbound-and-quota.md) | 被动/主动配额、msg_id 锚点、媒体投递、progress card | 动发送路径、配额扣减、媒体策略 |
| [docs/agents/chunking.md](docs/agents/chunking.md) | 字形簇安全分块、结构上下文开销封顶 | 动 `src/outbound/chunker.ts` / `src/outbound/grapheme.ts` |
| [docs/agents/streaming.md](docs/agents/streaming.md) | 流式生命周期、段模型、final 承接判定、park 语义 | 动 `src/outbound/streaming-controller.ts` 或 dispatch 流式分支 |
| [docs/agents/group-and-room-event.md](docs/agents/group-and-room-event.md) | 群三模式、room_event、合批、群历史窗口 | 动群聊策略、合批、唤醒判定 |
| [docs/agents/durable-group-ingress.md](docs/agents/durable-group-ingress.md) | 群聊持久化入站：队列/租约、到达序排序、lane 串行、幂等、降级 | 动群聊入站缓冲、合批、排序、幂等 |
| [docs/agents/inbound.md](docs/agents/inbound.md) | 入站防抖、白名单回告、事件守卫、语音转录、限流 | 动中间件链、入站分类、附件处理 |
| [docs/agents/interaction.md](docs/agents/interaction.md) | ask_user 按钮卡片、Secret 输入、webhook detached 派发 | 动按钮卡片、凭据输入、webhook 传输 |
| [docs/agents/platform-capabilities.md](docs/agents/platform-capabilities.md) | QQ 平台语义：被动/主动/互动、流式通道、Markdown、OpenID、双传输、Telegram 对照 | 拿 Telegram 直觉套 QQ、设计平台交互时 |

**构建基线：openclaw `2026.10.5`**（peer 范围 `>=2026.10.5`，devDependency 精确钉版 `2026.10.5`）。所有与 openclaw / `openclaw/plugin-sdk` 的交互以 2026.10.5 为最低兼容版本 —— 不得使用仅存在于更新版本中的 API，除非带能力探测与回退。抬地板判据、历史盯版实测与子路径增删全量，见 [docs/agents/sdk-compat.md](docs/agents/sdk-compat.md)。

## Setup commands

- Install deps: `npm install --no-fund --no-audit`（**不要 `npm ci`**——fresh clone 一律 `npm install`）
- Start dev:    `npm run dev`（tsup --watch）
- Build:        `npm run build`（tsup → `dist/index.cjs` + `dist/index.d.cts`，CJS only，target node18）
- Typecheck:    `npm run typecheck`（tsc --noEmit）
- Lint:         `npm run lint:runtime`（扫 `adapter/` 之外的直接 runtime 访问，`src/adapter/lint.ts`）
- Test:         **无 `npm test` script**——测试是独立脚本，见 Testing instructions
- Node:         开发机期望 v24.x（CI 用 Node 24；tsup target node18 只是产物目标，不限开发机版本）

**隔离规则**：

- 依赖只装项目内 `node_modules/`，**禁止任何全局安装**（`npm i -g`、改全局 npm 配置）；构建/测试一律 `npm run <script>` 或 `npx`（自动走项目内 `node_modules/.bin`）。
- **npm 11 `allowScripts` 拦截是预期状态、保持不放行**：install 时 npm 会警告 5 个包的 install 脚本不在 `package.json` `allowScripts` 白名单（`openclaw` pre/postinstall、`koffi`、`tree-sitter-bash`、`protobufjs`、`@google/genai`）。刻意如此：openclaw 的 postinstall 会往用户目录写 bundled plugins（破坏环境隔离），且 CI 同样不执行这些脚本、测试照样全绿。白名单只保留 `esbuild`（tsup/tsx 的关键依赖，必须执行）——**不要 `npm install-scripts approve` 放行上述任何包**。
- **lockfile 零 diff 预期**：`package.json` 未改动时 fresh install 后 `git diff package-lock.json` 应为空（lockfile 与 npm 11 + 主流镜像同步，cn 区域常用腾讯镜像 `https://mirrors.tencent.com/npm/`）；出现意外 diff 说明 npm 版本或 registry 漂移，先排查再继续——确属依赖变更产生的 diff 才随 PR 提交（lockfile 虽在 `.gitignore` 但实际被 git 跟踪）。

## Project layout

```
index.ts                  # 入口：re-export qqbotPlugin（from src/channel.ts）
src/                      # 插件实现（channel.ts / config.ts / types.ts + 7 个框架侧 *-adapter.ts 在根）
  gateway/                # WebSocket/Webhook lifecycle, event handlers, middleware wiring
  dispatch/               # inbound → OpenClaw: body-assembler, ctx-builder, envelope
  outbound/               # send pipeline: text, media, TTS, streaming, cron, debounce
  middleware/             # access-control, attachment, secret-capture, typing, policy-injector
  commands/               # /bot-* slash commands（经 buildCommandList() 注册）
  features/               # pairing, approval, ref-index, history, question-*, group-*, secret-*
  adapter/                # contract probe, media, resolve, webhook, workspace
  setup/                  # QR login (start/wait), account-key, finalize, surface wizard
  tools/                  # platform.ts (qqbot_platform_api), remind.ts, secret-input.ts
  utils/                  # logger, mention, pkg-version, ssrf-guard, stt
openclaw.plugin.json      # 插件 manifest：配置 schema 的唯一来源
preload.cjs               # 同步建 node_modules/openclaw junction
tests/                    # 独立测试脚本（tests/*.test.ts，tsx 直跑）
docs/agents/              # 主题层：跨模块概念的完整叙事
skills/qqbot-channel      # 频道 API skill（宿主 AI 加载，导行为不是构建步骤）
scripts/                  # 仓库工具脚本（proactive-api-server / send-proactive / test-sendmedia / link-sdk-core）
.github/workflows/        # ci.yml（typecheck·lint·build·test）、release.yml（v* tag 发版）
```

Plugin exports include `qqbotPlugin`, `getBotForAccount`, `QQBotGateway`, `sendText`, `sendMedia`, `parseTarget`, `dispatchToOpenClaw`, `StreamingController`, `PersistedRefIndexStore`, quota management functions, and typing lifecycle functions.

### 模块文档层

每个源码目录一个 `README.md`，内容 = 职责边界 / 关键文件 / **本模块相关红线的指针**（指向 `docs/agents/` 的具体小节）/ 本目录特有的坑。**只做指针，不复制正文**。新增模块目录 = 新增 README + 登记进本表。

| 目录 | 模块速查 | 红线主要归属 |
|---|---|---|
| `src/`（根文件） | [README](src/README.md) | 配置类型与 manifest schema、`capabilities` 声明、凭据读取 |
| `src/adapter/` | [README](src/adapter/README.md) | SDK 依赖面、webhook detached 准入 |
| `src/commands/` | [README](src/commands/README.md) | 日志脱敏、群配置优先级链 |
| `src/dispatch/` | [README](src/dispatch/README.md) | session key 构造、群合并载体、room_event 入站分类 |
| `src/features/` | [README](src/features/README.md) | 出站锚点与配额实现、多题问答、Secret 输入、群聊策略 |
| `src/gateway/` | [README](src/gateway/README.md) | SDK 依赖面、入站事件守卫、互动事件 ack、限流装配 |
| `src/middleware/` | [README](src/middleware/README.md) | 白名单回告、事件守卫、room_event 门控、typing 停发 |
| `src/outbound/` | [README](src/outbound/README.md) | 分块、流式、锚点失效兜底、进度卡与问题卡 |
| `src/setup/` | [README](src/setup/README.md) | 凭据互斥、manifest schema |
| `src/tools/` | [README](src/tools/README.md) | 不绕过 SDK、Secret kind、主动预算 |
| `src/utils/` | [README](src/utils/README.md) | STT 走框架管线、SSRF 假防护、日志脱敏 |

## Code style

- TypeScript strict（`tsconfig.json`: `strict: true`），`module`/`moduleResolution`: `NodeNext`；源码是 ESM，但**发布产物是 CJS 单文件**（tsup `format: ['cjs']` + `outExtension` → `.cjs`，target node18）。
- **仓库没有 eslint / prettier 配置**——风格靠人工一致 + `npm run typecheck`。不要顺手引入 formatter 依赖。
- 日志：用 `createPluginLogger()`（`src/utils/plugin-logger.ts`）。**不要直接 `console.*`**，除非早期 `register()` 路径（runtime logger 尚未接好）。
- 文本分块上限：`TEXT_CHUNK_LIMIT`（`src/constants.ts`，默认 5000 字）。
- 斜杠命令：一命令一文件放在 `src/commands/`，经 `buildCommandList()`（`src/commands/index.ts`）注册。
- 插件 ID：plugin 是 `openclaw-qqbot`，channel 是 `qqbot`——别混。
- **tsup post-build 的 `sanitizeDist()` 是承重的**——把 `new Function` 改写成 `new _F`（protobufjs 模式触发安全扫描器），别剥。

## Testing instructions

- **没有 `npm test` script**。测试是独立脚本，`node:assert` + 手写 `test()` helper，tsx 直跑：`npx tsx tests/<name>.test.ts`（单文件调试用，**非门禁**）。
- **全量测试是 CI 的职责**：ci.yml 在每次 push / PR 跑全部 `tests/*.test.ts`（当前 64 个），本地不做全量跑（tsx 冷启动太慢）。
- **覆盖率同样只在 CI 统计**：Test 步骤经 `NODE_V8_COVERAGE` 收集 V8 profile，Coverage report 步骤用 `c8`（`--all --include 'src/**' --include 'index.ts'`）聚合，逐文件表格 + 总百分比写入 Actions run 的 Step Summary——本地不要跑覆盖率。
- **PR 前本地自检只做秒级项**：`npm run typecheck` + `npm run lint:runtime` + `npm run build`。**测试一律由 CI 执行**，PR 的 CI 全绿即测试通过。
- 行为改动（尤其 `src/gateway/`、`src/dispatch/`、`src/outbound/`）在 PR 描述里注明重点看哪些测试文件（如 `tests/session-key.test.ts`、`tests/body-assembler.test.ts`、`tests/middleware-chain.test.ts`、`tests/room-event.test.ts`、`tests/dispatch-lifecycle.test.ts`、`tests/streaming-parked-finalize.test.ts`），CI 全量都会跑到。

### 守卫测试（改动命中对应领域时，它们就是你的验收清单，不只是 CI 装饰）

| 测试文件 | 守的是什么 |
|---|---|
| `tests/sdk-surface.test.ts` | plugin-sdk 子路径存在且能 require、ambient stub 新鲜度、钉版一致性、`dist/index.cjs` 可加载 |
| `tests/manifest-config-schema.test.ts` | manifest schema ↔ TS 配置类型逐字一致（改配置类型必红） |
| `tests/fallback-route-key.test.ts` | 兜底 session key 过 canonical + route 两道文法 |
| `tests/chunker-grapheme.test.ts` / `tests/chunker-context-overhead.test.ts` | 字形簇切点、结构上下文开销封顶 |
| `tests/streaming-parked-finalize.test.ts` | 流式 park / 取消 / 补发 / 媒体完整性 |

## PR & commit conventions

- **禁止直接 push 到 `main`**（GitHub branch protection）。任何开发——功能、修复、文档——一律走 `分支 + PR`：
  1. 从最新 `main` 切分支，命名 `<type>/<短描述>`（如 `fix/room-event-echo`、`docs/agents-md`）
  2. 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `chore:` / `ci:` / `refactor:`，breaking change 加 `!`，如 `refactor!:`）——与仓库现有历史一致
  3. push 分支、开 PR；CI（ci.yml，push + pull_request 双触发）必须全绿（typecheck / lint:runtime / build / 全量测试）
  4. 合并后删除远端分支
- **PR 不自动合并（2026-09-10 约定）**：CI 全绿 ≠ 已授权合并——review 与合并由仓库主人决定。开完 PR、CI 全绿后即停，把 PR 链接交回并等待主人亲自合并或明确授权；打 `v*` tag 发版等下游动作同样必须等合并完成且主人确认后再执行。
- **发版不受分支保护影响**：tag 打在已合并进 main 的提交上（`git tag v1.0.0 && git push origin v1.0.0`，branch protection 不拦 tag push）→ release.yml 校验版本一致性 + 跑全量检查 + 构建产物 + 自动发布 npm + 建 GitHub Release。完整流程见 CHANGELOG.md「发版操作手册」。
- **gh CLI 注意**：本仓库 git remote 走代理（github.jerryliang.win），gh 无法从 remote 推断仓库，PR/issue 操作需显式 `--repo jerryliang122/qqbot-openclaw`。

## Security

- **仓库代码里不写任何密钥**：appid/secret 经 `openclaw channels add --token "appid:secret"` 或环境变量 `QQBOT_APPID` / `QQBOT_SECRET` 配置。Never hardcode or log credentials.
- **凭据文件只在账号启动时读一次**；`resolveQQBotAccount` 是热路径（每次出站发送都解析一次账号），全程不读盘——同步 `stat`/`readFileSync` 会阻塞事件循环。
- **内联密钥与凭据文件强制互斥**：两者同时存在时内联优先、文件静默忽略；写入必须清掉另一个，注销要清 `clientSecretFile`。
- **`config.inspectAccount` 是只读巡检面，不 materialize 凭据**——`openclaw status` / doctor 不该为「描述配置」触发 token 交换或扫码。`secretStatus` 三态：`available` / `configured_unavailable` / `missing`。
- **日志脱敏**：任何 INFO 以上日志不得落完整 openid / sessionKey（`/bot-logs` 会导出本地日志文件原样）——openid 一律走 `shortId()`，sessionKey 一律记 sha256 前 8 位摘要。
- **Secret input 的消息绝不进 AI transcript**（kind 恒为 `env`）；**红线**：多问题 ask_user 待答时 capture 中间件必须放行，否则用户的答案会被写进密钥库。
- 媒体 source 的 SSRF 防护目前是「假防护」（只按小写 `http://`/`https://` 字面量前缀判定，`HTTP://` / `http:/` / 前导空格三种拼写可绕过，平台侧 URL 解析器会归一化）。**当前决定暂不加固**（触发前提是 agent 输出被污染，那一步成立时 agent 已有更强能力）。**触发器**：① 插件侧出现「先下载再上传」媒体路径；② 媒体 source 可信度假设从「可信」改为「不可信」；③ 出现提示注入可触达外部内容的部署形态。届时改用 `new URL(source)` 按 `url.protocol` 判定，并让 `resolveMediaSource` 用同一份解析结果决定 `{url}/{localPath}/{fileData}`。

## Key gotchas（根级红线）

以下每条都是**红线**（改错了会出线上事故），且都**横跨 ≥2 个模块或属于框架/平台契约**——所以留在根文件。模块级红线在各源码目录的 `README.md`（索引见 [§ 模块文档层](#模块文档层)），跨模块叙事的「为什么」在 `docs/agents/`。

### SDK 依赖面（[详情](docs/agents/sdk-compat.md)）

- **SDK 子路径被删 = 插件整体加载失败，typecheck 不设防。** openclaw 删子路径时连 `.d.ts` 一起删，`dist/index.cjs` 加载期就抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`，功能全灭且本地完全无声。守卫在 `tests/sdk-surface.test.ts`——它**按引号字面量取子路径全集，不解析 import 语句形态**（动态 import / 字面量 require / re-export 都算），豁免必须显式登记 `EXEMPT_SUBPATHS`，别靠「扫不到」。运行时断言必须放**子进程**（tsx 会 patch `Module._resolveFilename`，进程内直接 require 会误报 ESM-only 依赖缺失）。`import { fn, type Opts }` 的 inline `type` 要逐项判 type，否则守卫误报「缺少运行时值」把人引向不存在的缺陷。
- **裸子路径 `openclaw/plugin-sdk`（无后缀）不在包 exports 里**——运行时 require 抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。本插件对它只有 `import type`，永远不要从裸路径做值导入。
- **ambient stub 会遮蔽包内真实类型，留着等于没验证。** `src/openclaw-plugin-sdk.d.ts` 当前只剩三段（裸入口 + `text-utility-runtime` + `text-grapheme`），升级钉版时先删掉包已提供类型的 stub 段再跑 typecheck。
- **`preload.cjs` 不能删改名**——它同步建 `node_modules/openclaw` junction，删了插件在框架里加载失败。
- **tsup post-build 的 `sanitizeDist()` 是承重的**（见 Code style），别剥。
- **钉版必须恒等于 peer 承诺的最低版本**——两者脱钩就测不出「误用旧版没有的 API」，虚假承诺只在用户运行时炸。
- **Runtime contract probe 的 `REQUIRED` 列表是空的**，全部能力按 `OPTIONAL` 处理，别指望它 fail-fast。→ 细节见 [`src/adapter/README.md`](src/adapter/README.md)

### 配置面与凭据（[详情](docs/agents/config-and-credentials.md)）

- **改配置类型必须同步 manifest schema，否则用户配置被直接拒收。** 唯一来源是 `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`（顶层 + `accounts.<id>` 两处逐字一致），框架走 `validatePluginSchemaValue`（`applyDefaults: true`，对 `additionalProperties:false` 和 `enum` 都做值校验）。typecheck 不设防——`tests/manifest-config-schema.test.ts` 是唯一防线，红了先补 manifest，不要绕过守卫。
- **凭据读写与巡检口径见 Security**（互斥、只读巡检、热路径不读盘）。
- **`capabilities.tts.voice` 必须声明**，否则 TTS 被当普通音频文件发。本插件走 SILK 语音气泡，声明 `{ synthesisTarget: "voice-note", transcodesAudio: true, captionedFinalText: false }`——`captionedFinalText: false` 是必需的（QQ 语音不带文字说明，声明 true 会让终稿正文永不到达）。**`capabilities.nativeCommands` 刻意不声明**（QQ 指令面板是引导型 UI，声明会与 `commands.text=false` 冲突）。
- **`messaging.inferTargetChatType` 必须实现**——否则宿主只能走通用路由搜索，Gateway 一直报 `waiting for route`。其余一律 `undefined`（不猜）。→ 细节见 [`src/README.md`](src/README.md)

### Session key 与投递（[详情](docs/agents/session-and-dispatch.md)）

- **canonical session key 文法是 10.x 硬门槛**：key 必须满足 `agent:<agentId>:<rest>` 且全小写折叠形，裸通道前缀 key 或含大写的 key **直接拒写**（抛 `SessionCanonicalKeyMigrationRequiredError`，该 session 一切读写瘫痪、dispatch 全部 outcome=error）。生产路径走 `adapters.resolveAgentRoute` 天然合规；**兜底路由**（routing API 探测失败的安全网）必须用 `buildFallbackRouteSessionKey`。
- **canonical 过了不等于框架能反解出投递目标**——框架反解用 `parseSessionDeliveryRoute`，文法是 `<channel>[:<accountId>]:<peerKind>:<peerId>`，peer 段之后所有冒号分段都会被并进 peerId。兜底优先用框架原语 `runtime.channel.routing.buildAgentSessionKey`。
- **群 key 不含 accountId**（框架自身就不按账号隔离群会话），插件兜底也不该塞。
- **所有 c2c 用户默认共享 `agent:main:main` 一个 session**——要多用户隔离得让用户配 `session.dmScope: "per-peer"`。
- **10.5 的 admission ticket 发生在 replyResolver 之前**——忙碌会话里非 abort 类指令要等活动 turn 结束才被解释，「群里任务跑着发指令没反应」是预期排队语义，不是丢消息。→ 实现见 [`src/dispatch/README.md`](src/dispatch/README.md)

### 出站锚点与配额（[详情](docs/agents/outbound-and-quota.md)）

- **出站锚点模型：显式锚点 or 主动（2026-11-03 移除池化选取）**——挂 msg_id 的被动消息在平台语义上是「对用户消息的回复」，锚点必须来自显式回复意图。网关 `resolveOutboundAnchor` 只透传显式 `opts.msgId`；**无显式锚点（message 工具不带 replyTo、remind/cron、框架直发）一律走主动发送**（烧每日预算）。**红线：禁止重新引入「从缓存挑 msg_id」的池化选取**——它会把回复引用挂到更早的错误消息上（历史演进 7a59a2c→bbed520→e3e2be7 为省预算引入，已按平台语义移除；代价：1000 条/天预算消耗、用户关「允许主动发送」时该类消息拒发）。
- **反应式配额（2026-11-03）：本地不按「次数」阻断被动发送**——探针实测平台**不执行**文档口径的 c2c 4 次/群 5 次 per msg_id 上限（同 msg_id 25 次全送达；typing 也不占额度）。本地只强制两个真实硬约束：TTL 窗口预检（c2c 60min/群 5min，40034005 确定性）与 msg_seq 单调发号（40054005）；count 仅观测（超文档上限打一次 INFO，**仅 logger 在场才置位**——否则标志会被无 logger 的消耗烧死；主出站路径须透传 logger）；**观测计数只升不降**——判死时不得回截 count（证据保全）。平台真拒绝时由网关死锚点兜底转主动。**禁止把 count 上限改回 preemptive 阻断**——那会逼正文白烧每日 1000 条主动预算、让进度卡被静默跳过。
- **锚点失效兜底**：被动发送被平台 **40034005**（过期）/ **40034128**（超限）确定性拒绝 → rollback + 驱逐 + 标记 dead → 同内容**转主动重发一次**。网络错（`httpStatus===0`，结果不明）**不重发**（有重复风险）。`passiveOnly` 发送（progress card）**不做主动重发**。
- **typing 永不占用主动额度（2026-11-03）**——typing（msg_type=6）不占被动回复额度，但**绝不降级为「不带 msg_id 的主动形态」**：锚点不可用（TTL 过期 / 死锚点 / 平台 40034005·40034128 拒收）⇒ **本轮停发**。主动额度留给正文与前置消息，typing 不参与竞争。
- **ask_user 问题卡必须挂本轮显式锚点（2026-11-05）**——问题卡（单题卡 / 多题卡 / 确认卡 / 状态回执）此前走 SDK 直发（请求体不带 `msg_id` ⇒ 平台按**主动消息**处理）：白烧每日 1000 条主动预算，且用户关「允许主动发送」时问题卡根本发不出去（模型空等 `ask_user` 超时）。现走 `outbound-service.sendText` + 本轮 inbound 的 `envelope.messageId` ⇒ 被动回复；锚点不可用时**降级主动一次**。**红线：禁止改回 SDK 直发**；**不得**让网关 `retryOnDeadAnchor` 兜底——那条主动重发路径不携带 keyboard（用户看到题干却无从作答），故降级必须由问题卡层自己做。→ 实现见 [`src/outbound/README.md`](src/outbound/README.md)

### 群聊与 room_event（[详情](docs/agents/group-and-room-event.md)）

- **群聊三模式由平台决定，插件不可控**（AT 纯模式 / AT+最近N / 全量），**插件无需也不应按模式分流**——三事件共用 intent、SDK 映射同形态、走同一条中间件链。
- **room_event 的三处裁决必须同源**——门控（`src/middleware/policy-injector.ts`）、入站分类（`src/dispatch/`）、历史缓冲跳过三处共用 `resolveGroupRoomEventPolicy` 的一份结论，**三处各算各的必然出事**（门控放行 + 分类成 user_request = 刷屏；门控拦掉 + 分类成 room_event = 永远收不到消息）。
- **群消息合并在插件侧做**——框架 collect 合批对「同群不同人」无效（分组键含 `senderId`，遇第一个不同 key 就 break）。**批次键按群不按人**。→ 实现见 [`src/features/README.md`](src/features/README.md)
- **群聊入站是持久化队列（2026-11-16）**——群消息**先落盘再派发**（SQLite 队列 + lane 串行 + 租约续期 + 失败重投 + 幂等守卫），对齐 openclaw 2026.11.4 的 Telegram L1–L5。**排序权威是本地到达时刻**（不是平台 timestamp——QQ timestamp 是客户端发送时间，群成员设备时钟不一致 ⇒ 按它排就是排错）；**忙闲判据是 durable lane claim**（不是 dispatch promise 生命周期——框架把 turn defer 时 promise 就 resolve，旧口径会提前归零导致合批散架）。**红线：不得改回按平台 timestamp 排序、不得把 busy 判据换回 promise 生命周期、不得让群路径出现「绕过队列直接 dispatch」的快路径**（空闲群单条消息也走队列）。**合批窗口时长来源 = 框架 `resolveInboundDebounceMs(cfg,'qqbot')`**（默认 0 ⇒ 零延迟；用户旋钮直接生效）——**不得改回插件内硬编码常量、不得新增群专属配置键**。**单条批次（`kept.length===1 && dropped===0`）必须走「不合并」特判**——否则正文多出 `[消息 1/1]` 分节头、webBody 的 from 变成群 openid（内存路径有同条件特判，durable 路径必须对齐）。**日志里的群标识一律走 `shortId()`**（唯一事实源 `src/utils/redaction.ts`）——core drain 的内部日志内嵌 lane key（含群 openid）⇒ 桥接处须脱敏。**C2C 私聊零改动、配置面零变更、`strategy:'framework'` 保持 legacy**。→ 叙事见 [`docs/agents/durable-group-ingress.md`](docs/agents/durable-group-ingress.md)

### 交互面（[详情](docs/agents/interaction.md)）

- **多问题 ask_user 的红线是「禁止代替用户作答」，不是「禁止程序化提交」**（2026-11-11 再界定，issue #99 / PR #100）——**答案值必须来自用户的真实输入**（按钮点选 / 手打文本），插件只负责**搬运与组合**；**禁止合成入站消息**（合成消息会被框架 steer 进 ask_user-suspended run，2026-08-24 事故）。提交通道 = 框架官方 `claimPendingAgentQuestionAnswer({ sessionKey, text })`（`openclaw/plugin-sdk/agent-harness-runtime`）——它与框架自己的入站认领走**同一套解析与校验**（`buildAgentHarnessUserInputAnswers` / `validateAnswers`）⇒ 插件组合的文本与用户手打的文本在框架侧等价。
- **多题问答进行中（c2c、多题 pending 武装期间）的入站文本一律本地暂存为当前题答案、不转发框架**——平台无法区分「用户手打的普通消息」与「指令按钮代发的回调内容」；中间态文本转发给框架只会撞上 `validateAnswers` 的 partial 拒收 + 重问循环（白烧一轮、两侧状态分裂），且靠中间态词汇猜意图必然失效。**边界**：仅多题 pending 武装期间 + 仅 c2c + 仅 `sequential` 形态；单题 pending / 无 pending 时文本照旧原样转发框架；斜杠命令（`/` 开头）照旧放行（逃生通道）。**分类只认形态**（整单 / 形态错误 / 本题答案），**不靠内容语义猜**。
- **Secret input 的消息绝不进 AI transcript**——kind 恒为 `env`；多问题 ask_user 待答时 capture 中间件必须放行。→ 实现见 [`src/features/README.md`](src/features/README.md) 与 [`src/middleware/README.md`](src/middleware/README.md)

### 其他根级事实

- **群消息优先级链**：`groups.{groupOpenid}.requireMention` → `groups.*.requireMention` → account 级 `defaultRequireMention` → `true`（默认）。其他群配置字段（`ignoreOtherMentions/toolPolicy/name/prompt/historyLimit/historyMode/unmentionedInbound/coalesce`）同一 ??-cascade。→ 细节见 [`src/README.md`](src/README.md)
- **10.5 会主动外发「💾 Learned:」通知**——非缺陷不修，规避用 `skills.workshop.autonomous.mode: "off"`。
- **openclaw 10.5 新增群话题（group thread）能力**——配置在**顶层 `cfg.broadcast["<channel>:<peerId>"]`**（不在 `channels.qqbot` 下），本插件尚未接入。

### 红线归位索引（模块级红线在哪）

| 主题 | 结论在 | 叙事在 |
|---|---|---|
| 分块（字形簇 / 上下文开销） | [`src/outbound/README.md`](src/outbound/README.md) | [docs/agents/chunking.md](docs/agents/chunking.md) |
| 流式（段模型 / final 三态 / park） | [`src/outbound/README.md`](src/outbound/README.md) | [docs/agents/streaming.md](docs/agents/streaming.md) |
| 进度卡 / 问题卡 / 媒体投递 | [`src/outbound/README.md`](src/outbound/README.md) | [docs/agents/outbound-and-quota.md](docs/agents/outbound-and-quota.md) |
| 入站（防抖 / 守卫 / 语音 / 回告 / 限流） | [`src/middleware/README.md`](src/middleware/README.md) [`src/features/README.md`](src/features/README.md) | [docs/agents/inbound.md](docs/agents/inbound.md) |
| 群聊（合并 / 可见回复 / 工具策略 / 历史模式） | [`src/features/README.md`](src/features/README.md) | [docs/agents/group-and-room-event.md](docs/agents/group-and-room-event.md) |
| 群聊持久化入站（到达序 / lane 串行 / 幂等 / 降级） | [`src/features/README.md`](src/features/README.md) | [docs/agents/durable-group-ingress.md](docs/agents/durable-group-ingress.md) |
| 问答（多题 / 拦截层 / 归属 / 提交失败） | [`src/features/README.md`](src/features/README.md) | [docs/agents/interaction.md](docs/agents/interaction.md) |
| 配置类型 / capabilities / 凭据 | [`src/README.md`](src/README.md) | [docs/agents/config-and-credentials.md](docs/agents/config-and-credentials.md) |
| webhook detached 准入 | [`src/adapter/README.md`](src/adapter/README.md) | [docs/agents/interaction.md](docs/agents/interaction.md) |
| SDK 依赖面 / contract probe | [`src/adapter/README.md`](src/adapter/README.md) | [docs/agents/sdk-compat.md](docs/agents/sdk-compat.md) |

## QQ Bot 平台能力 vs 其他 OpenClaw 通道

QQ Bot 跟 Telegram / Discord / Slack 等其他通道在平台 API 形态上差异较大，这些差异是不可消解的，设计时必须以此为前提。**别拿 Telegram 的 thread_id / topic / supergroup 之类概念来对齐 QQBot**——写代码前先确认这个能力在 QQ 上压根不存在。（注释里说的「对齐 telegram」指的是**用户体验层面**：typing、失败兜底、debounce、abort、per-user session，不是 API 调用一一对应。）

完整语义、被动/主动/互动配额表、Telegram 能力对照表见 [docs/agents/platform-capabilities.md](docs/agents/platform-capabilities.md)：

- **没有话题 / 频道 / Forum**——会话只有 `c2c` 与 `group` 两种 scope；频道是独立产品（有自己 OpenID 域，不共享 session / dispatch / streaming 路径），要做得单独开 skill / 模块。
- **同一个 API 靠带不带 `msg_id` / `event_id` 区分三种互斥的发送形态**（被动回复 / 主动推送 / 互动召回）；错误码 `40034128` = 被动超限、`40034100` = 主动超限、`40034122` = 互动召回达上限。**流式是第四种「通道」不是回复模式**——`openStream` / `session.update` / `session.complete`（仅 c2c），流式没有独立配额但其推送消息仍占 C2C 被动配额，已下发 prefix 不可修改（改了 40007）。
- **Markdown 由客户端原生渲染**（`msg_type: markdown`）——没有 Telegram 那种服务端 parse_mode 转换，也没有 HTML parse 失败回退；写得越界的 Markdown 会渲染异常，代码层无兜底。
- **OpenID 跨账号不通用**——bot A 的 user openid 在 bot B 上完全无意义，影响 allowFrom / pairing store / URL 路由。
- **底层依赖官方 SDK，不要绕过**——`@tencent-connect/qqbot-nodejs`（v1.0.4）+ `@tencent-connect/qqbot-connector`（1.2.0 精确钉版，仅扫码登录 setup）。**SDK 版本滞后于平台文档**——REST 新接口今天就可经 `qqbot_platform_api` 工具调用（SDK `bot.api` 是任意 path 的通用网关），但入群申请**事件**与 `force_verify_image_resource` 参数依赖 SDK 更新。**不要在本仓库中绕过 SDK 直接 fetch QQ API**。
- **WebSocket（默认）/ Webhook 双传输**——插件层消息处理行为无差异；唯一例外是 webhook 模式专属的**准入跟踪**（见 Key gotchas 的 webhook 条目）。

## Skills

- `skills/qqbot-channel`（目录 `/skills/`）— Guild/Channel API operations（notes / posts / schedules）。触发词：用户提到「频道」「子频道」等。由宿主 AI 加载，导行为而不是构建步骤。
