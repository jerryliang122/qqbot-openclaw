/**
 * 多题顺序发题的流程编排（PR2 / issue #93）
 *
 * ── 为什么需要这个模块 ─────────────────────────────────────────────
 * 改造前，多题 ask_user 一次性把 2–3 张卡全发出去，答完还要再点一次
 * 「✅ 提交」（确认卡）。PR2 改成 **c2c 单聊顺序发题**：
 *
 * 1. 只发第 1 题；用户答完第 k 题才发第 k+1 题；
 * 2. 每一题卡带「✏️ 改一改」入口（点它重发该题卡，可回改）；
 * 3. **最后一题卡本身就是提交点**——选项按钮是指令型（type=2,
 *    enter=true），data 里写全量 keyed 答案文本（`"1: 3\n2: 1"`），
 *    客户端以真实用户身份发出 ⇒ 框架 keyed 认领通道 resolve 掉挂起的
 *    ask_user ⇒ **确认卡整个消失**。
 *
 * 交互流程的出站在两处发生（首卡在 dispatch、续卡在 interaction 回调），
 * 但「这张卡长什么样」只有一份口径 ⇒ 渲染 + 发送收敛到本模块。
 *
 * ── 红线 ───────────────────────────────────────────────────────────
 * - **不程序化提交**（插件没有 `operator.questions` scope）；
 * - **不合成入站消息**（会被框架 steer 进 ask_user-suspended run，
 *   2026-08-24 事故）——提交只靠客户端代发的**真实**用户消息；
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
  buildSequentialCollectKeyboard,
  buildSequentialSubmitKeyboard,
  formatSequentialQuestionCard,
} from './question-card.js';
import {
  buildSequentialAnswerPrefix,
  formatMultiQuestionAnswerDisplay,
  type PendingMultiQuestionState,
} from './question-helpers.js';
import { sendQuestionMessage } from '../outbound/question-send.js';

/** 渲染出来的一张顺序发题卡 */
export interface SequentialCard {
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * 渲染顺序发题的第 `index` 题卡。
 *
 * - 最后一题 ⇒ **提交态**（选项是指令型按钮，data 带全量答案文本）；
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
  const editing = state.editingIndex === index;
  const isLast = index === total - 1;

  if (!isLast) {
    return {
      text: formatSequentialQuestionCard(question, { index, total, mode: 'collect', editing }),
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
      text: formatSequentialQuestionCard(question, { index, total, mode: 'collect', editing }),
      keyboard: buildSequentialCollectKeyboard(state.questionId, index, question),
    };
  }

  const prefix = buildSequentialAnswerPrefix(state.answers, total);
  const collected = state.questions.slice(0, total - 1).map((q, i) => {
    const answer = state.answers.get(i);
    return {
      header: q.header,
      display: answer ? formatMultiQuestionAnswerDisplay(q, answer) : '（未作答）',
    };
  });
  // 手打兜底模板：前 N-1 题的答案 + 最后一题占位（客户端不支持指令按钮时用）
  const submitTemplate = prefix
    ? `${prefix}\n${total}: 你的答案`
    : '1: 你的答案';

  return {
    text: formatSequentialQuestionCard(question, {
      index,
      total,
      mode: 'submit',
      editing,
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
