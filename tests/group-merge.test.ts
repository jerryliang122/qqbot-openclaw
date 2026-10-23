/**
 * 群消息插件侧合批 回归测试
 *
 * 覆盖：
 * 1. 忙碌信号（features/group-session-busy.ts）：计数增减、归零回调、
 *    多 turn 在途时只在最后一个归零时触发。
 * 2. 配置解析（config.ts resolveGroupConfigFromAccount）：strategy /
 *    maxBatchSize / maxHoldMs 的回落链（群级 > 通配群 > 账号级 > 默认）。
 * 3. 合批装配（body-assembler assembleMergedGroupBody）：逐条归属 +
 *    **单份**历史块（直接拼 N 条 agentBody 会让历史重复 N 次）。
 * 4. 集成（真实框架 debouncer + 真实 dispatchToOpenClaw）：
 *    - 空闲零延迟：群消息立即直发（不缓冲）；
 *    - 跨发言人合批：busy 期间 3 个不同 sender 的消息 → turn 结束后
 *      **一次** dispatch，正文含 3 段、各段 sender 标签正确；
 *    - 单份历史：批内 2 条均带历史 → 历史块只出现一次；
 *    - 容量与丢弃：12 条 → 保留最新 10 条 + 丢弃说明；
 *    - 旁路不合并：斜杠命令 / 控制命令（stop）立即直发，且 pending
 *      buffer 先冲刷（保序）；
 *    - 跨群隔离：两个群的批次互不干扰；
 *    - 前缀归位：room_event turn 的 transcript 体（AmbientTranscriptBody）
 *      **不含** `#<messageId>` 前缀，且 AmbientTranscriptMessageId 仍是
 *      真实消息 id；
 *    - 失败不丢批：dispatch 抛错 → busy 归零 → 批次仍被冲刷。
 *
 * 运行方式: npx tsx tests/group-merge.test.ts
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
 * ref'd 定时器，事件循环会在 flush 前空转退出。等待任何依赖 flush
 * timer 的 promise 时用本 helper 挂一个 ref'd 心跳。
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
  enqueueGroupInboundMessage,
  flushGroupMergeQueue,
  flushAllGroupMergeQueues,
  resetGroupMergeStateForTest,
  DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE,
  DEFAULT_GROUP_MERGE_MAX_HOLD_MS,
} = await import('../src/features/group-merge.ts');
const {
  markGroupTurnStarted,
  markGroupTurnFinished,
  isGroupBusy,
  onGroupIdle,
  resetGroupBusyStateForTests,
} = await import('../src/features/group-session-busy.ts');
const { assembleMergedGroupBody } = await import('../src/dispatch/body-assembler.ts');
const { resolveGroupConfigFromAccount } = await import('../src/config.ts');
const { _resetAdaptersCache } = await import('../src/adapter/resolve.ts');
const { registerGateway } = await import('../src/outbound/outbound-service.ts');

// ── 测试基础设施（对齐 inbound-debounce.test.ts）──

interface CapturedInbound {
  params: any;
  ingest: any;
  ctxPayload: any;
  /** dispatchReply 收到的 replyOptions（sourceReplyDeliveryMode 等） */
  replyOptions?: any;
}

function makeFakeRuntime(captured: CapturedInbound[], hang?: Promise<void>) {
  let pendingCtxPayload: any;
  return {
    version: 'test',
    channel: {
      inbound: {
        run: async (params: any) => {
          captured.push({ params, ingest: params.adapter.ingest({}), ctxPayload: pendingCtxPayload });
          pendingCtxPayload = undefined;
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
          params?.replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          const last = captured[captured.length - 1];
          if (last) last.replyOptions = params?.replyOptions;
          return { queuedFinal: true, counts: { final: 1 } };
        },
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:group:${params.peer.id}`,
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

function makeGroupMsgAndCtx(overrides: {
  content?: string;
  senderId?: string;
  senderName?: string;
  groupId?: string;
  mentioned?: boolean;
  timestamp?: string;
  history?: Array<{ senderId: string; senderName?: string; content: string }>;
  voiceText?: string;
} = {}) {
  msgSeq += 1;
  const senderId = overrides.senderId ?? 'USER_A';
  const groupId = overrides.groupId ?? 'GROUP_X';
  const msg = {
    kind: 'group',
    messageId: `g-msg-${msgSeq}`,
    content: overrides.content ?? '',
    senderId,
    senderName: overrides.senderName ?? senderId,
    attachments: [],
    replyTarget: { scope: 'group', targetId: groupId },
    mentions: [],
    timestamp: overrides.timestamp ?? new Date().toISOString(),
    raw: {},
  } as any;
  const ctx = {
    state: {
      mention: { wasMentioned: overrides.mentioned === true, implicit: false },
      ...(overrides.history ? { history: overrides.history } : {}),
      ...(overrides.voiceText
        ? {
            processedAttachments: {
              voiceText: overrides.voiceText,
              imageUrls: [],
              otherInfo: '',
              transcripts: [],
              localMediaPaths: [],
              localMediaTypes: [],
              remoteMediaUrls: [],
              media: [],
            },
          }
        : {}),
    },
    message: { content: msg.content },
    signal: undefined,
  } as any;
  return { msg, ctx };
}

function makeAccount(coalesce?: any, groups?: any): any {
  return {
    accountId: 'test-account',
    appId: 'x',
    config: {
      deliverDebounce: { enabled: false },
      streaming: false,
      ...(coalesce !== undefined ? { groupCoalesce: coalesce } : {}),
      ...(groups !== undefined ? { groups } : {}),
    },
  };
}

function setupScenario(opts: {
  coalesce?: any;
  groups?: any;
  hang?: Promise<void>;
} = {}) {
  resetGroupMergeStateForTest();
  resetGroupBusyStateForTests();
  _resetAdaptersCache();
  installFakeGateway();
  const captured: CapturedInbound[] = [];
  const runtime = makeFakeRuntime(captured, opts.hang);
  return {
    account: makeAccount(opts.coalesce, opts.groups),
    runtime,
    captured,
  };
}

function fire(scenario: { account: any; runtime: any }, mc: { msg: any; ctx: any }): Promise<boolean> {
  return enqueueGroupInboundMessage(mc.ctx, mc.msg, scenario.account, scenario.runtime);
}

// ── 1. 忙碌信号 ──

group('忙碌信号：per-群 in-flight 计数 + 归零回调');

await test('计数增减正确', () => {
  resetGroupBusyStateForTests();
  assert.equal(isGroupBusy('acct', 'G1'), false);
  markGroupTurnStarted('acct', 'G1');
  assert.equal(isGroupBusy('acct', 'G1'), true);
  markGroupTurnFinished('acct', 'G1');
  assert.equal(isGroupBusy('acct', 'G1'), false);
});

await test('不同群的计数互不影响', () => {
  resetGroupBusyStateForTests();
  markGroupTurnStarted('acct', 'G1');
  assert.equal(isGroupBusy('acct', 'G1'), true);
  assert.equal(isGroupBusy('acct', 'G2'), false);
  markGroupTurnFinished('acct', 'G1');
});

await test('多个 turn 在途时只在最后一个归零时触发空闲回调', () => {
  resetGroupBusyStateForTests();
  let idleCount = 0;
  onGroupIdle('acct', 'G1', () => { idleCount += 1; });
  markGroupTurnStarted('acct', 'G1');
  markGroupTurnStarted('acct', 'G1');
  markGroupTurnFinished('acct', 'G1');
  assert.equal(idleCount, 0, '还有一个 turn 在途，不该触发空闲');
  markGroupTurnFinished('acct', 'G1');
  assert.equal(idleCount, 1, '最后一个 turn 结束应触发空闲');
});

// ── 2. 配置解析 ──

group('配置解析：strategy / maxBatchSize / maxHoldMs 回落链');

await test('默认：strategy=plugin，maxBatchSize=10，maxHoldMs=300000', () => {
  const cfg = resolveGroupConfigFromAccount(makeAccount(), 'GROUP_X');
  assert.equal(cfg.coalesce.enabled, true);
  assert.equal(cfg.coalesce.strategy, 'plugin');
  assert.equal(cfg.coalesce.maxBatchSize, 10);
  assert.equal(cfg.coalesce.maxHoldMs, 300_000);
  assert.equal(DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE, 10);
  assert.equal(DEFAULT_GROUP_MERGE_MAX_HOLD_MS, 300_000);
});

await test('群级配置覆盖账号级', () => {
  const account = makeAccount(
    { strategy: 'framework', maxBatchSize: 3, maxHoldMs: 1000 },
    { 'GROUP_X': { coalesce: { strategy: 'plugin', maxBatchSize: 5 } } },
  );
  const cfg = resolveGroupConfigFromAccount(account, 'GROUP_X');
  assert.equal(cfg.coalesce.strategy, 'plugin');
  assert.equal(cfg.coalesce.maxBatchSize, 5);
  assert.equal(cfg.coalesce.maxHoldMs, 1000, '未覆盖的字段回落账号级');
});

await test('通配群（"*"）兜底', () => {
  const account = makeAccount({ strategy: 'framework' }, { '*': { coalesce: { strategy: 'plugin' } } });
  const cfg = resolveGroupConfigFromAccount(account, 'GROUP_OTHER');
  assert.equal(cfg.coalesce.strategy, 'plugin');
});

// ── 3. 合批装配（纯函数）──

group('合批装配：逐条归属 + 单份历史');

await test('两条消息 → 两段归属标签', () => {
  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'U_ALICE', senderName: 'Alice', mentioned: true });
  const b = makeGroupMsgAndCtx({ content: '问题二', senderId: 'U_BOB', senderName: 'Bob' });
  const merged = assembleMergedGroupBody(
    [{ ctx: a.ctx, msg: a.msg }, { ctx: b.ctx, msg: b.msg }],
    makeAccount(),
  );
  assert.ok(merged.agentBody.includes('[消息 1/2]'), '缺分节头 1');
  assert.ok(merged.agentBody.includes('[消息 2/2]'), '缺分节头 2');
  assert.ok(merged.agentBody.includes('[Alice (U_ALICE)] 问题一 (@you)'), '缺 Alice 归属/(@you)');
  assert.ok(merged.agentBody.includes('[Bob (U_BOB)] 问题二'), '缺 Bob 归属');
});

await test('历史块只出现一次（不重复 N 份）', () => {
  const history = [{ senderId: 'X', senderName: 'X', content: '旧消息' }];
  const a = makeGroupMsgAndCtx({ content: '问题一', mentioned: true, history });
  const b = makeGroupMsgAndCtx({ content: '问题二', mentioned: true, history });
  const merged = assembleMergedGroupBody(
    [{ ctx: a.ctx, msg: a.msg }, { ctx: b.ctx, msg: b.msg }],
    makeAccount(),
  );
  const historyBlocks = merged.agentBody.split('[Chat history begins]').length - 1;
  assert.equal(historyBlocks, 1, `历史块应只出现一次，实际 ${historyBlocks} 次`);
  assert.ok(merged.agentBody.includes('旧消息'), '历史内容缺失');
});

await test('丢弃说明前置在正文最前', () => {
  const a = makeGroupMsgAndCtx({ content: '问题一' });
  const merged = assembleMergedGroupBody(
    [{ ctx: a.ctx, msg: a.msg }],
    makeAccount(),
    undefined,
    { droppedNote: '[已丢弃 2 条较早的群消息（批次上限 10）]' },
  );
  assert.ok(merged.agentBody.startsWith('[已丢弃 2 条较早的群消息'), '丢弃说明应前置');
});

// ── 4. 集成 ──

group('集成：空闲直发 / 跨发言人合批 / 容量 / 旁路 / 跨群隔离');

await test('空闲时群消息零延迟直发（不缓冲）', async () => {
  const scenario = setupScenario();
  const one = makeGroupMsgAndCtx({ content: '你好', mentioned: true });
  assert.equal(await keepAlive(fire(scenario, one)), true);
  assert.equal(scenario.captured.length, 1, `expected 1 dispatch, got ${scenario.captured.length}`);
  const { ingest } = scenario.captured[0]!;
  assert.ok(ingest.textForAgent.includes('你好'));
  assert.ok(!ingest.textForAgent.includes('[消息'), '单条不应有分节头');
});

await test('busy 期间 3 个不同 sender 的消息 → turn 结束后一次 dispatch', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang });

  // A：空闲 → 立即直发，turn 开始（busy=1），随后挂起
  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'U_ALICE', senderName: 'Alice', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);
  assert.equal(scenario.captured.length, 1, 'A 应已 dispatch');
  assert.equal(isGroupBusy('test-account', 'GROUP_X'), true, 'turn 在途期间应 busy');

  // B / C：busy → 进缓冲区
  const b = makeGroupMsgAndCtx({ content: '问题二', senderId: 'U_BOB', senderName: 'Bob' });
  const c = makeGroupMsgAndCtx({ content: '问题三', senderId: 'U_CAROL', senderName: 'Carol' });
  await fire(scenario, b);
  await fire(scenario, c);
  await sleep(30);
  assert.equal(scenario.captured.length, 1, 'busy 期间不应有新 dispatch');

  // turn 结束 → busy 归零 → 合批冲刷
  release();
  await keepAlive(pa);
  await keepAlive(sleep(120));

  assert.equal(scenario.captured.length, 2, `expected 2 dispatches (A + 合并批), got ${scenario.captured.length}`);
  // 第一条是空闲时单独 dispatch 的 A
  assert.ok(scenario.captured[0]!.ingest.textForAgent.includes('[Alice (U_ALICE)] 问题一'), 'A 应单独直发');
  // 第二条是合并批（B + C，跨发言人）
  const merged = scenario.captured[1]!;
  assert.ok(merged.ingest.textForAgent.includes('[消息 1/2]'), '缺分节头 1');
  assert.ok(merged.ingest.textForAgent.includes('[消息 2/2]'), '缺分节头 2');
  assert.ok(merged.ingest.textForAgent.includes('[Bob (U_BOB)] 问题二'), '缺 Bob 归属');
  assert.ok(merged.ingest.textForAgent.includes('[Carol (U_CAROL)] 问题三'), '缺 Carol 归属');
  // 载体 = 批内最后一条（最新到达）
  assert.equal(merged.params.raw.messageId, c.msg.messageId, '锚点应为批内最后一条');
});

await test('容量上限：12 条 → 保留最新 10 条 + 丢弃说明', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang, coalesce: { maxBatchSize: 10 } });

  const a = makeGroupMsgAndCtx({ content: '问题0', senderId: 'A', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);

  for (let i = 1; i <= 12; i += 1) {
    await fire(scenario, makeGroupMsgAndCtx({ content: `问题${i}`, senderId: `S${i}` }));
  }
  await sleep(30);
  release();
  await keepAlive(pa);
  await keepAlive(sleep(150));

  assert.equal(scenario.captured.length, 2, `expected 2 dispatches, got ${scenario.captured.length}`);
  const body = scenario.captured[1]!.ingest.textForAgent;
  assert.ok(body.includes('[已丢弃 2 条较早的群消息'), '缺丢弃说明');
  assert.ok(body.includes('[消息 1/10]'), '分节头总数应为 10');
  assert.ok(body.includes('[消息 10/10]'), '分节头总数应为 10');
  assert.ok(!body.includes('[消息 11/'), '不应保留超过 10 条');
});

await test('斜杠命令旁路：立即直发，pending buffer 先冲刷（保序）', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang });

  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'A', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);

  // 进 buffer 的普通群消息
  await fire(scenario, makeGroupMsgAndCtx({ content: '问题二', senderId: 'B' }));
  await sleep(20);

  // 斜杠命令：旁路 → 先冲刷 buffer 再执行命令
  const slash = makeGroupMsgAndCtx({ content: '/status', senderId: 'C' });
  await keepAlive(fire(scenario, slash));

  const bodies = scenario.captured.map((c) => c.ingest.textForAgent);
  const flushIdx = bodies.findIndex((b) => b.includes('问题二'));
  const slashIdx = bodies.findIndex((b) => b.includes('/status'));
  assert.ok(flushIdx >= 0, 'pending buffer 未被冲刷');
  assert.ok(slashIdx >= 0, '斜杠命令未 dispatch');
  assert.ok(flushIdx < slashIdx, 'buffer 应先于旁路项发出（保序）');

  release();
  await keepAlive(pa);
});

await test('两个群的批次互不干扰', async () => {
  let releaseG1!: () => void;
  const hangG1 = new Promise<void>((r) => { releaseG1 = r; });
  const scenario = setupScenario({ hang: hangG1 });

  // G1 的 turn 挂起（busy）
  const a = makeGroupMsgAndCtx({ content: 'G1问题一', groupId: 'GROUP_1', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);

  // G2 空闲 → 立即直发，不受 G1 影响
  const g2 = makeGroupMsgAndCtx({ content: 'G2问题一', groupId: 'GROUP_2', mentioned: true });
  await keepAlive(fire(scenario, g2));
  assert.equal(scenario.captured.length, 2, 'G2 应独立 dispatch');
  assert.ok(scenario.captured[1]!.ingest.textForAgent.includes('G2问题一'));

  releaseG1();
  await keepAlive(pa);
  await keepAlive(sleep(100));
});

await test('前缀归位：transcript 体不含 #<messageId>，且 messageId 仍可追溯', async () => {
  const scenario = setupScenario();
  const one = makeGroupMsgAndCtx({ content: '你好', senderId: 'A', mentioned: true });
  await keepAlive(fire(scenario, one));
  assert.equal(scenario.captured.length, 1);

  const { ctxPayload, params } = scenario.captured[0]!;
  const ambient = ctxPayload?.extra?.AmbientTranscriptBody ?? ctxPayload?.AmbientTranscriptBody;
  assert.ok(typeof ambient === 'string' && ambient.length > 0, '未设置 AmbientTranscriptBody');
  assert.ok(!ambient.includes('#'), `transcript 体不应含 # 前缀：${ambient}`);
  assert.ok(!ambient.includes(params.raw.messageId), 'transcript 体不应含消息 id');
  assert.ok(ambient.includes('你好'), 'transcript 体应含正文');

  const ambientId = ctxPayload?.extra?.AmbientTranscriptMessageId ?? ctxPayload?.AmbientTranscriptMessageId;
  assert.equal(ambientId, params.raw.messageId, 'AmbientTranscriptMessageId 应等于真实消息 id');
});

await test('同账号的第二个群也能在 turn 结束后冲刷（空闲订阅按群，不是按账号）', async () => {
  // 回归：debouncer 是账号级单例，若空闲订阅只在创建时挂首个群，
  // 同账号其它群攒的批永远等不到冲刷（busy 归零无回调 → 消息滞留到重启）。
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang });

  // 两个群各起一个 turn（都挂起 → busy）
  const g1a = makeGroupMsgAndCtx({ content: 'G1一', groupId: 'GROUP_1', senderId: 'UA', mentioned: true });
  const g2a = makeGroupMsgAndCtx({ content: 'G2一', groupId: 'GROUP_2', senderId: 'UB', mentioned: true });
  const p1 = fire(scenario, g1a);
  await sleep(20);
  const p2 = fire(scenario, g2a);
  await sleep(20);
  assert.equal(scenario.captured.length, 2, '两个群的起手消息各自 dispatch');

  // 两个群各攒一条
  await fire(scenario, makeGroupMsgAndCtx({ content: 'G1二', groupId: 'GROUP_1', senderId: 'UA' }));
  await fire(scenario, makeGroupMsgAndCtx({ content: 'G2二', groupId: 'GROUP_2', senderId: 'UB' }));
  await sleep(20);
  assert.equal(scenario.captured.length, 2, '攒批期间不应 dispatch');

  // 两个 turn 同时结束 → 两个群都应冲刷
  release();
  await keepAlive(Promise.all([p1, p2]));
  await keepAlive(sleep(150));

  assert.equal(scenario.captured.length, 4, `expected 4 dispatches (2 起手 + 2 攒批), got ${scenario.captured.length}`);
  const bodies = scenario.captured.map((c) => c.ingest.textForAgent);
  assert.ok(bodies.some((b) => b.includes('G1二')), 'G1 的攒批未发出');
  assert.ok(bodies.some((b) => b.includes('G2二')), 'G2 的攒批未发出');
});

await test('room_event 群：批内含「在叫 bot」的消息 → 整批按 user_request（不被压成静默）', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({
    hang,
    groups: { GROUP_X: { unmentionedInbound: 'room_event' } },
  });

  // 起手：一条被 @ 的消息（user_request），turn 挂起
  const a = makeGroupMsgAndCtx({ content: '被问的问题', senderId: 'UA', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);

  // 攒批：一条被 @ + 一条没叫 bot（room_event）
  await fire(scenario, makeGroupMsgAndCtx({ content: '被问的二', senderId: 'UB', mentioned: true }));
  await fire(scenario, makeGroupMsgAndCtx({ content: '随便聊聊', senderId: 'UC' }));
  await sleep(20);

  release();
  await keepAlive(pa);
  await keepAlive(sleep(150));

  assert.equal(scenario.captured.length, 2, `expected 2 dispatches, got ${scenario.captured.length}`);
  const merged = scenario.captured[1]!;
  assert.ok(merged.ingest.textForAgent.includes('被问的二'), '合并正文缺成员 1');
  assert.ok(merged.ingest.textForAgent.includes('随便聊聊'), '合并正文缺成员 2');
  assert.equal(
    merged.replyOptions?.sourceReplyDeliveryMode,
    undefined,
    '批内含被 @ 的消息 → 整批必须有回复权（不得被压成 message_tool_only）',
  );
});

await test('room_event 群：全是被动消息 → 整批按 room_event（严格投递）', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({
    hang,
    groups: { GROUP_X: { unmentionedInbound: 'room_event' } },
  });

  const a = makeGroupMsgAndCtx({ content: '随便聊聊', senderId: 'UA' });
  const pa = fire(scenario, a);
  await sleep(30);
  await fire(scenario, makeGroupMsgAndCtx({ content: '继续闲聊', senderId: 'UB' }));
  await sleep(20);

  release();
  await keepAlive(pa);
  await keepAlive(sleep(150));

  assert.equal(scenario.captured.length, 2, `expected 2 dispatches, got ${scenario.captured.length}`);
  const merged = scenario.captured[1]!;
  assert.equal(
    merged.replyOptions?.sourceReplyDeliveryMode,
    'message_tool_only',
    '全被动消息的批次应保持 room_event 语义',
  );
});

await test('dispatch 抛错 → busy 归零 → 批次仍被冲刷', async () => {
  const scenario = setupScenario();
  // 制造一次失败的 dispatch：adapters.inboundRun 抛错
  const failing = {
    ...scenario.runtime,
    channel: {
      ...scenario.runtime.channel,
      inbound: {
        ...scenario.runtime.channel.inbound,
        run: async () => { throw new Error('boom'); },
      },
    },
  } as any;

  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'A', mentioned: true });
  await keepAlive(enqueueGroupInboundMessage(a.ctx, a.msg, scenario.account, failing));
  await sleep(30);
  assert.equal(isGroupBusy('test-account', 'GROUP_X'), false, 'dispatch 失败后 busy 应归零');

  // 之后的群消息应能正常直发（未被永久压住）
  const b = makeGroupMsgAndCtx({ content: '问题二', senderId: 'B', mentioned: true });
  await keepAlive(fire(scenario, b));
  assert.ok(scenario.captured.length >= 1, '失败后应仍能 dispatch');
});

await test('退出冲刷：flushAllGroupMergeQueues 强制发出攒批消息', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang });

  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'A', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);
  await fire(scenario, makeGroupMsgAndCtx({ content: '问题二', senderId: 'B' }));
  await sleep(20);
  assert.equal(scenario.captured.length, 1, '攒批期间不应 dispatch');

  release();
  await keepAlive(pa);
  await keepAlive(flushAllGroupMergeQueues());
  await keepAlive(sleep(80));
  assert.equal(scenario.captured.length, 2, '退出冲刷应发出攒批消息');
});

await test('显式 flushGroupMergeQueue 可提前放行某群批次', async () => {
  let release!: () => void;
  const hang = new Promise<void>((r) => { release = r; });
  const scenario = setupScenario({ hang });

  const a = makeGroupMsgAndCtx({ content: '问题一', senderId: 'A', mentioned: true });
  const pa = fire(scenario, a);
  await sleep(30);
  await fire(scenario, makeGroupMsgAndCtx({ content: '问题二', senderId: 'B' }));
  await sleep(20);

  await keepAlive(flushGroupMergeQueue('test-account', 'GROUP_X'));
  await keepAlive(sleep(80));
  assert.equal(scenario.captured.length, 2, '显式冲刷应发出攒批消息');

  release();
  await keepAlive(pa);
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
