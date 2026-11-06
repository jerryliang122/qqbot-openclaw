/**
 * ask_user 按钮辅助函数
 *
 * 与 approval-helpers.ts 模式一致：
 * - buildQuestionKeyboard: 构建 inline keyboard（单问题，**解析失败时的回退形态**）
 * - parseQuestionButtonData / parseMultiQuestionButtonData: 解析 INTERACTION_CREATE 的 button_data
 * - isAskUserPayload / isNonSingleAskUserPayload: 判断 payload 是否为 ask_user（单/非单问题）
 * - parseMultiQuestionPrompt: 从多问题投递文本反解题目结构
 * - registerPendingMultiQuestion 等: 多问题答案暂存 store
 * - registerPendingSingleQuestion 等: 单问题 pending 登记（c2c 旁路用）
 * - buildMultiQuestionConfirmKeyboard 等: 集齐后发"确认卡"——指令按钮
 *   (type=2, enter=true) 携带完整答案文本，由客户端以真实用户消息发出，
 *   走框架原生的 keyed 文本认领通道（不程序化提交，不合成入站消息）
 *
 * **卡片渲染已迁到 `question-card.ts`**（单题 / 多题共用渲染层，PR1）：
 * 本文件保留 `buildQuestionKeyboard` 作为**单题文本反解失败时的回退形态**
 * （= 改造前：框架原文 + 旧键盘）；其余渲染原语
 * （`formatMultiQuestionCard` / `buildMultiQuestionKeyboard` /
 * `splitOptionLabel` / `buildButtonLabel` …）从 `./question-card.js` 再导出，
 * 既有 import 路径与测试保持可用。
 */

import type { InlineKeyboard, KeyboardButton } from '../types.js';
import { KEYBOARD_PERMISSION_EVERYONE } from '../types.js';
import type { QuestionDef } from './question-card.js';
// 确认卡正文按题展示已选内容时仍要用到这两个原语（再导出不产生本地绑定）
import { splitOptionLabel, stripRecommendedSuffix } from './question-card.js';

/**
 * 卡片渲染层（单题 / 多题共用）。
 *
 * 迁移说明：`question-card.ts` **不 import** 本文件（避免与这里的再导出
 * 形成循环依赖），依赖方向是单向的 `question-helpers → question-card`。
 */
export type { QuestionDef } from './question-card.js';
export {
  buildButtonLabel,
  buildMultiQuestionKeyboard,
  buildQuestionOptionKeyboard,
  estimateLabelWidth,
  formatMultiQuestionCard,
  formatQuestionCard,
  parseSingleQuestionPrompt,
  splitOptionLabel,
  stripRecommendedSuffix,
} from './question-card.js';

// ============ Constants ============

const QUESTION_CALLBACK_PREFIX = 'qqbot:q:';
const MULTI_QUESTION_CALLBACK_PREFIX = 'qqbot:qm:';
/** 多题「✏️ 改一改」回调前缀（PR2）：`qqbot:qme:<questionId>:<题号>` */
const MULTI_QUESTION_EDIT_PREFIX = 'qqbot:qme:';

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
 * ask_user 一道题的结构（单题 / 多题共用）。
 *
 * 框架的多问题 payload 只有 questionId + 格式化文本（无结构化选项数据），
 * 题目结构需从文本反解；单题则由 `parseSingleQuestionPrompt` 反解
 * （锚点是 `channelData.askUser.optionValues` 里的精确 label）。
 *
 * 定义已迁到 `question-card.ts`（渲染层），此处保留别名兼容既有引用。
 */
export type MultiQuestionDef = QuestionDef;

export interface ParsedMultiQuestionAction {
  questionId: string;
  questionIndex: number;
  optionIndex: number;
}

/** 多题「✏️ 改一改」回调（PR2） */
export interface ParsedMultiQuestionEditAction {
  questionId: string;
  questionIndex: number;
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
 * 2026.8.1+ 稳定导出，peer 已要求 >=2026.10.5）。
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
      permission: { type: KEYBOARD_PERMISSION_EVERYONE },
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

// ── 卡片渲染原语已迁至 `question-card.ts`（PR1）────────────────────
// `formatMultiQuestionCard` / `buildMultiQuestionKeyboard` /
// `splitOptionLabel` / `splitOptionDescription` / `estimateLabelWidth` /
// `buildButtonLabel` / `stripRecommendedSuffix` / `layoutButtonRows` /
// `OPTION_NUMBER_PREFIXES` 现在住在渲染层（单题与多题共用），
// 本文件顶部已从 `./question-card.js` 再导出，既有 import 路径不变。
// 多题的渲染输出**逐字未变**（既有回归用例即迁移安全的硬证据）。

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

/**
 * 解析多题「✏️ 改一改」按钮的 button_data（PR2）。
 *
 * 格式: `qqbot:qme:<questionId>:<questionIndex>`
 * 返回 null 表示不是改一改按钮。
 */
export function parseMultiQuestionEditData(buttonData: string): ParsedMultiQuestionEditAction | null {
  if (!buttonData.startsWith(MULTI_QUESTION_EDIT_PREFIX)) return null;

  const payload = buttonData.slice(MULTI_QUESTION_EDIT_PREFIX.length);
  const parts = payload.split(':');
  if (parts.length !== 2) return null;

  const [questionId, questionIndexStr] = parts;
  if (!QUESTION_ID_PATTERN.test(questionId)) return null;
  if (!questionIndexStr) return null;

  const questionIndex = Number(questionIndexStr);
  if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= MAX_MULTI_QUESTIONS) {
    return null;
  }

  return { questionId, questionIndex };
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
  /**
   * 多题流程形态（PR2）。
   *
   * - `sequential`：**c2c 单聊**新形态——一次只发一题，逐题收集，
   *   最后一题卡直接提交全量 keyed 文本（无确认卡）；
   * - `legacy`：群聊旧形态——所有题一次性发出 + 集齐后发确认卡。
   *
   * 范围锁定见 issue #93 第十节：群里默认拿不到 `ask_user` 工具，
   * 多题在群里基本不会发生，故群路径保持原样（零回归）。
   */
  mode: 'sequential' | 'legacy';
  /**
   * 顺序发题的**流程位置**（sequential 形态）：当前发出去的那张卡对应的
   * 题号。`0` = 第 1 题。
   */
  cursor: number;
  /**
   * 正在回改的题号（sequential 形态）：用户点了「✏️ 改一改」后置位，
   * 下一次作答落在该题上（覆盖旧答案），答完回到 `cursor`。
   */
  editingIndex?: number;
  /**
   * 本轮 inbound 消息的 msg_id（**显式锚点**）——多题的续卡 / 确认卡 /
   * 状态回执复用它走被动回复。
   *
   * 取值只来自 dispatch 当轮的 `envelope.messageId`（**不是** msgid-cache
   * 池化选取：挂错引用等于把回复挂到错误的消息上，见 AGENTS.md 红线）。
   * 锚点过期（群聊 5min / c2c 60min）或被平台判死时，发送侧降级为主动。
   */
  anchorMsgId?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

const pendingMultiQuestions = new Map<string, PendingMultiQuestion>();
/**
 * `${accountId}:${scope}:${targetId}` -> questionId，供入站文字答案按会话定位。
 * accountId 必须入键：QQ openid 是 per-account 的（bot A 与 bot B 的同字符串
 * targetId 指向不同用户），不带账号维度会让 A 账号的 pending 误命中 B 账号
 * 同 targetId 的会话（2026-10-14 Sourcery 评审发现，防抖 keyed 旁路受此影响）。
 */
const pendingByConversation = new Map<string, string>();

function conversationKey(accountId: string, scope: 'c2c' | 'group', targetId: string): string {
  return `${accountId}:${scope}:${targetId}`;
}

/**
 * 登记一次多问题 ask_user 投递，供按钮回调 / 入站文字按题缓冲答案。
 * 必须在发送按钮消息之前调用，避免「先点后登记」竞态。
 *
 * @param anchorMsgId 本轮 inbound 的 msg_id（显式锚点）——续卡 / 确认卡 /
 *   状态回执据此走被动回复；缺省则后续消息一律主动发送。
 * @param mode 多题流程形态（PR2）：`sequential` = c2c 顺序发题（逐题收集、
 *   最后一题直接提交）；`legacy` = 群聊旧形态（全部发出 + 确认卡）。
 */
export function registerPendingMultiQuestion(
  accountId: string,
  questionId: string,
  scope: 'c2c' | 'group',
  targetId: string,
  questions: MultiQuestionDef[],
  ttlMs: number = DEFAULT_MULTI_QUESTION_TTL_MS,
  anchorMsgId?: string,
  mode: 'sequential' | 'legacy' = 'legacy',
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
    mode,
    cursor: 0,
    ...(anchorMsgId ? { anchorMsgId } : {}),
    expiresAtMs: Date.now() + ttlMs,
    cleanupTimer: setTimeout(() => {
      if (pendingMultiQuestions.get(questionId) === entry) {
        pendingMultiQuestions.delete(questionId);
      }
      if (pendingByConversation.get(conversationKey(accountId, scope, targetId)) === questionId) {
        pendingByConversation.delete(conversationKey(accountId, scope, targetId));
      }
    }, ttlMs),
  };
  entry.cleanupTimer.unref?.();
  pendingMultiQuestions.set(questionId, entry);
  pendingByConversation.set(conversationKey(accountId, scope, targetId), questionId);
}

/** 按会话查找进行中的多问题单（终态/提交中/已过期不算）；会话键含账号维度 */
export function findPendingMultiQuestionByConversation(
  accountId: string,
  scope: 'c2c' | 'group',
  targetId: string,
): { questionId: string } | undefined {
  const questionId = pendingByConversation.get(conversationKey(accountId, scope, targetId));
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
 * 读取登记的被动锚点（本轮 inbound 的 msg_id）。
 *
 * 用于多题的续卡 / 确认卡 / 状态回执走被动回复。返回 undefined 表示
 * 「无可用锚点」（pending 不存在 / 已过期 / 登记时未带锚点）⇒ 发送侧
 * 直接走主动。
 */
export function getPendingMultiQuestionAnchor(questionId: string): string | undefined {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.expiresAtMs <= Date.now()) return undefined;
  return entry.anchorMsgId;
}

// ============ 顺序发题状态机（PR2）============

/**
 * 多题 pending 的只读快照（顺序发题用）。
 *
 * 供渲染层决定「这张卡该长什么样」：第几题、是不是最后一题（提交态）、
 * 前序已收了哪些答案、当前是否处于回改态。
 */
export interface PendingMultiQuestionState {
  questionId: string;
  questions: MultiQuestionDef[];
  answers: ReadonlyMap<number, MultiQuestionAnswer>;
  /** 流程位置：当前发出去的那张卡对应的题号 */
  cursor: number;
  /** 正在回改的题号（用户点了「✏️ 改一改」后置位） */
  editingIndex?: number;
  mode: 'sequential' | 'legacy';
  scope: 'c2c' | 'group';
  targetId: string;
  anchorMsgId?: string;
}

/** 读取多题 pending 的快照；不存在 / 已过期 ⇒ null */
export function getPendingMultiQuestionState(
  questionId: string,
): PendingMultiQuestionState | null {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.expiresAtMs <= Date.now()) return null;
  return {
    questionId,
    questions: entry.questions,
    answers: new Map(entry.answers),
    cursor: entry.cursor,
    ...(entry.editingIndex !== undefined ? { editingIndex: entry.editingIndex } : {}),
    mode: entry.mode,
    scope: entry.scope,
    targetId: entry.targetId,
    ...(entry.anchorMsgId ? { anchorMsgId: entry.anchorMsgId } : {}),
  };
}

/**
 * 顺序发题：记录一次作答，返回**下一张要发的卡**的题号。
 *
 * ── 状态机 ─────────────────────────────────────────────────────────
 * - 正常作答（点在当前卡上）⇒ 记答案 ⇒ 前进一题；
 * - 回改作答（点在「✏️ 改一改」重发的那张卡上）⇒ 覆盖该题答案 ⇒
 *   改的是**更早**的题就回到流程位置（重发当前卡，保证最后一题的
 *   全量文本是最新的）；改的就是当前题就前进一题；
 * - 误点更早那张卡的选项 ⇒ 记答案 ⇒ 重发当前卡（同上，刷新全量文本）。
 *
 * ⚠️ 框架要求**整单齐备**才 resolve（`validateAnswers`，见 issue #93
 * 根因 2），所以这里只收集、**不提交**——提交发生在最后一题卡的
 * 指令按钮上（客户端代发真实用户消息）。
 */
export type SequentialAnswerResult =
  | { status: 'ok'; nextIndex: number }
  | { status: 'unknown' }
  | { status: 'terminal' };

export function recordSequentialAnswer(
  questionId: string,
  questionIndex: number,
  optionIndex: number,
): SequentialAnswerResult {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry) return { status: 'unknown' };
  if (entry.expiresAtMs <= Date.now()) {
    pendingMultiQuestions.delete(questionId);
    clearTimeout(entry.cleanupTimer);
    return { status: 'unknown' };
  }
  if (entry.terminal) return { status: 'terminal' };

  const question = entry.questions[questionIndex];
  if (!question) return { status: 'unknown' };
  if (typeof question.options[optionIndex] !== 'string') return { status: 'unknown' };

  entry.answers.set(questionIndex, { optionIndex });

  const total = entry.questions.length;
  let nextIndex: number;
  if (entry.editingIndex === questionIndex) {
    // 回改完成
    entry.editingIndex = undefined;
    nextIndex = questionIndex < entry.cursor ? entry.cursor : entry.cursor + 1;
  } else if (entry.editingIndex !== undefined) {
    // 回改期间点了别的卡 ⇒ 放弃回改，按普通作答处理
    entry.editingIndex = undefined;
    nextIndex = questionIndex === entry.cursor ? entry.cursor + 1 : entry.cursor;
  } else if (questionIndex === entry.cursor) {
    nextIndex = entry.cursor + 1;
  } else {
    // 点了更早那张卡的选项（改前面已答的题）⇒ 重发当前卡刷新全量文本
    nextIndex = entry.cursor;
  }
  if (nextIndex >= total) nextIndex = total - 1;
  if (nextIndex < 0) nextIndex = 0;
  entry.cursor = nextIndex;
  return { status: 'ok', nextIndex };
}

/**
 * 顺序发题：进入第 k 题的**回改态**（「✏️ 改一改」回调）。
 *
 * 只置位 `editingIndex`——真正的「重发该题卡」由调用方做（它才有出站
 * 通道与锚点）。
 */
export type SequentialEditResult =
  | { status: 'ok' }
  | { status: 'unknown' }
  | { status: 'terminal' };

export function beginSequentialEdit(
  questionId: string,
  questionIndex: number,
): SequentialEditResult {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry) return { status: 'unknown' };
  if (entry.expiresAtMs <= Date.now()) {
    pendingMultiQuestions.delete(questionId);
    clearTimeout(entry.cleanupTimer);
    return { status: 'unknown' };
  }
  if (entry.terminal) return { status: 'terminal' };
  if (questionIndex < 0 || questionIndex >= entry.questions.length) return { status: 'unknown' };
  entry.editingIndex = questionIndex;
  return { status: 'ok' };
}

/**
 * 构造最后一题卡的**提交前缀**：前 N-1 题的 keyed 答案文本
 * （`"1: 3\n2: 1"`）。
 *
 * 纯数字 = 选项序号（1-based，框架 `normalizeAgentHarnessUserInputOption`
 * 按 `Number(trimmed)-1` 反查）；非数字 = 自由文本（ask_user 恒有
 * `isOther`，故自由文本原样保留）。
 */
export function buildSequentialAnswerPrefix(
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
  total: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < total - 1; i++) {
    const answer = answers.get(i);
    if (!answer) continue;
    lines.push(`${i + 1}: ${'optionIndex' in answer ? answer.optionIndex + 1 : answer.text}`);
  }
  return lines.join('\n');
}

/** 答案的人话版展示（确认卡 / 顺序卡「已记录」区共用） */
export function formatMultiQuestionAnswerDisplay(
  question: MultiQuestionDef,
  answer: MultiQuestionAnswer,
): string {
  return 'optionIndex' in answer
    ? stripRecommendedSuffix(splitOptionLabel(question.options[answer.optionIndex] ?? ''))
    : answer.text;
}

// ============ 单问题 pending Store（PR1）============

/**
 * 单问题 pending 登记（**仅 c2c**）。
 *
 * ── 为什么需要 ───────────────────────────────────────────────────
 * 单题卡正文现在明确写着「不想选按钮？直接回复…」，也就是**鼓励用户用
 * 自由文本作答**（框架单题契约：整条文本即答案，序号 / 选项名 / 任意
 * 文本都能命中，见 `normalizeAgentHarnessUserInputAnswer`）。
 *
 * 但 c2c 入站有 3 秒防抖合并：合并会把答案文本改写成 `[消息 1/N]` 分节体
 * ⇒ 框架认领到的答案被污染（多问题路径早有同款问题，见
 * `inbound-debounce.ts` 的 keyed 答案旁路）。
 *
 * 因此单题卡发出后登记一条 pending，让**该会话的下一条 c2c 文本不被合并**
 * （与多问题 keyed 答案旁路同款机制），并顺带保护 secret-capture
 * 中间件不把答案当密钥吞掉（红线）。
 *
 * ── 生命周期 ─────────────────────────────────────────────────────
 * - 登记：单题卡**发送前**（先登记后发，避免「先点后登记」竞态）
 * - 清理：① 按钮 resolve 成功；② 卡片发送失败（用户没看到卡）；
 *   ③ 该会话下一条 c2c 入站消息（答案必然是用户看到卡后的第一条消息）；
 *   ④ TTL 定时器兜底
 * - 群聊**不登记**（群合批旁路本 PR 不动，群行为与改造前一致）
 */
interface PendingSingleQuestion {
  accountId: string;
  scope: 'c2c' | 'group';
  targetId: string;
  /** 本轮 inbound 的 msg_id（显式锚点，非池化选取） */
  anchorMsgId?: string;
  expiresAtMs: number;
  cleanupTimer: ReturnType<typeof setTimeout>;
}

/** gateway 默认问题超时 15min，这里留 10min 余量兜住投递延迟 */
const DEFAULT_SINGLE_QUESTION_TTL_MS = 25 * 60 * 1000;

const pendingSingleQuestions = new Map<string, PendingSingleQuestion>();
/**
 * `${accountId}:${scope}:${targetId}` -> questionId（与多问题同款会话键）。
 * accountId 必须入键：QQ openid 是 per-account 的（bot A 与 bot B 的同
 * 字符串 targetId 指向不同用户），不带账号维度会让 A 账号的 pending 误命中
 * B 账号同 targetId 的会话。
 */
const pendingSingleByConversation = new Map<string, string>();

/**
 * 登记一次单问题 ask_user 投递（供 c2c 旁路识别）。
 *
 * @param anchorMsgId 本轮 inbound 的 msg_id（显式锚点）——仅作留痕，
 *   单题卡本身在 dispatch 里直接用当轮锚点发送。
 */
export function registerPendingSingleQuestion(
  accountId: string,
  questionId: string,
  scope: 'c2c' | 'group',
  targetId: string,
  ttlMs: number = DEFAULT_SINGLE_QUESTION_TTL_MS,
  anchorMsgId?: string,
): void {
  const existing = pendingSingleQuestions.get(questionId);
  if (existing) clearTimeout(existing.cleanupTimer);

  const entry: PendingSingleQuestion = {
    accountId,
    scope,
    targetId,
    ...(anchorMsgId ? { anchorMsgId } : {}),
    expiresAtMs: Date.now() + ttlMs,
    cleanupTimer: setTimeout(() => {
      if (pendingSingleQuestions.get(questionId) === entry) {
        pendingSingleQuestions.delete(questionId);
      }
      const key = conversationKey(accountId, scope, targetId);
      if (pendingSingleByConversation.get(key) === questionId) {
        pendingSingleByConversation.delete(key);
      }
    }, ttlMs),
  };
  entry.cleanupTimer.unref?.();
  pendingSingleQuestions.set(questionId, entry);
  pendingSingleByConversation.set(conversationKey(accountId, scope, targetId), questionId);
}

/**
 * 按会话查找进行中的单问题（已过期 / 已清理不算）；会话键含账号维度。
 */
export function findPendingSingleQuestionByConversation(
  accountId: string,
  scope: 'c2c' | 'group',
  targetId: string,
): { questionId: string } | undefined {
  const questionId = pendingSingleByConversation.get(conversationKey(accountId, scope, targetId));
  if (!questionId) return undefined;
  const entry = pendingSingleQuestions.get(questionId);
  if (!entry || entry.expiresAtMs <= Date.now()) {
    return undefined;
  }
  return { questionId };
}

/**
 * 清理单问题 pending（按钮已作答 / 卡片发送失败 / 用户已回话）。
 */
export function markSingleQuestionResolved(questionId: string): void {
  const entry = pendingSingleQuestions.get(questionId);
  if (!entry) return;
  clearTimeout(entry.cleanupTimer);
  pendingSingleQuestions.delete(questionId);
  const key = conversationKey(entry.accountId, entry.scope, entry.targetId);
  if (pendingSingleByConversation.get(key) === questionId) {
    pendingSingleByConversation.delete(key);
  }
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
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
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
        permission: { type: KEYBOARD_PERMISSION_EVERYONE },
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
