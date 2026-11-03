/**
 * QQBot Heartbeat 适配器
 *
 * Typing 指示器（与 turn 内中间件 middleware/typing.ts 同口径：
 * 锚点不可用 ⇒ 不启动/停止续期，**绝不降级为主动形态**——主动额度留给
 * 正文与前置消息）。
 */

import { startTypingWithRenewal, stopTyping } from './typing-lifecycle.js';
import { inferQQBotScope, invalidateMsgIdQuota, isAnchorDeadError } from './features/quota-manager.js';
import { getGateway } from './outbound/outbound-service.js';
import { tryParseTarget } from './outbound/target.js';

/**
 * QQBot Heartbeat Adapter
 */
export const qqbotHeartbeatAdapter = {
  sendTyping: async (params: {
    cfg: any;
    to: string;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string;
  }) => {
    const { to, accountId, replyToId } = params;

    if (!accountId || !replyToId) {
      return;
    }

    const scope = inferQQBotScope(to);
    if (scope !== 'c2c') {
      return;
    }

    await startTypingWithRenewal({
      accountId,
      to,
      replyToId,
      sendTyping: async ({ to, msgId }) => {
        const gw = getGateway(accountId);
        if (!gw) return false;

        const target = tryParseTarget(to);
        if (!target) {
          return false;
        }

        const targetWithMsgId = msgId ? { ...target, msgId } : target;
        try {
          await gw.sendTyping(targetWithMsgId);
          return true;
        } catch (err) {
          // 平台判定锚点已死（40034005 / 40034128）⇒ 标记死锚点，
          // 本轮后续消息一律不得走被动回复；生命周期侧据此停止续期。
          if (msgId && isAnchorDeadError(err)) {
            invalidateMsgIdQuota({ accountId, msgId, scope: 'c2c' });
          }
          return false;
        }
      },
    });
  },
};
