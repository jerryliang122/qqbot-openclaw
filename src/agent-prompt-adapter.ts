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
