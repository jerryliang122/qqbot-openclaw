/**
 * webhook detached 派发回归测试（issue #74：transport=webhook 入站 100% 被
 * GatewayDrainingError 拒）。
 *
 * 机制背景（全部经已安装 openclaw 2026.10.5 dist 实证）：
 *  1. core 对每个 HTTP 请求持一次 root-work 准入，插件路由 handler settle
 *     即释放；SDK WebhookTransport.handleRequest 先 ACK、把派发
 *     fire-and-forget 到后台——那条链经 AsyncLocalStorage 继承的请求根
 *     已释放 → 框架 enqueue 处 isGatewaySubordinateWorkAdmissionClosed()
 *     判 `current.released === true` → GatewayDrainingError。
 *  2. 修法：op:0 委托放进 openclaw/plugin-sdk/webhook-request-guards 的
 *     runDetachedWebhookWork 回调（detached 根在回调挂起期间保持引用），
 *     回调内等「本次委托派生的在途派发」全部落地（tracker scope 登记）。
 *  3. **只包 runDetachedWebhookWork 不等登记表是不够的**：SDK 的后台
 *     promise 不在回调的 AsyncWorkScope 里，回调随 ACK settle 后 detached
 *     根照样释放——「money test」同时锁这两件事。
 *
 * 覆盖（含 Sourcery 评审 8 条意见的回归面）：
 *  A. tracker scope 语义：同步级联圈定 / end() 后他人登记不混入（并发
 *     请求各自持根）/ 超时截断 / 秒完成计入 / 容量上限（settled 与卡死
 *     unsettled 均 FIFO 有界——评审意见 3、4）；
 *  B. installWebhookDispatchTracking：surface 缺失 WARN；真实 QQBot 实例
 *     （构造无网络副作用）包裹后派发被同步登记、随链 settle；
 *  C. createInteractionDispatchListener（网关真实接线，评审意见 8）：
 *     type-13 观测型互动事件经真实 handleInteraction 驱动——同步登记、
 *     settle 出表、错误走 onError；
 *  D. dispatchOp0WithDetachedWork：detached 回调内委托 + 等 scope 归零；
 *     委托失败兜底写 500（评审意见 2）；tripwire；guards 缺失直连；
 *     **默认 loader + 真实 runDetachedWebhookWork 的生产路径**（评审意见 7）；
 *  E. 真实 SDK WebhookTransport + 合法 Ed25519 签名的 op:0：ACK 即时、
 *     包裹后的 handleInboundMessage 同步登记、ACK 落地先于派发链完成；
 *  F. money test（子进程加载真实 openclaw dist 的准入状态机）：
 *     fire-and-forget 链在根释放后 enqueue 判 closed=true（复现 bug）；
 *     runDetachedWebhookWork + 回调内 await 工作期间判 closed=false（修法）；
 *  G. withDetachedWebhookWork（group-merge 冲刷的包裹原语，评审意见 1）：
 *     包裹 / 直跑降级 / 真实默认 loader。
 *
 * 运行方式: npx tsx tests/webhook-detached-dispatch.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQBot, type InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import { WebhookTransport, ed25519Sign } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  beginWebhookDispatchScope,
  installWebhookDispatchTracking,
  makeTrackedListener,
  resetWebhookDispatchTrackerForTest,
  settleWebhookDispatchScope,
  trackWebhookDispatch,
  webhookDispatchTrackerStatsForTest,
} from '../src/features/webhook-dispatch-tracker.js';
import {
  loadDetachedWebhookGuards,
  withDetachedWebhookWork,
} from '../src/features/detached-webhook-work.js';
import { dispatchOp0WithDetachedWork, writeErrorResponse } from '../src/adapter/webhook.js';
import { createInteractionDispatchListener } from '../src/gateway/qqbot-gateway.js';
import type { PluginLogger } from '../src/utils/plugin-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** settle 的超时定时器是 unref() 的：依赖它的等待需挂 ref'd 心跳保活 */
async function keepAlive<T>(p: Promise<T>): Promise<T> {
  const heartbeat = setInterval(() => {}, 50);
  try {
    return await p;
  } finally {
    clearInterval(heartbeat);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** 收集 warn/error 的假 logger */
function fakeLogger() {
  const lines: string[] = [];
  const log: PluginLogger = {
    info: () => {}, debug: () => {},
    warn: (m: string) => { lines.push(`WARN: ${m}`); },
    error: (m: string) => { lines.push(`ERROR: ${m}`); },
    child: () => log,
  };
  return { lines, log };
}

/** 手动释放闸 */
function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
}

group('A. tracker scope 语义');

await test('scope 只圈定同步级联里的登记；end() 后他人的登记不混入（并发隔离）', async () => {
  resetWebhookDispatchTrackerForTest();
  // scope 外的旧条目（他请求）——不得被等
  const old = deferred();
  trackWebhookDispatch('acct-a', old.promise);

  const scope = beginWebhookDispatchScope();
  const mine = deferred();
  trackWebhookDispatch('acct-a', mine.promise); // 同步级联内的登记
  scope.end();

  // end() 之后他人（并发请求）的登记——不得被等
  const concurrent = deferred();
  trackWebhookDispatch('acct-a', concurrent.promise);

  const settle = settleWebhookDispatchScope(scope, 5_000);
  // 圈内的先放行：若实现错误地等账号级全局工作（old/concurrent 仍挂起），
  // settle 不会返回——outsiders 必须保持 pending 直到断言完成
  mine.release();
  const result = await keepAlive(settle);
  assert.equal(result.awaited, 1, '只等 scope 圈定的 1 条');
  assert.equal(result.timedOut, false);
  old.release();
  concurrent.release();
  await sleep(10);
});

await test('超时截断：timedOut=true 且不中断被等的工作', async () => {
  resetWebhookDispatchTrackerForTest();
  const scope = beginWebhookDispatchScope();
  const work = deferred();
  trackWebhookDispatch('acct-a', work.promise);
  scope.end();

  const result = await keepAlive(settleWebhookDispatchScope(scope, 50));
  assert.equal(result.timedOut, true);
  assert.equal(result.awaited, 1);
  work.release();
  await sleep(10);
});

await test('秒完成的派发也计入（awaited≥1）；空 scope 立即返回 awaited=0', async () => {
  resetWebhookDispatchTrackerForTest();
  const scope = beginWebhookDispatchScope();
  trackWebhookDispatch('acct-a', Promise.resolve());
  scope.end();
  const r1 = await settleWebhookDispatchScope(scope, 1_000);
  assert.deepEqual(r1, { awaited: 1, timedOut: false });

  const empty = beginWebhookDispatchScope();
  empty.end();
  const r2 = await settleWebhookDispatchScope(empty, 1_000);
  assert.deepEqual(r2, { awaited: 0, timedOut: false });
});

await test('容量上限：settled 与永不 settle 的条目均 FIFO 有界', async () => {
  resetWebhookDispatchTrackerForTest();
  // 70 条已完成 → settled 上限 64
  for (let i = 0; i < 70; i++) trackWebhookDispatch('acct-a', Promise.resolve());
  await sleep(10);
  let stats = webhookDispatchTrackerStatsForTest()['acct-a'];
  assert.ok(stats.settled <= 64, `settled 条目应有界（实际 ${stats.settled}）`);

  // 70 条永不 settle → unsettled 上限 64（卡死条目不许多到无界）
  resetWebhookDispatchTrackerForTest();
  for (let i = 0; i < 70; i++) trackWebhookDispatch('acct-a', new Promise<void>(() => {}));
  stats = webhookDispatchTrackerStatsForTest()['acct-a'];
  assert.ok(stats.unsettled <= 64, `未 settle 条目应有界（实际 ${stats.unsettled}）`);
});

group('B. installWebhookDispatchTracking（真实 QQBot 实例，构造无网络）');

function newTestBot(): QQBot {
  return new QQBot({ appId: 'test-appid', appSecret: 'test-secret', accountId: 'acct-a' });
}

await test('包裹后：handleInboundMessage 派发被登记且随链 settle', async () => {
  resetWebhookDispatchTrackerForTest();
  const bot: any = newTestBot();
  const listenerDone = deferred();
  bot.on('message', () => listenerDone.promise);
  installWebhookDispatchTracking(bot, 'acct-a', fakeLogger().log);

  const scope = beginWebhookDispatchScope();
  const c2cRaw = {
    id: 'msg-1', timestamp: Date.now(),
    author: { user_openid: 'openid-user' },
    content: 'hello',
  };
  const dispatched = bot.handleInboundMessage(c2cRaw);
  // 同步级联断言：登记必须发生在派发链的第一个 await 之前——
  // settle 的快照逻辑在同一 tick 同步执行，若包裹只异步登记会漏拍
  const settleProbe = settleWebhookDispatchScope(scope, 5_000);
  scope.end();
  await sleep(10);
  listenerDone.release();
  await dispatched;
  const result = await keepAlive(settleProbe);
  assert.equal(result.awaited, 1, '派发链挂起期间登记表应有 1 条在途条目');
  assert.equal(result.timedOut, false);
});

await test('无 reply target 的消息：早退路径也登记并立即 settle', async () => {
  resetWebhookDispatchTrackerForTest();
  const bot: any = newTestBot();
  installWebhookDispatchTracking(bot, 'acct-a', fakeLogger().log);
  const scope = beginWebhookDispatchScope();
  const p = bot.handleInboundMessage({ id: 'x', content: 'no-target' });
  const settleProbe = settleWebhookDispatchScope(scope, 1_000);
  scope.end();
  await p;
  const result = await keepAlive(settleProbe);
  assert.equal(result.awaited, 1);
  assert.equal(result.timedOut, false);
});

await test('surface 缺失：WARN 且不炸', () => {
  const logger = fakeLogger();
  const bare: any = {};
  installWebhookDispatchTracking(bare, 'acct-a', logger.log);
  assert.ok(logger.lines.some((l) => l.includes('handleInboundMessage surface missing')));
});

group('C. createInteractionDispatchListener（网关真实接线）');

/** type=13（消息反馈）走 handlePlatformInteraction 纯观测分支：不 ack、不进框架 */
function observationInteractionEvent(): InteractionEvent {
  return {
    id: 'itx-1',
    type: 13,
    data: { type: 3001 },
    group_openid: 'group-1',
  } as unknown as InteractionEvent;
}

await test('真实 listener：同步登记、settle 出表、错误走 onError', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  const ackCalls: unknown[][] = [];
  const listener = createInteractionDispatchListener({
    account: { accountId: 'acct-a', appId: 'a', clientSecret: 's' } as any,
    runtime: {} as any,
    log: logger.log,
    acknowledgeInteraction: async (id, code, data) => { ackCalls.push([id, code, data]); },
  });

  const scope = beginWebhookDispatchScope();
  listener({}, observationInteractionEvent());
  // bot.emit 同步调 listener → 登记必须已发生（同一 tick 快照）
  const settleProbe = settleWebhookDispatchScope(scope, 5_000);
  scope.end();
  const result = await keepAlive(settleProbe);
  assert.equal(result.awaited, 1, 'listener 调用即应同步登记 1 条在途派发');
  assert.equal(result.timedOut, false);
  assert.equal(ackCalls.length, 0, 'type-13 观测型事件不得 ack');

  // 错误路径：handleInteraction 拒绝 → onError 记日志、条目照常出表。
  // （handleConfigQuery 等分支内部吞错，故用 data getter 在入口第一行炸）
  const failing = createInteractionDispatchListener({
    account: { accountId: 'acct-a', appId: 'a', clientSecret: 's' } as any,
    runtime: {} as any,
    log: logger.log,
    acknowledgeInteraction: async () => {},
  });
  const badEvent = {
    id: 'itx-2',
    type: 12,
    get data(): never { throw new Error('bad interaction payload'); },
  } as unknown as InteractionEvent;
  const scope2 = beginWebhookDispatchScope();
  failing({}, badEvent);
  const settleProbe2 = settleWebhookDispatchScope(scope2, 5_000);
  scope2.end();
  const result2 = await keepAlive(settleProbe2);
  assert.equal(result2.awaited, 1);
  assert.ok(logger.lines.some((l) => l.includes('Interaction error')), '错误应走 onError 记日志');
});

group('D. dispatchOp0WithDetachedWork');

function fakeGuards() {
  const runs: Array<Promise<unknown>> = [];
  return {
    runs,
    runDetachedWebhookWork: (run: () => Promise<unknown>) => {
      const p = (async () => {
        await Promise.resolve();
        return await run();
      })();
      runs.push(p);
      return p;
    },
  };
}

await test('detached 回调内委托 + 等 scope 归零；ACK 先于派发完成', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();

  let ackWritten = false;
  const dispatchWork = deferred();

  await dispatchOp0WithDetachedWork({
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    log: logger.log,
    guards,
    onDelegateError: () => {},
    delegate: async () => {
      // 模拟 SDK：同步启动 fire-and-forget 派发链（= 包裹后的 handleInboundMessage 被同步调用）
      trackWebhookDispatch('acct-a', dispatchWork.promise);
      await sleep(1); // ACK 写出
      ackWritten = true;
    },
  });

  assert.equal(guards.runs.length, 1, 'runDetachedWebhookWork 应恰好调用一次');
  const detachedRun = guards.runs[0];
  await sleep(50);
  assert.ok(ackWritten, 'ACK 已由委托写出');
  // 派发未完成 → detached 回调（= detached 根的持有时长）不得结束
  let done = false;
  void detachedRun.then(() => { done = true; }).catch(() => { done = true; });
  await sleep(50);
  assert.equal(done, false, 'scope 未归零前 detached 回调不得 settle（detached 根需继续持有）');
  dispatchWork.release();
  await detachedRun;
  assert.equal(logger.lines.length, 0, '正常路径无 WARN');
});

await test('委托异步失败：兜底 500 立即写出（不等 settle）、记 ERROR', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();
  const stuck = deferred(); // 已启动的派发挂着，验证 500 不等 settle
  let errors = 0;

  await dispatchOp0WithDetachedWork({
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards,
    onDelegateError: () => { errors++; },
    delegate: async () => {
      trackWebhookDispatch('acct-a', stuck.promise);
      await sleep(1);
      throw new Error('delegate boom');
    },
  });
  await sleep(30);
  assert.equal(errors, 1, '委托失败应立即兜底（未等 settle）');
  stuck.release();
  await guards.runs[0].catch(() => {}); // 回调尾部 rethrow delegateError → run promise 拒绝（预期）
  assert.ok(logger.lines.some((l) => l.includes('detached dispatch failed')), '应记 ERROR 日志');
});

await test('委托同步抛错：同样兜底 500', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();
  // 镜像 writeErrorResponse 的幂等语义：内层 catch 与外层 catch 都可能调
  let written = false;
  let errors = 0;
  await dispatchOp0WithDetachedWork({
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards,
    onDelegateError: () => { if (!written) { written = true; errors++; } },
    delegate: () => { throw new Error('sync boom'); },
  });
  await guards.runs[0].catch(() => {}); // 同步抛错 → run promise 拒绝（预期）
  assert.equal(errors, 1, '兜底响应恰好写出一次（幂等）');
  assert.ok(logger.lines.some((l) => l.includes('detached dispatch failed')), '应记 ERROR 日志');
});

await test('writeErrorResponse：仅在响应未写出时兜底', () => {
  const written: any = { headersSent: true, writableEnded: true, statusCode: 200, setHeader: () => {}, end: () => { throw new Error('不得重复写'); } };
  writeErrorResponse(written); // 已写出 → no-op

  const fresh: any = {
    headersSent: false, writableEnded: false, statusCode: 0,
    setHeader: () => {}, end: (b: string) => { fresh.body = b; },
  };
  writeErrorResponse(fresh);
  assert.equal(fresh.statusCode, 500);
  assert.ok(String(fresh.body).includes('internal error'));
});

await test('秒完成的派发也计入（tripwire 不误报）', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();
  await dispatchOp0WithDetachedWork({
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards,
    onDelegateError: () => {},
    delegate: async () => {
      trackWebhookDispatch('acct-a', Promise.resolve());
    },
  });
  await guards.runs[0];
  assert.equal(logger.lines.length, 0, '秒完成的派发不应触发 tripwire');
});

await test('tripwire：应派生派发的事件零登记 → WARN；非派发事件不 WARN', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  const guardsWarn = fakeGuards();
  await dispatchOp0WithDetachedWork({
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    log: logger.log,
    guards: guardsWarn,
    onDelegateError: () => {},
    delegate: async () => {},
  });
  await guardsWarn.runs[0];
  assert.ok(logger.lines.some((l) => l.includes('no tracked dispatch observed')), '应打出 tripwire WARN');

  logger.lines.length = 0;
  const guardsQuiet = fakeGuards();
  await dispatchOp0WithDetachedWork({
    eventType: 'GROUP_ADD_ROBOT',
    log: logger.log,
    guards: guardsQuiet,
    onDelegateError: () => {},
    delegate: async () => {},
  });
  await guardsQuiet.runs[0];
  assert.equal(logger.lines.filter((l) => l.includes('no tracked dispatch observed')).length, 0, '非派生事件不应 WARN');
});

await test('guards 缺失：直连委托（修复前行为），委托失败照常兜底', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  let delegated = false;
  let errors = 0;
  await dispatchOp0WithDetachedWork({
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards: null,
    onDelegateError: () => { errors++; },
    delegate: async () => {
      delegated = true;
      throw new Error('boom');
    },
  });
  assert.ok(delegated);
  assert.equal(errors, 1, '直连路径委托失败也要兜底 500');
  assert.ok(logger.lines.some((l) => l.includes('dispatch delegation failed')));
});

await test('runDetachedWebhookWork 自身拒绝（回调未执行、无 ACK）：外层 catch 兜底 500（评审二轮意见 2）', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  const rejectingGuards = {
    // 模拟全局 drain：新根被拒、回调根本不执行
    runDetachedWebhookWork: async (_run: () => Promise<unknown>) => {
      throw new Error('GatewayDrainingError');
    },
  };
  let delegated = false;
  let errors = 0;
  await dispatchOp0WithDetachedWork({
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards: rejectingGuards as any,
    onDelegateError: () => { errors++; },
    delegate: async () => { delegated = true; },
  });
  await sleep(20);
  assert.equal(delegated, false, '回调不应执行');
  assert.equal(errors, 1, '外层 catch 必须兜底写响应（否则请求悬挂）');
  assert.ok(logger.lines.some((l) => l.includes('detached dispatch failed')));
});

await test('delegate 挂死：超时兜底 500、settle 照常有界、根不无限持有（评审二轮意见 3）', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  const guards = fakeGuards();
  const stuckDelegate = deferred();
  const stuckDispatch = deferred();
  let errors = 0;

  // 持有上限经 env 覆盖成 80ms（生产 360s；resolveWebhookDispatchHoldMs 调用时读取）
  const prevHold = process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS;
  process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS = '80';
  try {
    await dispatchOp0WithDetachedWork({
      eventType: 'C2C_MESSAGE_CREATE',
      log: logger.log,
      guards,
      onDelegateError: () => { errors++; },
      delegate: () => {
        // 同步登记已发生的派发（挂在 scope 里），delegate 本身永不返回
        trackWebhookDispatch('acct-a', stuckDispatch.promise);
        return stuckDelegate.promise;
      },
    });
    await sleep(200);
    assert.equal(errors, 1, 'delegate 超时必须兜底写 500');
    assert.ok(logger.lines.some((l) => l.includes('timed out')), '应记超时 ERROR');
    // settle 也受同一上限约束 → detached 回调有界 settle（不无限持有根）
    await keepAlive(guards.runs[0].catch(() => {}));
  } finally {
    if (prevHold === undefined) delete process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS;
    else process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS = prevHold;
    stuckDelegate.release();
    stuckDispatch.release();
  }
});

await test('持有上限是总预算：delegate 消耗的预算从 settle 扣除，不被两段串行翻倍', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  const guards = fakeGuards();
  const stuckDispatch = deferred();

  // 预算 400ms：delegate「正常」耗时 300ms（未超时），登记的派发挂死 →
  // settle 只剩 ~100ms 预算。若两段各计 400ms，回调要到 ~700ms 才 settle。
  const prevHold = process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS;
  process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS = '400';
  try {
    await dispatchOp0WithDetachedWork({
      eventType: 'C2C_MESSAGE_CREATE',
      log: logger.log,
      guards,
      onDelegateError: () => {},
      delegate: async () => {
        trackWebhookDispatch('acct-a', stuckDispatch.promise);
        await sleep(300);
      },
    });
    // startedAt ≈ delegate 起点（fake guards 只隔一个 microtask）：
    // 总预算 400ms → 回调应在 ≈400ms settle（300 delegate + ~100 settle 剩余）；
    // 若两段各计全额（bug 形态）则 ≈700ms。窗口 [340, 600] 把两者分开。
    const startedAt = Date.now();
    await keepAlive(guards.runs[0].catch(() => {}));
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 600, `持有总时长应受单一 deadline 约束（实际 ${elapsed}ms，翻倍形态 ≈700ms）`);
    assert.ok(elapsed >= 340, `持有应真实等待了预算（实际 ${elapsed}ms，零等待说明没等登记）`);
  } finally {
    if (prevHold === undefined) delete process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS;
    else process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS = prevHold;
    stuckDispatch.release();
  }
});

await test('生产路径：默认 loader 加载真实 guards，withDetachedWebhookWork 持有到工作完成（评审意见 7）', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  // ① 默认 loader 能在已安装 openclaw（≥2026.10.5 基线）上加载真实原语
  const guards = await loadDetachedWebhookGuards(logger.log);
  assert.ok(guards, '应能加载 webhook-request-guards（基线 2026.10.5 起）');
  assert.equal(typeof guards!.runDetachedWebhookWork, 'function');

  // ② 默认路径（不注入 guards）+ 真实原语：回调 await 的工作未完成时不得返回
  //    —— dispatchOp0WithDetachedWork 的返回 promise 是即发的（void detached），
  //    持有语义在这里直接对 withDetachedWebhookWork 断言（同一默认 loader）
  const work = deferred();
  const run = withDetachedWebhookWork(async () => {
    await work.promise;
  }, logger.log);
  await sleep(50);
  let done = false;
  void run.then(() => { done = true; });
  await sleep(50);
  assert.equal(done, false, '真实 detached 原语必须在回调工作完成前保持挂起（生产路径）');
  work.release();
  await run;
});

group('E. 真实 SDK WebhookTransport（合法 Ed25519 签名 op:0）');

const SECRET = 'unit-test-secret';
const ACCOUNT = 'acct-a';

function signedOp0Request(payload: object) {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = ed25519Sign(SECRET, Buffer.concat([Buffer.from(timestamp, 'utf-8'), body]));
  return {
    body,
    headers: {
      'content-type': 'application/json',
      'x-signature-timestamp': timestamp,
      'x-signature-ed25519': signature,
    },
  };
}

await test('ACK 即时返回；包裹后的派发同步登记；ACK 先于派发链完成', async () => {
  resetWebhookDispatchTrackerForTest();
  const bot: any = newTestBot();
  const listenerDone = deferred();
  bot.on('message', () => listenerDone.promise);
  installWebhookDispatchTracking(bot, ACCOUNT, fakeLogger().log);

  const transport = new WebhookTransport(
    {
      appId: 'test-appid',
      appSecret: SECRET,
      accountId: ACCOUNT,
      server: { listen: async () => {}, close: () => {} } as any,
    },
    {
      onMessage: (raw: any) => bot.handleInboundMessage(raw),
    } as any,
  );

  const scope = beginWebhookDispatchScope();
  const req = signedOp0Request({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm1', timestamp: Date.now(), author: { user_openid: 'u1' }, content: 'hi' },
  });
  const resp = await transport.handleRequest(req);
  // handleRequest 返回即 ACK——派发链此时已同步启动并登记（同一 tick 快照）
  const settleProbe = settleWebhookDispatchScope(scope, 5_000);
  scope.end();

  assert.equal(resp.status, 200);
  assert.deepEqual(JSON.parse(String(resp.body)), { op: 12, d: 0 });

  let settledEarly = false;
  void settleProbe.then((r) => { if (r.awaited > 0 && !r.timedOut) settledEarly = true; });
  await sleep(20);
  assert.equal(settledEarly, false, 'listener 挂起期间登记表不应归零');
  listenerDone.release();
  const result = await keepAlive(settleProbe);
  assert.equal(result.awaited, 1);
  assert.equal(result.timedOut, false);
});

group('F. money test：真实 openclaw 准入状态机（子进程）');

/**
 * 子进程里加载真实 dist 的 gateway-work-admission（导出名被压缩成单字母，
 * 按函数名探测）+ 真实 runDetachedWebhookWork，锁两条机制事实：
 *  1. fire-and-forget 链在请求根释放后 enqueue 判 closed=true（= issue #74 病灶）；
 *  2. runDetachedWebhookWork 回调内 await 工作期间判 closed=false（= 修法依据）。
 */
function runSub<T>(code: string): T {
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', code],
    { cwd: repoRoot, encoding: 'utf-8' },
  );
  return JSON.parse(out) as T;
}

await test('fire-and-forget 链在根释放后判 closed=true（复现 #74）', () => {
  const result = runSub<{ found: boolean; ackTime: boolean; enqueueTime: boolean }>(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const dist = path.resolve('node_modules/openclaw/dist');
    let admission = null;
    for (const f of fs.readdirSync(dist)) {
      if (!/^gateway-work-admission-.*\\.mjs$/.test(f)) continue;
      let m;
      try { m = await import(pathToFileURL(path.join(dist, f)).href); } catch { continue; }
      const fns = Object.values(m).filter((v) => typeof v === 'function');
      const byName = (n) => fns.find((fn) => fn.name === n);
      if (byName('isGatewaySubordinateWorkAdmissionClosed') && byName('runWithGatewayIndependentRootWorkAdmission')) {
        admission = {
          isClosed: byName('isGatewaySubordinateWorkAdmissionClosed'),
          withRoot: byName('runWithGatewayIndependentRootWorkAdmission'),
        };
        break;
      }
    }
    if (!admission) { console.log(JSON.stringify({ found: false })); process.exit(0); }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { found: true, ackTime: false, enqueueTime: false };
    await admission.withRoot(async () => {
      // 模拟 SDK：handler 同步发起 fire-and-forget 派发链后返回（根随之释放）；
      // 真实 enqueue 发生在链的若干 await 之后（中间件/附件下载）——
      // 即先于请求根释放启动、晚于释放到达判定点。
      void (async () => {
        await sleep(20);
        out.enqueueTime = admission.isClosed();
      })();
      await sleep(1);
      out.ackTime = admission.isClosed();
    });
    await sleep(50);
    console.log(JSON.stringify(out));
  `);
  assert.ok(result.found, '未能在 openclaw dist 中定位准入状态机模块');
  assert.equal(result.ackTime, false, '请求根存续期间（ACK 时）准入应开放');
  assert.equal(result.enqueueTime, true, 'fire-and-forget 链晚到的 enqueue 应判 closed（复现 #74）');
});

await test('runDetachedWebhookWork 回调内 await 工作期间判 closed=false（修法）', async () => {
  const result = runSub<{ found: boolean; duringWork: boolean | null; guards: boolean }>(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';
    const dist = path.resolve('node_modules/openclaw/dist');
    let admission = null;
    for (const f of fs.readdirSync(dist)) {
      if (!/^gateway-work-admission-.*\\.mjs$/.test(f)) continue;
      let m;
      try { m = await import(pathToFileURL(path.join(dist, f)).href); } catch { continue; }
      const fns = Object.values(m).filter((v) => typeof v === 'function');
      const byName = (n) => fns.find((fn) => fn.name === n);
      if (byName('isGatewaySubordinateWorkAdmissionClosed') && byName('runWithGatewayIndependentRootWorkAdmission')) {
        admission = {
          isClosed: byName('isGatewaySubordinateWorkAdmissionClosed'),
          withRoot: byName('runWithGatewayIndependentRootWorkAdmission'),
        };
        break;
      }
    }
    const guards = await import('openclaw/plugin-sdk/webhook-request-guards').then((m) => m, () => null);
    if (!admission || !guards?.runDetachedWebhookWork) {
      console.log(JSON.stringify({ found: false, guards: !!guards?.runDetachedWebhookWork, duringWork: null }));
      process.exit(0);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { found: true, duringWork: null, guards: true };
    await admission.withRoot(async () => {
      await guards.runDetachedWebhookWork(async () => {
        // 模拟「委托 + 等 scope 归零」：工作挂起期间 detached 根必须保住准入
        await sleep(60);
        out.duringWork = admission.isClosed();
      });
    });
    console.log(JSON.stringify(out));
  `);
  assert.ok(result.found, '未能在 openclaw dist 中定位准入状态机模块');
  assert.ok(result.guards, 'openclaw/plugin-sdk/webhook-request-guards 应可加载（基线 2026.10.5 起）');
  assert.equal(result.duringWork, false, 'detached 回调内 await 工作期间准入必须开放（修法依据）');
});

group('G. withDetachedWebhookWork（群合批冲刷的包裹原语，评审意见 1）');

await test('包裹：run 在 guards 回调内执行并 await 完成', async () => {
  const logger = fakeLogger();
  const guards = fakeGuards();
  let ran = false;
  await withDetachedWebhookWork(async () => { ran = true; }, logger.log, guards);
  assert.ok(ran);
  assert.equal(guards.runs.length, 1);
});

await test('guards 为 null：直跑降级', async () => {
  const logger = fakeLogger();
  let ran = false;
  await withDetachedWebhookWork(async () => { ran = true; }, logger.log, null);
  assert.ok(ran);
});

await test('默认 loader（真实模块）：正常包裹', async () => {
  const logger = fakeLogger();
  let ran = false;
  await withDetachedWebhookWork(async () => { ran = true; }, logger.log);
  assert.ok(ran);
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
