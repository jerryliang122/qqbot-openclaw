/**
 * 被动锚点解析（msg_id 轮转）
 *
 * 背景：平台按「每条用户消息独立计数」——单聊 4 次/条、群聊 5 次/条。
 * 一条长回复被框架按 TEXT_CHUNK_LIMIT(5000) 分块后逐块发送，一轮可能产生
 * 7~8 条出站；再叠加媒体、TTS、typing 续期、progress card，单条用户消息的
 * 配额很容易被打满。旧实现只认**最新**一条 msg_id，它一耗尽就直接降级主动
 * ——而用户此前发过的、更早的 msg_id 还躺着没用的配额被白白丢弃。
 *
 * 本模块把「用哪个 msg_id」收敛成一个决策点：首选锚点（当前用户消息）
 * 优先，占不到就沿会话缓存新→旧依次轮转，全部不可用才返回 undefined，
 * 由调用方降级主动。轮转纯属配额利用率的提升——平台侧的次数/时效限制
 * 依旧由 quota-manager 按「每条 msg_id 独立」严格记账，不会因为轮转而
 * 绕过任何一条消息自身的限额。
 *
 * 三处配额决策点共用本助手：
 * - src/outbound-adapter.ts  sendTextWithQuota / sendMediaWithQuota（框架分块出站）
 * - src/outbound/outbound-service.ts  reservePassiveReply（插件内建直发）
 * - src/gateway/qqbot-gateway.ts  attachMsgIdWithQuota（无显式锚点的中间件直发）
 */

import { checkAndConsumePassiveReplyQuota } from './quota-manager.js';
import { getCachedMsgIds } from './msgid-cache.js';

/** 结构化日志（PluginLogger 天然满足，避免本模块耦合日志实现） */
interface AnchorLog {
  debug?: (message: string) => void;
  info?: (message: string) => void;
}

export interface PassiveAnchorParams {
  /** 配额记账账号（须与实际发送账号一致——见 resolveQuotaAccountId） */
  accountId: string;
  scope: 'c2c' | 'group';
  /** 会话目标 id（c2c=openid，group=group_openid），用于取缓存候选 */
  targetId: string;
  /**
   * 首选锚点：调用方已知的当前用户消息 ID。
   * 不做 TTL 校验——它来自本轮入站事件，由上游保证新鲜；TTL 判定只作用于
   * 从缓存里取的候选（那里才有接收时刻可比）。
   */
  preferredMsgId?: string;
  log?: AnchorLog;
}

export interface PassiveAnchorResult {
  /** 实际占得配额的 msg_id；undefined = 无可用被动通道，调用方应降级主动 */
  msgId?: string;
  /** API 调用失败时回滚已扣减的额度 */
  rollback: () => void;
  /** 是否发生了轮转（首选锚点被跳过，用了更旧的 msg_id） */
  rotated: boolean;
  /** 尝试过的候选总数（观测用） */
  candidates: number;
}

/**
 * 解析一条出站消息的被动锚点：首选优先，耗尽则沿缓存新→旧轮转。
 *
 * @returns 占得配额的 msgId；全部候选不可用时返回 { msgId: undefined }，
 *          调用方据此降级主动发送（宁可烧每日主动预算，也不挂过期 msg_id
 *          去撞平台的 40034005 / 40034128 硬失败）。
 */
export function resolvePassiveAnchor(params: PassiveAnchorParams): PassiveAnchorResult {
  const { accountId, scope, targetId, preferredMsgId, log } = params;

  const candidates: string[] = [];
  if (preferredMsgId) candidates.push(preferredMsgId);
  for (const id of getCachedMsgIds(scope, targetId)) {
    if (!candidates.includes(id)) candidates.push(id);
  }

  if (candidates.length === 0) {
    log?.debug?.(`[${accountId}] no passive anchor candidates (scope=${scope} target=${targetId})`);
    return { rollback: () => {}, rotated: false, candidates: 0 };
  }

  let exhausted = 0;
  for (const msgId of candidates) {
    const reservation = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope });
    if (reservation.canReply) {
      const rotated = preferredMsgId !== undefined && msgId !== preferredMsgId;
      if (rotated) {
        log?.info?.(
          `[quota] passive anchor rotated: ${preferredMsgId} exhausted → ${msgId} ` +
            `(${exhausted + 1}/${candidates.length} candidates tried)`,
        );
      }
      return { msgId, rollback: reservation.rollback, rotated, candidates: candidates.length };
    }
    exhausted += 1;
  }

  // 全部候选都拿不到配额：过期或次数用尽。降级由调用方决定。
  log?.info?.(
    `[${accountId}] [quota] no passive anchor available: ${candidates.length} candidate(s) ` +
      `exhausted or expired (scope=${scope} target=${targetId})`,
  );
  return { rollback: () => {}, rotated: false, candidates: candidates.length };
}
