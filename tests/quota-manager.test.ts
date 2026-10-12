import { strict as assert } from 'assert';
import {
  checkPassiveReplyQuota,
  checkAndConsumePassiveReplyQuota,
  rollbackPassiveReplyQuota,
  inferQQBotScope,
  clearQuotaCache,
  registerMsgIdWindow,
  getPassiveReplyQuotaRemaining,
  invalidateMsgIdQuota,
  getQuotaStats,
  PLATFORM_PASSIVE_WINDOW,
  __test_getQuotaCache,
} from '../src/features/quota-manager.js';

function test(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => console.log(`✓ ${name}`)).catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

// 清理缓存
clearQuotaCache();

await test('inferQQBotScope: C2C', () => {
  const scope = inferQQBotScope('qqbot:c2c:user123');
  assert(scope === 'c2c');
});

await test('inferQQBotScope: Group', () => {
  const scope = inferQQBotScope('qqbot:group:group456');
  assert(scope === 'group');
});

await test('checkPassiveReplyQuota: 初始状态允许', async () => {
  const canReply = await checkPassiveReplyQuota({
    accountId: 'test-account',
    msgId: 'test-msg-1',
    scope: 'c2c',
  });
  assert(canReply === true);
});

await test('checkAndConsumePassiveReplyQuota: C2C 配额消耗至上限', async () => {
  clearQuotaCache();
  const accountId = 'test-account-2';
  const msgId = 'test-msg-2';

  // 消耗 4 次（C2C 上限），前 4 次均允许
  for (let i = 0; i < 4; i++) {
    const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
    assert(canReply === true, `attempt ${i + 1} should be allowed`);
  }

  // 第 5 次 check 应该失败
  const canReply = await checkPassiveReplyQuota({
    accountId,
    msgId,
    scope: 'c2c',
  });
  assert(canReply === false);
});

await test('rollbackPassiveReplyQuota: 回滚后配额恢复', async () => {
  clearQuotaCache();
  const accountId = 'test-account-rollback';
  const msgId = 'test-msg-rollback';

  for (let i = 0; i < 4; i++) {
    checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  }
  rollbackPassiveReplyQuota({ accountId, msgId, scope: 'c2c' });

  const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert(canReply === true, 'quota should be restored after rollback');
});

await test('checkPassiveReplyQuota: 无 msgId 时返回 false', async () => {
  const canReply = await checkPassiveReplyQuota({
    accountId: 'test-account-3',
    msgId: undefined,
    scope: 'c2c',
  });
  assert(canReply === false);
});

await test('checkPassiveReplyQuota: 过期配额返回 false', async () => {
  clearQuotaCache();
  const accountId = 'test-account-expired';
  const msgId = 'test-msg-expired';

  checkAndConsumePassiveReplyQuota({
    accountId,
    msgId,
    scope: 'c2c',
  });

  const stats = { accountId, msgId, scope: 'c2c' as const };
  const canReplyBefore = await checkPassiveReplyQuota(stats);
  assert(canReplyBefore === true, 'Active quota should allow reply');

  const quotaCache = __test_getQuotaCache();
  const key = `${accountId}:c2c:${msgId}`;
  const cached = quotaCache.get(key);
  if (cached) {
    cached.expiresAt = Date.now() - 1;
  }

  const canReplyAfter = await checkPassiveReplyQuota(stats);
  assert(canReplyAfter === false, 'Expired quota should NOT allow passive reply');
});

// ── 平台时钟窗口预注册 ──

await test('registerMsgIdWindow: 过期窗口自接收时刻起算（未消耗也拒绝）', () => {
  clearQuotaCache();
  const accountId = 'test-account-window';
  const msgId = 'test-msg-window';
  // 接收于 61 分钟前（c2c 窗口 60min）：即便从未消耗过配额，窗口也已过
  registerMsgIdWindow({
    accountId,
    msgId,
    scope: 'c2c',
    receivedAt: Date.now() - PLATFORM_PASSIVE_WINDOW.c2c - 60_000,
  });
  const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(canReply, false, '窗口已过（按接收时刻）应拒绝，即使 count=0');

  const remaining = getPassiveReplyQuotaRemaining({ accountId, msgId, scope: 'c2c' });
  assert.equal(remaining, 0, '过期条目剩余额度应为 0');
});

await test('registerMsgIdWindow: 幂等——重复登记不重置窗口/计数', () => {
  clearQuotaCache();
  const accountId = 'test-account-idem';
  const msgId = 'test-msg-idem';
  const oldReceived = Date.now() - 30 * 60_000;
  registerMsgIdWindow({ accountId, msgId, scope: 'c2c', receivedAt: oldReceived });
  const { canReply: c1 } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(c1, true);
  // 重复推送同一 msg_id：窗口不应被推后、计数不应被清零
  registerMsgIdWindow({ accountId, msgId, scope: 'c2c', receivedAt: Date.now() });
  const cache = __test_getQuotaCache();
  const entry = cache.get(`${accountId}:c2c:${msgId}`);
  assert.ok(entry);
  assert.equal(entry!.count, 1, '重复登记不应清零已消耗计数');
  assert.ok(entry!.expiresAt <= oldReceived + PLATFORM_PASSIVE_WINDOW.c2c + 1, '重复登记不应推后窗口');
});

await test('registerMsgIdWindow: 群 5 分钟窗口（接收时刻起算）', () => {
  clearQuotaCache();
  const accountId = 'test-account-gwin';
  const msgId = 'test-msg-gwin';
  registerMsgIdWindow({
    accountId,
    msgId,
    scope: 'group',
    receivedAt: Date.now() - PLATFORM_PASSIVE_WINDOW.group - 1_000,
  });
  const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'group' });
  assert.equal(canReply, false, '群消息接收超过 5 分钟应拒绝');
});

// ── msg_seq 发号 ──

await test('checkAndConsumePassiveReplyQuota: 连续消耗发号 1,2,3…', () => {
  clearQuotaCache();
  const accountId = 'test-account-seq';
  const msgId = 'test-msg-seq';
  const seqs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const { canReply, seq } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
    assert.equal(canReply, true);
    seqs.push(seq);
  }
  assert.deepEqual(seqs, [1, 2, 3], 'seq 应从 1 起单调递增');
});

await test('rollback 只回滚 count，seq 不回退', () => {
  clearQuotaCache();
  const accountId = 'test-account-seq-rb';
  const msgId = 'test-msg-seq-rb';
  const first = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(first.seq, 1);
  first.rollback(); // 模拟 API 失败
  const second = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(second.canReply, true, 'count 回滚后配额应恢复');
  assert.equal(second.seq, 2, 'seq 单调不回退（防同 msg_id+msg_seq 精确重复）');
});

await test('invalidateMsgIdQuota: 锚点判死后永不再可用', () => {
  clearQuotaCache();
  const accountId = 'test-account-inv';
  const msgId = 'test-msg-inv';
  invalidateMsgIdQuota({ accountId, msgId, scope: 'group' });
  // 未预注册时 invalidate 为 no-op——先注册再作废
  registerMsgIdWindow({ accountId, msgId, scope: 'group', receivedAt: Date.now() });
  invalidateMsgIdQuota({ accountId, msgId, scope: 'group' });
  const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'group' });
  assert.equal(canReply, false, '判死锚点应视为已耗尽');
  assert.equal(getPassiveReplyQuotaRemaining({ accountId, msgId, scope: 'group' }), 0);
});

await test('invalidate 后 rollback 不得复活死锚点（dead 标记）', () => {
  clearQuotaCache();
  const accountId = 'test-account-dead-rb';
  const msgId = 'test-msg-dead-rb';
  // 模拟真实链路：adapter 消耗成功（拿到 rollback）→ 平台判死锚点 invalidate
  // → 主动重发也失败 → 上游补偿 rollback()——不得把 count 减回 limit 以下
  const { rollback } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  invalidateMsgIdQuota({ accountId, msgId, scope: 'c2c' });
  rollback();
  rollbackPassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(
    getPassiveReplyQuotaRemaining({ accountId, msgId, scope: 'c2c' }),
    0,
    '回滚后死锚点仍应无额度',
  );
  const again = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(again.canReply, false, '死锚点经回滚不得复活');
  assert.equal(checkPassiveReplyQuota({ accountId, msgId, scope: 'c2c' }), false);
});

await test('getQuotaStats: 预注册的 count=0 条目不计入统计', () => {
  clearQuotaCache();
  const accountId = 'test-account-stats';
  registerMsgIdWindow({ accountId, msgId: 'm-zero', scope: 'c2c', receivedAt: Date.now() });
  registerMsgIdWindow({ accountId, msgId: 'm-used', scope: 'c2c', receivedAt: Date.now() });
  checkAndConsumePassiveReplyQuota({ accountId, msgId: 'm-used', scope: 'c2c' });

  const stats = getQuotaStats(accountId, 'c2c');
  assert.equal(stats.activeSessions, 1, '只统计 count>0 的会话');
  assert.equal(stats.totalUsage, 1);
});

// ── 容量控制（过期清扫优先 + LRU 触达）与诚实重建 ──

await test('容量控制：超限先清扫过期条目，早期活跃窗口不被 FIFO 淘汰', () => {
  clearQuotaCache();
  const accountId = 'test-account-evict';
  // 活跃锚点 L：先登记、先消耗一次（count=1，剩余 3）
  registerMsgIdWindow({ accountId, msgId: 'LIVE', scope: 'c2c', receivedAt: Date.now() });
  const c1 = checkAndConsumePassiveReplyQuota({ accountId, msgId: 'LIVE', scope: 'c2c' });
  assert.equal(c1.canReply, true);

  // 涌入大量「已过期」条目（receivedAt = 61min 前）——只做 FIFO 会把
  // 插入序最老的 LIVE 淘汰掉；过期清扫优先应保住它
  const old = Date.now() - PLATFORM_PASSIVE_WINDOW.c2c - 60_000;
  for (let i = 0; i < 10_060; i++) {
    registerMsgIdWindow({ accountId, msgId: `EXP_${i}`, scope: 'c2c', receivedAt: old });
  }

  // 判别：条目若被淘汰，探测会按「无条目=满额」返回 4；存活则 count 保留、剩余 3
  const remaining = getPassiveReplyQuotaRemaining({ accountId, msgId: 'LIVE', scope: 'c2c' });
  assert.equal(remaining, 3, '活跃锚点应经清扫存活（count 保留）');

  // 过期条目应已被清扫而非堆积
  const cache = __test_getQuotaCache();
  assert.ok(cache.size < 10_060, `过期条目应被清扫而非保留（实际 size=${cache.size}）`);
});

await test('LRU 触达：消耗把条目沉到插入序队尾', () => {
  clearQuotaCache();
  const accountId = 'test-account-lru';
  registerMsgIdWindow({ accountId, msgId: 'LRU_A', scope: 'c2c', receivedAt: Date.now() });
  registerMsgIdWindow({ accountId, msgId: 'LRU_B', scope: 'c2c', receivedAt: Date.now() });

  // Map.set 不改变既有 key 的插入序；消耗（触达）应把 A 沉到队尾
  checkAndConsumePassiveReplyQuota({ accountId, msgId: 'LRU_A', scope: 'c2c' });
  getPassiveReplyQuotaRemaining({ accountId, msgId: 'LRU_A', scope: 'c2c' });

  const keys = [...__test_getQuotaCache().keys()];
  assert.equal(keys[0], `${accountId}:c2c:LRU_B`, '未触达的 B 应在队首');
  assert.equal(keys[keys.length - 1], `${accountId}:c2c:LRU_A`, '触达过的 A 应沉到队尾');
});

await test('诚实重建：条目缺失时按 receivedAt 重建窗口（非当下起算）', () => {
  clearQuotaCache();
  const accountId = 'test-account-rebuild';

  // 条目缺失 + receivedAt 已超窗口（61min 前）→ 拒绝，而非 now+60min 放行
  const denied = checkAndConsumePassiveReplyQuota({
    accountId,
    msgId: 'RB_OLD',
    scope: 'c2c',
    receivedAt: Date.now() - PLATFORM_PASSIVE_WINDOW.c2c - 60_000,
  });
  assert.equal(denied.canReply, false, 'receivedAt 超窗口应拒绝（诚实重建）');

  // 条目缺失 + receivedAt 在窗口内（5min 前）→ 允许
  const allowed = checkAndConsumePassiveReplyQuota({
    accountId,
    msgId: 'RB_FRESH',
    scope: 'c2c',
    receivedAt: Date.now() - 5 * 60_000,
  });
  assert.equal(allowed.canReply, true);
  assert.equal(allowed.seq, 1);

  // 无 receivedAt（调用方无从得知接收时间）→ 旧兜底 now+TTL 放行
  const legacy = checkAndConsumePassiveReplyQuota({ accountId, msgId: 'RB_LEGACY', scope: 'c2c' });
  assert.equal(legacy.canReply, true);
});

console.log('All quota manager tests passed');
