/**
 * partial 态中间块的被动配额策略
 *
 * ## 背景：QQ 平台被动回复配额很紧
 *
 * QQ 对**每条用户消息**的被动回复条数有限（c2c 4 条 / 群 5 条），且
 * **typing 指示器与回复消息共享同一份额度**——模型首字节慢的时候，typing
 * 续期会先吃掉好几条。2026-10-23 真机实测：模型首字节耗时 42s，typing 续了
 * 3 次，被动额度只剩 1 条。
 *
 * ## 铁律：承载正文的块**绝不能丢**
 *
 * partial 态下块承载的就是正文（final 与块的合并源文本相等时框架会自动丢弃
 * final，不额外占配额）。一旦把承载全文的终态块丢掉，无论用哪种方式上报，
 * **携带全文的 final 都会被一并丢弃**：
 *
 * - 静默返回 → 框架记 `outcome:"delivered"` → `hasSentPayload()` 判定
 *   「已投递块的合并源文本 == final 文本」→ final 被丢
 * - 抛错上报未送达 → 框架记 `outcome:"failed-deliver"`；而
 *   `shouldRetryReplyDispatch()` 的可重试集合里**没有** `failed-deliver`
 *   → `hasBlockReplyDeliveryCustody()` 判定该块「仍有投递托管权」→
 *   `isFinalPayloadRetryBlocked()` 为真 → `preserveUnsentMediaAfterBlockSend()`
 *   返回 null → final 被丢
 *
 * 两条路实测都导致**用户完全收不到回复**（2026-10-23 真机复现）。
 *
 * ## 因此：配额不足时**降级为主动发送**，不丢块
 *
 * 主动发送不带 msg_id，会烧每日 1000 条的主动预算——但**内容送达优先于预算**：
 * 少一条正文比少一次主动预算严重得多。
 *
 * 注意与 progress card 的区别：卡片是**可选**的进度提示，所以它仍然
 * `passiveOnly` + 直接丢弃（绝不烧主动预算）；正文块则必须送达。
 */

/**
 * 为最终回复预留的被动配额槽位。
 *
 * partial 态下 final 通常被框架自动丢弃（块已承载全文），**不额外占配额**，
 * 所以这里不预留——预留反而会让唯一的额度被空转。
 *
 * 仅当 final 带了 usage footer（`/usage` 开启）时 final 才会被保留并占 1 条；
 * 那时 final 会降级为主动发送，footer 依然送达。
 */
export const BLOCK_QUOTA_RESERVE = 0;

/**
 * 该 msg_id 是否还有被动配额可用。
 *
 * @param remaining 该 msg_id 剩余的被动回复额度（纯探测值，不消耗配额）
 * @returns true = 有被动槽（走被动回复，锚定 msg_id）；false = 只能主动发送
 */
export function hasPassiveBlockSlot(remaining: number): boolean {
  return remaining > BLOCK_QUOTA_RESERVE;
}

/**
 * 平台「确定性拒绝」业务码集合：内容**明确未投递**。
 *
 * - 40034005：回复消息 msg_id 已过期
 * - 40034128：回复次数超限
 *
 * 与 `src/gateway/qqbot-gateway.ts` 的 `ANCHOR_DEAD_CODES` 同源。
 */
const DETERMINISTIC_REJECT_BIZ_CODES = new Set<number>([40034005, 40034128]);

/**
 * 判断一次发送是否**确定未投递**（可以安全地告诉上游「这块没发出去」）。
 *
 * 判定为「确定未投递」的情形只有两种：
 * - 平台**明确拒绝**（业务码 40034005 / 40034128）——内容没到，重发无重复风险
 * - 网关根本没注册（`Bot "x" not running`）——连发都没发起
 *
 * **不包含歧义失败**（网络中断 / 30s 超时 / httpStatus===0）——那些可能**已经**
 * 发出去了，此时上报「未投递」会让上游重投 → 用户收到两条。
 */
export function isDefinitelyNotDispatched(result: { error?: string; qqBizCode?: number }): boolean {
  if (typeof result.qqBizCode === 'number' && DETERMINISTIC_REJECT_BIZ_CODES.has(result.qqBizCode)) {
    return true;
  }
  // notRunningError(accountId) → `Bot "x" not running (running accounts: ...)`
  return /^Bot ".*" not running/.test(result.error ?? '');
}
