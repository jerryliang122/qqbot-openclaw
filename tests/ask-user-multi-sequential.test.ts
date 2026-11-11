/**
 * 多题顺序发题守卫（PR2 / issue #93 + 整单直提改造）
 *
 * 背景：改造前多题 ask_user 一次性把 2–3 张卡全发出去，答完还要再点一次
 * 「✅ 提交」（确认卡）。PR2 改成 **c2c 单聊顺序发题**：
 *
 * 1. 只发第 1 题，答完第 k 题才发第 k+1 题；
 * 2. 每题卡**只有选项按钮**（没有「✏️ 改一改」）——想改前面的题，在最后
 *    一题点预填按钮（「✍️ 其他」/「📝 填写模板」），输入框会带上全部已答
 *    内容，用户改哪行都行；
 * 3. **全部答齐即提交**：插件把已收集的答案组合成整单文本（`"1: 3\n2: 1"`），
 *    交给框架官方认领通道（`claimPendingAgentQuestionAnswer`）整单 resolve
 *    ——用户聊天里不再出现机器代发的 keyed 文本气泡，也没有确认卡。
 *
 * 本文件锁定：
 * - 首卡形态（收集态：type=1 选项，**无**「✍️ 其他」、**无**「✏️ 改一改」）
 * - 逐题推进（点选 → 续发下一题）
 * - 末题按钮形态（type=1 回调、**无** enter / **无** click_limit；预填按钮
 *   仍是指令型 type=2 + enter=false）
 * - **插件直提**：末题点选 / 末题打字 ⇒ 提交器收到组合好的整单文本 + 框架
 *   sessionKey；pending 终态；不再发卡
 * - 拦截层三形态（整单覆盖 / 形态错误 / 本题答案）
 * - 失败矩阵（提交失败保持武装可重试；already-resolved 终态）
 * - 红线守卫：**不代替用户作答**、**不合成入站消息**、提交只走官方认领通道
 *
 * 运行方式: npx tsx tests/ask-user-multi-sequential.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { MultiQuestionAnswer } from '../src/features/question-helpers.ts';

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
const { handleInteraction } = await import('../src/gateway/event-handlers.ts');
const {
  buildSequentialAnswerPrefix,
  buildSequentialFullAnswerDraft,
  buildSequentialFullAnswerText,
  buildMultiQuestionConfirmKeyboard,
  registerPendingMultiQuestion,
  getPendingMultiQuestionState,
  recordSequentialAnswer,
  recordSequentialTextAnswer,
  findPendingMultiQuestionByConversation,
  matchFullKeyedAnswer,
  containsKeyedAnswerLine,
  applyFullKeyedAnswer,
  markMultiQuestionResolved,
} = await import('../src/features/question-helpers.ts');
const { submitSequentialAnswers } = await import('../src/features/question-flow.ts');
const { setMultiQuestionSubmitterForTest } = await import('../src/features/question-submit.ts');
const { enqueueC2CInboundMessage } = await import('../src/features/inbound-debounce.ts');

// ── 假提交器（插件直提整单答案的替身）──

interface SubmitCall {
  sessionKey?: string;
  text: string;
}

let submitCalls: SubmitCall[] = [];
let submitBehavior: 'ok' | 'resolved' | 'throw' | 'invalid' = 'ok';

/**
 * 注入假提交器：记录 `{sessionKey, text}`，按 `submitBehavior` 决定返回值。
 * 真实实现走框架的 `claimPendingAgentQuestionAnswer`（同进程、需真框架
 * 状态），测试里用替身断言「插件交出去的整单文本 + sessionKey」。
 */
function installFakeSubmitter(): void {
  submitCalls = [];
  setMultiQuestionSubmitterForTest(async (params) => {
    submitCalls.push({ sessionKey: params.sessionKey, text: params.text });
    if (submitBehavior === 'throw') throw new Error('simulated submit failure');
    if (submitBehavior === 'invalid') {
      const err: any = new Error('invalid answer');
      err.code = 'INVALID_REQUEST';
      err.details = { reason: 'QUESTION_INVALID_ANSWER' };
      throw err;
    }
    if (submitBehavior === 'resolved') return false;
    return true;
  });
}

function uninstallFakeSubmitter(): void {
  setMultiQuestionSubmitterForTest(null);
  submitCalls = [];
}

// ── 测试基础设施（沿用 ask-user-passive-anchor.test.ts 的形态）──

const ACCOUNT_ID = 'test-account';
const QID = `ask_${'b'.repeat(32)}`;

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
  // ctx.signal 必须是真实 AbortSignal（群聊路径下 combinedAbortSignal 直接
  // 取 ctx.signal；给 undefined 会在 deliverHandler 读 `.aborted` 时抛错）
  const ctx = {
    state: {},
    message: { content: 'hello' },
    signal: new AbortController().signal,
  } as any;
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

function installFakeGateway() {
  const sent: RecordedSend[] = [];
  const gw: any = {
    sendText: async (target: any, text: string, sendOpts: any) => {
      sent.push({ target, text, opts: sendOpts });
      return { id: `out-${sent.length}` };
    },
    sendMedia: async () => ({ id: 'media-out' }),
  };
  registerGateway(ACCOUNT_ID, gw);
  return { sent, gw };
}

/** 投递一次 ask_user payload 并**保留** fake gateway（后续 interaction 复用） */
async function deliverAskUserKeepingGateway(payload: any, opts: { messageId: string }) {
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
  const { sent, gw } = installFakeGateway();
  await dispatchToOpenClaw(ctx, msg, account, runtime);
  return { sent, gw, account, runtime };
}

/**
 * 同会话派发一条**普通** c2c 入站消息（不投递任何 payload）——模拟
 * issue #99 里末题指令按钮代发的 keyed 作答文本到达 dispatch 的那一刻
 * （防抖关闭配置走直发路径，不经 shouldDebounce；本 helper 同样绕过
 * 防抖器，覆盖 dispatch 起点的兜底认领点）。
 */
async function dispatchPlainInbound(opts: { messageId: string; targetId?: string; content?: string }) {
  _resetAdaptersCache();
  const { msg, ctx } = makeMsgAndCtx({ ...opts, targetId: opts.targetId ?? 'USER_123' });
  if (opts.content !== undefined) {
    msg.content = opts.content;
    ctx.message = { content: opts.content };
  }
  const runtime = makeFakeRuntime({
    onInboundRun: async () => ({ dispatched: true }),
    dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
  });
  await dispatchToOpenClaw(ctx, msg, makeAccount(), runtime);
}

const fakeLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => fakeLog,
} as any;

function makeInteractionEvent(buttonData: string): any {
  return {
    id: `int-${Math.random().toString(36).slice(2, 8)}`,
    type: 11,
    data: { type: 11, resolved: { button_data: buttonData } },
    user_openid: 'USER_123',
    timestamp: new Date().toISOString(),
  };
}

async function tap(buttonData: string, account: any, runtime: any) {
  await handleInteraction(makeInteractionEvent(buttonData), account, runtime, fakeLog, async () => {});
}

function buttonsOf(call: RecordedSend): any[] {
  return (call.opts?.keyboard?.content?.rows ?? []).flatMap((r: any) => r.buttons ?? []);
}

function buttonByLabel(call: RecordedSend, label: string): any | undefined {
  return buttonsOf(call).find((b: any) => b.render_data?.label === label);
}

const THREE_QUESTION_TEXT = [
  'Question for you:',
  '',
  '1. 甲', '第一题？', '1. a1', '2. a2',
  '',
  '2. 乙', '第二题？', '1. b1', '2. b2',
  '',
  '3. 丙', '第三题？', '1. c1', '2. c2',
  '',
  'Reply by number or question id. Use a declared option where choices are fixed.',
].join('\n');

const THREE_QUESTION_PAYLOAD = {
  text: THREE_QUESTION_TEXT,
  channelData: { askUser: { questionId: QID } },
};

const TWO_QUESTION_WITH_OTHER_TEXT = [
  'Question for you:',
  '',
  '1. 甲', '第一题？', '1. a1', '2. a2',
  '',
  '2. 乙', '第二题？', '1. b1', '2. b2', 'Other: reply with your own answer.',
  '',
  'Reply by number or question id. Use a declared option where choices are fixed.',
].join('\n');

// ── 1. 首卡形态 ──

group('1. 首卡：只发第 1 题（收集态）');

await test('c2c 多题首轮只发 1 张卡，正文是「第 1/3 题」', async () => {
  clearQuotaCache();
  const { sent, gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_1' });
  try {
    assert.equal(sent.length, 1, `顺序发题首轮只应发 1 张卡，实际 ${sent.length}`);
    const call = sent[0]!;
    assert.equal(call.opts?.msgId, 'M_SEQ_1', '卡必须挂本轮 inbound 的 msg_id（被动回复）');
    assert.ok(call.opts?.keyboard, '卡必须带 keyboard');
    const body = String(call.text ?? '');
    assert.ok(body.includes('第 1/3 题'), '正文应是第 1 题');
    assert.ok(!body.includes('第 2/3 题'), '正文不得含第 2 题');
    assert.ok(!body.includes('第 3/3 题'), '正文不得含第 3 题');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('中间题：选项是回调型(type=1)，既无「✍️ 其他」也无「✏️ 改一改」', async () => {
  clearQuotaCache();
  const { sent, gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_2' });
  try {
    const buttons = buttonsOf(sent[0]!);
    const optionButtons = buttons.filter((b: any) => b.render_data.label.startsWith('①') || b.render_data.label.startsWith('②'));
    assert.equal(optionButtons.length, 2, '中间题应有 2 个选项按钮');
    assert.equal(optionButtons[0].action.type, 1, '中间题选项必须是回调型（type=1）');
    assert.equal(optionButtons[0].action.data, `qqbot:qm:${QID}:0:0`, '选项回调 data 沿用旧契约');
    assert.equal(optionButtons[1].action.data, `qqbot:qm:${QID}:0:1`);
    assert.ok(!buttons.some((b: any) => b.render_data.label.includes('其他')), '中间题不给「✍️ 其他」按钮（框架要求整单齐备）');
    assert.ok(!buttons.some((b: any) => b.render_data.label.includes('改一改')), '中间题不得挂「✏️ 改一改」（回改统一走最后一题「✍️ 其他」）');
    assert.equal(buttons.length, 2, '中间题只有选项按钮，不得多挂别的入口');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 2. 逐题推进 ──

group('2. 逐题推进：答完第 k 题才发第 k+1 题');

await test('点第 1 题选项 → 续发第 2 题卡（仍是收集态，挂同一锚点）', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_3' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    assert.equal(sent.length, 2, `点完第 1 题应续发第 2 题卡，实际 ${sent.length}`);
    const second = sent[1]!;
    assert.equal(second.opts?.msgId, 'M_SEQ_3', '续卡复用同一个显式锚点');
    assert.ok(String(second.text).includes('第 2/3 题'), '续卡应是第 2 题');
    const options = buttonsOf(second).filter((b: any) => b.action.type === 1 && b.action.data.startsWith('qqbot:qm:'));
    assert.equal(options[0].action.data, `qqbot:qm:${QID}:1:0`, '第 2 题选项回调 data');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('续卡发送失败 ⇒ 回执含全量手打草稿，不静默（评审 F1）', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_F1' });
  try {
    // 让第 2 题卡（续卡）发送失败；其余消息（含失败回执本身）正常发出——
    // 模拟「卡发送持续失败但纯文本仍可达」的不对称故障形态
    const origSendText = gw.sendText.bind(gw);
    gw.sendText = async (target: any, text: string, sendOpts: any) => {
      if (String(text).includes('第 2/3 题')) throw new Error('simulated send failure');
      return origSendText(target, text, sendOpts);
    };
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    const feedback = sent.find((s) => String(s.text).includes('下一题发送失败'));
    assert.ok(feedback, '续卡失败必须回执——点选后石沉大海 = 流程静默死路');
    assert.ok(String(feedback.text).includes('1: 1'), '回执草稿应带已答部分（填值）');
    assert.ok(String(feedback.text).includes('2: '), '回执草稿未答题留空供用户补全');
    assert.ok(!feedback.opts?.keyboard, '回执是纯文本（尽力而为，不带键盘）');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('点第 2 题选项 → 续发最后一题卡（提交态：type=1 回调 + 预填按钮）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_4' });
  try {
    await tap(`qqbot:qm:${QID}:0:1`, account, runtime); // 第 1 题选第 2 项（a2）
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项（b1）
    assert.equal(sent.length, 3, `应发到第 3 题卡，实际 ${sent.length}`);
    const last = sent[2]!;
    const body = String(last.text);
    assert.ok(body.includes('第 3/3 题'), '第三张应是最后一题');
    assert.ok(body.includes('选完即提交全部答案'), '最后一题正文要点明「选完即提交」');
    assert.ok(body.includes('甲'), '最后一题正文应展示已记录的前序答案');

    const options = buttonsOf(last).filter((b: any) => b.render_data.label.startsWith('①') || b.render_data.label.startsWith('②'));
    assert.equal(options.length, 2, '最后一题应有 2 个选项按钮');
    // 末题选项 = 回调型（与中间题同构）：点选只记答案，提交由插件直提
    assert.equal(options[0].action.type, 1, '最后一题选项必须是回调型（type=1）');
    assert.equal(options[0].action.data, `qqbot:qm:${QID}:2:0`, '选项回调 data 沿用旧契约');
    assert.equal(options[1].action.data, `qqbot:qm:${QID}:2:1`);
    assert.equal(options[0].action.enter, undefined, '回调型按钮不得带 enter');
    assert.equal(options[0].action.click_limit, undefined, '回调型按钮不设 click_limit（没有客户端代发）');
    assert.equal(submitCalls.length, 0, '还没答完不得提交');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('最后一题不出现「✅ 提交」确认卡（提交点就是最后一题卡本身）', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_5' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime);
    const last = sent[2]!;
    const labels = buttonsOf(last).map((b: any) => b.render_data.label);
    assert.ok(!labels.some((l: string) => l.includes('提交')), `不应再有「✅ 提交」按钮，实际：${labels.join('、')}`);
    assert.ok(!String(last.text).includes('答案确认'), '不应再有确认卡正文');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 3. 「✍️ 其他」（仅最后一题）──

group('3. 最后一题的「✍️ 其他」：指令型 + enter=false + 预填前缀');

await test('最后一题带「✍️ 其他」，data 预填「1: x\\n2: 」供手打补充', async () => {
  clearQuotaCache();
  const payload = {
    text: TWO_QUESTION_WITH_OTHER_TEXT,
    channelData: { askUser: { questionId: QID } },
  };
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(payload, { messageId: 'M_SEQ_6' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项 → 前缀 "1: 1"
    assert.equal(sent.length, 2, '两题应发到最后一题卡');
    const last = sent[1]!;
    const other = buttonByLabel(last, '✍️ 其他');
    assert.ok(other, '最后一题必须带「✍️ 其他」');
    assert.equal(other.action.type, 2, '「✍️ 其他」是指令型（type=2）');
    assert.equal(other.action.enter, false, '「✍️ 其他」必须 enter=false（填入输入框由用户手打）');
    assert.equal(other.action.data, '1: 1\n2: ', '预填内容 = 前序答案 + 本题题号');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('末题**无 isOther** 时也有预填按钮（「📝 填写模板」）：填进输入框、不自动发送', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_FILL_1' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    const last = sent[2]!;
    const fill = buttonByLabel(last, '📝 填写模板');
    assert.ok(fill, '末题必须带预填按钮——预填能力不依赖题面有没有「其他」选项');
    assert.equal(fill.action.type, 2, '预填按钮是指令型（type=2）');
    assert.equal(fill.action.enter, false, '必须 enter=false（填入输入框、由用户手动发送）');
    assert.equal(fill.action.click_limit, undefined, '只预填不发消息，不设 click_limit');
    assert.equal(fill.action.data, '1: 1\n2: 1\n3: ', '预填内容 = 全部已答 + 本题空位（与正文模板同源）');
    // 正文必须写清怎么用，且不得指引不存在的「✍️ 其他」
    const body = String(last.text);
    assert.ok(body.includes('📝 填写模板'), '正文要写明预填按钮怎么用');
    assert.ok(!body.includes('✍️ 其他'), '非 isOther 题不得指引不存在的「✍️ 其他」按钮');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('整组都没有「其他」选项时，中间题正文不得提「✍️ 其他」（按钮根本不存在）', async () => {
  clearQuotaCache();
  const { sent, gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_6B' });
  try {
    const body = String(sent[0]!.text);
    assert.ok(!body.includes('✍️ 其他'), '没有该按钮时正文不得指引用户去点它');
    assert.ok(!body.includes('改一改'), '不得再指引已移除的「✏️ 改一改」');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('中间题正文指引「直接回复一句话作答」，不指引只在末题存在的「✍️ 其他」', async () => {
  clearQuotaCache();
  const payload = {
    text: TWO_QUESTION_WITH_OTHER_TEXT,
    channelData: { askUser: { questionId: QID } },
  };
  const { sent, gw } = await deliverAskUserKeepingGateway(payload, { messageId: 'M_SEQ_6D' });
  try {
    const body = String(sent[0]!.text);
    // sequential-text-answer 改造：文本作答是**每张卡**的入口（pending 武装
    // 期间入站文本被消费为当前题答案），不再指路到最后一题的「✍️ 其他」
    assert.ok(body.includes('直接回复一句话作为本题答案'), '中间题正文要写明文本作答入口');
    assert.ok(!body.includes('✍️ 其他'), '中间题不得指引只在末题存在的「✍️ 其他」');
    assert.ok(!body.includes('改一改'), '不得再指引已移除的「✏️ 改一改」');
    assert.ok(!buttonsOf(sent[0]!).some((b: any) => b.render_data.label.includes('其他')), '中间题本身不得有「✍️ 其他」按钮');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('最后一题正文给出可复制的手打兜底模板（末题留空，评审 F2）', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_6C' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime);
    const body = String(sent[2]!.text);
    assert.ok(body.includes('或直接回复下面这段提交'), '最后一题应给出手打兜底指引');
    assert.ok(body.includes('1: 1\n2: 1\n3: '), '兜底模板应是全量 keyed 形态（前序填值、末题留空）');
    assert.ok(
      !body.includes('你的答案'),
      '模板不得带占位文案——ask_user 恒 isOther，占位文案会被框架当自由文本静默收单；'
        + '末题留空则被 validateAnswers 拒绝并重问（与「✍️ 其他」预填同口径）',
    );
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 4. 「✏️ 改一改」已移除 ──

group('4. 「✏️ 改一改」已移除：回改统一走最后一题的「✍️ 其他」');

await test('首卡 / 中间卡 / 最后一题卡都不出现「✏️ 改一改」按钮', async () => {
  clearQuotaCache();
  const payload = {
    text: TWO_QUESTION_WITH_OTHER_TEXT,
    channelData: { askUser: { questionId: QID } },
  };
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(payload, { messageId: 'M_SEQ_7' });
  try {
    assert.ok(!buttonsOf(sent[0]!).some((b: any) => b.render_data.label.includes('改一改')), '首卡不得有「✏️ 改一改」');
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 答第 1 题 → 续发最后一题
    const last = sent[sent.length - 1]!;
    assert.ok(!buttonsOf(last).some((b: any) => b.render_data.label.includes('改一改')), '最后一题不得有「✏️ 改一改」');
    assert.ok(!String(last.text).includes('改一改'), '最后一题正文不得指引已移除的按钮');
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('源码里不再有「qqbot:qme:」回调前缀与回改状态机', () => {
  for (const file of [
    'src/features/question-card.ts',
    'src/features/question-helpers.ts',
    'src/features/question-flow.ts',
    'src/gateway/event-handlers.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(!src.includes('qqbot:qme:'), `${file} 不得再出现「qqbot:qme:」回调前缀`);
    assert.ok(!src.includes('beginSequentialEdit'), `${file} 不得再有回改态入口`);
    assert.ok(!src.includes('editingIndex'), `${file} 不得再有回改态字段`);
  }
});

await test('点更早那张卡的选项 ⇒ 记答案并重发当前卡（刷新已记录展示）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_9' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    const lastBefore = sent[2]!;
    assert.ok(String(lastBefore.text).includes('第 3/3 题'));
    // 回头改第 1 题（点更早那张卡上的选项）
    await tap(`qqbot:qm:${QID}:0:1`, account, runtime); // 改成第 2 项
    assert.equal(sent.length, 4, '应重发当前卡刷新已记录展示');
    const lastAfter = sent[3]!;
    assert.ok(String(lastAfter.text).includes('第 3/3 题'), '重发的应是当前（最后一题）卡');
    const st = getPendingMultiQuestionState(QID)!;
    assert.deepEqual(st.answers.get(0), { optionIndex: 1 }, '第 1 题的答案必须被改后的覆盖');
    assert.equal(submitCalls.length, 0, '还有一题没答，不得提交');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 5. keyed 文本口径与状态机单测 ──

group('5. keyed 答案文本口径 + 状态机');

await test('buildSequentialAnswerPrefix：数字=选项序号(1-based)，非数字=自由文本', () => {
  const answers = new Map<number, MultiQuestionAnswer>([
    [0, { optionIndex: 1 }],
    [1, { text: '我自己写的' }],
  ]);
  assert.equal(buildSequentialAnswerPrefix(answers, 3), '1: 2\n2: 我自己写的');
});

await test('buildSequentialFullAnswerDraft：已答填值、未答留空（F1 回执草稿）', () => {
  const answers = new Map<number, MultiQuestionAnswer>([
    [0, { optionIndex: 1 }],
    [2, { text: '自定义' }],
  ]);
  assert.equal(buildSequentialFullAnswerDraft(answers, 3), '1: 2\n2: \n3: 自定义');
});

await test('recordSequentialAnswer：正常推进 / 点更早题回到流程位置 / 越界保护', () => {
  registerPendingMultiQuestion(
    ACCOUNT_ID,
    QID,
    'c2c',
    'USER_123',
    [
      { header: '甲', question: 'q1', options: ['a1', 'a2'] },
      { header: '乙', question: 'q2', options: ['b1', 'b2'] },
      { header: '丙', question: 'q3', options: ['c1', 'c2'] },
    ],
    undefined,
    undefined,
    'sequential',
  );
  // 正常：答第 1 题 → 下一张是第 2 题
  let r = recordSequentialAnswer(QID, 0, 1);
  assert.equal(r.status, 'ok');
  assert.equal((r as any).nextIndex, 1);
  // 改更早的题（点更早那张卡）⇒ 回到流程位置（重发当前卡）
  r = recordSequentialAnswer(QID, 0, 0);
  assert.equal(r.status, 'ok');
  assert.equal((r as any).nextIndex, 1, '改更早的题后应回到流程位置');
  // 越界题号
  r = recordSequentialAnswer(QID, 7, 0);
  assert.equal(r.status, 'unknown');
  // 未登记
  assert.equal(recordSequentialAnswer(`ask_${'c'.repeat(32)}`, 0, 0).status, 'unknown');
});

await test('getPendingMultiQuestionState：暴露 cursor，且没有回改态字段', () => {
  const state = getPendingMultiQuestionState(QID);
  assert.ok(state, 'pending 应可读');
  assert.equal(state!.mode, 'sequential');
  assert.equal(state!.cursor, 1, 'cursor 停在流程位置');
  assert.ok(!('editingIndex' in state!), '快照不得再暴露回改态字段');
});

// ── 6. 红线守卫 ──

group('6. 红线守卫');

await test('不得调用不存在的多题提交 API（resolveAnswers 一类）', () => {
  for (const file of [
    'src/features/question-flow.ts',
    'src/features/question-helpers.ts',
    'src/gateway/event-handlers.ts',
    'src/dispatch/dispatch.ts',
    'src/features/question-submit.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(
      !/resolveAnswers\s*\(/.test(src),
      `${file} 不得调用不存在的多题提交 API（2026-08-24 事故红线）`,
    );
  }
});

await test('提交必须走框架官方认领通道（不得自造提交入口）', () => {
  const submitSrc = readFileSync(new URL('../src/features/question-submit.ts', import.meta.url), 'utf-8');
  assert.ok(
    submitSrc.includes("import('openclaw/plugin-sdk/agent-harness-runtime')"),
    '提交器必须走 openclaw/plugin-sdk/agent-harness-runtime 的 claimPendingAgentQuestionAnswer',
  );
  assert.ok(
    submitSrc.includes('claimPendingAgentQuestionAnswer'),
    '提交器必须调用 claimPendingAgentQuestionAnswer',
  );
  const flowSrc = readFileSync(new URL('../src/features/question-flow.ts', import.meta.url), 'utf-8');
  assert.ok(
    flowSrc.includes('submitMultiQuestionAnswer('),
    '提交动作必须收敛到 submitMultiQuestionAnswer（单一入口）',
  );
});

await test('顺序发题不得合成入站消息（不得出现 inbound 注入入口）', () => {
  for (const file of ['src/features/question-flow.ts', 'src/features/question-submit.ts']) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(
      !/enqueueC2CInboundMessage|enqueueGroupInboundMessage/.test(src),
      `${file} 不得合成入站消息（会被 steer 进 ask_user-suspended run）`,
    );
  }
});

await test('提交文本只能来自用户真实作答（答案值不得由插件编造）', () => {
  // 提交器的入参只有「sessionKey + text」，text 必须由已记录的答案组合而成
  const flowSrc = readFileSync(new URL('../src/features/question-flow.ts', import.meta.url), 'utf-8');
  assert.ok(
    flowSrc.includes('buildSequentialFullAnswerText(state.answers, total)'),
    '提交文本必须由已记录的答案组合（buildSequentialFullAnswerText）',
  );
  const helpersSrc = readFileSync(new URL('../src/features/question-helpers.ts', import.meta.url), 'utf-8');
  assert.ok(
    helpersSrc.includes('export function buildSequentialFullAnswerText('),
    '组合函数必须存在（每题必有值，缺答即 null）',
  );
});

await test('顺序发题只在 c2c 生效（群聊仍旧路径）', () => {
  const src = readFileSync(new URL('../src/dispatch/dispatch.ts', import.meta.url), 'utf-8');
  assert.ok(
    /const sequential = scope === 'c2c'/.test(src),
    'dispatch 必须按 scope 区分：c2c 顺序发题、群聊旧路径',
  );
});

// ── 7. 插件直提整单答案（c2c 顺序发题）──

group('7. 插件直提：整单答案交给框架官方认领通道');

await test('发卡那一轮不自清：ask_user 投递后 pending 仍武装', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_1' });
  try {
    assert.equal(sent.length, 1, '顺序发题首轮只发 1 张卡');
    const pending = findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123');
    assert.ok(pending, '发卡那一轮的 dispatch 起点不得清掉自己（deliver 回调里）刚登记的 pending');
    assert.equal(pending!.questionId, QID);
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('pending 登记必须带上 route.sessionKey（提交器的查表键）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SK_1' });
  try {
    const state = getPendingMultiQuestionState(QID);
    assert.ok(state, 'pending 可读');
    // 假 runtime 的 resolveAgentRoute 返回 `qqbot:test:<peerId>`
    assert.equal(state!.sessionKey, 'qqbot:test:USER_123', 'pending 必须带上框架 sessionKey');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('末题点选 ⇒ 提交器收到组合好的整单文本 + sessionKey；pending 终态；不再发卡', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_1' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    assert.equal(sent.length, 3, '应发到最后一题卡');
    const before = sent.length;
    await tap(`qqbot:qm:${QID}:2:0`, account, runtime); // 第 3 题选第 1 项 ⇒ 全部答齐
    assert.equal(submitCalls.length, 1, '全部答齐必须提交一次');
    assert.equal(submitCalls[0]!.text, '1: 1\n2: 1\n3: 1', '提交器收到组合好的整单文本');
    assert.equal(submitCalls[0]!.sessionKey, 'qqbot:test:USER_123', '提交必须带框架 sessionKey');
    assert.equal(sent.length, before, '提交后不得再发卡（末题不再有确认卡）');
    assert.equal(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      undefined,
      '提交成功后 pending 终态（旁路失效，恢复防抖合并）',
    );
    assert.equal(
      recordSequentialAnswer(QID, 0, 0).status,
      'terminal',
      '终态后继续点旧卡应按 terminal 处理',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('末题打字 ⇒ 拦截层消费（不进框架）⇒ 提交器收到整单文本 ⇒ pending 终态', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_2' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_SUB_2_ANSWER', targetId: 'USER_123' });
    msg.content = '第三个答案';
    ctx.message = { content: '第三个答案' };
    let inboundRuns = 0;
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => { inboundRuns++; return { dispatched: true }; },
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(handled, true, '末题文本作答必须被接管');
    assert.equal(inboundRuns, 0, '不得转发框架成轮');
    assert.equal(submitCalls.length, 1, '末题答完必须提交');
    assert.equal(submitCalls[0]!.text, '1: 1\n2: 1\n3: 第三个答案', '整单文本 = 前序答案 + 本题自由文本');
    assert.equal(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      undefined,
      '提交成功后 pending 终态',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('「改一改」预填后发送整单形态文本 ⇒ 前面题的答案被替换 ⇒ 提交器收到替换后的文本', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_3' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    assert.equal(sent.length, 3);
    const before = sent.length;
    // 用户改完「1: 1\n2: 1\n3: 」后整段发出（改了第 1 题、补了第 3 题）
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_SUB_3_EDIT', targetId: 'USER_123' });
    msg.content = '1: 2\n2: 1\n3: 我改的答案';
    ctx.message = { content: msg.content };
    let inboundRuns = 0;
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => { inboundRuns++; return { dispatched: true }; },
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(handled, true, '整单形态文本必须被接管');
    assert.equal(inboundRuns, 0, '整单形态文本不得转发框架');
    assert.equal(submitCalls.length, 1, '整单覆盖后全部答齐 ⇒ 提交');
    assert.equal(submitCalls[0]!.text, '1: 2\n2: 1\n3: 我改的答案', '提交文本必须是改后的答案');
    assert.equal(sent.length, before, '提交后不得再发卡');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('「改一改」文本形态错误（含题号行但行数不对）⇒ 回执格式错误、不提交、pending 保持武装', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_4' });
  try {
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_SUB_4_BAD', targetId: 'USER_123' });
    msg.content = '1: 1\n2: 2';
    ctx.message = { content: msg.content };
    let inboundRuns = 0;
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => { inboundRuns++; return { dispatched: true }; },
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(handled, true, '形态错误的文本仍被接管（不得转发框架）');
    assert.equal(inboundRuns, 0, '不得转发框架');
    assert.equal(submitCalls.length, 0, '形态错误不得提交');
    const receipt = sent.find((s) => String(s.text).includes('格式不对'));
    assert.ok(receipt, '必须回执格式错误');
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      'pending 保持武装（用户可改完重发）',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('「改一改」文本某题留空 ⇒ 回执要求补全、不提交（不得把「N: 」当答案）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_5' });
  try {
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_SUB_5_EMPTY', targetId: 'USER_123' });
    msg.content = '1: 1\n2: 2\n3: ';
    ctx.message = { content: msg.content };
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => ({ dispatched: true }),
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(submitCalls.length, 0, '空值行不得提交（框架会把它当字面量「3:」静默收下）');
    const receipt = sent.find((s) => String(s.text).includes('每道题都要填上答案'));
    assert.ok(receipt, '必须回执要求补全');
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      'pending 保持武装',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('提交失败（提交器抛错）⇒ 回执「提交失败」+ pending 保持武装（可重试）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  submitBehavior = 'throw';
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_6' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime);
    await tap(`qqbot:qm:${QID}:2:0`, account, runtime);
    assert.equal(submitCalls.length, 1, '前置：确实提交过一次');
    const receipt = sent.find((s) => String(s.text).includes('提交失败'));
    assert.ok(receipt, '必须回执提交失败');
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      'pending 保持武装（用户可再次点选重试）',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('提交器返回 already-resolved ⇒ 回执「已过期」+ pending 终态 + 不再发卡', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  submitBehavior = 'resolved';
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SUB_7' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime);
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime);
    const before = sent.length;
    await tap(`qqbot:qm:${QID}:2:0`, account, runtime);
    const receipt = sent.find((s) => String(s.text).includes('已提交或已过期'));
    assert.ok(receipt, '必须回执已提交或已过期');
    assert.equal(sent.length, before + 1, '只多一条回执，不再发卡');
    assert.equal(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      undefined,
      'pending 终态（问卷已结束）',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('无关文本不认领：pending 不终态，卡片流程继续存活', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_2B' });
  try {
    // 用户没点按钮，先发了条无关文本（"这题什么意思？"）——**入队口**路径：
    // 文本被本地暂存为当前题答案、不转发框架。
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_I99_2B_ASK', targetId: 'USER_123' });
    msg.content = '这题什么意思？';
    ctx.message = { content: msg.content };
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => ({ dispatched: true }),
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      '无关文本不得认领 pending（无条件置终态会打死顺序发题状态机）',
    );
    assert.equal(submitCalls.length, 0, '无关文本不得触发提交');
    // 卡片流程确实还活着：点选仍被受理（不是 terminal）
    const r = recordSequentialAnswer(QID, 0, 0);
    assert.equal(r.status, 'ok', '无关文本后点选第 1 题仍应正常推进');
    void runtime;
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('matchFullKeyedAnswer：整单形态逐项判定（行数 + 题号顺序，值可空）', () => {
  const questions = [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2', 'b3'] },
    { header: '丙', question: 'q3', options: ['c1'], isOther: true },
  ];
  const cases: Array<{ text: string; expected: boolean; why: string }> = [
    { text: '1: 1\n2: 3\n3: 自由文本', expected: true, why: '标准形态' },
    { text: '1: 2\n2: 1\n3: 1', expected: true, why: 'isOther 题用序号作答也合法' },
    { text: '1: 1\n2: 1', expected: false, why: '行数不足 3' },
    { text: '1: 1\n2: 1\n3: 1\n4: 1', expected: false, why: '行数超题数' },
    { text: '1: 3\n2: 1\n3: 1', expected: true, why: '越界数字按自由文本收' },
    { text: '1: 1\n2: 1\n3: ', expected: true, why: '末题空值——形态合法（值为空由提交前自检拦下）' },
    { text: '1：1\n2：1\n3：1', expected: false, why: '全角冒号不算 keyed 行' },
    { text: '第一题: 1\n第二题: 1\n第三题: 1', expected: false, why: '非题号 key' },
    { text: '2: 1\n1: 1\n3: 1', expected: false, why: '题号乱序' },
  ];
  for (const { text, expected, why } of cases) {
    const got = matchFullKeyedAnswer(questions, text);
    assert.equal(got !== null, expected, `「${text.replace(/\n/g, '⏎')}」应${expected ? '命中整单' : '不命中'}：${why}`);
  }
  // 命中时返回「题号 → 值」映射（值 trim，空值是空串）
  const full = matchFullKeyedAnswer(questions, '1: 1\n2: 3\n3: ')!;
  assert.equal(full.get(0), '1');
  assert.equal(full.get(1), '3');
  assert.equal(full.get(2), '', '空值是空串（不是 undefined）');
});

await test('containsKeyedAnswerLine：形态错误判定（含题号行但非整单）', () => {
  assert.equal(containsKeyedAnswerLine('1: 1\n2: 2'), true);
  assert.equal(containsKeyedAnswerLine('这题什么意思？'), false);
  assert.equal(containsKeyedAnswerLine('随便写点东西'), false);
  assert.equal(containsKeyedAnswerLine('1：全角冒号'), false);
});

await test('applyFullKeyedAnswer：空值视为未答 ⇒ 拒绝覆盖（保持武装）', () => {
  const qid = `ask_apply_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_APPLY', [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
  ], 5000);
  assert.equal(
    applyFullKeyedAnswer(qid, new Map([[0, '1'], [1, '  ']])),
    false,
    '任一题空值 ⇒ 拒绝覆盖',
  );
  assert.equal(
    applyFullKeyedAnswer(qid, new Map([[0, '1'], [1, '随便写']])),
    true,
    '全部有值 ⇒ 覆盖成功',
  );
  const st = getPendingMultiQuestionState(qid)!;
  assert.deepEqual(st.answers.get(0), { optionIndex: 0 }, '数字落在选项范围内 ⇒ 选项序号');
  assert.deepEqual(st.answers.get(1), { text: '随便写' }, '非数字 ⇒ 自由文本');
});

await test('buildSequentialFullAnswerText：每题必有值，缺答即 null', () => {
  const answers = new Map<number, MultiQuestionAnswer>([
    [0, { optionIndex: 1 }],
    [1, { text: '我自己写的' }],
  ]);
  assert.equal(buildSequentialFullAnswerText(answers, 3), null, '缺题 ⇒ null（不得提交缺题的整单）');
  const full = new Map<number, MultiQuestionAnswer>([
    [0, { optionIndex: 1 }],
    [1, { text: '我自己写的' }],
    [2, { optionIndex: 0 }],
  ]);
  assert.equal(buildSequentialFullAnswerText(full, 3), '1: 2\n2: 我自己写的\n3: 1');
});

await test('源码守卫：旧认领机制已退役（客户端不再代发 keyed 副本）', () => {
  for (const file of [
    'src/features/question-helpers.ts',
    'src/features/inbound-debounce.ts',
    'src/dispatch/dispatch.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(
      !src.includes('claimPendingMultiQuestionIfKeyedAnswer'),
      `${file} 不得再调用已退役的认领入口`,
    );
    assert.ok(
      !src.includes('isDuplicateClaimedKeyedAnswerDelivery'),
      `${file} 不得再有 keyed 副本丢弃窗口（客户端不再代发 ⇒ 无副本；重复提交由框架 claim 幂等覆盖）`,
    );
  }
});

await test('源码守卫：拦截层三形态齐备 + 放行判定只做旁路不认领', () => {
  const debounceSrc = readFileSync(new URL('../src/features/inbound-debounce.ts', import.meta.url), 'utf-8');
  assert.ok(debounceSrc.includes('matchFullKeyedAnswer('), '拦截层必须识别整单形态');
  assert.ok(debounceSrc.includes('containsKeyedAnswerLine('), '拦截层必须识别形态错误');
  assert.ok(debounceSrc.includes('recordSequentialTextAnswer('), '拦截层必须识别本题答案形态');
  assert.ok(debounceSrc.includes('submitSequentialAnswers('), '拦截层的末题分支必须提交');
  const dispatchSrc = readFileSync(new URL('../src/dispatch/dispatch.ts', import.meta.url), 'utf-8');
  assert.ok(
    !/claimPendingMultiQuestionIfKeyedAnswer/.test(dispatchSrc),
    'dispatch 起点不得再有兜底认领（提交由插件完成）',
  );
});

// ── 8. 按钮形态（末题不再有客户端代发）──

group('8. 按钮形态：末题选项 = 回调型，预填按钮仍是指令型');

await test('末题选项：type=1 回调、无 enter、无 click_limit；预填按钮 type=2 + enter=false', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const payload = {
    text: TWO_QUESTION_WITH_OTHER_TEXT,
    channelData: { askUser: { questionId: QID } },
  };
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(payload, { messageId: 'M_I99_3' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 答第 1 题 → 续发最后一题
    const last = sent[1]!;
    const options = buttonsOf(last).filter((b: any) => b.render_data.label.startsWith('①') || b.render_data.label.startsWith('②'));
    assert.equal(options.length, 2, '末题应有 2 个选项按钮');
    for (const b of options) {
      assert.equal(b.action.type, 1, '末题选项是回调型（type=1）——不再让客户端代发机器文本');
      assert.equal(b.action.enter, undefined, '回调型按钮不得带 enter');
      assert.equal(
        b.action.click_limit,
        undefined,
        '回调型按钮不设 click_limit——没有客户端代发 ⇒ 不存在连点重复投递',
      );
    }
    const other = buttonByLabel(last, '✍️ 其他');
    assert.ok(other, '末题带「✍️ 其他」');
    assert.equal(other.action.type, 2, '预填按钮是指令型（type=2）');
    assert.equal(other.action.enter, false, '预填按钮 enter=false（只填输入框）');
    assert.equal(
      other.action.click_limit,
      undefined,
      '「✍️ 其他」只预填不发消息，不设 click_limit（清空输入框后再要一次模板是真实用法）',
    );
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('群确认卡键盘：「✅ 提交」click_limit=1；「✏️ 改一改」不设（legacy 路径不动）', () => {
  const kb: any = buildMultiQuestionConfirmKeyboard('1: 3\n2: 1');
  const buttons = (kb.content.rows ?? []).flatMap((r: any) => r.buttons ?? []);
  const submit = buttons.find((b: any) => b.id === 'confirm_submit');
  const edit = buttons.find((b: any) => b.id === 'confirm_edit');
  assert.ok(submit && edit, '确认卡应有「✅ 提交」与「✏️ 改一改」两个按钮');
  assert.equal(submit.action.click_limit, 1, '「✅ 提交」每次点击代发答案文本，必须限一次');
  assert.equal(edit.action.click_limit, undefined, '「✏️ 改一改」只预填输入框，可重复点');
});

// ── 9. 文本作答 ──

group('9. 文本作答：直接回复一句话即作答，末题收齐即提交');

await test('recordSequentialTextAnswer：压平单行 / 推进 cursor / 末题收齐返回 complete', () => {
  const qid = `ask_text_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_TEXT', [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
    { header: '丙', question: 'q3', options: ['c1', 'c2'] },
  ], 5000);
  // 多行压平为单行（整单文本一行一题，多行自由文本会打乱行数）
  let r = recordSequentialTextAnswer(qid, '就选\na 吧  ');
  assert.equal(r.status, 'ok');
  assert.equal((r as any).nextIndex, 1, '答完第 1 题 cursor 前进');
  assert.equal(
    (getPendingMultiQuestionState(qid)!.answers.get(0) as { text: string }).text,
    '就选 a 吧',
    '多行压平为单行',
  );
  r = recordSequentialTextAnswer(qid, '第二个答案');
  assert.equal((r as any).nextIndex, 2, '答完第 2 题推进到第 3 题');
  // 末题文本作答 → 全部收齐
  r = recordSequentialTextAnswer(qid, '3');
  assert.equal(r.status, 'complete', '末题收齐返回 complete');
  const st = getPendingMultiQuestionState(qid);
  assert.ok(st, 'pending 保持武装（终态由提交结果决定）');
  assert.equal((st!.answers.get(2) as { text: string }).text, '3');
  // 空文本 / 未登记
  assert.equal(recordSequentialTextAnswer(qid, '   ').status, 'unknown', '空文本不作答');
  assert.equal(recordSequentialTextAnswer(`ask_x_${'9'.repeat(30)}`, 'x').status, 'unknown', '未登记 unknown');
  // 终态后按 terminal 处理
  markMultiQuestionResolved(qid);
  assert.equal(recordSequentialTextAnswer(qid, '再来一句').status, 'terminal', '已终态后按 terminal 处理');
});

await test('末题文本作答 ⇒ 直接提交：不再出现「✅ 提交」确认卡', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_TEXT_1' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_TEXT_1_ANSWER', targetId: 'USER_123' });
    msg.content = '第三个答案';
    ctx.message = { content: msg.content };
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => ({ dispatched: true }),
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(submitCalls.length, 1, '末题答完必须提交');
    const labels = sent.flatMap((s) => buttonsOf(s).map((b: any) => String(b.render_data?.label ?? '')));
    assert.ok(!labels.some((l) => l.includes('提交')), `不应再有「✅ 提交」按钮，实际：${labels.join('、')}`);
    assert.ok(!sent.some((s) => String(s.text).includes('答案确认')), '不应再有确认卡正文');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('submitSequentialAnswers：缺答不提交（incomplete）', async () => {
  clearQuotaCache();
  installFakeSubmitter();
  const qid = `ask_inc_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_INC', [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
  ], 5000, 'M_INC_ANCHOR', 'sequential', 'qqbot:test:USER_INC');
  const { gw } = installFakeGateway();
  try {
    const state = getPendingMultiQuestionState(qid)!;
    const outcome = await submitSequentialAnswers({
      state,
      account: makeAccount(),
      to: 'qqbot:c2c:USER_INC',
    });
    assert.equal(outcome.status, 'incomplete', '缺答 ⇒ 不提交');
    assert.equal(submitCalls.length, 0, '缺答不得调提交器');
  } finally {
    uninstallFakeSubmitter();
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

// ── 结果 ──

console.log('\n' + '='.repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('全部通过');
