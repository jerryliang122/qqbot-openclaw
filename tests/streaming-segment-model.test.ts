/**
 * 流式「段模型」回归测试（issue #67）
 *
 * 背景（2026-10-22 生产现场，bot2 账号 C2C）：
 *   同一轮回复在 QQ 端收到**两条**消息——第一条是两次尝试被「截断拼接」缝合
 *   出来的残段，第二条才是完整内容；两条消息的收尾帧与开流帧只相隔
 *   343ms / 386ms（用户观感 = 「同一条回复被重发了一遍」）。
 *
 *   现场 A（18:24）：同轮第二次模型调用，文本与第一段**无公共前缀**
 *     （common=0）→ 命中旧的 `prefix retry` 拼接支 → 缝合体 → 再命中
 *     `new reply` → complete 旧流 + openStream 新流 → 两条消息。
 *   现场 B（18:29）：provider 断流 + core 的 visible-answer fallback 重试，
 *     同轮整篇重发 → 同一条链路。
 *
 *   旧实现用**文本长度**猜「是不是新回复」，并把「前缀不匹配的新文本」
 *   截断后拼到已发文本后面 —— 这两处是全部症状的来源。
 *
 * 新契约：
 *   1. **一段 = 一条 QQ 流式消息**（中间文本各自独立，不合并）——本插件一直
 *      以来的形态，不得改成多段合并成一条；
 *   2. 每段内容**原样送达、互不重叠**——绝不跨段截断拼接；
 *   3. 段边界由框架 onAssistantMessageStart / 工具调用驱动（长度启发式废除），
 *      「新块不延续当前段」为兜底判定；
 *   4. 段结束 ≠ 整轮结束——工具调用后的正文不得被静默丢弃；
 *   5. 终稿必达——未在流内呈现的终稿必须补发，不得静默丢弃。
 *
 * 运行方式: npx tsx tests/streaming-segment-model.test.ts
 */
import assert from 'node:assert/strict';

// ── 真实模块 ──

const { StreamingController } = await import('../src/outbound/streaming-controller.ts');
const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

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

// ── 现场数据（issue #67）──

/** 现场 A 第 1 段：模型在工具调用前写的抬头（与第 2 段无公共前缀） */
const SEG_A1 = 'Please review your Q 值重出：目的港 **USD 50/BL**，O/F 回到表内 **USD 31/CBM**（45/BL 那版是 32）。';

/** 现场 A 第 2 段：工具返回后模型整篇重写的完整报价 */
const SEG_A2 = [
  'Please review your quotation. The freight rate is for reference only.',
  '',
  'POL: SHANGHAI',
  'POD: COLOMBO',
  'Term: EXW SHANGHAI',
  '',
  'below is EXW price :',
  '',
  '| Description      | Currency | Amount  | Unit          |',
  '|------------------|----------|---------|---------------|',
  '| LCL OF           | USD      | 31      | CBM           |',
].join('\n');

/** 现场 B 第 1 段：provider 断流时已下发的抬头 */
const SEG_B1 = 'Please review your Q 值重出：目的港 **USD 50/BL**，O/F 回到表内 **USD 31/CBM**（45/BL 那版是 32）。';

/** 现场 B 第 2 段：visible-answer fallback 重试整篇重写 */
const SEG_B2 = `${SEG_A2}\n\n要点：目的港取卖价表基准值，O/F 回到表内值。`;

// ============ Part 1: StreamingController（控制器单元）============

interface FakeSession {
  updates: string[];
  completed: number;
}

function makeController(opts: { failUpdates?: boolean; sendStatic?: (t: string) => Promise<void> } = {}) {
  const sessions: FakeSession[] = [];
  const staticTexts: string[] = [];
  const gateway: any = {
    openStream: () => {
      const s: FakeSession = { updates: [], completed: 0 };
      sessions.push(s);
      return {
        update: async (text: string) => {
          if (opts.failUpdates) throw new Error('update API error');
          s.updates.push(text);
        },
        complete: async () => {
          s.completed++;
          return { id: 'stream-done', timestamp: Date.now() };
        },
      };
    },
  };
  const ctrl = new StreamingController({
    gateway,
    target: { scope: 'c2c', targetId: 'u1', msgId: 'm1' } as any,
    accountId: 'test',
    replyToId: 'm1',
    sendMode: 'stream',
    sendStatic: opts.sendStatic ?? (async (t: string) => { staticTexts.push(t); }),
  });
  return { ctrl, sessions, staticTexts };
}

/** 取每条消息的最终内容（最后一条 update） */
function messageTexts(sessions: FakeSession[]): string[] {
  return sessions.map((s) => s.updates.at(-1) ?? '');
}

group('Part 1: 控制器层（段模型）');

await test('T1 现场 A：同轮第二次模型调用 → 两段各自一条消息，内容互不重叠', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply(SEG_A1);
  await ctrl.onPartialReply(SEG_A2);   // 新段：与第 1 段无公共前缀
  await ctrl.absorbFinalText(SEG_A2);  // 终稿 = 最后一段的权威文本
  await ctrl.finalize();

  assert.strictEqual(sessions.length, 2, `每个段一条消息，实际 ${sessions.length}`);
  assert.strictEqual(sessions[0]!.completed, 1, '第 1 条消息应已收尾（DONE 帧）');
  assert.deepStrictEqual(
    messageTexts(sessions),
    [SEG_A1, SEG_A2],
    '每条消息的内容 = 本段原文，互不重叠',
  );
});

await test('T2 现场 B：provider 断流后同轮重试 → 仍是分段投递，不产生缝合体', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply(SEG_B1);
  await ctrl.onPartialReply(SEG_B2);   // 重试整篇重写
  await ctrl.absorbFinalText(SEG_B2);
  await ctrl.finalize();

  assert.strictEqual(sessions.length, 2, `每段一条消息，实际 ${sessions.length}`);
  assert.deepStrictEqual(
    messageTexts(sessions),
    [SEG_B1, SEG_B2],
    '两段各自原样送达，无截断拼接',
  );
});

await test('T3 拼接禁令：绝不出现「旧文本 + 新文本去掉公共前缀」的缝合体', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply('abcdefg');
  await ctrl.onPartialReply('abcXYZ!');   // 公共前缀 abc，但整段不是延续
  await ctrl.finalize();

  assert.strictEqual(sessions.length, 2, '新段应另起一条消息');
  assert.deepStrictEqual(messageTexts(sessions), ['abcdefg', 'abcXYZ!'], '每段原样送达');
  for (const s of sessions) {
    for (const t of s.updates) {
      assert.ok(!t.includes('abcdefgXYZ!'), `不得出现跨段截断的缝合体：${JSON.stringify(t)}`);
    }
  }
});

await test('T4 段内增长：同一段只产生递增的 update（平台前缀单调）', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply('第一段');
  await ctrl.onPartialReply('第一段继续');
  await ctrl.onPartialReply('第一段继续写');

  assert.strictEqual(sessions.length, 1, '同一段应只有一条消息');
  const texts = sessions[0]!.updates;
  assert.deepStrictEqual(texts, ['第一段', '第一段继续', '第一段继续写']);
  for (let i = 1; i < texts.length; i++) {
    assert.ok(
      texts[i]!.startsWith(texts[i - 1]!),
      `第 ${i} 次 update 必须以前一次为前缀：${JSON.stringify(texts)}`,
    );
  }
});

await test('T5 工具调用 = 段边界：封口当前段，但不终止整轮（后续正文不丢）', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply('工具调用前的抬头');
  await ctrl.closeSegment('tool_call');     // 工具调用
  await ctrl.onPartialReply('工具调用后的正文');
  await ctrl.finalize();

  assert.strictEqual(sessions.length, 2, '工具调用后另起一条消息');
  assert.deepStrictEqual(
    messageTexts(sessions),
    ['工具调用前的抬头', '工具调用后的正文'],
    '工具调用后的正文必须完整送达（旧实现在这里 finalize → 整段丢失）',
  );
});

await test('T6 终稿与已流出内容无关且本段从未流出 → 必须整段补发（不丢内容）', async () => {
  const { ctrl, sessions, staticTexts } = makeController();

  await ctrl.onPartialReply('第一段');
  await ctrl.beginSegment();            // 框架信号：新段开始（上一段封口）
  await ctrl.absorbFinalText('终稿正文（与第一段无关）');

  assert.deepStrictEqual(staticTexts, ['终稿正文（与第一段无关）'], '本段从未流出 → 终稿必须补发');
  assert.strictEqual(sessions.length, 1, '补发走普通消息，不应另起流式会话');
});

await test('T7 终稿与已流出内容无关但本段已流出 → 不补发（不制造重复）', async () => {
  const { ctrl, staticTexts } = makeController();

  await ctrl.onPartialReply('第一段');
  await ctrl.absorbFinalText('模型改写后的另一版正文');

  assert.deepStrictEqual(staticTexts, [], '流内内容即答案，补发会造成重复');
});

await test('T8 显式段边界优先：即使下一段首片延续上一段也判为新段', async () => {
  const { ctrl, sessions } = makeController();

  await ctrl.onPartialReply('abc');
  await ctrl.beginSegment();            // 框架 onAssistantMessageStart
  await ctrl.onPartialReply('abcdef');  // 首片延续上一段文本

  assert.strictEqual(sessions.length, 2, '显式边界优先：另起一条消息');
  assert.deepStrictEqual(messageTexts(sessions), ['abc', 'abcdef']);
});

await test('T9 平台 update 失败 → 终稿仍必须送达（普通消息兜底）', async () => {
  const { ctrl, sessions } = makeController({ failUpdates: true });

  await ctrl.onPartialReply('正文');
  assert.strictEqual(ctrl.currentPhase, 'failed', 'update 抛错应进入 failed');

  // 控制器层：终态后 absorb 不再动作，兜底由上层（dispatch 默认路径）承担
  await ctrl.absorbFinalText('正文');
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(ctrl.shouldFallbackToStatic, true, '一条都没发成功 → 应降级为普通消息兜底');
});

// ============ Part 2: dispatch 层（真实 dispatchToOpenClaw）============

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

function installFakeGateway(opts: { failFirstUpdate?: boolean } = {}) {
  const sentTexts: string[] = [];
  const streamUpdates: string[] = [];
  const streamCompletes: number[] = [];
  const gw = {
    sendText: async (_target: any, text: string) => {
      sentTexts.push(text);
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
    openStream: () => ({
      update: async (text: string) => {
        if (opts.failFirstUpdate) throw new Error('Network error [stream/update]: fetch timeout');
        streamUpdates.push(text);
      },
      complete: async () => {
        streamCompletes.push(Date.now());
        return { id: 'stream-done', timestamp: Date.now() };
      },
    }),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts, streamUpdates, streamCompletes };
}

async function runDispatch(opts: {
  streaming: false | { mode: string; sendMode?: 'static' };
  simulate: (captured: CapturedDispatch) => Promise<void>;
  failFirstUpdate?: boolean;
}) {
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
  const ctx = { state: {}, message: { content: 'hello' } } as any;
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

  const gw = installFakeGateway({ failFirstUpdate: opts.failFirstUpdate });
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  return gw;
}

group('Part 2: dispatch 层（端到端）');

await test('端到端：同轮第二次模型调用 → 两段各自一条消息，无内容重叠', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: SEG_A1 });
      await c.replyOptions?.onPartialReply?.({ text: SEG_A2 });
      await c.dispatcherOptions?.deliver?.({ text: SEG_A2 }, { kind: 'final' });
    },
  });

  assert.deepStrictEqual(gw.sentTexts, [], '不应有普通消息（正文全在流式消息里）');
  assert.strictEqual(gw.streamCompletes.length, 2, '两条消息各收尾一次');
  assert.deepStrictEqual(
    gw.streamUpdates,
    [SEG_A1, SEG_A2],
    '每段原样送达为一条消息，无跨段拼接',
  );
});

await test('端到端：tool payload = 段边界 → 工具后的正文另起一条且完整', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '工具调用前的抬头' });
      await c.dispatcherOptions?.deliver?.({ text: '' }, { kind: 'tool' });
      await c.replyOptions?.onPartialReply?.({ text: '工具调用后的正文' });
      await c.dispatcherOptions?.deliver?.({ text: '工具调用后的正文' }, { kind: 'final' });
    },
  });

  assert.deepStrictEqual(gw.sentTexts, [], '不应有普通消息');
  assert.strictEqual(gw.streamCompletes.length, 2, '两条消息各收尾一次');
  assert.deepStrictEqual(
    gw.streamUpdates,
    ['工具调用前的抬头', '工具调用后的正文'],
    '工具调用后的正文不得被丢弃（内容不丢）',
  );
});

await test('端到端：首片 update 失败 → 终稿走普通消息送达（内容不丢）', async () => {
  const gw = await runDispatch({
    streaming: { mode: 'stream' },
    failFirstUpdate: true,
    simulate: async (c) => {
      await c.replyOptions?.onPartialReply?.({ text: '正文开头' });
      await c.dispatcherOptions?.deliver?.({ text: '正文开头与结尾' }, { kind: 'final' });
    },
  });

  assert.deepStrictEqual(
    gw.sentTexts,
    ['正文开头与结尾'],
    `流不可用时终稿必须以普通消息送达，实际: ${JSON.stringify(gw.sentTexts)}`,
  );
});

// ============ 结果 ============

console.log(`\n========================================`);
console.log(`  总计: ${passed + failed} | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
if (failedTests.length > 0) {
  console.log(`  失败用例:`);
  for (const t of failedTests) console.log(`    - ${t}`);
}
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
