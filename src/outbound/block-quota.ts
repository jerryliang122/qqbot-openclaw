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
 * **为最终回复预留 1 条槽位**，额度不足时直接丢弃该中间块。
 *
 * 丢弃中间块不丢内容——最终回复仍携带完整正文送达，用户看到的只是
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
 * @returns true = 投递；false = 丢弃（不消耗配额、不落主动通道）
 */
export function shouldDeliverBlockText(remaining: number): boolean {
  return remaining > BLOCK_QUOTA_RESERVE;
}
