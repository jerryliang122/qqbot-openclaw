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
 *    - 三类旁路（控制命令 stop / 斜杠命令 / 多问题 keyed 答案）：
 *      不被合并且原样直发；有 pending buffer 时先冲刷再执行（保序）；
 *      运行中的 turn 不阻塞旁路（admission 在 lane 决策时放行，
 *      /stop 挡在 keyChains 后排队是 2026-10-16 修复的回归缺陷）；
 *      挂起 ask_user 的 keyed 答案同机制立即 dispatch（死锁类钉子）；
 *      跨窗口消息在运行中的 turn 期间即 dispatch（插嘴语义显式拍板）；
 *      放行时点取 lane 决策而非 inboundRun 调用（入队前不抢先，
 *      Sourcery 意见 2）；dispatch 失败（run 抛错）不悬挂 enqueue、
 *      不卡死同 key 后续旁路；
 *    - 退出冲刷两段式：flushAll 先等 lane 决策、再等在途 completion，
 *      宽限内能完成的 turn 不丢回复（Sourcery 意见 1）；
 *    - 滑动窗口：窗口内新消息重置计时（宽裕量 400ms 防事件循环延迟抖动）；
 *    - 超窗消息 → 各自独立 dispatch；不同发送者互不合并；
 *    - 到达顺序排序：入队顺序与平台到达顺序相反时按 timestamp 排序，
 *      载体 = 最新到达的消息；
 *    - 入队 await 语义：enqueue 的 promise 在 flush dispatch 完成后才
 *      resolve（typing 中间件链据此续命到 turn 结束）；
 *    - 防抖中途禁用：pending buffer 先冲刷再返回 false（消息不乱序）；
 *    - 群消息 / 防抖关闭 → enqueue 返回 false（调用方走直发路径）；
 *    - 退出冲刷：flushAllC2CInboundDebouncers 强制发出窗口内 pending 消息。
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

/**
 * 框架 debouncer 的 flush timer 是 unref() 的：裸测试环境里若无其他
 * ref'd 定时器，事件循环会在 flush 前空转退出（进程带着未决 await 静默
 * 终止）。生产环境由 WS 心跳/typing 续期等长活定时器撑住，无此问题。
 * 等待任何依赖 flush timer 的 promise 时用本 helper 挂一个 ref'd 心跳。
 */
async function keepAlive<T>(p: Promise<T>): Promise<T> {
  const heartbeat = setInterval(() => {}, 50);
  try {
    return await p;
  } finally {
    clearInterval(heartbeat);
  }
}

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
const { registerPendingMultiQuestion } = await import('../src/features/question-helpers.ts');

// ── 测试基础设施（对齐 room-event.test.ts）──

interface CapturedInbound {
  /** adapters.inboundRun 收到的 params */
  params: any;
  /** params.adapter.ingest({}) 的产物（textForAgent 等） */
  ingest: any;
  /** adapters.buildContext 收到的 ctxPayload（media facts 等） */
  ctxPayload: any;
}

function makeFakeRuntime(captured: CapturedInbound[], hang?: Promise<void>, admissionGate?: Promise<void>) {
  // dispatchToOpenClaw 的执行序：buildCtxPayload（调 buildContext）→
  // adapters.inboundRun——ctxPayload 先产出、后入栈，用暂存变量衔接。
  // hang：run 在 lane 采纳并调用 runDispatch 后挂起直至该 promise resolve
  // ——模拟"turn 已入 lane 队列但仍在运行"的长任务场景。
  // admissionGate：run 在 resolveTurn 前先等该 promise——模拟框架
  // runChannelTurn 入队前的异步管线（ingest/classify/preflight/
  // resolveTurn 多个 await 段，dist/run-channel-turn-*.js），用于验证
  // 放行信号取 lane 决策而非「inboundRun 已调用」。
  let pendingCtxPayload: any;
  return {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          captured.push({ params, ingest: params.adapter.ingest({}), ctxPayload: pendingCtxPayload });
          pendingCtxPayload = undefined;
          if (admissionGate) await admissionGate;
          const resolved = params.adapter.resolveTurn?.(params.raw, {}, {});
          try {
            await resolved?.runDispatch?.();
          } catch {
            /* dispatchReply 抛错由 dispatchToOpenClaw 自行处理 */
          }
          if (hang) await hang;
          return { dispatched: true };
        },
        buildContext: (params: any) => {
          pendingCtxPayload = params;
          return { ...params, __built: true };
        },
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: (params: any) => {
          // 模拟框架 lane 仲裁：真实框架在 session lane 接纳 turn 时调用
          // replyOptions.turnAdoptionLifecycle 的 onAdopted/onDeferred
          params?.replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          return { queuedFinal: true, counts: { final: 1 } };
        },
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
  timestamp?: string;
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
    timestamp: overrides.timestamp ?? new Date().toISOString(),
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
function setupScenario(inboundDebounce?: any, hang?: Promise<void>, admissionGate?: Promise<void>) {
  resetC2CInboundDebouncersForTest();
  _resetAdaptersCache();
  installFakeGateway();
  const captured: CapturedInbound[] = [];
  const runtime = makeFakeRuntime(captured, hang, admissionGate);
  return { account: makeAccount(inboundDebounce), runtime, captured };
}

/** 便捷封装：fire-and-forget 入队（buffered 项的 promise 要到 flush 才 resolve） */
function fire(scenario: { account: any; runtime: any }, mc: { msg: any; ctx: any }): Promise<boolean> {
  return enqueueC2CInboundMessage(mc.ctx, mc.msg, scenario.account, scenario.runtime);
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
  const scenario = setupScenario({ debounceMs: W });
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

  // fire-and-forget：buffered 项的 promise 到 flush dispatch 完成才 resolve
  const pf = fire(scenario, file);
  await sleep(40);
  const pt = fire(scenario, text);
  await keepAlive(Promise.all([pf, pt]));
  assert.equal(scenario.captured.length, 1, `expected 1 dispatch, got ${scenario.captured.length}`);

  const { ingest, params, ctxPayload } = scenario.captured[0]!;
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
  const scenario = setupScenario({ debounceMs: W });
  const one = makeC2CMsgAndCtx({
    content: '你好',
    assembledBody: { webBody: '你好', agentBody: '你好', rawBody: '你好' },
  });
  assert.equal(await keepAlive(fire(scenario, one)), true);
  assert.equal(scenario.captured.length, 1);
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '你好');
  assert.ok(!scenario.captured[0]!.ingest.textForAgent.includes('[消息'));
});

await test('控制命令（stop）旁路防抖，立即 dispatch', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const stop = makeC2CMsgAndCtx({
    content: 'stop',
    assembledBody: { webBody: 'stop', agentBody: 'stop', rawBody: 'stop' },
  });
  assert.equal(await keepAlive(fire(scenario, stop)), true);
  // 旁路路径在 enqueue 内同步完成 dispatch，无需等窗口
  assert.equal(scenario.captured.length, 1, `expected immediate dispatch, got ${scenario.captured.length}`);
  assert.equal(scenario.captured[0]!.ingest.textForCommands, 'stop');
});

await test('斜杠命令旁路：不被合并，原样直发（pending buffer 先冲刷，保序）', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const file = makeC2CMsgAndCtx({
    content: '',
    assembledBody: { webBody: '[文件] a.pdf', agentBody: '[文件] a.pdf', rawBody: '' },
  });
  const slash = makeC2CMsgAndCtx({
    content: '/status',
    assembledBody: { webBody: '/status', agentBody: '/status', rawBody: '/status' },
  });

  const pf = fire(scenario, file); // 进 buffer
  await sleep(30); // 窗口内
  assert.equal(await keepAlive(fire(scenario, slash)), true); // 旁路：先冲刷 buffer 再执行命令
  await keepAlive(pf);
  assert.equal(scenario.captured.length, 2, `expected buffer-flush + command dispatch, got ${scenario.captured.length}`);
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '[文件] a.pdf', 'buffer must flush before command');
  assert.equal(scenario.captured[1]!.ingest.textForCommands, '/status', 'command text must stay unmerged');
});

await test('多问题 keyed 答案旁路：原样直发不被合并（认领文本不被改写）', async () => {
  const scenario = setupScenario({ debounceMs: W });
  // 独立 sender：pending 记录 TTL（200ms）内仍在注册表里，同 sender 会
  // 让后续用例的消息误命中 keyed 旁路（跨测试污染）
  const answer = makeC2CMsgAndCtx({
    senderId: 'USER_QM',
    content: '1: 3\n2: 1',
    assembledBody: { webBody: '1: 3\n2: 1', agentBody: '1: 3\n2: 1', rawBody: '1: 3\n2: 1' },
  });
  registerPendingMultiQuestion(
    'test-account',
    'q-bypass-test',
    'c2c',
    answer.msg.replyTarget.targetId,
    [{ header: '题1', question: '选一个', options: ['a', 'b', 'c'] }],
    200, // 短 TTL：cleanup timer 不悬挂测试进程
  );
  assert.equal(await keepAlive(fire(scenario, answer)), true);
  assert.equal(scenario.captured.length, 1, 'keyed answer must bypass debounce immediately');
  assert.equal(scenario.captured[0]!.ingest.textForCommands, '1: 3\n2: 1');
});

await test('keyed 旁路按账号隔离：他账号的 pending 不影响本账号合并', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const a = makeC2CMsgAndCtx({ content: '前半句', assembledBody: { webBody: '前半句', agentBody: '前半句', rawBody: '前半句' } });
  const b = makeC2CMsgAndCtx({ content: '后半句', assembledBody: { webBody: '后半句', agentBody: '后半句', rawBody: '后半句' } });
  // openid 是 per-account 的：另一账号（other-account）同 targetId 的 pending
  // 多问题不应让本账号（test-account）的消息误走 keyed 旁路
  registerPendingMultiQuestion(
    'other-account',
    'q-cross-account',
    'c2c',
    a.msg.replyTarget.targetId,
    [{ header: '题', question: '选一个', options: ['a', 'b'] }],
    200,
  );
  const pa = fire(scenario, a);
  await sleep(30);
  const pb = fire(scenario, b);
  await keepAlive(Promise.all([pa, pb]));
  assert.equal(scenario.captured.length, 1, 'other-account pending must not bypass this account');
  assert.ok((scenario.captured[0]!.ingest.textForAgent as string).includes('[消息 1/2]'));
});

group('回归：旁路不被运行中的 turn 阻塞（2026-10-16 /stop 卡死修复）');

await test('turn 运行中到达的 /stop 立即 dispatch，不等 turn 跑完', async () => {
  // 场景：任务 turn 已提交进网关且仍在运行（run 挂起）。此时同发送者
  // 发来 /stop——框架 debouncer 的 enqueue 对旁路项在同 key 有 in-flight
  // 任务链时会排队等其 settle；修复前 admission === completion（覆盖整个
  // turn run），/stop 要等任务 turn 跑完才 dispatch，插嘴语义失效。
  // 修复后 admission 在 turn 提交（onTurnSubmitted）时即放行，/stop
  // 在 turn 仍在运行时就完成 dispatch（fake run 在入口记录 captured）。
  let releaseTurn!: () => void;
  const turnHanging = new Promise<void>((r) => {
    releaseTurn = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, turnHanging);

  const task = makeC2CMsgAndCtx({
    content: '长任务',
    assembledBody: { webBody: '长任务', agentBody: '长任务', rawBody: '长任务' },
  });
  const pf = fire(scenario, task); // 进 buffer
  await keepAlive(sleep(200)); // 窗口过 → flush → dispatchToOpenClaw → run 入口挂起（turn 运行中）
  assert.equal(scenario.captured.length, 1, 'task turn must be submitted and still running');
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '长任务');

  const stop = makeC2CMsgAndCtx({
    content: '/stop',
    assembledBody: { webBody: '/stop', agentBody: '/stop', rawBody: '/stop' },
  });
  const ps = fire(scenario, stop); // 旁路：无 pending buffer；key 链须已随 turn 提交释放
  await keepAlive(sleep(80)); // 同步前缀 → inboundRun 入口，远小于窗口/turn 时长
  assert.equal(
    scenario.captured.length,
    2,
    '/stop must dispatch while previous turn is still running (was queued behind it before fix)',
  );
  assert.equal(scenario.captured[1]!.ingest.textForCommands, '/stop', 'command text must stay unmerged');

  releaseTurn(); // 放行挂起的 turn（两条 run 共用同一 hang）
  await keepAlive(Promise.all([pf, ps]));
  assert.equal(scenario.captured.length, 2);
});

await test('turn 运行中到达的控制命令（stop）同样立即 dispatch', async () => {
  // 同机制的控制命令词形态（非斜杠）：shouldDebounceTextInbound 判定旁路
  let releaseTurn!: () => void;
  const turnHanging = new Promise<void>((r) => {
    releaseTurn = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, turnHanging);

  const task = makeC2CMsgAndCtx({
    content: '另一个长任务',
    assembledBody: { webBody: '另一个长任务', agentBody: '另一个长任务', rawBody: '另一个长任务' },
  });
  const pf = fire(scenario, task);
  await keepAlive(sleep(200));
  assert.equal(scenario.captured.length, 1);

  const stopWord = makeC2CMsgAndCtx({
    content: 'stop',
    assembledBody: { webBody: 'stop', agentBody: 'stop', rawBody: 'stop' },
  });
  const ps = fire(scenario, stopWord);
  await keepAlive(sleep(80));
  assert.equal(
    scenario.captured.length,
    2,
    'control word must dispatch while previous turn is still running',
  );
  assert.equal(scenario.captured[1]!.ingest.textForCommands, 'stop');

  releaseTurn();
  await keepAlive(Promise.all([pf, ps]));
});

await test('dispatch 失败（run 抛错）不卡死同 key 后续旁路，enqueue promise 不悬挂', async () => {
  // completion reject 路径：dispatchToOpenClaw 尾部 rethrow → onFlush 的
  // completion 拒绝 → finally 兜底 admit + settleItems（onError 再 settle 幂等）。
  // 若无兜底，失败批次的 key 链悬挂，同 key 后续旁路消息被永久卡死。
  let failFirst = true;
  const captured: CapturedInbound[] = [];
  const runtime = {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          captured.push({ params, ingest: params.adapter.ingest({}), ctxPayload: undefined });
          if (failFirst) {
            failFirst = false;
            throw new Error('gateway exploded');
          }
          return { dispatched: true };
        },
        buildContext: (params: any) => ({ ...params, __built: true }),
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
  resetC2CInboundDebouncersForTest();
  _resetAdaptersCache();
  installFakeGateway();
  const scenario = { account: makeAccount({ debounceMs: 120 }), runtime, captured };

  const first = makeC2CMsgAndCtx({
    content: '会失败的消息',
    assembledBody: { webBody: '会失败的消息', agentBody: '会失败的消息', rawBody: '会失败的消息' },
  });
  const p1 = fire(scenario, first);
  await keepAlive(sleep(200)); // flush → dispatch → run 抛错 → completion reject → 兜底 admit + onError settle
  await keepAlive(p1); // onError/onCancel 路径必须放行 done 信号（不悬挂）
  assert.equal(captured.length, 1);

  const stop = makeC2CMsgAndCtx({
    content: '/stop',
    assembledBody: { webBody: '/stop', agentBody: '/stop', rawBody: '/stop' },
  });
  const p2 = fire(scenario, stop); // key 链必须已释放（不能被失败批次卡住）
  await keepAlive(p2);
  assert.equal(captured.length, 2, 'bypass after failed batch must not be blocked');
  assert.equal(captured[1]!.ingest.textForCommands, '/stop');
});

await test('放行取 lane 决策而非 inboundRun 调用时点——入队前 /stop 不抢先 dispatch', async () => {
  // Sourcery 意见 2：框架 runChannelTurn 在真正入队前还有 ingest →
  // classify → preflight → resolveTurn 多个异步段。若放行信号取
  // 「adapters.inboundRun 已调用」，任务批次尚未入 lane 时链已释放，
  // /stop 会抢先到达 lane 而无处可取消，任务随后入队继续跑（stop 落空）。
  // admissionGate 把 lane 决策闸住：闸门释放前（turn 已 dispatch、
  // captured 已记录，但尚未入队），/stop 不得 dispatch。
  let releaseAdoption!: () => void;
  const adoptionGate = new Promise<void>((r) => {
    releaseAdoption = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, undefined, adoptionGate);

  const task = makeC2CMsgAndCtx({
    content: '闸门中的任务',
    assembledBody: { webBody: '闸门中的任务', agentBody: '闸门中的任务', rawBody: '闸门中的任务' },
  });
  const pf = fire(scenario, task);
  await keepAlive(sleep(200)); // flush → dispatch → run 入口已记录，但 lane 决策被闸住
  assert.equal(scenario.captured.length, 1, 'task dispatched but not yet admitted into lane');

  const stop = makeC2CMsgAndCtx({
    content: '/stop',
    assembledBody: { webBody: '/stop', agentBody: '/stop', rawBody: '/stop' },
  });
  const ps = fire(scenario, stop);
  await keepAlive(sleep(80));
  assert.equal(
    scenario.captured.length,
    1,
    '/stop must NOT dispatch before previous turn is admitted into the lane (pre-enqueue release race)',
  );

  releaseAdoption(); // lane 采纳任务批次 → 链放行
  await keepAlive(sleep(80));
  assert.equal(scenario.captured.length, 2, '/stop dispatches right after lane admission');
  assert.equal(scenario.captured[1]!.ingest.textForCommands, '/stop');
  await keepAlive(Promise.all([pf, ps]));
});

await test('退出冲刷两段式：flushAll 等在途 turn 的 completion，宽限内完成的回复不丢', async () => {
  // Sourcery 意见 1：SIGINT/SIGTERM 时若 flushAll 只等 admission（lane
  // 决策）就返回，shutdown handler 立即 forceExit，正在运行的 turn 即使
  // 能在 1.5s 宽限内跑完也会被杀掉、回复丢失。flushAll 必须再等在途
  // completion（调用方 runtime.ts 以 1.5s 有界封顶，不会无限等）。
  let releaseTurn!: () => void;
  const turnHanging = new Promise<void>((r) => {
    releaseTurn = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, turnHanging);

  const task = makeC2CMsgAndCtx({
    content: '退出前的任务',
    assembledBody: { webBody: '退出前的任务', agentBody: '退出前的任务', rawBody: '退出前的任务' },
  });
  const pf = fire(scenario, task);
  await keepAlive(sleep(200)); // turn 已入 lane（onAdopted 已触发）且运行中
  assert.equal(scenario.captured.length, 1);

  let flushDone = false;
  const flushP = keepAlive(
    flushAllC2CInboundDebouncers().then(() => {
      flushDone = true;
    }),
  );
  await keepAlive(sleep(80));
  assert.equal(flushDone, false, 'flushAll must keep waiting for the in-flight turn completion');
  releaseTurn();
  await keepAlive(Promise.all([pf, flushP]));
  assert.equal(flushDone, true);
});

await test('跨窗口第二文件在 turn A 运行中即 dispatch——插嘴语义（二轮评审显式拍板）', async () => {
  // 拍板结论：放行在 lane 决策处 ⇒ 窗口外的同发送者消息不再串行在
  // 运行中的 turn 之后（v2.5.0–v2.6.0 的意外串行被放弃，c2c 恢复
  // pre-v2.5.0 插嘴语义，对齐框架 createInboundDebounceFlush 契约；
  // 窗口内合并不受影响）。本用例钉住该决策：turn A 运行中，窗口外的
  // 文件 2 必须能 dispatch（真实框架里它 exclusive 入场 abort turn A，
  // 插件级测试钉 dispatch 时机即可）。修复前（admission === completion）
  // 文件 2 会排在 turn A 之后——本用例红。
  let releaseTurn!: () => void;
  const turnHanging = new Promise<void>((r) => {
    releaseTurn = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, turnHanging);

  const file1 = makeC2CMsgAndCtx({
    content: '',
    assembledBody: { webBody: '[文件] 1.pdf', agentBody: '[文件] 1.pdf', rawBody: '' },
  });
  const p1 = fire(scenario, file1);
  await keepAlive(sleep(250)); // 窗口过 → turn A 已入 lane 且运行中（hang）
  assert.equal(scenario.captured.length, 1);

  const file2 = makeC2CMsgAndCtx({
    content: '',
    assembledBody: { webBody: '[文件] 2.pdf', agentBody: '[文件] 2.pdf', rawBody: '' },
  });
  const p2 = fire(scenario, file2); // 窗口外、非旁路 → 新 buffer
  await keepAlive(sleep(450)); // 文件 2 的窗口走完 → flush → dispatch
  assert.equal(
    scenario.captured.length,
    2,
    'out-of-window message must dispatch while previous turn still runs (interjection semantics)',
  );
  assert.ok((scenario.captured[1]!.ingest.textForAgent as string).includes('2.pdf'));

  releaseTurn();
  await keepAlive(Promise.all([p1, p2]));
});

await test('挂起 ask_user 的 keyed 答案在 turn 运行中立即 dispatch（死锁类钉子）', async () => {
  // 与 /stop 同一旁路机制、但后果更重：ask_user turn 运行中（等待答案），
  // keyed 答案若被同 key 链排队即死锁——答案等 turn 完成、turn 等答案。
  // 修复前（admission === completion）正是如此；放行在 lane 决策处后
  // 答案立即 dispatch、turn 得以续跑。
  let releaseTurn!: () => void;
  const turnHanging = new Promise<void>((r) => {
    releaseTurn = r;
  });
  const scenario = setupScenario({ debounceMs: 120 }, turnHanging);
  const senderId = 'USER_ASK'; // 独立 sender 防 keyed pending 跨测试污染
  const ask = makeC2CMsgAndCtx({
    senderId,
    content: '帮我选一下',
    assembledBody: { webBody: '帮我选一下', agentBody: '帮我选一下', rawBody: '帮我选一下' },
  });
  const p1 = fire(scenario, ask);
  await keepAlive(sleep(250)); // ask turn 已入 lane 且运行中（模拟挂起 ask_user）
  assert.equal(scenario.captured.length, 1);

  registerPendingMultiQuestion(
    'test-account',
    'q-deadlock-pin',
    'c2c',
    senderId,
    [{ header: '题1', question: '选一个', options: ['a', 'b'] }],
    200, // 短 TTL：cleanup timer 不悬挂测试进程
  );
  const answer = makeC2CMsgAndCtx({
    senderId,
    content: '1: a',
    assembledBody: { webBody: '1: a', agentBody: '1: a', rawBody: '1: a' },
  });
  const p2 = fire(scenario, answer); // keyed 旁路：不得被运行中的 turn 排队
  await keepAlive(sleep(80));
  assert.equal(
    scenario.captured.length,
    2,
    'keyed answer must dispatch while the awaiting turn still runs (deadlock before fix)',
  );
  assert.equal(scenario.captured[1]!.ingest.textForCommands, '1: a');

  releaseTurn();
  await keepAlive(Promise.all([p1, p2]));
});

await test('到达顺序排序：入队顺序颠倒时按平台 timestamp 排序，载体 = 最新到达', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const base = Date.now();
  // 快消息（文字）先完成中间件先入队，但平台时间戳更晚；
  // 慢消息（附件下载耗时）后入队，平台时间戳更早（用户先发的文件）
  const file = makeC2CMsgAndCtx({
    content: '',
    timestamp: new Date(base).toISOString(),
    assembledBody: { webBody: '[文件] early.pdf', agentBody: '[文件] early.pdf', rawBody: '' },
  });
  const text = makeC2CMsgAndCtx({
    content: '后到的说明',
    timestamp: new Date(base + 1000).toISOString(),
    assembledBody: { webBody: '后到的说明', agentBody: '后到的说明', rawBody: '后到的说明' },
  });

  const pt = fire(scenario, text); // 先入队（中间件完成顺序）
  await sleep(20);
  const pf = fire(scenario, file); // 后入队（真实到达更早）
  await keepAlive(Promise.all([pt, pf]));

  assert.equal(scenario.captured.length, 1);
  const { ingest, params } = scenario.captured[0]!;
  const body = ingest.textForAgent as string;
  assert.ok(
    body.indexOf('[消息 1/2]\n[文件] early.pdf') < body.indexOf('[消息 2/2]\n后到的说明'),
    'arrival order must follow platform timestamp, not enqueue order',
  );
  // 载体 = 最新到达（text），锚点取其 messageId
  assert.equal(params.raw.messageId, text.msg.messageId);
});

await test('入队 await 语义：promise 在 flush dispatch 完成后才 resolve（typing 续命）', async () => {
  const scenario = setupScenario({ debounceMs: 150 });
  const one = makeC2CMsgAndCtx({
    content: 'hold',
    assembledBody: { webBody: 'hold', agentBody: 'hold', rawBody: 'hold' },
  });
  const p = fire(scenario, one);
  // 窗口未过：无 dispatch，promise 未 resolve
  const early = await Promise.race([p.then(() => 'done' as const), sleep(20).then(() => 'pending' as const)]);
  assert.equal(early, 'pending');
  assert.equal(scenario.captured.length, 0);
  await keepAlive(p); // resolve 时 dispatch 必已完成
  assert.equal(scenario.captured.length, 1, 'enqueue promise must resolve after flush dispatch');
});

await test('滑动窗口：窗口期内的新消息重置计时（宽窗口防事件循环抖动）', async () => {
  // 用 400ms 窗口：入队间隙需 >400ms 的事件循环停顿才会破坏前提（CI 低概率），
  // 断言点的裕量同样放大；计时器按到期顺序执行，后断言稳健
  const W2 = 400;
  const scenario = setupScenario({ debounceMs: W2 });
  const a = makeC2CMsgAndCtx({ content: 'a', assembledBody: { webBody: 'a', agentBody: 'a', rawBody: 'a' } });
  const b = makeC2CMsgAndCtx({ content: 'b', assembledBody: { webBody: 'b', agentBody: 'b', rawBody: 'b' } });

  const pa = fire(scenario, a);
  await sleep(120); // 30% 窗口：未过
  const pb = fire(scenario, b); // 重置计时，deadline = b + 400ms
  const mid = await Promise.race([Promise.all([pa, pb]).then(() => 'flushed' as const), sleep(280).then(() => 'pending' as const)]);
  assert.equal(mid, 'pending', `flushed too early (~400ms after a, only ~280ms after b)`);
  await keepAlive(Promise.all([pa, pb]));
  assert.equal(scenario.captured.length, 1);
  assert.ok((scenario.captured[0]!.ingest.textForAgent as string).includes('a'));
  assert.ok((scenario.captured[0]!.ingest.textForAgent as string).includes('b'));
});

await test('超窗消息 → 各自独立 dispatch', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const a = makeC2CMsgAndCtx({ content: '先到', assembledBody: { webBody: '先到', agentBody: '先到', rawBody: '先到' } });
  const b = makeC2CMsgAndCtx({ content: '后到', assembledBody: { webBody: '后到', agentBody: '后到', rawBody: '后到' } });
  await keepAlive(fire(scenario, a)); // await 到第一次 flush 完成
  await keepAlive(fire(scenario, b));
  assert.equal(scenario.captured.length, 2);
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '先到');
  assert.equal(scenario.captured[1]!.ingest.textForAgent, '后到');
});

await test('不同发送者互不合并', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const u1 = makeC2CMsgAndCtx({ senderId: 'USER_1', content: '来自1', assembledBody: { webBody: '来自1', agentBody: '来自1', rawBody: '来自1' } });
  const u2 = makeC2CMsgAndCtx({ senderId: 'USER_2', content: '来自2', assembledBody: { webBody: '来自2', agentBody: '来自2', rawBody: '来自2' } });
  const p1 = fire(scenario, u1);
  const p2 = fire(scenario, u2);
  await keepAlive(Promise.all([p1, p2]));
  assert.equal(scenario.captured.length, 2);
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '来自1');
  assert.equal(scenario.captured[1]!.ingest.textForAgent, '来自2');
});

await test('防抖中途禁用：pending buffer 先冲刷再返回 false（消息不乱序）', async () => {
  const scenario = setupScenario({ debounceMs: 200 });
  const old = makeC2CMsgAndCtx({ content: '旧消息', assembledBody: { webBody: '旧消息', agentBody: '旧消息', rawBody: '旧消息' } });
  const fresh = makeC2CMsgAndCtx({ content: '新消息', assembledBody: { webBody: '新消息', agentBody: '新消息', rawBody: '新消息' } });

  const pOld = fire(scenario, old); // 进 buffer
  await sleep(30);
  (scenario.account.config as any).inboundDebounce = { debounceMs: 0 }; // 配置热更新为关闭
  // 返回 false 前必须先把该发送者的 pending buffer 冲刷掉（保序）
  assert.equal(await keepAlive(fire(scenario, fresh)), false);
  await keepAlive(pOld);
  assert.equal(scenario.captured.length, 1, 'pending buffer must be flushed before returning false');
  assert.equal(scenario.captured[0]!.ingest.textForAgent, '旧消息');
});

await test('群消息 → 返回 false（不接管，调用方走直发）', async () => {
  const scenario = setupScenario({ debounceMs: W });
  const g = makeC2CMsgAndCtx({ scope: 'group', content: '群消息' });
  assert.equal(await fire(scenario, g), false);
  await sleep(60);
  assert.equal(scenario.captured.length, 0);
});

await test('防抖关闭（debounceMs: 0）→ 返回 false', async () => {
  const scenario = setupScenario({ debounceMs: 0 });
  const one = makeC2CMsgAndCtx({ content: 'x' });
  assert.equal(await fire(scenario, one), false);
  await sleep(60);
  assert.equal(scenario.captured.length, 0);
});

await test('退出冲刷：flushAllC2CInboundDebouncers 强制发出窗口内 pending 消息', async () => {
  const scenario = setupScenario({ debounceMs: 10_000 });
  const a = makeC2CMsgAndCtx({ content: 'pending', assembledBody: { webBody: 'pending', agentBody: 'pending', rawBody: 'pending' } });
  const pa = fire(scenario, a);
  assert.equal(scenario.captured.length, 0);
  await keepAlive(flushAllC2CInboundDebouncers());
  assert.equal(scenario.captured.length, 1, 'flushKey should force-dispatch pending buffer');
  assert.equal(scenario.captured[0]!.ingest.textForAgent, 'pending');
  await keepAlive(pa); // 冲刷触发 onFlush，入队 promise 随之 resolve
});

// ── 结果 ──

console.log(`\n${'-'.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
