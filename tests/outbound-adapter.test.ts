import { strict as assert } from 'assert';
import { clearQuotaCache, registerMsgIdWindow, invalidateMsgIdQuota, __test_getQuotaCache } from '../src/features/quota-manager.js';
import { createQQBotOutboundAdapter } from '../src/outbound-adapter.js';
import type { ResolvedQQBotAccount } from '../src/types.js';

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

const mockAccount: ResolvedQQBotAccount = {
  accountId: 'test-account',
  appId: 'test-app-id',
  appIdSource: 'config',
  clientSecret: 'test-secret',
  secretSource: 'config',
  enabled: true,
  markdownSupport: true,
  userAgentSuffix: '',
  config: {},
};

async function main() {
  clearQuotaCache();

  await test('createQQBotOutboundAdapter: 创建适配器', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: ({ kind }) => kind !== 'final',
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter !== undefined);
    assert(typeof adapter.sendTextWithQuota === 'function');
    assert(typeof adapter.sendMediaWithQuota === 'function');
    assert(typeof adapter.canSendTyping === 'function');
  });

  await test('shouldSuppressLocalPayloadPrompt: 审批 payload 抑制', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: ({ payload }) => (payload as { type?: string })?.type === 'approval',
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter.shouldSuppressLocalPayloadPrompt({ payload: { type: 'approval' } }) === true);
    assert(adapter.shouldSuppressLocalPayloadPrompt({ payload: { type: 'text' } }) === false);
  });

  await test('shouldTreatDeliveredTextAsVisible: 文本可见性判断', () => {
    const adapter = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: ({ kind }) => kind !== 'hidden',
      preferFinalAssistantVisibleText: true,
    });
    
    assert(adapter.shouldTreatDeliveredTextAsVisible({ kind: 'text' }) === true);
    assert(adapter.shouldTreatDeliveredTextAsVisible({ kind: 'hidden' }) === false);
  });

  await test('preferFinalAssistantVisibleText: 配置值传递', () => {
    const adapter1 = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: true,
    });
    assert(adapter1.preferFinalAssistantVisibleText === true);
    
    const adapter2 = createQQBotOutboundAdapter({
      shouldSuppressLocalPayloadPrompt: () => false,
      shouldTreatDeliveredTextAsVisible: () => true,
      preferFinalAssistantVisibleText: false,
    });
    assert(adapter2.preferFinalAssistantVisibleText === false);
  });

  // ====== 配额感知行为测试 ======

  await test('sendTextWithQuota: 有配额时包含 replyToId', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendText: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'msg-1' };
      },
    });

    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user123',
      text: 'test message',
      replyToId: 'original-msg-id',
      account: mockAccount,
    });

    assert(capturedReplyToId === 'original-msg-id', 'Should include replyToId when quota available');
  });

  await test('sendTextWithQuota: 超文档上限仍带 replyToId（反应式，次数不阻断）', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendText: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'msg-2' };
      },
    });

    // 消耗文档口径的全部配额（C2C: 4 次）
    for (let i = 0; i < 4; i++) {
      await adapter.sendTextWithQuota({
        to: 'qqbot:c2c:user456',
        text: `message ${i}`,
        replyToId: 'msg-id-exhausted',
        account: mockAccount,
      });
    }

    // 第 5 次：反应式模型下仍带 replyToId（count 仅观测，平台实测不执行 4 次上限）
    capturedReplyToId = undefined;
    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user456',
      text: 'message 5',
      replyToId: 'msg-id-exhausted',
      account: mockAccount,
    });

    assert(capturedReplyToId === 'msg-id-exhausted', '反应式：超文档上限不省略 replyToId');
  });

  await test('sendTextWithQuota: 锚点判死时省略 replyToId（转主动）', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendText: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'msg-2b' };
      },
    });

    // 模拟平台 40034128/40034005 判死锚点
    registerMsgIdWindow({ accountId: mockAccount.accountId, msgId: 'msg-id-dead', scope: 'c2c', receivedAt: Date.now() });
    invalidateMsgIdQuota({ accountId: mockAccount.accountId, msgId: 'msg-id-dead', scope: 'c2c' });

    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user456',
      text: 'hello',
      replyToId: 'msg-id-dead',
      account: mockAccount,
    });

    assert(capturedReplyToId === undefined, '判死锚点应省略 replyToId（降级主动）');
  });

  await test('sendMediaWithQuota: 有配额时包含 replyToId', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendMedia: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'media-msg-1' };
      },
    });

    await adapter.sendMediaWithQuota({
      to: 'qqbot:c2c:user789',
      source: 'https://example.com/image.png',
      replyToId: 'original-media-msg-id',
      account: mockAccount,
    });

    assert(capturedReplyToId === 'original-media-msg-id', 'Should include replyToId when quota available');
  });

  await test('sendMediaWithQuota: 锚点判死时省略 replyToId（转主动）', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendMedia: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'media-msg-2' };
      },
    });

    // 反应式模型下次数不阻断，能触发「省略」的是判死/过期锚点
    registerMsgIdWindow({ accountId: mockAccount.accountId, msgId: 'msg-id-media-dead', scope: 'c2c', receivedAt: Date.now() });
    invalidateMsgIdQuota({ accountId: mockAccount.accountId, msgId: 'msg-id-media-dead', scope: 'c2c' });

    await adapter.sendMediaWithQuota({
      to: 'qqbot:c2c:user999',
      source: 'https://example.com/image.png',
      replyToId: 'msg-id-media-dead',
      account: mockAccount,
    });

    assert(capturedReplyToId === undefined, '判死锚点应省略 replyToId（降级主动）');
  });

  await test('canSendTyping: C2C 有配额且有 replyToId 返回 true', async () => {
    clearQuotaCache();
    
    const adapter = createQQBotOutboundAdapter({});
    const canSend = await adapter.canSendTyping({
      to: 'qqbot:c2c:user111',
      accountId: mockAccount.accountId,
      replyToId: 'typing-msg-id',
    });

    assert(canSend === true, 'Should allow typing for C2C with quota and replyToId');
  });

  await test('canSendTyping: 群聊返回 false', async () => {
    clearQuotaCache();
    
    const adapter = createQQBotOutboundAdapter({});
    const canSend = await adapter.canSendTyping({
      to: 'qqbot:group:group123',
      accountId: mockAccount.accountId,
      replyToId: 'typing-group-msg-id',
    });

    assert(canSend === false, 'Should NOT allow typing for group scope');
  });

  await test('canSendTyping: 无 replyToId 返回 false', async () => {
    clearQuotaCache();
    
    const adapter = createQQBotOutboundAdapter({});
    const canSend = await adapter.canSendTyping({
      to: 'qqbot:c2c:user222',
      accountId: mockAccount.accountId,
      replyToId: '',
    });

    assert(canSend === false, 'Should NOT allow typing without replyToId');
  });

  await test('canSendTyping: 锚点判死返回 false（反应式：次数不阻断）', async () => {
    clearQuotaCache();

    const adapter = createQQBotOutboundAdapter({
      sendText: async () => ({ messageId: 'msg' }),
    });

    // 反应式模型下 count 不再阻断 typing——能触发 false 的是判死锚点
    registerMsgIdWindow({ accountId: mockAccount.accountId, msgId: 'quota-msg-id', scope: 'c2c', receivedAt: Date.now() });
    invalidateMsgIdQuota({ accountId: mockAccount.accountId, msgId: 'quota-msg-id', scope: 'c2c' });

    const canSend = await adapter.canSendTyping({
      to: 'qqbot:c2c:user333',
      accountId: mockAccount.accountId,
      replyToId: 'quota-msg-id',
    });

    assert(canSend === false, '判死锚点不应再带 msg_id 发 typing');
  });

  await test('配额检查与发送之间过期', async () => {
    clearQuotaCache();
    
    let capturedReplyToId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendText: async ({ replyToId }) => {
        capturedReplyToId = replyToId;
        return { messageId: 'msg-expired' };
      },
    });

    // 先消耗一次配额
    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user-expired',
      text: 'first message',
      replyToId: 'msg-id-expired',
      account: mockAccount,
    });

    // 模拟配额过期
    const quotaCache = __test_getQuotaCache();
    const key = `${mockAccount.accountId}:c2c:msg-id-expired`;
    const cached = quotaCache.get(key);
    if (cached) {
      cached.expiresAt = Date.now() - 1;
    }

    // 过期后发送应该省略 replyToId
    capturedReplyToId = 'not-undefined';
    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user-expired',
      text: 'second message',
      replyToId: 'msg-id-expired',
      account: mockAccount,
    });

    assert(capturedReplyToId === undefined, 'Should omit replyToId when quota expired between check and send');
  });

  await test('accountId 回退到 account.accountId', async () => {
    clearQuotaCache();
    
    let capturedAccountId: string | undefined;
    const adapter = createQQBotOutboundAdapter({
      sendText: async ({ accountId }) => {
        capturedAccountId = accountId;
        return { messageId: 'msg-account' };
      },
    });

    // 不传 accountId，应该使用 account.accountId
    await adapter.sendTextWithQuota({
      to: 'qqbot:c2c:user-acc',
      text: 'test',
      account: mockAccount,
    });

    assert(capturedAccountId === mockAccount.accountId, 'Should fallback to account.accountId when accountId not provided');
  });

  await test('默认发送链路只计数一次且群聊超文档上限仍全程被动（反应式）', async () => {
    const { registerGateway, unregisterGateway } = await import('../src/outbound/outbound-service.js');
    clearQuotaCache();
    const sentMsgIds: Array<string | undefined> = [];
    registerGateway(mockAccount.accountId, {
      sendText: async (_target: unknown, _text: string, opts: { msgId?: string }) => {
        sentMsgIds.push(opts.msgId);
        return { id: `sent-${sentMsgIds.length}` };
      },
    } as any);

    try {
      const adapter = createQQBotOutboundAdapter({});
      for (let i = 0; i < 6; i++) {
        await adapter.sendTextWithQuota({
          to: 'qqbot:group:group-quota',
          text: `group message ${i + 1}`,
          replyToId: 'group-source-msg',
          account: mockAccount,
        });
      }
      // 反应式（2026-11-03）：群「5 次/msg_id」文档上限不再本地阻断——
      // 6 次全部被动（count 仅观测），绝不因次数降级主动
      assert.deepEqual(sentMsgIds, Array(6).fill('group-source-msg'));
    } finally {
      unregisterGateway(mockAccount.accountId);
    }
  });

  console.log('All outbound adapter tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
