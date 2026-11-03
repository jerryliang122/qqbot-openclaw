import { strict as assert } from 'assert';
import {
  checkPassiveReplyQuota,
  checkAndConsumePassiveReplyQuota,
  inferQQBotScope,
  clearQuotaCache,
  registerMsgIdWindow,
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

await test('反应式：count 超文档上限不阻断（平台实测不执行 4/5 次）', () => {
  clearQuotaCache();
  const accountId = 'test-account-2';
  const msgId = 'test-msg-2';

  // 连续消耗 6 次（文档口径 c2c 上限 4）——反应式模型下全部放行
  for (let i = 0; i < 6; i++) {
    const { canReply } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
    assert.equal(canReply, true, `attempt ${i + 1} should be allowed (count is observational)`);
  }

  // 存活探测同样不判次数
  assert.equal(checkPassiveReplyQuota({ accountId, msgId, scope: 'c2c' }), true);

  // count 仍如实观测
  const entry = __test_getQuotaCache().get(`${accountId}:c2c:${msgId}`);
  assert.ok(entry);
  assert.equal(entry!.count, 6);
});

await test('超文档上限只打一次 INFO 观测日志', () => {
  clearQuotaCache();
  const accountId = 'test-account-obs';
  const msgId = 'test-msg-obs';
  const infos: string[] = [];
  const log = { info: (m: string) => infos.push(m), debug: () => {} };

  // 前 4 次不触发
  for (let i = 0; i < 4; i++) {
    checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c', log });
  }
  assert.equal(infos.length, 0, '未超限不应打观测日志');

  checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c', log }); // 第 5 次：超限
  assert.equal(infos.length, 1, '首次超限打一条 INFO');
  assert.ok(infos[0]!.includes('exceeded documented limit'), `日志应说明超文档上限：${infos[0]}`);

  checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c', log }); // 第 6 次：不重复
  assert.equal(infos.length, 1, '同一 msg_id 只打一次');
});

await test('观测标志不被无 logger 的消耗烧死（评审 #86-F1）', () => {
  clearQuotaCache();
  const accountId = 'test-account-obs2';
  const msgId = 'test-msg-obs2';
  const infos: string[] = [];

  // 主出站路径形态：不传 logger——超限消耗不得置位一次性标志
  for (let i = 0; i < 5; i++) {
    checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  }
  assert.equal(infos.length, 0);

  // 之后带上 logger 的消耗（adapter 路径同 msg_id）：标志未被烧死，INFO 应发出
  checkAndConsumePassiveReplyQuota({
    accountId, msgId, scope: 'c2c',
    log: { info: (m: string) => infos.push(m), debug: () => {} },
  });
  assert.equal(infos.length, 1, '无 logger 消耗不得烧死观测标志');

  checkAndConsumePassiveReplyQuota({
    accountId, msgId, scope: 'c2c',
    log: { info: (m: string) => infos.push(m), debug: () => {} },
  });
  assert.equal(infos.length, 1, '发出后仍只一次');
});

await test('invalidate 不回截观测计数（评审 #86-F2）', () => {
  clearQuotaCache();
  const accountId = 'test-account-inv2';
  const msgId = 'test-msg-inv2';
  registerMsgIdWindow({ accountId, msgId, scope: 'c2c', receivedAt: Date.now() });
  for (let i = 0; i < 6; i++) {
    checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  }
  invalidateMsgIdQuota({ accountId, msgId, scope: 'c2c' });
  const entry = __test_getQuotaCache().get(`${accountId}:c2c:${msgId}`);
  assert.ok(entry);
  assert.equal(entry!.count, 6, '判死不得把超限观测计数回截到文档上限（保住证据）');
  assert.equal(entry!.dead, true);
});

await test('rollback（闭包）：只回滚观测计数（无阻断语义）', async () => {
  clearQuotaCache();
  const accountId = 'test-account-rollback';
  const msgId = 'test-msg-rollback';

  const first = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  first.rollback(); // 模拟首次发送失败

  const entry = __test_getQuotaCache().get(`${accountId}:c2c:${msgId}`);
  assert.ok(entry);
  assert.equal(entry!.count, 1, '回滚应递减观测计数');
  assert.equal(entry!.seq, 2, 'seq 不回退');
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
  assert.equal(checkPassiveReplyQuota({ accountId, msgId, scope: 'c2c' }), false, '探测同样应判过期');
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

await test('超文档上限后 seq 仍单调发号（唯一性是平台硬约束）', () => {
  clearQuotaCache();
  const accountId = 'test-account-seq-over';
  const msgId = 'test-msg-seq-over';
  const seqs: number[] = [];
  for (let i = 0; i < 6; i++) {
    const { canReply, seq } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
    assert.equal(canReply, true, 'count 不阻断');
    seqs.push(seq);
  }
  assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6], '第 5/6 次仍要拿到新 msg_seq（40054005 防重复）');
});

await test('rollback 只回滚 count，seq 不回退', () => {
  clearQuotaCache();
  const accountId = 'test-account-seq-rb';
  const msgId = 'test-msg-seq-rb';
  const first = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(first.seq, 1);
  first.rollback(); // 模拟 API 失败
  const second = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  assert.equal(second.canReply, true);
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
  assert.equal(canReply, false, '判死锚点应不可消耗');
  assert.equal(checkPassiveReplyQuota({ accountId, msgId, scope: 'group' }), false, '探测也应判死');
});

await test('invalidate 后 rollback 不得复活死锚点（dead 标记）', () => {
  clearQuotaCache();
  const accountId = 'test-account-dead-rb';
  const msgId = 'test-msg-dead-rb';
  // 模拟真实链路：adapter 消耗成功（拿到 rollback）→ 平台判死锚点 invalidate
  // → 主动重发也失败 → 上游补偿 rollback()——不得复活死锚点
  const { rollback } = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  invalidateMsgIdQuota({ accountId, msgId, scope: 'c2c' });
  rollback();
  // 判死后的消耗直接拒绝（rollback 为 no-op，复活不了）
  const again = checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  again.rollback();
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
  // 活跃锚点 L：先登记、先消耗一次（count=1）
  registerMsgIdWindow({ accountId, msgId: 'LIVE', scope: 'c2c', receivedAt: Date.now() });
  const c1 = checkAndConsumePassiveReplyQuota({ accountId, msgId: 'LIVE', scope: 'c2c' });
  assert.equal(c1.canReply, true);

  // 涌入大量「已过期」条目（receivedAt = 61min 前）——只做 FIFO 会把
  // 插入序最老的 LIVE 淘汰掉；过期清扫优先应保住它
  const old = Date.now() - PLATFORM_PASSIVE_WINDOW.c2c - 60_000;
  for (let i = 0; i < 10_060; i++) {
    registerMsgIdWindow({ accountId, msgId: `EXP_${i}`, scope: 'c2c', receivedAt: old });
  }

  // 判别：条目若被 FIFO 淘汰则 cache 中无此键；存活则 count 保留
  const entry = __test_getQuotaCache().get(`${accountId}:c2c:LIVE`);
  assert.ok(entry, '活跃锚点应经清扫存活');
  assert.equal(entry!.count, 1, '存活条目的观测计数应保留');

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
  checkPassiveReplyQuota({ accountId, msgId: 'LRU_A', scope: 'c2c' });

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
