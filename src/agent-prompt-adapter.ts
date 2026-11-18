/**
 * QQBot Agent Prompt 适配器
 *
 * 提供 inboundFormattingHints 等提示信息
 */

/**
 * QQBot Agent Prompt Adapter
 */
export const qqbotAgentPromptAdapter = {
  /**
   * 声明本频道支持**原生 ask_user 提问控件**（按钮卡）。
   *
   * ⚠️ **红线：这一行不能删**（2026-11-18 issue #113）——
   * openclaw 2026.11.5 起，core 把 `ask_user` 是否进入工具目录
   * **按频道能力发放**：`shouldIncludePrimarySessionToolForOpenClawTools`
   * 读 `questionInputMode`，取值既不是 `"native"` 也不是 `"buttons"`
   * 就把 `ask_user` 从工具目录里剔除（缺省 `"none"`）。core 的解析
   * 来源是**入站频道插件**：
   *
   * ```js
   * // openclaw ≥2026.11.5
   * getChannelPlugin(channel)?.agentPrompt?.questionInputMode ?? "none"
   * ```
   *
   * 删掉这一行的后果是**静默降级**：插件不报错、编译不失败，
   * `ask_user` 只是从工具目录消失 ⇒ agent 改用纯文本提问，QQ 用户
   * 看到的单题 / 多题卡片与按钮**全部消失**。2026.11.4 → 2026.11.5
   * 升级即触发（11.4 完全不检查该字段，故升级前功能正常）。
   *
   * 上游把「省略即不发放」写成了**有意设计**（core 文档
   * `docs/plugins/sdk-channel-plugins.md` § Question input：省略声明
   * 会让 `ask_user` 不进入工具目录），所以修复归属在插件侧——
   * 我们必须**显式声明**自己支持按钮。
   *
   * 声明与实现一致（不是空头支票）：QQ 的 `keyboard` 是发送接口的
   * 一等字段，`src/features/question-card.ts` 渲染选项按钮
   * （`qqbot:q:` / `qqbot:qm:` 回调数据）、`src/gateway/event-handlers.ts`
   * 路由按钮回调、`src/features/question-submit.ts` 走框架官方
   * `claimPendingAgentQuestionAnswer` 通道回流答案。
   *
   * 取值只能是 `"buttons"`：core 的类型是字面量联合
   * `"buttons" | "native" | "none"`，`"native"` 指**客户端**（webchat
   * 一类）自带的提问控件，QQ 属于**频道自带按钮**，故取 `"buttons"`
   * ——与内置 Telegram 频道同值。
   *
   * `as const` 不可省：让推断类型是字面量 `"buttons"` 而不是 `string`，
   * 这样钉版抬到声明了该字段的 openclaw 时类型仍成立。
   */
  questionInputMode: 'buttons' as const,

  /**
   * 开放给模型的 message 工具能力。
   *
   * `inlineButtons` —— QQ 支持**原生按钮**（`keyboard` 是发送接口的一等
   * 字段，与 `markdown`/`content` 平级，见 QQ 开放平台文档）。本插件已
   * 实现落地通路：`src/outbound/presentation-buttons.ts` 把框架的可移植
   * presentation 映射为 QQ 的 `keyboard`，出站侧经
   * `renderPresentation` / `presentationCapabilities` 两个钩子接入框架。
   *
   * ⚠️ **能力范围是刻意收窄的**，模型并不总能拿到按钮：
   * | 框架 action | QQ 落地 |
   * |---|---|
   * | `url` | ✅ `action.type=0` 跳转链接 |
   * | `command` | ✅ `action.type=2` 指令型 |
   * | `approval` | ✅ `action.type=1`，复用 `approve:v2:` 解析 |
   * | `question` | ✅ `action.type=1`，复用 `qqbot:q:` 解析（需 ask_user 上下文） |
   * | `callback` | ❌ 丢弃控件保留文本（QQ 无「按钮点击回流到会话」的通道） |
   * | `web-app` | ❌ 丢弃控件保留文本（QQ 无 web app） |
   * | `model-picker` | ❌ 丢弃控件保留文本（QQ 无模型选择器） |
   *
   * 不可落地的控件按框架惯例**丢弃控件、保留文本**——模型正文不丢，
   * 只是按钮变成文字描述。因此「声明了 inlineButtons」对模型而言是
   * **大体可用但非全支持**，模型应把按钮当作锦上添花而非依赖项。
   */
  messageToolCapabilities: ({ cfg, accountId }: { cfg?: any; accountId?: string | null }) => {
    return ['inlineButtons'];
  },

  inboundFormattingHints: ({ accountId }: { accountId?: string | null }) => {
    return {
      text_markup: 'markdown',
      rules: [
        'QQ Bot 原生支持 Markdown 渲染',
        '支持标题、列表、代码块、引用等',
        '不支持 HTML 标签',
        '媒体使用 https URL',
      ],
    };
  },
};

/**
 * 类型层守卫：`questionInputMode` 的推断类型必须是**字面量** `"buttons"`，
 * 不能退化成 `string`。
 *
 * openclaw ≥2026.11.5 的类型是 `questionInputMode?: "buttons"`（字面量联合），
 * 一旦退化成 `string`，抬钉版时 typecheck 会**响亮报错**（而不是等到线上
 * 静默降级）——所以这里把该失败前移到编译期。
 *
 * 注意：钉版 `2026.10.5` 的 `ChannelAgentPromptAdapter` 还没有这个字段，
 * 故本守卫走「独立断言」而非依赖框架类型（框架类型抬上来后两者同时成立）。
 */
const _assertQuestionInputModeIsLiteral: 'buttons' =
  qqbotAgentPromptAdapter.questionInputMode;
void _assertQuestionInputModeIsLiteral;
