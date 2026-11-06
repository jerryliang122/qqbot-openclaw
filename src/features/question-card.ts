/**
 * ask_user 卡片渲染层（单题 / 多题共用）
 *
 * ── 为什么独立成模块 ─────────────────────────────────────────────
 * 此前**单题**卡与**多题**卡是两套完全不同的渲染：
 *
 * - 多题：插件从框架文本反解题目结构，**自己渲染**（`第 k/N 题 · header`
 *   + 题干 + 编号选项 + 按钮），用户可见形态可控；
 * - 单题：插件**不重绘**，直接把框架 `payload.text` 原文当正文发出去——
 *   于是用户看到的是框架脚手架（`Question for you:` /
 *   `Other: reply with your own answer.` / `Reply with the number…`）
 *   加上与按钮重复的选项清单，且按钮标签既不截断也没有序号前缀。
 *
 * 本模块把两种卡片收敛到**同一套渲染原语**上：
 * - `parseSingleQuestionPrompt`：单题文本反解（锚点是 `optionValues` 的精确 label）
 * - `formatQuestionCard`：正文渲染（单题 / 多题同源）
 * - `buildQuestionOptionKeyboard`：选项按钮（序号前缀 + 截断 + 自适应分行）
 *
 * 迁移自 `question-helpers.ts` 的原语**逻辑与输出逐字不变**（多题卡的
 * 既有回归用例即迁移安全的硬证据）。
 *
 * ── 红线 ───────────────────────────────────────────────────────────
 * - 解析失败一律返回 `null`，由调用方回退到「框架原文 + 旧键盘」
 *   （= 改造前的形态），**绝不产出半解析的卡片**；
 * - 按钮 `action.data` 的格式是既有回调契约（`parseQuestionButtonData` /
 *   `parseMultiQuestionButtonData`），**不得改动**；
 * - 本模块只负责「渲染」，**不负责提交**——答案回流仍走框架的
 *   `resolveOption` / keyed 文本认领通道（禁止程序化提交、禁止合成入站消息）。
 */

import type { InlineKeyboard, KeyboardButton } from '../types.js';
import { KEYBOARD_PERMISSION_EVERYONE } from '../types.js';

// ============ Types ============

/**
 * 一道题的结构（单题 / 多题共用）。
 *
 * 多题的来源是 `parseMultiQuestionPrompt`（框架文本反解）；单题的来源是
 * `parseSingleQuestionPrompt`（框架文本反解 + `optionValues` 精确锚点）。
 */
export interface QuestionDef {
  /** 模型的短标题（框架截断到 12 字符） */
  header: string;
  /** 题干（模型原文，可含换行） */
  question: string;
  /** 选项原始行：`"<label>"` 或 `"<label> - <description>"` */
  options: string[];
  /** 题目声明了 "Other: reply with your own answer."（允许自由文本作答） */
  isOther?: boolean;
}

/** 正文渲染参数 */
export interface QuestionCardOpts {
  /** 0-based 题序号（显示时 +1）；缺省 = 单题 */
  index?: number;
  /** 总题数；缺省 = 单题 */
  total?: number;
  /** 单题 / 多题（决定标题形态与结尾提示） */
  variant: 'single' | 'multi';
  /**
   * 卡片是否伴随按钮键盘投递（默认 true）。
   * 键盘发送失败后的**纯文本兜底**传 false：去掉「点下方按钮作答」
   * 指引、引导行改为「直接回复」文案——否则正文在指引用户点不存在的
   * 按钮（2026-11-05 评审 F1）。
   */
  keyboardAttached?: boolean;
}

/** 选项按钮渲染参数 */
export interface QuestionKeyboardOpts {
  questionId: string;
  /** 点击回调 data 的构造器（单题 `qqbot:q:<qid>:<idx>`；多题 `qqbot:qm:<qid>:<qIdx>:<idx>`） */
  buildActionData: (optionIndex: number) => string;
  /** 互斥组 id（单题 `question`；多题 `question-<k>`） */
  groupId: string;
  /** 按钮 id 前缀（单题 `q`；多题 `q<k>_`） */
  idPrefix: string;
  /** 点击后的按钮文案（单题「已回答」；多题「已选」） */
  visitedLabel?: string;
  /** 是否追加「✍️ 其他」指令按钮（仅多题 isOther） */
  includeOtherButton?: boolean;
  /** 「✍️ 其他」按钮预填内容（多题：`"<题号>: "`） */
  otherData?: string;
}

// ============ 渲染原语（自 question-helpers.ts 原样迁入）============

/** 选项按钮的序号前缀，与正文里的加粗序号 1./2./3./4. 一一对应 */
const OPTION_NUMBER_PREFIXES = ['①', '②', '③', '④'] as const;

/** 按钮标签安全宽度（约 12 个汉字），超出截断加省略号 */
const MAX_BUTTON_LABEL_WIDTH = 24;
/** 一行放满时允许的最大标签宽度，超过改为每行 2 个 */
const SINGLE_ROW_MAX_LABEL_WIDTH = 20;

/**
 * 选项整行形如 "调研/方案 (Recommended) - 搜索、分析、对比、出方案。"，
 * 按第一个 " - " 拆出标签部分（拆不准时退回整行，不影响答案正确性——
 * 答案靠题号/选项号定位，不依赖标签文本）。
 */
export function splitOptionLabel(optionLine: string): string {
  const sep = optionLine.indexOf(' - ');
  if (sep > 0) return optionLine.slice(0, sep).trim();
  return optionLine.trim();
}

function splitOptionDescription(optionLine: string): string {
  const label = splitOptionLabel(optionLine);
  if (optionLine.length > label.length && optionLine.startsWith(label)) {
    return optionLine.slice(label.length).replace(/^\s*-\s*/, '').trim();
  }
  return '';
}

/** 估算文字显示宽度：CJK/全角/emoji 记 2，其余记 1 */
export function estimateLabelWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      code >= 0x1f300;
    width += wide ? 2 : 1;
  }
  return width;
}

/** 剥掉框架渲染在选项标签尾部的 "(Recommended)" 标记 */
export function stripRecommendedSuffix(label: string): string {
  return label.replace(/\s*\(\s*recommended\s*\)\s*$/i, '').trim();
}

/** 从选项整行生成按钮短标签：剥描述 → 剥 "(Recommended)" 后缀 → 超宽截断。
 * reserveWidth 为前缀（如选项序号）预留的显示宽度。 */
export function buildButtonLabel(optionLine: string, reserveWidth = 0): string {
  let label = stripRecommendedSuffix(splitOptionLabel(optionLine));
  const max = MAX_BUTTON_LABEL_WIDTH - reserveWidth;
  if (estimateLabelWidth(label) <= max) return label;
  let truncated = '';
  let width = 0;
  for (const ch of label) {
    const w = estimateLabelWidth(ch);
    if (width + w > max - 2) break;
    truncated += ch;
    width += w;
  }
  return `${truncated.trimEnd()}…`;
}

/** 自适应分行：标签全部较短时一行放满，否则每行 2 个 */
function layoutButtonRows(buttons: KeyboardButton[]): Array<{ buttons: KeyboardButton[] }> {
  const widest = buttons.reduce(
    (max, b) => Math.max(max, estimateLabelWidth(b.render_data?.label ?? '')),
    0,
  );
  if (widest <= SINGLE_ROW_MAX_LABEL_WIDTH || buttons.length <= 2) {
    return [{ buttons }];
  }
  const rows: Array<{ buttons: KeyboardButton[] }> = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push({ buttons: buttons.slice(i, i + 2) });
  }
  return rows;
}

// ============ 正文渲染 ============

/**
 * 渲染一张问题卡的正文（单题 / 多题同源）。
 *
 * 单题（`variant:'single'`）：
 * ```
 * **<header>**
 *
 * <题干>
 *
 * **1.** <选项> —— <描述>
 *
 * **2.** <选项2>
 *
 * 👇 点下方按钮作答
 *
 * 不想选按钮？直接回复「序号 / 选项名 / 你的答案」
 * ```
 *
 * 多题（`variant:'multi'`）：`**第 k/N 题 · <header>**` + 题干 + 编号选项
 * + `👇 点下方按钮作答` + （isOther 时）「✍️ 其他」提示。
 */
export function formatQuestionCard(def: QuestionDef, opts: QuestionCardOpts): string {
  const index = opts.index ?? 0;
  const total = opts.total ?? 1;
  const keyboardAttached = opts.keyboardAttached ?? true;
  const lines: string[] = [];

  if (opts.variant === 'multi') {
    lines.push(`**第 ${index + 1}/${total} 题 · ${def.header}**`);
  } else {
    lines.push(`**${def.header}**`);
  }

  if (def.question.trim()) {
    lines.push('', def.question.trim());
  }
  for (const [optionIndex, optionLine] of def.options.entries()) {
    const label = stripRecommendedSuffix(splitOptionLabel(optionLine));
    const desc = splitOptionDescription(optionLine);
    lines.push('', `**${optionIndex + 1}.** ${label}${desc ? ` —— ${desc}` : ''}`);
  }
  if (keyboardAttached) {
    lines.push('', '👇 点下方按钮作答');
  }

  if (opts.variant === 'multi') {
    if (def.isOther) {
      lines.push(
        '',
        keyboardAttached
          ? `选项不合适？点「✍️ 其他」后输入，或直接回复 "${index + 1}: 你的答案"`
          : `选项不合适？直接回复 "${index + 1}: 你的答案"`,
      );
    }
  } else if (!keyboardAttached) {
    // 单题纯文本兜底：没有按钮可点，直接回复是唯一作答方式——无论
    // isOther 都要给引导行（非 isOther 题不收自由文本，只引导序号/选项名）
    lines.push('', def.isOther ? '直接回复「序号 / 选项名 / 你的答案」' : '直接回复「序号 / 选项名」');
  } else if (def.isOther) {
    // 单题自由文本作答走框架的「整条文本即答案」通道（isOther 恒为 true，
    // 见 normalizeAskUserParams）⇒ 序号 / 选项名 / 任意文本都能作答。
    lines.push('', '不想选按钮？直接回复「序号 / 选项名 / 你的答案」');
  }

  return lines.join('\n');
}

/**
 * 多题卡的正文（兼容入口，输出与迁移前**逐字一致**）。
 */
export function formatMultiQuestionCard(
  question: QuestionDef,
  questionIndex: number,
  total: number,
): string {
  return formatQuestionCard(question, { variant: 'multi', index: questionIndex, total });
}

// ============ 按钮渲染 ============

/**
 * 渲染一道题的选项按钮（单题 / 多题同源）。
 *
 * - 选项按钮：`action.type=1`（回调）、`permission.type=2`（所有人可点）、
 *   `click_limit=1`；标签带 `①②③` 序号前缀（与正文加粗序号一一对应，
 *   截断后也能对上号）；宽标签自动每行 2 个
 * - 「✍️ 其他」指令按钮（仅多题 isOther）：`action.type=2`、`enter=false`，
 *   点击后客户端在输入框预填 `<题号>: `，用户续写后发送即 keyed 答案格式
 */
export function buildQuestionOptionKeyboard(
  def: QuestionDef,
  opts: QuestionKeyboardOpts,
): InlineKeyboard {
  const visitedLabel = opts.visitedLabel ?? '已选';
  const buttons: KeyboardButton[] = def.options.map((optionLine, optionIndex) => {
    const prefix = OPTION_NUMBER_PREFIXES[optionIndex] ?? '';
    // 前缀 + 空格的显示宽度（全角序号 2 + 空格 1）
    const reserve = estimateLabelWidth(`${prefix} `);
    return {
      id: `${opts.idPrefix}${optionIndex}`,
      render_data: {
        label: `${prefix} ${buildButtonLabel(optionLine, reserve)}`,
        visited_label: visitedLabel,
        style: 1 as const,
      },
      action: {
        type: 1 as const,
        data: opts.buildActionData(optionIndex),
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        click_limit: 1,
      },
      group_id: opts.groupId,
    };
  });

  if (opts.includeOtherButton && def.isOther) {
    buttons.push({
      id: `${opts.idPrefix}other`,
      render_data: {
        label: '✍️ 其他',
        visited_label: '✍️ 其他',
        style: 0 as const,
      },
      action: {
        type: 2 as const,
        // 点击后输入框预填 "题号: "，用户续写后手动发送
        data: opts.otherData ?? '',
        enter: false,
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        unsupport_tips: '当前客户端版本不支持，请直接回复「题号: 答案」',
      },
      // 指令按钮不属于互斥选项组
    });
  }

  return {
    content: {
      rows: layoutButtonRows(buttons),
    },
  };
}

/**
 * 多题卡的选项按钮（兼容入口，输出与迁移前**逐字一致**）。
 */
export function buildMultiQuestionKeyboard(
  questionId: string,
  questionIndex: number,
  question: QuestionDef,
): InlineKeyboard {
  return buildQuestionOptionKeyboard(question, {
    questionId,
    buildActionData: (optionIndex) =>
      `qqbot:qm:${questionId}:${questionIndex}:${optionIndex}`,
    groupId: `question-${questionIndex}`,
    idPrefix: `q${questionIndex}_`,
    visitedLabel: '已选',
    includeOtherButton: true,
    otherData: `${questionIndex + 1}: `,
  });
}

// ============ 顺序发题（多题 c2c，PR2）============

/**
 * 顺序发题的按钮形态。
 *
 * - `collect`：**中间题**——选项是回调型（type=1），点选只把答案记进
 *   pending store，**不提交**（框架要求整单齐备，见 issue #93 根因 2）。
 * - `submit`：**最后一题**——选项是指令型（type=2, enter=true），data 里
 *   直接写**全量 keyed 答案文本**（`"1: 3\n2: 1"`），QQ 客户端以真实
 *   用户身份发出 ⇒ 框架 keyed 认领通道 resolve 掉挂起的 ask_user。
 *   这就是「去掉确认卡」的实现：**最后一题卡本身就是提交点**。
 */
export type SequentialCardMode = 'collect' | 'submit';

/** 顺序发题卡片的正文渲染参数 */
export interface SequentialCardOpts {
  /** 0-based 题序号 */
  index: number;
  /** 总题数 */
  total: number;
  /** 按钮形态（collect=中间题 / submit=最后一题） */
  mode: SequentialCardMode;
  /** 编辑态：本次是「✏️ 改一改」重发的题卡 */
  editing?: boolean;
  /** 提交态：前序已记录的答案（人话版），逐题展示 */
  collected?: ReadonlyArray<{ header: string; display: string }>;
  /**
   * 提交态：手打兜底的答案模板（keyed 文本，最后一题留占位）。
   *
   * 指令按钮需要客户端版本 8983+；老客户端上按钮不可用 ⇒ 给用户一段
   * 可直接复制的答案文本（含格式），保证「答不了」退化为「手打也能答」。
   */
  submitTemplate?: string;
}

/**
 * 顺序发题的卡片正文。
 *
 * 与 `formatQuestionCard(variant:'multi')` 的差异（**刻意不复用**）：
 * - 中间题**不给**「✍️ 其他」按钮（框架要求整单齐备，中间题的自由文本
 *   单独提交会被判「requires an answer」整单拒绝 ⇒ 中间题的自由作答
 *   统一留到最后一题）；
 * - 最后一题多一段「已记录」展示 + 「选完即提交」提示；
 * - 编辑态多一行「重新作答本题」。
 *
 * `formatMultiQuestionCard`（群聊旧路径）**逐字不动**。
 */
export function formatSequentialQuestionCard(
  def: QuestionDef,
  opts: SequentialCardOpts,
): string {
  const lines: string[] = [];
  lines.push(`**第 ${opts.index + 1}/${opts.total} 题 · ${def.header}**`);
  if (def.question.trim()) {
    lines.push('', def.question.trim());
  }
  for (const [optionIndex, optionLine] of def.options.entries()) {
    const label = stripRecommendedSuffix(splitOptionLabel(optionLine));
    const desc = splitOptionDescription(optionLine);
    lines.push('', `**${optionIndex + 1}.** ${label}${desc ? ` —— ${desc}` : ''}`);
  }
  lines.push(
    '',
    opts.mode === 'submit'
      ? '👇 点下方按钮作答（选完即提交全部答案）'
      : '👇 点下方按钮作答',
  );
  if (opts.editing) {
    lines.push('', '🔁 重新作答本题');
  }
  if (opts.mode === 'submit') {
    if (opts.collected?.length) {
      lines.push('', '**已记录**');
      for (const item of opts.collected) {
        lines.push(`**·** ${item.header}：${item.display}`);
      }
    }
    if (opts.submitTemplate) {
      lines.push('', '**或直接回复下面这段提交**', '', '```', opts.submitTemplate, '```');
    }
    const hints = ['想改前面的题？回到那张卡点「✏️ 改一改」'];
    if (def.isOther) hints.push('想自由作答？点「✍️ 其他」编辑后发送');
    lines.push('', `${hints.join('；')}。`);
  } else {
    lines.push('', '想改这一题？点「✏️ 改一改」重发本题。');
  }
  return lines.join('\n');
}

/**
 * 顺序发题：**中间题**键盘（收集态）。
 *
 * - 选项：回调型（type=1），data = `qqbot:qm:<qid>:<题号>:<选项号>`
 *   ——与旧路径的按钮契约**逐字一致**（`parseMultiQuestionButtonData`
 *   不用改），点选只记答案、不提交；
 * - 「✏️ 改一改」：回调型（type=1），data = `qqbot:qme:<qid>:<题号>`
 *   ——插件据此**重发该题卡**（回改入口）。刻意**不带** `click_limit`
 *   （可反复点），也**不进**选项的互斥组（`group_id` 留空），否则点它
 *   会把选项按钮一起置成「已选」。
 */
export function buildSequentialCollectKeyboard(
  questionId: string,
  questionIndex: number,
  question: QuestionDef,
): InlineKeyboard {
  const idPrefix = `q${questionIndex}_`;
  const optionButtons: KeyboardButton[] = question.options.map((optionLine, optionIndex) => {
    const prefix = OPTION_NUMBER_PREFIXES[optionIndex] ?? '';
    const reserve = estimateLabelWidth(`${prefix} `);
    return {
      id: `${idPrefix}${optionIndex}`,
      render_data: {
        label: `${prefix} ${buildButtonLabel(optionLine, reserve)}`,
        visited_label: '已选',
        style: 1 as const,
      },
      action: {
        type: 1 as const,
        data: `qqbot:qm:${questionId}:${questionIndex}:${optionIndex}`,
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        click_limit: 1,
      },
      group_id: `question-${questionIndex}`,
    };
  });

  const editButton: KeyboardButton = {
    id: `${idPrefix}edit`,
    render_data: {
      label: '✏️ 改一改',
      visited_label: '✏️ 改一改',
      style: 0 as const,
    },
    action: {
      type: 1 as const,
      data: `qqbot:qme:${questionId}:${questionIndex}`,
      permission: { type: KEYBOARD_PERMISSION_EVERYONE },
      unsupport_tips: '当前客户端版本不支持，请直接回复答案',
    },
  };

  const rows = layoutButtonRows(optionButtons);
  // 「✏️ 改一改」单独一行（不与选项挤在一行）
  rows.push({ buttons: [editButton] });
  return { content: { rows } };
}

/**
 * 顺序发题：**最后一题**键盘（提交态）。
 *
 * - 选项：**指令型**（type=2, enter=true），data = 全量 keyed 答案文本
 *   （前 N-1 题已答 + 本题该选项），点击即由客户端以**真实用户身份**
 *   发出 ⇒ 框架认领并 resolve（**不程序化提交、不合成入站消息**）；
 * - 「✏️ 改一改」：回调型（type=1），重发本题卡；
 * - 「✍️ 其他」：指令型（type=2, enter=false），预填
 *   `"<前 N-1 题>\n<N>: "` ——用户可在输入框里改任意一行（含最后一题
 *   的自由文本）后手动发送。
 *
 * @param answerPrefix 前 N-1 题的 keyed 答案文本（`"1: 3\n2: 1"`）；
 *   空串表示前序还没答（此时退化为只带本题号）。
 */
export function buildSequentialSubmitKeyboard(
  questionId: string,
  questionIndex: number,
  question: QuestionDef,
  answerPrefix: string,
): InlineKeyboard {
  const idPrefix = `q${questionIndex}_`;
  const line = (value: string): string =>
    answerPrefix ? `${answerPrefix}\n${questionIndex + 1}: ${value}` : `${questionIndex + 1}: ${value}`;

  const optionButtons: KeyboardButton[] = question.options.map((optionLine, optionIndex) => {
    const prefix = OPTION_NUMBER_PREFIXES[optionIndex] ?? '';
    const reserve = estimateLabelWidth(`${prefix} `);
    return {
      id: `${idPrefix}${optionIndex}`,
      render_data: {
        label: `${prefix} ${buildButtonLabel(optionLine, reserve)}`,
        visited_label: '已提交',
        style: 1 as const,
      },
      action: {
        type: 2 as const,
        data: line(String(optionIndex + 1)),
        enter: true,
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        unsupport_tips: '当前客户端版本不支持，请直接回复下方给出的答案文本',
      },
      group_id: `question-${questionIndex}`,
    };
  });

  const editButton: KeyboardButton = {
    id: `${idPrefix}edit`,
    render_data: {
      label: '✏️ 改一改',
      visited_label: '✏️ 改一改',
      style: 0 as const,
    },
    action: {
      type: 1 as const,
      data: `qqbot:qme:${questionId}:${questionIndex}`,
      permission: { type: KEYBOARD_PERMISSION_EVERYONE },
      unsupport_tips: '当前客户端版本不支持，请直接回复答案',
    },
  };

  const buttons = [...optionButtons];
  if (question.isOther) {
    buttons.push({
      id: `${idPrefix}other`,
      render_data: {
        label: '✍️ 其他',
        visited_label: '✍️ 其他',
        style: 0 as const,
      },
      action: {
        type: 2 as const,
        data: line(''),
        enter: false,
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
        unsupport_tips: '当前客户端版本不支持，请直接回复「题号: 答案」',
      },
    });
  }

  const rows = layoutButtonRows(buttons);
  rows.push({ buttons: [editButton] });
  return { content: { rows } };
}

// ============ 单题文本反解 ============

/** 框架选项行：`<序号>. <label>[ - <描述>]` */
const OPTION_LINE_PATTERN = /^(\d+)\.\s(.*)$/;

/** 框架的「Other: reply with your own answer.」声明行前缀 */
const OTHER_LINE_PREFIX = 'Other:';

/** 框架末尾引导行前缀（"Reply with the number…" / "Reply by number…"） */
const REPLY_GUIDANCE_PREFIX = 'Reply ';

/**
 * 从框架的**单题**投递文本反解题目结构。
 *
 * 框架单题文本形如（`buildAgentHarnessQuestionPromptPayload` 实测）：
 * ```
 * Question for you:
 *
 * <header>
 * <题干>
 * 1. <label> - <描述>
 * 2. <label2>
 * Other: reply with your own answer.
 *
 * Reply with the number, the option text, or your own answer.
 * ```
 *
 * **锚点是 `optionValues` 里的精确 label**（来自 `channelData.askUser.optionValues`），
 * 不用「数到第几行是选项」这种结构推断——比多题解析器稳得多。
 *
 * 任何不确定（结构不符 / 选项行缺失 / 尾部出现未知内容 / label 内含
 * " - " 导致无法按首个分隔符还原）一律返回 `null`，由调用方回退到
 * 「框架原文 + 旧键盘」（= 改造前形态）。
 */
export function parseSingleQuestionPrompt(
  text: string,
  optionValues: readonly string[],
): QuestionDef | null {
  if (!text || optionValues.length < 2) return null;

  const lines = text.split(/\r?\n/);
  let index = 0;

  // 跳过开头空行
  while (index < lines.length && !lines[index]!.trim()) index++;
  if (index >= lines.length) return null;
  // 跳过 intro 行（框架的 "Question for you:"）
  index++;
  while (index < lines.length && !lines[index]!.trim()) index++;
  if (index >= lines.length) return null;

  const header = lines[index]!.trim();
  if (!header) return null;
  index++;

  // 阶段 1：收集题干，直到命中第一个选项行
  const questionLines: string[] = [];
  while (index < lines.length) {
    const line = lines[index]!;
    if (isExpectedOptionLine(line, 0, optionValues)) break;
    questionLines.push(line);
    index++;
  }
  const question = questionLines.join('\n').trim();
  if (!question) return null;

  // 阶段 2：逐个取选项（label 用 optionValues 的精确值，描述取行内余量）
  const options: string[] = [];
  for (let optionIndex = 0; optionIndex < optionValues.length; optionIndex++) {
    if (index >= lines.length) return null;
    const line = lines[index]!;
    const match = line.match(OPTION_LINE_PATTERN);
    const label = optionValues[optionIndex]!;
    if (
      !match ||
      Number(match[1]) !== optionIndex + 1 ||
      !match[2]!.startsWith(label)
    ) {
      return null;
    }
    const rest = match[2]!.slice(label.length).trim();
    const description = rest.startsWith('-') ? rest.slice(1).trim() : rest;
    const optionLine = description ? `${label} - ${description}` : label;
    // label 内含 " - " 时渲染层无法按首个分隔符还原（会截错标签）→ 放弃解析
    if (splitOptionLabel(optionLine) !== label) return null;
    options.push(optionLine);
    index++;
  }

  // 阶段 3：尾部只允许「Other:」声明行与框架引导行，出现别的内容即放弃
  let isOther = false;
  for (; index < lines.length; index++) {
    const tail = lines[index]!.trim();
    if (!tail) continue;
    if (tail.startsWith(OTHER_LINE_PREFIX)) {
      isOther = true;
      continue;
    }
    if (tail.startsWith(REPLY_GUIDANCE_PREFIX)) continue;
    return null;
  }

  return { header, question, options, isOther };
}

/**
 * 该行是否是「序号 = optionIndex+1 且以对应 label 开头」的选项行。
 */
function isExpectedOptionLine(
  line: string,
  optionIndex: number,
  optionValues: readonly string[],
): boolean {
  const label = optionValues[optionIndex];
  if (label === undefined) return false;
  const match = line.match(OPTION_LINE_PATTERN);
  if (!match) return false;
  return Number(match[1]) === optionIndex + 1 && match[2]!.startsWith(label);
}
