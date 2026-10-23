/**
 * "正在输入"指示器（配额感知版）测试
 *
 * 覆盖：
 * - 续期间隔钳制（QPS 约束：不低于 20s）
 * - ReplyLimiter.tryAcquire 的占用语义
 * - 中间件行为：C2C-only、首次立即发送、完成后清理定时器、
 *   被动配额耗尽后降级为主动发送（不带 msg_id）且续期不中断
 * - 出站消息后 5s 补发续期（QQ 客户端收到消息会终止输入状态显示），
 *   任务完成后不再补发；补发同样受 20s QPS 间距保护
 * - typing 与回复共享被动配额（tryAcquirePassiveSlot 记账）
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
import { tryAcquirePassiveSlot } from '../src/outbound/outbound-service.js';
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

await test('默认间隔为 45s（一次 notify 覆盖 60s，20s 续期会把同一窗口重复消耗 3 遍）', () => {
  // 2026-10-23 真机事故：typing 与回复共享同一份被动配额（c2c 4 条/msg_id），
  // 每 20s 续一次而一次 notify 的 input_second 就是 60s → 首字节 42s 就吃掉 3 条，
  // 回复只剩 1 条 → 正文块被挤掉。默认改为 45s（< 60s 窗口，续期不中断指示器）。
  assert.strictEqual(resolveTypingIntervalMs(undefined), 45_000);
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

await test('无 msgId 时不占被动配额（无法走被动通道）', () => {
  assert.strictEqual(tryAcquirePassiveSlot('acct-x', undefined), false);
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

await test('被动配额耗尽后降级为主动发送（不带 msg_id）', async () => {
  // 预耗尽该 msg_id 的被动配额（limit=4）
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(tryAcquirePassiveSlot('acct-c2', 'cm2'), true);
  }
  const calls: string[] = [];
  let nextCalled = false;
  const mw = c2cTypingIndicator({ accountId: 'acct-c2' });
  await mw(makeCtx('c2c', 'cm2', calls) as any, async () => {
    nextCalled = true;
  });
  assert.strictEqual(calls.length, 1, '配额耗尽不应中断 typing');
  assert.strictEqual(calls[0], 'undefined:60', '应不带 msgId（主动）发送');
  assert.strictEqual(nextCalled, true, 'next 应被调用');
});

await test('续期定时器间隔为 20s，续期不因配额耗尽而中断', async () => {
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
    const mw = c2cTypingIndicator({ accountId: 'acct-c3', intervalMs: 1_000 }); // 应被钳制
    // next 挂起，模拟框架任务仍在进行（完成后 sendNow 不再生效）
    let releaseNext!: () => void;
    const nextDone = new Promise<void>((r) => { releaseNext = r; });
    const chainPromise = mw(makeCtx('c2c', 'cm3', calls) as any, () => nextDone);

    assert.ok(captured, '应创建续期定时器');
    assert.strictEqual(captured!.ms, 20_000, '续期间隔应被钳制到 20000ms（下限不变）');
    assert.strictEqual(calls.length, 1, '初始发送一次');

    // 连续触发 5 次续期回调：limit=4，前 3 次被动（带 msgId），之后降级主动（无 msgId）
    // cb 始终是同一个 sendNow 闭包，重置锚点不影响触发
    for (let i = 0; i < 5; i++) captured!.cb();
    assert.strictEqual(calls.length, 6, '续期不应中断');
    const passive = calls.filter((c) => c === 'cm3:60').length;
    const proactive = calls.filter((c) => c === 'undefined:60').length;
    assert.strictEqual(passive, 4, '被动配额 limit=4，应恰好 4 次带 msgId');
    assert.strictEqual(proactive, 2, '配额耗尽后应降级主动发送');

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

await test('typing 与回复共享配额：同一 limiter 记账', async () => {
  const calls: string[] = [];
  const mw = c2cTypingIndicator({ accountId: 'acct-c4' });
  await mw(makeCtx('c2c', 'cm4', calls) as any, async () => {});
  assert.strictEqual(calls.length, 1);
  // typing 已占 1 条，再占 3 条后耗尽（limit=4），后续 typing/回复都走主动通道
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(tryAcquirePassiveSlot('acct-c4', 'cm4'), true);
  }
  assert.strictEqual(tryAcquirePassiveSlot('acct-c4', 'cm4'), false, '配额耗尽后应返回 false');
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

    // 5s 到期：与初始发送间距不足（QPS/续期间隔），应顺延而非立即发送
    const intervalMs = resolveTypingIntervalMs(undefined);
    timeouts[0].cb();
    assert.strictEqual(calls.length, 1, '间距不足时不应立即补发');
    assert.strictEqual(timeouts.length, 2, '应顺延剩余间距');
    assert.ok(timeouts[1].ms > 0 && timeouts[1].ms <= intervalMs,
      `顺延时长应在 (0, ${intervalMs}]，实际 ${timeouts[1].ms}`);

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
