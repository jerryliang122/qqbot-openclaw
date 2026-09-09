/**
 * room_event 终态 + 出站被动优先 回归测试
 *
 * 覆盖：
 * 1. 分类正确性：@ / 称呼唤醒 / 引用唤醒 → user_request；其余（room_event 群）→ room_event；
 *    AT 群 / 未开启配置 → 恒 user_request；斜杠命令 → user_request。
 * 2. room_event turn：sourceReplyDeliveryMode='message_tool_only'、群 admission=exclusive
 *    且无 abortSignal（不打断）。
 * 3. 出站被动优先：有新鲜 msg_id → 被动（带 msgId）；配额耗尽（群 5 次/msg_id）
 *    → 第 6 次降级主动而非报错；静群（无缓存）→ 直接主动；主动计数正确。
 *
 * 运行方式: npx tsx tests/room-event.test.ts
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
const { cacheMsgId } = await import('../src/features/msgid-cache.ts');
const { _resetProactiveBudget, getProactiveUsage } = await import('../src/features/proactive-budget.ts');
const { resolveGroupConfigFromAccount } = await import('../src/config.ts');
const { recordGroupEvent, getGroupModeFacts, _resetGroupModeStore } = await import('../src/features/group-mode-store.ts');
const { QQBotGateway } = await import('../src/gateway/qqbot-gateway.ts');

// ── 测试基础设施（对齐 dispatch-lifecycle.test.ts）──

interface CapturedDispatch {
  replyOptions?: any;
  ctxPayload?: any;
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
          if (!opts.dispatchReply) throw new Error('test dispatchReply not configured');
          return opts.dispatchReply(params);
        },
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:group:${params.peer.id}:coalescing`,
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

function makeGroupMsgAndCtx(overrides: {
  rawEventType?: string;
  content?: string;
  mentionState?: { wasMentioned?: boolean; implicit?: boolean };
} = {}) {
  const msg = {
    kind: 'group' as const,
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    content: overrides.content ?? '大家好',
    senderId: 'USER_A',
    senderName: 'UserA',
    attachments: [],
    replyTarget: { scope: 'group' as const, targetId: 'GROUP_ROOM' },
    groupOpenid: 'GROUP_ROOM',
    rawEventType: overrides.rawEventType ?? 'GROUP_MESSAGE_CREATE',
    mentions: [],
    timestamp: Date.now(),
    raw: {},
  } as any;
  const ctx = {
    state: { ...(overrides.mentionState ? { mention: overrides.mentionState } : {}) },
    message: { content: msg.content },
    signal: undefined,
  } as any;
  return { msg, ctx };
}

function makeAccount(groups?: Record<string, any>): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: false,
      ...(groups ? { groups } : {}),
    },
  };
}

function installFakeGateway() {
  const sends: Array<{ target: any; opts?: any }> = [];
  const gw = {
    sendText: async (target: any, _text: string, opts?: any) => {
      sends.push({ target, opts });
      return { id: `out-${sends.length}`, timestamp: Date.now() };
    },
    sendMedia: async () => ({ id: 'media-out' }),
  } as any;
  registerGateway('test-account', gw);
  return { sends };
}

/**
 * 原型构造真实 QQBotGateway（绕开 constructor 里的 new QQBot——那会触发
 * token 预取等副作用），手动注入 fake bot 与账号，用于测网关层逻辑
 * （attachMsgIdWithQuota 配额感知挂接 / 主动计数 / 失败回滚）。
 */
function installRealGatewayMethods(account: any) {
  const sends: Array<{ target: any; opts?: any }> = [];
  const gw: any = Object.create(QQBotGateway.prototype);
  gw.account = account;
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  gw.textTimeout = 5_000;
  gw.mediaTimeout = 5_000;
  gw.bot = {
    sendText: async (target: any, _text: string) => {
      sends.push({ target, opts: undefined });
      // target.msgId 由 attachMsgIdWithQuota 决定，记录最终形态
      sends[sends.length - 1]!.target = target;
      return { id: `out-${sends.length}`, timestamp: Date.now() };
    },
    sendMedia: async () => ({ message: { id: 'media-out', timestamp: Date.now() } }),
  };
  registerGateway(account.accountId, gw);
  return { sends, gw };
}

async function runDispatch(opts: {
  account: any;
  msg: any;
  ctx: any;
}): Promise<CapturedDispatch> {
  _resetAdaptersCache();
  let captured: CapturedDispatch = {};
  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      captured.ctxPayload = plan;
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: (params2: any) => {
      captured = { ...captured, replyOptions: params2.replyOptions, ctxPayload: params2.ctx };
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });
  installFakeGateway();
  await dispatchToOpenClaw(opts.ctx, opts.msg, opts.account, runtime);
  return captured;
}

// ── 测试 ──

group('room_event 分类正确性');

await test('room_event 群 + 未 @ + 无称呼 → room_event + message_tool_only', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ content: '今天天气不错' });
  const account = makeAccount({ GROUP_ROOM: { unmentionedInbound: 'room_event' } });
  const captured = await runDispatch({ account, msg, ctx });
  assert.equal(captured.ctxPayload?.InboundEventKind, 'room_event');
  assert.equal(captured.replyOptions?.sourceReplyDeliveryMode, 'message_tool_only');
  assert.equal(captured.replyOptions?.queueModeOverride, 'collect');
});

await test('room_event 群 + 被 @（AT 事件）→ user_request（正常回复权）', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    mentionState: { wasMentioned: true },
  });
  const account = makeAccount({ GROUP_ROOM: { unmentionedInbound: 'room_event' } });
  const captured = await runDispatch({ account, msg, ctx });
  assert.equal(captured.ctxPayload?.InboundEventKind, 'user_request');
  assert.equal(captured.replyOptions?.sourceReplyDeliveryMode, undefined);
});

await test('room_event 群 + 称呼唤醒（mentionPatterns 命中「沈处」）→ user_request', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ content: '沈处沈处帮我干活' });
  const account = makeAccount({ GROUP_ROOM: { unmentionedInbound: 'room_event' } });
  const runtime = makeFakeRuntime();
  // mentionPatterns 经 adapters.getConfig 提供（config.current 必须是函数——
  // probeFunction 探测可调用性，传对象会被判为无 getConfig）
  _resetAdaptersCache();
  const patchedRuntime = {
    ...runtime,
    config: {
      current: () => ({
        agents: { list: [{ id: 'default', groupChat: { mentionPatterns: ['沈处'] } }] },
      }),
    },
  } as any;
  let captured: CapturedDispatch = {};
  patchedRuntime.channel.inbound.run = async (params: any) => {
    const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
    captured.ctxPayload = plan;
    await plan.runDispatch();
    return { dispatched: true };
  };
  patchedRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher = (params2: any) => {
    captured = { ...captured, replyOptions: params2.replyOptions, ctxPayload: params2.ctx };
    return { queuedFinal: true, counts: { final: 1 } };
  };
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, patchedRuntime);
  assert.equal(captured.ctxPayload?.InboundEventKind, 'user_request', '称呼唤醒必须拿到正常回复权');
  assert.equal(captured.replyOptions?.sourceReplyDeliveryMode, undefined);
});

await test('room_event 群 + 引用唤醒（quote implicit）→ user_request', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ mentionState: { implicit: true } });
  const account = makeAccount({ GROUP_ROOM: { unmentionedInbound: 'room_event' } });
  const captured = await runDispatch({ account, msg, ctx });
  assert.equal(captured.ctxPayload?.InboundEventKind, 'user_request');
});

await test('room_event 群 + 斜杠命令 → user_request', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ content: '/bot-ping' });
  // 注：真实链路 slashCommand 中间件会拦截并直答；此处模拟"命令到达 dispatch"
  // 的分类兜底——rawBody 以 / 开头时不降级为 room_event
  const account = makeAccount({ GROUP_ROOM: { unmentionedInbound: 'room_event' } });
  const captured = await runDispatch({ account, msg, ctx });
  assert.equal(captured.ctxPayload?.InboundEventKind, 'user_request');
});

await test('未开启 room_event 的群 → 恒 user_request（默认配置不变）', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ content: '闲聊' });
  const account = makeAccount(); // 无 groups 配置
  const captured = await runDispatch({ account, msg, ctx });
  assert.equal(captured.ctxPayload?.InboundEventKind, 'user_request');
  assert.equal(captured.replyOptions?.sourceReplyDeliveryMode, undefined);
});

await test('群聊 turn 不传 abortSignal（不打断正在处理的任务）', async () => {
  const { msg, ctx } = makeGroupMsgAndCtx({ rawEventType: 'GROUP_AT_MESSAGE_CREATE', mentionState: { wasMentioned: true } });
  const account = makeAccount();
  _resetAdaptersCache();
  let lifecycle: any;
  const runtime = makeFakeRuntime({
    onInboundRun: async (params) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      lifecycle = plan.runDispatchLifecycle?.turnAdoptionLifecycle;
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: () => ({ queuedFinal: true, counts: { final: 1 } }),
  });
  installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  assert.equal(lifecycle.admission, 'exclusive');
  assert.equal(lifecycle.abortSignal, undefined);
});

group('出站被动优先（保 1000/天主动预算）');

await test('网关无显式 msgId 时优先挂缓存 msg_id（被动）', async () => {
  const account = makeAccount();
  const { sends } = installRealGatewayMethods(account);
  // 刷新该群 msgid-cache（模拟刚收到群消息）
  cacheMsgId('group', 'GROUP_Q', 'INBOUND_MSG_1');
  const { sendText } = await import('../src/outbound/outbound-service.ts');
  const result = await sendText({
    to: 'qqbot:group:GROUP_Q',
    text: 'hello',
    account,
    // 不传 replyToId —— 走网关 attachMsgIdWithQuota 的 msgid-cache 兜底
  });
  assert.ok(!result.error, `unexpected error: ${result.error}`);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.target.msgId, 'INBOUND_MSG_1', '应挂缓存 msg_id 走被动回复');
});

await test('同 msg_id 连续 6 次群发送：第 6 次降级主动（无 msgId）而非报错', async () => {
  const { sends } = installFakeGateway();
  cacheMsgId('group', 'GROUP_Q2', 'INBOUND_MSG_2');
  const { sendText } = await import('../src/outbound/outbound-service.ts');
  const account = makeAccount();
  for (let i = 1; i <= 6; i++) {
    const result = await sendText({ to: 'qqbot:group:GROUP_Q2', text: `m${i}`, account, replyToId: 'INBOUND_MSG_2' });
    assert.ok(!result.error, `第 ${i} 次发送不应报错: ${result.error}`);
  }
  assert.equal(sends.length, 6);
  // 群配额 5 次/msg_id：前 5 次被动（带 msgId），第 6 次主动（无 msgId）
  const withMsgId = sends.filter((s) => s.opts?.msgId).length;
  assert.equal(withMsgId, 5, `应 5 次被动，实际 ${withMsgId}`);
  assert.equal(sends[5]!.opts?.msgId, undefined, '第 6 次应降级主动');
});

await test('静群（无缓存 msg_id）→ 直接主动发送并计数', async () => {
  _resetProactiveBudget();
  const account = makeAccount();
  const { sends } = installRealGatewayMethods(account);
  const { sendText } = await import('../src/outbound/outbound-service.ts');
  const before = getProactiveUsage('test-account').count;
  const result = await sendText({ to: 'qqbot:group:GROUP_QUIET', text: 'hi', account });
  assert.ok(!result.error, `unexpected error: ${result.error}`);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]!.target.msgId, undefined, '无缓存应不带 msg_id（主动）');
  assert.equal(getProactiveUsage('test-account').count, before + 1, '主动发送应计数');
});

group('模式推断存储');

test('GROUP_MESSAGE_CREATE → full；GROUP_AT_MESSAGE_CREATE → at；变化返回新模式', () => {
  _resetGroupModeStore();
  const first = recordGroupEvent('acct', 'G1', 'GROUP_MESSAGE_CREATE', false);
  assert.equal(first, null, '首次记录不视为变化');
  assert.equal(getGroupModeFacts('acct', 'G1')?.mode, 'full');
  const changed = recordGroupEvent('acct', 'G1', 'GROUP_AT_MESSAGE_CREATE', false);
  assert.equal(changed, 'at', '模式变化应返回新模式');
  assert.equal(getGroupModeFacts('acct', 'G1')?.mode, 'at');
  assert.ok(getGroupModeFacts('acct', 'G1')!.sawMsgElements === false);
  recordGroupEvent('acct', 'G1', 'GROUP_AT_MESSAGE_CREATE', true);
  assert.ok(getGroupModeFacts('acct', 'G1')!.sawMsgElements, 'msg_elements 观测应留痕');
});

group('配置级联');

test('unmentionedInbound 级联：具体群 > "*" > 默认 user_request', () => {
  const account: any = {
    accountId: 'default',
    config: { groups: { GROUP_RE: { unmentionedInbound: 'room_event' }, '*': { unmentionedInbound: 'room_event' } } },
  };
  assert.equal(resolveGroupConfigFromAccount(account, 'GROUP_RE').unmentionedInbound, 'room_event');
  assert.equal(resolveGroupConfigFromAccount(account, 'GROUP_OTHER').unmentionedInbound, 'room_event');
  const bare: any = { accountId: 'default', config: {} };
  assert.equal(resolveGroupConfigFromAccount(bare, 'GROUP_ANY').unmentionedInbound, 'user_request');
});

// ── 结果 ──

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
}
console.log('\n✅ 所有测试通过！');
process.exit(0);
