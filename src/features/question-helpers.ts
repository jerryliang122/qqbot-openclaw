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
 * - buildMultiQuestionConfirmKeyboard 等: 群聊 legacy 路径的「确认卡」——
 *   指令按钮 (type=2, enter=true) 携带完整答案文本，由客户端以真实用户
 *   消息发出，走框架原生的 keyed 文本认领通道。
 *
 * **c2c 顺序发题路径（sequential）不走确认卡**：答案齐备后由
 * `question-submit.ts` 直接调框架官方认领通道
 * （`claimPendingAgentQuestionAnswer`）整单 resolve——插件只**搬运**用户
 * 真实作答，不代替用户作答、不合成入站消息。
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

// ============ 多问题答案暂存 Store ============

interface PendingMultiQuestion {
  /** 登记账号（claimed-answer 登记表的会话键需要；openid 是 per-account 的） */
  accountId: string;
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
   * 本轮 inbound 消息的 msg_id（**显式锚点**）——多题的续卡 / 确认卡 /
   * 状态回执复用它走被动回复。
   *
   * 取值只来自 dispatch 当轮的 `envelope.messageId`（**不是** msgid-cache
   * 池化选取：挂错引用等于把回复挂到错误的消息上，见 AGENTS.md 红线）。
   * 锚点过期（群聊 5min / c2c 60min）或被平台判死时，发送侧降级为主动。
   */
  anchorMsgId?: string;
  /**
   * 框架挂起 ask_user 记录的 sessionKey——`claimPendingAgentQuestionAnswer`
   * 的查表键（框架的 `pendingAgentQuestions` 全局表）。
   *
   * 取值来自 dispatch 当轮的 `route.sessionKey`（与框架 turn 同一个 session
   * ⇒ 命中同一条挂起记录）。缺省时插件直提会失败（回执「提交失败」），
   * 用户仍可走「整单文本原样转发框架」的兜底路径。
   */
  sessionKey?: string;
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
 * @param sessionKey 框架挂起 ask_user 记录的 sessionKey——插件直提整单答案的
 *   查表键（`claimPendingAgentQuestionAnswer`）。只用于 `sequential` 形态。
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
  sessionKey?: string,
): void {
  const existing = pendingMultiQuestions.get(questionId);
  if (existing) clearTimeout(existing.cleanupTimer);

  const entry: PendingMultiQuestion = {
    accountId,
    scope,
    targetId,
    questions,
    answers: new Map(),
    terminal: false,
    resolving: false,
    mode,
    cursor: 0,
    ...(anchorMsgId ? { anchorMsgId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
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

/**
 * 按会话查找进行中的多问题单（终态/提交中/已过期不算）；会话键含账号维度 */
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

// ============ keyed 答案形态判定（整单提交改造）============

/**
 * keyed 答案行：`<题号>: <值>`（ASCII 冒号——插件卡片/模板只产这种形态）。
 *
 * **值可空**：整单形态判定只看「行数 + 题号顺序 + 有题号行」，值是否为空
 * 交给提交前的自检（框架 `validateAnswers` 要求每题非空，空值会被拒收
 * 并重问——与其让框架拒收，不如插件先拦下并回执格式错误）。
 */
const KEYED_ANSWER_LINE = /^\s*(\d+)\s*:\s*(.*)$/;

/**
 * 文本里是否含「题号: 值」形态的行。
 *
 * 用于区分两种意图：
 * - 含题号行但**不是**整单形态 ⇒ **形态错误**（行数/题号不对）⇒ 回执格式
 *   错误、保持 pending 武装；
 * - 完全不含题号行 ⇒ **本题答案**（用户为当前题写的自由文本）。
 *
 * 只认题号 + ASCII 冒号：全角冒号「：」框架解析不了（落 fallbackLines
 * 按行兜底，多题时必被 `validateAnswers` 拒收），不当作 keyed 行。
 */
export function containsKeyedAnswerLine(text: string): boolean {
  return String(text ?? '')
    .split(/\r?\n/)
    .some((line) => KEYED_ANSWER_LINE.test(line.trim()));
}

/**
 * 把文本解析成**整单** keyed 答案（题号 → 值）。
 *
 * 判据（与框架认领口径对齐）：
 * - 非空行数 = 题数；
 * - 每行匹配 `^\s*(\d+)\s*:\s*(.*)$`；
 * - 题号必须是 1..N **顺序**（框架 `fallbackLines` 按行配位的前提）。
 *
 * 值可为空串（用户用「📝 填写模板」预填后没填完）——调用方负责补答或
 * 回执格式错误，**不要**把空值直接提交（框架会拒收重问）。
 *
 * 不满足整单形态 ⇒ 返回 null（调用方再按「含题号行」判形态错误）。
 */
export function matchFullKeyedAnswer(
  questions: MultiQuestionDef[],
  text: string,
): Map<number, string> | null {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length !== questions.length) return null;
  const answers = new Map<number, string>();
  for (let index = 0; index < lines.length; index++) {
    const match = KEYED_ANSWER_LINE.exec(lines[index]!);
    if (!match) return null;
    if (Number(match[1]) !== index + 1) return null;
    answers.set(index, match[2]!.trim());
  }
  return answers;
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
  mode: 'sequential' | 'legacy';
  scope: 'c2c' | 'group';
  targetId: string;
  anchorMsgId?: string;
  /** 框架挂起 ask_user 记录的 sessionKey（插件直提整单答案的查表键） */
  sessionKey?: string;
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
    mode: entry.mode,
    scope: entry.scope,
    targetId: entry.targetId,
    ...(entry.anchorMsgId ? { anchorMsgId: entry.anchorMsgId } : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
  };
}

/**
 * 顺序发题：记录一次作答，返回**下一张要发的卡**的题号。
 *
 * ── 状态机 ─────────────────────────────────────────────────────────
 * - 正常作答（点在当前卡上）⇒ 记答案 ⇒ 前进一题；
 * - 点了更早那张卡的选项（改前面已答的题）⇒ 记答案 ⇒ 重发当前卡
 *   （刷新最后一题的全量提交文本）。
 *
 * ⚠️ 框架要求**整单齐备**才 resolve（`validateAnswers`，见 issue #93
 * 根因 2），所以这里只收集、**不提交**——提交发生在最后一题卡的
 * 指令按钮上（客户端代发真实用户消息）。
 *
 * ⚠️ 本形态**没有**「回改态」：卡上不再挂「✏️ 改一改」按钮——想改前面的
 * 题，在最后一题点「✍️ 其他」，输入框会带上全部已答内容，用户改哪一行
 * 都行（见 issue #93 与 PR #96 评审结论）。
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
  if (questionIndex === entry.cursor) {
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
 * 顺序发题（文本作答）：把用户**直接回复的一条文本消息**记为**当前题**
 * （cursor 指向的那张卡）的答案。
 *
 * - 多行压平为单行（`\n` → 空格）：整单文本是「一行一题」格式，多行
 *   自由文本会把行数打乱、框架认领必失败；
 * - 中间题 ⇒ cursor 前进，返回 `{status:'ok', nextIndex}`（调用方续发
 *   下一题卡）；
 * - 末题 ⇒ 全部收齐，返回 `{status:'complete'}`（调用方组合整单文本并
 *   交给框架官方认领通道提交）；**pending 不在此置终态**——终态由提交
 *   结果决定（成功 ⇒ 终态；失败 ⇒ 保持武装，用户可重试）；
 * - 文本作答永远作用于**当前题**：想改更早的题，点那张卡的选项按钮
 *   （既有语义）。
 *
 * 框架侧合法性：ask_user 归一化对每题强制 `isOther: true` ⇒ 自由文本
 * 值（`k: <text>`）必可被认领，无需按题开关。
 */
export type SequentialTextAnswerResult =
  | { status: 'ok'; nextIndex: number }
  /** 末题收齐（全部答案齐备）⇒ 调用方负责组合 + 提交 */
  | { status: 'complete' }
  | { status: 'unknown' }
  | { status: 'terminal' };

export function recordSequentialTextAnswer(
  questionId: string,
  rawText: string,
): SequentialTextAnswerResult {
  const flattened = String(rawText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ');
  if (!flattened) return { status: 'unknown' };

  const entry = pendingMultiQuestions.get(questionId);
  if (!entry) return { status: 'unknown' };
  if (entry.expiresAtMs <= Date.now()) {
    pendingMultiQuestions.delete(questionId);
    clearTimeout(entry.cleanupTimer);
    return { status: 'unknown' };
  }
  if (entry.terminal) return { status: 'terminal' };

  const total = entry.questions.length;
  const cursor = Math.min(Math.max(entry.cursor, 0), total - 1);
  entry.answers.set(cursor, { text: flattened });

  if (cursor >= total - 1) {
    // 末题收齐：不置终态（等提交器认领），由调用方组合整单文本后提交
    return { status: 'complete' };
  }
  entry.cursor = cursor + 1;
  return { status: 'ok', nextIndex: cursor + 1 };
}

/**
 * 把**整单 keyed 文本**解析出的值覆盖进 pending 的答案表（「改一改」路径）。
 *
 * 值的形态归一与框架一致（`normalizeAgentHarnessUserInputOption`）：
 * - 纯数字且落在选项范围内 ⇒ 选项序号（1-based）；
 * - 其余（含越界数字）⇒ 自由文本。
 *
 * ⚠️ **空值不算作答**：框架的 `validateAnswers` 要求每题非空，且框架的
 * keyed 解析正则要求值至少一个字符——空值行会被行序兜底捡成字面量
 * `"N:"` 并**静默当成答案收下**（实测）。这里显式把空值当作「未答」，
 * 由调用方回执格式错误、要求补全。
 *
 * @returns 是否覆盖成功（pending 不存在 / 已终态 ⇒ false）
 */
export function applyFullKeyedAnswer(
  questionId: string,
  values: ReadonlyMap<number, string>,
): boolean {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.terminal || entry.resolving || entry.expiresAtMs <= Date.now()) {
    return false;
  }
  for (const [index, value] of values) {
    const question = entry.questions[index];
    if (!question) return false;
    const trimmed = value.trim();
    if (!trimmed) return false; // 空值 = 未答 ⇒ 拒绝覆盖（避免静默收下 `"N:"`）
    entry.answers.set(index, toMultiQuestionAnswer(question, trimmed));
  }
  return true;
}

/**
 * 把文本值归一成答案（选项序号 or 自由文本）。
 *
 * 与框架 `normalizeAgentHarnessUserInputOption` 同口径：纯数字且在选项
 * 范围内 ⇒ 选项序号；其余 ⇒ 自由文本。
 */
function toMultiQuestionAnswer(question: MultiQuestionDef, value: string): MultiQuestionAnswer {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const optionIndex = Number(trimmed) - 1;
    if (optionIndex >= 0 && optionIndex < question.options.length) {
      return { optionIndex };
    }
  }
  return { text: trimmed };
}

/**
 * 置「正在提交」锁（防并发重复提交）。
 *
 * 顺序发题的末题点选 / 末题打字都可能撞上同一次提交（用户连点、平台重推
 * interaction 事件）——提交是 await 边界，锁必须**在 await 前**置上。
 *
 * @returns 是否成功取得锁（已终态 / 已在提交中 ⇒ false）
 */
export function markMultiQuestionSubmitting(questionId: string): boolean {
  const entry = pendingMultiQuestions.get(questionId);
  if (!entry || entry.terminal || entry.resolving || entry.expiresAtMs <= Date.now()) {
    return false;
  }
  entry.resolving = true;
  return true;
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

/**
 * 顺序发题的**整单答案文本**（每题一行「题号: 答案」，**每题必有值**）。
 *
 * 与 `buildSequentialFullAnswerDraft` 的区别：草稿版未答**留空**（给用户
 * 手打补全用），本版**缺答即 null**——提交路径绝不能带空值（框架的
 * `validateAnswers` 要求每题非空；空值行还会被框架的行序兜底捡成字面量
 * `"N:"` 静默收下）。
 *
 * @returns 整单文本；任一题缺答 ⇒ null（调用方不得提交）
 */
export function buildSequentialFullAnswerText(
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
  total: number,
): string | null {
  if (total <= 0) return null;
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const answer = answers.get(i);
    if (!answer) return null;
    const value = 'optionIndex' in answer ? String(answer.optionIndex + 1) : answer.text.trim();
    if (!value) return null;
    lines.push(`${i + 1}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * 顺序发题失败兜底的**全量**手打草稿：每题一行「题号: 答案」，已答填值
 * （选项序号 1-based / 自由文本），未答**留空**。
 *
 * 用于续卡发送失败的回执（评审 F1）：中间题卡正文不含 keyed 手打格式，
 * 用户没有自救入口——回执直接给出可补全的草稿。未答行**留空**与
 * `buildSequentialAnswerPrefix` 的末题占位同口径：空值会被框架
 * `validateAnswers` 拒绝并重问，原样发送不会静默收单。
 */
export function buildSequentialFullAnswerDraft(
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
  total: number,
): string {
  const lines: string[] = [];
  for (let i = 0; i < total; i++) {
    const answer = answers.get(i);
    lines.push(
      `${i + 1}: ${answer ? ('optionIndex' in answer ? String(answer.optionIndex + 1) : answer.text) : ''}`,
    );
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
 * - 提交：enter=true，客户端点击后自动以用户身份发出（真实消息，框架可认领）；
 *   click_limit=1 防连点重复发送（issue #99）
 * - 改一改：enter=false，答案填入输入框，用户编辑后手动发送。不设
 *   click_limit——只预填不发消息，重复点无害
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
        click_limit: 1,
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
