/**
 * C2C 入站消息防抖合并 回归测试
 *
 * 覆盖：
 * 1. 配置解析：插件显式值 / enabled:false / 框架 messages.inbound.byChannel.qqbot
 *    与全局 debounceMs / 插件优先 / 默认 3000 / 钳制 [0,60000]。
 * 2. 纯合并函数：mergeAssembledBodies（[消息 i/N] 分节头 + 拼接）、
 *    mergeProcessedAttachments（media 顺序 concat / 平行数组配对 / 去重）。
 * 3. 集成（真实框架 debouncer + 真实 dispatchToOpenClaw）：
 *    - 窗口内两条消息 → 单次 dispatch，textForAgent 含分节头与两段内容，
 *      锚点 messageId = 最后一条；media facts 合并；
 *    - 单条消息 → 原样直发，无分节头；
 *    - 控制命令（stop）旁路防抖立即 dispatch；
 *    - 滑动窗口：窗口内新消息重置计时；
 *    - 超窗消息 → 各自独立 dispatch；
 *    - 群消息 / 防抖关闭 → enqueue 返回 false（调用方走直发路径）。
 *
 * 运行方式: npx tsx tests/inbound-debounce.test.ts
 */
import assert from 'node:assert/strict';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 真实模块 ──

const {
  resolveC2CInboundDebounceMs,
  mergeAssembledBodies,
  mergeProcessedAttachments,
  enqueueC2CInboundMessage,
  flushAllC2CInboundDebouncers,
  resetC2CInboundDebouncersForTest,
  DEFAULT_C2C_INBOUND_DEBOUNCE_MS,
} = await import('../src/features/inbound-debounce.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');

// ── 测试基础设施（对齐 room-event.test.ts）──

interface CapturedInbound {
  /** adapters.inboundRun 收到的 params */
  params: any;
  /** params.adapter.ingest({}) 的产物（textForAgent 等） */
  ingest: any;
  /** adapters.buildContext 收到的 ctxPayload（media facts 等） */
  ctxPayload: any;
}

function makeFakeRuntime(captured: CapturedInbound[]) {
  // dispatchToOpenClaw 的执行序：buildCtxPayload（调 buildContext）→
  // adapters.inboundRun——ctxPayload 先产出、后入栈，用暂存变量衔接
  let pendingCtxPayload: any;
  return {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          captured.push({ params, ingest: params.adapter.ingest({}), ctxPayload: pendingCtxPayload });
          pendingCtxPayload = undefined;
          return { dispatched: true };
        },
        buildContext: (params: any) => {
          pendingCtxPayload = params;
          return { ...params, __built: true };
        },
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: () => ({ queuedFinal: true, counts: { final: 1 } }),
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:${params.peer.id}`,
          accountId: params.accountId,
          agentId: 'default',
        }),
      },
      session: {
        resolveStorePath: () => '',
        recordInboundSession: async () => {},
      },
    },
    config: { current: {} },
  } as any;
}

function installFakeGateway() {
  const gw = {
    sendText: async () => ({ id: 'out-1', timestamp: Date.now() }),
    sendMedia: async () => ({ id: 'media-out' }),
  } as any;
  registerGateway('test-account', gw);
}

let msgSeq = 0;

function makeC2CMsgAndCtx(overrides: {
  content?: string;
  senderId?: string;
  scope?: 'c2c' | 'group';
  assembledBody?: any;
  processedAttachments?: any;
} = {}) {
  const scope = overrides.scope ?? 'c2c';
  msgSeq += 1;
  const msg = {
    kind: scope,
    messageId: `c2c-msg-${msgSeq}`,
    content: overrides.content ?? '',
    senderId: overrides.senderId ?? 'USER_C2C',
    senderName: 'UserC2C',
    attachments: [],
    replyTarget: { scope, targetId: overrides.senderId ?? 'USER_C2C' },
    mentions: [],
    timestamp: new Date().toISOString(),
    raw: {},
  } as any;
  const ctx = {
    state: {
      ...(overrides.assembledBody ? { assembledBody: overrides.assembledBody } : {}),
      ...(overrides.processedAttachments ? { processedAttachments: overrides.processedAttachments } : {}),
    },
    message: { content: msg.content },
    signal: undefined,
  } as any;
  return { msg, ctx };
}

function makeAccount(inboundDebounce?: any): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: false,
      ...(inboundDebounce !== undefined ? { inboundDebounce } : {}),
    },
  };
}

/** 场景重置 + 组装（每个集成用例独立 runtime / 防抖器） */
function setupScenario(inboundDebounce?: any) {
  resetC2CInboundDebouncersForTest();
  _resetAdaptersCache();
  installFakeGateway();
  const captured: CapturedInbound[] = [];
  const runtime = makeFakeRuntime(captured);
  return { account: makeAccount(inboundDebounce), runtime, captured };
}

// ── 配置解析 ──

group('resolveC2CInboundDebounceMs 配置解析');

await test('无任何配置 → 默认 3000', () => {
  assert.equal(resolveC2CInboundDebounceMs(makeAccount(), {}), DEFAULT_C2C_INBOUND_DEBOUNCE_MS);
  assert.equal(DEFAULT_C2C_INBOUND_DEBOUNCE_MS, 3000);
});

await test('插件显式 debounceMs 优先', () => {
  assert.equal(resolveC2CInboundDebounceMs(makeAccount({ debounceMs: 8000 }), {}), 8000);
});

await test('插件 debounceMs: 0 → 关闭', () => {
  assert.equal(resolveC2CInboundDebounceMs(makeAccount({ debounceMs: 0 }), {}), 0);
});

await test('插件 enabled: false → 关闭（即使框架配了窗口）', () => {
  assert.equal(
    resolveC2CInboundDebounceMs(makeAccount({ enabled: false }), {
      messages: { inbound: { debounceMs: 5000 } },
    }),
    0,
  );
});

await test('框架 messages.inbound.byChannel.qqbot 生效', () => {
  const cfg = { messages: { inbound: { byChannel: { qqbot: 5000 }, debounceMs: 9000 } } };
  assert.equal(resolveC2CInboundDebounceMs(makeAccount(), cfg), 5000);
});

await test('框架全局 messages.inbound.debounceMs 生效', () => {
  const cfg = { messages: { inbound: { debounceMs: 4000 } } };
  assert.equal(resolveC2CInboundDebounceMs(makeAccount(), cfg), 4000);
});

await test('插件显式值压过框架值', () => {
  const cfg = { messages: { inbound: { byChannel: { qqbot: 9000 } } } };
  assert.equal(resolveC2CInboundDebounceMs(makeAccount({ debounceMs: 2500 }), cfg), 2500);
});

await test('钳制：负数 → 0；超限 → 60000', () => {
  assert.equal(resolveC2CInboundDebounceMs(makeAccount({ debounceMs: -5 }), {}), 0);
  assert.equal(resolveC2CInboundDebounceMs(makeAccount({ debounceMs: 999999 }), {}), 60000);
});

// ── 纯合并函数 ──

group('mergeAssembledBodies');

await test('单条原样返回（无分节头）', () => {
  const body = { webBody: 'w', agentBody: 'a', rawBody: 'r', systemPrompt: undefined };
  assert.equal(mergeAssembledBodies([body]), body);
});

await test('多条：分节头 + 拼接 + systemPrompt 取首个非空', () => {
  const merged = mergeAssembledBodies([
    { webBody: 'w1', agentBody: 'a1', rawBody: 'r1', systemPrompt: undefined },
    { webBody: 'w2', agentBody: 'a2', rawBody: 'r2', systemPrompt: 'SP' },
  ]);
  assert.equal(merged.agentBody, '[消息 1/2]\na1\n\n[消息 2/2]\na2');
  assert.equal(merged.webBody, '[消息 1/2]\nw1\n\n[消息 2/2]\nw2');
  assert.equal(merged.rawBody, 'r1\nr2');
  assert.equal(merged.systemPrompt, 'SP');
});

group('mergeProcessedAttachments');

await test('media 顺序 concat、平行数组配对、URL 去重、文本行拼接', () => {
  const merged = mergeProcessedAttachments([
    {
      voiceText: '',
      imageUrls: ['u1', 'u2'],
      otherInfo: '[文件] a.pdf',
      transcripts: [],
      localMediaPaths: ['/tmp/a'],
      localMediaTypes: ['application/pdf'],
      remoteMediaUrls: ['ru1'],
      media: [{ kind: 'document', localPath: '/tmp/a' }] as any,
    },
    {
      voiceText: '[语音] 你好',
      imageUrls: ['u2', 'u3'],
      otherInfo: '',
      transcripts: [],
      localMediaPaths: ['/tmp/b'],
      localMediaTypes: ['image/png'],
      remoteMediaUrls: ['ru1', 'ru2'],
      media: [{ kind: 'image', localPath: '/tmp/b' }] as any,
    },
  ]);
  assert.equal(merged.media.length, 2);
  assert.equal(merged.media[0].kind, 'document');
  assert.equal(merged.media[1].kind, 'image');
  assert.deepEqual(merged.localMediaPaths, ['/tmp/a', '/tmp/b']);
  assert.deepEqual(merged.localMediaTypes, ['application/pdf', 'image/png']);
  assert.deepEqual(merged.imageUrls, ['u1', 'u2', 'u3']);
  assert.deepEqual(merged.remoteMediaUrls, ['ru1', 'ru2']);
  assert.equal(merged.voiceText, '[语音] 你好');
  assert.equal(merged.otherInfo, '[文件] a.pdf');
});

// ── 集成（真实 debouncer + 真实 dispatchToOpenClaw）──

group('集成：窗口内合并 / 单条直发 / 旁路 / 滑动窗口');

// 短窗口控制用例时长；框架内部硬上限 = debounceMs × 5 不受影响
const W = 120;

await test('窗口内「文件 + 文字」→ 单次 dispatch，合并 body，锚点为最后一条', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const file = makeC2CMsgAndCtx({
    content: '',
    assembledBody: {
      webBody: '[文件] report.pdf',
      agentBody: '- Images: \n\n[文件] report.pdf',
      rawBody: '',
    },
    processedAttachments: {
      voiceText: '',
      imageUrls: [],
      otherInfo: '[文件] report.pdf',
      transcripts: [],
      localMediaPaths: [],
      localMediaTypes: [],
      remoteMediaUrls: [],
      media: [{ kind: 'document', localPath: '/tmp/report.pdf' }],
    },
  });
  const text = makeC2CMsgAndCtx({
    content: '总结一下这个文件',
    assembledBody: { webBody: '总结一下这个文件', agentBody: '总结一下这个文件', rawBody: '总结一下这个文件' },
  });

  assert.equal(await enqueueC2CInboundMessage(file.ctx, file.msg, account, runtime), true);
  await sleep(40);
  assert.equal(await enqueueC2CInboundMessage(text.ctx, text.msg, account, runtime), true);
  await sleep(W + 80);
  assert.equal(captured.length, 1, `expected 1 dispatch, got ${captured.length}`);

  const { ingest, params, ctxPayload } = captured[0]!;
  assert.ok(ingest.textForAgent.includes('[消息 1/2]'), 'missing section header 1');
  assert.ok(ingest.textForAgent.includes('[消息 2/2]'), 'missing section header 2');
  assert.ok(ingest.textForAgent.includes('report.pdf'), 'file info missing');
  assert.ok(ingest.textForAgent.includes('总结一下这个文件'), 'companion text missing');
  // 载体 = 最后一条消息：锚点 messageId / 回复目标都取自最后一条
  assert.equal(params.raw.messageId, text.msg.messageId);
  assert.ok(String(params.raw.targetId).endsWith(text.msg.senderId));
  // media facts 合并进 ctxPayload（框架正规媒体通道）
  assert.equal(ctxPayload.media?.length, 1);
  assert.equal(ctxPayload.media[0].kind, 'document');
});

await test('单条消息 → 原样直发（无分节头，body 不变）', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const one = makeC2CMsgAndCtx({
    content: '你好',
    assembledBody: { webBody: '你好', agentBody: '你好', rawBody: '你好' },
  });
  assert.equal(await enqueueC2CInboundMessage(one.ctx, one.msg, account, runtime), true);
  await sleep(W + 80);
  assert.equal(captured.length, 1);
  assert.equal(captured[0]!.ingest.textForAgent, '你好');
  assert.ok(!captured[0]!.ingest.textForAgent.includes('[消息'));
});

await test('控制命令（stop）旁路防抖，立即 dispatch', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const stop = makeC2CMsgAndCtx({
    content: 'stop',
    assembledBody: { webBody: 'stop', agentBody: 'stop', rawBody: 'stop' },
  });
  assert.equal(await enqueueC2CInboundMessage(stop.ctx, stop.msg, account, runtime), true);
  // 旁路路径在 enqueue 内同步完成 dispatch，无需等窗口
  assert.equal(captured.length, 1, `expected immediate dispatch, got ${captured.length}`);
  assert.equal(captured[0]!.ingest.textForCommands, 'stop');
});

await test('滑动窗口：窗口期内的新消息重置计时', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const a = makeC2CMsgAndCtx({ content: 'a', assembledBody: { webBody: 'a', agentBody: 'a', rawBody: 'a' } });
  const b = makeC2CMsgAndCtx({ content: 'b', assembledBody: { webBody: 'b', agentBody: 'b', rawBody: 'b' } });

  await enqueueC2CInboundMessage(a.ctx, a.msg, account, runtime);
  await sleep(W / 2); // 60ms：窗口 120ms 未过，b 进入同一 buffer 并重置计时
  await enqueueC2CInboundMessage(b.ctx, b.msg, account, runtime);
  await sleep(W / 2 + 20); // t≈140ms：距 b 到达仅 80ms < 120ms，不应 flush
  assert.equal(captured.length, 0, `flushed too early at ${W / 2 + 20}ms after b`);
  await sleep(W); // t≈260ms：b 的窗口已过
  assert.equal(captured.length, 1);
  assert.ok(captured[0]!.ingest.textForAgent.includes('a'));
  assert.ok(captured[0]!.ingest.textForAgent.includes('b'));
});

await test('超窗消息 → 各自独立 dispatch', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const a = makeC2CMsgAndCtx({ content: '先到', assembledBody: { webBody: '先到', agentBody: '先到', rawBody: '先到' } });
  const b = makeC2CMsgAndCtx({ content: '后到', assembledBody: { webBody: '后到', agentBody: '后到', rawBody: '后到' } });
  await enqueueC2CInboundMessage(a.ctx, a.msg, account, runtime);
  await sleep(W + 80);
  await enqueueC2CInboundMessage(b.ctx, b.msg, account, runtime);
  await sleep(W + 80);
  assert.equal(captured.length, 2);
  assert.equal(captured[0]!.ingest.textForAgent, '先到');
  assert.equal(captured[1]!.ingest.textForAgent, '后到');
});

await test('不同发送者互不合并', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const u1 = makeC2CMsgAndCtx({ senderId: 'USER_1', content: '来自1', assembledBody: { webBody: '来自1', agentBody: '来自1', rawBody: '来自1' } });
  const u2 = makeC2CMsgAndCtx({ senderId: 'USER_2', content: '来自2', assembledBody: { webBody: '来自2', agentBody: '来自2', rawBody: '来自2' } });
  await enqueueC2CInboundMessage(u1.ctx, u1.msg, account, runtime);
  await enqueueC2CInboundMessage(u2.ctx, u2.msg, account, runtime);
  await sleep(W + 80);
  assert.equal(captured.length, 2);
  assert.equal(captured[0]!.ingest.textForAgent, '来自1');
  assert.equal(captured[1]!.ingest.textForAgent, '来自2');
});

await test('群消息 → 返回 false（不接管，调用方走直发）', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: W });
  const g = makeC2CMsgAndCtx({ scope: 'group', content: '群消息' });
  assert.equal(await enqueueC2CInboundMessage(g.ctx, g.msg, account, runtime), false);
  await sleep(W + 60);
  assert.equal(captured.length, 0);
});

await test('防抖关闭（debounceMs: 0）→ 返回 false', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: 0 });
  const one = makeC2CMsgAndCtx({ content: 'x' });
  assert.equal(await enqueueC2CInboundMessage(one.ctx, one.msg, account, runtime), false);
  await sleep(60);
  assert.equal(captured.length, 0);
});

await test('退出冲刷：flushAllC2CInboundDebouncers 强制发出窗口内 pending 消息', async () => {
  const { account, runtime, captured } = setupScenario({ debounceMs: 10_000 });
  const a = makeC2CMsgAndCtx({ content: 'pending', assembledBody: { webBody: 'pending', agentBody: 'pending', rawBody: 'pending' } });
  await enqueueC2CInboundMessage(a.ctx, a.msg, account, runtime);
  assert.equal(captured.length, 0);
  await flushAllC2CInboundDebouncers();
  assert.equal(captured.length, 1, 'flushKey should force-dispatch pending buffer');
  assert.equal(captured[0]!.ingest.textForAgent, 'pending');
});

// ── 结果 ──

console.log(`\n${'-'.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
