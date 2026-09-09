/**
 * ask_user 按钮辅助函数
 *
 * 与 approval-helpers.ts 模式一致：
 * - buildQuestionKeyboard: 构建 inline keyboard（单问题）
 * - buildMultiQuestionKeyboard: 构建多问题场景单题的 inline keyboard
 * - parseQuestionButtonData / parseMultiQuestionButtonData: 解析 INTERACTION_CREATE 的 button_data
 * - isAskUserPayload / isNonSingleAskUserPayload: 判断 payload 是否为 ask_user（单/非单问题）
 * - parseMultiQuestionPrompt: 从多问题投递文本反解题目结构
 * - registerPendingMultiQuestion 等: 多问题答案暂存 store
 * - buildMultiQuestionConfirmKeyboard 等: 集齐后发"确认卡"——指令按钮
 *   (type=2, enter=true) 携带完整答案文本，由客户端以真实用户消息发出，
 *   走框架原生的 keyed 文本认领通道（不程序化提交，不合成入站消息）
 */

import type { InlineKeyboard, KeyboardButton } from '../types.js';

// ============ Constants ============

const QUESTION_CALLBACK_PREFIX = 'qqbot:q:';
const MULTI_QUESTION_CALLBACK_PREFIX = 'qqbot:qm:';

/** questionId 格式: ask_<32位hex> */
const QUESTION_ID_PATTERN = /^ask_[a-f0-9]{32}$/;

/** gateway 协议上限：单次 ask_user 最多 3 个问题，每题最多 4 个选项 */
const MAX_MULTI_QUESTIONS = 3;
const MAX_OPTIONS_PER_QUESTION = 4;

/** gateway 默认问题超时 15min，这里留 10min 余量兜住投递延迟 */
const DEFAULT_MULTI_QUESTION_TTL_MS = 25 * 60 * 1000;

// ============ Types ============

export interface ParsedQuestionAction {
  questionId: string;
  optionIndex: number;
}

/**
 * ask_user 多问题场景中从投递文本解析出的单题结构。
 * 框架的多问题 payload 只有 questionId + 格式化文本（无结构化选项数据），
 * 题目结构需从文本反解。
 */
export interface MultiQuestionDef {
  header: string;
  question: string;
  options: string[];
  /** 题目声明了 "Other: reply with your own answer."（允许自由文本作答） */
  isOther?: boolean;
}

export interface ParsedMultiQuestionAction {
  questionId: string;
  questionIndex: number;
  optionIndex: number;
}

/** 一次多问题整单的答案（题号 -> 按钮选项序号或自由文本） */
export type MultiQuestionAnswer = { optionIndex: number } | { text: string };

export interface QuestionGatewayRuntime {
  resolveOption: (params: {
    cfg: unknown;
    questionId: string;
    optionIndex: number;
    senderId?: string;
    gatewayUrl?: string;
    clientDisplayName?: string;
  }) => Promise<{ status: string }>;
}

let questionRuntimePromise: Promise<QuestionGatewayRuntime> | undefined;

/**
 * question gateway runtime（openclaw/plugin-sdk/question-gateway-runtime，
 * 2026.8.1+ 稳定导出，peer 已要求 >=2026.9.2）。
 */
export function getQuestionGatewayRuntime(): Promise<QuestionGatewayRuntime> {
  questionRuntimePromise ??= import('openclaw/plugin-sdk/question-gateway-runtime')
    .then((mod) => mod.questionGatewayRuntime as QuestionGatewayRuntime);
  return questionRuntimePromise;
}

// ============ Payload Detection ============

/**
 * 判断 DeliverPayload 是否为 ask_user 单问题单选场景。
 * 要求：有 channelData.askUser.questionId，且 optionValues 长度 2-4。
 */
export function isAskUserPayload(payload: {
  channelData?: { askUser?: { questionId?: unknown; optionValues?: unknown } };
}): payload is { channelData: { askUser: { questionId: string; optionValues: string[] } } } {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== 'object') return false;
  const { questionId, optionValues } = askUser as { questionId?: unknown; optionValues?: unknown };
  return (
    typeof questionId === 'string' &&
    QUESTION_ID_PATTERN.test(questionId) &&
    Array.isArray(optionValues) &&
    optionValues.length >= 2 &&
    optionValues.length <= 4 &&
    optionValues.every((v: unknown) => typeof v === 'string')
  );
}

/**
 * 判断 DeliverPayload 是否为 ask_user「非单问题」场景。
 *
 * 框架只在恰好 1 个问题（且单选、非 secret、2-4 个唯一选项）时附带
 * optionValues；其余情况 payload 只有 questionId + 纯文本。多问题结构
 * 需要调用 parseMultiQuestionPrompt 从文本反解。
 */
export function isNonSingleAskUserPayload(payload: {
  channelData?: { askUser?: { questionId?: unknown; optionValues?: unknown } };
}): payload is { channelData: { askUser: { questionId: string } } } {
  const askUser = payload.channelData?.askUser;
  if (!askUser || typeof askUser !== 'object') return false;
  const { questionId, optionValues } = askUser as { questionId?: unknown; optionValues?: unknown };
  if (typeof questionId !== 'string' || !QUESTION_ID_PATTERN.test(questionId)) return false;
  // 单问题场景由 isAskUserPayload 优先认领
  return !Array.isArray(optionValues);
}

// ============ 多问题投递文本解析 ============

const NUMBERED_LINE_PATTERN = /^(\d+)\.\s+(.+)$/;

/**
 * 从 ask_user 多问题投递文本中解析题目结构。
 *
 * 文本由框架 formatAgentHarnessUserInputPrompt 生成（多问题格式）：
 * ```
 * [intro]
 * <空行>
 * 1. <header>
 * <题干>
 * 1. <label> - <description>
 * ...
 * <空行>
 * 2. <header>
 * ...
 * <空行>
 * Reply by number or question id...
 * ```
 *
 * 判别依赖生成器的两个不变量：
 * - header 行总是紧跟空行之后（每个 question 前都有空行）
 * - 选项行紧跟题干/上一选项（块内无空行）
 *
 * 解析失败返回 null（secret 警告行 / isOther 行 / 结构异常都会失败），
 * 调用方回退纯文本展示。multiSelect 题无法从文本区分，按钮单选属可接受降级。
 */
export function parseMultiQuestionPrompt(text: string): MultiQuestionDef[] | null {
  const lines = text.split(/\r?\n/);

  // 定位第一个 "1. " header（其后必须紧跟空行或行首，排除 intro 干扰）
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(NUMBERED_LINE_PATTERN);
    if (m && Number(m[1]) === 1 && (i === 0 || !lines[i - 1]!.trim())) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  const questions: MultiQuestionDef[] = [];
  let header: string | undefined;
  let questionText: string | undefined;
  let options: string[] = [];
  let isOther = false;
  let afterBlank = true; // start 位置的 header 已由扫描保证满足"空行在前"

  const finishQuestion = (): boolean => {
    if (header === undefined || questionText === undefined) return false;
    if (options.length < 2 || options.length > MAX_OPTIONS_PER_QUESTION) return false;
    questions.push({ header, question: questionText, options, ...(isOther ? { isOther: true } : {}) });
    header = undefined;
    questionText = undefined;
    options = [];
    isOther = false;
    return true;
  };

  for (let i = start; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (!trimmed) {
      afterBlank = true;
      continue;
    }
    const m = trimmed.match(NUMBERED_LINE_PATTERN);
    const num = m ? Number(m[1]) : NaN;

    if (header === undefined) {
      // 期待下一题 header：序号连续且前面是空行
      if (!m || num !== questions.length + 1 || !afterBlank) return null;
      header = m[2];
      afterBlank = false;
      continue;
    }
    if (questionText === undefined) {
      // 期待题干：编号行说明结构异常
      if (m) return null;
      questionText = trimmed;
      afterBlank = false;
      continue;
    }
    // 选项后出现 isOther 声明行（框架默认文案 "Other: reply with your own answer."）
    if (trimmed.startsWith('Other:') && options.length >= 2) {
      isOther = true;
      afterBlank = false;
      continue;
    }
    // 期待选项 / 下一题 header / 终止（引导语等尾部内容）
    if (m && num === 1 && options.length === 0 && !afterBlank) {
      options.push(m[2]);
      afterBlank = false;
      continue;
    }
    if (
      m &&
      num === options.length + 1 &&
      options.length > 0 &&
      options.length < MAX_OPTIONS_PER_QUESTION &&
      !afterBlank
    ) {
      options.push(m[2]);
      afterBlank = false;
      continue;
    }
    // 当前题尚未入列，下一题 header 的序号 = 已入列数 + 当前题 + 1
    if (m && num === questions.length + 2 && afterBlank) {
      if (!finishQuestion()) return null;
      header = m[2];
      afterBlank = false;
      continue;
    }
    // 其余内容：收尾并停止（正常情况是尾部引导语）
    if (!finishQuestion()) return null;
    break;
  }
  if (header !== undefined || questionText !== undefined || options.length > 0) {
    // 循环耗尽时仍有未收尾的题目
    if (!finishQuestion()) return null;
  }
  if (questions.length < 2 || questions.length > MAX_MULTI_QUESTIONS) return null;
  return questions;
}

// ============ Keyboard Builder ============

/**
 * 为 ask_user 构建 inline keyboard。
 *
 * 与审批按钮结构完全一致：
 * - action.type=1 (回调型)
 * - permission.type=2 (所有人可点)
 * - click_limit=1 (每人一次)
 * - group_id="question" (互斥)
 *
 * button_data 格式: `qqbot:q:<questionId>:<optionIndex>`
 */
export function buildQuestionKeyboard(
  questionId: string,
  optionLabels: string[],
): InlineKeyboard {
  const buttons: KeyboardButton[] = optionLabels.map((label, index) => ({
    id: `q${index}`,
    render_data: {
      label,
      visited_label: '已回答',
      style: 1 as const,
    },
    action: {
      type: 1 as const,
      data: `${QUESTION_CALLBACK_PREFIX}${questionId}:${index}`,
      permission: { type: 2 as const },
      click_limit: 1,
    },
    group_id: 'question',
  }));

  return {
    content: {
      rows: [{ buttons }],
    },
  };
}

/** 选项按钮的序号前缀，与正文里的加粗序号 1./2./3./4. 一一对应 */
const OPTION_NUMBER_PREFIXES = ['①', '②', '③', '④'] as const;

/**
 * 为 ask_user 多问题场景构建第 questionIndex 题的 inline keyboard。
 *
 * - 选项按钮：action.type=1（回调），button_data `qqbot:qm:<id>:<题号>:<选项号>`，
 *   group_id 按题隔离（`question-<i>`）保证同题互斥、跨题不互斥；
 *   标签带 ①②③ 序号前缀（截断时也能与正文选项对上号）
 * - isOther 题追加「✍️ 其他」指令按钮（action.type=2）：点击后客户端在
 *   输入框预填 `<题号>: `，用户续写自由答案后发送，天然就是 keyed 答案格式
 * - 按钮标签超过宽度预算时自动改为每行 2 个，避免文字显示不全
 */
export function buildMultiQuestionKeyboard(
  questionId: string,
  questionIndex: number,
  question: MultiQuestionDef,
): InlineKeyboard {
  const buttons: KeyboardButton[] = question.options.map((optionLine, optionIndex) => {
    const prefix = OPTION_NUMBER_PREFIXES[optionIndex] ?? '';
    // 前缀 + 空格的显示宽度（全角序号 2 + 空格 1）
    const reserve = estimateLabelWidth(`${prefix} `);
    return {
      id: `q${questionIndex}_${optionIndex}`,
      render_data: {
        label: `${prefix} ${buildButtonLabel(optionLine, reserve)}`,
        visited_label: '已选',
        style: 1 as const,
      },
      action: {
        type: 1 as const,
        data: `${MULTI_QUESTION_CALLBACK_PREFIX}${questionId}:${questionIndex}:${optionIndex}`,
        permission: { type: 2 as const },
        click_limit: 1,
      },
      group_id: `question-${questionIndex}`,
    };
  });

  if (question.isOther) {
    buttons.push({
      id: `q${questionIndex}_other`,
      render_data: {
        label: '✍️ 其他',
        visited_label: '✍️ 其他',
        style: 0 as const,
      },
      action: {
        type: 2 as const,
        // 点击后输入框预填 "题号: "，用户续写后手动发送
        data: `${questionIndex + 1}: `,
        enter: false,
        permission: { type: 2 as const },
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

/** 按钮标签安全宽度（约 12 个汉字），超出截断加省略号 */
const MAX_BUTTON_LABEL_WIDTH = 24;
/** 一行放满时允许的最大标签宽度，超过改为每行 2 个 */
const SINGLE_ROW_MAX_LABEL_WIDTH = 20;

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

/** 剥掉框架渲染在选项标签尾部的 "(Recommended)" 标记 */
export function stripRecommendedSuffix(label: string): string {
  return label.replace(/\s*\(\s*recommended\s*\)\s*$/i, '').trim();
}

/**
 * 格式化多问题卡片中单题的文本部分（QQ 客户端原生 Markdown 渲染）。
 * 完整选项（含描述）放在正文里，按钮只放截断后的短标签。
 * 正文选项用加粗序号，与按钮上的 ①②③ 前缀一一对应。
 */
export function formatMultiQuestionCard(
  question: MultiQuestionDef,
  questionIndex: number,
  total: number,
): string {
  const lines = [`**第 ${questionIndex + 1}/${total} 题 · ${question.header}**`];
  if (question.question.trim()) {
    lines.push('', question.question.trim());
  }
  for (const [optionIndex, optionLine] of question.options.entries()) {
    const label = stripRecommendedSuffix(splitOptionLabel(optionLine));
    const desc = splitOptionDescription(optionLine);
    lines.push('', `**${optionIndex + 1}.** ${label}${desc ? ` —— ${desc}` : ''}`);
  }
  lines.push('', '👇 点下方按钮作答');
  if (question.isOther) {
    lines.push('', `选项不合适？点「✍️ 其他」后输入，或直接回复 "${questionIndex + 1}: 你的答案"`);
  }
  return lines.join('\n');
}

// ============ Button Data Parser ============

/**
 * 解析 INTERACTION_CREATE 事件中的 button_data。
 *
 * 格式: `qqbot:q:<questionId>:<optionIndex>`
 * 返回 null 表示不是 question 按钮。
 */
export function parseQuestionButtonData(buttonData: string): ParsedQuestionAction | null {
  if (!buttonData.startsWith(QUESTION_CALLBACK_PREFIX)) return null;

  const payload = buttonData.slice(QUESTION_CALLBACK_PREFIX.length);
  const sepIndex = payload.lastIndexOf(':');
  if (sepIndex <= 0) return null;

  const questionId = payload.slice(0, sepIndex);
  const indexStr = payload.slice(sepIndex + 1);

  if (!QUESTION_ID_PATTERN.test(questionId)) return null;
  if (!indexStr) return null; // 防止 'qqbot:q:ask_xxx:' 被解析为 index 0

  const optionIndex = Number(indexStr);
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex > 3) return null;

  return { questionId, optionIndex };
}

/**
 * 解析多问题按钮的 button_data。
 *
 * 格式: `qqbot:qm:<questionId>:<questionIndex>:<optionIndex>`
 * 返回 null 表示不是多问题按钮。
 */
export function parseMultiQuestionButtonData(buttonData: string): ParsedMultiQuestionAction | null {
  if (!buttonData.startsWith(MULTI_QUESTION_CALLBACK_PREFIX)) return null;

  const payload = buttonData.slice(MULTI_QUESTION_CALLBACK_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 3) return null;

  const [questionId, questionIndexStr, optionIndexStr] = parts;
  if (!QUESTION_ID_PATTERN.test(questionId)) return null;
  if (!questionIndexStr || !optionIndexStr) return null;

  const questionIndex = Number(questionIndexStr);
  const optionIndex = Number(optionIndexStr);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= MAX_MULTI_QUESTIONS) {
    return null;
  }
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= MAX_OPTIONS_PER_QUESTION) {
    return null;
  }

  return { questionId, questionIndex, optionIndex };
}

// ============ 多问题答案暂存 Store ============

interface PendingMultiQuestion {
  scope: 'c2c' | 'group';
  targetId: string;
  questions: MultiQuestionDef[];
  /** questionIndex -> 答案（同题重复作答，最后一次为准） */
  answers: Map<number, MultiQuestionAnswer>;
  terminal: boolean;
  /** 正在合成入站提交（防并发重复提交） */
  resolving: boolean;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

const pendingMultiQuestions = new Map<string, PendingMultiQuestion>();
/** `${scope}:${targetId}` -> questionId，供入站文字答案按会话定位 */
const pendingByConversation = new Map<string, string>();

function conversationKey(scope: 'c2c' | 'group', targetId: string): string {
  return `${scope}:${targetId}`;
}

/**
 * 登记一次多问题 ask_user 投递，供按钮回调 / 入站文字按题缓冲答案。
 * 必须在发送按钮消息之前调用，避免「先点后登记」竞态。
 */
export function registerPendingMultiQuestion(
  questionId: string,
  scope: 'c2c' | 'group',
  targetId: string,
  questions: MultiQuestionDef[],
  ttlMs: number = DEFAULT_MULTI_QUESTION_TTL_MS,
): void {
  const existing = pendingMultiQuestions.get(questionId);
  if (existing) clearTimeout(existing.cleanupTimer);

  const entry: PendingMultiQuestion = {
    scope,
    targetId,
    questions,
    answers: new Map(),
    terminal: false,
    resolving: false,
    expiresAtMs: Date.now() + ttlMs,
    cleanupTimer: setTimeout(() => {
      if (pendingMultiQuestions.get(questionId) === entry) {
        pendingMultiQuestions.delete(questionId);
      }
      if (pendingByConversation.get(conversationKey(scope, targetId)) === questionId) {
        pendingByConversation.delete(conversationKey(scope, targetId));
      }
    }, ttlMs),
  };
  entry.cleanupTimer.unref?.();
  pendingMultiQuestions.set(questionId, entry);
  pendingByConversation.set(conversationKey(scope, targetId), questionId);
}

/** 按会话查找进行中的多问题单（终态/提交中/已过期不算） */
export function findPendingMultiQuestionByConversation(
  scope: 'c2c' | 'group',
  targetId: string,
): { questionId: string } | undefined {
  const questionId = pendingByConversation.get(conversationKey(scope, targetId));
  if (!questionId) return undefined;
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.terminal || entry.resolving || entry.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return { questionId };
}

export type MultiQuestionTapResult =
  | { status: 'unknown' }
  | { status: 'terminal' }
  | { status: 'resolving' }
  | { status: 'nomatch' }
  | {
      status: 'buffered';
      total: number;
      answeredCount: number;
      /** 尚未作答的题目 */
      pendingQuestions: MultiQuestionDef[];
    }
  | {
      status: 'complete';
      total: number;
      /**
       * 题号 -> 答案 的快照（complete 时刻的拷贝）。
       * 最终提交直接走 questionGatewayRuntime.resolveAnswers 整单 resolve，
       * 不再合成入站文本——合成消息会被框架当成 steering 注入挂起的 run，
       * 永远到不了 pending ask_user 的 claim（生产 2026-08-24 事故）。
       */
      answers: ReadonlyMap<number, MultiQuestionAnswer>;
    };

function bufferedOrComplete(entry: PendingMultiQuestion): MultiQuestionTapResult {
  if (entry.answers.size < entry.questions.length) {
    const pendingQuestions = entry.questions.filter((_, index) => !entry.answers.has(index));
    return {
      status: 'buffered',
      total: entry.questions.length,
      answeredCount: entry.answers.size,
      pendingQuestions,
    };
  }
  entry.resolving = true;
  return {
    status: 'complete',
    total: entry.questions.length,
    answers: new Map(entry.answers),
  };
}

/**
 * 记录一次多问题按钮点选。
 * - 未登记/已过期 -> unknown
 * - 已终态（已提交/已在框架侧结束）-> terminal
 * - 正在提交中 -> resolving
 * - 还有题目未作答 -> buffered（附带剩余题目）
 * - 全部作答 -> complete（同步置 resolving，调用方拿到回复文本后走入站派发）
 */
export function recordMultiQuestionTap(
  questionId: string,
  questionIndex: number,
  optionIndex: number,
): MultiQuestionTapResult {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry) return { status: 'unknown' };
  if (entry.expiresAtMs <= Date.now()) {
    if (pendingMultiQuestions.get(questionId) === entry) {
      pendingMultiQuestions.delete(questionId);
    }
    clearTimeout(entry.cleanupTimer);
    return { status: 'unknown' };
  }
  if (entry.terminal) return { status: 'terminal' };
  if (entry.resolving) return { status: 'resolving' };

  const question = entry.questions[questionIndex];
  if (!question) return { status: 'unknown' };
  if (typeof question.options[optionIndex] !== 'string') return { status: 'unknown' };

  entry.answers.set(questionIndex, { optionIndex });
  return bufferedOrComplete(entry);
}

/** 入站派发已受理（或问题已在框架侧结束）后标记终态，后续点选按 terminal 处理 */
export function markMultiQuestionResolved(questionId: string): void {
  const entry = pendingMultiQuestions.get(questionId);
  if (entry) {
    entry.terminal = true;
    entry.resolving = false;
  }
}

/**
 * 复位 complete 时置上的 resolving 锁（确认卡已发出或发送失败后调用），
 * 允许用户继续点选修改答案并重新拿到确认卡。
 */
export function markMultiQuestionResolveFailed(questionId: string): void {
  const entry = pendingMultiQuestions.get(questionId);
  if (entry) {
    entry.resolving = false;
  }
}

/** 读取登记的题目定义（确认卡正文按题展示已选项） */
export function getPendingMultiQuestions(questionId: string): MultiQuestionDef[] | null {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.expiresAtMs <= Date.now()) return null;
  return entry.questions;
}

/**
 * 合成整单答案文本："1: 3\n2: 1"（数字选项走框架原生 keyed 文本解析，
 * 由客户端以真实用户消息发出后，框架认领并 resolve 挂起的 ask_user）。
 */
export function buildMultiQuestionAnswerText(
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
): string {
  return [...answers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([questionIdx, answer]) =>
      `${questionIdx + 1}: ${'optionIndex' in answer ? answer.optionIndex + 1 : answer.text}`)
    .join('\n');
}

/** 确认卡正文：按题展示人话版的已选内容 */
export function formatMultiQuestionConfirmCard(
  questions: readonly MultiQuestionDef[],
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
): string {
  const lines = ['**✅ 答案确认**'];
  for (const [index, question] of questions.entries()) {
    const answer = answers.get(index);
    const display = !answer
      ? '（未作答）'
      : 'optionIndex' in answer
        ? stripRecommendedSuffix(splitOptionLabel(question.options[answer.optionIndex] ?? ''))
        : answer.text;
    lines.push('', `**${index + 1}.** ${question.header}：${display}`);
  }
  lines.push('', '点「✅ 提交」自动发送；想改动就点「✏️ 改一改」编辑后发送。');
  return lines.join('\n');
}

/**
 * 确认卡键盘：两个指令按钮（action.type=2）携带完整答案文本。
 * - 提交：enter=true，客户端点击后自动以用户身份发出（真实消息，框架可认领）
 * - 改一改：enter=false，答案填入输入框，用户编辑后手动发送
 */
export function buildMultiQuestionConfirmKeyboard(answerText: string): InlineKeyboard {
  const buttons: KeyboardButton[] = [
    {
      id: 'confirm_submit',
      render_data: {
        label: '✅ 提交',
        visited_label: '已提交',
        style: 1 as const,
      },
      action: {
        type: 2 as const,
        data: answerText,
        enter: true,
        permission: { type: 2 as const },
        unsupport_tips: '当前客户端不支持，请手动回复上方答案文本',
      },
    },
    {
      id: 'confirm_edit',
      render_data: {
        label: '✏️ 改一改',
        visited_label: '✏️ 改一改',
        style: 0 as const,
      },
      action: {
        type: 2 as const,
        data: answerText,
        enter: false,
        permission: { type: 2 as const },
        unsupport_tips: '当前客户端不支持，请手动回复上方答案文本',
      },
    },
  ];
  return {
    content: {
      rows: [{ buttons }],
    },
  };
}
