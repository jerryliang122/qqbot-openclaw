/**
 * /usage tokens|full footer 流式补发回归测试
 *
 * 背景（2026-10-07 用户反馈）：框架支持 /usage off|tokens|full，在模型输出
 * 完成后把 "Usage: X in / Y out · cache … " 行追加到 final payload 文本尾部
 * （框架 agent-runner 的 appendUsageLine）。非流式路径整段发送 final 文本，
 * footer 天然带上；但 c2c 开启流式后 dispatch 的流式分支把 final payload
 * 直接丢弃（假定内容已由流式发过），而 onPartialReply 增量产生于追加之前，
 * 永远不含 footer → QQ 侧看不到 usage 行（telegram 用 final 文本整体收尾，
 * 所以正常显示）。
 *
 * 修复：流式 turn 暂存 final 文本，收尾（finalize）后按前缀差量补发
 * 「未流出尾巴」（StreamingController.computeUnsentRemainder）。
 *
 * 运行方式: npx tsx tests/stream-usage-footer.test.ts
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

// ── 真实模块 ──

const { StreamingController } = await import('../src/outbound/streaming-controller.ts');
const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

const FOOTER = 'Usage: 66k in / 9.8k out · cache 894k cached / 0 new';

// ============ Part 1: StreamingController.computeUnsentRemainder 单元 ============

function makeController(opts: { sendMode?: 'stream' | 'static'; sendStatic?: (t: string) => Promise<void> }) {
  return new StreamingController({
    gateway: {
      openStream: () => ({
        update: async () => {},
        complete: async () => ({ id: 's', timestamp: Date.now() }),
      }),
    } as any,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: opts.sendMode,
    sendStatic: opts.sendStatic ?? (async () => {}),
  });
}

group('Part 1: computeUnsentRemainder（控制器单元）');

await test('stream: final 为已流出段落的扩展 → 返回 footer 增量', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('这是回答');
  await ctrl.onPartialReply('这是回答全文');
  await ctrl.finalize();
  assert.strictEqual(
    ctrl.computeUnsentRemainder(`这是回答全文\n${FOOTER}`),
    `\n${FOOTER}`,
  );
});

await test('stream: final 与已流出一致 → 空串（纯去重）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('回答');
  await ctrl.finalize();
  assert.strictEqual(ctrl.computeUnsentRemainder('回答'), '');
});

await test('stream: 多段 turn（final 拼接全部段落）→ 定位最后一段之后的增量', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  // 段A 流出后，段B 更短且前缀不匹配 → new_reply 轮转
  await ctrl.onPartialReply('第一段较长的开头文本');
  await ctrl.onPartialReply('第二段结论');
  await ctrl.finalize();
  const finalText = `第一段较长的开头文本\n\n第二段结论\n${FOOTER}`;
  assert.strictEqual(
    ctrl.computeUnsentRemainder(finalText),
    `\n${FOOTER}`,
  );
});

await test('stream: final 完全不含已流出段落（模型重写）→ 空串（维持丢弃）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('原始回答');
  await ctrl.finalize();
  assert.strictEqual(ctrl.computeUnsentRemainder(`完全不同的回答\n${FOOTER}`), '');
});

await test('stream: 未经流式（无基准）→ 空串', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  assert.strictEqual(ctrl.computeUnsentRemainder(`回答\n${FOOTER}`), '');
});

await test('stream: 空白差异容忍（归一化前缀匹配）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('回答  结尾带空格 ');
  await ctrl.finalize();
  // final 首尾被 trim，空白分布不同
  const remainder = ctrl.computeUnsentRemainder(`回答 结尾带空格\n${FOOTER}`);
  assert.ok(remainder.includes(FOOTER), `remainder 应包含 footer，实际: ${JSON.stringify(remainder)}`);
});

await test('static: flushSegment + finalize 后仍可计算差量', async () => {
  const sentStatic: string[] = [];
  const ctrl = makeController({ sendMode: 'static', sendStatic: async (t) => { sentStatic.push(t); } });
  await ctrl.onPartialReply('段A文本');
  await ctrl.flushSegment();
  await ctrl.onPartialReply('段B文本');
  await ctrl.finalize();
  assert.deepStrictEqual(sentStatic, ['段A文本', '段B文本']);
  // final 只含最后一段 + footer（另一常见组装形态）
  assert.strictEqual(ctrl.computeUnsentRemainder(`段B文本\n${FOOTER}`), `\n${FOOTER}`);
});

// ============ Part 2: dispatch 层（真实 dispatchToOpenClaw） ============

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

function makeMsgAndCtx() {
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
  return { msg, ctx: { state: {}, message: { content: 'hello' }, signal: undefined } as any };
}

function installFakeGateway() {
  const sentTexts: string[] = [];
  const streamUpdates: string[] = [];
  // 注意：complete 次数用数组记录（原始类型 number 在闭包内自增不会
  // 反映到返回对象的属性快照上）
  const streamCompletes: number[] = [];
  const gw = {
    sendText: async (_target: any, text: string) => {
      sentTexts.push(text);
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
    openStream: () => ({
      update: async (text: string) => { streamUpdates.push(text); },
      complete: async () => { streamCompletes.push(Date.now()); return { id: 'stream-done', timestamp: Date.now() }; },
    }),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts, streamUpdates, streamCompletes };
}

/**
 * 跑一次完整 dispatchToOpenClaw：
 * simulate 拿到框架侧 replyOptions/dispatcherOptions，模拟框架行为
 * （onPartialReply 流式增量 → deliver final payload）
 */
async function runDispatch(opts: {
  streaming: false | { mode: string; sendMode?: 'static' };
  simulate: (captured: CapturedDispatch) => Promise<void>;
}) {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();
  let captured: CapturedDispatch = {};

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
    },
  });
  // dispatchReply 经 params.__dispatch 分发（见 makeFakeRuntime）
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

  const gw = installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  return gw;
}

group('Part 2: dispatch 层（真实 dispatchToOpenClaw）');

await test('stream 模式: final 含 footer → 流式发正文 + 补发 footer 独立消息', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答' });
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(gw.streamCompletes.length, 1, '流式会话应收尾一次');
  assert.ok(gw.streamUpdates.length >= 1, '应有流式 update');
  assert.deepStrictEqual(
    gw.sentTexts,
    [FOOTER],
    `sendText 应仅补发 footer 一条，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: 多段 turn → 正文两段流式 + footer 补发', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '第一段较长的开头' });
      await c.replyOptions?.onPartialReply?.({ text: '第二段结论' }); // 更短 → new_reply 轮转
      await c.dispatcherOptions?.deliver?.(
        { text: `第一段较长的开头\n\n第二段结论\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.deepStrictEqual(
    gw.sentTexts,
    [FOOTER],
    `只应补发 footer，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: final 与流出内容一致 → 不补发（无重复）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '回答' });
      await c.dispatcherOptions?.deliver?.({ text: '回答' }, { kind: 'final' });
    },
  });
  assert.deepStrictEqual(gw.sentTexts, [], 'final 完全被流式覆盖时不应补发');
});

await test('static 模式: 最后一段整段发出后补发 footer（顺序正确）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream', sendMode: 'static' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答' });
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.deepStrictEqual(
    gw.sentTexts,
    ['这是回答全文', FOOTER],
    `应先整段发正文、再补发 footer，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('非流式: final 文本（含 footer）原样单条发送（回归保护）', async () => {
  const gw = await runDispatch({
    streaming: false,
    simulate: async (c) => {
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.deepStrictEqual(
    gw.sentTexts,
    [`这是回答全文\n${FOOTER}`],
    `非流式应整条原样发送（含 footer），实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

// ============ 汇总 ============

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
