/**
 * Progress Card（进度卡片）回归测试
 *
 * 覆盖：
 * 1. 渲染：normalizePlanSteps 宽容归一 + renderProgressCardText（头部 ✅/▸/▢、
 *    explanation 可选、超 maxLines 压缩为 N/M done 头）。
 * 2. 发布器：去重（无状态变化不重发）、防抖窗口、maxPerTurn 保险丝、
 *    清卡（steps=[]）停止/恢复、配额探测（剩余 ≤ reserve 跳过）、
 *    passive-quota-exhausted 静默丢弃、stop/dispose/abort 关闭。
 * 3. 配置解析：resolveProgressCardConfig 默认值/覆盖/非法值钳制。
 * 4. outbound sendText passiveOnly：配额耗尽返回 error 且不触达网关
 *    （不降级主动）；非 passiveOnly 维持原降级行为。
 * 5. dispatch 装配（真实 dispatchToOpenClaw）：c2c 默认启用挂 onPlanUpdate +
 *    suppressDefaultToolProgressMessages；群默认/scope 不匹配/enabled:false/
 *    room_event 不挂；端到端发送（被动挂 msgId）+ deliver final 停止发布。
 *
 * 运行方式: npx tsx tests/progress-card.test.ts
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

// ── 被测模块 ──

const {
  ProgressCardPublisher,
  normalizePlanSteps,
  renderProgressCardText,
} = await import('../src/outbound/progress-card-publisher.ts');
const { resolveProgressCardConfig } = await import('../src/config.ts');
const {
  checkAndConsumePassiveReplyQuota,
  clearQuotaCache,
} = await import('../src/features/quota-manager.ts');
const { dispatchToOpenClaw } = await import('../src/dispatch/dispatch.ts');
const { registerGateway, sendText } = await import('../src/outbound/outbound-service.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');

// ── 单元测试基础设施 ──

interface PublisherHarness {
  publisher: ProgressCardPublisher;
  sends: string[];
  remaining: () => number;
  setRemaining: (n: number) => void;
  failNext: () => void;
}

function makePublisher(overrides: {
  config?: Record<string, unknown>;
  signal?: AbortSignal;
} = {}): PublisherHarness {
  const sends: string[] = [];
  let remaining = 4;
  let failNext = false;
  const config = {
    enabled: true,
    scope: 'c2c' as const,
    minIntervalMs: 1500,
    maxPerTurn: 3,
    maxLines: 8,
    reserveQuota: 1,
    ...overrides.config,
  };
  const publisher = new ProgressCardPublisher({
    config: config as never,
    sendCard: async (text: string) => {
      if (failNext) {
        failNext = false;
        return { error: 'passive-quota-exhausted' };
      }
      sends.push(text);
      return {};
    },
    quotaRemaining: () => remaining,
    signal: overrides.signal,
    log: undefined,
  });
  return {
    publisher,
    sends,
    remaining: () => remaining,
    setRemaining: (n: number) => { remaining = n; },
    failNext: () => { failNext = true; },
  };
}

const STEPS_A = [
  { step: '分析现有包结构', status: 'completed' },
  { step: 'pack 8.0(覆盖 8.0.tar, 沿用现有 logs.txt)', status: 'in_progress' },
  { step: '运行回归测试', status: 'pending' },
  { step: '清理临时文件', status: 'pending' },
];

const STEPS_B = STEPS_A.map((s, i) =>
  i === 1 ? { ...s, status: 'completed' as const } : i === 2 ? { ...s, status: 'in_progress' as const } : s,
);

// ── 1. 渲染 ──

group('渲染');

await test('normalizePlanSteps：过滤非法条目、压缩空白', () => {
  const steps = normalizePlanSteps([
    { step: '  正常  步骤  ', status: 'pending' },
    { step: '', status: 'completed' },
    { step: 42, status: 'pending' },
    { step: '状态非法', status: 'done' },
    { step: '缺少状态' },
    'not-an-object',
    null,
  ] as never);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.step, '正常 步骤');
  assert.equal(steps[0]!.status, 'pending');
});

await test('渲染：头部 + ✅/▸/▢ 标记（无 explanation，2026.9.1 形态）', () => {
  const text = renderProgressCardText(normalizePlanSteps(STEPS_A));
  const lines = text.split('\n');
  assert.equal(lines[0], '📋 进度 1/4');
  assert.ok(lines[1]!.startsWith('✅ 分析现有包结构'));
  assert.ok(lines[2]!.startsWith('▸ pack 8.0(覆盖 8.0.tar, 沿用现有 logs.txt)'));
  assert.ok(lines[3]!.startsWith('▢ 运行回归测试'));
  assert.ok(lines[4]!.startsWith('▢ 清理临时文件'));
  assert.equal(lines.length, 5);
});

await test('渲染：explanation 存在时插在头部之后（前向兼容）', () => {
  const text = renderProgressCardText(normalizePlanSteps(STEPS_A), '失败隔离在会话所有权，无阻塞。');
  const lines = text.split('\n');
  assert.equal(lines[0], '📋 进度 1/4');
  assert.equal(lines[1], '失败隔离在会话所有权，无阻塞。');
  assert.ok(lines[2]!.startsWith('✅ '));
});

await test('渲染：超长 explanation 截断到 80 字符', () => {
  const long = 'x'.repeat(200);
  const text = renderProgressCardText(normalizePlanSteps(STEPS_A), long);
  const line = text.split('\n')[1]!;
  assert.ok(line.length <= 80, `explanation 行长度 ${line.length} 应 ≤ 80`);
  assert.ok(line.endsWith('…'));
});

await test('渲染：步骤超过 maxLines 压缩为 N/M done 头', () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    step: `步骤 ${i + 1}`,
    status: i < 5 ? ('completed' as const) : i === 5 ? ('in_progress' as const) : ('pending' as const),
  }));
  const text = renderProgressCardText(normalizePlanSteps(many), undefined, 8);
  const lines = text.split('\n');
  assert.equal(lines[0], '📋 进度 5/10');
  assert.equal(lines[1], '✅ 5/10 done');
  assert.ok(lines.includes('▸ 步骤 6'), '应保留当前步');
  assert.ok(lines.includes('▢ 步骤 10'), '应保留待办尾部');
  assert.ok(!lines.includes('✅ 步骤 1') && !lines.includes('✅ 步骤 2') && !lines.includes('✅ 步骤 3'),
    '早期完成步应被压缩掉');
});

// ── 2. 发布器行为 ──

group('发布器');

await test('状态更新即发送：步骤状态变化 → 新快照发出', async () => {
  const h = makePublisher({ config: { minIntervalMs: 0 } });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_B });
  assert.equal(h.sends.length, 2, '两次状态不同的更新各发一条');
  assert.ok(h.sends[0]!.includes('▸ pack 8.0'));
  assert.ok(h.sends[1]!.includes('✅ pack 8.0'));
});

await test('去重：相同状态的重复写卡不重发', async () => {
  const h = makePublisher();
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 1);
});

await test('防抖窗口：minIntervalMs 内的第二次不同渲染被跳过', async () => {
  const h = makePublisher({ config: { minIntervalMs: 60_000 } });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_B });
  assert.equal(h.sends.length, 1, '防抖窗口内只发首条');
});

await test('maxPerTurn 保险丝用尽后跳过', async () => {
  const h = makePublisher({ config: { minIntervalMs: 0, maxPerTurn: 2 } });
  const c1 = STEPS_A.map((s, i) => (i === 0 ? { ...s, status: 'in_progress' as const } : s));
  const c2 = STEPS_A.map((s, i) => (i === 0 ? { ...s, status: 'completed' as const } : i === 1 ? { ...s, status: 'in_progress' as const } : s));
  const c3 = STEPS_A.map((s, i) => (i < 2 ? { ...s, status: 'completed' as const } : i === 2 ? { ...s, status: 'in_progress' as const } : s));
  await h.publisher.onPlanUpdate({ phase: 'update', steps: c1 });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: c2 });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: c3 });
  assert.equal(h.sends.length, 2, 'maxPerTurn=2 后停发');
});

await test('清卡：steps=[] 不发消息；后续非空 update 恢复发布', async () => {
  const h = makePublisher({ config: { minIntervalMs: 0 } });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: [] });
  assert.equal(h.sends.length, 1, '清卡本身不产生消息');
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_B });
  assert.equal(h.sends.length, 2, '清空后的新卡片恢复发布');
});

await test('配额：剩余额度 ≤ reserveQuota 跳过且不发送', async () => {
  const h = makePublisher();
  h.setRemaining(1); // reserve=1 → 1 ≤ 1 跳过
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 0);
  h.setRemaining(0);
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_B });
  assert.equal(h.sends.length, 0);
  h.setRemaining(2);
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 1, '额度恢复后可发送');
});

await test('passive-quota-exhausted：静默丢弃、无重试、不影响后续更新', async () => {
  const h = makePublisher({ config: { minIntervalMs: 0 } });
  h.failNext();
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 0, '被拒的卡片被丢弃');
  assert.equal(h.publisher.sentCards, 0);
  // 未记为已发送 → 同状态重试可再发
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 1, '同状态重试成功发送');
});

await test('发送异常：丢弃该条卡片不抛错', async () => {
  const publisher = new ProgressCardPublisher({
    config: { enabled: true, scope: 'c2c', minIntervalMs: 1500, maxPerTurn: 3, maxLines: 8, reserveQuota: 1 } as never,
    sendCard: async () => { throw new Error('QQ API unavailable'); },
    quotaRemaining: () => 4,
  });
  await assert.doesNotReject(publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A }));
  assert.equal(publisher.sentCards, 0);
});

await test('stop() 后 onPlanUpdate no-op', async () => {
  const h = makePublisher();
  h.publisher.stop('final delivery started');
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 0);
});

await test('dispose() 后不再发布', async () => {
  const h = makePublisher();
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  h.publisher.dispose();
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_B });
  assert.equal(h.sends.length, 1);
});

await test('abort 信号中止后不发送', async () => {
  const controller = new AbortController();
  controller.abort();
  const h = makePublisher({ signal: controller.signal });
  await h.publisher.onPlanUpdate({ phase: 'update', steps: STEPS_A });
  assert.equal(h.sends.length, 0);
});

await test('phase !== "update" 忽略', async () => {
  const h = makePublisher();
  await h.publisher.onPlanUpdate({ phase: 'other', steps: STEPS_A });
  await h.publisher.onPlanUpdate({ steps: STEPS_A });
  await h.publisher.onPlanUpdate(undefined as never);
  assert.equal(h.sends.length, 0);
});

// ── 3. 配置解析 ──

group('配置解析');

await test('缺省默认值：enabled=true / scope=c2c / 1500ms / 3 / 8 / 1', () => {
  const cfg = resolveProgressCardConfig({ config: {} } as never);
  assert.deepEqual(cfg, {
    enabled: true,
    scope: 'c2c',
    minIntervalMs: 1500,
    maxPerTurn: 3,
    maxLines: 8,
    reserveQuota: 1,
  });
});

await test('账号级覆盖', () => {
  const cfg = resolveProgressCardConfig({
    config: { progressCard: { enabled: false, scope: 'both', minIntervalMs: 300, maxPerTurn: 5, maxLines: 6, reserveQuota: 2 } },
  } as never);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.scope, 'both');
  assert.equal(cfg.minIntervalMs, 300);
  assert.equal(cfg.maxPerTurn, 5);
  assert.equal(cfg.maxLines, 6);
  assert.equal(cfg.reserveQuota, 2);
});

await test('非法数值钳制回默认（maxPerTurn 0.x 向下取整视为显式 0=禁发）', () => {
  const cfg = resolveProgressCardConfig({
    config: { progressCard: { minIntervalMs: -5, maxPerTurn: 0.7, maxLines: 0, reserveQuota: 'x' as never } },
  } as never);
  assert.equal(cfg.minIntervalMs, 1500, '负数 → 默认');
  assert.equal(cfg.maxPerTurn, 0, '0.7 floor=0（显式禁发语义）');
  assert.equal(cfg.maxLines, 8, '0 → 默认 8');
  assert.equal(cfg.reserveQuota, 1, '非数值 → 默认');
});

// ── 4. outbound sendText passiveOnly ──

group('outbound passiveOnly');

await test('配额耗尽 + passiveOnly → 返回 error 且不触达网关（不降级主动）', async () => {
  clearQuotaCache();
  const accountId = 'pc-passive-only';
  const msgId = 'pc-msg-1';
  const gwCalls: unknown[] = [];
  registerGateway(accountId, {
    sendText: async (...args: unknown[]) => {
      gwCalls.push(args);
      return { id: 'x' };
    },
    sendMedia: async () => ({ id: 'm' }),
  } as never);
  // 耗尽 c2c 4 条被动配额
  for (let i = 0; i < 4; i++) {
    assert.equal(checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' }).canReply, true);
  }
  const result = await sendText({
    to: 'qqbot:c2c:USER_X',
    text: '卡片',
    replyToId: msgId,
    account: { accountId, config: {} } as never,
    passiveOnly: true,
  });
  assert.equal(result.error, 'passive-quota-exhausted');
  assert.equal(gwCalls.length, 0, '网关不应被调用');
});

await test('配额耗尽 + 非 passiveOnly → 维持原行为（降级主动发送）', async () => {
  clearQuotaCache();
  const accountId = 'pc-passive-fallback';
  const msgId = 'pc-msg-2';
  const gwCalls: Array<{ msgId?: string }> = [];
  registerGateway(accountId, {
    sendText: async (target: { msgId?: string }) => {
      gwCalls.push(target);
      return { id: 'x' };
    },
    sendMedia: async () => ({ id: 'm' }),
  } as never);
  for (let i = 0; i < 4; i++) {
    checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
  }
  const result = await sendText({
    to: 'qqbot:c2c:USER_X',
    text: '正文',
    replyToId: msgId,
    account: { accountId, config: {} } as never,
  });
  assert.equal(result.error, undefined);
  assert.equal(gwCalls.length, 1);
  assert.equal(gwCalls[0]!.msgId, undefined, '降级主动：不带 msgId');
});

// ── 5. dispatch 装配（真实 dispatchToOpenClaw）──

group('dispatch 装配');

interface CapturedDispatch {
  replyOptions?: any;
  dispatcherOptions?: { deliver?: (payload: unknown, info?: { kind?: string }) => Promise<void> };
}

/**
 * 构造 fake runtime。midRun 钩子在 dispatchReply mock 内部执行——真实框架里
 * plan 事件（onPlanUpdate）与 deliver 都发生在 agent run 进行中、
 * dispatchToOpenClaw 返回（publisher dispose）之前，必须在该时机触发。
 */
function makeFakeRuntime(captured: CapturedDispatch, midRun?: (captured: CapturedDispatch) => Promise<void> | void) {
  return {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          const plan = params.adapter.resolveTurn({}, 'provider_message_sending', {});
          await plan.runDispatch();
          return { dispatched: true };
        },
        buildContext: (params: any) => ({ ...params, __built: true }),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: async (params: any) => {
          captured.replyOptions = params.replyOptions;
          captured.dispatcherOptions = params.dispatcherOptions;
          if (midRun) await midRun(captured);
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

function makeMsgAndCtx(overrides: { scope?: 'group' | 'c2c'; groupOpenid?: string } = {}) {
  const scope = overrides.scope ?? 'c2c';
  const msg = {
    kind: scope === 'group' ? 'group' : 'c2c',
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    content: 'hello',
    senderId: scope === 'group' ? 'USER_A' : 'USER_123',
    senderName: 'Tester',
    attachments: [],
    replyTarget: { scope, targetId: scope === 'group' ? (overrides.groupOpenid ?? 'GROUP_1') : 'USER_123' },
    ...(scope === 'group' ? { groupOpenid: overrides.groupOpenid ?? 'GROUP_1', rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [] } : {}),
    timestamp: Date.now(),
  } as any;
  const ctx = { state: {}, message: { content: 'hello' }, signal: undefined } as any;
  return { msg, ctx };
}

function makeAccount(overrides: { scope?: 'group' | 'c2c'; progressCard?: unknown; groups?: Record<string, unknown> } = {}): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: false,
      ...(overrides.progressCard !== undefined ? { progressCard: overrides.progressCard } : {}),
      ...(overrides.groups ? { groups: overrides.groups } : {}),
    },
  };
}

function installFakeGateway() {
  const sentTexts: Array<{ target: any; text: string; opts: any }> = [];
  registerGateway('test-account', {
    sendText: async (target: any, text: string, opts?: any) => {
      sentTexts.push({ target, text, opts });
      return { id: `out-${sentTexts.length}`, timestamp: Date.now() };
    },
    sendMedia: async () => ({ id: 'media-out', timestamp: Date.now() }),
  } as never);
  return { sentTexts };
}

async function runDispatch(opts: {
  account: any;
  msg: any;
  ctx: any;
  midRun?: (captured: CapturedDispatch) => Promise<void> | void;
}): Promise<CapturedDispatch> {
  _resetAdaptersCache();
  const captured: CapturedDispatch = {};
  await dispatchToOpenClaw(opts.ctx, opts.msg, opts.account, makeFakeRuntime(captured, opts.midRun));
  return captured;
}

await test('c2c 默认启用：replyOptions 挂 onPlanUpdate + suppressDefaultToolProgressMessages', async () => {
  installFakeGateway();
  const captured = await runDispatch({ account: makeAccount(), msg: makeMsgAndCtx().msg, ctx: makeMsgAndCtx().ctx });
  assert.equal(typeof captured.replyOptions?.onPlanUpdate, 'function');
  assert.equal(captured.replyOptions?.suppressDefaultToolProgressMessages, true);
});

await test('端到端：onPlanUpdate → 卡片消息被动发送（挂入站 msgId）', async () => {
  clearQuotaCache();
  const { sentTexts } = installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx();
  await runDispatch({
    account: makeAccount(),
    msg,
    ctx,
    midRun: async (captured) => {
      await captured.replyOptions!.onPlanUpdate({ phase: 'update', steps: STEPS_A });
    },
  });
  const card = sentTexts.find((s) => s.text.startsWith('📋 进度'));
  assert.ok(card, '应发出卡片消息');
  assert.ok(card!.text.includes('▸ pack 8.0(覆盖 8.0.tar, 沿用现有 logs.txt)'));
  assert.equal(card!.opts?.msgId, msg.messageId, '卡片走被动回复（挂 msgId）');
});

await test('端到端：deliver kind=final 后停止卡片发布（kind=tool 不停止）', async () => {
  clearQuotaCache();
  const { sentTexts } = installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx();
  await runDispatch({
    account: makeAccount(),
    msg,
    ctx,
    midRun: async (captured) => {
      // verbose 工具进度通知：不停止发布
      await captured.dispatcherOptions!.deliver!({ text: '工具进度通知' }, { kind: 'tool' });
      await captured.replyOptions!.onPlanUpdate({ phase: 'update', steps: STEPS_A });
      // final 投递：停止发布
      await captured.dispatcherOptions!.deliver!({ text: '最终答案' }, { kind: 'final' });
      await captured.replyOptions!.onPlanUpdate({ phase: 'update', steps: STEPS_B });
    },
  });
  assert.equal(sentTexts.filter((s) => s.text.startsWith('📋 进度')).length, 1, 'tool 通知后可发送、final 后不再发卡片');
});

await test('群默认（scope=c2c）不挂 onPlanUpdate', async () => {
  installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group' });
  const captured = await runDispatch({ account: makeAccount(), msg, ctx });
  assert.equal(captured.replyOptions?.onPlanUpdate, undefined);
  assert.equal(captured.replyOptions?.suppressDefaultToolProgressMessages, undefined);
});

await test('群 + scope=both 挂 onPlanUpdate', async () => {
  installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group' });
  const captured = await runDispatch({
    account: makeAccount({ progressCard: { scope: 'both' } }),
    msg,
    ctx,
  });
  assert.equal(typeof captured.replyOptions?.onPlanUpdate, 'function');
});

await test('enabled=false 不挂 onPlanUpdate', async () => {
  installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx();
  const captured = await runDispatch({
    account: makeAccount({ progressCard: { enabled: false } }),
    msg,
    ctx,
  });
  assert.equal(captured.replyOptions?.onPlanUpdate, undefined);
});

await test('room_event 群不挂 onPlanUpdate（结构性无卡片）', async () => {
  installFakeGateway();
  const { msg, ctx } = makeMsgAndCtx({ scope: 'group', groupOpenid: 'GROUP_ROOM' });
  const captured = await runDispatch({
    account: makeAccount({
      progressCard: { scope: 'both' },
      groups: { GROUP_ROOM: { unmentionedInbound: 'room_event' } },
    }),
    msg,
    ctx,
  });
  assert.equal(captured.replyOptions?.sourceReplyDeliveryMode, 'message_tool_only', '前置：确实是 room_event turn');
  assert.equal(captured.replyOptions?.onPlanUpdate, undefined);
});

// ── 汇总 ──

console.log(`\n${'='.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
