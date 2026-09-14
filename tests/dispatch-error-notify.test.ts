/**
 * Agent run 失败通知回归测试（issue #8）
 *
 * 场景：c2c 流式已启动且首分片已送达用户，随后模型失败，框架经 deliver
 * 回调投递带 isError 标记的失败通知 payload。
 *
 * 修复前：deliverHandler 的「流式已启动 → final 已由流式发过」去重早退把
 * 失败文案整个吞掉（dispatch.ts 流式分支的 return），用户只见首分片后静默，
 * WebUI ⚠️ 成为唯一失败信号。
 *
 * 修复后：isError payload 绕过流式去重早退，落到默认路径静态发出；
 * 非 error payload 的去重早退行为保持不变。
 *
 * 运行方式: npx tsx tests/dispatch-error-notify.test.ts
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

const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

// ── 测试基础设施（对齐 dispatch-lifecycle.test.ts）──

interface CapturedDispatch {
  replyOptions?: any;
  dispatcherOptions?: { deliver?: (payload: any, info?: any) => Promise<void> };
}

function makeFakeRuntime(opts: {
  onInboundRun?: (params: any) => Promise<any>;
  dispatchReply?: (params: any) => any;
} = {}) {
  return {
    version: 'test',
    channel: {
      inbound: {
        ...(opts.onInboundRun ? { run: (params: any) => opts.onInboundRun!(params) } : {}),
        buildContext: (params: any) => ({ ...params, __built: true }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: (params: any) => {
          if (!opts.dispatchReply) {
            throw new Error('test dispatchReply not configured');
          }
          return opts.dispatchReply(params);
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

function makeMsgAndCtx() {
  const messageId = `msg-${Math.random().toString(36).slice(2, 10)}`;
  const msg = {
    kind: 'c2c',
    messageId,
    content: 'hello',
    senderId: 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope: 'c2c', targetId: 'USER_123' },
    timestamp: Date.now(),
  } as any;
  const ctx = { state: {}, message: { content: 'hello' }, signal: undefined } as any;
  return { msg, ctx, messageId };
}

/**
 * 账号配置的 streaming 形态对齐真实配置：
 *   { mode: 'partial', sendMode: 'stream' }  打字机（QQ 流式 API）
 *   { mode: 'partial', sendMode: 'static' }  思考链+最终回复走普通文本
 *   { mode: 'off' }                          只发最终回复（无流式 controller）
 */
function makeAccount(streaming: false | { mode: 'partial'; sendMode: 'stream' | 'static' } | { mode: 'off' }): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming,
    },
  };
}

interface FakeGatewayOpts {
  streamMode?: boolean;
}

function installFakeGateway(opts: FakeGatewayOpts = {}) {
  const sentTexts: Array<{ target: any; text: string; opts: any }> = [];
  const streamUpdates: string[] = [];
  const streamCompletes = { count: 0 };
  const gw = {
    sendText: async (target: any, text: string, sendOpts: any) => {
      sentTexts.push({ target, text, opts: sendOpts });
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
    ...(opts.streamMode
      ? {
          openStream: () => ({
            update: async (text: string) => {
              streamUpdates.push(text);
            },
            complete: async () => {
              streamCompletes.count++;
              return { id: 'stream-done', timestamp: Date.now() };
            },
          }),
        }
      : {}),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts, streamUpdates, streamCompletes };
}

/** 跑一次 dispatch，fake dispatchReply 内模拟「流式首分片已送达 + 框架投递 payload」 */
async function runDispatchWithPayloads(opts: {
  account: any;
  payloads: Array<{ payload: any; info?: any }>;
  firstPartial?: string;
  flushFirstChunk?: boolean;
}) {
  let captured: CapturedDispatch | undefined;
  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: async (params2: any) => {
      captured = params2;
      // 流式启动：模型吐出首段（static 模式仅累积，stream 模式开流会话）
      if (opts.firstPartial !== undefined) {
        await params2.replyOptions?.onPartialReply?.({ text: opts.firstPartial });
        // static 模式：工具开始前 flush —— 模拟首分片实际送达用户
        if (opts.flushFirstChunk) {
          await params2.replyOptions?.onToolStart?.();
        }
      }
      // 框架投递 payload（按序）
      for (const { payload, info } of opts.payloads) {
        await params2.dispatcherOptions?.deliver?.(payload, info);
      }
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });
  const { msg, ctx } = makeMsgAndCtx();
  await dispatchToOpenClaw(ctx, msg, opts.account, runtime);
  return { captured };
}

// ── 测试 ──

group('issue #8: 流式已启动后 agent run 失败通知不被吞');

await test('static 模式：首分片已送达，isError final payload 必须静态发出', async () => {
  _resetAdaptersCache();
  const { sentTexts } = installFakeGateway();
  const errorText = '⚠️ Agent run failed (model: minimax/MiniMax-M3).';

  await runDispatchWithPayloads({
    account: makeAccount({ mode: 'partial', sendMode: 'static' }),
    firstPartial: '这是已送达用户的首段回答（1062 字符）。',
    flushFirstChunk: true,
    payloads: [{ payload: { text: errorText, isError: true }, info: { kind: 'final' } }],
  });

  assert.ok(
    sentTexts.some((s) => s.text === errorText),
    `失败通知必须经 sendText 发出，实际发送: ${JSON.stringify(sentTexts.map((s) => s.text))}`,
  );
  assert.equal(sentTexts.length, 2, '应恰好两条：首分片（static flush）+ 失败通知');
});

await test('static 模式：非 error final payload 的流式去重早退保持不变', async () => {
  _resetAdaptersCache();
  const { sentTexts } = installFakeGateway();
  const firstChunk = '这是已送达用户的首段回答。';
  const finalText = '这是与流式内容一致的完整 final 文本，不应重复发送。';

  await runDispatchWithPayloads({
    account: makeAccount({ mode: 'partial', sendMode: 'static' }),
    firstPartial: firstChunk,
    flushFirstChunk: true,
    payloads: [{ payload: { text: finalText }, info: { kind: 'final' } }],
  });

  assert.ok(
    sentTexts.some((s) => s.text === firstChunk),
    '首分片应已送达',
  );
  assert.ok(
    !sentTexts.some((s) => s.text === finalText),
    `非 error final 文本不应重复发送（流式去重早退），实际发送: ${JSON.stringify(sentTexts.map((s) => s.text))}`,
  );
});

await test('stream 模式：打字机流收尾后，isError final payload 静态发出', async () => {
  _resetAdaptersCache();
  const { sentTexts, streamUpdates, streamCompletes } = installFakeGateway({ streamMode: true });
  const errorText = '⚠️ Something went wrong while processing your request. Please try again, or use /new to start a fresh session.';

  await runDispatchWithPayloads({
    account: makeAccount({ mode: 'partial', sendMode: 'stream' }),
    firstPartial: '打字机流中的首段文本',
    payloads: [{ payload: { text: errorText, isError: true }, info: { kind: 'final' } }],
  });

  assert.ok(streamUpdates.length > 0, '打字机流应有分片下发');
  assert.ok(streamCompletes.count >= 1, '流会话应已收尾（deliver 时 finalize）');
  assert.ok(
    sentTexts.some((s) => s.text === errorText),
    `失败通知必须经 sendText 发出，实际发送: ${JSON.stringify(sentTexts.map((s) => s.text))}`,
  );
});

group('回归守卫：流式未启用时失败通知原本就走默认路径');

await test('mode:off（只发最终回复）：isError payload 正常发出', async () => {
  _resetAdaptersCache();
  const { sentTexts } = installFakeGateway();
  const errorText = '⚠️ Agent run failed (model: minimax/MiniMax-M3).';

  await runDispatchWithPayloads({
    account: makeAccount({ mode: 'off' }),
    payloads: [{ payload: { text: errorText, isError: true }, info: { kind: 'final' } }],
  });

  assert.ok(
    sentTexts.some((s) => s.text === errorText),
    'mode:off 无流式 controller，失败通知走默认路径，不应受本次修复影响',
  );
});

await test('无流式配置（streaming:false）：isError payload 正常发出', async () => {
  _resetAdaptersCache();
  const { sentTexts } = installFakeGateway();
  const errorText = '⚠️ Agent run failed (model: minimax/MiniMax-M3).';

  await runDispatchWithPayloads({
    account: makeAccount(false),
    payloads: [{ payload: { text: errorText, isError: true }, info: { kind: 'final' } }],
  });

  assert.ok(
    sentTexts.some((s) => s.text === errorText),
    '非流式路径的失败通知发送行为不应受本次修复影响',
  );
});

// ── 汇总 ──

console.log(`\n${'='.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
} else {
  console.log(`✓ All ${passed} tests passed`);
}
