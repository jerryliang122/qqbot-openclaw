import { strict as assert } from 'assert';
import {
  startTypingWithRenewal,
  stopTyping,
  cleanupAllTyping,
  isTypingActive,
} from '../src/typing-lifecycle.js';
import { clearQuotaCache, __test_getQuotaCache } from '../src/features/quota-manager.js';

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

cleanupAllTyping();
clearQuotaCache();

let sendTypingCalls: Array<{ to: string; msgId?: string }> = [];
const mockSendTyping = async (params: { to: string; msgId?: string }) => {
  sendTypingCalls.push(params);
  return true;
};

await test('startTypingWithRenewal: 启动 typing with passive mode', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCalls = [];

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-1',
    sendTyping: mockSendTyping,
  };

  await startTypingWithRenewal(params);

  assert(sendTypingCalls.length === 1, 'Should call sendTyping once');
  assert(sendTypingCalls[0].msgId === 'msg-1', 'Should send with msgId in passive mode');
  assert(isTypingActive('test-account', 'msg-1') === true, 'Should be active');

  // 反应式（2026-11-03）：typing 不占回复额度（平台实测），纯存活探测——
  // 不创建配额条目、不消耗 count、不发号
  const cache = __test_getQuotaCache();
  assert(!cache.has('test-account:c2c:msg-1'), 'typing 不应创建配额条目');
});

await test('startTypingWithRenewal: anchor dead → 不启动 typing（不降级主动）', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCalls = [];

  // 反应式：次数不阻断——判死锚点（平台 40034005/40034128）才停发
  const cache = __test_getQuotaCache();
  cache.set('test-account:c2c:msg-2', { count: 2, seq: 2, expiresAt: Date.now() + 60000, dead: true });

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user456',
    replyToId: 'msg-2',
    sendTyping: mockSendTyping,
  };

  await startTypingWithRenewal(params);

  assert(sendTypingCalls.length === 0, '锚点判死 ⇒ 不应发送 typing');
  assert(sendTypingCalls.every((c) => c.msgId !== undefined), 'typing 不得以主动形态发送');
  assert(isTypingActive('test-account', 'msg-2') === false, '不应处于活跃状态');
});

await test('续期时锚点过期 → 停止续期（不降级主动）', async () => {
  cleanupAllTyping();
  clearQuotaCache();
  sendTypingCalls = [];

  const cache = __test_getQuotaCache();
  cache.set('test-account:c2c:msg-4', { count: 0, seq: 0, expiresAt: Date.now() + 60000 });

  const origSetTimeout = globalThis.setTimeout;
  let captured: { cb: () => void } | undefined;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void) => {
    captured = { cb: cb as () => void };
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setTimeout;

  try {
    const params = {
      accountId: 'test-account',
      to: 'qqbot:c2c:user789',
      replyToId: 'msg-4',
      sendTyping: mockSendTyping,
    };
    await startTypingWithRenewal(params);
    assert(sendTypingCalls.length === 1, '初始发送一次');
    assert(captured, '应安排续期定时器');

    // 续期前锚点过期（TTL 到期）
    const entry = __test_getQuotaCache().get('test-account:c2c:msg-4');
    entry!.expiresAt = Date.now() - 1;

    captured!.cb();
    // 续期回调是异步的（void handleTypingRenewal(...)）——等一个微任务窗口
    await new Promise<void>((r) => origSetTimeout(r, 10));

    assert(sendTypingCalls.length === 1, '锚点过期后不应再续期');
    assert(sendTypingCalls.every((c) => c.msgId !== undefined), 'typing 不得以主动形态发送');
    assert(isTypingActive('test-account', 'msg-4') === false, '会话应已结束');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

await test('stopTyping: 停止 typing', () => {
  cleanupAllTyping();

  const params = {
    accountId: 'test-account',
    to: 'qqbot:c2c:user123',
    replyToId: 'msg-3',
  };

  stopTyping(params);
  assert(isTypingActive('test-account', 'msg-3') === false, 'Should not be active');
});

await test('cleanupAllTyping: 清理所有 typing', () => {
  cleanupAllTyping();
  assert(isTypingActive('test-account', 'msg-1') === false);
});

console.log('All typing lifecycle tests passed');
