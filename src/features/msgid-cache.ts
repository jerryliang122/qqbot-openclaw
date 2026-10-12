/**
 * 消息 ID 缓存 — 记录最近处理的 msgId，供被动回复锚定使用。
 *
 * 场景：外部调用发送消息时没有上下文（message 工具 / 框架直发路径），
 * 从缓存按「旧配额优先」选取被动回复锚点（selectMsgIdForPassiveReply）。
 *
 * 时钟：条目 timestamp 存**平台事件时间**（Date.parse(平台事件 timestamp)，
 * 缺失时回退本地时钟），TTL 判定与 quota-manager 的配额窗口共用
 * PLATFORM_PASSIVE_WINDOW——两层窗口同源，免疫本地时钟偏差。
 */

import {
  PLATFORM_PASSIVE_WINDOW,
  getPassiveReplyQuotaRemaining,
  registerMsgIdWindow,
} from './quota-manager.js';

interface CachedMsgId {
  msgId: string;
  /** 平台事件时间（ms）；平台 timestamp 缺失时为本地接收时间 */
  timestamp: number;
}

const MAX_PER_TARGET = 10;
const MAX_TARGETS = 200;

/** scope → 平台被动回复窗口（c2c 60min / group 5min） */
const ttlForScope = (scope: string): number =>
  scope === 'group' ? PLATFORM_PASSIVE_WINDOW.group : PLATFORM_PASSIVE_WINDOW.c2c;

const cache = new Map<string, CachedMsgId[]>();

export function cacheMsgId(
  scope: string,
  targetId: string,
  msgId: string,
  opts?: { accountId?: string; receivedAt?: number },
): void {
  if (!scope || !targetId || !msgId) return;
  const receivedAt = opts?.receivedAt ?? Date.now();
  const key = `${scope}:${targetId}`;
  const existing = cache.get(key);
  if (existing) {
    // LRU: 删除再重新插入
    cache.delete(key);
    existing.push({ msgId, timestamp: receivedAt });
    if (existing.length > MAX_PER_TARGET) existing.shift();
    cache.set(key, existing);
  } else {
    cache.set(key, [{ msgId, timestamp: receivedAt }]);
    if (cache.size > MAX_TARGETS) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }

  // 同步预注册配额窗口（receivedAt 起算平台窗口）——与缓存条目同一时钟；
  // 幂等，重复推送不重置窗口
  if (opts?.accountId && (scope === 'c2c' || scope === 'group')) {
    registerMsgIdWindow({ accountId: opts.accountId, msgId, scope, receivedAt });
  }
}

/**
 * 无显式锚点时的被动锚点选取（旧配额优先）。
 *
 * 候选按接收时间**从旧到新**遍历，返回第一条「平台窗口未过期 且 剩余被动
 * 额度 > 0」的 msgId：旧配额最先过期、先用先耗尽，为最新消息保留完整额度
 * 做它自己 turn 的显式锚点回复。纯探测不消耗——消耗由调用方的原子
 * checkAndConsumePassiveReplyQuota 完成。无合格候选返回 undefined（降级主动）。
 */
export function selectMsgIdForPassiveReply(params: {
  accountId: string;
  scope: 'c2c' | 'group';
  targetId: string;
}): string | undefined {
  const { accountId, scope, targetId } = params;
  const list = cache.get(`${scope}:${targetId}`);
  if (!list || list.length === 0) return undefined;

  const now = Date.now();
  const ttl = ttlForScope(scope);
  // 从旧到新：第一个窗口内且有余量的候选
  for (let i = 0; i < list.length; i++) {
    const candidate = list[i];
    if (now - candidate.timestamp >= ttl) continue; // 平台窗口已过，跳过
    if (getPassiveReplyQuotaRemaining({ accountId, msgId: candidate.msgId, scope }) <= 0) continue;
    return candidate.msgId;
  }
  return undefined;
}

/**
 * 从候选列表剔除指定 msgId——平台 40034005（msg_id 已过期）/40034128
 * （回复次数超限）判死后调用，防止死锚点被再次选中。
 */
export function evictMsgId(scope: string, targetId: string, msgId: string): void {
  const key = `${scope}:${targetId}`;
  const list = cache.get(key);
  if (!list) return;
  const idx = list.findIndex((e) => e.msgId === msgId);
  if (idx >= 0) {
    list.splice(idx, 1);
    if (list.length === 0) cache.delete(key);
    else cache.set(key, list);
  }
}

export function clearMsgIdCache(scope: string, targetId: string): void {
  cache.delete(`${scope}:${targetId}`);
}
