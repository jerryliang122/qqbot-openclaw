/**
 * 多题顺序发题的流程编排（PR2 / issue #93）
 *
 * ── 为什么需要这个模块 ─────────────────────────────────────────────
 * 改造前，多题 ask_user 一次性把 2–3 张卡全发出去，答完还要再点一次
 * 「✅ 提交」（确认卡）。PR2 改成 **c2c 单聊顺序发题**：
 *
 * 1. 只发第 1 题；用户答完第 k 题才发第 k+1 题；
 * 2. 每一题卡只有选项按钮（**没有**「✏️ 改一改」）；想改前面的题，在
 *    最后一题点预填按钮（「✍️ 其他」/「📝 填写模板」）——输入框会带上全部
 *    已答内容，用户改哪行都行；
 * 3. **最后一题答完即提交**：选项按钮是回调型（type=1），点选只记答案；
 *    全部答齐后由本模块的 `submitSequentialAnswers` **组合整单文本**并交给
 *    框架官方认领通道（`claimPendingAgentQuestionAnswer`）整单 resolve。
 *
 * 交互流程的出站在两处发生（首卡在 dispatch、续卡在 interaction 回调），
 * 但「这张卡长什么样」只有一份口径 ⇒ 渲染 + 发送收敛到本模块。
 *
 * ── 红线 ───────────────────────────────────────────────────────────
 * - **禁止代替用户作答**：提交出去的每个答案值都来自用户的真实输入
 *   （按钮点选 / 手打文本），插件只负责**搬运**与**组合**；
 * - **禁止合成入站消息**（会被框架 steer 进 ask_user-suspended run，
 *   2026-08-24 事故）——提交只走框架的官方认领通道，不构造入站事件；
 * - 被动锚点只认 pending 登记时记下的**本轮 inbound msg_id**（禁止从
 *   msgid-cache 池化选取）。
 *
 * ── 范围 ───────────────────────────────────────────────────────────
 * 本形态**仅用于 c2c 单聊**。群聊保持改造前的形态（全部发出 + 确认卡），
 * 依据见 issue #93 第十节：群里默认拿不到 `ask_user` 工具，多题在群里
 * 基本不会发生 ⇒ 不动群路径 = 零回归。
 */

import type { InlineKeyboard, ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { SendResult } from '../outbound/outbound-service.js';
import {
  ANSWER_DISPLAY_MAX_GRAPHEMES,
  buildSequentialCollectKeyboard,
  buildSequentialSubmitKeyboard,
  formatSequentialQuestionCard,
  truncateGraphemeSafe,
} from './question-card.js';
import {
  buildSequentialAnswerPrefix,
  buildSequentialFullAnswerText,
  formatMultiQuestionAnswerDisplay,
  markMultiQuestionResolveFailed,
  markMultiQuestionResolved,
  markMultiQuestionSubmitting,
  type PendingMultiQuestionState,
} from './question-helpers.js';
import { submitMultiQuestionAnswer } from './question-submit.js';
import { sendQuestionMessage } from '../outbound/question-send.js';

/** 渲染出来的一张顺序发题卡 */
export interface SequentialCard {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * 渲染顺序发题的第 `index` 题卡。
 *
 * - 最后一题 ⇒ **提交态**（选项是回调型按钮 + 预填按钮）；
 * - 中间题 ⇒ **收集态**（选项是回调型按钮，点选只记答案）。
 *
 * 最后一题的前序答案**不齐**时（理论上不会发生：流程只在 0..N-2 都
 * 答完后才推进到最后一题）降级为收集态——宁可不提交，也不提交一份
 * 缺题的答案（框架会整单拒绝，白白让用户多点一次）。
 */
export function renderSequentialCard(
  state: PendingMultiQuestionState,
  index: number,
): SequentialCard | null {
  const question = state.questions[index];
  if (!question) return null;

  const total = state.questions.length;
  const isLast = index === total - 1;

  if (!isLast) {
    return {
      text: formatSequentialQuestionCard(question, {
        index,
        total,
        mode: 'collect',
      }),
      keyboard: buildSequentialCollectKeyboard(state.questionId, index, question),
    };
  }

  // 最后一题：前 N-1 题的答案必须齐全，否则不能走提交态
  let prefixComplete = true;
  for (let i = 0; i < total - 1; i++) {
    if (!state.answers.has(i)) {
      prefixComplete = false;
      break;
    }
  }
  if (!prefixComplete) {
    return {
      text: formatSequentialQuestionCard(question, {
        index,
        total,
        mode: 'collect',
      }),
      keyboard: buildSequentialCollectKeyboard(state.questionId, index, question),
    };
  }

  const prefix = buildSequentialAnswerPrefix(state.answers, total);
  const collected = state.questions.slice(0, total - 1).map((q, i) => {
    const answer = state.answers.get(i);
    return {
      header: q.header,
      display: answer
        ? truncateGraphemeSafe(formatMultiQuestionAnswerDisplay(q, answer), ANSWER_DISPLAY_MAX_GRAPHEMES)
        : '（未作答）',
    };
  });
  // 手打兜底模板：前 N-1 题的答案 + 最后一题**留空**占位（客户端不支持
  // 指令按钮时用）。末题占位必须是空值、不得填「你的答案」之类文案：
  // ask_user 恒 isOther（框架 normalizeAskUserParams 强制），任何非数字
  // 文本都会被当合法自由文本收单——原样复制模板会把占位文案静默提交成
  // 末题答案；留空则被插件判为「未答」并回执格式错误（评审 F2，与
  // 「✍️ 其他」预填 `"<N>: "` 同口径）。
  const submitTemplate = prefix
    ? `${prefix}\n${total}: `
    : '1: ';

  return {
    text: formatSequentialQuestionCard(question, {
      index,
      total,
      mode: 'submit',
      collected,
      submitTemplate,
    }),
    keyboard: buildSequentialSubmitKeyboard(state.questionId, index, question, prefix),
  };
}

/**
 * 渲染并发送顺序发题的第 `index` 题卡。
 *
 * 出站走**被动回复**：锚点 = pending 登记时记下的本轮 inbound msg_id
 * （与首卡同一个锚点）——不耗每日主动预算，用户关闭「允许主动发送」
 * 时也能收到；锚点不可用（TTL 过期 / 平台判死）时自动降级为主动。
 */
export async function sendSequentialQuestionCard(params: {
  state: PendingMultiQuestionState;
  index: number;
  account: ResolvedQQBotAccount;
  /** 出站目标（`qqbot:c2c:<openid>`） */
  to: string;
  log?: PluginLogger;
}): Promise<SendResult> {
  const { state, index, account, to, log } = params;
  const card = renderSequentialCard(state, index);
  if (!card) {
    return { error: `question ${index} not found` };
  }
  const result = await sendQuestionMessage({
    account,
    accountId: account.accountId,
    to,
    text: card.text,
    keyboard: card.keyboard as never,
    ...(state.anchorMsgId ? { anchorMsgId: state.anchorMsgId } : {}),
    log,
  });
  if (result.error) {
    log?.error?.(`[question] sequential card send failed index=${index}: ${result.error}`);
  } else {
    log?.info?.(
      `[question] sequential card sent id=${state.questionId} index=${index + 1}/${state.questions.length}`,
    );
  }
  return result;
}

// ============ 整单提交（插件直提）============

/** 整单提交的结果 */
export type SequentialSubmitOutcome =
  /** 框架已受理答案（挂起的 ask_user 被 resolve） */
  | { status: 'submitted' }
  /** 框架侧已终态（无挂起记录 / 已取消 / 已超时） */
  | { status: 'already-resolved' }
  /** 提交失败（答案非法 / SDK 不可用 / 传输异常）——pending 保持武装 */
  | { status: 'failed'; reason: string }
  /** 答案不齐（缺题）——不提交 */
  | { status: 'incomplete' }
  /** 未取得提交锁（已在提交中 / 已终态）——静默忽略 */
  | { status: 'skipped' };

/**
 * 把已收集的答案**组合成整单文本**并交给框架官方认领通道提交。
 *
 * 流程：
 * 1. `buildSequentialFullAnswerText` 组合（任一题缺答 ⇒ `incomplete`）；
 * 2. `markMultiQuestionSubmitting` 取提交锁（防并发重复提交）；
 * 3. `submitMultiQuestionAnswer` 调框架 `claimPendingAgentQuestionAnswer`
 *    —— 与框架自己的入站认领**同一套解析与校验**；
 * 4. 结果映射：
 *    - `submitted` ⇒ pending 终态（不回执：助手续跑后会自己回话）；
 *    - `already-resolved` ⇒ pending 终态 + 回执「该问题已提交或已过期」；
 *    - `invalid` / `error` / `unsupported` ⇒ **pending 保持武装**（用户可
 *      再次点选或重新打字重试）+ 回执失败原因。
 */
export async function submitSequentialAnswers(params: {
  state: PendingMultiQuestionState;
  account: ResolvedQQBotAccount;
  /** 出站目标（`qqbot:c2c:<openid>`） */
  to: string;
  log?: PluginLogger;
}): Promise<SequentialSubmitOutcome> {
  const { state, account, to, log } = params;
  const total = state.questions.length;

  const text = buildSequentialFullAnswerText(state.answers, total);
  if (!text) {
    log?.warn?.(`[question] submit skipped: answers incomplete id=${state.questionId}`);
    return { status: 'incomplete' };
  }

  if (!markMultiQuestionSubmitting(state.questionId)) {
    log?.info?.(`[question] submit skipped: not armed id=${state.questionId}`);
    return { status: 'skipped' };
  }

  const result = await submitMultiQuestionAnswer({
    sessionKey: state.sessionKey,
    text,
    log,
  });

  if (result.status === 'submitted') {
    markMultiQuestionResolved(state.questionId);
    log?.info?.(`[question] answers submitted id=${state.questionId} chars=${text.length}`);
    return { status: 'submitted' };
  }

  if (result.status === 'already-resolved') {
    markMultiQuestionResolved(state.questionId);
    log?.info?.(`[question] answers not consumed (already resolved) id=${state.questionId}`);
    await sendSubmitReceipt({
      state,
      account,
      to,
      text: '该问题已提交或已过期',
      log,
    });
    return { status: 'already-resolved' };
  }

  // 失败：pending 保持武装 ⇒ 用户可再次点选 / 重新打字重试
  markMultiQuestionResolveFailed(state.questionId);
  const reason =
    result.status === 'invalid'
      ? '答案格式不对，请检查后重新提交'
      : result.status === 'unsupported'
        ? '提交失败，请重新作答'
        : '提交失败，请重新作答';
  log?.warn?.(`[question] submit failed id=${state.questionId} status=${result.status}`);
  await sendSubmitReceipt({ state, account, to, text: `⚠️ ${reason}`, log });
  return { status: 'failed', reason };
}

/**
 * 提交结果的回执（尽力而为：失败不阻断流程）。
 *
 * 出站口径与续卡一致（被动锚点优先、锚点不可用降级主动）。
 */
async function sendSubmitReceipt(params: {
  state: PendingMultiQuestionState;
  account: ResolvedQQBotAccount;
  to: string;
  text: string;
  log?: PluginLogger;
}): Promise<void> {
  const { state, account, to, text, log } = params;
  try {
    const result = await sendQuestionMessage({
      account,
      accountId: account.accountId,
      to,
      text,
      ...(state.anchorMsgId ? { anchorMsgId: state.anchorMsgId } : {}),
      log,
    });
    if (result.error) {
      log?.error?.(`[question] submit receipt send failed: ${result.error}`);
    }
  } catch (err) {
    log?.error?.(
      `[question] submit receipt send threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
