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
const { registerGateway, unregisterGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');
const {
  registerMsgIdWindow,
  checkAndConsumePassiveReplyQuota,
  clearQuotaCache,
} = await import('../src/features/quota-manager.ts');

const FOOTER = 'Usage: 66k in / 9.8k out · cache 894k cached / 0 new';

/** issue #44 场景：末段 600+ 字符总结正文（框架未送 partial，只有 final payload） */
const FINAL_BODY = `${'最终总结正文。'.repeat(90)}\nEND`;

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
  // 段A 流出后，段B 与之无公共前缀 → 判为新段 → 另起一条消息（原样送达）
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

await test('stream: 空白差异容忍（归一化前缀匹配取原始偏移切片）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  // 流式文本中间双空格，final 文本单空格——tail.length 与匹配前缀的原始
  // 长度不一致，必须按原始偏移切片（否则会截掉 footer 首字符）
  await ctrl.onPartialReply('回答  继续');
  await ctrl.finalize();
  const remainder = ctrl.computeUnsentRemainder(`回答 继续\n${FOOTER}`);
  assert.ok(
    remainder.includes(FOOTER),
    `remainder 应包含完整 footer，实际: ${JSON.stringify(remainder)}`,
  );
  assert.ok(
    remainder.startsWith('\nUsage:'),
    `切片应从匹配前缀的原始结束位置开始，实际: ${JSON.stringify(remainder)}`,
  );
});

await test('stream: 旧段内嵌在重写文本中间（非行首边界）→ 空串（不误发）', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('旧段结论');
  await ctrl.finalize();
  // 模型重写：旧段片段出现在行内（前一字符非换行），之后还有大段新文本——
  // 不能把该位置之后的内容当增量发出
  const rewritten = `新回答里内嵌 旧段结论 之后还有一大段没流出过的重写内容\n${FOOTER}`;
  assert.strictEqual(ctrl.computeUnsentRemainder(rewritten), '', '内嵌匹配不应视为增量');
});

await test('stream: 旧段在行首边界命中（多段拼接形态）→ 正常切出 footer', async () => {
  const ctrl = makeController({ sendMode: 'stream' });
  await ctrl.onPartialReply('旧段结论');
  await ctrl.finalize();
  const composed = `前文段落\n旧段结论\n${FOOTER}`;
  assert.strictEqual(
    ctrl.computeUnsentRemainder(composed),
    `\n${FOOTER}`,
    '行首边界命中的多段拼接应正常切出 footer',
  );
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

await test('absorb: stream 模式尾巴并入当前会话（前缀增长），finalize 一次收尾', async () => {
  const updates: string[] = [];
  const ctrl = new StreamingController({
    gateway: { openStream: () => ({ update: async (t: string) => { updates.push(t); }, complete: async () => ({ id: 's', timestamp: 0 }) }) } as any,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: 'stream',
  });
  await ctrl.onPartialReply('回答全文');
  await ctrl.absorbFinalText(`回答全文\n${FOOTER}`);
  await ctrl.finalize();
  assert.deepStrictEqual(updates, ['回答全文', `回答全文\n${FOOTER}`], 'footer 应作为前缀增长推入同一条流');
  assert.strictEqual(ctrl.currentPhase, 'done');
  // 基准已推进——上层差量兜底不会再重复补发
  assert.strictEqual(ctrl.computeUnsentRemainder(`回答全文\n${FOOTER}`), '');
});

await test('absorb: 回调入队后、执行前 signal 中止 → 不吸收（TOCTOU 重查）', async () => {
  const updates: string[] = [];
  const ctrl = new StreamingController({
    gateway: { openStream: () => ({ update: async (t: string) => { updates.push(t); }, complete: async () => ({ id: 's', timestamp: 0 }) }) } as any,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: 'stream',
  });
  await ctrl.onPartialReply('回答全文');
  const ac = new AbortController();
  // absorb 回调入队后、chain 消费前中止（dispatch 侧守卫已放行的竞态窗口）
  const pending = ctrl.absorbFinalText(`回答全文\n${FOOTER}`, { signal: ac.signal });
  ac.abort();
  await pending;
  await ctrl.finalize();
  assert.deepStrictEqual(
    updates,
    ['回答全文'],
    `已取消的回复不应吸收 footer，实际: ${JSON.stringify(updates)}`,
  );
  assert.strictEqual(ctrl.currentPhase, 'done');
});

await test('absorb: 流式段落带尾随空白 → 合并边界去重（无双空行）', async () => {
  const updates: string[] = [];
  const ctrl = new StreamingController({
    gateway: { openStream: () => ({ update: async (t: string) => { updates.push(t); }, complete: async () => ({ id: 's', timestamp: 0 }) }) } as any,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: 'stream',
  });
  // provider 末帧带尾随换行；final 文本已 trim、分隔符为单个 \n
  await ctrl.onPartialReply('回答全文\n');
  await ctrl.absorbFinalText(`回答全文\n${FOOTER}`);
  await ctrl.finalize();
  assert.strictEqual(
    updates[updates.length - 1],
    `回答全文\n${FOOTER}`,
    `合并边界应去重空白（不得出现双空行），实际: ${JSON.stringify(updates[updates.length - 1])}`,
  );
});

await test('absorb: static 缓冲带尾随空白 → 合并后一条消息无双空行', async () => {
  const sentStatic: string[] = [];
  const ctrl = makeController({ sendMode: 'static', sendStatic: async (t) => { sentStatic.push(t); } });
  await ctrl.onPartialReply('段文本\n\n');
  await ctrl.absorbFinalText(`段文本\n${FOOTER}`);
  await ctrl.finalize();
  assert.deepStrictEqual(
    sentStatic,
    [`段文本\n${FOOTER}`],
    `static 合并应与 final 文本边界一致，实际: ${JSON.stringify(sentStatic)}`,
  );
});

await test('absorb: static 缓冲已 flush 后尾巴独占缓冲（退化为单独一条，无前导空行）', async () => {
  const sentStatic: string[] = [];
  const ctrl = makeController({ sendMode: 'static', sendStatic: async (t) => { sentStatic.push(t); } });
  await ctrl.onPartialReply('段A文本');
  await ctrl.flushSegment();
  await ctrl.absorbFinalText(`段A文本\n${FOOTER}`);
  await ctrl.finalize();
  assert.strictEqual(sentStatic.length, 2);
  assert.strictEqual(sentStatic[0], '段A文本');
  assert.strictEqual(sentStatic[1], FOOTER, `第二条应为 footer 本体（无前导空行），实际: ${JSON.stringify(sentStatic[1])}`);
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

function installFakeGateway(opts: { failSendText?: boolean; failSecondUpdate?: 'definitive' | 'ambiguous' } = {}) {
  const sentTexts: string[] = [];
  /** 每次发送实际带的 msgId：有值=被动回复（锚定），undefined=降级主动 */
  const sentMsgIds: Array<string | undefined> = [];
  const streamUpdates: string[] = [];
  // 注意：complete 次数用数组记录（原始类型 number 在闭包内自增不会
  // 反映到返回对象的属性快照上）
  const streamCompletes: number[] = [];
  const gw = {
    sendText: async (_target: any, text: string, sendOpts: any) => {
      sentTexts.push(text);
      sentMsgIds.push(sendOpts?.msgId);
      if (opts.failSendText) throw new Error('QQ API unavailable');
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
    openStream: () => ({
      update: async (text: string) => {
        streamUpdates.push(text);
        if (opts.failSecondUpdate && streamUpdates.length >= 2) {
          if (opts.failSecondUpdate === 'definitive') {
            // 平台明确拒绝（SDK ApiError 形态：httpStatus > 0）——update 确定未应用
            throw Object.assign(new Error('API Error: content too long'), { httpStatus: 400, name: 'ApiError' });
          }
          // 网络层失败（httpStatus === 0 / 非结构化）——结果不明，可能已应用
          throw new Error('Network error [stream/update]: fetch timeout');
        }
      },
      complete: async () => { streamCompletes.push(Date.now()); return { id: 'stream-done', timestamp: Date.now() }; },
    }),
  } as any;
  registerGateway('test-account', gw);
  // 一并返回 gateway 本身：runDispatch 的「单账号回退」场景需要把它注册到
  // 另一个账号键下（此前误把本容器注册进去，导致 resolved.gw.sendText 不存在）。
  return { sentTexts, sentMsgIds, streamUpdates, streamCompletes, gateway: gw };
}

/**
 * 跑一次完整 dispatchToOpenClaw：
 * simulate 拿到框架侧 replyOptions/dispatcherOptions，模拟框架行为
 * （onPartialReply 流式增量 → deliver final payload）
 */
async function runDispatch(opts: {
  streaming: false | { mode: string; sendMode?: 'static' };
  simulate: (captured: CapturedDispatch) => Promise<void>;
  /** 自定义请求级 signal（模拟用户取消 / SDK 超时中止） */
  requestSignal?: AbortSignal;
  /** 固定入站 msg_id（默认随机）——配额相关用例需要预先占用同一锚点的额度 */
  msgId?: string;
  /**
   * 网关注册在哪个账号键下（默认与配置账号同为 'test-account'）。
   * 指定别的键可复现**单账号回退**场景：配置账号没网、只有一个别的账号在跑，
   * 此时配额记账键 = 回退到的账号键（见 resolveGatewayForSend）。
   */
  gatewayAccountId?: string;
  /** gateway.sendText 失败策略：true = 每次都抛错 */
  failSendText?: boolean;
  /** 流式 update 失败策略：'definitive' = 平台明确拒绝；'ambiguous' = 网络层结果不明 */
  failSecondUpdate?: 'definitive' | 'ambiguous';
}) {
  _resetAdaptersCache();
  const msg = {
    kind: 'c2c',
    messageId: opts.msgId ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
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
    signal: opts.requestSignal,
  } as any;
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

  const gw = installFakeGateway({ failSendText: opts.failSendText, failSecondUpdate: opts.failSecondUpdate });
  if (opts.gatewayAccountId) {
    // 复现**单账号回退**场景：配置账号没网、只有另一个账号在跑。
    // 配额记账键 = 回退到的账号键（resolveGatewayForSend），探测必须同键。
    unregisterGateway('test-account');
    registerGateway(opts.gatewayAccountId, gw.gateway);
  }
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  return gw;
}

group('Part 2: dispatch 层（真实 dispatchToOpenClaw）');

await test('stream 模式: final 含 footer → 尾巴并入流式会话，同一条消息收尾', async () => {
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
  const lastUpdate = gw.streamUpdates[gw.streamUpdates.length - 1];
  assert.strictEqual(
    lastUpdate,
    `这是回答全文\n${FOOTER}`,
    `最后一次 update 应为正文+footer 全文（同一条消息），实际: ${JSON.stringify(lastUpdate)}`,
  );
  assert.deepStrictEqual(
    gw.sentTexts,
    [],
    `footer 已并入流式消息，不应再单独补发，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: 多段 turn → footer 并入最后一段的流式会话', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '第一段较长的开头' });
      await c.replyOptions?.onPartialReply?.({ text: '第二段结论' }); // 新段 → 另起一条消息
      await c.dispatcherOptions?.deliver?.(
        { text: `第一段较长的开头\n\n第二段结论\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  const lastUpdate = gw.streamUpdates[gw.streamUpdates.length - 1];
  assert.strictEqual(
    lastUpdate,
    `第二段结论\n${FOOTER}`,
    `footer 应并入最后一段的流式消息，实际: ${JSON.stringify(lastUpdate)}`,
  );
  assert.deepStrictEqual(gw.sentTexts, [], '不应单独补发');
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

await test('stream 模式: tool payload 封口当前段后到达的 final → 兜底单独补发 footer', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      // verbose 开启时框架会投递 tool payload = 段边界 → 当前段收尾（会话关闭），
      // 之后到达的 final 无法再并入 → 走 [stream-final] 兜底单独补发。
      // 注意：段收尾**不**终止整轮（issue #67：旧实现在此 finalize，工具后的
      // 整段正文被静默丢弃）。
      await c.dispatcherOptions?.deliver?.({ text: '' }, { kind: 'tool' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.deepStrictEqual(
    gw.sentTexts,
    [FOOTER],
    `终态后无法并入，应兜底单独补发 footer，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial 模式: footer 随 final 整条发出（不经插件差量补发）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
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
    [`这是回答全文\n${FOOTER}`],
    `正文与 footer 应合成一条消息，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial 模式: 正文发送失败 → 不额外补发 footer（插件侧无补发机制）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    failSendText: true,
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(
    gw.sentTexts[0],
    `这是回答全文\n${FOOTER}`,
    '失败的是整条 final 发送',
  );
  assert.ok(
    gw.sentTexts[1]?.includes('Something went wrong'),
    `正文未送达时应发失败兜底文案（对齐非流式路径），实际: ${JSON.stringify(gw.sentTexts)}`,
  );
  assert.ok(
    !gw.sentTexts.slice(1).some((t) => t.includes('Usage:')),
    `正文失败后不应再单独发 footer，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: 请求级 signal 在 final 暂存后中止 → 不补发 footer', async () => {
  const requestAbort = new AbortController();
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    requestSignal: requestAbort.signal,
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
      // final 已暂存、流式已收尾之后，请求被取消（turnAbort 未触发）——
      // 补发 guard 必须看合并信号，不能只看 turnAbort
      requestAbort.abort();
    },
  });
  assert.strictEqual(gw.streamCompletes.length, 1, '流式会话正常收尾');
  assert.deepStrictEqual(
    gw.sentTexts,
    [],
    `已取消的 turn 不应补发 footer，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: 请求级 signal 在 final 投递前中止 → 不吸收、流不增长', async () => {
  const requestAbort = new AbortController();
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    requestSignal: requestAbort.signal,
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      // 合并 signal 先中止，框架仍投递非错误 final（竞态）——已取消的
      // 回复不得继续增长：absorb 跳过，footer 不进流
      requestAbort.abort();
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(gw.streamCompletes.length, 1, '会话仍应收尾（关闭挂起流）');
  const lastUpdate = gw.streamUpdates[gw.streamUpdates.length - 1];
  assert.strictEqual(
    lastUpdate,
    '这是回答全文',
    `已取消的 turn 流内容不应增长（不吸收 footer），实际: ${JSON.stringify(lastUpdate)}`,
  );
  assert.deepStrictEqual(
    gw.sentTexts,
    [],
    `不应兜底补发，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: footer 吸收 update 被平台明确拒绝 → 流照常收尾 + 兜底补发 footer', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    failSecondUpdate: 'definitive',
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(gw.streamUpdates.length, 2, '正文首帧 + footer 合并推送各一次');
  assert.strictEqual(
    gw.streamCompletes.length,
    1,
    `已接受正文的流必须补发 DONE 收尾（防用户端悬挂），实际完成 ${gw.streamCompletes.length} 次`,
  );
  assert.deepStrictEqual(
    gw.sentTexts,
    [FOOTER],
    `明确拒绝（httpStatus>0）= footer 确定未进流 → 兜底补发，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('stream 模式: footer 吸收 update 网络层失败（结果不明）→ 流照常收尾、不兜底（防重复）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    failSecondUpdate: 'ambiguous',
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '这是回答全文' });
      await c.dispatcherOptions?.deliver?.(
        { text: `这是回答全文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(
    gw.streamCompletes.length,
    1,
    `结果不明也必须收尾已接受的流，实际完成 ${gw.streamCompletes.length} 次`,
  );
  assert.deepStrictEqual(
    gw.sentTexts,
    [],
    `结果不明（httpStatus=0，footer 可能已在流中）→ 抑制兜底防重复，实际: ${JSON.stringify(gw.sentTexts)}`,
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

await test('shouldSuppressFinalTailFallback 判定矩阵：仅「正文确定未送达」才抑制', async () => {
  // static 失败（sendStatic 抛错）→ 正文未投递 → 抑制
  const staticFail = makeController({
    sendMode: 'static',
    sendStatic: async () => { throw new Error('send error'); },
  });
  await staticFail.onPartialReply('正文');
  await staticFail.finalize();
  assert.strictEqual(staticFail.currentPhase, 'failed');
  assert.strictEqual(staticFail.shouldSuppressFinalTailFallback, true, 'static 失败应抑制');

  // stream 失败但已有分片被接受（如 footer update 被拒）→ 正文可见 → 不抑制
  const streamWithChunks = new StreamingController({
    gateway: {
      openStream: () => ({
        update: async (_t: string) => { throw new Error('update rejected'); },
        complete: async () => ({ id: 's', timestamp: 0 }),
      }),
    } as any,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: 'stream',
  });
  // 先用一个成功的控制器推正文？构造更直接：update 永远失败 → 0 分片 → 抑制
  await streamWithChunks.onPartialReply('正文');
  assert.strictEqual(streamWithChunks.currentPhase, 'failed');
  assert.strictEqual(streamWithChunks.shouldSuppressFinalTailFallback, true, 'stream 无已接受分片应抑制');

  // stream 失败且正文已被接受 → 不抑制（本用例经 dispatch 层 failSecondUpdate 覆盖，
  // 这里直接构造：成功推正文后手动 abort（failed）模拟吸收后失败）
  const streamAfterAccept = makeController({ sendMode: 'stream' });
  await streamAfterAccept.onPartialReply('正文');
  await streamAfterAccept.abort('update_error');
  assert.strictEqual(streamAfterAccept.currentPhase, 'failed');
  assert.strictEqual(streamAfterAccept.shouldSuppressFinalTailFallback, false, 'stream 正文已可见后失败不应抑制');

  // stream update 失败按错误形态分类（正文已被接受后失败）：明确拒绝
  // （httpStatus>0）→ 不抑制；网络层结果不明（httpStatus=0）→ 抑制
  // （footer 可能已在流中）。注：首帧即失败 = 正文未送达，无论形态都抑制。
  const mkFailingAfterAccept = (err: unknown) => {
    let calls = 0;
    return new StreamingController({
      gateway: {
        openStream: () => ({
          update: async () => { if (++calls > 1) throw err; },
          complete: async () => ({ id: 's', timestamp: 0 }),
        }),
      } as any,
      target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
      accountId: 'test',
      replyToId: 'm1',
      sendMode: 'stream',
    });
  };
  const definitive = mkFailingAfterAccept(Object.assign(new Error('API Error'), { httpStatus: 400, name: 'ApiError' }));
  await definitive.onPartialReply('正');
  await definitive.onPartialReply('正文'); // 第二帧 update 被平台明确拒绝
  assert.strictEqual(definitive.currentPhase, 'failed');
  assert.strictEqual(definitive.shouldSuppressFinalTailFallback, false, '正文已接受后明确拒绝（httpStatus>0）不应抑制');

  const ambiguous = mkFailingAfterAccept(Object.assign(new Error('Network error'), { httpStatus: 0, name: 'ApiError' }));
  await ambiguous.onPartialReply('正');
  await ambiguous.onPartialReply('正文'); // 第二帧 update 网络层失败
  assert.strictEqual(ambiguous.currentPhase, 'failed');
  assert.strictEqual(ambiguous.shouldSuppressFinalTailFallback, true, '正文已接受后结果不明（httpStatus=0）应抑制');

  // 正常 done → 不抑制
  const done = makeController({ sendMode: 'stream' });
  await done.onPartialReply('正文');
  await done.finalize();
  assert.strictEqual(done.shouldSuppressFinalTailFallback, false, 'done 不抑制');
});

// ============ Part 3: partial 态（框架块流式）—— final 正文与中间块 ============

group('Part 3: partial 态（框架块流式）中间块与 final');

await test('partial: final 正文整条送达（不经插件差量补发）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      // partial 态插件不注册 onPartialReply / onToolStart（无自研控制器）：
      // 中间消息由框架块流式产出，final 直接走默认投递路径整条发出。
      await c.dispatcherOptions?.deliver?.({ text: FINAL_BODY }, { kind: 'final' });
    },
  });
  assert.strictEqual(gw.sentTexts.length, 1, `final 应整条发出，实际 ${gw.sentTexts.length} 条`);
  assert.strictEqual(
    gw.sentTexts[0],
    FINAL_BODY,
    `最终正文应完整送达，实际长度 ${gw.sentTexts[0]?.length}`,
  );
  assert.ok(gw.sentTexts[0]!.length >= 600, '最终正文应完整无截断');
});

await test('partial: 块文本（kind:block）作为中间消息发出，final 再整条发', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      await c.dispatcherOptions?.deliver?.({ text: '块一' }, { kind: 'block' });
      await c.dispatcherOptions?.deliver?.(
        { text: `最终正文\n${FOOTER}` },
        { kind: 'final' },
      );
    },
  });
  assert.strictEqual(
    gw.sentTexts.length,
    2,
    `块 + final 两条，不应有第三条，实际: ${JSON.stringify(gw.sentTexts.map((t) => t.length))}`,
  );
  assert.strictEqual(gw.sentTexts[0], '块一', '块文本应作为中间消息发出');
  assert.strictEqual(gw.sentTexts[1], `最终正文\n${FOOTER}`, 'final 应整条发出并带 footer');
});

await test('partial: 工具调用前置说明作为独立消息发出（判据=工具调用事件）', async () => {
  // 框架的块流式只在 assistant 消息「完成时」产块；带工具调用的消息不是
  // completed reply，其文本走 onAssistantText → onPartialReply。partial 态
  // 收集该文本，等 deliver(kind:'tool') 到达（工具真的被调用）时发出。
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '我先调用 session_status 看看' });
      // 工具调用事件到达 → 前置说明应作为独立消息发出
      await c.dispatcherOptions?.deliver?.({ text: '工具结果' }, { kind: 'tool' });
    },
  });
  assert.ok(
    gw.sentTexts.includes('我先调用 session_status 看看'),
    `前置说明应作为独立消息发出，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial: 最终答案的 partial 文本不单独发（由框架块/最终回复承载）', async () => {
  // 收集但不发送：最终答案会作为框架块到达，partial 文本再发一遍就是双投。
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '最终答案正文' });
      // 没有工具调用 → 不触发前置说明 flush
    },
  });
  assert.ok(
    !gw.sentTexts.includes('最终答案正文'),
    `最终答案的 partial 文本不应单独发（会与框架块双投），实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial: 前置说明与框架块不双投（同一文本只发一次）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      // 模型把前置说明与工具调用拆成两条 assistant 消息 → 前置说明已作为块到达
      await c.dispatcherOptions?.deliver?.({ text: '前置说明' }, { kind: 'block' });
      await c.replyOptions?.onPartialReply?.({ text: '前置说明' });
      await c.dispatcherOptions?.deliver?.({ text: '工具结果' }, { kind: 'tool' });
    },
  });
  assert.strictEqual(
    gw.sentTexts.filter((t) => t === '前置说明').length,
    1,
    `同一文本只能发一次，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial: 块文本不重复发（kind:block 分支收口，不落默认路径）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      await c.dispatcherOptions?.deliver?.({ text: '块一' }, { kind: 'block' });
    },
  });
  assert.strictEqual(
    gw.sentTexts.filter((t) => t === '块一').length,
    1,
    `块文本必须且只能出现一次，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

await test('partial: 被动配额耗尽 → 块降级为主动发送（内容必达，绝不丢块）', async () => {
  const msgId = 'msg-quota-exhausted';
  // 预占该 msg_id 的全部被动配额（c2c 4 条）
  registerMsgIdWindow({ accountId: 'test-account', msgId, scope: 'c2c' });
  for (let i = 0; i < 4; i++) {
    checkAndConsumePassiveReplyQuota({ accountId: 'test-account', msgId, scope: 'c2c' });
  }
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    msgId,
    simulate: async (c) => {
      // 块承载的是正文，**绝不能丢**：丢掉承载全文的终态块，携带全文的 final
      // 会被一并丢弃（静默丢 → 记 delivered → hasSentPayload 丢 final；
      // 抛错 → 记 failed-deliver → 仍有投递托管权 → final 被 retry-block 丢）。
      // 两条路实测都导致用户完全收不到回复 → 正确做法是降级为主动发送。
      await c.dispatcherOptions?.deliver?.({ text: '块一' }, { kind: 'block' });
    },
  });
  assert.strictEqual(
    gw.sentTexts.filter((t) => t === '块一').length,
    1,
    `配额耗尽时块必须仍然发出（降级主动），内容不能丢，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
  assert.strictEqual(
    gw.sentMsgIds[0],
    undefined,
    '配额耗尽时该条应降级为主动发送（不带 msg_id）',
  );
  clearQuotaCache();
});

await test('partial: 块发送确定性失败（网关未注册）→ 上报未送达，final 不被丢', async () => {
  // 「确定未投递」必须用框架的带类型错误上报（PlatformMessageNotDispatchedError，
  // retryable:true）→ 框架记 'failed-before-deliver'（无投递托管权）→
  // 携带全文的 final 不会被丢弃 → 正文必达。
  // 若静默返回：框架记 'delivered' → hasSentPayload 丢 final → 正文永久丢失。
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    simulate: async (c) => {
      unregisterGateway('test-account');
      await assert.rejects(
        () => c.dispatcherOptions?.deliver?.({ text: '块一' }, { kind: 'block' }) as Promise<void>,
        (err: any) => err?.code === 'OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED',
        '确定性未投递必须抛 PlatformMessageNotDispatchedError（否则框架记 delivered → final 被丢）',
      );
    },
  });
  assert.strictEqual(gw.sentTexts.length, 0, '网关未注册时不该有任何发送');
  registerGateway('test-account', gw.gateway);
});

await test('partial: 配额探测用回退后的账号键（单账号回退场景）', async () => {
  const msgId = 'msg-quota-fallback-key';
  // 网关在 'gw-account'，配置账号 'test-account' 没网 → 单账号回退。
  // 配额记账发生在 'gw-account' 名下 → 探测必须同键，否则探测乐观、
  // 会白白降级主动（多烧每日主动预算）。
  registerMsgIdWindow({ accountId: 'gw-account', msgId, scope: 'c2c' });
  for (let i = 0; i < 3; i++) {
    checkAndConsumePassiveReplyQuota({ accountId: 'gw-account', msgId, scope: 'c2c' });
  }
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    msgId,
    gatewayAccountId: 'gw-account',
    simulate: async (c) => {
      await c.dispatcherOptions?.deliver?.({ text: '块一' }, { kind: 'block' });
    },
  });
  assert.strictEqual(
    gw.sentTexts.filter((t) => t === '块一').length,
    1,
    `回退场景下块必须仍然发出，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
  assert.strictEqual(
    gw.sentMsgIds[0],
    msgId,
    '探测键与记账键一致 → 仍走被动回复（不多烧主动预算）',
  );
  clearQuotaCache();
});

await test('partial: 系统通知（isCompactionNotice）不受配额守卫丢弃', async () => {
  const msgId = 'msg-quota-system-notice';
  registerMsgIdWindow({ accountId: 'test-account', msgId, scope: 'c2c' });
  for (let i = 0; i < 4; i++) {
    checkAndConsumePassiveReplyQuota({ accountId: 'test-account', msgId, scope: 'c2c' });
  }
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    msgId,
    simulate: async (c) => {
      // 框架的上下文压缩 / 准入通知以 kind:'block' 投递（与 disableBlockStreaming
      // 无关、任何模式都可能出现），必须保证送达，不能被配额守卫吞掉。
      await c.dispatcherOptions?.deliver?.(
        { text: '上下文已压缩', isCompactionNotice: true },
        { kind: 'block' },
      );
    },
  });
  assert.ok(
    gw.sentTexts.includes('上下文已压缩'),
    `系统通知必须送达（可降级主动），实际: ${JSON.stringify(gw.sentTexts)}`,
  );
  clearQuotaCache();
});

await test('partial: 请求级 signal 中止 → 插件不自行补发（只有框架投递的那一条）', async () => {
  const requestAbort = new AbortController();
  const gw = await runDispatch({
    streaming: { mode: 'partial', sendMode: 'static' },
    requestSignal: requestAbort.signal,
    simulate: async (c) => {
      requestAbort.abort();
      await c.dispatcherOptions?.deliver?.({ text: FINAL_BODY }, { kind: 'final' });
    },
  });
  assert.strictEqual(
    gw.sentTexts.length,
    1,
    `插件侧不应额外补发，只应有框架投递的那一条，实际: ${JSON.stringify(gw.sentTexts.map((t) => t.length))}`,
  );
});

await test('stream: final 与流内内容无关 → 维持丢弃（不因 #44 修复而行为变化）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '原始回答' });
      await c.dispatcherOptions?.deliver?.({ text: '完全不同的最终回答' }, { kind: 'final' });
    },
  });
  assert.deepStrictEqual(
    gw.sentTexts,
    [],
    'stream 模式维持「重写即丢弃」，不补发（避免与流内已显示内容重复）',
  );
  assert.strictEqual(gw.streamCompletes.length, 1, '流照常收尾');
});

// ============ 汇总 ============

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
