/**
 * 持久化入站队列 回归测试
 *
 * 覆盖：
 * 1. lane key / 队列行 id 的构造（按群、跨账号不撞号）；
 * 2. **能力探测**：core 未提供队列 API ⇒ 返回 null（调用方回落内存合批）；
 * 3. 入队失败 ⇒ 返回 false（调用方必须回落直发，不可丢消息）；
 * 4. drain 派发回调路由到注册的 handler（未注册时动态载入并注册）；
 * 5. lane 忙闲读的是 drain 的 activeLaneKeys（durable claim 状态，
 *    不是 dispatch promise 生命周期）。
 *
 * 运行方式: npx tsx tests/ingress-queue.test.ts
 */
import assert from 'node:assert/strict';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import {
  buildIngressLaneKey,
  buildIngressQueueId,
  enqueueGroupInbound,
  getIngressAccount,
  isIngressDurableAvailable,
  isIngressLaneBusy,
  resetIngressStateForTest,
  setIngressDispatchHandlers,
  type IngressAccountHandle,
  type QQBotIngressClaim,
  type QQBotIngressLifecycle,
} from '../src/features/ingress-queue.js';
import { INGRESS_PAYLOAD_VERSION, type QQBotIngressPayload } from '../src/features/ingress-payload.js';

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

/** 内存态假队列（只实现本插件用到的面） */
class FakeQueue {
  rows = new Map<string, { payload: QQBotIngressPayload; receivedAt: number; laneKey: string }>();
  failEnqueue = false;

  async enqueue(id: string, payload: QQBotIngressPayload, options?: { receivedAt?: number; laneKey?: string }) {
    if (this.failEnqueue) throw new Error('disk on fire');
    this.rows.set(id, {
      payload,
      receivedAt: options?.receivedAt ?? Date.now(),
      laneKey: options?.laneKey ?? '',
    });
    return { id, state: 'pending' as const };
  }
  async listPending() {
    return [...this.rows.entries()].map(([id, r]) => ({ id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey }));
  }
  async claimNext(options?: { blockedLaneKeys?: Iterable<string> }) {
    const blocked = new Set(options?.blockedLaneKeys ?? []);
    for (const [id, r] of this.rows) {
      if (blocked.has(r.laneKey)) continue;
      return { id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey } as unknown as QQBotIngressClaim;
    }
    return null;
  }
  async claim(id: string) {
    const r = this.rows.get(id);
    if (!r) return null;
    return { id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey } as unknown as QQBotIngressClaim;
  }
  async complete(id: string | { id: string }) {
    const key = typeof id === 'string' ? id : id.id;
    return this.rows.delete(key);
  }
  async release() { return true; }
  async fail() { return true; }
  async recoverStaleClaims() { return 0; }
  async prune() { return 0; }
}

/** 假 drain */
function makeFakeDrain(queue: FakeQueue) {
  const active = new Set<string>();
  return {
    queue,
    active,
    drain: {
      recoverStaleClaims: async () => 0,
      drainOnce: async () => ({ started: 0 }),
      activeLaneKeys: () => active as ReadonlySet<string>,
      waitForIdle: async () => {},
      dispose: () => {},
    },
  };
}

/** 造一个带 state 队列 API 的假 runtime */
function makeRuntime(
  queue: FakeQueue,
  drain: ReturnType<typeof makeFakeDrain>['drain'],
  captured?: { options?: Record<string, unknown> },
): PluginRuntime {
  return {
    version: '2026.10.5',
    state: {
      openChannelIngressQueue: () => queue as never,
      openChannelIngressDrain: (options: Record<string, unknown>) => {
        if (captured) captured.options = options;
        return drain as never;
      },
    },
  } as unknown as PluginRuntime;
}

function makePayload(overrides: Partial<QQBotIngressPayload> = {}): QQBotIngressPayload {
  return {
    v: INGRESS_PAYLOAD_VERSION,
    accountId: 'acc1',
    groupOpenid: 'g1',
    messageId: 'm1',
    senderId: 'u1',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    content: 'x',
    rawContent: 'x',
    platformTimestamp: '1',
    receivedAtMs: 1000,
    mention: { wasMentioned: false, implicit: false },
    nameMentioned: false,
    ...overrides,
  };
}

group('键构造');

await test('lane key 按群（不同发言人同 lane）', () => {
  assert.equal(buildIngressLaneKey('acc1', 'g1'), 'qqbot:acc1:group:g1');
  assert.equal(buildIngressLaneKey('acc1', 'g2'), 'qqbot:acc1:group:g2');
  // 跨账号不撞
  assert.notEqual(buildIngressLaneKey('acc1', 'g1'), buildIngressLaneKey('acc2', 'g1'));
});

await test('队列行 id 含账号前缀（跨账号 msgId 撞号不串行）', () => {
  assert.equal(buildIngressQueueId('acc1', 'm1'), 'qqbot-group:acc1:m1');
  assert.notEqual(buildIngressQueueId('acc1', 'm1'), buildIngressQueueId('acc2', 'm1'));
});

group('能力探测与降级');

await test('core 未提供队列 API ⇒ 判定不可用', () => {
  const bare = { version: '2026.10.5' } as unknown as PluginRuntime;
  assert.equal(isIngressDurableAvailable(bare), false);
  assert.equal(getIngressAccount(bare, 'acc-x'), null);
});

await test('队列初始化抛错 ⇒ 判定不可用（回落内存合批）', () => {
  const runtime = {
    version: '2026.10.5',
    state: {
      openChannelIngressQueue: () => {
        throw new Error('boom');
      },
      openChannelIngressDrain: () => ({}) as never,
    },
  } as unknown as PluginRuntime;
  assert.equal(getIngressAccount(runtime, 'acc-boom'), null);
});

group('入队');

await test('入队成功 ⇒ true，行落在 lane 上', async () => {
  resetIngressStateForTest();
  const queue = new FakeQueue();
  const fake = makeFakeDrain(queue);
  const runtime = makeRuntime(queue, fake.drain);
  const ok = await enqueueGroupInbound(runtime, 'acc1', makePayload({ messageId: 'm-1' }));
  assert.equal(ok, true);
  assert.equal(queue.rows.size, 1);
  const row = queue.rows.get('qqbot-group:acc1:m-1');
  assert.ok(row);
  assert.equal(row!.laneKey, 'qqbot:acc1:group:g1');
  assert.equal(row!.receivedAt, 1000);
});

await test('入队失败 ⇒ false（调用方必须回落直发）', async () => {
  resetIngressStateForTest();
  const queue = new FakeQueue();
  queue.failEnqueue = true;
  const fake = makeFakeDrain(queue);
  const runtime = makeRuntime(queue, fake.drain);
  const ok = await enqueueGroupInbound(runtime, 'acc1', makePayload({ messageId: 'm-2' }));
  assert.equal(ok, false);
});

await test('lane 忙闲读的是 drain 的 activeLaneKeys', async () => {
  resetIngressStateForTest();
  const queue = new FakeQueue();
  const fake = makeFakeDrain(queue);
  const runtime = makeRuntime(queue, fake.drain);
  const handle = getIngressAccount(runtime, 'acc1');
  assert.ok(handle);
  const lane = buildIngressLaneKey('acc1', 'g1');
  assert.equal(isIngressLaneBusy(handle as IngressAccountHandle, lane), false);
  fake.active.add(lane);
  assert.equal(isIngressLaneBusy(handle as IngressAccountHandle, lane), true);
});

group('派发回调路由');

await test('注册的 handler 收到 claim 与 lifecycle', async () => {
  resetIngressStateForTest();
  const queue = new FakeQueue();
  const fake = makeFakeDrain(queue);
  const captured: { options?: Record<string, unknown> } = {};
  const runtime = makeRuntime(queue, fake.drain, captured);
  const handle = getIngressAccount(runtime, 'acc1');
  assert.ok(handle);

  let seen: { claimId?: string; hasLifecycle?: boolean; laneKey?: string } = {};
  setIngressDispatchHandlers({
    dispatchClaimedEvent: async (claim, lifecycle) => {
      seen = { claimId: claim.id, hasLifecycle: !!lifecycle?.onAdopted, laneKey: claim.laneKey };
      return { kind: 'completed' };
    },
  });

  const options = captured.options as
    | { dispatchClaimedEvent: (claim: unknown, lifecycle: unknown) => Promise<unknown>; ownerId?: string; orderBy?: string }
    | undefined;
  assert.ok(options, 'drain options 未捕获');
  assert.equal(options!.orderBy, 'received', '必须按到达序领行（不是插入序）');
  assert.ok(options!.ownerId && options!.ownerId.includes('acc1'));

  const lifecycle = {
    abortSignal: new AbortController().signal,
    onAdopted: () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: () => {},
  } as unknown as QQBotIngressLifecycle;

  const result = await options!.dispatchClaimedEvent(
    { id: 'row-1', payload: makePayload(), laneKey: 'qqbot:acc1:group:g1' },
    lifecycle,
  );
  assert.deepEqual(result, { kind: 'completed' });
  assert.equal(seen.claimId, 'row-1');
  assert.equal(seen.hasLifecycle, true);
  assert.equal(seen.laneKey, 'qqbot:acc1:group:g1');
});

resetIngressStateForTest();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
