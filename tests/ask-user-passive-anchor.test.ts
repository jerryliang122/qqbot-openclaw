/**
 * ask_user 问题卡被动锚点守卫（PR3 / issue #93）
 *
 * 背景：ask_user 的问题卡此前走 SDK 直发（请求体不带 `msg_id`）⇒ 平台按
 * **主动消息**处理——白烧每日 1000 条主动预算，且用户关闭「允许主动发送」
 * 时问题卡根本发不出去（模型空等到 ask_user 超时）。
 *
 * 本文件锁定新口径：
 * 1. 单问题卡 / 多题卡 → **被动回复**（锚点 = 本轮 inbound 的 msg_id）
 * 2. 锚点不可用（TTL 过期 / 平台判死 40034005·40034128）⇒ **降级主动一次**
 * 3. 网络错（结果不明）⇒ **不重发**
 * 4. 多题的确认卡 / 状态回执 ⇒ 复用**同一个锚点**
 * 5. 回归守卫：ask_user 出站不再出现 SDK 直发（`sendTextWithKeyboard`）
 *
 * 运行方式: npx tsx tests/ask-user-passive-anchor.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ApiError } from '@tencent-connect/qqbot-nodejs';

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
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 真实模块 ──

const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway, unregisterGateway } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');
const { clearQuotaCache } = await import('../src/features/quota-manager.ts');
const { cacheMsgId, clearMsgIdCache } = await import('../src/features/msgid-cache.ts');
const { registerPendingMultiQuestion } = await import('../src/features/question-helpers.ts');
const { handleInteraction } = await import('../src/gateway/event-handlers.ts');

// ── 测试基础设施（沿用 dispatch-lifecycle.test.ts 的形态）──

const ACCOUNT_ID = 'test-account';
const QID = `ask_${'a'.repeat(32)}`;

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

function makeMsgAndCtx(opts: { scope?: 'group' | 'c2c'; targetId?: string; messageId: string }) {
  const scope = opts.scope ?? 'c2c';
  const targetId = opts.targetId ?? 'USER_123';
  const msg = {
    kind: scope,
    messageId: opts.messageId,
    content: 'hello',
    senderId: 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope, targetId },
    timestamp: Date.now(),
  } as any;
  const ctx = { state: {}, message: { content: 'hello' }, signal: undefined } as any;
  return { msg, ctx };
}

function makeAccount(): any {
  return {
    accountId: ACCOUNT_ID,
    appId: 'x',
    config: { deliverDebounce: { enabled: false }, streaming: false },
  };
}

interface RecordedSend {
  target: any;
  text: string;
  opts: any;
}

/** 注册 fake gateway，记录 sendText 调用；可模拟平台判死 / 网络错 */
function installFakeGateway(opts: { failMode?: 'dead' | 'network' } = {}) {
  const sent: RecordedSend[] = [];
  const gw: any = {
    sendText: async (target: any, text: string, sendOpts: any) => {
      sent.push({ target, text, opts: sendOpts });
      if (opts.failMode === 'dead' && sendOpts?.msgId) {
        throw new ApiError('API Error: code=40034005', 400, '/v2/users/x/messages', 40034005, 'platform reject');
      }
      if (opts.failMode === 'network') {
        throw new ApiError('API Error: network', 0, '/v2/users/x/messages', 0, 'network');
      }
      return { id: `out-${sent.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
  };
  registerGateway(ACCOUNT_ID, gw);
  return { sent, gw };
}

/** 触发一次 ask_user payload 的投递（走真实 dispatchToOpenClaw） */
async function deliverAskUser(payload: any, opts: {
  messageId: string;
  scope?: 'c2c' | 'group';
  targetId?: string;
  gateway?: { failMode?: 'dead' | 'network' };
}) {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx(opts);
  const runtime = makeFakeRuntime({
    onInboundRun: async (params: any) => {
      const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
      await plan.runDispatch();
      return { dispatched: true };
    },
    dispatchReply: async (params2: any) => {
      await params2.dispatcherOptions.deliver?.(payload, { kind: 'final' });
      return { queuedFinal: true, counts: { final: 1 } };
    },
  });
  const account = makeAccount();
  const { sent, gw } = installFakeGateway(opts.gateway);
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  unregisterGateway(ACCOUNT_ID, gw);
  return sent;
}

const SINGLE_QUESTION_PAYLOAD = {
  text: 'Question for you:\n\n甲\n选哪个？\n1. Yes\n2. No\n\nReply with the number or option text.',
  channelData: { askUser: { questionId: QID, optionValues: ['Yes', 'No'] } },
};

const MULTI_QUESTION_TEXT = [
  'Question for you:',
  '',
  '1. 甲', '第一题？', '1. a1', '2. a2',
  '',
  '2. 乙', '第二题？', '1. b1', '2. b2',
  '',
  'Reply by number or question id. Use a declared option where choices are fixed.',
].join('\n');

const MULTI_QUESTION_PAYLOAD = {
  text: MULTI_QUESTION_TEXT,
  channelData: { askUser: { questionId: QID } },
};

// ── 1. 单问题卡：被动回复 ──

group('1. 单问题卡 → 被动回复（锚点 = 本轮 inbound msg_id）');

await test('单问题卡带显式锚点 + keyboard + passiveOnly', async () => {
  clearQuotaCache();
  const messageId = 'M_SINGLE_1';
  const sent = await deliverAskUser(SINGLE_QUESTION_PAYLOAD, { messageId });
  assert.equal(sent.length, 1, `应只发一条问题卡，实际 ${sent.length}`);
  const call = sent[0]!;
  assert.equal(call.opts?.msgId, messageId, '问题卡必须挂本轮 inbound 的 msg_id（被动回复）');
  assert.ok((call.opts?.msgSeq ?? 0) >= 1, '被动回复必须带单调发号的 msg_seq');
  assert.equal(call.opts?.passiveOnly, true, '首尝试必须是 passiveOnly（锚点不可用时才降级主动）');
  assert.ok(call.opts?.keyboard, '问题卡必须带 keyboard');
  assert.ok(
    (call.opts?.keyboard?.content?.rows ?? []).length > 0,
    'keyboard 必须有按钮行',
  );
});

// ── 2. 多问题卡：每张都带同一个锚点 ──

group('2. 多问题卡 → 每张都挂同一个锚点');

await test('2 张卡都带同一 msgId + keyboard', async () => {
  clearQuotaCache();
  const messageId = 'M_MULTI_1';
  const sent = await deliverAskUser(MULTI_QUESTION_PAYLOAD, { messageId });
  assert.equal(sent.length, 2, `应发 2 张题卡，实际 ${sent.length}`);
  assert.ok(
    sent.every((s) => s.opts?.msgId === messageId),
    '每张题卡都应挂同一个显式锚点',
  );
  assert.ok(
    sent.every((s) => s.opts?.passiveOnly === true),
    '每张题卡首尝试都应 passiveOnly',
  );
  assert.ok(sent.every((s) => !!s.opts?.keyboard), '每张题卡都应带 keyboard');
});

// ── 3. 锚点不可用 → 降级主动 ──

group('3. 锚点不可用 → 降级为主动发送一次');

await test('本地 TTL 预检判死（窗口过期）⇒ 直接降级主动，且键盘保留', async () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'USER_123');
  const messageId = 'M_EXPIRED_1';
  // 登记一个**已过期**的窗口（c2c TTL 60min，接收时刻在 61min 前）
  cacheMsgId('c2c', 'USER_123', messageId, {
    accountId: ACCOUNT_ID,
    receivedAt: Date.now() - 61 * 60_000,
  });
  const sent = await deliverAskUser(SINGLE_QUESTION_PAYLOAD, { messageId });
  // 本地预检直接拦下被动请求（不触达平台）⇒ 只发一次主动形态
  assert.equal(sent.length, 1, `窗口过期应只发一次主动消息，实际 ${sent.length}`);
  const active = sent[0]!;
  assert.equal(active.opts?.msgId, undefined, '降级主动不得再挂锚点');
  assert.notEqual(active.opts?.passiveOnly, true, '降级主动不是 passiveOnly');
  assert.ok(active.opts?.keyboard, '降级主动必须保留 keyboard（否则用户无从作答）');
  clearMsgIdCache('c2c', 'USER_123');
});

await test('平台判死 40034005 ⇒ 降级主动重试一次（带 keyboard）', async () => {
  clearQuotaCache();
  const messageId = 'M_DEAD_1';
  const sent = await deliverAskUser(SINGLE_QUESTION_PAYLOAD, {
    messageId,
    gateway: { failMode: 'dead' },
  });
  assert.equal(sent.length, 2, `被动被判死后应降级主动重试一次，实际 ${sent.length}`);
  assert.equal(sent[0]!.opts?.msgId, messageId, '首次应带锚点');
  assert.equal(sent[1]!.opts?.msgId, undefined, '重试应走主动');
  assert.ok(sent[1]!.opts?.keyboard, '重试必须保留 keyboard');
});

await test('网络错（结果不明）⇒ 卡片不重发（避免重复）', async () => {
  clearQuotaCache();
  const messageId = 'M_NET_1';
  const sent = await deliverAskUser(SINGLE_QUESTION_PAYLOAD, {
    messageId,
    gateway: { failMode: 'network' },
  });
  // 卡片只尝试一次（带 keyboard 的调用恰好 1 次）；其后是既有的纯文本
  // 兜底与失败提示（无 keyboard），不是卡片重发。
  const cardCalls = sent.filter((s) => !!s.opts?.keyboard);
  assert.equal(cardCalls.length, 1, `网络错不得重发问题卡，实际卡片调用 ${cardCalls.length} 次`);
  assert.equal(cardCalls[0]!.opts?.msgId, messageId, '首次尝试应带锚点');
});

// ── 4. 多题后续（确认卡 / 状态回执）复用同一锚点 ──

group('4. 多题续卡 / 确认卡 / 状态回执 → 复用同一锚点');

function makeInteractionEvent(buttonData: string): any {
  return {
    id: `int-${Math.random().toString(36).slice(2, 8)}`,
    type: 11,
    data: { type: 11, resolved: { button_data: buttonData } },
    user_openid: 'USER_123',
    timestamp: new Date().toISOString(),
  };
}

const fakeLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => fakeLog,
} as any;

await test('状态回执（已记录 1/2）挂同一锚点', async () => {
  clearQuotaCache();
  const messageId = 'M_FEEDBACK_1';
  const { sent, gw } = installFakeGateway();
  registerPendingMultiQuestion(
    ACCOUNT_ID,
    QID,
    'c2c',
    'USER_123',
    [
      { header: '甲', question: '第一题？', options: ['a1', 'a2'] },
      { header: '乙', question: '第二题？', options: ['b1', 'b2'] },
    ],
    undefined,
    messageId,
  );
  try {
    await handleInteraction(
      makeInteractionEvent(`qqbot:qm:${QID}:0:0`),
      makeAccount(),
      makeFakeRuntime(),
      fakeLog,
      async () => {},
    );
    assert.equal(sent.length, 1, `应发一条状态回执，实际 ${sent.length}`);
    assert.equal(sent[0]!.opts?.msgId, messageId, '状态回执应复用登记时的锚点');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('确认卡（全部答完）挂同一锚点 + keyboard', async () => {
  clearQuotaCache();
  const messageId = 'M_CONFIRM_1';
  const { sent, gw } = installFakeGateway();
  registerPendingMultiQuestion(
    ACCOUNT_ID,
    QID,
    'c2c',
    'USER_123',
    [{ header: '甲', question: '第一题？', options: ['a1', 'a2'] }],
    undefined,
    messageId,
  );
  try {
    await handleInteraction(
      makeInteractionEvent(`qqbot:qm:${QID}:0:1`),
      makeAccount(),
      makeFakeRuntime(),
      fakeLog,
      async () => {},
    );
    assert.equal(sent.length, 1, `应发一张确认卡，实际 ${sent.length}`);
    assert.equal(sent[0]!.opts?.msgId, messageId, '确认卡应复用登记时的锚点');
    assert.ok(sent[0]!.opts?.keyboard, '确认卡必须带 keyboard');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('未登记锚点的 pending ⇒ 回执走主动（无 msg_id）', async () => {
  clearQuotaCache();
  const { sent, gw } = installFakeGateway();
  registerPendingMultiQuestion(
    ACCOUNT_ID,
    QID,
    'c2c',
    'USER_123',
    [
      { header: '甲', question: '第一题？', options: ['a1', 'a2'] },
      { header: '乙', question: '第二题？', options: ['b1', 'b2'] },
    ],
    undefined,
    undefined,
  );
  try {
    await handleInteraction(
      makeInteractionEvent(`qqbot:qm:${QID}:0:0`),
      makeAccount(),
      makeFakeRuntime(),
      fakeLog,
      async () => {},
    );
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.opts?.msgId, undefined, '无锚点时不得凭空挂 msg_id');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 5. 回归守卫：ask_user 出站不再走 SDK 直发 ──

group('5. 回归守卫：ask_user 出站不得回到 SDK 直发（主动形态）');

await test('dispatch.ts / event-handlers.ts 不再出现 sendTextWithKeyboard', () => {
  for (const file of ['src/dispatch/dispatch.ts', 'src/gateway/event-handlers.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(
      !src.includes('sendTextWithKeyboard'),
      `${file} 仍在用 SDK 直发（不带 msg_id ⇒ 主动消息），问题卡必须走 sendQuestionMessage`,
    );
  }
});

console.log(`\n${failed === 0 ? '✅' : '❌'} ask-user-passive-anchor: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('失败用例：\n  - ' + failedTests.join('\n  - '));
  process.exitCode = 1;
}
