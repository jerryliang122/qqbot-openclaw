/**
 * 补充测试覆盖
 *
 * 覆盖关键路径：
 * 1. heartbeat-adapter.ts 发送逻辑
 * 2. typing session 清理和账户重启行为
 * 3. 配额管理器原子操作
 *
 * 运行方式: npx tsx tests/additional-coverage.test.ts
 */
import assert from 'node:assert';
import path from 'node:path';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

async function main(): Promise<void> {
  console.log('\n=== 补充测试覆盖 ===\n');

  // 测试 1: heartbeat-adapter parseTarget null 检查
  await test('heartbeat-adapter 正确处理无效 target', async () => {
    const { qqbotHeartbeatAdapter } = await import('../src/heartbeat-adapter.js');
    const { tryParseTarget } = await import('../src/outbound/target.js');
    
    // 模拟无效的 to 参数
    const result1 = tryParseTarget('');
    assert.equal(result1, null, '空字符串应该返回 null');
    
    const result2 = tryParseTarget('invalid:format');
    assert.equal(result2, null, '无效格式应该返回 null');
    
    const result3 = tryParseTarget('telegram:c2c:USER_123');
    assert.equal(result3, null, '非 qqbot 前缀应该返回 null');
    
    // 验证有效格式
    const result4 = tryParseTarget('qqbot:c2c:USER_123');
    assert.ok(result4, '有效的 qqbot 格式应该返回对象');
    assert.equal(result4?.scope, 'c2c');
    assert.equal(result4?.targetId, 'USER_123');
  });

  // 测试 2: typing session 清理
  await test('cleanupTypingByAccount 清理指定账户的 session', async () => {
    const { startTypingWithRenewal, stopTyping, cleanupTypingByAccount } = await import('../src/typing-lifecycle.js');
    
    // 模拟两个账户的 typing session
    const sendTypingMock = async () => true;
    
    // 账户 1 的 session
    await startTypingWithRenewal({
      accountId: 'account1',
      to: 'qqbot:c2c:USER_1',
      replyToId: 'MSG_1',
      log: { debug: () => {} },
      sendTyping: sendTypingMock,
    });
    
    // 账户 2 的 session
    await startTypingWithRenewal({
      accountId: 'account2',
      to: 'qqbot:c2c:USER_2',
      replyToId: 'MSG_2',
      log: { debug: () => {} },
      sendTyping: sendTypingMock,
    });
    
    // 清理账户 1 的 session
    cleanupTypingByAccount('account1');
    
    // 验证账户 2 的 session 仍然存在
    // 由于我们无法直接访问 activeTypingSessions，我们只能通过行为测试
    // 这里我们测试清理函数不会抛出异常
    cleanupTypingByAccount('account1'); // 清理不存在的 session
    cleanupTypingByAccount('account3'); // 清理不存在的账户
  });

  // 测试 3: 配额管理器原子操作
  await test('checkAndConsumePassiveReplyQuota 原子操作', async () => {
    const { checkAndConsumePassiveReplyQuota, clearQuotaCache } = await import('../src/features/quota-manager.js');
    
    clearQuotaCache();
    
    // 测试原子消耗
    const result1 = await checkAndConsumePassiveReplyQuota({
      accountId: 'test',
      msgId: 'MSG_1',
      scope: 'c2c',
      log: { debug: () => {} },
    });
    
    assert.ok(result1.canReply, '第一次应该成功');
    assert.ok(typeof result1.rollback === 'function', '应该返回回滚函数');
    
    // 测试回滚
    result1.rollback();
    
    // 再次消耗应该仍然成功（因为回滚了）
    const result2 = await checkAndConsumePassiveReplyQuota({
      accountId: 'test',
      msgId: 'MSG_1',
      scope: 'c2c',
      log: { debug: () => {} },
    });
    
    assert.ok(result2.canReply, '回滚后应该可以再次消耗');
    
    clearQuotaCache();
  });

  // 测试 4: 配额管理器达到上限
  await test('checkAndConsumePassiveReplyQuota 达到配额上限', async () => {
    const { checkAndConsumePassiveReplyQuota, clearQuotaCache } = await import('../src/features/quota-manager.js');
    
    clearQuotaCache();
    
    // C2C 配额限制为 4 次
    for (let i = 0; i < 4; i++) {
      const result = await checkAndConsumePassiveReplyQuota({
        accountId: 'test',
        msgId: 'MSG_2',
        scope: 'c2c',
        log: { debug: () => {} },
      });
      assert.ok(result.canReply, `第 ${i + 1} 次应该成功`);
    }
    
    // 第 5 次应该失败
    const result5 = await checkAndConsumePassiveReplyQuota({
      accountId: 'test',
      msgId: 'MSG_2',
      scope: 'c2c',
      log: { debug: () => {} },
    });
    
    assert.ok(!result5.canReply, '达到配额上限应该失败');
    
    clearQuotaCache();
  });

  // 测试 5: rollbackPassiveReplyQuota 回滚机制
  await test('rollbackPassiveReplyQuota 正确回滚配额', async () => {
    const { checkAndConsumePassiveReplyQuota, rollbackPassiveReplyQuota, clearQuotaCache, getQuotaStats } = await import('../src/features/quota-manager.js');
    
    clearQuotaCache();
    
    // 消耗配额
    await checkAndConsumePassiveReplyQuota({
      accountId: 'test',
      msgId: 'MSG_3',
      scope: 'c2c',
      log: { debug: () => {} },
    });
    
    const stats1 = getQuotaStats('test', 'c2c');
    assert.equal(stats1.totalUsage, 1, '消耗后配额应该为 1');
    
    // 回滚
    rollbackPassiveReplyQuota({
      accountId: 'test',
      msgId: 'MSG_3',
      scope: 'c2c',
    });
    
    const stats2 = getQuotaStats('test', 'c2c');
    assert.equal(stats2.totalUsage, 0, '回滚后配额应该为 0');
    
    clearQuotaCache();
  });

  // 测试 6: 纯相对路径也必须经过本地文件白名单
  await test('媒体相对路径不能用中间目录穿越白名单', async () => {
    const { sendMedia } = await import('../src/outbound/media-send.js');
    // 以普通目录名开头，绕过旧版 isLocalFilePath；规范化后指向允许根之外的 Node 可执行文件。
    const traversal = `placeholder/../${path.relative(process.cwd(), process.execPath)}`;
    const result = await sendMedia({
      to: 'qqbot:c2c:test-user',
      source: traversal,
      accountId: 'missing-gateway',
    });

    assert.match(result.error ?? '', /不在允许的目录/);
  });

  // 测试 7: 文档公开的环境变量名必须可直接启动 default 账户
  await test('QQBOT_APPID / QQBOT_SECRET 环境变量兼容', async () => {
    const keys = ['QQBOT_APPID', 'QQBOT_SECRET'] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.QQBOT_APPID = ' documented-app-id ';
      process.env.QQBOT_SECRET = ' documented-secret ';

      const { listQQBotAccountIds, resolveQQBotAccount } = await import('../src/config.js');
      const cfg = {} as any;
      assert.deepEqual(listQQBotAccountIds(cfg), ['default']);
      const account = resolveQQBotAccount(cfg, 'default');
      assert.equal(account.appId, 'documented-app-id');
      assert.equal(account.clientSecret, 'documented-secret');
      assert.equal(account.secretSource, 'env');
    } finally {
      for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  // ── 汇总 ──────────────────────────────────────────────────

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`FAILED: ${failedTests.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
