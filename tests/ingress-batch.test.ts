/**
 * 群聊持久化入站 · 组批与幂等 回归测试
 *
 * 覆盖：
 * 1. **到达序排序**（复现"群聊快速刷新时消息错乱"）：
 *    3 条群消息的平台 timestamp 乱序（成员设备时钟不一致），
 *    批次内顺序必须是**本地到达序**。
 * 2. 容量裁剪：条数上限 / 正文字数上限，超限丢弃**较早**的消息。
 * 3. 批次指纹：同一批消息跨重投**完全一致**（幂等守卫的 key）；
 *    集合不同 ⇒ 指纹不同。
 * 4. 唤醒判定：@ / 称呼唤醒 / 事件类型 ⇒ "在叫 bot"。
 * 5. 幂等守卫：同一 eventId 第二次命中 ⇒ 不重复执行副作用。
 *
 * 运行方式: npx tsx tests/ingress-batch.test.ts
 */
import assert from 'node:assert/strict';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { createIngressEffectOnce } from 'openclaw/plugin-sdk/ingress-effect-once';
import {
  batchFingerprint,
  isExplicitlyWoken,
  trimToCapacity,
  type BatchMember,
} from '../src/features/ingress-batcher.js';
import { INGRESS_PAYLOAD_VERSION, type QQBotIngressPayload } from '../src/features/ingress-payload.js';
import type { AssembledBody } from '../src/dispatch/body-assembler.js';

/**
 * 每次运行的唯一后缀。
 *
 * ⚠️ 幂等守卫（`createIngressEffectOnce` → `createClaimableDedupe`）是**跨进程
 * 持久化**的：批次指纹一旦用过就再也���会重放。测试的指纹必须每次运行唯一，
 * 否则第二次跑本文件会被判 replayed ⇒ 派发被跳过 ⇒ 断言全灭。
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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
    platformTimestamp: '1700000000',
    receivedAtMs: 1000,
    mention: { wasMentioned: false, implicit: false },
    nameMentioned: false,
    ...overrides,
  };
}

function member(payload: QQBotIngressPayload): BatchMember {
  return { payload, claim: null };
}

group('到达序排序（群消息错乱的根因）');

await test('平台 timestamp 乱序时，批次内顺序 = 本地到达序', () => {
  // 模拟：群成员设备时钟不一致 → 平台 timestamp 与真实到达顺序相反
  const t2 = makePayload({ messageId: 't2', platformTimestamp: '100', receivedAtMs: 2000 });
  const t1 = makePayload({ messageId: 't1', platformTimestamp: '200', receivedAtMs: 1000 });
  const t3 = makePayload({ messageId: 't3', platformTimestamp: '300', receivedAtMs: 3000 });

  const members = [member(t2), member(t1), member(t3)];
  members.sort((a, b) => a.payload.receivedAtMs - b.payload.receivedAtMs);

  assert.deepEqual(members.map((m) => m.payload.messageId), ['t1', 't2', 't3']);

  // 反证：按平台 timestamp 排序会排成 t2,t1,t3（错乱）
  const byPlatform = [member(t2), member(t1), member(t3)].sort(
    (a, b) =>
      Date.parse(a.payload.platformTimestamp) - Date.parse(b.payload.platformTimestamp),
  );
  assert.deepEqual(byPlatform.map((m) => m.payload.messageId), ['t2', 't1', 't3']);
});

group('容量裁剪');

await test('条数上限：保留最新的 N 条，较早的丢弃', () => {
  const members = Array.from({ length: 12 }, (_, i) =>
    member(makePayload({ messageId: `m${i}`, receivedAtMs: 1000 + i })),
  );
  const { kept, dropped } = trimToCapacity(members, 10, 8000);
  assert.equal(kept.length, 10);
  assert.equal(dropped, 2);
  // 保留的是**最新**的 10 条
  assert.equal(kept[0]!.payload.messageId, 'm2');
  assert.equal(kept[9]!.payload.messageId, 'm11');
});

await test('正文字数上限：从最新往最旧累加，超限即停', () => {
  const big = (id: string, i: number) =>
    member(
      makePayload({
        messageId: id,
        receivedAtMs: 1000 + i,
        rawContent: 'x'.repeat(100),
        processedAttachments: {
          voiceText: '',
          imageUrls: [],
          otherInfo: '',
          transcripts: [],
          localMediaPaths: [],
          localMediaTypes: [],
          remoteMediaUrls: [],
          media: [],
        },
      }),
    );
  const members = [big('a', 0), big('b', 1), big('c', 2)];
  const { kept, dropped } = trimToCapacity(members, 10, 250);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((m) => m.payload.messageId), ['b', 'c']);
});

await test('单条超限仍保留（不因超上限整批丢弃）', () => {
  const huge = member(makePayload({ messageId: 'huge', rawContent: 'x'.repeat(9999) }));
  const { kept, dropped } = trimToCapacity([huge], 10, 100);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});

group('批次指纹（幂等 key）');

await test('同一批消息跨重投指纹完全一致', () => {
  const mk = () => [
    member(makePayload({ messageId: 'b', receivedAtMs: 2 })),
    member(makePayload({ messageId: 'a', receivedAtMs: 1 })),
    member(makePayload({ messageId: 'c', receivedAtMs: 3 })),
  ];
  const first = batchFingerprint('qqbot:acc1:group:g1', mk());
  const second = batchFingerprint('qqbot:acc1:group:g1', mk());
  assert.equal(first, second);
});

await test('集合不同 ⇒ 指纹不同（不同批次不会互相吞掉）', () => {
  const a = batchFingerprint('qqbot:acc1:group:g1', [
    member(makePayload({ messageId: 'a' })),
  ]);
  const b = batchFingerprint('qqbot:acc1:group:g1', [
    member(makePayload({ messageId: 'a' })),
    member(makePayload({ messageId: 'b' })),
  ]);
  assert.notEqual(a, b);
});

await test('不同 lane ⇒ 指纹不同', () => {
  const members = [member(makePayload({ messageId: 'a' }))];
  assert.notEqual(
    batchFingerprint('qqbot:acc1:group:g1', members),
    batchFingerprint('qqbot:acc1:group:g2', members),
  );
});

group('唤醒判定');

await test('事件类型 GROUP_AT_MESSAGE_CREATE ⇒ 在叫 bot', () => {
  const p = makePayload({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('mentions.is_you ⇒ 在叫 bot', () => {
  const p = makePayload({ mentions: [{ is_you: true }] });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('称呼唤醒 ⇒ 在叫 bot', () => {
  const p = makePayload({ nameMentioned: true });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('普通群消息 ⇒ 不在叫 bot', () => {
  const p = makePayload({ rawEventType: 'GROUP_MESSAGE_CREATE' });
  assert.equal(isExplicitlyWoken(p), false);
});

group('幂等守卫');

await test('同一 eventId 第二次命中 ⇒ 不重复执行副作用', async () => {
  const guard = createIngressEffectOnce({
    pluginId: 'openclaw-qqbot',
    namespacePrefix: 'test-ingress-effect',
    ttlMs: 60_000,
    stateMaxEntries: 100,
  });
  let sideEffects = 0;
  const run = async () => {
    const first = await guard.runOnce({
      eventId: `fp-${RUN_ID}`,
      effect: 'dispatch',
      run: async () => {
        sideEffects += 1;
        return 'done';
      },
    });
    assert.equal(first.kind, 'executed');

    const second = await guard.runOnce({
      eventId: `fp-${RUN_ID}`,
      effect: 'dispatch',
      run: async () => {
        sideEffects += 1;
        return 'done';
      },
    });
    assert.equal(second.kind, 'replayed');
  };
  await run();
  assert.equal(sideEffects, 1, '副作用只应执行一次');
});

group('合批窗口收集（D-c：窗口来源 = 框架 resolveInboundDebounceMs）');

/** 最小假 runtime：只需要 getConfig（窗口来源）+ dispatch 链路 */
function makeWindowRuntime(cfg: Record<string, unknown>) {
  let capturedBody = '';
  return {
    runtime: {
      version: '2026.10.5',
      channel: {
        inbound: {
          run: async (params: any) => {
            capturedBody = String(params.adapter.resolveTurn?.({}, {}, {}).ctxPayload?.message?.bodyForAgent ?? '');
            return { dispatched: true };
          },
          buildContext: (params: any) => ({ ...params }),
        },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => ({
            queuedFinal: true,
            counts: { final: 1 },
          }),
        },
        routing: {
          resolveAgentRoute: () => ({ sessionKey: 's', accountId: 'acc1', agentId: 'default' }),
        },
        session: { resolveStorePath: () => '', recordInboundSession: async () => {} },
      },
      config: { current: () => cfg },
    } as unknown as PluginRuntime,
    body: () => capturedBody,
  };
}

await test('窗口来源 = 框架旋钮：未配 ⇒ 0（零延迟）；配了 ⇒ 取该值', async () => {
  const { resolveGroupMergeWindowMs } = await import('../src/features/ingress-batcher.js');
  assert.equal(resolveGroupMergeWindowMs(makeWindowRuntime({}).runtime), 0);
  assert.equal(
    resolveGroupMergeWindowMs(
      makeWindowRuntime({ messages: { inbound: { byChannel: { qqbot: 250 } } } }).runtime,
    ),
    250,
  );
  assert.equal(
    resolveGroupMergeWindowMs(
      makeWindowRuntime({ messages: { inbound: { debounceMs: 400 } } }).runtime,
    ),
    400,
  );
});

/**
 * 跑一次「领队首行 → 窗口收集 → 派发」。
 *
 * backlog 用「按调用次数返回」模拟「窗口期内又来了一条消息」。
 */
async function runWindowDispatch(params: {
  cfg: Record<string, unknown>;
  backlogCalls: number;
}): Promise<string> {
  const { dispatchClaimedGroupEvent } = await import('../src/features/ingress-batcher.js');
  const { resetIngressEffectGuardsForTest } = await import('../src/features/ingress-batcher.js');
  resetIngressEffectGuardsForTest();

  const env = makeWindowRuntime(params.cfg);
  const groupOpenid = `g1-${RUN_ID}`;
  const head = makePayload({
    groupOpenid,
    messageId: 'head',
    content: 'AAA',
    rawContent: 'AAA',
  });
  const later = makePayload({
    groupOpenid,
    messageId: 'later',
    content: 'BBB',
    rawContent: 'BBB',
    receivedAtMs: head.receivedAtMs + 1,
  });

  let backlogCalls = 0;
  const lifecycle = {
    abortSignal: new AbortController().signal,
    readLaneBacklog: async () => {
      backlogCalls += 1;
      // 第一次读时「窗口期内的新消息」还没到；第二次读才出现
      return backlogCalls <= 1 ? [] : [{ id: 'row-later', payload: later }];
    },
    onAdopted: () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: () => {},
  };

  const handle = {
    accountId: 'acc1',
    ownerId: 'test-owner',
    runtime: env.runtime,
    queue: {
      claim: async (id: string) => ({ id, payload: later, receivedAt: later.receivedAtMs, laneKey: 'l' }),
      complete: async () => true,
      release: async () => true,
    },
    log: undefined,
  } as never;

  await dispatchClaimedGroupEvent(
    { id: 'row-head', payload: head, receivedAt: head.receivedAtMs, laneKey: 'l' } as never,
    lifecycle as never,
    handle,
  );
  return env.body();
}

await test('窗口 = 0 ⇒ 领到队首行即派发（窗口期内到达的消息不并入本批）', async () => {
  const body = await runWindowDispatch({ cfg: {}, backlogCalls: 1 });
  assert.ok(body.includes('AAA'), '队首消息应在正文里');
  assert.ok(!body.includes('BBB'), '窗口为 0 时不应等待后来者');
});

await test('窗口 > 0 ⇒ 窗口期内到达的消息并入本批', async () => {
  const body = await runWindowDispatch({
    cfg: { messages: { inbound: { byChannel: { qqbot: 150 } } } },
    backlogCalls: 1,
  });
  assert.ok(body.includes('AAA'), '队首消息应在正文里');
  assert.ok(body.includes('BBB'), '窗口期内到达的消息应并入本批');
});

group('单条批次不合并（正文格式与改造前逐字一致）');

/**
 * 派发一批并抓取模型可见正文（bodyForAgent / rawBody / webBody）。
 *
 * bodyForAgent = 模型看到的正文；rawBody = 命令判定用的原文；
 * webBody = Web UI 信封正文（from 标签在 renderWebBody 里决定）。
 */
async function dispatchAndCapture(params: {
  cfg?: Record<string, unknown>;
  head: QQBotIngressPayload;
  backlog?: QQBotIngressPayload[];
  frozenBody?: AssembledBody;
}): Promise<{ agentBody: string; rawBody: string; webBody: string }> {
  const { dispatchClaimedGroupEvent, resetIngressEffectGuardsForTest } = await import(
    '../src/features/ingress-batcher.js'
  );
  resetIngressEffectGuardsForTest();

  let captured: { agentBody: string; rawBody: string; webBody: string } = {
    agentBody: '',
    rawBody: '',
    webBody: '',
  };
  const runtime = {
    version: '2026.10.5',
    channel: {
      inbound: {
        run: async (runParams: any) => {
          const message = runParams.adapter.resolveTurn?.({}, {}, {}).ctxPayload?.message ?? {};
          captured = {
            agentBody: String(message.bodyForAgent ?? ''),
            rawBody: String(message.rawBody ?? ''),
            webBody: String(message.body ?? ''),
          };
          return { dispatched: true };
        },
        buildContext: (buildParams: any) => ({ ...buildParams }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async () => ({ queuedFinal: true, counts: { final: 1 } }),
      },
      routing: {
        resolveAgentRoute: () => ({ sessionKey: 's', accountId: 'acc1', agentId: 'default' }),
      },
      session: { resolveStorePath: () => '', recordInboundSession: async () => {} },
    },
    config: { current: () => params.cfg ?? {} },
  } as unknown as PluginRuntime;

  const handle = {
    accountId: 'acc1',
    ownerId: 'test-owner',
    runtime,
    queue: {
      claim: async (id: string) => {
        const row = (params.backlog ?? []).find((p) => `row-${p.messageId}` === id);
        return row
          ? { id, payload: row, receivedAt: row.receivedAtMs, laneKey: 'l' }
          : null;
      },
      complete: async () => true,
      release: async () => true,
    },
    log: undefined,
  } as never;

  const lifecycle = {
    abortSignal: new AbortController().signal,
    readLaneBacklog: async () =>
      (params.backlog ?? []).map((p) => ({ id: `row-${p.messageId}`, payload: p })),
    onAdopted: () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: () => {},
  } as never;

  await dispatchClaimedGroupEvent(
    {
      id: `row-${params.head.messageId}`,
      payload: params.head,
      receivedAt: params.head.receivedAtMs,
      laneKey: 'l',
    } as never,
    lifecycle,
    handle,
  );
  return captured;
}

await test('单条消息：沿用中间件冻结的单条正文（无 [消息 1/1]、webBody 不变）', async () => {
  const groupOpenid = `g-single-${RUN_ID}`;
  const frozen: AssembledBody = {
    agentBody: 'FROZEN-SINGLE-BODY',
    rawBody: 'FROZEN-RAW',
    webBody: 'FROZEN-WEB',
  };
  const head = makePayload({
    groupOpenid,
    messageId: 'single',
    content: 'AAA',
    rawContent: 'AAA',
    assembledBody: frozen,
  });

  const out = await dispatchAndCapture({ head });
  assert.equal(out.agentBody, 'FROZEN-SINGLE-BODY', '单条批次必须沿用中间件冻结的单条正文');
  assert.ok(!out.agentBody.includes('[消息 1/1]'), '单条批次不得出现 [消息 1/1] 分节头');
  assert.equal(out.rawBody, 'FROZEN-RAW', 'rawBody 必须沿用冻结值');
  assert.equal(out.webBody, 'FROZEN-WEB', 'webBody 必须沿用冻结值（from 不得变成群 id）');
});

await test('多条消息：仍走合并装配（[消息 i/N] 分节 + 合并正文）', async () => {
  const groupOpenid = `g-multi-${RUN_ID}`;
  const head = makePayload({
    groupOpenid,
    messageId: 'm1',
    content: 'AAA',
    rawContent: 'AAA',
    assembledBody: {
      agentBody: 'FROZEN-1',
      rawBody: 'FROZEN-1',
      webBody: 'FROZEN-1',
    },
  });
  const second = makePayload({
    groupOpenid,
    messageId: 'm2',
    content: 'BBB',
    rawContent: 'BBB',
    receivedAtMs: head.receivedAtMs + 1,
    assembledBody: {
      agentBody: 'FROZEN-2',
      rawBody: 'FROZEN-2',
      webBody: 'FROZEN-2',
    },
  });

  const out = await dispatchAndCapture({ head, backlog: [second] });
  assert.ok(out.agentBody.includes('[消息 1/2]'), '多成员批次必须带分节头');
  assert.ok(out.agentBody.includes('[消息 2/2]'), '多成员批次必须带分节头');
  assert.ok(out.agentBody.includes('AAA') && out.agentBody.includes('BBB'), '两��成员都要进正文');
  assert.ok(!out.agentBody.includes('FROZEN-1'), '多成员批次不得沿用单条冻结正文');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
