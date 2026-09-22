# 更新日志 (Changelog)

本项目（GitHub 仓库 `jerryliang122/qqbot-openclaw`，npm 包 `@jerryliang122/openclaw-qqbot`）自 **v1.0.0** 起按自己的发版机制独立发版，版本号与上游旧版本（`tencent-connect/openclaw-qqbot` 2.x）**完全脱钩**：1.0.0 是本仓库独立维护后的第一个正式版本，其内容 = 上游 2.1.0 基础上的大量功能重构 + v1.0.0 的全面兼容性清理。

- 发版流程：推送 `v*` tag → GitHub Actions 自动校验版本一致性、跑全量检查、构建产物 → **自动发布 npm**（`@jerryliang122/openclaw-qqbot`，OIDC Trusted Publishing 免 token）→ 创建 GitHub Release 并附 `npm pack` 产物
- 版本规则：语义化版本（SemVer）。Major 位变更意味着存在 Breaking Change（配置格式 / 运行要求 / 公开 API）
- 运行要求：**OpenClaw >= 2026.9.2**（peer 依赖硬性要求，见 package.json）

---

## [1.0.7] - 2026-09-22

### 修复

- **入站消息不再携带自引用 `reply_to_id` 假签名**（PR #20）：`ctx-builder` 此前把 `reply.replyToId` 与 `supplemental.quote.id` 填成**当前消息自身 ID**（`envelope.messageId`），openclaw 框架把 `ctx.ReplyToId` 渲染为模型可见 Conversation info 的 `reply_to_id` 字段——于是每条消息都呈现 `message_id == reply_to_id`，被上层 agent 的 AGENTS 规则判为「内部回灌、非新指令」而拒绝响应。已观测症状：模型反复回复「这是 OpenClaw 内部上下文块——message_id == reply_to_id，是回灌，不重复响应」「这条 envelope 是 08:25:51 消息的第四次回灌」「这条 envelope 是我自己刚发的回复的回灌」「OpenClaw 系统级反射，疑似之前我的 reply 没被 ACK」等（「第 N 次回灌」为模型对会话记忆回放的计数误判，非真实重复投喂——插件 inbound-guard 30min 去重 / runId 幂等 / collect 队列一次性 drain 均核实无重复路径）。现对齐 telegram 原生通道契约语义：ReplyToId = 当前消息**回复(引用)的那条消息**的真实 ID（ref-index 命中时来自 `quote.entry.messageId`），无引用 / msg_elements 兜底解析拿不到 ID 时为 undefined，并加防御守卫——任何路径（含上游异常输入）不允许再现自引用值。QQ 被动回复锚点不受影响：`deliverCtx.replyToId`、msgid-cache 兜底（`resolvePassiveFirstReplyToId`）、`attachMsgIdWithQuota`、typing 均独立取值，threading `resolveReplyToMode: 'off'` 阻断框架隐式回复线程。新增 `tests/inbound-replyto-id.test.ts`（8 用例，含 Sourcery 复审补齐的 `supplemental.quote.id` 红线断言）。
  - **升级后配套（重要）**：删除 agent 层 AGENTS.md 中「message_id == reply_to_id 即回灌」类规则——它是被此假签名逼出的 workaround，修复后 `reply_to_id` 只在真正引用消息时出现（且指向被引用消息），该规则永久失配。

---

## [1.0.6] - 2026-09-21

### 修复

- **`message` 工具主动发送不再报 `Bot "default" not running`**（issue #15，PR #17）：openclaw 框架的 `message` 工具在后台任务 / bootstrap 兜底注册表上下文会经 jiti 二次加载产生插件的**另一个模块实例**，旧实现的 gateway 注册表是模块级 `Map`——第二实例的注册表为空，`getGateway("default")` 恒 miss，所有框架侧主动发送（媒体尤甚）失败；而会话回复走同实例直连不受影响，表现为「文本正常流出、kind=image 从未出现、`[tx]` 网关日志零条目」。三层修复：
  - **gateway 注册表桥接 `globalThis`**（`Symbol.for`，主修复）——所有模块实例共享同一份注册表，双实例场景下按 accountId 精确路由到真正运行的网关；
  - **发送路径单账号回退**——gateway 查找 miss 且注册表恰有一个运行中账号时回退发送（打一次 INFO 便于取证）；0 个或多个运行中账号时不盲路由（OpenID 跨账号不通用），错误信息附运行中账号列表，多账号排障不再盲猜；
  - **`resolveDefaultQQBotAccountId` 可运行性感知**——只在 default 账号「可运行」（配置内 appId + 任一凭证来源 + enabled）时返回 `default`，否则回落到第一个可运行的命名账号；凭证备份只补 secret 不补存在性（appId 必须在配置内，保证「被选中 ⇒ 可被枚举启动」的一致性）。完整顶层配置（常规单账号形态）行为不变。
- **回退发送的被动配额按实际发送账号记账**（Sourcery 复审）：平台配额按「真实发送账号 × msg_id」计，回退场景此前记在请求键下会绕过或误伤限额；`resolveGatewayForSend` 现返回 `{gw, accountId, fallbackFrom}`，配额预留/回滚统一用实际发送账号。
- **`unregisterGateway` 所有权守卫**（Sourcery 复审）：共享注册表后，旧模块实例延迟执行的 stop 不再可能删掉新实例已注册的替代网关（带 gateway 引用做身份比对；登出路径保持无条件删除）。

### 加固

- `outbound-service` 模块级 logger 改惰性创建——该模块处于 `bot-instance → outbound-service → plugin-logger → runtime → bot-instance` 循环依赖环上，顶层求值会在环半初始化状态下崩溃。
- 新增 `tests/proactive-account-fallback.test.ts`（18 用例）：globalThis 桥存在性与 dist 产物读写契约（子进程验证）、单账号回退（文本+媒体）、多账号不盲路由、回退配额记账键（同 msg_id 第 5 次降级主动）、默认账号解析全形态、注销所有权守卫。

---

## [1.0.5] - 2026-09-14

### 修复

- **ask_user 卡片投递后不再误报 "Agent run failed"**（issue #11，PR #12）：模型未流式输出文本直接调用 `ask_user` 工具时，卡片通过 `bot.sendTextWithKeyboard()` 成功投递给用户，但 `StreamingController` 的 `sentChunkCount` 仍为 0，turn 结束时 `finalize()` 走 `finalize:fallback` 路径，框架 `replyResolver` 将其解读为投递失败，Web UI 误显 "Agent run failed"。新增 `markDeliveredExternally()` 方法，插件在 ask_user 卡片发送成功后调用，`handleFinalize` 检测到外部投递后走 `finalize`（成功）而非 `finalize:fallback`（失败）。

---

## [1.0.4] - 2026-09-14

### 修复

- **流式会话中 agent run 失败不再静默**（issue #8，PR #9）：c2c 流式已启动且首分片已送达后模型失败（如空闲超时），框架经 deliver 回调投递的 `isError` 失败通知 payload 此前被 deliverHandler 的流式去重早退吞掉——「final 已由流式发过」的假设对失败文案不成立（它从未进入流式通道），用户只见首分片后静默，WebUI ⚠️ 是唯一失败信号；插件自身的 `FAILURE_FALLBACK` 兜底也不触发（dispatch 正常 resolve + 已有可见回复）。现 `payload.isError === true`（框架 `markAgentRunFailureReplyPayload` 必置）绕过去重早退、落到默认路径静态发出（stream 模式先收尾打字机流再发）；非 error payload 的去重行为不变。`mode:'partial'+sendMode:'static'`（生产形态）、`partial/stream`、`mode:'off'` 三种配置全覆盖，回归测试 `tests/dispatch-error-notify.test.ts`（5 用例）钉住。

---

## [1.0.3] - 2026-09-11

### 移除的功能

- **移除 `qqbot-remind` skill**（PR #7）：删除 `skills/qqbot-remind/` 目录（SKILL.md 引导文档存在问题，不再随 npm 包分发），`openclaw.plugin.json` 的 `skills` 清单同步移除注册。**`qqbot_remind` 工具本身保留**（`src/tools/remind.ts` 与 `contracts.tools` 注册不变），宿主 AI 仍可经工具描述直接发现与调用，仅少了引导文档；`qqbot-channel` skill 不受影响。已安装用户升级后该 skill 自动消失，无需任何配置迁移。

---

## [1.0.2] - 2026-09-10

### 可观测性补全（日志全链路覆盖，PR #5）

纯日志与防御性 catch，**无任何业务逻辑 / 中间件链 / 发送行为变化**。修复日志覆盖审计发现的系统性盲区——INFO 级别下插件工作状态全程可见：

#### 出站链路

- **出站成功统一 `[tx] sent` INFO**：在 `wrapBotSendForRefIndex` 包装层打点（kind/scope/target/msgId/passive/contentLen）——gateway 五个 send 方法与中间件 `bot.sendText` 直调的单一卡点，此前成功发送插件层零日志、只能靠 SDK 状态行倒推。
- **框架契约出站路径接入 logger**（`[outbound]`）：框架直发 / `message` 工具 / cron announce 路径的配额降级 INFO 与回滚 DEBUG 此前因不传 log 是死代码；媒体消息配额降级补 INFO（此前完全无日志）。
- `qqbot_secret_input` 工具：卡片发送失败 ERROR、pending 登记成功 INFO。

#### 命令与交互审计

- **`/bot-*` 命令执行审计**：全部 11 个内置命令每次调用打 `[cmd]` INFO（命令/执行者/scope/raw 截断 80 字符），越权尝试打 WARN——含 `/bot-clear-storage`（删存储）、`/bot-approve`（安全相关）；配置 persist 失败 WARN。
- **审批交互留痕**：授权通过的按钮点击 `[approval] tap` INFO、resolve 成功 `[approval] resolved` INFO（此前仅越权 WARN / 失败 ERROR，合法成功的审批不留痕）；审批卡投递成功/失败日志。
- 单问题 ask_user resolve 结果 DEBUG→INFO（与多问题流程对齐）；四处交互初始 ack 失败静默 catch 补 DEBUG。

#### 静默吞错与裸 promise 加固

- 配对审批 CLI（`approveViaCli`）：收集 stderr 尾部（≤500 字符），spawn 失败与非零退出打 WARN——区分「CLI 坏了」与「配对码无效」。
- webhook ingress 管线动态 import 失败打 WARN（此前整条请求路径静默降级 handleSimple 无痕迹）。
- access-control 配对挑战回复 / secret-capture 被动+主动回复失败由 `.catch(()=>{})` 改为 WARN。
- **消除 unhandledRejection 风险**：debounce 定时器 flush、typing 续期定时器经 `.catch` 封口；`notifyOutboundMessageSent` 监听器逐个隔离（单个坏订阅方不再能炸掉发送成功路径）；history-store 异步 append 兜底。

#### 低优先补全

- 账号启动 INFO（accountId/appId/enabled/secretSource/transport——secret 只打来源不打值）。
- webhook 每请求 DEBUG 访问日志；签名全不匹配 401 升 WARN（与管线路径对齐）。
- `qqbot_platform_api` 工具每调用 INFO（method/path/耗时），失败 WARN（status/bizCode）。
- quota-manager 拒绝路径（无 msgId/过期/耗尽）DEBUG 留痕；setup 手动绑定路径补 `rt.log`。

#### 测试与不变项

- 新增 `tests/command-audit.test.ts`（7 用例：注册完整 / 返回值透传 / INFO 字段 / raw 截断 / authorized 通过与拒绝 / SDK 可选方法形态 / 数组别名）。
- **入站消息追踪维持 DEBUG 级**（设计决策不变）：INFO 级别下正常流量保持安静，只看异常与拦截（`[guard]`/`[rawEvent]`）。
- `setup/login.ts` 的 QR 终端输出保留（用户界面非日志）；`ssrf-guard` 的 console.warn 保留（纯 util，caller 已有日志）。

---

## [1.0.1] - 2026-09-10

### 移除的功能

- **移除「命令自动更新插件」功能**：删除 `/bot-upgrade` 指令、npm 版本检查器（`src/features/update-checker.ts`）与 `qqbot-upgrade` 技能（原宿主 AI 自动执行 `openclaw plugins install` + `openclaw gateway restart`）。插件不再访问 npm registry，`/bot-version` 只显示当前已安装版本与框架版本。
  - 配置字段 `channels.qqbot.upgradeUrl` 一并移除；已配置该字段的用户无需操作，多余字段会被忽略（schema `additionalProperties: true`，不会报错）。
  - 今后的升级方式：在宿主机手动执行 `openclaw plugins install @jerryliang122/openclaw-qqbot`，然后 `openclaw gateway restart`（见 README「快速开始」）。

---

## [1.0.0] - 2026-09-09

### 1. 与上游旧版本（2.x）的差异总览

以下能力为本仓库在长期使用中重构/新增，上游版本（含 2.1.0）不具备或行为不同：

#### 群聊架构

- **群聊三模式矩阵**：同时支持群主可选的三种推送模式——AT 纯模式（仅被 @ 收到事件）、AT+最近 N 条（`msg_elements` 携带上下文，≤10 条，含 per-element 作者与 message_type=102 聊天记录识别）、全量模式（每条消息推送 `GROUP_MESSAGE_CREATE`）。两事件共用同一 intent 与中间件链，插件按 per-group 推断实际模式（`src/features/group-mode-store.ts`），模式变化打 INFO 日志。
- **群消息排队完全交给框架**：消息逐条立即 dispatch，排队/合并由 OpenClaw followup 队列承担（`coalesce.enabled=true` → `collect` 合并批处理；`false` → `followup` 排队不合并）。群 turn 使用 `exclusive` admission 且不传 abortSignal——进行中的 turn 结构性不可被打断。
- **room_event 房间事件**（`unmentionedInbound: 'room_event'`，默认关）：全量模式群里未被唤醒的消息作为被动房间事件进框架——AI 只读上下文、最终文本不投递（结构性沉默）、只能通过主动 `message` 工具发言；被 @/称呼/引用时恢复正常回复。
- **三种唤醒方式**：@提及（事件/mentions.is_you/内容标记）、称呼唤醒（`agents.list.<id>.groupChat.mentionPatterns`，如 `["沈处"]`）、引用 bot 出站消息（ref-index 隐式提及）。
- **群历史模式 historyMode**：`clear`（回复后整清）与 `rolling`（bot 出站计入历史，裁剪到最后一条 bot 发言之后，对齐 telegram selectAfterLastSelf）。
- **群级配置 ??-级联**：`groups.{gid}` > `groups."*"` > 账号级默认 > 内置默认，覆盖 requireMention / ignoreOtherMentions / toolPolicy / name / prompt / historyLimit / historyMode / unmentionedInbound / coalesce。

#### 出站与配额

- **被动优先出站**：全链路 msg_id 优先，保护主动消息每日 1000 条预算。挂载 msg_id 前经 quota-manager **原子预检+扣减**（群 5 次/msg_id/5min，c2c 4 次/60min），配额耗尽自动降级主动发送，API 失败自动 rollback——彻底消除平台 40034128 硬失败无兜底的问题。
- **主动预算计量**（`src/features/proactive-budget.ts`）：按账号按天计数、跨天重置、80% 告警，`/bot-group-info` 可查。
- **msgid-cache**：c2c 30min / 群 5min（与平台被动窗口对齐），静群（窗口内无消息）只能主动发送——平台约束。
- **typing 配额感知**：typing 通知与回复共享被动配额，耗尽自动降级主动；20s QPS 约束自动钳制；出站消息后 5s 自动续期。

#### 可靠性与观测

- **入站事件守卫**（inbound-guard）：拦截出站回声（群按 author.bot、c2c 按 outbound-echo-store 比对）、重复推送（msg_seq/msg_idx 30min 长窗口去重）、空内容事件；带 msg_elements 的引用/转发消息放行。每次拦截打 INFO `[guard]` 日志。
- **rawEvent 观测**：未被 SDK 映射的平台推送（入群申请、好友变动、reaction、media_upload_finish、未来新增类型）统一 INFO 记录，消除静默丢弃盲区。
- **三层限流默认开启**：sender 20/min、group 60/min、global 300/min 滑动窗口，`channels.qqbot.rateLimit` 可覆盖或关闭；room_event 群强烈建议保持开启。
- **member_role 提取**：admin/owner 从 raw.author 提取进 `sender.roles`，供框架权限分级。
- **凭证备份**（credential-backup）：gateway 启动后写凭证快照，热更新被打断时自动恢复。

#### 平台能力

- **指令面板自动同步**：gateway ready 后把 openclaw essential 原生指令注册到 QQ Bot 指令面板（`/v2/panels`，经 SDK 通用网关），c2c/group 各一个面板，remark 打标幂等，用户手建面板绝不触碰；`channels.qqbot.commands.native` 门控（默认 true）。
- **ask_user 交互**：单问题 → inline 按钮键盘（`questionGatewayRuntime.resolveOption` 认领）；多问题（2-3 题）→ 每题一张带按钮的卡片 + 答案缓冲 + 指令按钮确认卡（客户端以真实用户消息发出，走框架原生 keyed 文本认领）；isOther 题有「✍️ 其他」预填按钮。**绝不程序化提交多问题答案**、**绝不拦截真实入站消息**。
- **密钥输入**（`qqbot_secret_input` 工具，c2c）：AI 发卡片 → 用户下一条消息被中间件拦截 → `openclaw secrets store set`（恒为 `env` kind，AI 可读）→ 消息绝不进入 AI 转录。多问题 ask_user 挂起时红线放行。
- **`qqbot_platform_api` 工具**：任意 path 的平台 REST 调用（自动鉴权/重试），覆盖 SDK 未封装的新接口（群禁言、入群审批、自定义菜单等）。
- **`qqbot_remind` 工具**：cron 主动消息提醒。
- **域名切换能力**：默认仍走旧域名 `api.sgroup.qq.com`，`QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` 环境变量随时切换 `api.bot.qq.com`，无需等 SDK 发版。
- **SSRF 防护**：插件自身媒体/图片 fetch 经白名单与私网拦截（media-runtime 不可用时不再降级裸 fetch）。

#### 工程与构建

- 构建基线钉版 openclaw `2026.9.2`（devDependency 精确钉版，typecheck 对最老支持面验证）；peer `>=2026.9.2`。
- tsup CJS 产物 + `new Function` 别名改写（规避安全扫描误报）；`preload.cjs` 同步保证 plugin-sdk 可解析。
- 全部测试统一 `node:assert` + `tsx` 直跑风格，无外部测试框架依赖。
- `npm run lint:runtime`：扫描 adapter/ 之外的直接 runtime 访问。

### 2. v1.0.0 移除的兼容性功能（Breaking Changes）

与上游断开后，**所有针对旧环境的兼容层一次性清除**。从上游 2.x（或本仓库更早状态）升级到 1.0.0 前请核对：

#### 运行时兼容（openclaw < 2026.9.2 的探测/回退）

- 删除 `channel.turn.run`、`reply.finalizeInboundContext`、`reply.formatInboundEnvelope`、顶层 `getConfig`/`config.loadConfig`、`writeConfigFile` 及裸写 `~/.openclaw/openclaw.json` 等全部旧 API 回退（src/adapter/resolve.ts）
- 删除 dispatch 的「无 inbound.run 时手动 session + dispatchReply 直调」低版本整条分支
- 删除 setup/media/workspace/pairing/question-helpers 各子路径加载失败的降级实现；media 不再降级裸 fetch（安全考虑）
- 配对审批（`/bot-pairing approve`）改为 spawn 与网关同源的 `openclaw pairing approve` CLI（`approveChannelPairingCode` 无稳定导出）
- `preload.cjs` 删除旧 tsc `.js` 产物回退，只加载 `dist/index.cjs`

#### 用户配置兼容

| 移除项 | 替代写法 |
|---|---|
| `streaming: true/false`（布尔旧格式） | `streaming: { "mode": "partial", "sendMode": "stream" }` |
| 环境变量 `QQBOT_APP_ID` / `QQBOT_CLIENT_SECRET` | `QQBOT_APPID` / `QQBOT_SECRET` |
| `voiceDirectUploadFormats` | `audioFormatPolicy.uploadDirectFormats` |
| `processingTimeoutMs`（早已无效的死配置） | 无（并发控制由框架 session lane 承担） |
| `coalesce.strategy: "plugin"` 与 `maxBuffer` | 无——插件内合并器已删除，排队完全交给框架；只保留 `coalesce.enabled` |
| `OPENCLAW_PROCESSING_TIMEOUT_MS` 环境变量 | 无 |
| 审批目标解析的 `qqbot:direct:` 旧 scope | `qqbot:c2c:`（框架实际产生的格式） |

#### 死代码与旧生态

- 删除 onboarding 适配器（2026.9.2 SDK 已无该概念，引导入口统一为 setupWizard）
- 删除 `bin/qqbot-cli.js`（其 install/upgrade 安装的是**旧上游包** `@tencent-connect/openclaw-qqbot`，对本仓库完全错误）
- 删除 `scripts/cleanup-legacy-plugins.sh`、`upgrade-via-npm.sh`、`upgrade-via-npm.ps1`、`upgrade-via-source.sh`、`set-markdown.sh` 与 `docs/UPGRADE_GUIDE*.md`（全部指向旧上游 URL / clawdbot 生态）
- 清除全部 clawdbot / moltbot 残留（日志发现、CLI 名单、dev 脚本、版本探测）
- 删除孤儿模块 `tts-provider.ts`、`cron-scheduler.ts`、`image-size.ts`
- `getOpenclawVersion` 裁剪为直接读 `PluginRuntime.version`
- 本地 SDK 类型 stub 裁剪（onboarding 类型组、deprecated 成员、旧版 rt.log 声明）

#### API 变化（插件导出面）

- 移除导出：`qqbotOnboardingAdapter`、`consumePassiveReplyQuota`、`stripMentionText`/`detectWasMentioned`/`TEXT_CHUNK_LIMIT` 的兼容 re-export（内部请直接 import 源模块）
- `checkPassiveReplyQuota` 语义改为纯探测（不消耗配额）；需要消耗请用原子 API `checkAndConsumePassiveReplyQuota`（含 rollback）
- `/bot-pairing approve` 返回 `{approved}` 布尔语义

### 3. 升级到 1.0.0

```bash
# 从旧版本升级（含上游 2.x 装机）
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git#v1.0.0

# 或源码安装
git clone https://github.com/jerryliang122/qqbot-openclaw.git
cd openclaw-qqbot && npm install && npm run build
openclaw plugins install .
```

- 先确认 OpenClaw 框架 >= 2026.9.2（`openclaw --version`）
- 按上表迁移配置项；旧 key 会被静默忽略（不再有迁移逻辑）
- 群会话 lane 不受影响：session key 的 `:coalescing` 后缀保留，存量会话连续

---

## 发版操作手册

1. 更新 `CHANGELOG.md` 新版本段落
2. `package.json` 的 `version` 改为目标版本，并同步 `package-lock.json` 根部两处 `version` 字段（`version` 与 `packages."".version`，只改字段不重装依赖——v1.0.3 曾遗漏导致 lock 元数据停在 1.0.2）
3. 以上改动经 PR 合并进 main（**main 为保护分支，禁止直接 push**），然后在合并提交上打 tag：`git tag v1.0.0 && git push origin v1.0.0`（branch protection 不拦 tag push）
4. GitHub Actions（`.github/workflows/release.yml`）自动：校验 tag 与 package.json 一致 → typecheck / lint / build / 全量测试 → **`npm publish`（发布 `@jerryliang122/openclaw-qqbot`，OIDC Trusted Publishing）** → `npm pack` → 创建 GitHub Release 并附 tarball

**npm 发布前置（一次性配置，OIDC 免 token）**：

1. **首发引导**：npm 无 pending publisher 机制，全新包不能用 OIDC 首发——在已 `npm login` 的本机手动发布第一个版本一次（`npm run build && npm publish --access public`）。发版 workflow 检测到该版本已存在会自动跳过 publish、照常创建 GitHub Release。
2. **关联 Trusted Publisher**：npmjs.com → 包 `@jerryliang122/openclaw-qqbot` → Settings → Trusted publishing → 添加 GitHub Actions：`jerryliang122` / `qqbot-openclaw` / workflow 文件名 `release.yml`（大小写敏感，可留空 Environment）。
3. 之后所有版本由 CI 经 OIDC 自动发布，无需任何 npm token（建议随后在包设置中开启「Require 2FA and disallow tokens」彻底封死 token 发布）。
   - 要求：Node ≥ 22.14 / npm ≥ 11.5.1（workflow 已用 Node 24）；`package.json` 的 `repository.url` 必须与 GitHub 仓库一致（已一致）。

---

<details>
<summary><strong>上游历史版本记录（v2.1.0 及以前，来自 tencent-connect/openclaw-qqbot，仅供溯源）</strong></summary>

# Changelog (upstream lineage)

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [2.1.0] - 2026-08-17

### Changed

- **`asrFallback` semantics tightened**: QQ's built-in platform transcript (`asr_refer_text`) is now discarded in **all** cases unless `channels.qqbot.stt.asrFallback` is explicitly set to `true` — including when STT is not configured at all. Previously, unconfigured STT silently fell back to the platform transcript. Voice messages without any transcript source now render as `[Voice message - transcription unavailable]` (the audio URL is still referenced via the `- Voice:` line).
- The `asrFallback` flag is now read directly from the raw config, independent of whether STT credentials resolve — `stt: { "asrFallback": true }` alone restores the legacy platform-transcript behavior.

### Fixed

- `src/adapter/media.ts` no longer throws at import time under ESM (tsx): the `createRequire` anchor is now resolved lazily (`__filename` under CJS bundles, cwd under ESM).

## [2.0.1] - 2026-08-09

### Improved

- Enhanced message dispatch stability with better handling and logging for skipped dispatches.
- Relaxed runtime capability checks for broader OpenClaw version compatibility.

### Fixed

- Fixed the `/bot-upgrade` upgrade guide link.

## [2.0.0] - 2026-07-13

### Added

- **Modular Layered Architecture**: Refactored codebase into 12 sub-modules (adapter / dispatch / gateway / middleware / outbound / transport, etc.) for better maintainability and extensibility.
- **Runtime Adapter**: New runtime adaptation layer supporting automatic multi-version OpenClaw SDK compatibility, including older OpenClaw versions.
- **Outbound Pipeline**: Unified outbound delivery pipeline (TTS voice → media → text debounce) with streaming controller, reply rate limiter, and outbound text sanitization (strips thinking tags).
- **Middleware Layer**: Three new middlewares — access control, attachment processing, and policy injection — with flexible composition support.
- **New Slash Command**: `/bot-pairing` (QR code pairing).

### Changed

- Build switched to `tsup` pre-compilation (`dist/index.cjs`) for faster loading.
- `qqbot_channel_api` tool renamed to `qqbot_platform_api`.
- Dependency upgrades: `@tencent-connect/qqbot-connector` 1.2.0, added `@tencent-connect/qqbot-nodejs ^1.0.3`.

</details>
