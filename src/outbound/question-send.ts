/**
 * ask_user 问题卡出站（被动优先 + 锚点不可用降级主动）
 *
 * ── 为什么需要这个模块 ─────────────────────────────────────────────
 * ask_user 的**问题卡**（单问题卡 / 多题卡 / 确认卡 / 状态回执）此前
 * 走的是 SDK 直发（`bot.sendTextWithKeyboard` / `bot.sendText`），
 * 请求体里**不带 `msg_id`** ⇒ 平台按**主动消息**处理。后果：
 *
 * 1. 白烧每日 1000 条/关系主动预算（问答卡每次 ask_user 至少一条）；
 * 2. 用户在 QQ 客户端关闭「允许主动发送」时，问题卡**根本发不出去**
 *    （纯文本兜底同样是主动）→ 模型空等 `ask_user` 超时（默认 900s）
 *    才返回 `no_answer`。
 *
 * 而正文 / 流式 / 进度卡一直走 `outbound-service.sendText` + **显式
 * 锚点**（`replyToId`）⇒ 被动回复。ask_user 是唯一漏掉锚点的一族。
 *
 * ── 本模块的口径（照抄进度卡，`outbound/progress-card-publisher.ts`）──
 *
 * 1. 有显式锚点（= 本轮 inbound 的 msg_id）⇒ **先走被动**
 *    （`passiveOnly: true`）：不挂错引用、不耗主动预算；
 * 2. 锚点**不可用**（本地 TTL 预检判死 / 平台判死 40034005·40034128）
 *    ⇒ **降级为主动发送一次**——问题必须让用户看到，代价是烧 1 条
 *    每日主动预算（与进度卡同款代价）；
 * 3. 其他错误（网络错 `httpStatus===0` 结果不明、内容超长等）
 *    ⇒ **原样返回、不重发**（网络错重发有重复风险；其他错误重发必同错）。
 *
 * ⚠️ **为什么不让网关的 `retryOnDeadAnchor` 兜底**：网关那条主动重发
 * 路径用 `bot.sendText`（`gateway/qqbot-gateway.ts` 的 retry 回调），
 * **不携带 keyboard** ⇒ 用户会看到题干却没有可点的选项。问题卡必须
 * 自己降级，才能保住按钮。
 *
 * ── 红线 ───────────────────────────────────────────────────────────
 * - 锚点只认**调用方显式传入的**本轮 inbound msg_id；**禁止**从
 *   msgid-cache 池化选取（见 AGENTS.md「出站与配额」）。
 * - 本模块**不引入** preemptive 次数门（平台实测不执行「每 msg_id
 *   4/5 次」上限，见 issue #84）。
 */

import type { InlineKeyboard, ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { isAnchorDeadBizCode } from '../features/quota-manager.js';
import { sendText, type SendResult } from './outbound-service.js';

export interface QuestionSendParams {
  /** 解析账号（用于配额记账与发送账号回退） */
  account: ResolvedQQBotAccount;
  accountId: string;
  /** 目标：`qqbot:c2c:<openid>` / `qqbot:group:<openid>` */
  to: string;
  text: string;
  /** QQ 原生按钮（keyboard） */
  keyboard?: InlineKeyboard;
  /**
   * 本轮 inbound 消息的 msg_id（显式锚点）。
   *
   * 缺省 ⇒ 直接走主动发送（不挂任何 msg_id）。
   */
  anchorMsgId?: string;
  log?: PluginLogger;
}

/**
 * 发送一条 ask_user 消息（正文 + 可选按钮）。
 *
 * 优先被动回复（锚点 = 本轮 inbound msg_id）；锚点不可用时降级为主动
 * 发送一次，保证问题一定送达。
 */
export async function sendQuestionMessage(params: QuestionSendParams): Promise<SendResult> {
  const { account, accountId, to, text, keyboard, anchorMsgId, log } = params;
  const keyboardOpt = keyboard ? { keyboard } : {};

  // 无显式锚点 ⇒ 直接主动（不挂任何 msg_id；网关记账进每日主动预算）
  if (!anchorMsgId) {
    return await sendText({ to, text, accountId, account, ...keyboardOpt });
  }

  // 被动优先
  const passive = await sendText({
    to,
    text,
    accountId,
    account,
    replyToId: anchorMsgId,
    ...keyboardOpt,
    passiveOnly: true,
  });
  if (!passive.error) return passive;

  // 锚点不可用判定：
  // - passive-quota-exhausted：本地预检拦截（TTL 过期 / 死锚点 / 无 msg_id）
  // - qqBizCode ∈ {40034005, 40034128}：平台判死该 msg_id
  const anchorUnavailable =
    passive.error === 'passive-quota-exhausted' ||
    isAnchorDeadBizCode(passive.qqBizCode);
  if (!anchorUnavailable) {
    // 网络错（结果不明）/ 其他业务码 ⇒ 不重发
    return passive;
  }

  log?.warn?.(
    `[question] passive anchor unavailable (${passive.error}${
      passive.qqBizCode ? ` bizCode=${passive.qqBizCode}` : ''
    }); falling back to proactive send`,
  );

  // 降级主动：不挂锚点（计入每日主动预算），按钮必须保留
  return await sendText({ to, text, accountId, account, ...keyboardOpt });
}
