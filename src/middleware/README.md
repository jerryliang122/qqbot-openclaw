# `src/middleware/` — 入站中间件链

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：入站消息的准入判定与加工——访问控制、附件解析、事件守卫、策略注入、Secret 捕获、typing 指示。
- **不做**：正文装配与投递（在 [`src/dispatch/`](../dispatch/)）、会话状态（在 [`src/features/`](../features/)）、发送（在 [`src/outbound/`](../outbound/)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `access-control.ts` | `dynamicAccessControl`——allowFrom / pairing 判定 |
| `attachment.ts` | `attachmentProcessor` / `processAttachments`——入站附件解析与媒体事实提取 |
| `inbound-guard.ts` | `inboundGuard`——出站回声 / 重复推送 / 空内容三类守卫 |
| `policy-injector.ts` | `createPolicyInjector`——room_event 门控与策略注入 |
| `secret-capture.ts` | `secretCapture`——拦截下一条 c2c 文本写入密钥库；`isSecretInputCancelKeyword` |
| `typing.ts` | `c2cTypingIndicator`——typing 指示与续期；`MIN_TYPING_INTERVAL_MS` / `POST_MESSAGE_REFRESH_DELAY_MS` |

## 相关红线

- **白名单拒绝必须回告，不能静默丢弃** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「白名单拒绝必须回告」
- **入站事件守卫拦三类非真实用户输入** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「入站事件守卫」
- **入站语音走框架转录管线** → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「入站语音走框架转录管线」
- **room_event 的三处裁决必须同源**（本目录是其中一处：门控）→ [`docs/agents/group-and-room-event.md`](../../docs/agents/group-and-room-event.md) §「room_event 完整支持」
- **Secret input 的消息绝不进 AI transcript** → [`docs/agents/interaction.md`](../../docs/agents/interaction.md) §「Secret input flow」
- **typing 永不占用主动额度；锚点不可用即本轮停发** → [`docs/agents/outbound-and-quota.md`](../../docs/agents/outbound-and-quota.md) §「Typing renewal」

## 本目录特有的坑

- **中间件链顺序敏感**——`secretCapture` 挂在 slashCommand 之后、`c2cTypingIndicator` 之前；改顺序前先读 [`docs/agents/interaction.md`](../../docs/agents/interaction.md) 的 Secret input 段。
- **多问题 ask_user 待答时 `secretCapture` 必须放行**——否则用户的答案会被写进密钥库（红线）。
- **`access-control.ts` 的拒绝回告由 `src/features/access-notice.ts` 实现**——本目录只做判定，回话在那边，且 `disabled` 策略下必须静默。
- **`inbound-guard.ts` 的 `skipSelfEcho` 必须 true**，重复推送窗口补到 30min（SDK 内置仅 5s）。
- **带 `msg_elements` 的 103 引用/转发必须放行**——不能被空内容守卫误杀。
- **`typing.ts` 与 `src/typing-lifecycle.ts` 必须同口径**——turn 内中间件路径与心跳路径的停发判定要一致。
- **`policy-injector.ts` 的门控结论要与 dispatch 的入站分类、历史缓冲跳过共用同一份**——三处各算各的必然出事（门控放行 + 分类成 user_request = 刷屏；门控拦掉 + 分类成 room_event = 永远收不到消息）。
