/**
 * StreamingController 提前 finalize 的 park 语义（issue #80）测试
 *
 * 场景：框架 follow-up 注入（reply-owner-ended 交接）下 dispatch 的 inboundRun
 * 在「仅入队」时即 resolve，dispatch 收尾的 finalize 打到 idle 无内容的 controller。
 * 修复前：落入 finalize:fallback 终态，之后长跑 run 持续投递的 partial/flush/final
 * 全被 isTerminal 守卫静默吞掉（零日志、零网络请求），只有最终回复经默认路径送达。
 * 修复后（三件套）：
 *   1. 无内容 finalize 不终态化（park 保持 idle 待命），后续内容正常承接；
 *   2. dispatch 已收尾时 deliver(kind='final') 补位 finalize，收尾最后一段缓冲；
 *   3. 终态丢弃内容的入口（handleChunk/flushSegment/doCloseSegment/absorbFinalText）
 *      打 WARN 附字符数。
 *
 * 另含 Sourcery 评审驱动的补丁用例（PR #81 评审意见 1-5/7/8）：
 * 补位收尾发送失败回退默认路径、纯空白 partial 不算内容、已中止 turn 不承接
 * 迟到内容、流式早退前转发媒体、stream parked 尾巴直接补发、终态封口告警。
 *
 * 运行方式: npx tsx tests/streaming-parked-finalize.test.ts
 */
import assert from 'node:assert/strict';

// ============ Mock 记录（Part 1: controller 层）============

let openStreamCalls = 0;
let streamUpdates: string[] = [];
let streamCompletes = 0;
let staticSendCalls: string[] = [];

const logs: string[] = [];

function resetMocks(): void {
  openStreamCalls = 0;
  streamUpdates = [];
  streamCompletes = 0;
  staticSendCalls = [];
  logs.length = 0;
}

function createMockGateway() {
  return {
    openStream() {
      openStreamCalls++;
      return {
        update: async (text: string) => {
          streamUpdates.push(text);
        },
        complete: async () => {
          streamCompletes++;
          return { id: 'stream-done', timestamp: Date.now() };
        },
      };
    },
  };
}

const { StreamingController } = await import('../src/outbound/streaming-controller.ts');
type Ctrl = InstanceType<typeof StreamingController>;

interface MakeOpts {
  sendMode?: 'stream' | 'static';
  sendStatic?: (text: string) => Promise<void>;
}

function makeController(opts: MakeOpts = {}): Ctrl {
  return new StreamingController({
    gateway: createMockGateway() as any,
    target: { scope: 'c2c', targetId: 'user-1', msgId: 'msg-1' },
    accountId: 'test',
    replyToId: 'msg-1',
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: () => {},
    },
    sendMode: opts.sendMode,
    sendStatic: opts.sendStatic ?? (async (text: string) => { staticSendCalls.push(text); }),
  });
}

// ============ 测试框架 ============

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  resetMocks();
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ✗ ${name}`);
    console.log(`     ${e.message}`);
    const relevant = logs.slice(-8);
    if (relevant.length) {
      console.log(`     --- 日志 ---`);
      for (const l of relevant) console.log(`       ${l}`);
    }
    failed++;
    failedTests.push(name);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function warnCount(fragment: string): number {
  return logs.filter((l) => l.includes('[WARN]') && l.includes(fragment)).length;
}

// ============ Part 1: controller 层（park 语义）============

group('Part 1: controller 层');

await test('static: idle 无内容 finalize → park（不终态化）+ WARN', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.finalize();

  assert.strictEqual(ctrl.currentPhase, 'idle', '应保持 idle，不进终态');
  assert.strictEqual(ctrl.isTerminal, false, '非终态——后续内容可正常承接');
  assert.strictEqual(ctrl.parked, true, 'park 标记应置位');
  assert.strictEqual(warnCount('parking'), 1, '应打一条 park WARN');
  assert.strictEqual(staticSendCalls.length, 0, '无内容不应发送');
  assert.ok(!logs.some((l) => l.includes('finalize:fallback')), '不应再出现 finalize:fallback 终态');
});

await test('static: park 后 partial 正常累积，flush 发出，再 finalize → done:flushed', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.finalize(); // park

  await ctrl.onPartialReply('前置');
  assert.strictEqual(ctrl.currentPhase, 'streaming', 'park 后 partial 应正常承接');
  assert.strictEqual(ctrl.parked, true, 'park 标记保持（dispatch 据此补位收尾）');

  await ctrl.flushSegment();
  assert.deepStrictEqual(staticSendCalls, ['前置'], '前置消息应正常送达');

  await ctrl.finalize(); // 缓冲空、已发段 → finalize:flushed
  assert.strictEqual(ctrl.currentPhase, 'done');
  assert.ok(logs.some((l) => l.includes('finalize:flushed')), '终态原因应是 finalize:flushed');
  assert.ok(!logs.some((l) => l.includes('finalize:fallback')), '不应是误导性的 finalize:fallback');
});

await test('static: park 后 partial + absorb(final) + finalize → 终稿送达（长跑收尾链）', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.finalize(); // park

  await ctrl.onPartialReply('终稿正文');
  await ctrl.absorbFinalText('终稿正文'); // identical → no-op（等待收尾）
  await ctrl.finalize(); // dispatch 补位收尾

  assert.deepStrictEqual(staticSendCalls, ['终稿正文'], '终稿应经 finalize 发出');
  assert.strictEqual(ctrl.currentPhase, 'done');
});

await test('static: 多段已全部 flush → finalize → done:flushed（非 fallback、非 park）', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.onPartialReply('段A');
  await ctrl.flushSegment();
  await ctrl.onPartialReply('段B');
  await ctrl.flushSegment();
  assert.deepStrictEqual(staticSendCalls, ['段A', '段B']);

  await ctrl.finalize();
  assert.strictEqual(ctrl.currentPhase, 'done', '有过内容应正常终态');
  assert.strictEqual(ctrl.parked, false, '不应 park');
  assert.ok(logs.some((l) => l.includes('finalize:flushed')), 'reason 应为 finalize:flushed');
});

await test('static: 正常收尾后再 flushSegment → 无 WARN、无重复发送（清缓冲不误报）', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.onPartialReply('正文');
  await ctrl.finalize(); // 发送 + done
  assert.deepStrictEqual(staticSendCalls, ['正文']);

  staticSendCalls.length = 0;
  logs.length = 0;
  await ctrl.flushSegment();
  assert.deepStrictEqual(staticSendCalls, [], '缓冲已清空，不应重复发送');
  assert.strictEqual(warnCount('flushSegment dropped'), 0, '已发送内容不构成丢弃，不应误报 WARN');
});

await test('static: 终态后 onPartialReply → WARN 附字符数，不再发送', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.onPartialReply('正文');
  await ctrl.finalize();
  staticSendCalls.length = 0;
  logs.length = 0;

  await ctrl.onPartialReply('迟到内容');
  assert.deepStrictEqual(staticSendCalls, [], '终态后不应发送');
  assert.strictEqual(warnCount('chunk dropped'), 1, '应打一条丢弃 WARN');
  assert.ok(logs.some((l) => l.includes('chars=4')), 'WARN 应附丢弃字符数');
});

await test('static: 终态后 absorbFinalText → WARN 留痕', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.onPartialReply('正文');
  await ctrl.finalize();
  logs.length = 0;

  await ctrl.absorbFinalText('迟到 final');
  assert.strictEqual(warnCount('final absorb skipped'), 1, '终态 absorb 应打 WARN（issue #80 可观测性）');
});

await test('static: sendStatic 失败（failed 终态、缓冲未清）后 flushSegment → WARN 真实丢失', async () => {
  const ctrl = makeController({
    sendMode: 'static',
    sendStatic: async () => { throw new Error('send boom'); },
  });
  await ctrl.onPartialReply('正文');
  await ctrl.finalize();
  assert.strictEqual(ctrl.currentPhase, 'failed', 'sendStatic 抛错应 failed');
  logs.length = 0;

  await ctrl.flushSegment();
  assert.strictEqual(warnCount('flushSegment dropped'), 1, '未发送缓冲被丢弃应告警');
  assert.ok(logs.some((l) => l.includes('bufferChars=2')), 'WARN 应附缓冲字符数');
});

await test('stream: idle 无内容 finalize → park；park 后 partial 正常开流；finalize 收尾', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.finalize();

  assert.strictEqual(ctrl.currentPhase, 'idle', 'stream 模式同样 park，不终态化');
  assert.strictEqual(ctrl.parked, true);
  assert.strictEqual(warnCount('parking'), 1);

  await ctrl.onPartialReply('正文');
  assert.strictEqual(ctrl.currentPhase, 'streaming');
  assert.strictEqual(openStreamCalls, 1, 'park 后 partial 应正常开流式会话');
  assert.deepStrictEqual(streamUpdates, ['正文']);

  await ctrl.finalize();
  assert.strictEqual(ctrl.currentPhase, 'done');
  assert.strictEqual(streamCompletes, 1, 'finalize 应收尾会话');
});

await test('park 幂等：再次无内容 finalize → 仍 idle，WARN 不重复', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.finalize();
  assert.strictEqual(warnCount('parking'), 1);

  await ctrl.finalize();
  assert.strictEqual(warnCount('parking'), 1, '重复 park 不应重复 WARN');
  assert.strictEqual(ctrl.parked, true);
  assert.strictEqual(ctrl.currentPhase, 'idle');
});

// ============ Part 2: dispatch 层（端到端，真实 dispatchToOpenClaw）============

const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

interface CapturedDispatch {
  replyOptions?: any;
  dispatcherOptions?: { deliver?: (payload: any, info?: any) => Promise<void> };
}

function makeFakeRuntime(opts: { onInboundRun?: (params: any) => Promise<any> } = {}) {
  return {
    version: 'test',
    channel: {
      inbound: {
        ...(opts.onInboundRun ? { run: (params: any) => opts.onInboundRun!(params) } : {}),
        buildContext: (params: any) => ({ ...params, __built: true }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: (params: any) => params.__dispatch(params),
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

function installFakeGateway(opts: { failFirstTextSend?: boolean } = {}) {
  const sentTexts: string[] = [];
  const sentMedia: string[] = [];
  let textSendCount = 0;
  const gw = {
    sendText: async (_target: any, text: string) => {
      textSendCount++;
      // outbound-service.sendText 只把 gateway 的【抛错】当失败（返回值一律视为
      // 成功，error 由其 catch formatError 产生）——模拟失败必须 throw
      if (opts.failFirstTextSend && textSendCount === 1) {
        throw new Error('boom (failFirstTextSend)');
      }
      sentTexts.push(text);
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async (...args: any[]) => {
      const url = args.find((a) => typeof a === 'string' && a.startsWith('http'));
      sentMedia.push(url ?? `arg:${args.length}`);
      return { id: 'media-out' };
    },
    openStream: () => ({
      update: async () => {},
      complete: async () => ({ id: 'stream-done', timestamp: Date.now() }),
    }),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts, sentMedia };
}

/**
 * 跑一次真实 dispatchToOpenClaw。simulate 在 inboundRun 内部执行：返回即代表
 * inboundRun resolve（正常 turn 跑完 / follow-up 注入下「仅入队」即 resolve）。
 * 返回 captured 供 dispatch 返回后继续模拟框架投递（issue #80 场景的关键）。
 */
async function runDispatch(opts: {
  streaming: false | { mode: string; sendMode?: 'static' };
  simulate: (captured: CapturedDispatch) => Promise<void>;
  ctxSignal?: AbortSignal;
  failFirstTextSend?: boolean;
}): Promise<{ sentTexts: string[]; sentMedia: string[]; captured: CapturedDispatch }> {
  _resetAdaptersCache();
  const msg = {
    kind: 'c2c',
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    content: 'hello',
    senderId: 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope: 'c2c', targetId: 'USER_123' },
    timestamp: Date.now(),
  } as any;
  const ctx = {
    state: {},
    message: { content: 'hello' },
    ...(opts.ctxSignal ? { signal: opts.ctxSignal } : {}),
  } as any;
  let captured: CapturedDispatch = {};

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
    },
  });
  (runtime.channel.reply as any).dispatchReplyWithBufferedBlockDispatcher = async (params: any) => {
    captured = {
      replyOptions: params.replyOptions,
      dispatcherOptions: params.dispatcherOptions,
    };
    await opts.simulate(captured);
    return { ok: true };
  };

  const account = {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: opts.streaming,
    },
  } as any;

  const { sentTexts, sentMedia } = installFakeGateway({ failFirstTextSend: opts.failFirstTextSend });
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  return { sentTexts, sentMedia, captured };
}

group('Part 2: dispatch 层（端到端）');

await test('issue #80 复现：提前收尾后长跑投递 → 前置消息与终稿全部送达', async () => {
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    // simulate 为空 = inboundRun 立即 resolve（follow-up 注入，dispatch 提前收尾，
    // controller 被 park 而非终态化）。修复前：之后到达的 partial 全被吞。
    simulate: async () => {},
  });

  // dispatch 已返回，框架继续用这个 delivery context 投递长跑产出
  await captured.replyOptions?.onPartialReply?.({ text: '前置消息1' });
  await captured.replyOptions?.onToolStart?.();            // 段边界1 → flush 前置消息1
  await captured.replyOptions?.onPartialReply?.({ text: '前置消息2' });
  await captured.replyOptions?.onAssistantMessageStart?.(); // 段边界2 → flush 前置消息2
  await captured.replyOptions?.onPartialReply?.({ text: '终稿正文' });
  await captured.dispatcherOptions?.deliver?.({ text: '终稿正文' }, { kind: 'final' }); // absorb + 补位 finalize

  assert.deepStrictEqual(
    sentTexts,
    ['前置消息1', '前置消息2', '终稿正文'],
    '前置消息逐段送达 + 终稿经补位 finalize 送达（修复前仅终稿经默认路径幸存）',
  );
});

await test('空 turn park 无害 + 迟到内容仍被承接（park 未终态化的直接证据，评审意见 8）', async () => {
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async () => {},
  });
  assert.deepStrictEqual(sentTexts, [], '空 turn 不应有任何发送');

  // 仅断言「无发送」无法区分 park 与旧的终态化（旧行为同样静默）——直接
  // 验证 park 的行为面：迟到 partial 应被承接并在边界 flush 发出。
  await captured.replyOptions?.onPartialReply?.({ text: '迟到段落' });
  await captured.replyOptions?.onToolStart?.();
  assert.deepStrictEqual(sentTexts, ['迟到段落'], 'park（非终态）应承接迟到内容并发出');
});

group('Part 3: Sourcery 评审驱动用例（PR #81）');

await test('评审1: parked 补位收尾发送失败 → final 落回默认路径送达', async () => {
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    failFirstTextSend: true, // 第一次 sendText（补位 finalize 的 sendStatic）失败
    simulate: async () => {},
  });
  await captured.replyOptions?.onPartialReply?.({ text: '终稿正文' });
  await captured.dispatcherOptions?.deliver?.({ text: '终稿正文' }, { kind: 'final' });
  assert.ok(
    sentTexts.includes('终稿正文'),
    '补位 finalize 发送失败（failed）后，final 应经默认路径整段补发而非被早退 return 吞掉',
  );
});

await test('评审2: 纯空白 partial 不算内容 → final 走默认路径送达', async () => {
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async () => {},
  });
  await captured.replyOptions?.onPartialReply?.({ text: '   \n  ' });
  await captured.dispatcherOptions?.deliver?.({ text: '终稿' }, { kind: 'final' });
  assert.deepStrictEqual(
    sentTexts,
    ['终稿'],
    '空白 partial 不置 hasStarted/不计数，final 经默认路径整段送达（不吞稿、不发空白）',
  );
});

await test('controller: 纯空白 partial 不置 hasStarted、不进缓冲', async () => {
  const ctrl = makeController({ sendMode: 'static' });
  await ctrl.onPartialReply('   ');
  assert.strictEqual(ctrl.hasStarted, false, '空白 partial 不算流式启动');
  await ctrl.finalize();
  assert.strictEqual(ctrl.parked, true, '仍按无内容 park');
  assert.strictEqual(staticSendCalls.length, 0, '不发送空白');
});

await test('评审3: 已中止 turn 的迟到 partial/final 不再发出任何内容', async () => {
  const abortCtl = new AbortController();
  abortCtl.abort();
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    ctxSignal: abortCtl.signal,
    simulate: async () => {},
  });
  await captured.replyOptions?.onPartialReply?.({ text: '迟到内容' });
  await captured.replyOptions?.onToolStart?.();
  await captured.dispatcherOptions?.deliver?.({ text: '终稿' }, { kind: 'final' });
  // 迟到 partial 被信号守卫拦下（评审关注点：park 不复活已取消 turn 的输出）；
  // final 文本经默认路径送达是既有语义（默认路径不按 signal 门控），不在本修复面
  assert.ok(!sentTexts.includes('迟到内容'), '已取消 turn 的迟到 partial 不得承接/发出');
  assert.deepStrictEqual(sentTexts, ['终稿'], 'final 走默认路径（既有行为，非信号门控面）');
});

await test('评审4: parked 流式早退前转发 final 携带的媒体', async () => {
  const { sentTexts, sentMedia, captured } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async () => {},
  });
  await captured.replyOptions?.onPartialReply?.({ text: '见附图' });
  await captured.dispatcherOptions?.deliver?.(
    { text: '见附图', mediaUrls: ['https://example.com/img.png'] },
    { kind: 'final' },
  );
  assert.ok(sentTexts.includes('见附图'), '终稿正文经补位 finalize 送达');
  assert.ok(
    sentMedia.some((m) => m.includes('img.png')),
    'final 携带的媒体应在流式早退 return 前转发（默认路径此时不可达）',
  );
});

await test('评审5: stream parked + 段已封口 → final 尾巴直接补发', async () => {
  const { sentTexts, captured } = await runDispatch({
    streaming: { mode: 'partial' }, // stream 模式（默认）
    simulate: async () => {},
  });
  await captured.replyOptions?.onPartialReply?.({ text: '段A' });
  await captured.dispatcherOptions?.deliver?.({ text: '段A' }, { kind: 'tool' }); // closeSegment 封口，会话关闭
  await captured.dispatcherOptions?.deliver?.({ text: '段A\nUsage: 66k in / 9.8k out' }, { kind: 'final' });
  assert.ok(
    sentTexts.some((t) => t.includes('Usage:')),
    '段已封口无会话时 absorb 接不住 extension，usage footer 尾巴应在 park 场景直接补发（dispatch 末尾兜底已跑过）',
  );
});

await test('controller: stream 终态后 closeSegment 丢弃段文本 → WARN（评审意见 7）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('段A');
  await ctrl.abort('test'); // failed 终态（session 已 complete，currentSegmentText 残留）
  logs.length = 0;
  await ctrl.closeSegment('late');
  assert.strictEqual(warnCount('segment close dropped'), 1, '终态封口丢弃段文本应告警（issue #80 四入口可观测）');
  assert.ok(logs.some((l) => l.includes('chars=2')), 'WARN 应附丢弃字符数');
});

await test('回归锚点：dispatch 存活期间的正常 static 多段流行为不变', async () => {
  const { sentTexts } = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '段A' });
      await c.dispatcherOptions?.deliver?.({ text: '段A' }, { kind: 'tool' });   // flush 段A
      await c.replyOptions?.onPartialReply?.({ text: '段B' });
      await c.dispatcherOptions?.deliver?.({ text: '段B' }, { kind: 'final' });  // absorb + dispatch 末尾 finalize
    },
  });
  assert.deepStrictEqual(sentTexts, ['段A', '段B'], '正常流：段A 工具边界即时发，段B 兜底 finalize 发');
});

// ============ 结果 ============

console.log(`\n========================================`);
console.log(`  总计: ${passed + failed} | ✓ 通过: ${passed} | ✗ 失败: ${failed}`);
if (failedTests.length > 0) {
  console.log(`  失败用例:`);
  for (const t of failedTests) console.log(`    - ${t}`);
}
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
