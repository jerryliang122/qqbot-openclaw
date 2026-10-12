/**
 * 被动锚点轮转（passive-anchor）回归测试
 *
 * 覆盖：
 * 1. 轮转语义：首选 msg_id 优先；耗尽后沿缓存新→旧依次尝试；全部耗尽才
 *    返回 undefined（调用方据此降级主动）。
 * 2. 真实场景：用户连发 A/B/C，c2c 单条 4 次配额 → 12 条全部走被动，
 *    而非第 5 条就降级主动（旧实现的浪费点）。
 * 3. 边界：候选去重、preferred 不在缓存时仍可用、rollback 释放额度、
 *    过期条目不参与轮转。
 * 4. 不变量守卫：msgid-cache TTL 必须严格小于 quota TTL——否则
 *    quota-manager 以「首次消费」为锚点的 expiresAt 会放行已过期 msg_id，
 *    撞平台 40034005 / 40034128 硬失败。
 * 5. c2c 缓存 TTL 回归：锁定 55 分钟（平台窗口 60 分钟留 5 分钟余量）。
 *
 * 运行方式: npx tsx tests/passive-anchor.test.ts
 */
import assert from 'node:assert/strict';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 被测模块 ──

const { resolvePassiveAnchor } = await import('../src/features/passive-anchor.ts');
const { cacheMsgId, getCachedMsgId, getCachedMsgIds, clearMsgIdCache, _msgidCacheTtlMs } =
  await import('../src/features/msgid-cache.ts');
const { checkAndConsumePassiveReplyQuota, clearQuotaCache, __test_getQuotaCache, QUOTA_LIMITS } =
  await import('../src/features/quota-manager.ts');

const ACCOUNT = 'acc_test';

/** 读回某 msg_id 的已用配额 */
function usedOf(msgId: string, scope: 'c2c' | 'group' = 'c2c'): number {
  return __test_getQuotaCache().get(`${ACCOUNT}:${scope}:${msgId}`)?.count ?? 0;
}

function reset() {
  clearQuotaCache();
  for (const id of ['A', 'B', 'C', 'D']) clearMsgIdCache('c2c', `U_${id}`);
  for (const id of ['G1', 'G2']) clearMsgIdCache('group', `G_${id}`);
}

// ── 1. 轮转语义 ──

group('1. 轮转语义');

await test('首选 msg_id 有配额时直接使用，不轮转', () => {
  reset();
  cacheMsgId('c2c', 'U_A', 'A');
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_A', preferredMsgId: 'A',
  });
  assert.equal(r.msgId, 'A');
  assert.equal(r.rotated, false);
  assert.equal(usedOf('A'), 1);
});

await test('首选耗尽 → 轮转到缓存里次新的 msg_id', () => {
  reset();
  cacheMsgId('c2c', 'U_B', 'B');
  cacheMsgId('c2c', 'U_B', 'C');   // C 最新，B 次新
  // 抽干 C 的 4 次配额
  for (let i = 0; i < 4; i++) {
    assert.equal(checkAndConsumePassiveReplyQuota({ accountId: ACCOUNT, msgId: 'C', scope: 'c2c' }).canReply, true);
  }
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_B', preferredMsgId: 'C',
  });
  assert.equal(r.msgId, 'B', '应轮转到次新的 B，而不是直接放弃');
  assert.equal(r.rotated, true);
  assert.equal(usedOf('B'), 1);
  assert.equal(r.candidates, 2);
});

await test('全部候选耗尽 → 返回 undefined（调用方降级主动）', () => {
  reset();
  cacheMsgId('c2c', 'U_C', 'A');
  cacheMsgId('c2c', 'U_C', 'B');
  for (const id of ['A', 'B']) {
    for (let i = 0; i < 4; i++) {
      checkAndConsumePassiveReplyQuota({ accountId: ACCOUNT, msgId: id, scope: 'c2c' });
    }
  }
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_C', preferredMsgId: 'B',
  });
  assert.equal(r.msgId, undefined);
  assert.equal(r.rotated, false);
});

await test('无任何候选 → undefined 且 candidates=0', () => {
  reset();
  const r = resolvePassiveAnchor({ accountId: ACCOUNT, scope: 'c2c', targetId: 'U_D' });
  assert.equal(r.msgId, undefined);
  assert.equal(r.candidates, 0);
});

// ── 2. 真实场景：连发 A/B/C ──

group('2. 真实场景（c2c，连发 3 条 → 12 条出站全被动）');

await test('旧实现第 5 条就降主动；轮转后 12 条全部走被动', () => {
  reset();
  cacheMsgId('c2c', 'U_A', 'A');
  cacheMsgId('c2c', 'U_A', 'B');
  cacheMsgId('c2c', 'U_A', 'C');

  const used: string[] = [];
  let proactive = 0;
  // 模拟一轮 12 条出站（正文分块 + 媒体 + typing），全部以最新 msg_id 为首选
  for (let i = 0; i < 12; i++) {
    const r = resolvePassiveAnchor({
      accountId: ACCOUNT, scope: 'c2c', targetId: 'U_A', preferredMsgId: 'C',
    });
    if (r.msgId) used.push(r.msgId);
    else proactive++;
  }

  assert.equal(proactive, 0, '不应有任何一条降级主动');
  assert.equal(used.length, 12);
  // 平台按每条消息独立计数：A/B/C 各 4 次
  assert.equal(used.filter((m) => m === 'C').length, 4);
  assert.equal(used.filter((m) => m === 'B').length, 4);
  assert.equal(used.filter((m) => m === 'A').length, 4);
  assert.equal(usedOf('C'), 4);
  assert.equal(usedOf('B'), 4);
  assert.equal(usedOf('A'), 4);
});

await test('轮转顺序为新→旧（C 耗尽后 B，再之后 A）', () => {
  reset();
  cacheMsgId('c2c', 'U_A', 'A');
  cacheMsgId('c2c', 'U_A', 'B');
  cacheMsgId('c2c', 'U_A', 'C');
  const order: (string | undefined)[] = [];
  for (let i = 0; i < 9; i++) {
    order.push(resolvePassiveAnchor({
      accountId: ACCOUNT, scope: 'c2c', targetId: 'U_A', preferredMsgId: 'C',
    }).msgId);
  }
  assert.deepEqual(order, [
    'C', 'C', 'C', 'C',   // C 的 4 次
    'B', 'B', 'B', 'B',   // B 的 4 次
    'A',                   // A 的第 1 次
  ]);
});

// ── 3. 边界 ──

group('3. 边界');

await test('候选去重：preferred 同时在缓存中只尝试一次', () => {
  reset();
  cacheMsgId('c2c', 'U_B', 'B');
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_B', preferredMsgId: 'B',
  });
  assert.equal(r.msgId, 'B');
  assert.equal(r.candidates, 1, 'B 同时是 preferred 和缓存最新，不应重复计数');
  assert.equal(usedOf('B'), 1, '只扣一次配额');
});

await test('preferred 不在缓存（上游显式给出）也能用', () => {
  reset();
  cacheMsgId('c2c', 'U_B', 'OLD');
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_B', preferredMsgId: 'FRESH',
  });
  assert.equal(r.msgId, 'FRESH');
  assert.equal(r.rotated, false);
});

await test('rollback 释放已扣额度，后续轮转可重新占用', () => {
  reset();
  cacheMsgId('c2c', 'U_B', 'B');
  const first = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_B', preferredMsgId: 'B',
  });
  assert.equal(usedOf('B'), 1);
  first.rollback();
  assert.equal(usedOf('B'), 0, 'rollback 应归还额度');
  const second = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_B', preferredMsgId: 'B',
  });
  assert.equal(second.msgId, 'B');
  assert.equal(usedOf('B'), 1);
});

await test('过期条目不参与轮转', () => {
  reset();
  cacheMsgId('c2c', 'U_C', 'A');
  cacheMsgId('c2c', 'U_C', 'B');
  // 人为把 A 的配额条目的 expiresAt 推到过去（模拟平台窗口已过）
  const cache = __test_getQuotaCache();
  cache.set(`${ACCOUNT}:c2c:A`, { count: 0, expiresAt: Date.now() - 1000 });
  const r = resolvePassiveAnchor({
    accountId: ACCOUNT, scope: 'c2c', targetId: 'U_C', preferredMsgId: 'B',
  });
  assert.equal(r.msgId, 'B', '过期的 A 不应被选中');
});

// ── 4. 不变量守卫 ──

group('4. 不变量守卫');

await test('msgid-cache TTL 必须严格小于 quota TTL（防 40034128 硬失败）', () => {
  assert.ok(
    _msgidCacheTtlMs.c2c < QUOTA_LIMITS.c2c.ttlMs,
    `c2c 缓存 TTL ${_msgidCacheTtlMs.c2c}ms 必须 < 配额 TTL ${QUOTA_LIMITS.c2c.ttlMs}ms`,
  );
  assert.ok(
    _msgidCacheTtlMs.group < QUOTA_LIMITS.group.ttlMs,
    `group 缓存 TTL ${_msgidCacheTtlMs.group}ms 必须 < 配额 TTL ${QUOTA_LIMITS.group.ttlMs}ms`,
  );
});

await test('群聊余量必须 ≥ 60 秒（TTL 从到达起算，扣入站网络延迟后仍为正）', () => {
  const groupMargin = QUOTA_LIMITS.group.ttlMs - _msgidCacheTtlMs.group;
  // TTL 锚点是「消息到达本进程」，平台锚点是「它自己的消息时间戳」，到达必然
  // 更晚——真实余量 = 平台窗口 − (入站延迟 + TTL)。余量低于 60 秒时，WebSocket
  // 重连补发 / 网关积压造成的几十秒抖动就可能把余量吃成负数，挂上过期 msg_id
  // → 40034005 / 40034128 硬失败（无降级通道）。4.5 分钟只有 30 秒，故禁用。
  assert.ok(
    groupMargin >= 60 * 1000,
    `群聊余量仅 ${groupMargin}ms，应 ≥ 60000ms（否则入站抖动即可击穿）`,
  );
});

await test('c2c 余量 ≥ 1 分钟', () => {
  const c2cMargin = QUOTA_LIMITS.c2c.ttlMs - _msgidCacheTtlMs.c2c;
  assert.ok(c2cMargin >= 60 * 1000, `c2c 余量 ${c2cMargin}ms 应 ≥ 60000ms`);
});

// ── 5. c2c TTL 回归 ──

group('5. c2c 缓存 TTL 回归');

await test('c2c 缓存 TTL = 55 分钟 / 群 = 4 分钟', () => {
  assert.equal(_msgidCacheTtlMs.c2c, 55 * 60 * 1000);
  assert.equal(_msgidCacheTtlMs.group, 4 * 60 * 1000);
});

await test('getCachedMsgId 语义不变（仍返回最新一条）', () => {
  reset();
  cacheMsgId('c2c', 'U_B', 'B');
  cacheMsgId('c2c', 'U_B', 'C');
  assert.equal(getCachedMsgId('c2c', 'U_B'), 'C');
  assert.deepEqual(getCachedMsgIds('c2c', 'U_B'), ['C', 'B'], '复数版按新→旧');
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:\n  - ' + failedTests.join('\n  - '));
  process.exit(1);
}
