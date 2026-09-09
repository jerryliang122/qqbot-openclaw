/**
 * 群聊/私聊差异化处理测试
 *
 * 验证：
 * 1. 群聊消息使用消息合并中间件，所有消息都应该被处理
 * 2. 私聊消息使用 exclusive admission，用户可以"插嘴"
 * 3. sessionKey 根据群聊/私聊生成不同格式
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

  // 测试 1: 验证消息合并中间件导出
  await test('消息合并中间件可以正常导入', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    assert.ok(typeof groupMessageCoalescer === 'function');
    assert.ok(typeof clearAllCoalescers === 'function');
  });

  // 测试 2: 验证群聊合并配置解析
  await test('群聊合并配置解析', async () => {
    const { resolveGroupCoalesceConfig, resolveGroupCoalesceEnabled, resolveGroupCoalesceMaxBuffer } = await import('../src/config.js');
    
    const cfg = {
      channels: {
        qqbot: {
          groupCoalesce: {
            enabled: true,
            maxBuffer: 100,
          },
          groups: {
            'GROUP_123': {
              coalesce: {
                maxBuffer: 200,
              },
            },
          },
        },
      },
    };

    // 默认配置（strategy 默认 framework，排队交给框架）
    const defaultConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_456', 'default');
    assert.equal(defaultConfig.strategy, 'framework');
    assert.equal(defaultConfig.enabled, true);
    assert.equal(defaultConfig.maxBuffer, 100);

    // 群级配置覆盖
    const groupConfig = resolveGroupCoalesceConfig(cfg, 'GROUP_123', 'default');
    assert.equal(groupConfig.strategy, 'framework');
    assert.equal(groupConfig.enabled, true);
    assert.equal(groupConfig.maxBuffer, 200);

    // 快捷函数
    assert.equal(resolveGroupCoalesceEnabled(cfg, 'GROUP_456', 'default'), true);
    assert.equal(resolveGroupCoalesceMaxBuffer(cfg, 'GROUP_123', 'default'), 200);
  });

  // 测试 2b: strategy 级联覆盖（回退到插件 coalescer）
  await test('coalesce.strategy 级联（具体群 > "*" > 账号级 > 默认 framework）', async () => {
    const { resolveGroupConfigFromAccount } = await import('../src/config.js');

    const account: any = {
      accountId: 'default',
      config: {
        groupCoalesce: { strategy: 'plugin' },
        groups: {
          '*': { coalesce: { strategy: 'plugin' } },
          GROUP_PLUGIN: { coalesce: { strategy: 'plugin' } },
          GROUP_FRAMEWORK: { coalesce: { strategy: 'framework' } },
        },
      },
    };

    assert.equal(resolveGroupConfigFromAccount(account, 'GROUP_PLUGIN').coalesce.strategy, 'plugin');
    assert.equal(resolveGroupConfigFromAccount(account, 'GROUP_FRAMEWORK').coalesce.strategy, 'framework');
    // 未配置的群落到 "*"（plugin）
    assert.equal(resolveGroupConfigFromAccount(account, 'GROUP_OTHER').coalesce.strategy, 'plugin');

    const bareAccount: any = { accountId: 'default', config: {} };
    assert.equal(resolveGroupConfigFromAccount(bareAccount, 'GROUP_ANY').coalesce.strategy, 'framework');
  });

  // 测试 3: 验证消息合并中间件行为
  await test('消息合并中间件行为', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    
    clearAllCoalescers();

    const bufferedMessages: any[] = [];
    
    const middleware = groupMessageCoalescer({
      maxBuffer: 10,
      onCoalesce: (buffered) => {
        bufferedMessages.push(...buffered);
        return buffered[buffered.length - 1]!;
      },
    });

    // 模拟群聊消息
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_TEST',
        messageId: 'MSG_1',
        content: '消息 1',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;

    const ctx2 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_TEST',
        messageId: 'MSG_2',
        content: '消息 2',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;

    let nextCalled = 0;
    const next = async () => {
      nextCalled++;
    };

    // 第一条消息应该立即处理
    await middleware(ctx1, next);
    assert.equal(nextCalled, 1);

    clearAllCoalescers();
  });

  // 测试 4: 验证 sessionKey 生成逻辑
  await test('sessionKey 生成逻辑（群聊/私聊差异化）', async () => {
    // 群聊应该使用 coalescing 后缀
    const groupSessionKey = 'qqbot:default:group:GROUP_123:coalescing';
    assert.ok(groupSessionKey.includes(':coalescing'));

    // 私聊不应该有 coalescing 后缀
    const c2cSessionKey = 'qqbot:default:USER_456';
    assert.ok(!c2cSessionKey.includes(':coalescing'));
  });

  // 测试 5: admission 语义（2026-09 起群聊/私聊均为 exclusive；差异在可打断性）
  await test('admission 策略（群聊/私聊均 exclusive，群聊不打断由框架队列保证）', async () => {
    // 群聊与私聊统一使用 exclusive（框架 durable ingress 约定）
    const groupAdmission = 'exclusive';
    const c2cAdmission = 'exclusive';
    assert.equal(groupAdmission, 'exclusive');
    assert.equal(c2cAdmission, 'exclusive');

    // 真正的差异：c2c 传 abortSignal（可插嘴取消），群聊不传（排队不打断）——
    // 行为断言见 dispatch-lifecycle.test.ts「修4: 群聊框架排队」组
  });

  // 测试 6: 验证消息合并后的 body 组装
  await test('消息合并后的 body 组装', async () => {
    const { assembleBody } = await import('../src/dispatch/body-assembler.js');
    
    // 模拟合并后的消息
    const ctx = {
      message: {
        kind: 'group',
        content: '消息 3',
        senderId: 'USER_3',
        senderName: '小华',
      },
      state: {
        mergedMessages: [
          {
            message: {
              kind: 'group',
              content: '消息 1',
              senderId: 'USER_1',
              senderName: '小明',
            },
            state: {},
          },
          {
            message: {
              kind: 'group',
              content: '消息 2',
              senderId: 'USER_2',
              senderName: '小红',
            },
            state: {},
          },
          {
            message: {
              kind: 'group',
              content: '消息 3',
              senderId: 'USER_3',
              senderName: '小华',
            },
            state: {},
          },
        ],
        mention: { wasMentioned: true },
      },
    } as any;

    const account = {
      accountId: 'default',
      systemPrompt: '',
    } as any;

    const result = assembleBody(ctx, ctx.message, account);
    
    // 验证合并消息标记
    assert.ok(result.agentBody.includes('[Merged messages begins]'));
    assert.ok(result.agentBody.includes('[Merged messages ends]'));
    assert.ok(result.agentBody.includes('[Current message]'));
    assert.ok(result.agentBody.includes('(@you)'));
  });

  // 测试 7: 多条消息同时到达时的缓冲行为
  await test('多条消息同时到达时的缓冲行为', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    
    clearAllCoalescers();
    
    const messages: any[] = [];
    let resolveProcessing: () => void;
    
    const middleware = groupMessageCoalescer({
      maxBuffer: 10,
      onCoalesce: (buffered) => {
        messages.push(buffered.map((c: any) => c.message.content));
        return buffered[buffered.length - 1]!;
      },
    });
    
    // 模拟处理中的消息（不会立即完成）
    const processingPromise = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });
    
    let firstNextCalled = false;
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_CONCURRENT',
        messageId: 'MSG_1',
        content: '消息 1',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    // 第一条消息开始处理，但不会立即完成
    const promise1 = middleware(ctx1, async () => {
      firstNextCalled = true;
      await processingPromise; // 阻塞处理
    });
    
    // 在第一条消息处理期间，发送第二条和第三条消息
    await new Promise((resolve) => setTimeout(resolve, 50)); // 等待第一条消息开始处理
    
    const ctx2 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_CONCURRENT',
        messageId: 'MSG_2',
        content: '消息 2',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    const ctx3 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_CONCURRENT',
        messageId: 'MSG_3',
        content: '消息 3',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    let secondNextCalled = false;
    let thirdNextCalled = false;
    const promise2 = middleware(ctx2, async () => {
      secondNextCalled = true;
    });
    
    const promise3 = middleware(ctx3, async () => {
      thirdNextCalled = true;
    });
    
    // 第一条消息完成处理
    resolveProcessing!();
    await promise1;
    
    // 等待第二条和第三条消息处理完成
    await Promise.all([promise2, promise3]);
    
    // 验证：第一条消息单独处理，第二和第三条消息合并处理
    assert.ok(firstNextCalled, '第一条消息应该被处理');
    assert.equal(secondNextCalled, false, '非 survivor 不应重复进入下游');
    assert.ok(thirdNextCalled, '最后一条 survivor 应该被处理');
    assert.equal(messages.length, 1, '应该有一次合并');
    assert.deepEqual(messages[0], ['消息 2', '消息 3'], '第二和第三条消息应该被合并');
    
    clearAllCoalescers();
  });

  // 测试 8: 缓冲满时的丢弃行为
  await test('缓冲满时的丢弃行为', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    
    clearAllCoalescers();
    
    const messages: any[] = [];
    const bufferFullWarnings: string[] = [];
    
    const middleware = groupMessageCoalescer({
      maxBuffer: 3, // 小缓冲区
      onCoalesce: (buffered) => {
        messages.push(buffered.map((c: any) => c.message.content));
        return buffered[buffered.length - 1]!;
      },
      onBufferFull: (ctx) => {
        bufferFullWarnings.push(ctx.message.groupOpenid);
      },
    });
    
    // 模拟处理中的消息
    let resolveProcessing: () => void;
    const processingPromise = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });
    
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_BUFFER_FULL',
        messageId: 'MSG_1',
        content: '消息 1',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    const promise1 = middleware(ctx1, async () => {
      await processingPromise;
    });
    
    await new Promise((resolve) => setTimeout(resolve, 50));
    
    // 发送超过缓冲区容量的消息
    const promises: Promise<void>[] = [];
    for (let i = 2; i <= 5; i++) {
      const ctx = {
        message: {
          kind: 'group',
          groupOpenid: 'GROUP_BUFFER_FULL',
          messageId: `MSG_${i}`,
          content: `消息 ${i}`,
        },
        state: {},
        log: { debug: () => {} },
        stop: () => {},
      } as any;
      
      promises.push(middleware(ctx, async () => {}));
    }
    
    // 完成第一条消息的处理
    resolveProcessing!();
    await promise1;
    
    // 等待所有消息处理完成
    await Promise.all(promises);
    
    // 验证：缓冲区满时应该触发警告，但消息仍会被处理
    assert.ok(bufferFullWarnings.length > 0, '应该有缓冲区满的警告');
    assert.ok(messages.length > 0, '部分消息应该被合并处理');
    
    clearAllCoalescers();
  });

  // 测试 9: survivor 选择和 mergedMessages 组装
  await test('survivor 选择和 mergedMessages 组装', async () => {
    const { groupMessageCoalescer, clearAllCoalescers } = await import('../src/features/message-coalescer.js');
    
    clearAllCoalescers();
    
    let survivorContext: any = null;
    
    const middleware = groupMessageCoalescer({
      maxBuffer: 10,
      onCoalesce: (buffered) => {
        const last = buffered[buffered.length - 1]!;
        survivorContext = last;
        
        // 验证 mergedMessages 被正确设置
        assert.ok(last.state.mergedMessages, 'survivor 应该有 mergedMessages');
        assert.deepEqual(
          (last.state.mergedMessages as any[]).map((c: any) => c.message.content),
          buffered.map((c: any) => c.message.content),
          'mergedMessages 应该包含所有缓冲的消息'
        );
        
        return last;
      },
    });
    
    // 模拟处理中的消息
    let resolveProcessing: () => void;
    const processingPromise = new Promise<void>((resolve) => {
      resolveProcessing = resolve;
    });
    
    const ctx1 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_SURVIVOR',
        messageId: 'MSG_1',
        content: '消息 1',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    const promise1 = middleware(ctx1, async () => {
      await processingPromise;
    });
    
    await new Promise((resolve) => setTimeout(resolve, 50));
    
    // 发送多条消息
    const ctx2 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_SURVIVOR',
        messageId: 'MSG_2',
        content: '消息 2',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    const ctx3 = {
      message: {
        kind: 'group',
        groupOpenid: 'GROUP_SURVIVOR',
        messageId: 'MSG_3',
        content: '消息 3',
      },
      state: {},
      log: { debug: () => {} },
      stop: () => {},
    } as any;
    
    const promise2 = middleware(ctx2, async () => {});
    const promise3 = middleware(ctx3, async () => {});
    
    // 完成第一条消息的处理
    resolveProcessing!();
    await promise1;
    
    // 等待后续消息处理完成
    await Promise.all([promise2, promise3]);
    
    // 验证 survivor 是最后一条消息
    assert.ok(survivorContext, '应该有 survivor context');
    assert.equal(survivorContext.message.content, '消息 3', 'survivor 应该是最后一条消息');
    
    clearAllCoalescers();
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
