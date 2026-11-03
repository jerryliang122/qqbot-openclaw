/**
 * 入站 msgId 接收时刻登记表（2026-11-03 起不再是锚点池）。
 *
 * 现存职责：
 * - `cacheMsgId`（event-handlers 入站调用）：登记每条入站消息的平台事件
 *   时间戳，并 `registerMsgIdWindow` 预注册配额窗口（幂等，防重复推送
 *   重置）。
 * - `peekMsgIdReceivedAt`：**显式锚点**消耗配额时「诚实重建」窗口的接收
 *   时刻来源（outbound-adapter / outbound-service 三处消费）——条目被
 *   容量控制淘汰后重建窗口仍锚定真实接收时刻，不超出平台窗口。
 * - `evictMsgId`：平台判死锚点（40034005/40034128）后的登记簿记。
 *
 * 历史红线：**本文件曾提供 `selectMsgIdForPassiveReply`（旧配额优先的
 * 池化锚点选取），已移除，禁止恢复**。平台语义上携带 msg_id 的被动消息
 * = 「对用户消息的回复」（官方《消息收发概述》），把无上下文发送挂到更早
 * 的入站消息上等于把回复引用挂错消息。池化当年为省每日主动预算引入
 * （7a59a2c → e3e2be7 演进），2026-11-03 按「显式锚点 or 主动」模型移除。
 *
 * 时钟：条目 timestamp 存**平台事件时间**（Date.parse(平台事件 timestamp)，
 * 缺失时回退本地时钟），与 quota-manager 的配额窗口共用
 * PLATFORM_PASSIVE_WINDOW——两层窗口同源同起点；比对仍用本地时钟
 * （本地与平台若有偏差 Δ，判定会等量放宽/收紧 Δ）。
 */

import {
  registerMsgIdWindow,
} from './quota-manager.js';

interface CachedMsgId {
  msgId: string;
  /** 平台事件时间（ms）；平台 timestamp 缺失时为本地接收时间 */
  timestamp: number;
}

const MAX_PER_TARGET = 10;
const MAX_TARGETS = 200;

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
 * 从登记表剔除指定 msgId——平台 40034005（msg_id 已过期）/40034128
 * （回复次数超限）判死后调用（登记簿记；本文件已不参与锚点选取）。
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

/**
 * 查询某 msgId 的登记接收时间（原始 timestamp，不做 TTL 过滤）——
 * 显式锚点配额条目缺失（容量淘汰等）重建窗口时用：窗口起点取真实接收
 * 时刻而非当下（诚实重建，防重建窗口超出平台窗口）。
 */
export function peekMsgIdReceivedAt(scope: string, targetId: string, msgId: string): number | undefined {
  const list = cache.get(`${scope}:${targetId}`);
  if (!list) return undefined;
  return list.find((e) => e.msgId === msgId)?.timestamp;
}

export function clearMsgIdCache(scope: string, targetId: string): void {
  cache.delete(`${scope}:${targetId}`);
}
