import { strict as assert } from 'assert';
import {
  checkPassiveReplyQuota,
  checkAndConsumePassiveReplyQuota,
  rollbackPassiveReplyQuota,
  inferQQBotScope,
  clearQuotaCache,
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

console.log('All quota manager tests passed');
