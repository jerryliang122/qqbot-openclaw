/**
 * "正在输入"指示器（配额感知版）测试
 *
 * 覆盖：
 * - 续期间隔钳制（QPS 约束：不低于 20s）
 * - ReplyLimiter.tryAcquire 的占用语义
 * - 中间件行为：C2C-only、首次立即发送、完成后清理定时器、
 *   **锚点过期/判死 ⇒ 本轮停发（绝不降级为主动形态）**、
 *   平台拒收（40034005）⇒ 停发 + 标记死锚点
 * - 出站消息后 5s 补发续期（QQ 客户端收到消息会终止输入状态显示），
 *   任务完成后不再补发；补发同样受 20s QPS 间距保护
 * - 反应式配额：typing 不占回复额度（平台探针实测），仅锚点存活探测
 *   （probePassiveAnchorAlive），续期次数不因「文档上限」失效
 *
 * 运行方式: npx tsx tests/typing-indicator.test.ts
 */
import assert from 'node:assert';
import {
  c2cTypingIndicator,
  resolveTypingIntervalMs,
  MIN_TYPING_INTERVAL_MS,
  POST_MESSAGE_REFRESH_DELAY_MS,
} from '../src/middleware/typing.js';
import { probePassiveAnchorAlive } from '../src/outbound/outbound-service.js';
import {
  registerMsgIdWindow,
  invalidateMsgIdQuota,
  checkAndConsumePassiveReplyQuota,
  clearQuotaCache,
  __test_getQuotaCache,
} from '../src/features/quota-manager.js';
import { ReplyLimiter } from '../src/outbound/reply-limiter.js';
import {
  subscribeOutboundMessage,
  notifyOutboundMessageSent,
} from '../src/features/typing-refresh.js';

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── Mock ──────────────────────────────────────────────

interface CtxMock {
  message: { kind: string; senderId: string; messageId: string };
  replyTarget: { scope: string; targetId: string; msgId?: string };
  state: Record<string, unknown>;
  log: { debug?: (m: string) => void };
  bot: { sendTyping: (target: unknown, durationSec?: number) => Promise<void> };
}

function makeCtx(kind: 'c2c' | 'group', msgId: string, calls: string[]): CtxMock {
  return {
    message: { kind, senderId: 'u1', messageId: msgId },
    replyTarget:
      kind === 'c2c'
        ? { scope: 'c2c', targetId: 'u1', msgId }
        : { scope: 'group', targetId: 'g1', msgId },
    state: {},
    log: { debug() {} },
    bot: {
      // 记录 "msgId:durationSec"，msgId 为 undefined 表示主动发送（不带 msg_id）
      sendTyping: async (target: any, durationSec?: number) => {
        calls.push(`${target.msgId}:${durationSec}`);
      },
    },
  } as CtxMock;
}

// ── 测试开始 ──────────────────────────────────────────

group('续期间隔钳制（QPS 约束）');

await test('默认间隔为 20s', () => {
  assert.strictEqual(resolveTypingIntervalMs(undefined), 20_000);
});

await test('低于 20s 的配置被钳制到 20s', () => {
  assert.strictEqual(resolveTypingIntervalMs(5_000), MIN_TYPING_INTERVAL_MS);
  assert.strictEqual(resolveTypingIntervalMs(19_999), MIN_TYPING_INTERVAL_MS);
  assert.strictEqual(resolveTypingIntervalMs(1), MIN_TYPING_INTERVAL_MS);
});

await test('高于 20s 的配置保留原值', () => {
  assert.strictEqual(resolveTypingIntervalMs(45_000), 45_000);
});

group('ReplyLimiter.tryAcquire 占用语义');

await test('limit=4 时最多占用 4 次，之后拒绝', () => {
  const limiter = new ReplyLimiter({ limit: 4 });
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(limiter.tryAcquire('m1'), true, `第 ${i + 1} 次应成功`);
  }
  assert.strictEqual(limiter.tryAcquire('m1'), false, '配额耗尽后应拒绝');
});

await test('每次占用后剩余额度递减（与回复共享记账）', () => {
  const limiter = new ReplyLimiter({ limit: 4 });
  limiter.tryAcquire('m2');
  limiter.tryAcquire('m2');
  assert.strictEqual(limiter.checkLimit('m2').remaining, 2, '占用 2 次后应剩 2 条');
});

await test('不同 msgId 的配额互不影响', () => {
  const limiter = new ReplyLimiter({ limit: 4 });
  limiter.tryAcquire('m3a');
  limiter.tryAcquire('m3a');
  assert.strictEqual(limiter.tryAcquire('m3b'), true, '新消息有独立配额');
});

await test('无 msgId 时无法走被动通道（探测返回 false）', () => {
  assert.strictEqual(probePassiveAnchorAlive('acct-x', undefined), false);
});

group('中间件行为');

await test('群消息不发送 typing（平台仅支持 C2C）', async () => {
  const calls: string[] = [];
  let nextCalled = false;
  const mw = c2cTypingIndicator({ accountId: 'acct-g1' });
  await mw(makeCtx('group', 'gm1', calls) as any, async () => {
    nextCalled = true;
  });
  assert.strictEqual(calls.length, 0, '群消息不应发送 typing');
  assert.strictEqual(nextCalled, true, 'next 应被调用');
});

await test('C2C 消息立即发送一次（带 msg_id 被动发送），处理链完成后清理定时器', async () => {
  const calls: string[] = [];
  const mw = c2cTypingIndicator({ accountId: 'acct-c1' });
  await mw(makeCtx('c2c', 'cm1', calls) as any, async () => {
    await sleep(30); // 模拟 LLM 推理中
  });
  await sleep(50); // 完成后不应再有续期推送
  assert.strictEqual(calls.length, 1, '应只发送初始一次');
  assert.strictEqual(calls[0], 'cm1:60', '应带 msgId（被动）和 60s 窗口');
});

await test('锚点判死 → 本轮不再发送 typing（绝不降级为主动形态）', async () => {
  // 反应式模型：次数不再阻断；判死锚点（平台 40034005/40034128）⇒ 本轮停发
  clearQuotaCache();
  registerMsgIdWindow({ accountId: 'acct-c2', msgId: 'cm2', scope: 'c2c', receivedAt: Date.now() });
  invalidateMsgIdQuota({ accountId: 'acct-c2', msgId: 'cm2', scope: 'c2c' });
  assert.strictEqual(probePassiveAnchorAlive('acct-c2', 'cm2'), false);
  const calls: string[] = [];
  let nextCalled = false;
  const mw = c2cTypingIndicator({ accountId: 'acct-c2' });
  await mw(makeCtx('c2c', 'cm2', calls) as any, async () => {
    nextCalled = true;
  });
  assert.strictEqual(calls.length, 0, '锚点判死 ⇒ 本轮不发送 typing');
  assert.strictEqual(nextCalled, true, 'next 应被调用');
});

await test('turn 中途锚点判死 → 续期时停发', async () => {
  clearQuotaCache();
  registerMsgIdWindow({ accountId: 'acct-c2b', msgId: 'cm2b', scope: 'c2c', receivedAt: Date.now() });
  const calls: string[] = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  let captured: { cb: () => void } | undefined;
  globalThis.setInterval = ((cb: (...a: unknown[]) => void) => {
    captured = { cb: cb as () => void };
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;
  try {
    const mw = c2cTypingIndicator({ accountId: 'acct-c2b' });
    let releaseNext!: () => void;
    const nextDone = new Promise<void>((r) => { releaseNext = r; });
    const chainPromise = mw(makeCtx('c2c', 'cm2b', calls) as any, () => nextDone);

    assert.strictEqual(calls.length, 1, '锚点存活 → 初始发送一次');
    assert.ok(captured, '应创建续期定时器');

    // turn 中途锚点判死（平台 40034005 路径）
    invalidateMsgIdQuota({ accountId: 'acct-c2b', msgId: 'cm2b', scope: 'c2c' });

    captured!.cb();
    assert.strictEqual(calls.length, 1, '锚点判死后不应再发送 typing');

    releaseNext();
    await chainPromise;
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

await test('平台拒收 typing（40034005）→ 停发并标记死锚点', async () => {
  clearQuotaCache();
  registerMsgIdWindow({ accountId: 'acct-c2c', msgId: 'cm2c', scope: 'c2c', receivedAt: Date.now() });
  const calls: string[] = [];
  const ctxMock = makeCtx('c2c', 'cm2c', calls);
  ctxMock.bot.sendTyping = async () => {
    calls.push('cm2c:60');
    const err = new Error('reply msg_id expired') as Error & { bizCode?: number };
    err.bizCode = 40034005;
    throw err;
  };
  const mw = c2cTypingIndicator({ accountId: 'acct-c2c' });
  await mw(ctxMock as any, async () => {
    await sleep(10); // 给 .catch 一个微任务窗口
  });
  assert.strictEqual(calls.length, 1, '仅首次发送');
  const entry = __test_getQuotaCache().get('acct-c2c:c2c:cm2c');
  assert.ok(entry, '应存在配额条目');
  assert.strictEqual(entry!.dead, true, '平台拒收 ⇒ 锚点应标记为死（后续消息不得走被动）');
});

await test('不变量：typing 调用永远带 msgId（不占主动额度）', async () => {
  clearQuotaCache();
  registerMsgIdWindow({ accountId: 'acct-c2d', msgId: 'cm2d', scope: 'c2c', receivedAt: Date.now() });
  const calls: string[] = [];
  const mw = c2cTypingIndicator({ accountId: 'acct-c2d' });
  await mw(makeCtx('c2c', 'cm2d', calls) as any, async () => {});
  assert.ok(calls.length >= 1, '应有 typing 调用');
  for (const c of calls) {
    assert.ok(!c.startsWith('undefined:'), `typing 不得以主动形态发送：${c}`);
  }
});

await test('续期定时器间隔为 20s，续期全程被动（次数不失效）', async () => {
  const calls: string[] = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  let captured: { cb: () => void; ms: number } | undefined;
  let nextHandle = 0;
  let lastHandle = -1;
  const clearedHandles = new Set<number>();
  globalThis.setInterval = ((cb: (...a: unknown[]) => void, ms?: number) => {
    captured = { cb: cb as () => void, ms: ms ?? 0 };
    lastHandle = ++nextHandle;
    return lastHandle as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((h: unknown) => {
    clearedHandles.add(Number(h));
  }) as unknown as typeof globalThis.clearInterval;
  try {
    clearQuotaCache();
    const mw = c2cTypingIndicator({ accountId: 'acct-c3', intervalMs: 1_000 }); // 应被钳制
    // next 挂起，模拟框架任务仍在进行（完成后 sendNow 不再生效）
    let releaseNext!: () => void;
    const nextDone = new Promise<void>((r) => { releaseNext = r; });
    const chainPromise = mw(makeCtx('c2c', 'cm3', calls) as any, () => nextDone);

    assert.ok(captured, '应创建续期定时器');
    assert.strictEqual(captured!.ms, 20_000, '续期间隔应被钳制到 20000ms');
    assert.strictEqual(calls.length, 1, '初始发送一次');

    // 连续触发 5 次续期回调：锚点存活 → 全程带 msgId（反应式：次数不失效）
    // cb 始终是同一个 sendNow 闭包，重置锚点不影响触发
    for (let i = 0; i < 5; i++) captured!.cb();
    assert.strictEqual(calls.length, 6, '续期不应中断');
    const passive = calls.filter((c) => c === 'cm3:60').length;
    assert.strictEqual(passive, 6, '锚点存活期间续期全程带 msgId（平台不执行次数上限）');

    releaseNext();
    await chainPromise;
    assert.ok(clearedHandles.has(lastHandle), '处理链完成后应清理最新注册的定时器');

    // 任务完成后周期回调不再发送
    captured!.cb();
    assert.strictEqual(calls.length, 6, '任务完成后不应再发送');
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
  }
});

await test('typing 不消耗 count：发送后观测计数不含 typing', async () => {
  clearQuotaCache();
  const calls: string[] = [];
  const mw = c2cTypingIndicator({ accountId: 'acct-c4' });
  await mw(makeCtx('c2c', 'cm4', calls) as any, async () => {});
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0], 'cm4:60', 'typing 带 msgId 发送');

  // typing 未产生任何配额条目（不消耗、不发号）
  assert.ok(!__test_getQuotaCache().has('acct-c4:c2c:cm4'), 'typing 不应创建配额条目');

  // 之后正文回复消耗 6 次（超文档上限 4）全部放行，count 只含正文消耗
  for (let i = 0; i < 6; i++) {
    assert.strictEqual(
      checkAndConsumePassiveReplyQuota({ accountId: 'acct-c4', msgId: 'cm4', scope: 'c2c' }).canReply,
      true,
    );
  }
  const entry = __test_getQuotaCache().get('acct-c4:c2c:cm4');
  assert.ok(entry);
  assert.strictEqual(entry!.count, 6, '观测计数应只含正文消耗（typing 不计入）');
});

group('出站消息信号（typing-refresh）');

await test('subscribe 后 notify 触发监听器，取消订阅后不再触发', () => {
  let fired = 0;
  const off = subscribeOutboundMessage('acct-s1', 'c2c', 'u1', () => fired++);
  notifyOutboundMessageSent('acct-s1', 'c2c', 'u1');
  assert.strictEqual(fired, 1);
  off();
  notifyOutboundMessageSent('acct-s1', 'c2c', 'u1');
  assert.strictEqual(fired, 1, '取消订阅后不应再触发');
});

await test('不同账号 / scope / 用户的信号互不干扰', () => {
  let fired = 0;
  const off = subscribeOutboundMessage('acct-s2', 'c2c', 'u1', () => fired++);
  notifyOutboundMessageSent('acct-s2', 'group', 'u1');
  notifyOutboundMessageSent('acct-other', 'c2c', 'u1');
  notifyOutboundMessageSent('acct-s2', 'c2c', 'u2');
  assert.strictEqual(fired, 0, '非本会话的出站消息不应触发');
  off();
});

group('出站消息后补发续期');

await test('中间消息发出后 5s 补发续期，受 QPS 间距保护顺延', async () => {
  const calls: string[] = [];
  const intervals: { cb: () => void; ms: number }[] = [];
  const timeouts: { cb: () => void; ms: number }[] = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((cb: (...a: unknown[]) => void, ms?: number) => {
    intervals.push({ cb: cb as () => void, ms: ms ?? 0 });
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number) => {
    timeouts.push({ cb: cb as () => void, ms: ms ?? 0 });
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof globalThis.clearTimeout;

  try {
    const mw = c2cTypingIndicator({ accountId: 'acct-p1' });
    // next 挂起，模拟框架任务仍在进行
    let releaseNext!: () => void;
    const nextDone = new Promise<void>((r) => { releaseNext = r; });
    const chainPromise = mw(makeCtx('c2c', 'pm1', calls) as any, () => nextDone);

    assert.strictEqual(calls.length, 1, '初始发送一次');
    assert.strictEqual(timeouts.length, 0, '尚无消息发出，不应安排补发');

    // 模拟思维链等中间消息发送成功
    notifyOutboundMessageSent('acct-p1', 'c2c', 'u1');
    assert.strictEqual(timeouts.length, 1, '应安排一次补发');
    assert.strictEqual(timeouts[0].ms, POST_MESSAGE_REFRESH_DELAY_MS, `补发延迟应为 ${POST_MESSAGE_REFRESH_DELAY_MS}ms`);

    // 5s 到期：与初始发送间距不足 20s（QPS），应顺延而非立即发送
    timeouts[0].cb();
    assert.strictEqual(calls.length, 1, '间距不足时不应立即补发');
    assert.strictEqual(timeouts.length, 2, '应顺延剩余间距');
    assert.ok(timeouts[1].ms > 0 && timeouts[1].ms <= MIN_TYPING_INTERVAL_MS,
      `顺延时长应在 (0, ${MIN_TYPING_INTERVAL_MS}]，实际 ${timeouts[1].ms}`);

    // 顺延到期 → 补发（配额内仍走被动）
    timeouts[1].cb();
    assert.strictEqual(calls.length, 2, '应补发一次续期');
    assert.strictEqual(calls[1], 'pm1:60', '补发仍带 msgId（被动）');

    // 模拟最终消息 + 任务完成
    releaseNext();
    await chainPromise;
    const timeoutCountAfterDone = timeouts.length;
    notifyOutboundMessageSent('acct-p1', 'c2c', 'u1');
    assert.strictEqual(timeouts.length, timeoutCountAfterDone, '任务完成后不应再安排补发');
    assert.strictEqual(calls.length, 2, '任务完成后不应再补发');
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});

await test('连续多条中间消息：每条都重新安排补发（不叠加）', async () => {
  const calls: string[] = [];
  const timeouts: { cb: () => void; ms: number }[] = [];
  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  globalThis.setInterval = ((cb: unknown) => ({ cb }) as unknown as NodeJS.Timeout) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = (() => {}) as unknown as typeof globalThis.clearInterval;
  globalThis.setTimeout = ((cb: (...a: unknown[]) => void, ms?: number) => {
    timeouts.push({ cb: cb as () => void, ms: ms ?? 0 });
    return 1 as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof globalThis.clearTimeout;

  try {
    const mw = c2cTypingIndicator({ accountId: 'acct-p2' });
    let releaseNext!: () => void;
    const nextDone = new Promise<void>((r) => { releaseNext = r; });
    const chainPromise = mw(makeCtx('c2c', 'pm2', calls) as any, () => nextDone);

    // 两条中间消息接连发出 → 只有最新的补发计时生效（clearTimeout 后重设）
    notifyOutboundMessageSent('acct-p2', 'c2c', 'u1');
    notifyOutboundMessageSent('acct-p2', 'c2c', 'u1');
    assert.strictEqual(timeouts.length, 2, '每次消息都重新安排（旧的被清除，不叠加计时）');

    releaseNext();
    await chainPromise;
  } finally {
    globalThis.setInterval = origSetInterval;
    globalThis.clearInterval = origClearInterval;
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
  }
});

// ── 输出测试结果 ──────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  process.exit(0);
}
