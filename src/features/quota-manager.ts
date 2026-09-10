/**
 * QQBot 被动回复配额管理
 *
 * C2C: 4 次/msg_id, 60 分钟
 * Group: 5 次/msg_id, 5 分钟
 *
 * 重要说明：
 * - QQ Bot 平台的 msg_id 有时效性限制（C2C: 60分钟，Group: 5分钟）
 * - 过期后的 msg_id 不能再用于被动回复（API 会返回错误 40034128）
 * - 这是平台限制，不是"配额恢复"
 * - 因此 checkPassiveReplyQuota 在 msg_id 过期时返回 false，而非重置配额
 *
 * 使用方式：
 * 1. 推荐：使用 checkAndConsumePassiveReplyQuota 进行原子操作（失败用 rollback 回滚）
 * 2. 纯探测（不消耗配额）：checkPassiveReplyQuota
 */

import type { QuotaState, QuotaCheckParams } from '../types-plugin.js';

const quotaCache = new Map<string, QuotaState>();
const MAX_CACHE_SIZE = 10000;

const QUOTA_LIMITS = {
  c2c: { count: 4, ttlMs: 60 * 60 * 1000 },
  group: { count: 5, ttlMs: 5 * 60 * 1000 },
};

/**
 * 检查被动回复配额（纯探测，不消耗配额）。
 * 需要同时消耗配额时使用 checkAndConsumePassiveReplyQuota。
 */
export function checkPassiveReplyQuota(params: QuotaCheckParams): boolean {
  const { accountId, msgId, scope } = params;

  if (!msgId) {
    return false;
  }

  const key = `${accountId}:${scope}:${msgId}`;
  const now = Date.now();

  const cached = quotaCache.get(key);
  if (cached) {
    // msg_id 过期后不能再用于被动回复
    // 这是 QQ Bot 平台限制，API 会返回错误 40034128
    if (now > cached.expiresAt) {
      quotaCache.delete(key);
      return false;
    }

    const limit = QUOTA_LIMITS[scope].count;
    if (cached.count >= limit) {
      return false;
    }
  }

  return true;
}

/**
 * 回滚被动回复配额（API 调用失败时使用）
 */
export function rollbackPassiveReplyQuota(params: {
  accountId: string;
  msgId: string;
  scope: 'c2c' | 'group';
}): void {
  const { accountId, msgId, scope } = params;
  const key = `${accountId}:${scope}:${msgId}`;

  const cached = quotaCache.get(key);
  if (cached && cached.count > 0) {
    cached.count -= 1;
    quotaCache.set(key, cached);
  }
}

/**
 * 原子操作：检查并消耗被动回复配额
 * 推荐使用此函数，避免 check-then-consume 竞态
 */
export function checkAndConsumePassiveReplyQuota(
  params: QuotaCheckParams & { log?: { debug?: (message: string) => void } },
): { canReply: boolean; rollback: () => void } {
  const { accountId, msgId, scope, log } = params;

  if (!msgId) {
    log?.debug?.(`[${accountId}] passive quota check without msgId (proactive path) scope=${scope}`);
    return { canReply: false, rollback: () => {} };
  }

  const key = `${accountId}:${scope}:${msgId}`;
  const now = Date.now();
  const ttl = QUOTA_LIMITS[scope].ttlMs;

  let cached = quotaCache.get(key);

  // 检查过期：msg_id 过期后不能用于被动回复
  // 这是 QQ Bot 平台限制，API 会返回错误 40034128
  if (cached && now > cached.expiresAt) {
    // msg_id 已过期，不能用于被动回复（降级决策的日志在 adapter/gateway 层）
    log?.debug?.(`[${accountId}] passive quota denied (expired): ${key}`);
    return { canReply: false, rollback: () => {} };
  }

  // 检查配额
  const limit = QUOTA_LIMITS[scope].count;
  if (cached && cached.count >= limit) {
    log?.debug?.(`[${accountId}] passive quota denied (exhausted): ${key} count=${cached.count}/${limit}`);
    return { canReply: false, rollback: () => {} };
  }

  // 原子消耗
  cached = cached || { count: 0, expiresAt: now + ttl };
  cached.count += 1;
  quotaCache.set(key, cached);

  // 缓存大小控制
  if (quotaCache.size > MAX_CACHE_SIZE) {
    const oldestKey = quotaCache.keys().next().value;
    if (oldestKey) {
      quotaCache.delete(oldestKey);
    }
  }

  log?.debug?.(`[${accountId}] consumed passive quota: ${key} count=${cached.count}`);

  // 返回回滚函数
  const rollback = () => {
    const state = quotaCache.get(key);
    if (state && state.count > 0) {
      state.count -= 1;
      quotaCache.set(key, state);
    }
  };

  return { canReply: true, rollback };
}

export function inferQQBotScope(to: string): 'c2c' | 'group' {
  const parts = to.split(':');
  const scope = parts[1];
  return scope === 'group' ? 'group' : 'c2c';
}

export function clearQuotaCache(): void {
  quotaCache.clear();
}

export function clearQuotaCacheForAccount(accountId: string): void {
  const prefix = `${accountId}:`;
  for (const key of quotaCache.keys()) {
    if (key.startsWith(prefix)) quotaCache.delete(key);
  }
}

export function getQuotaStats(accountId: string, scope: 'c2c' | 'group'): {
  activeSessions: number;
  totalUsage: number;
} {
  let activeSessions = 0;
  let totalUsage = 0;

  for (const [key, state] of quotaCache.entries()) {
    if (key.startsWith(`${accountId}:${scope}:`)) {
      activeSessions += 1;
      totalUsage += state.count;
    }
  }

  return { activeSessions, totalUsage };
}

export function __test_getQuotaCache(): Map<string, QuotaState> {
  return quotaCache;
}
