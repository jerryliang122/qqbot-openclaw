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
 *     回调内等「本次请求派生的在途派发」全部落地（tracker 登记）。
 *  3. **只包 runDetachedWebhookWork 不等登记表是不够的**：SDK 的后台
 *     promise 不在回调的 AsyncWorkScope 里，回调随 ACK settle 后 detached
 *     根照样释放——「money test」同时锁这两件事。
 *
 * 覆盖：
 *  A. tracker 纯语义：marker 排除旧条目 / 账号隔离 / 超时 / settle 出表；
 *  B. installWebhookDispatchTracking：surface 缺失 WARN；真实 QQBot 实例
 *     （构造无网络副作用）包裹后派发被同步登记、随链 settle；
 *  C. makeTrackedListener：同步登记、完成/出错均出表、错误回传 onError；
 *  D. dispatchOp0WithDetachedWork（注入 fake guards）：委托在 detached 回调
 *     内执行；回调等登记表归零才 settle；guards 缺失直连；tripwire WARN；
 *  E. 真实 SDK WebhookTransport + 合法 Ed25519 签名的 op:0：ACK 即时、
 *     包裹后的 handleInboundMessage 同步登记、ACK 落地先于派发链完成；
 *  F. money test（子进程加载真实 openclaw dist 的准入状态机）：
 *     fire-and-forget 链在根释放后 enqueue 判 closed=true（复现 bug）；
 *     runDetachedWebhookWork + 回调内 await 工作期间判 closed=false（修法）。
 *
 * 运行方式: npx tsx tests/webhook-detached-dispatch.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { WebhookTransport, ed25519Sign } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  installWebhookDispatchTracking,
  makeTrackedListener,
  markWebhookDispatches,
  resetWebhookDispatchTrackerForTest,
  settleWebhookDispatchesSince,
  trackWebhookDispatch,
} from '../src/features/webhook-dispatch-tracker.js';
import { dispatchOp0WithDetachedWork } from '../src/adapter/webhook.js';

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
  return {
    lines,
    log: {
      info: () => {},
      debug: () => {},
      warn: (m: string) => { lines.push(`WARN: ${m}`); },
      error: (m: string) => { lines.push(`ERROR: ${m}`); },
    } as any,
  };
}

group('A. tracker 纯语义');

await test('marker 之后的条目才被等待（旧条目/他账条目不搭车）', async () => {
  resetWebhookDispatchTrackerForTest();
  // marker 之前的旧条目（不应被等待）
  let releaseOld!: () => void;
  trackWebhookDispatch('acct-a', new Promise<void>((r) => { releaseOld = r; }));
  // 他账号条目
  let releaseB!: () => void;
  trackWebhookDispatch('acct-b', new Promise<void>((r) => { releaseB = r; }));

  const marker = markWebhookDispatches();
  let releaseNew!: () => void;
  trackWebhookDispatch('acct-a', new Promise<void>((r) => { releaseNew = r; }));

  const settle = settleWebhookDispatchesSince('acct-a', marker, 5_000);
  releaseOld();
  releaseB();
  await sleep(30);
  // 旧条目与他账号条目都 settle 了，新条目还挂着 → settle 不得返回
  let returned = false;
  void settle.then(() => { returned = true; });
  await sleep(30);
  assert.equal(returned, false, '新条目未 settle 前 settleSince 不应返回');
  releaseNew();
  const result = await keepAlive(settle);
  assert.equal(result.awaited, 1);
  assert.equal(result.timedOut, false);
});

await test('超时截断：timedOut=true 且不中断被等的工作', async () => {
  resetWebhookDispatchTrackerForTest();
  const marker = markWebhookDispatches();
  let release!: () => void;
  const work = new Promise<void>((r) => { release = r; });
  trackWebhookDispatch('acct-a', work);

  const result = await keepAlive(settleWebhookDispatchesSince('acct-a', marker, 50));
  assert.equal(result.timedOut, true);
  assert.equal(result.awaited, 1);
  release(); // 工作自身照常完成
  await sleep(10);
});

await test('无新条目：awaited=0 立即返回', async () => {
  resetWebhookDispatchTrackerForTest();
  const marker = markWebhookDispatches();
  const result = await settleWebhookDispatchesSince('acct-a', marker, 5_000);
  assert.deepEqual(result, { awaited: 0, timedOut: false });
});

group('B. installWebhookDispatchTracking（真实 QQBot 实例，构造无网络）');

function newTestBot(): QQBot {
  return new QQBot({ appId: 'test-appid', appSecret: 'test-secret', accountId: 'acct-a' });
}

await test('包裹后：handleInboundMessage 派发被登记且随链 settle', async () => {
  resetWebhookDispatchTrackerForTest();
  const bot: any = newTestBot();
  let releaseListener!: () => void;
  const listenerDone = new Promise<void>((r) => { releaseListener = r; });
  bot.on('message', () => listenerDone);
  installWebhookDispatchTracking(bot, 'acct-a', fakeLogger().log);

  const marker = markWebhookDispatches();
  const c2cRaw = {
    id: 'msg-1', timestamp: Date.now(),
    author: { user_openid: 'openid-user' },
    content: 'hello',
  };
  const dispatched = bot.handleInboundMessage(c2cRaw);
  // 同步级联断言：登记必须发生在派发链的第一个 await 之前——
  // settleSince 的快照逻辑在同一 tick 同步执行，若包裹只异步登记会漏拍
  const settleProbe = settleWebhookDispatchesSince('acct-a', marker, 5_000);
  await sleep(10);
  releaseListener();
  await dispatched;
  const result = await keepAlive(settleProbe);
  assert.equal(result.awaited, 1, '派发链挂起期间登记表应有 1 条在途条目');
  assert.equal(result.timedOut, false);
});

await test('无 reply target 的消息：早退路径也登记并立即 settle', async () => {
  resetWebhookDispatchTrackerForTest();
  const bot: any = newTestBot();
  installWebhookDispatchTracking(bot, 'acct-a', fakeLogger().log);
  const marker = markWebhookDispatches();
  await bot.handleInboundMessage({ id: 'x', content: 'no-target' });
  const result = await settleWebhookDispatchesSince('acct-a', marker, 1_000);
  assert.equal(result.awaited, 1);
  assert.equal(result.timedOut, false);
});

await test('surface 缺失：WARN 且不炸', () => {
  const logger = fakeLogger();
  const bare: any = {};
  installWebhookDispatchTracking(bare, 'acct-a', logger.log);
  assert.ok(logger.lines.some((l) => l.includes('handleInboundMessage surface missing')));
});

group('C. makeTrackedListener');

await test('同步登记；完成出表；错误走 onError 且同样出表', async () => {
  resetWebhookDispatchTrackerForTest();
  const errors: unknown[] = [];
  const listener = makeTrackedListener('acct-a', async (x: number) => {
    await sleep(20);
    if (x === 0) throw new Error('boom');
    return x;
  }, (err) => { errors.push(err); });

  const marker = markWebhookDispatches();
  listener(1);
  listener(0);
  // 同步登记：两条在途
  const settleAll = keepAlive(settleWebhookDispatchesSince('acct-a', marker, 5_000));
  const result = await settleAll;
  assert.equal(result.awaited, 2);
  assert.equal(result.timedOut, false);
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error && errors[0].message === 'boom');
});

group('D. dispatchOp0WithDetachedWork（注入 fake guards）');

/**
 * fake guards：模拟真实原语「预留根后一个 microtask 再执行回调」，
 * 并把回调 promise 暴露给测试（真实代码里它被 void —— detached 根的
 * 持有时长就体现在这个 promise 上）。
 */
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

await test('detached 回调内委托 + 等登记归零；ACK 先于派发完成', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();

  let ackWritten = false;
  let releaseDispatch!: () => void;
  const dispatchWork = new Promise<void>((r) => { releaseDispatch = r; });

  await dispatchOp0WithDetachedWork({
    expectAccountId: 'acct-a',
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    log: logger.log,
    guards,
    delegate: async () => {
      // 模拟 SDK：同步启动 fire-and-forget 派发链（= 包裹后的 handleInboundMessage 被同步调用）
      trackWebhookDispatch('acct-a', dispatchWork);
      await sleep(1); // ACK 写出
      ackWritten = true;
      return 'acct-a';
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
  assert.equal(done, false, '登记表未归零前 detached 回调不得 settle（detached 根需继续持有）');
  releaseDispatch();
  await detachedRun;
  assert.equal(logger.lines.length, 0, '正常路径无 WARN');
});

await test('秒完成的派发也计入（awaited≥1，tripwire 不误报）', async () => {
  resetWebhookDispatchTrackerForTest();
  const guards = fakeGuards();
  const logger = fakeLogger();
  await dispatchOp0WithDetachedWork({
    expectAccountId: 'acct-a',
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards,
    delegate: async () => {
      // 派发链在 settleSince 快照前就完成（如被 guard 拦截的消息）
      trackWebhookDispatch('acct-a', Promise.resolve());
      return 'acct-a';
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
    expectAccountId: 'acct-a',
    eventType: 'GROUP_AT_MESSAGE_CREATE',
    log: logger.log,
    guards: guardsWarn,
    delegate: async () => 'acct-a',
  });
  await guardsWarn.runs[0];
  assert.ok(logger.lines.some((l) => l.includes('no tracked dispatch observed')), '应打出 tripwire WARN');

  logger.lines.length = 0;
  const guardsQuiet = fakeGuards();
  await dispatchOp0WithDetachedWork({
    expectAccountId: 'acct-a',
    eventType: 'GROUP_ADD_ROBOT',
    log: logger.log,
    guards: guardsQuiet,
    delegate: async () => 'acct-a',
  });
  await guardsQuiet.runs[0];
  assert.equal(logger.lines.filter((l) => l.includes('no tracked dispatch observed')).length, 0, '非派生事件不应 WARN');
});

await test('guards 缺失：直连委托（修复前行为），不进 detached 回调', async () => {
  resetWebhookDispatchTrackerForTest();
  const logger = fakeLogger();
  let delegated = false;
  await dispatchOp0WithDetachedWork({
    expectAccountId: 'acct-a',
    eventType: 'C2C_MESSAGE_CREATE',
    log: logger.log,
    guards: null,
    delegate: async () => {
      delegated = true;
      return 'acct-a';
    },
  });
  assert.ok(delegated);
  assert.equal(logger.lines.length, 0);
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
  let releaseListener!: () => void;
  const listenerDone = new Promise<void>((r) => { releaseListener = r; });
  bot.on('message', () => listenerDone);
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

  const marker = markWebhookDispatches();
  const req = signedOp0Request({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'm1', timestamp: Date.now(), author: { user_openid: 'u1' }, content: 'hi' },
  });
  const resp = await transport.handleRequest(req);

  // ACK：op:12
  assert.equal(resp.status, 200);
  assert.deepEqual(JSON.parse(String(resp.body)), { op: 12, d: 0 });

  // 派发链已被同步启动并登记（ACK 已返回而链仍未完成）
  const settleProbe = settleWebhookDispatchesSince(ACCOUNT, marker, 5_000);
  let settledEarly = false;
  void settleProbe.then((r) => { if (r.awaited > 0 && !r.timedOut) settledEarly = true; });
  await sleep(20);
  assert.equal(settledEarly, false, 'listener 挂起期间登记表不应归零');
  releaseListener();
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
  const result = runSub<{ found: boolean; duringWork: boolean; guards: boolean }>(`
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
      console.log(JSON.stringify({ found: false, guards: !!guards?.runDetachedWebhookWork }));
      process.exit(0);
    }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = { found: true, duringWork: null, guards: true };
    await admission.withRoot(async () => {
      await guards.runDetachedWebhookWork(async () => {
        // 模拟「委托 + 等登记表归零」：工作挂起期间 detached 根必须保住准入
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

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
