/**
 * partial 态中间块的被动回复配额守卫
 *
 * ## 为什么需要
 *
 * QQ 平台对**每条用户消息**的被动回复条数有限（c2c 4 条 / 群 5 条），
 * 且配额耗尽后会**降级为主动发送**（不带 msg_id）——那是每日 1000 条的
 * 主动预算，中间块只是「渐进展示」，烧它不划算。
 *
 * partial 态的中间消息由框架 block streaming 产出、逐块投递。块数不受
 * 插件控制（取决于模型输出长度与框架的 chunker），必须有一个闸门：
 * **为最终回复预留 1 条槽位**，额度不足时该中间块**不投递**。
 *
 * 「不投递」的实现方式是**抛错向框架报未送达**（见 BlockNotDeliveredError），
 * 不是静默返回——静默返回会被框架记为「已送达」，进而把携带全文的 final
 * 一并丢弃，造成**正文永久丢失**。
 *
 * 内容不会丢：块未送达时框架的 final 仍会补发全文，用户看到的是
 * 「跳跃式渐进」而非逐字连续。
 */

/**
 * 为最终回复预留的被动配额槽位。
 *
 * 预留 1 条 → 中间块最多 c2c 3 条 / 群 4 条。
 */
export const BLOCK_QUOTA_RESERVE = 1;

/**
 * 是否投递这个中间块。
 *
 * @param remaining 该 msg_id 剩余的被动回复额度（纯探测值，不消耗配额）
 * @returns true = 投递；false = 不投递（不消耗配额、不落主动通道，须抛
 *   BlockNotDeliveredError 告知框架「未送达」）
 */
export function shouldDeliverBlockText(remaining: number): boolean {
  return remaining > BLOCK_QUOTA_RESERVE;
}

/**
 * 中间块**未送达**（被动配额耗尽）。
 *
 * ## 为什么必须抛错而不是静默返回
 *
 * 框架对块的投递默认记为 `outcome: "delivered"`（openclaw dist
 * `dispatch-from-config.payloads-*.mjs` 的 `deliverBlockReply`：无 settlement
 * 时取默认值）。一旦插件静默返回，框架就认为**这块已经送达**：
 *
 * - 它的 `hasSentPayload()` 判定「已投递块的合并源文本 == final 文本」→ true
 * - 于是**携带全文的 final 被一并丢弃**（`agent-runner` 的
 *   `contentSuppressedPayloads`）
 * - 结果：**正文永久丢失**——用户只看到前面的块，terminal 块那段内容消失
 *
 * 抛错让框架记为 `failed-deliver`（`resolveReplyDispatchErrorOutcome`），
 * 该块不计入「已投递」，final 就会补发全文兜底（框架的块回复管线会 catch
 * 住这个错误并继续，turn 不受影响）。
 */
export class BlockNotDeliveredError extends Error {
  constructor(readonly reason: string) {
    super(`block not delivered: ${reason}`);
    this.name = 'BlockNotDeliveredError';
  }
}
