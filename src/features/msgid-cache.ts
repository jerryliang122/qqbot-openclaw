/**
 * 消息 ID 缓存 — 记录最近处理的 msgId，供被动回复使用。
 *
 * 场景：外部调用发送消息时没有上下文，
 * 从缓存获取最近一条未过期的 msgId 作为被动回复目标。
 */

interface CachedMsgId {
  msgId: string;
  timestamp: number;
}

const MAX_PER_TARGET = 10;

/**
 * 缓存 TTL —— 必须**小于** quota-manager 的同名限额（见 QUOTA_LIMITS）。
 *
 * 平台被动回复窗口（QQ 官方文档，2026-09-03 版）：单聊 60 分钟 / 群聊 5 分钟。
 *
 * ⚠️ 余量怎么算：TTL 从**消息到达本进程**起算（cacheMsgId 在入站处理器里
 * 打点，见 gateway/event-handlers.ts），而平台是从**它自己的消息时间戳**起
 * 算。到达必然晚于平台打点，两者之差就是入站网络延迟（WebSocket 重连补发、
 * 网关积压、抖动可达数十秒）。所以真实余量是：
 *
 *     平台余量 = 平台窗口 − (入站延迟 + 本 TTL)
 *
 * 群聊窗口只有 5 分钟，TTL 若取 4.5 分钟，余量仅剩 30 秒——**扣掉入站延迟后
 * 可能为负**，届时会把平台已过期的 msg_id 判为可用，挂上去撞 40034005 /
 * 40034128 硬失败（无降级通道）。取 4 分钟留 60 秒，可吸收常态入站抖动。
 *
 * msg_id 踩在边界上过期没有兜底通道——宁可降级主动。
 *
 * ⚠️ 不变量：msgid-cache TTL 必须严格小于 quota TTL。二者相等或更大时，
 * quota-manager 的 expiresAt（锚点为「首次消费」时刻而非「消息接收」时刻）
 * 会把已过期的 msg_id 判为可用，挂上去就是硬失败。
 * 回归测试 tests/passive-anchor.test.ts 锁死该不变量与余量下限。
 */
const TTL_GROUP = 4 * 60 * 1000;       // 4 分钟（平台 5 分钟，留 60 秒余量）
const TTL_C2C = 55 * 60 * 1000;        // 55 分钟（平台 60 分钟，留 5 分钟余量）
const MAX_TARGETS = 200;

/** 测试用：导出台限供不变量断言 */
export const _msgidCacheTtlMs = { c2c: TTL_C2C, group: TTL_GROUP };

const cache = new Map<string, CachedMsgId[]>();

export function cacheMsgId(scope: string, targetId: string, msgId: string): void {
  if (!scope || !targetId || !msgId) return;
  const key = `${scope}:${targetId}`;
  const existing = cache.get(key);
  if (existing) {
    // LRU: 删除再重新插入
    cache.delete(key);
    existing.push({ msgId, timestamp: Date.now() });
    if (existing.length > MAX_PER_TARGET) existing.shift();
    cache.set(key, existing);
  } else {
    cache.set(key, [{ msgId, timestamp: Date.now() }]);
    if (cache.size > MAX_TARGETS) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
  }
}

export function getCachedMsgId(scope: string, targetId: string): string | undefined {
  return getCachedMsgIds(scope, targetId)[0];
}

/**
 * 取该会话所有未过期的 msg_id 候选，**按新→旧**排序。
 *
 * 被动锚点轮转用：最新一条配额耗尽时，继续尝试更旧的候选。平台按「每条
 * 消息独立计数」——A/B/C 各有 4(c2c)/5(群) 次配额，不该只吃最新一条。
 * 同一 TTL 下旧条目更早过期，故新→旧顺序同时也是「剩余有效期最长→最短」，
 * 优先用最新的可把更旧的额度留给后续出站。
 */
export function getCachedMsgIds(scope: string, targetId: string): string[] {
  const key = `${scope}:${targetId}`;
  const list = cache.get(key);
  if (!list || list.length === 0) return [];
  const now = Date.now();
  const ttl = scope === 'group' ? TTL_GROUP : TTL_C2C;
  const out: string[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (now - list[i].timestamp < ttl) {
      out.push(list[i].msgId);
    }
  }
  return out;
}

export function clearMsgIdCache(scope: string, targetId: string): void {
  cache.delete(`${scope}:${targetId}`);
}
