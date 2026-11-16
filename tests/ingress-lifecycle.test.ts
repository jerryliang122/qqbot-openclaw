/**
 * 持久化入站 · turn 采纳生命周期接线 回归测试
 *
 * 覆盖（dispatch.ts 的 buildIngressBoundAdoptionLifecycle）：
 * 1. onAdopted / onDeferred / onAbandoned 都映射到 drain 的 lifecycle，
 *    且本插件的 onTurnSubmitted **恰好触发一次**；
 * 2. drain 钩子抛错**不会**冒泡（框架 `await onAdopted()` 会把异常
 *    冒成 turn 失败——记账错误不该让用户这一轮失败）；
 * 3. abortSignal / deferredHeartbeatIntervalMs 原样透传。
 *
 * 运行方式: npx tsx tests/ingress-lifecycle.test.ts
 */
import assert from 'node:assert/strict';
import { buildIngressBoundAdoptionLifecycle } from '../src/dispatch/dispatch.js';

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

function makeIngress(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const controller = new AbortController();
  const lifecycle = {
    abortSignal: controller.signal,
    onAdopted: () => {
      calls.push('onAdopted');
    },
    onDeferred: () => {
      calls.push('onDeferred');
    },
    onDeferredHeartbeat: () => {
      calls.push('onDeferredHeartbeat');
    },
    deferredHeartbeatIntervalMs: 1234,
    onAdoptionFinalizing: () => {
      calls.push('onAdoptionFinalizing');
    },
    onAbandoned: () => {
      calls.push('onAbandoned');
    },
    ...overrides,
  };
  return { lifecycle, calls, controller };
}

group('采纳生命周期映射');

await test('onAdopted：转发给 drain 且通知 onTurnSubmitted', async () => {
  const { lifecycle, calls } = makeIngress();
  let notified = 0;
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'agent:main:qqbot:group:g1',
    notifyTurnSubmitted: () => {
      notified += 1;
    },
  });
  await bound.onAdopted();
  assert.deepEqual(calls, ['onAdopted']);
  assert.equal(notified, 1);
});

await test('onDeferred：转发给 drain 且通知 onTurnSubmitted', async () => {
  const { lifecycle, calls } = makeIngress();
  let notified = 0;
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {
      notified += 1;
    },
  });
  bound.onDeferred();
  assert.deepEqual(calls, ['onDeferred']);
  assert.equal(notified, 1);
});

await test('onAbandoned：转发给 drain 且通知 onTurnSubmitted', async () => {
  const { lifecycle, calls } = makeIngress();
  let notified = 0;
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {
      notified += 1;
    },
  });
  await bound.onAbandoned();
  assert.deepEqual(calls, ['onAbandoned']);
  assert.equal(notified, 1);
});

group('错误隔离');

await test('drain 钩子抛错不冒泡（turn 不能因记账失败而失败）', async () => {
  const { lifecycle } = makeIngress({
    onAdopted: () => {
      throw new Error('drain bookkeeping exploded');
    },
  });
  let notified = 0;
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {
      notified += 1;
    },
  });
  await bound.onAdopted();
  assert.equal(notified, 1, '通知仍须发生（否则链悬挂）');
});

await test('drain 钩子返回 rejected promise 也不冒泡', async () => {
  const { lifecycle } = makeIngress({
    onAbandoned: async () => {
      throw new Error('async boom');
    },
  });
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {},
  });
  await bound.onAbandoned();
});

group('透传');

await test('abortSignal 与心跳间隔原样透传', () => {
  const { lifecycle, controller } = makeIngress();
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {},
  });
  assert.equal(bound.abortSignal, controller.signal);
  assert.equal(bound.deferredHeartbeatIntervalMs, 1234);
  assert.equal(typeof bound.onDeferredHeartbeat, 'function');
  bound.onDeferredHeartbeat?.();
});

await test('admission 恒为 exclusive（与框架契约一致）', () => {
  const { lifecycle } = makeIngress();
  const bound = buildIngressBoundAdoptionLifecycle({
    ingress: lifecycle as never,
    isGroup: true,
    sessionKey: 'k',
    notifyTurnSubmitted: () => {},
  });
  assert.equal(bound.admission, 'exclusive');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
