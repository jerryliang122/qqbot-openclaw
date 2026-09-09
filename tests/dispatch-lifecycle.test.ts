/**
 * Dispatch lifecycle 回归测试
 *
 * 验证本次对齐 telegram 的三项修复（真实调用 dispatchToOpenClaw，不做逻辑复制）：
 * 1. turnAdoptionLifecycle 双透传：runDispatchLifecycle.turnAdoptionLifecycle 与
 *    replyOptions.turnAdoptionLifecycle 必须是同一对象（框架所有权校验要求）。
 * 2. onAbandoned → abortSignal 中止：排队 turn 被取代时 replyOptions.abortSignal 生效。
 * 3. 失败兜底：底层发送全部失败且无可见回复时，向用户发送兜底消息而非静默失败。
 *
 * 运行方式: npx tsx tests/dispatch-lifecycle.test.ts
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
const { registerGateway, sendText } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

// ── 测试基础设施 ──

interface CapturedPlan {
  runDispatchLifecycle?: { turnAdoptionLifecycle?: any; onDispatchSkipped?: (r: string) => void };
  runDispatch: () => Promise<any>;
}

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

function makeMsgAndCtx(overrides: { scope?: 'group' | 'c2c'; targetId?: string; messageId?: string } = {}) {
  const scope = overrides.scope ?? 'c2c';
  const targetId = overrides.targetId ?? 'USER_123';
  const messageId = overrides.messageId ?? `msg-${Math.random().toString(36).slice(2, 10)}`;
  const msg = {
    kind: scope === 'group' ? 'group' : 'c2c',
    messageId,
    content: 'hello',
    senderId: 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope, targetId },
    timestamp: Date.now(),
  } as any;
  const ctx = {
    state: {},
    message: { content: 'hello' },
    signal: undefined,
  } as any;
  return { msg, ctx, messageId };
}

function makeAccount(): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: false,
    },
  };
}

/** 注册 fake gateway，记录 sendText 调用，可指定失败策略 */
function installFakeGateway(opts: { failTexts?: boolean } = {}) {
  const sentTexts: Array<{ target: any; text: string; opts: any }> = [];
  const gw = {
    sendText: async (target: any, text: string, sendOpts: any) => {
      sentTexts.push({ target, text, opts: sendOpts });
      if (opts.failTexts) throw new Error('QQ API unavailable');
      return { id: `out-${sentTexts.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
  } as any;
  registerGateway('test-account', gw);
  return { sentTexts };
}

// ── 测试 ──

group('修1: turnAdoptionLifecycle 双透传');

await test('runDispatchLifecycle 与 replyOptions 持有同一 lifecycle 对象', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();
  let capturedPlan: CapturedPlan | undefined;
  let capturedDispatch: CapturedDispatch | undefined;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      capturedPlan = plan;
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      capturedDispatch = params2;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.ok(capturedPlan, 'resolveTurn plan 应被调用');
  const lifecycle = (capturedPlan as any).runDispatchLifecycle?.turnAdoptionLifecycle;
  assert.ok(lifecycle, 'runDispatchLifecycle.turnAdoptionLifecycle 必须存在（不能是 undefined）');
  assert.equal(lifecycle.admission, 'exclusive');
  assert.ok(lifecycle.abortSignal instanceof AbortSignal);
  assert.equal(typeof lifecycle.onAdopted, 'function');
  assert.equal(typeof lifecycle.onDeferred, 'function');
  assert.equal(typeof lifecycle.onAbandoned, 'function');

  assert.ok((capturedDispatch as any), 'runDispatch 应调用 dispatchReply');
  const replyLifecycle = (capturedDispatch as any).replyOptions?.turnAdoptionLifecycle;
  assert.ok(replyLifecycle, 'replyOptions.turnAdoptionLifecycle 必须存在');
  assert.strictEqual(
    replyLifecycle,
    lifecycle,
    '两个位置必须是同一对象（框架校验 runDispatchLifecycle 拥有顶层 lifecycle）',
  );
});

await test('onAbandoned 触发后 replyOptions.abortSignal 中止（排队 turn 被取代）', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();
  let lifecycle: any;
  let replyOptions: any;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      lifecycle = plan.runDispatchLifecycle?.turnAdoptionLifecycle;
      // 模拟：turn 先被 deferred，随后被新消息取代（abandoned）
      lifecycle.onDeferred?.();
      lifecycle.onAbandoned?.();
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      replyOptions = params2.replyOptions;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.ok(replyOptions?.abortSignal, 'replyOptions.abortSignal 必须存在（ctx.signal + turnAbort 合并）');
  assert.ok(
    replyOptions.abortSignal.aborted,
    'onAbandoned 之后合并 signal 必须处于 aborted 状态，供框架中止 superseded turn',
  );
});

group('修2: 失败兜底（无可见回复时通知用户）');

await test('底层 sendText 全部失败 → 发送兜底消息', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      // 执行 dispatch：deliver 一条 final 文本
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: async (params2: any) => {
      // 同步触发一次 deliver（模拟框架回调），发送失败由 fake gateway 抛错
      await params2.dispatcherOptions.deliver?.({ text: 'final answer' }, { kind: 'final' });
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  // 所有出站 sendText 均失败
  const { sentTexts } = installFakeGateway({ failTexts: true });
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const fallback = sentTexts.find((s) =>
    s.text === 'Something went wrong while processing your request. Please try again.');
  assert.ok(
    fallback,
    '全部发送失败后必须发出兜底消息（对齐 telegram），实际发送: '
      + JSON.stringify(sentTexts.map((s) => s.text)),
  );
  assert.equal(fallback!.opts?.msgId ?? fallback!.opts?.msgid, msg.messageId, '兜底消息应作为被动回复指向原消息');
});

await test('正常回复成功 → 不发送兜底消息', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: async (params2: any) => {
      await params2.dispatcherOptions.deliver?.({ text: 'here is your answer' }, { kind: 'final' });
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  const { sentTexts } = installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const fallback = sentTexts.find((s) =>
    s.text === 'Something went wrong while processing your request. Please try again.');
  assert.ok(!fallback, '已有可见回复时不应发送兜底消息');
  assert.ok(sentTexts.some((s) => s.text === 'here is your answer'), '正常回复应已送达');
});

await test('dispatch 抛错且无可见回复 → 发送兜底消息并向上传播错误', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();

  const runtime = makeFakeRuntime({
    onInboundRun: async () => {
      throw new Error('agent runtime exploded');
    },
  });

  const account = makeAccount();
  const { sentTexts } = installFakeGateway();

  let thrown: unknown;
  try {
    await dispatchToOpenClaw(ctx, msg, account, runtime);
  } catch (err) {
    thrown = err;
  }

  assert.ok(thrown, 'dispatch 错误必须继续向上传播（保持原语义）');
  const fallback = sentTexts.find((s) =>
    s.text === 'Something went wrong while processing your request. Please try again.');
  assert.ok(fallback, 'dispatch 抛错且无可见回复时必须发送兜底消息');
});

group('修4: legacy ctx 映射补 ChatId（echo 防环 conversation key）');

await test('buildInboundContext legacy 映射包含 ChatId（供框架 outbound-echo 丢弃检查）', async () => {
  _resetAdaptersCache();
  // 构造仅有旧版 finalizeInboundContext 的 runtime，触发 resolve.ts 的 legacy 映射
  const rawCtxPayloads: any[] = [];
  const runtime = {
    version: 'legacy-test',
    channel: {
      reply: {
        finalizeInboundContext: (rawCtx: any) => {
          rawCtxPayloads.push(rawCtx);
          return rawCtx;
        },
        dispatchReplyWithBufferedBlockDispatcher: async () => {
          return { queuedFinal: true, counts: { final: 1 } };
        },
      },
      session: {
        resolveStorePath: () => '',
        recordInboundSession: async () => {},
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:${params.peer.id}`,
          accountId: params.accountId,
          agentId: 'default',
        }),
      },
    },
    config: { current: {} },
  } as any;

  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_X' });
  const account = makeAccount();
  installFakeGateway();

  // dispatchToOpenClaw 走 legacy 分支（无 inbound.run）
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  assert.ok(rawCtxPayloads.length > 0, 'legacy finalizeInboundContext 应被调用');
  const rawCtx = rawCtxPayloads[0];
  assert.ok(rawCtx.ChatId, 'legacy 映射必须包含 ChatId');
  assert.equal(rawCtx.ChatId, 'GROUP_X', 'ChatId 应为会话 key（群 openid）');
  assert.equal(rawCtx.MessageSid, msg.messageId, 'MessageSid 应为平台消息 id');
});

// ── 结果 ──

group('修4: 群聊框架排队（coalesce.strategy=framework）');

await test('群聊 turn：admission=exclusive、无 abortSignal（不打断）、queueModeOverride=collect', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_X' });
  let capturedPlan: CapturedPlan | undefined;
  let capturedDispatch: CapturedDispatch | undefined;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      capturedPlan = plan;
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      capturedDispatch = params2;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const lifecycle = (capturedPlan as any)?.runDispatchLifecycle?.turnAdoptionLifecycle;
  assert.ok(lifecycle, '群聊 turn lifecycle 应存在');
  assert.equal(lifecycle.admission, 'exclusive', '群聊 admission 应为 exclusive（durable ingress 约定）');
  assert.equal(lifecycle.abortSignal, undefined, '群聊不传 abortSignal（不打断正在处理的 turn）');

  const replyOptions = (capturedDispatch as any)?.replyOptions;
  assert.equal(replyOptions?.queueModeOverride, 'collect', '默认 framework 策略 → collect 合并批处理');
});

await test('群聊 coalesce.enabled=false → queueModeOverride=followup（排队不合并）', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_X' });
  let capturedDispatch: CapturedDispatch | undefined;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      capturedDispatch = params2;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  account.config.groups = { GROUP_X: { coalesce: { enabled: false } } };
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const replyOptions = (capturedDispatch as any)?.replyOptions;
  assert.equal(replyOptions?.queueModeOverride, 'followup', '关闭合并但保留不打断语义 → followup');
});

await test('群聊 coalesce.strategy=plugin → 不传 queueModeOverride（插件 coalescer 负责）', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', targetId: 'GROUP_X' });
  let capturedDispatch: CapturedDispatch | undefined;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      capturedDispatch = params2;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  account.config.groups = { GROUP_X: { coalesce: { strategy: 'plugin' } } };
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const replyOptions = (capturedDispatch as any)?.replyOptions;
  assert.equal(replyOptions?.queueModeOverride, undefined, 'plugin 策略不传 queueModeOverride');
});

await test('c2c turn：queueModeOverride 不传（c2c 插嘴语义不变）', async () => {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx();
  let capturedDispatch: CapturedDispatch | undefined;

  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      capturedDispatch = params2;
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });

  const account = makeAccount();
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);

  const replyOptions = (capturedDispatch as any)?.replyOptions;
  assert.equal(replyOptions?.queueModeOverride, undefined, 'c2c 不传 queueModeOverride');
});

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
}
console.log('\n✅ 所有测试通过！');
process.exit(0);
