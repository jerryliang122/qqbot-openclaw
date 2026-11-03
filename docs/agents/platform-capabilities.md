# QQ Bot 平台能力 vs 其他 OpenClaw 通道

> 深度参考文档。AGENTS.md 只保留结论摘要；平台语义细节（配额表、渲染差异、传输模式）以本文为准。

## QQ Bot 平台能力 vs 其他 OpenClaw 通道

QQ Bot 跟 Telegram / Discord / Slack 等其他通道在平台 API 形态上差异较大,这些差异是不可消解的,设计时必须以此为前提。

### 底层依赖

- 完全依赖官方 Node.js SDK `@tencent-connect/qqbot-nodejs` (v1.0.4)。`@tencent-connect/qqbot-connector` (1.2.0, 精确钉版) 仅用于扫码登录 setup 流程。
- **SDK 版本滞后于平台文档**（2026-09 核查）: npm 上 SDK latest 仍是 1.0.4 (2026-07-14 发布)，未覆盖平台 2026-08-10 / 08-12 更新 —— 接口域名统一为 `api.bot.qq.com`、群禁言管理（查询/设置用户禁言）、入群申请审批（拉列表/审批）与自动审批策略、自定义菜单、指令面板、Markdown 新参数 `force_verify_image_resource`、入群申请事件。其中 REST 新接口**今天就可经 `qqbot_platform_api` 工具调用**（SDK `bot.api` 是任意 path 的通用网关，自动鉴权/重试），类型化封装等 SDK 发版；入群申请**事件**与 `force_verify_image_resource` 参数则依赖 SDK 更新。
- **媒体 source 的 SSRF 防护只按「小写 http(s):// 前缀」判定，非 http(s) scheme 一律透传（2026-11-02 实测，**决定暂不加固**，理由见下）**: `resolveMediaPath`（`src/outbound/media-send.ts`）用 `source.startsWith('http://'|'https://')` 决定是否走 `validateRemoteUrl`，其余 source 一律当「远程 URL」透传给 SDK（`resolveMediaSource` 末尾兜底 `return { url: source }`）；**SDK 不本地 fetch**（`node_modules/@tencent-connect/qqbot-nodejs/dist/protocol/api/media.js` 只做 `body.url = opts.url`，真正抓取的是 QQ 平台）。**实测可绕过**：同一内网目标 `http://169.254.169.254/x.png` 被拦截，而 `HTTP://…`（大写）、`http:/…`（单斜杠）、` http://…`（前导空格）三种拼写**全部放行**并原样交给平台——因为校验是**大小写敏感的字面量前缀匹配**，消费端（平台侧 URL 解析器，WHATWG 规范）会把这些变体**归一化成同一个 `http://` 绝对 URL**。**本地文件读取不受影响**（`file://` / `/` / `~` / `./` / `C:\` 全走 `resolveAllowedLocalPath` 的 realpath + 根目录白名单）。**决定：暂不加固**——触发前提是 agent 侧输出被污染（提示注入 / 被投毒的外部工具），而那一步一旦成立，agent 已具备更强能力（跑工具、读文件），SSRF 的边际收益低；「明确拒绝非 http(s) scheme」还会打断可能存在的既有工作流。**但这是「假防护」，不是「无防护」**：一旦插件开始**本地** fetch 媒体（按平台软限制预检大小、算 `file_size`、取时长/缩略图都是自然演进方向），这些拼写变体立刻变成插件主机侧完整可利用的 SSRF + 响应回传。**触发器（下次看到就做）**：① 插件侧出现任何「先下载再上传」媒体路径；② 媒体 source 的可信度假设从「agent 输出可信」改为「不可信」；③ 出现提示注入可触达外部内容的部署形态。届时做法：改用 `new URL(source)` 解析后按 `url.protocol` 判定（http/https → 现有 SSRF 校验、data: → 现有大小校验、file/本地路径 → 现有白名单、**其它 protocol 明确拒绝**），并让 `resolveMediaSource` 用同一份解析结果决定 `{url}/{localPath}/{fileData}`，杜绝「校验一套、消费另一套」。顺带待修的健壮性 bug：裸文件名在工作区找不到时被当成相对 URL 塞给平台（`{url:'photo.png'}`），应直接报「文件不存在」。
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
| **被动回复** (passive) | `msg_id` 或 `event_id` 二选一 | 私聊 4 次/msg,群 5 次/msg（**文档口径，平台实测不执行**，见下） | 私聊 60 min,群 5 min |
| **主动推送** (proactive) | 都不传 | 私聊 Bot 维度 10/qps(未认证 5/qps + 30/qpm),群 60/qpm;接收方 20/qpm,1 天最多 1000 条 | 无 |
| **互动召回** (wakeup) | `is_wakeup=true`,与 msg_id/event_id 互斥 | 30 天内 4 周期,每周期 1 条 | 30 天 |

- 接口级统一 QPS 上限 100。
- 错误码 `40034128` = 被动回复时间/次数超限;`40034100` = 主动消息超限;`40034122` = 互动召回达上限。
- **「4/5 次 per msg_id」平台实测不执行（2026-11-02 探针，官方 WebSocket 收 C2C + 撤回接口自证）**：同一 msg_id 连发 25 次被动回复全部 HTTP 200 且真实送达（撤回自证），25s 慢速间隔复测同样全过；typing（msg_type=6）不占回复额度。平台真实硬约束只有 **msg_id 时效窗口**（40034005）与 **msg_id+msg_seq 唯一性**（40054005）。这正是插件「反应式配额」模型的依据（本地不按次数阻断，平台真拒绝再兜底转主动，见 docs/agents/outbound-and-quota.md）。唯一性是**本地必须防**的约束（单调 seq 发号）；次数是**文档写了但平台不做**的约束——本地 preemptive 阻断等于替平台做决定。

### "流式"是另一种发送通道,不是回复模式

- **不要把流式跟被动/主动混在一起** — 流式是**另一套** API:
  - `openStream` 创建流(仅 c2c,群不支持流式参数)
  - `session.update` 多次替换(已发送的 prefix 不可修改)
  - `session.complete` 收尾
- 流式**没有"流式配额"**,但流式通道里的回复消息(`session.update` 推送)仍是 C2C 被动回复(同上表口径;次数上限实测不执行,60 min 窗口真实)。
- 见 `src/middleware/typing.ts`:typing 只做锚点存活探测(判 TTL/死锚点),不占回复额度(实测) — **锚点过期/判死 ⇒ 本轮停发**,绝不降级为不带 msg_id 的主动形态(主动额度留给正文与前置消息);平台当场拒收 typing(40034005/40034128)同样停发并标记死锚点。
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
- 两种模式对中间件、事件监听、消息发送 API 是一致的;插件层的**消息处理行为无差异**——唯一例外是 webhook 模式专属的**准入跟踪**（op:0 detached 派发 + handleInboundMessage 在途登记，见 Key gotchas 的 issue #74 条目）：那是对「HTTP 请求级准入 vs 常驻连接级准入」这一宿主差异的补偿，不是行为分叉，websocket 路径完全不经过它。

### 与 Telegram 的能力映射(快速对照)

| 能力 | Telegram | QQBot |
|------|----------|-------|
| 私聊 | DM (`chat.type === 'private'`) | C2C (`scope === 'c2c'`) |
| 群 | group / supergroup / forum | group (`scope === 'group'`) |
| DM topic / forum / thread | `message_thread_id` | **不存在** |
| 频道/Guild | channel | 独立 QQ 频道产品(走 `qqbot-channel` skill) |
| Markdown 渲染 | 服务端 `parse_mode: HTML` | 客户端原生 `msg_type: markdown` |
| 引用回复 | `reply_to_message_id` / `reply_parameters` | `msg_id` 被动回复（锚点必须来自**显式回复意图**——挂 msg_id = 对该消息的回复，池化挑锚=挂错引用，2026-11-03 已移除） |
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
