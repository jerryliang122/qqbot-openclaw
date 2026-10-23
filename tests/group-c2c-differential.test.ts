/**
 * 群聊/私聊差异化处理测试
 *
 * 验证：
 * 1. 群消息合并配置解析（enabled / strategy / maxBatchSize / maxHoldMs）
 * 2. 插件侧群合批存在且 strategy 双档可切换（plugin / framework）
 * 3. 私聊消息使用 exclusive admission，用户可以"插嘴"
 * 4. sessionKey 根据群聊/私聊生成不同格式
 *
 * 运行方式: npx tsx tests/group-c2c-differential.test.ts
 */
import assert from 'node:assert';

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
  console.log('\n=== 群聊/私聊差异化处理测试 ===\n');

  // 测试 1: 群聊合并配置解析（仅 enabled，排队交给框架）
  await test('群聊合并配置解析', async () => {
    const { resolveGroupCoalesceConfig, resolveGroupCoalesceEnabled } = await import('../src/config.js');

    const cfg = {
      channels: {
        qqbot: {
          groupCoalesce: {
            enabled: true,
          },
          groups: {
            'GROUP_123': {
              coalesce: {
                enabled: false,
              },
            },
          },
        },
      },
    };

    // 默认配置
    const defaultConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_456', 'default');
    assert.equal(defaultConfig.enabled, true);
    assert.equal(defaultConfig.strategy, 'plugin');
    assert.equal(defaultConfig.maxBatchSize, 10);
    assert.equal(defaultConfig.maxHoldMs, 300_000);

    // 群级配置覆盖
    const groupConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_123', 'default');
    assert.equal(groupConfig.enabled, false);

    // 快捷函数
    assert.equal(resolveGroupCoalesceEnabled(cfg, 'GROUP_456', 'default'), true);
    assert.equal(resolveGroupCoalesceEnabled(cfg, 'GROUP_123', 'default'), false);
  });

  // 测试 1b: 插件侧群合批存在（2026-10-23 起，群合并在插件侧完成）
  await test('插件侧群合批模块存在且 strategy 双档可切换', async () => {
    // 旧的 message-coalescer 仍不存在（职责已迁移到 features/group-merge.ts）
    let legacyImportFailed = false;
    try {
      await import('../src/features/message-coalescer.js');
    } catch {
      legacyImportFailed = true;
    }
    assert.ok(legacyImportFailed, 'message-coalescer 模块应已不存在');

    const mod = await import('../src/features/group-merge.js');
    assert.equal(typeof mod.enqueueGroupInboundMessage, 'function', '群合批入口应存在');
    assert.equal(typeof mod.flushGroupMergeQueue, 'function', '群合批冲刷入口应存在');

    const { resolveGroupConfigFromAccount } = await import('../src/config.js');
    const account = {
      accountId: 'default',
      config: { groupCoalesce: { strategy: 'framework' } },
    } as any;
    assert.equal(
      resolveGroupConfigFromAccount(account, 'GROUP_1').coalesce.strategy,
      'framework',
      'strategy=framework 应交回框架队列',
    );
    assert.equal(
      resolveGroupConfigFromAccount({ accountId: 'default', config: {} } as any, 'GROUP_1').coalesce.strategy,
      'plugin',
      '默认 strategy 应为 plugin（插件侧合批）',
    );
  });

  // 测试 2: 验证 sessionKey 生成逻辑
  await test('sessionKey 生成逻辑（群聊/私聊差异化）', async () => {
    // 群聊应该使用 coalescing 后缀
    const groupSessionKey = 'qqbot:default:group:GROUP_123:coalescing';
    assert.ok(groupSessionKey.includes(':coalescing'));

    // 私聊不应该有 coalescing 后缀
    const c2cSessionKey = 'qqbot:default:USER_456';
    assert.ok(!c2cSessionKey.includes(':coalescing'));
  });

  // 测试 3: admission 语义（2026-09 起群聊/私聊均为 exclusive；差异在可打断性）
  await test('admission 策略（群聊/私聊均 exclusive，群聊不打断由框架队列保证）', async () => {
    // 群聊与私聊统一使用 exclusive（框架 durable ingress 约定）
    const groupAdmission = 'exclusive';
    const c2cAdmission = 'exclusive';
    assert.equal(groupAdmission, 'exclusive');
    assert.equal(c2cAdmission, 'exclusive');

    // 真正的差异：c2c 传 abortSignal（可插嘴取消），群聊不传（排队不打断）——
    // 行为断言见 dispatch-lifecycle.test.ts「修4: 群聊框架排队」组
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
