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

console.log('All quota manager tests passed');
