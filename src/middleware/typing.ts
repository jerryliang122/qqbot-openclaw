/**
 * C2C "正在输入"指示器中间件（替代 SDK 的 typingIndicator）。
 *
 * 与 SDK 版的三点差异：
 * 1. 续期间隔默认 20s 且强制不低于 20s（QPS 约束，事件触发的续期
 *    同样受此间距保护）
 * 2. 配额感知：typing 通知携带入站 msg_id 时属于被动回复、消耗该
 *    msg_id 的被动配额，与真正的回复消息共享额度（经同一 limiter
 *    记账）。被动配额耗尽后与回复消息一样自动降级为主动发送
 *    （不带 msg_id），续期不会中断
 * 3. 出站消息后续期：QQ 客户端收到机器人消息（如思维链中间输出）
 *    会自动终止"正在输入"显示。若框架任务仍在进行，本中间件在
 *    每条消息发出 POST_MESSAGE_REFRESH_DELAY_MS 后补发一次续期；
 *    若该消息是最终回复（处理链完成），会话已结束，自然不再续期
 *
 * QQ 客户端行为：退出聊天界面再进入后指示器会消失，只有收到新的
 * input_notify 推送才会重新显示 —— 这是需要周期性续期的原因。
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { rollbackPassiveSlot, tryAcquirePassiveSlot } from '../outbound/outbound-service.js';
import { subscribeOutboundMessage } from '../features/typing-refresh.js';

/** QPS 约束：续期间隔不得低于 20s */
export const MIN_TYPING_INTERVAL_MS = 20_000;
/**
 * 默认续期间隔 45s。
 *
 * **为什么不是 20s**：typing 通知（input_notify）**与回复消息共享同一份被动配额**
 * （QQ 对每条用户消息的被动回复条数有限：c2c 4 条 / 群 5 条），而一次 notify 的
 * `input_second` 是 60s（见 `TYPING_DURATION_SEC`）——**一次 notify 已经覆盖 60 秒**。
 * 每 20s 续一次等于把同一份覆盖窗口重复消耗 3 遍：模型首字节慢时（实测 42s）
 * typing 就先吃掉 3 条额度，回复只剩 1 条 → 正文块被配额挤掉。
 *
 * 45s 间隔 + 60s 窗口 → 首字节 42s 只吃 1 条，且指示器覆盖不中断
 * （45 < 60，续期发生在窗口到期前）。
 */
const DEFAULT_TYPING_INTERVAL_MS = 45_000;
/** 服务端输入状态窗口（秒），QQ 平台窗口上限约 60s */
const TYPING_DURATION_SEC = 60;
/** 出站消息后延迟多久补发续期 */
export const POST_MESSAGE_REFRESH_DELAY_MS = 5_000;

export function resolveTypingIntervalMs(input: number | undefined): number {
  return Math.max(input ?? DEFAULT_TYPING_INTERVAL_MS, MIN_TYPING_INTERVAL_MS);
}

export interface TypingIndicatorMiddlewareOptions {
  accountId: string;
  /** 续期间隔 ms，默认 45_000，低于 20_000 会被钳制到 20_000 */
  intervalMs?: number;
}

export function c2cTypingIndicator(opts: TypingIndicatorMiddlewareOptions): Middleware {
  const accountId = opts.accountId;
  const intervalMs = resolveTypingIntervalMs(opts.intervalMs);

  return async (ctx, next) => {
    // QQ 开放平台限制：input_notify 仅支持 C2C（私聊）
    if (ctx.message.kind !== 'c2c') {
      await next();
      return;
    }

    let periodic: NodeJS.Timeout | null = null;
    let refresh: NodeJS.Timeout | null = null;
    let lastSentAt = 0;
    let active = true;

    const sendNow = (): void => {
      if (!active) return;
      // 被动配额可用 → 占用并带 msg_id 发送；耗尽 → 不带 msg_id 主动发送，
      // 与回复消息的降级策略一致（见 outbound-service 的统一配额预留）
      const passive = tryAcquirePassiveSlot(accountId, ctx.replyTarget.msgId);
      const target = passive
        ? ctx.replyTarget
        : { scope: 'c2c' as const, targetId: ctx.replyTarget.targetId };
      ctx.bot.sendTyping(target, TYPING_DURATION_SEC).catch((err: unknown) => {
        if (passive) rollbackPassiveSlot(accountId, ctx.replyTarget.msgId);
        ctx.log?.debug?.(`[typing] failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      lastSentAt = Date.now();
      // 以本次发送为锚点重置周期续期，避免与事件续期撞车
      if (periodic) clearInterval(periodic);
      periodic = setInterval(sendNow, intervalMs);
    };

    // 出站消息会终止客户端的输入状态显示 → 5s 后补发；
    // 与上次 typing 发送不足 intervalMs 时顺延（QPS 间距保护）
    const schedulePostMessageRefresh = (): void => {
      if (!active) return;
      if (refresh) clearTimeout(refresh);
      refresh = setTimeout(() => {
        refresh = null;
        const wait = intervalMs - (Date.now() - lastSentAt);
        if (wait > 0) {
          refresh = setTimeout(() => {
            refresh = null;
            sendNow();
          }, wait);
        } else {
          sendNow();
        }
      }, POST_MESSAGE_REFRESH_DELAY_MS);
    };

    // 订阅本会话的出站消息信号（ accountId + targetId 对应同一 C2C 用户）
    const unsubscribe = subscribeOutboundMessage(
      accountId, 'c2c', ctx.replyTarget.targetId, schedulePostMessageRefresh,
    );

    sendNow();

    try {
      await next();
    } finally {
      active = false;
      unsubscribe();
      if (periodic) clearInterval(periodic);
      if (refresh) clearTimeout(refresh);
    }
  };
}
