/**
 * QQBot 被动回复配额管理（反应式模型，2026-11-03）
 *
 * 平台事实（2026-11-02 探针实测，官方 WebSocket + 撤回接口自证）：
 * - 官方文档写「单聊 4 次/msg_id、群 5 次/msg_id」，但**平台并不执行**——
 *   同一 msg_id 连发 25 次被动回复全部送达，25s 慢速间隔复测同样全过；
 *   typing（msg_type=6）也不占回复额度（20 次 typing + 5 次回复全过）。
 * - 平台真实硬约束只有两个：
 *   ① msg_id 时效窗口（c2c 60min / group 5min，过期 40034005 确定性拒绝）
 *   ② msg_id + msg_seq 唯一性（重复 → 40054005）
 *
 * 反应式模型：
 * - 本地**不再**以「次数耗尽」阻断被动发送——count 仅作观测（超文档上限
 *   打一次 INFO 留证，供平台未来收紧时定位）。此前本地 preemptive 阻断
 *   是替平台做决定：逼正文降级主动、白烧每日 1000 条主动预算，还会让
 *   进度卡被静默跳过。
 * - 本地仍强制的两个约束：TTL 窗口预检（40034005 确定性拒绝，预检省一次
 *   必败请求）与 msg_seq 单调发号（40054005 硬错误，不可本地跳过）。
 * - 平台若真的拒绝（40034005/40034128），由网关 retryOnDeadAnchor 剔除
 *   死锚点并同内容转主动重发一次（gateway/qqbot-gateway.ts）。
 *
 * 窗口口径：过期窗口以**平台事件 timestamp**（消息产生时刻）起算——入站
 * 登记时经 registerMsgIdWindow 预注册（幂等）。窗口起点锚定平台时间、不随
 * 「首次消耗时刻」漂移；但比对仍用本地时钟——本地与平台若有偏差 Δ，
 * 判定会等量放宽/收紧 Δ（并非与本地时钟无关）。
 *
 * 使用方式：
 * 1. 消耗（含 msg_seq 发号）：checkAndConsumePassiveReplyQuota（失败用
 *    rollback 回滚观测计数；TTL/死锚点拒绝时 canReply=false）
 * 2. 存活探测（不消耗）：checkPassiveReplyQuota（typing 等）
 */

import type { QuotaState, QuotaCheckParams } from '../types-plugin.js';

const quotaCache = new Map<string, QuotaState>();
const MAX_CACHE_SIZE = 10000;

const QUOTA_LIMITS = {
  /**
   * 文档口径的回复次数上限（c2c 4 / group 5）——**仅观测用**：平台实测
   * 不执行（见文件头），count 超过该值只打一条 INFO 留证、不阻断发送。
   */
  c2c: { count: 4, ttlMs: 60 * 60 * 1000 },
  group: { count: 5, ttlMs: 5 * 60 * 1000 },
};

/**
 * 容量控制：超限时**先清扫过期条目**（窗口已过的普通条目与 dead 锚点），
 * 仍超限才按插入序 FIFO 淘汰存活条目。
 *
 * 只做 FIFO 的问题：预注册让每条入站消息都占一个条目，而 Map.set 不改变
 * 既有 key 的插入序——稳态下 FIFO 淘汰的恰是「最旧、窗口未过」的活跃锚点
 * （恰是旧配额优先策略要用的），被淘汰后消耗侧会按 now+TTL 重建窗口，
 * 起点被静默搬到当下、超出平台窗口 → 40034005。过期清扫优先 + 访问触达
 * （touchCacheEntry）让活跃条目沉到队尾，把淘汰压力集中到真正无价值的
 * 死条目上。
 */
function enforceCacheCapacity(now: number): void {
  if (quotaCache.size <= MAX_CACHE_SIZE) return;
  for (const [key, state] of quotaCache) {
    if (now > state.expiresAt) quotaCache.delete(key);
  }
  while (quotaCache.size > MAX_CACHE_SIZE) {
    const oldestKey = quotaCache.keys().next().value;
    if (!oldestKey) break;
    quotaCache.delete(oldestKey);
  }
}

/** LRU 触达：delete+重插把条目沉到插入序队尾（活跃锚点不被 FIFO 优先淘汰） */
function touchCacheEntry(key: string, entry: QuotaState): void {
  quotaCache.delete(key);
  quotaCache.set(key, entry);
}

/**
 * 平台被动回复窗口（自消息接收时刻起算）——与 msgid-cache 的候选 TTL 判定
 * 共用同一常量，防止两层窗口口径漂移。
 */
export const PLATFORM_PASSIVE_WINDOW = {
  c2c: QUOTA_LIMITS.c2c.ttlMs,
  group: QUOTA_LIMITS.group.ttlMs,
} as const;

/**
 * 入站消息登记时预注册配额窗口（幂等：已有条目不覆盖）。
 *
 * 把过期窗口锚定到**消息接收时刻**（receivedAt = Date.parse(平台事件 timestamp)，
 * 缺失时调用方传 Date.now()），而非首次消耗时刻——修复旧实现「首耗晚于接收时
 * 本地窗口超出平台窗口」的缺陷。重复推送不会重置窗口。
 */
export function registerMsgIdWindow(params: {
  accountId: string;
  msgId: string;
  scope: 'c2c' | 'group';
  receivedAt: number;
}): void {
  const { accountId, msgId, scope, receivedAt } = params;
  if (!msgId) return;
  const key = `${accountId}:${scope}:${msgId}`;
  if (quotaCache.has(key)) return; // 幂等：不覆盖既有窗口/计数

  quotaCache.set(key, {
    count: 0,
    seq: 0,
    expiresAt: receivedAt + QUOTA_LIMITS[scope].ttlMs,
  });

  // 缓存大小控制：过期清扫优先，FIFO 兜底（见 enforceCacheCapacity）
  enforceCacheCapacity(Date.now());
}

/**
 * 锚点存活探测（纯探测，不消耗、不发号）。
 *
 * 反应式模型下只判两件事：TTL 窗口（c2c 60min / group 5min，过期 =
 * 平台 40034005 确定性拒绝，本地预检省一次必败请求）与死锚点（平台
 * 40034128/40034005 判死后登记）。**不判次数**——平台实测不执行文档
 * 口径的 4/5 次上限（见文件头）。typing 等非正文发送用它决定是否带
 * msg_id；需要发号的正文发送用 checkAndConsumePassiveReplyQuota。
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
    // 这是 QQ Bot 平台限制，API 会返回错误 40034005
    if (now > cached.expiresAt) {
      quotaCache.delete(key);
      return false;
    }

    // 死锚点（平台判死）等同耗尽
    if (cached.dead) {
      return false;
    }

    // LRU 触达：被探测的活跃锚点沉到队尾
    touchCacheEntry(key, cached);
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
  if (cached && !cached.dead && cached.count > 0) {
    cached.count -= 1;
    touchCacheEntry(key, cached);
  }
}

/**
 * 原子操作：检查并消耗被动回复配额（含 msg_seq 发号）
 *
 * 反应式模型下「检查」只判 TTL 窗口与死锚点（不判次数）；count 仅观测
 * 计数。消耗成功时同时为该 msg_id 发号 msg_seq（单调递增、从不回滚——
 * 浪费序号无害，相同 msg_id+msg_seq 精确重复才是平台硬错误 40054005）。
 */
export function checkAndConsumePassiveReplyQuota(
  params: QuotaCheckParams & {
    log?: { debug?: (message: string) => void; info?: (message: string) => void };
    /**
     * 该 msg_id 的接收时刻（msgid-cache 登记的平台事件时间）。条目缺失
     * （被容量控制淘汰等）重建窗口时以此为起点——**诚实重建**：窗口仍是
     * 「接收时刻 + 平台窗口」，不再无声以当下起算（那会超出平台窗口，
     * 平台 40034005 拒绝）。缺省时保留旧兜底 now+TTL（调用方无从得知
     * 接收时间的场景），并打 DEBUG 留痕。
     */
    receivedAt?: number;
  },
): { canReply: boolean; seq: number; rollback: () => void } {
  const { accountId, msgId, scope, log, receivedAt } = params;

  if (!msgId) {
    log?.debug?.(`[${accountId}] passive quota check without msgId (proactive path) scope=${scope}`);
    return { canReply: false, seq: 0, rollback: () => {} };
  }

  const key = `${accountId}:${scope}:${msgId}`;
  const now = Date.now();
  const ttl = QUOTA_LIMITS[scope].ttlMs;

  let cached = quotaCache.get(key);

  // 检查过期：msg_id 过期后不能用于被动回复
  // 这是 QQ Bot 平台限制，API 会返回错误 40034005
  if (cached && now > cached.expiresAt) {
    // msg_id 已过期，不能用于被动回复（降级决策的日志在 adapter/gateway 层）
    log?.debug?.(`[${accountId}] passive quota denied (expired): ${key}`);
    return { canReply: false, seq: 0, rollback: () => {} };
  }

  // 检查死锚点（平台已判死，永不再挂接——rollback 也不得复活）
  if (cached && cached.dead) {
    log?.debug?.(`[${accountId}] passive quota denied (dead anchor): ${key}`);
    return { canReply: false, seq: 0, rollback: () => {} };
  }

  // 条目缺失（容量淘汰/未预注册）时重建窗口：有 receivedAt 用真实接收时刻
  // （诚实重建），否则旧兜底 now+TTL——非无声，DEBUG 留痕。重建出的窗口
  // 同样要过校验：接收时刻起算已超窗的（如条目被淘汰后残留的旧锚点）
  // 直接拒绝，不得以「当下起算」放行。注意重建会把 seq 归零（锚点失效
  // 兜底自愈，见 AGENTS.md「出站与配额」）
  if (!cached) {
    const expiresAt = (receivedAt ?? now) + ttl;
    if (now > expiresAt) {
      log?.debug?.(
        `[${accountId}] passive quota denied (expired by receivedAt rebuild): ${key}`,
      );
      return { canReply: false, seq: 0, rollback: () => {} };
    }
    cached = { count: 0, seq: 0, expiresAt };
    log?.debug?.(
      `[${accountId}] quota entry missing, rebuilding window: ${key} from=${receivedAt ? 'receivedAt' : 'now(legacy)'}`,
    );
  }
  cached.count += 1;
  cached.seq = (cached.seq ?? 0) + 1;
  // LRU 触达：消耗中的锚点沉到队尾，不被容量控制优先淘汰
  touchCacheEntry(key, cached);

  // 缓存大小控制：过期清扫优先，FIFO 兜底
  enforceCacheCapacity(now);

  // 超限观测（一次性）：count 超过文档口径上限不阻断（平台实测不执行，
  // 见文件头），但打一条 INFO 留证——若平台未来收紧，这是定位一线证据
  const limit = QUOTA_LIMITS[scope].count;
  if (cached.count > limit && !cached.overLimitLogged) {
    cached.overLimitLogged = true;
    log?.info?.(
      `[${accountId}] passive reply count ${cached.count} exceeded documented limit ${limit} (${scope}); ` +
        'platform probe 2026-11-02 showed the cap is not enforced — continuing passively',
    );
  }

  log?.debug?.(`[${accountId}] consumed passive quota: ${key} count=${cached.count} seq=${cached.seq}`);

  // 返回回滚函数（只回滚 count，不回滚 seq；死锚点不回滚——invalidate
  // 判死后 count 不得经回滚复活）
  const rollback = () => {
    const state = quotaCache.get(key);
    if (state && !state.dead && state.count > 0) {
      state.count -= 1;
      touchCacheEntry(key, state);
    }
  };

  return { canReply: true, seq: cached.seq, rollback };
}

/**
 * 将某 msg_id 配额标记为死锚点（dead=true）——平台 40034005（msg_id 已
 * 过期）/40034128（回复次数超限）判死后调用：该锚点永不再被选取/允许
 * 消耗，rollback 也无法复活（防上游发送失败的补偿回滚把死锚点再次挂接、
 * 再吃一次平台确定性拒绝）。count 同步封顶到文档上限（观测口径对齐
 * 「耗尽」；反应式模型下 count 无阻断作用）。不删条目（保留 seq 与窗口
 * 现场便于排障）。
 */
export function invalidateMsgIdQuota(params: {
  accountId: string;
  msgId: string;
  scope: 'c2c' | 'group';
}): void {
  const { accountId, msgId, scope } = params;
  const key = `${accountId}:${scope}:${msgId}`;
  const cached = quotaCache.get(key);
  if (!cached) return;
  cached.dead = true;
  cached.count = QUOTA_LIMITS[scope].count;
  quotaCache.set(key, cached);
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
    // 预注册（registerMsgIdWindow）会产生大量 count=0 条目；
    // 只统计真正消耗过的会话，防统计口径膨胀
    if (key.startsWith(`${accountId}:${scope}:`) && state.count > 0) {
      activeSessions += 1;
      totalUsage += state.count;
    }
  }

  return { activeSessions, totalUsage };
}

export function __test_getQuotaCache(): Map<string, QuotaState> {
  return quotaCache;
}
