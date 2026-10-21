/**
 * QQ 平台按钮（keyboard）渲染
 *
 * 把框架的**可移植 presentation**（`MessagePresentation`）映射为 QQ 开放平台
 * 原生的 `keyboard` 结构，让模型生成的按钮在 QQ 客户端真实可点。
 *
 * ── 为什么需要这个模块 ─────────────────────────────────────────────
 * 框架的 presentation 是通道无关的抽象，落地由通道侧的
 * `renderPresentation` / `presentationCapabilities` 两个钩子完成
 * （框架在 `deliver-prepare` 装配，契约见 openclaw 的
 * `outbound.types` —— `ChannelOutboundAdapter.renderPresentation`）。
 *
 * 此前本插件**没有**提供这两个钩子，导致：
 *   1. `agentPrompt.messageToolCapabilities` 声明了 `inlineButtons`，
 *      框架据此在 system prompt 里告诉模型「可以用按钮」；
 *   2. 但模型生成的按钮块在出站时被框架的通用降级路径
 *      （`materializeMessagePresentationFallback`）压成**纯文本列表**——
 *      用户看到的是「- 选项A」这种文本，而不是可点的按钮。
 *
 * 这就是「声明了但落地不了」的错配。本模块补齐落地侧。
 *
 * ── QQ 侧的平台约束（依据官方开放平台文档）───────────────────────
 * 1. `keyboard` 是发送接口的**一等字段**，与 `markdown` / `content` 平级，
 *    `keyboard.content.rows[].buttons[]` 可直接自定义，**不需要 template_id**。
 * 2. `action.type` 语义：
 *    - `0` 跳转链接（`data` 为 URL）
 *    - `1` 回调型（`data` 透传后台，触发 INTERACTION_CREATE）
 *    - `2` 指令型（点击后在输入框自动填入 `@bot` + `data`）
 *    - `3` mqqapi
 * 3. `action.permission.type` 语义：**0**=指定用户 / **1**=管理员 / **2**=所有人。
 *    （本插件统一用「所有人」，理由见 `src/types.ts` 的
 *    `KEYBOARD_PERMISSION_EVERYONE` 说明。）
 *
 * ── 映射范围（刻意收窄）────────────────────────────────────────────
 * 框架的按钮 action 类型有 7 种，QQ 只能落地 4 种：
 *
 * | 框架 action   | QQ action.type | 说明                          |
 * |----------------|----------------|-------------------------------|
 * | `url`         | `0` 跳转链接   | 直接映射                       |
 * | `command`     | `2` 指令型     | 直接映射，客户端自动填入指令  |
 * | `approval`    | `1` 回调型     | 复用既有 `approve:v2:` 解析    |
 * | `question`    | `1` 回调型     | 复用既有 `qqbot:qm:` 解析      |
 * | `callback`    | —              | **不支持**，见下方说明         |
 * | `web-app`     | —              | 不支持（QQ 无 web app）        |
 * | `model-picker`| —              | 不支持（QQ 无模型选择器）      |
 *
 * `callback` 不支持的理由：框架的 `callback` action 在 Telegram 侧走
 * `answerCallbackQuery`，语义是「给按钮一个回执」，**不是**「触发新一轮
 * agent 回合」。插件侧没有「任意模型按钮点击后回流到会话」的通道
 * （既有 interaction 路由只认 `qqbot:q:` / `qqbot:qm:` / `approve:v2:`
 * 三个固定前缀）。若把 `callback` 映射成 QQ 的 `action.type=1`，点击会
 * 产生一个无人处理的事件——比不支持更糟（用户点了没反应）。
 *
 * 不支持的控件按框架既有惯例**丢弃控件、保留文本**：模型的正文不丢，
 * 只是按钮变成文字描述。
 */

import type {
  MessagePresentation,
  MessagePresentationButton,
} from 'openclaw/plugin-sdk/interactive-runtime';
import {
  adaptMessagePresentationForChannel,
  renderMessagePresentationFallbackText,
} from 'openclaw/plugin-sdk/interactive-runtime';

import type { InlineKeyboard, KeyboardButton } from '../types.js';
import { KEYBOARD_PERMISSION_EVERYONE } from '../types.js';

// ── 常量 ────────────────────────────────────────────────────────────

/** QQ `action.type`：跳转链接 */
const QQ_ACTION_TYPE_URL = 0 as const;
/** QQ `action.type`：回调型（INTERACTION_CREATE） */
const QQ_ACTION_TYPE_CALLBACK = 1 as const;
/** QQ `action.type`：指令型（点击后客户端在输入框填入指令） */
const QQ_ACTION_TYPE_COMMAND = 2 as const;

/**
 * QQ 按钮 `action.data` 的 UTF-8 字节上限。
 *
 * 官方文档未在已读页面明确给出该上限，此处取保守值（与 QQ 模板消息的
 * `data` 惯例一致）。超限时降级为**指令型**按钮（`action.type=2`），
 * 而不是丢弃按钮——指令型对 `data` 的承载更宽松，且仍能触发用户操作。
 */
const MAX_ACTION_DATA_BYTES = 1024;

/** 单条消息的最大按钮数（平台未明确限制，取保守值） */
const MAX_BUTTONS = 20;

/** 单行最大按钮数（取保守值，与 QQ 客户端渲染友好度匹配） */
const MAX_BUTTONS_PER_ROW = 3;

/** 按钮 label 最大字符数 */
const MAX_LABEL_LENGTH = 40;

/**
 * 框架按钮 action → QQ 按钮的渲染结果。
 *
 * - `qq`：可落地的 QQ 按钮
 * - `dropped`：无法落地（web-app / model-picker / callback）——控件丢弃，文本保留
 */
interface RenderedButton {
  qq?: KeyboardButton;
  dropped?: boolean;
}

/**
 * ask_user 上下文：把框架的 `optionValue`（选项文本）映射回选项索引。
 *
 * 来自 payload 的 `channelData.askUser`（框架在投递前写入）：
 * `{ questionId, optionValues: string[] }`
 *
 * 与框架 Telegram 侧的 `resolveAskUserQuestionOptionIndex` 同款语义
 * （大小写不敏感 + trim 后匹配）。
 */
export interface QQQuestionContext {
  questionId: string;
  /** 选项文本 → 选项索引 */
  optionIndices: Map<string, number>;
}

/**
 * 从 payload 的 channelData 解析 ask_user 上下文。
 *
 * 返回 undefined 表示本次 payload 不带 ask_user 信息——此时 question
 * 类按钮无法映射到索引，只能丢弃控件。
 */
export function readQQQuestionContext(
  channelData: Record<string, unknown> | undefined,
): QQQuestionContext | undefined {
  if (!channelData) return undefined;
  const askUser = channelData.askUser;
  if (!askUser || typeof askUser !== 'object' || Array.isArray(askUser)) return undefined;
  const record = askUser as Record<string, unknown>;
  const questionId = record.questionId;
  const optionValues = record.optionValues;
  if (typeof questionId !== 'string' || !questionId) return undefined;
  if (!Array.isArray(optionValues) || optionValues.length < 2 || optionValues.length > 4) {
    return undefined;
  }
  const optionIndices = new Map<string, number>();
  for (const [optionIndex, optionValue] of optionValues.entries()) {
    if (typeof optionValue !== 'string') return undefined;
    const normalized = optionValue.trim().toLowerCase();
    if (!normalized || optionIndices.has(normalized)) return undefined;
    optionIndices.set(normalized, optionIndex);
  }
  return { questionId, optionIndices };
}

/**
 * 把框架的 question action 解析为 QQ 侧回调所需的 (questionId, optionIndex)。
 *
 * - `intent: 'custom-input'`（自由文本输入）——QQ 侧没有对应回调路由，
 *   丢弃控件（既有的「✍️ 其他」按钮走 `action.type=2` 指令型，不依赖本路径）。
 * - `optionValue` 变体——按 ask_user 上下文把选项文本换成索引。
 */
function resolveQQQuestionAction(
  action: Extract<NonNullable<MessagePresentationButton['action']>, { type: 'question' }>,
  context: QQQuestionContext | undefined,
): { questionId: string; optionIndex: number } | undefined {
  if ('intent' in action) return undefined; // custom-input：QQ 无对应路由
  if (!context) return undefined;
  if (context.questionId !== action.questionId) return undefined;
  const optionIndex = context.optionIndices.get(action.optionValue.trim().toLowerCase());
  if (optionIndex === undefined) return undefined;
  return { questionId: action.questionId, optionIndex };
}

// ── 能力声明 ────────────────────────────────────────────────────────

/**
 * QQ 的 presentation 能力声明。
 *
 * 各项含义见框架 `ChannelPresentationCapabilities`：
 * - `buttons: true` —— QQ 支持原生按钮（本模块实现）
 * - `selects/tables/charts/context/divider: false` —— QQ 无对应形态，
 *   框架会据此把这些块**自动降级为纯文本**（`adaptMessagePresentationForChannel`）
 * - `limits` —— 平台约束，供框架在适配阶段裁剪
 */
export const QQBOT_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: false,
  context: false,
  divider: false,
  charts: false,
  tables: false,
  limits: {
    actions: {
      maxActions: MAX_BUTTONS,
      maxActionsPerRow: MAX_BUTTONS_PER_ROW,
      maxRows: MAX_BUTTONS,
      maxLabelLength: MAX_LABEL_LENGTH,
      maxValueBytes: MAX_ACTION_DATA_BYTES,
      supportsStyles: false,
      supportsDisabled: false,
      supportsLayoutHints: false,
    },
    text: {
      maxLength: 5000,
      encoding: 'characters' as const,
      markdownDialect: 'markdown' as const,
      supportsEdit: false,
    },
  },
} as const;

// ── 工具 ────────────────────────────────────────────────────────────

/** UTF-8 字节长度 */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** 截断到指定字节数（不切开代理对） */
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Bytes(value) <= maxBytes) return value;
  // 逐步截断直到字节数达标（代理对安全：按 code point 边界回退）
  let end = value.length;
  while (end > 0) {
    const candidate = value.slice(0, end);
    if (utf8Bytes(candidate) <= maxBytes) return candidate;
    const code = value.charCodeAt(end - 1);
    // 落在代理对后半 → 再退一格，避免切碎代理对
    if (code >= 0xdc00 && code <= 0xdfff) end -= 1;
    else end -= 1;
  }
  return '';
}

/** 判断是否为可安全下发的 http(s) URL */
function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 生成稳定且唯一的按钮 id（QQ 要求同消息内唯一） */
function buildButtonId(index: number, kind: string): string {
  return `qqbot_${kind}_${index}`;
}

/**
 * 把框架按钮 action 映射为 QQ 按钮。
 *
 * @param button 框架按钮（已由 `adaptMessagePresentationForChannel` 适配）
 * @param index  同消息内序号（用于生成唯一 id）
 * @param questionContext ask_user 上下文（optionValue → 索引的映射）
 */
function renderButton(
  button: MessagePresentationButton,
  index: number,
  questionContext: QQQuestionContext | undefined,
): RenderedButton {
  const label = (button.label ?? '').trim();
  if (!label) return { dropped: true };

  const displayLabel =
    label.length > MAX_LABEL_LENGTH ? `${label.slice(0, MAX_LABEL_LENGTH - 1)}…` : label;

  const action = button.action;

  // ① url → QQ 跳转链接
  if (action?.type === 'url') {
    if (!isSafeHttpUrl(action.url)) return { dropped: true };
    const data = truncateUtf8(action.url, MAX_ACTION_DATA_BYTES);
    return {
      qq: {
        id: buildButtonId(index, 'url'),
        render_data: { label: displayLabel, visited_label: displayLabel, style: 0 },
        action: {
          type: QQ_ACTION_TYPE_URL,
          data,
          permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        },
      },
    };
  }

  // ② command → QQ 指令型（客户端点击后在输入框自动填入 @bot + 指令）
  if (action?.type === 'command') {
    const command = action.command?.trim();
    if (!command) return { dropped: true };
    const data = truncateUtf8(command, MAX_ACTION_DATA_BYTES);
    return {
      qq: {
        id: buildButtonId(index, 'cmd'),
        render_data: { label: displayLabel, visited_label: displayLabel, style: 0 },
        action: {
          type: QQ_ACTION_TYPE_COMMAND,
          data,
          // enter=true：点击后直接发出（而非仅填入输入框）
          enter: true,
          permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        },
      },
    };
  }

  // ③ approval → QQ 回调型（复用既有 approve:v2: 解析）
  if (action?.type === 'approval') {
    const data = `approve:v2:${action.approvalKind}:${encodeURIComponent(action.approvalId)}:${action.decision}`;
    const truncated = truncateUtf8(data, MAX_ACTION_DATA_BYTES);
    // 截断会破坏解析 → 宁可不发按钮，也不要发一个点了会报错的数据
    if (truncated !== data) return { dropped: true };
    return {
      qq: {
        id: buildButtonId(index, 'appr'),
        render_data: { label: displayLabel, visited_label: displayLabel, style: 0 },
        action: {
          type: QQ_ACTION_TYPE_CALLBACK,
          data,
          permission: { type: KEYBOARD_PERMISSION_EVERYONE },
          click_limit: 1,
        },
      },
    };
  }

  // ④ question → QQ 回调型（复用既有 qqbot:q: 解析）
  //
  // 框架的 question action 带的是 `optionValue`（选项**文本**），而 QQ 侧
  // 既有的回调格式 `qqbot:q:<questionId>:<optionIndex>` 用的是选项**索引**。
  // 二者的桥接靠 payload 上的 `channelData.askUser`：
  //   { questionId, optionValues: string[] }
  // 框架据此把 optionValue 映射回索引（Telegram 侧走同一套
  // `resolveAskUserQuestionOptionIndex`）。
  //
  // 拿不到该上下文（askUser 不在本次 payload 上）时**丢弃控件保留文本**——
  // 发一个点了会解析失败的回调比不发更糟。
  if (action?.type === 'question') {
    const resolved = resolveQQQuestionAction(action, questionContext);
    if (!resolved) return { dropped: true };
    const data = `qqbot:q:${resolved.questionId}:${resolved.optionIndex}`;
    const truncated = truncateUtf8(data, MAX_ACTION_DATA_BYTES);
    if (truncated !== data) return { dropped: true };
    return {
      qq: {
        id: buildButtonId(index, 'ques'),
        render_data: { label: displayLabel, visited_label: displayLabel, style: 0 },
        action: {
          type: QQ_ACTION_TYPE_CALLBACK,
          data,
          permission: { type: KEYBOARD_PERMISSION_EVERYONE },
          click_limit: 1,
        },
      },
    };
  }

  // ⑤ callback / web-app / model-picker —— QQ 无法承载，丢弃控件保留文本
  return { dropped: true };
}

// ── 主入口 ──────────────────────────────────────────────────────────

/**
 * 把 presentation 渲染为 QQ 原生 keyboard。
 *
 * 纯函数，无副作用，无状态。返回 `null` 表示「本次没有可落地的按钮」，
 * 调用方应保留纯文本投递。
 *
 * @param presentation 框架的规范化 presentation
 * @param questionContext ask_user 上下文（从 payload 的 channelData.askUser 解析）
 * @returns QQ keyboard，或 null（无可落地按钮 / 全部控件被丢弃）
 */
export function renderQQBotKeyboard(
  presentation: MessagePresentation,
  questionContext?: QQQuestionContext,
): InlineKeyboard | null {
  // 先按 QQ 的能力声明适配：selects/tables/charts/context/divider 等
  // 平台不支持的块在这里被框架自动降级为纯文本块。
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: QQBOT_PRESENTATION_CAPABILITIES,
  });

  const rows: KeyboardButton[][] = [];
  let buttonIndex = 0;

  for (const block of adapted.blocks) {
    if (block.type !== 'buttons') continue;
    const rowButtons: KeyboardButton[] = [];
    for (const button of block.buttons) {
      if (buttonIndex >= MAX_BUTTONS) break;
      const rendered = renderButton(button, buttonIndex, questionContext);
      buttonIndex += 1;
      if (!rendered.qq) continue; // 丢弃控件（文本已由 fallback 保留）
      rowButtons.push(rendered.qq);
      if (rowButtons.length >= MAX_BUTTONS_PER_ROW) {
        // 必须**复制**再 push：rowButtons 后续会被 length = 0 清空，
        // 直接 push 引用会把已产出的行一起清空（按钮全丢）。
        rows.push([...rowButtons]);
        rowButtons.length = 0;
      }
    }
    if (rowButtons.length > 0) {
      rows.push([...rowButtons]);
      rowButtons.length = 0;
    }
  }

  if (rows.length === 0) return null;
  return { content: { rows: rows.map((buttons) => ({ buttons })) } };
}

/**
 * 计算 presentation 中**无法落地**的控件（用于日志与诊断）。
 *
 * 返回被丢弃控件的数量与原因分布，便于排查「模型生成了按钮但 QQ 没渲染」。
 */
export function countDroppedPresentationControls(
  presentation: MessagePresentation,
  questionContext?: QQQuestionContext,
): { dropped: number; reasons: Record<string, number> } {
  const adapted = adaptMessagePresentationForChannel({
    presentation,
    capabilities: QQBOT_PRESENTATION_CAPABILITIES,
  });
  const reasons: Record<string, number> = {};
  let dropped = 0;

  for (const block of adapted.blocks) {
    if (block.type !== 'buttons') continue;
    for (const button of block.buttons) {
      const rendered = renderButton(button, 0, questionContext);
      if (rendered.qq) continue;
      dropped += 1;
      const action = button.action;
      // 分桶口径：
      // - 有 action → 按 action.type 分桶（url / command / approval / question /
      //   web-app / model-picker / callback）
      // - 无 action 但有 value → 框架的 `callback` 形态（按钮点了回传一个值，
      //   QQ 无对应回流通道）→ 归为 callback
      // - 无 action 无 value → url 非法（框架允许裸 url 字段）或未知
      const reason = action
        ? action.type
        : button.value
          ? 'callback'
          : button.url
            ? 'url-invalid'
            : 'unknown';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }

  return { dropped, reasons };
}

/**
 * 渲染 presentation 的纯文本兜底（供按钮全部被丢弃时使用）。
 *
 * 与框架的 `renderMessagePresentationFallbackText` 同源，保证
 * 「有按钮的模型消息」在 QQ 上退化成文本时，措辞与框架一致。
 */
export function renderQQBotPresentationFallbackText(presentation: MessagePresentation): string {
  return renderMessagePresentationFallbackText({ presentation });
}
