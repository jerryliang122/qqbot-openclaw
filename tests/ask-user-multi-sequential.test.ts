/**
 * 多题顺序发题守卫（PR2 / issue #93）
 *
 * 背景：改造前多题 ask_user 一次性把 2–3 张卡全发出去，答完还要再点一次
 * 「✅ 提交」（确认卡）。PR2 改成 **c2c 单聊顺序发题**：
 *
 * 1. 只发第 1 题，答完第 k 题才发第 k+1 题；
 * 2. 每题卡**只有选项按钮**（没有「✏️ 改一改」）——想改前面的题，在最后
 *    一题点「✍️ 其他」，输入框会带上全部已答内容，用户改哪行都行；
 * 3. 最后一题卡**本身就是提交点**——选项按钮是指令型（type=2,
 *    enter=true），data 写全量 keyed 答案文本（`"1: 3\n2: 1"`），
 *    客户端以真实用户身份发出 ⇒ 框架 keyed 认领 ⇒ 确认卡整个消失。
 *
 * 本文件锁定：
 * - 首卡形态（收集态：type=1 选项，**无**「✍️ 其他」、**无**「✏️ 改一改」）
 * - 逐题推进（点选 → 续发下一题）
 * - 最后一题提交态（type=2 + enter=true，data 带全量答案）
 * - 自由作答指引（正文写清「想自己写答案怎么办」，且只在按钮真实存在时提）
 * - 「✏️ 改一改」已移除（按钮、回调前缀、状态机全部不存在）
 * - keyed 答案文本口径（数字=选项序号 1-based / 非数字=自由文本）
 * - 红线守卫：**不程序化提交**、**不合成入站消息**
 * - issue #99：多题 pending 在同会话下一条入站时置终态（keyed 旁路失效、
 *   恢复防抖合并）；提交型按钮（末题选项 / 群确认卡「✅ 提交」）带
 *   click_limit=1 防连点重复发送
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
  buildMultiQuestionConfirmKeyboard,
  registerPendingMultiQuestion,
  getPendingMultiQuestionState,
  recordSequentialAnswer,
  recordSequentialTextAnswer,
  findPendingMultiQuestionByConversation,
  claimPendingMultiQuestionIfKeyedAnswer,
  isDuplicateClaimedKeyedAnswerDelivery,
} = await import('../src/features/question-helpers.ts');
const { renderSequentialTextConfirmCard, sendSequentialTextConfirmCard } =
  await import('../src/features/question-flow.ts');
const { enqueueC2CInboundMessage } = await import('../src/features/inbound-debounce.ts');

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

await test('点第 2 题选项 → 续发最后一题卡（提交态：type=2 + enter=true + 全量答案）', async () => {
  clearQuotaCache();
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
    assert.equal(options[0].action.type, 2, '最后一题选项必须是指令型（type=2）');
    assert.equal(options[0].action.enter, true, '最后一题选项必须 enter=true（点击即代发）');
    // 第 1 题选了第 2 项（序号 2）、第 2 题选了第 1 项（序号 1）、本题选第 1 项（序号 1）
    assert.equal(options[0].action.data, '1: 2\n2: 1\n3: 1', 'data 必须是全量 keyed 答案文本');
    assert.equal(options[1].action.data, '1: 2\n2: 1\n3: 2', '每个选项按钮携带自己那一档的全量答案');
  } finally {
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

await test('点更早那张卡的选项 ⇒ 记答案并重发当前卡（刷新全量提交文本）', async () => {
  clearQuotaCache();
  const { sent, gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_SEQ_9' });
  try {
    await tap(`qqbot:qm:${QID}:0:0`, account, runtime); // 第 1 题选第 1 项
    await tap(`qqbot:qm:${QID}:1:0`, account, runtime); // 第 2 题选第 1 项
    const lastBefore = sent[2]!;
    const optionBefore = buttonsOf(lastBefore).find((b: any) => b.render_data.label.startsWith('①'));
    assert.equal(optionBefore.action.data, '1: 1\n2: 1\n3: 1');
    // 回头改第 1 题（点更早那张卡上的选项）
    await tap(`qqbot:qm:${QID}:0:1`, account, runtime); // 改成第 2 项
    assert.equal(sent.length, 4, '应重发当前卡刷新全量文本');
    const lastAfter = sent[3]!;
    assert.ok(String(lastAfter.text).includes('第 3/3 题'), '重发的应是当前（最后一题）卡');
    const optionAfter = buttonsOf(lastAfter).find((b: any) => b.render_data.label.startsWith('①'));
    assert.equal(optionAfter.action.data, '1: 2\n2: 1\n3: 1', '提交文本必须用改后的答案');
  } finally {
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

await test('不得程序化提交多题答案（无 resolveAnswers 一类 API）', () => {
  for (const file of [
    'src/features/question-flow.ts',
    'src/features/question-helpers.ts',
    'src/gateway/event-handlers.ts',
    'src/dispatch/dispatch.ts',
  ]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf-8');
    assert.ok(
      !/resolveAnswers\s*\(/.test(src),
      `${file} 不得程序化提交多题答案（2026-08-24 事故红线）`,
    );
  }
});

await test('顺序发题不得合成入站消息（不得出现 inbound 注入入口）', () => {
  const src = readFileSync(new URL('../src/features/question-flow.ts', import.meta.url), 'utf-8');
  assert.ok(
    !/enqueueC2CInboundMessage|enqueueGroupInboundMessage/.test(src),
    'question-flow 不得合成入站消息（会被 steer 进 ask_user-suspended run）',
  );
});

await test('顺序发题只在 c2c 生效（群聊仍旧路径）', () => {
  const src = readFileSync(new URL('../src/dispatch/dispatch.ts', import.meta.url), 'utf-8');
  assert.ok(
    /const sequential = scope === 'c2c'/.test(src),
    'dispatch 必须按 scope 区分：c2c 顺序发题、群聊旧路径',
  );
});

// ── 7. issue #99 守卫：多题 pending 认领 ──

group('7. issue #99：多题 pending 认领（keyed 旁路在作答受理后失效）');

await test('发卡那一轮不自清：ask_user 投递后 pending 仍武装（keyed 旁路可用）', async () => {
  clearQuotaCache();
  const { sent, gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_1' });
  try {
    assert.equal(sent.length, 1, '顺序发题首轮只发 1 张卡');
    const pending = findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123');
    assert.ok(pending, '发卡那一轮的 dispatch 起点不得清掉自己（deliver 回调里）刚登记的 pending');
    assert.equal(pending!.questionId, QID);
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('keyed 形态作答入站 dispatch ⇒ pending 置终态（旁路失效，恢复防抖合并）', async () => {
  clearQuotaCache();
  const { gw } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_2' });
  try {
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      '前置：作答到达前 keyed 旁路处于武装态',
    );
    // 末题指令按钮代发的 keyed 答案 = 该会话的下一条入站消息（3 题 × 2 选项）
    await dispatchPlainInbound({ messageId: 'M_I99_2_ANSWER', content: '1: 1\n2: 1\n3: 1' });
    assert.equal(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      undefined,
      '可认领作答受理后 keyed 旁路必须失效——否则 25 分钟 TTL 内同一份作答的'
        + '重复投递（连点 / 平台重推）各自独立成轮次（issue #99 实录 3 条 USER）',
    );
    assert.equal(
      recordSequentialAnswer(QID, 0, 0).status,
      'terminal',
      '终态后继续点旧卡应按 terminal 处理，不再重复发卡',
    );
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('无关文本不认领（dispatch 起点兜底路径）：pending 不置终态，卡片流程继续存活', async () => {
  clearQuotaCache();
  const { gw, account, runtime } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_2B' });
  try {
    // 用户没点按钮，先发了条无关文本（"这题什么意思？"）——**dispatch 起点
    // 兜底路径**（防抖关闭配置的直发路径）：该处只认领「可认领 keyed 答案」，
    // 无关文本不认领 ⇒ pending 保持武装（无条件置终态会打死顺序发题状态机，
    // 两侧状态分裂）。
    // ⚠ 多题问答进行中的**真实路径是入队口**（enqueueC2CInboundMessage）——
    // 那里无关文本被本地暂存为当前题答案、不转发框架，见下一条用例。
    await dispatchPlainInbound({ messageId: 'M_I99_2B_ASK', content: '这题什么意思？' });
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      '无关文本不得认领 pending（评审一轮：无条件置终态会打死顺序发题状态机）',
    );
    // 卡片流程确实还活着：点选仍被受理（不是 terminal）
    const r = recordSequentialAnswer(QID, 0, 0);
    assert.equal(r.status, 'ok', '无关文本后点选第 1 题仍应正常推进');
    void account; void runtime;
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('无关文本在入队口被本地暂存为当前题答案（真实路径）：不进框架 + pending 不终态 + cursor 前进 + 续发下一题卡', async () => {
  clearQuotaCache();
  const { sent, gw, account } = await deliverAskUserKeepingGateway(THREE_QUESTION_PAYLOAD, { messageId: 'M_I99_2C' });
  try {
    assert.equal(sent.length, 1, '前置：首轮只发第 1 题卡');
    assert.equal(getPendingMultiQuestionState(QID)!.cursor, 0, '前置：cursor 指向第 1 题');

    // 多题问答进行中：平台无法区分「用户手打的普通消息」与「指令按钮代发的
    // 回调内容」——两者都是普通入站消息。故入队口把窗口内文本**本地暂存**
    // 为当前题答案、**不转发框架**（转发只会撞上 validateAnswers 的 partial
    // 拒收 + 重问循环：白烧一轮、两侧状态分裂）。分类只认形态（keyed vs
    // 非 keyed），不靠内容语义猜——用户在答题中途问别的也会被当答案。
    const { msg, ctx } = makeMsgAndCtx({ messageId: 'M_I99_2C_ASK', targetId: 'USER_123' });
    msg.content = '这题什么意思？';
    ctx.message = { content: '这题什么意思？' };
    let inboundRuns = 0;
    const runtime2 = makeFakeRuntime({
      onInboundRun: async () => { inboundRuns++; return { dispatched: true }; },
      dispatchReply: async () => ({ queuedFinal: true, counts: { final: 0 } }),
    });
    const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime2, fakeLog);
    assert.equal(handled, true, '文本已被接管（暂存为当前题答案）');
    assert.equal(inboundRuns, 0, '不得转发框架成轮（中间态文本转发 = 白烧一轮 + 重问循环）');

    // pending 不置终态：终态化只由最终 keyed 认领负责（全部答齐后）
    assert.ok(
      findPendingMultiQuestionByConversation(ACCOUNT_ID, 'c2c', 'USER_123'),
      'pending 保持武装（终态化只由最终 keyed 认领负责）',
    );
    const after = getPendingMultiQuestionState(QID)!;
    assert.equal(after.cursor, 1, 'cursor 前进到第 2 题');
    assert.equal(
      (after.answers.get(0) as { text?: string }).text,
      '这题什么意思？',
      '无关文本被记为当前题（第 1 题）的答案',
    );
    assert.equal(sent.length, 2, '续发第 2 题卡');
    assert.ok(
      String(sent[1]!.text).includes('第 2/3 题'),
      `续发的应是第 2 题卡，实际：${String(sent[1]!.text).slice(0, 40)}`,
    );
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('claimPendingMultiQuestionIfKeyedAnswer：认领形态逐项判定（与框架 validateAnswers 对齐）', () => {
  const questions = [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2', 'b3'] },
    { header: '丙', question: 'q3', options: ['c1'], isOther: true },
  ];
  const cases: Array<{ text: string; expected: boolean; why: string }> = [
    { text: '1: 1\n2: 3\n3: 自由文本', expected: true, why: '标准形态：序号在选项范围内，isOther 题收自由文本' },
    { text: '1: 2\n2: 1\n3: 1', expected: true, why: 'isOther 题用序号作答也合法' },
    { text: '1: 1\n2: 1', expected: false, why: '行数不足 3（框架 validateAnswers 逐题非空，认领必失败）' },
    { text: '1: 1\n2: 1\n3: 1\n4: 1', expected: false, why: '行数超题数' },
    { text: '1: 3\n2: 1\n3: 1', expected: true, why: '越界数字也认领——框架 isOther 强制下按自由文本收（2026-11-11 修正：此前「越界必拒收」判断源于未归一化 question 的对拍，生产路径不存在该分支）' },
    { text: '1: 1,2\n2: 3\n3: 1', expected: true, why: '多值同上——单选按自由文本、multiSelect 按拆段，框架都收' },
    { text: '1: 1 2\n2: 3\n3: 1', expected: true, why: '空格多值同上' },
    { text: '1: 1;2\n2: 3\n3: 1', expected: true, why: '分号多值同上' },
    { text: '1: 1\n2: 1\n3: ', expected: false, why: '末题空值（validateAnswers 拒空）' },
    { text: '1：1\n2：1\n3：1', expected: false, why: '全角冒号框架解析不了（卡片也从不产出）' },
    { text: '第一题: 1\n第二题: 1\n第三题: 1', expected: false, why: '非题号 key——卡片不指引这种写法，宁可漏认领' },
    { text: '1: 1\n2: 2\n3: 随便写', expected: true, why: '自由文本落在 isOther 题上' },
    { text: '1: 自由文本\n2: 1\n3: 1', expected: true, why: '自由文本在非 isOther 声明题上也认领——框架 ask_user 归一化对每题强制 isOther: true（dist 实锤），!isOther 门永不触发' },
  ];
  for (const { text, expected, why } of cases) {
    // 每例独立 pending（认领会置终态，复用会串味）
    const qid = `ask_shape_${Math.random().toString(36).slice(2, 10)}`;
    registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_SHAPE', questions, 200);
    assert.equal(
      claimPendingMultiQuestionIfKeyedAnswer(qid, text),
      expected,
      `「${text.replace(/\n/g, '⏎')} }」应${expected ? '认领' : '不认领'}：${why}`,
    );
  }
  // 非 isOther 声明题的自由文本：**认领**（sequential-text-answer 改造）
  // ——框架 ask_user 归一化对每题强制 isOther: true，认领侧 !isOther 门
  // 永不触发；插件反解出的 per-question isOther 只作展示参考
  {
    const qid = `ask_shape_${Math.random().toString(36).slice(2, 10)}`;
    registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_SHAPE', [
      { header: '甲', question: 'q1', options: ['a1'] },
    ], 200);
    assert.equal(
      claimPendingMultiQuestionIfKeyedAnswer(qid, '1: 我自己写的'),
      true,
      '自由文本对任何题都可认领（框架强制 isOther）',
    );
  }
  // 已终态 / 未知 id ⇒ 不认领
  {
    const qid = `ask_shape_${Math.random().toString(36).slice(2, 10)}`;
    registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_SHAPE', [
      { header: '甲', question: 'q1', options: ['a1'] },
    ], 200);
    assert.equal(claimPendingMultiQuestionIfKeyedAnswer(qid, '1: 1'), true, '前置：首次认领成功');
    assert.equal(claimPendingMultiQuestionIfKeyedAnswer(qid, '1: 1'), false, '已终态不再认领');
  }
});

await test('认领登记表：逐字副本判定 + 认领自身豁免 + 新一单清表（issue #99 评审三轮）', () => {
  const qid = `ask_reg_${Math.random().toString(36).slice(2, 10)}`;
  const twoQuestions = [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
  ];
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_REG', twoQuestions, 1000);
  assert.equal(claimPendingMultiQuestionIfKeyedAnswer(qid, '1: 1\n2: 2', 'MSG_CLAIM'), true, '前置：认领成功并登记');
  assert.equal(
    isDuplicateClaimedKeyedAnswerDelivery(ACCOUNT_ID, 'USER_REG', 'MSG_CLAIM', '1: 1\n2: 2'),
    false,
    '认领那次自身的投递不算重复（豁免）',
  );
  assert.equal(
    isDuplicateClaimedKeyedAnswerDelivery(ACCOUNT_ID, 'USER_REG', 'MSG_DUP', '1: 1\n2: 2'),
    true,
    '逐字同文 + 不同 messageId = 副本（客户端代发多次 / 平台重推）',
  );
  assert.equal(
    isDuplicateClaimedKeyedAnswerDelivery(ACCOUNT_ID, 'USER_REG', 'MSG_DUP', '1: 2\n2: 2'),
    false,
    '文本不同 = 新消息（可能是用户改答案重发），不得丢',
  );
  assert.equal(
    isDuplicateClaimedKeyedAnswerDelivery(ACCOUNT_ID, 'OTHER_USER', 'MSG_DUP', '1: 1\n2: 2'),
    false,
    '会话隔离：他用户同文本不受影响',
  );
  // 新一单开始 ⇒ 清表：上一单答案的重复窗口关闭，第二轮同文本作答不被误吞
  registerPendingMultiQuestion(ACCOUNT_ID, `ask_reg2_${Math.random().toString(36).slice(2, 10)}`, 'c2c', 'USER_REG', twoQuestions, 1000);
  assert.equal(
    isDuplicateClaimedKeyedAnswerDelivery(ACCOUNT_ID, 'USER_REG', 'MSG_DUP', '1: 1\n2: 2'),
    false,
    '新一单登记后，上一单答案的登记应被清除',
  );
});

await test('源码守卫：认领必须在放行判定处接线（不得只定义不调用 / 只在 dispatch 起点）', () => {
  const debounceSrc = readFileSync(new URL('../src/features/inbound-debounce.ts', import.meta.url), 'utf-8');
  assert.ok(
    debounceSrc.includes('claimPendingMultiQuestionIfKeyedAnswer(pendingMulti.questionId, text, String(item.msg.messageId'),
    '旁路放行判定处必须同步认领并登记 messageId——旁路资格是入队时逐条判定的，等到 dispatch'
      + '起点再做，同批到达的重复投递已各自拿到资格（评审二轮）',
  );
  assert.ok(
    debounceSrc.includes('isDuplicateClaimedKeyedAnswerDelivery('),
    'enqueue 入口必须接重复投递丢弃——副本降级进防抖缓冲、单条 flush 仍是独立轮次'
      + '（评审三轮·发现 1），且防抖关闭配置无缓冲可合并（发现 3）',
  );
  const dispatchSrc = readFileSync(new URL('../src/dispatch/dispatch.ts', import.meta.url), 'utf-8');
  assert.ok(
    dispatchSrc.includes('claimPendingMultiQuestionIfKeyedAnswer(pendingMulti.questionId'),
    'dispatch 起点必须保留兜底认领（防抖关闭配置不经 shouldDebounce）',
  );
});

// ── 8. issue #99 守卫：提交型按钮防连点 ──

group('8. issue #99：提交型按钮 click_limit（防连点重复发送）');

await test('末题提交键盘：选项按钮 click_limit=1；「✍️ 其他」不设（可重复预填）', async () => {
  clearQuotaCache();
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
      assert.equal(b.action.type, 2, '末题选项是指令型（type=2）');
      assert.equal(
        b.action.click_limit,
        1,
        '末题选项必须 click_limit=1——每次点击都让客户端代发整份答案文本，'
          + '连点 = 同一份作答重复投递（issue #99 缺陷 2）',
      );
    }
    const other = buttonByLabel(last, '✍️ 其他');
    assert.ok(other, '末题带「✍️ 其他」');
    assert.equal(
      other.action.click_limit,
      undefined,
      '「✍️ 其他」只预填不发消息，不设 click_limit（清空输入框后再要一次模板是真实用法）',
    );
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('群确认卡键盘：「✅ 提交」click_limit=1；「✏️ 改一改」不设', () => {
  const kb: any = buildMultiQuestionConfirmKeyboard('1: 3\n2: 1');
  const buttons = (kb.content.rows ?? []).flatMap((r: any) => r.buttons ?? []);
  const submit = buttons.find((b: any) => b.id === 'confirm_submit');
  const edit = buttons.find((b: any) => b.id === 'confirm_edit');
  assert.ok(submit && edit, '确认卡应有「✅ 提交」与「✏️ 改一改」两个按钮');
  assert.equal(submit.action.click_limit, 1, '「✅ 提交」每次点击代发答案文本，必须限一次');
  assert.equal(edit.action.click_limit, undefined, '「✏️ 改一改」只预填输入框，可重复点');
});

// ── 9. 文本作答（sequential-text-answer 改造）──

group('9. 文本作答：直接回复一句话即作答，末题收齐发确认卡');

await test('recordSequentialTextAnswer：压平单行 / 推进 cursor / 末题收齐返回 complete-text', () => {
  const qid = `ask_text_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_TEXT', [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
    { header: '丙', question: 'q3', options: ['c1', 'c2'] },
  ], 5000);
  // 多行压平为单行（keyed 终稿一行一题，多行自由文本会打乱行数）
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
  assert.equal(r.status, 'complete-text', '末题收齐返回 complete-text');
  const st = getPendingMultiQuestionState(qid);
  assert.ok(st, 'pending 保持武装（终态化由最终 keyed 认领负责，不在此处置）');
  assert.equal((st!.answers.get(2) as { text: string }).text, '3');
  // 空文本 / 未登记 / 已终态
  assert.equal(recordSequentialTextAnswer(qid, '   ').status, 'unknown', '空文本不作答');
  assert.equal(recordSequentialTextAnswer(`ask_x_${'9'.repeat(30)}`, 'x').status, 'unknown', '未登记 unknown');
  claimPendingMultiQuestionIfKeyedAnswer(qid, '1: 就选 a 吧\n2: 第二个答案\n3: 3', 'msg-x');
  assert.equal(recordSequentialTextAnswer(qid, '再来一句').status, 'terminal', '已认领置终态后按 terminal 处理');
});

await test('文本作答收齐 → 确认卡：单「✅ 提交」按钮携带全量 keyed（含自由文本行）', async () => {
  clearQuotaCache();
  const qid = `ask_confirm_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_CONFIRM', [
    { header: '甲', question: 'q1', options: ['a1', 'a2'] },
    { header: '乙', question: 'q2', options: ['b1', 'b2'] },
    { header: '丙', question: 'q3', options: ['c1', 'c2'] },
  ], 5000, 'M_TEXT_CONFIRM_ANCHOR');
  recordSequentialTextAnswer(qid, '就选 a 吧');
  recordSequentialTextAnswer(qid, '第二个答案');
  recordSequentialTextAnswer(qid, '3');

  const { sent, gw } = installFakeGateway();
  try {
    const r = await sendSequentialTextConfirmCard({
      state: getPendingMultiQuestionState(qid)!,
      account: makeAccount(),
      to: 'qqbot:c2c:USER_CONFIRM',
    });
    assert.ok(!r.error, `确认卡发送应成功：${r.error}`);
    assert.equal(sent.length, 1, '只发一张确认卡');
    const card = sent[0]!;
    assert.equal(card.opts?.msgId, 'M_TEXT_CONFIRM_ANCHOR', '确认卡复用 pending 锚点走被动回复');
    const body = String(card.text);
    assert.ok(body.includes('已收齐 3 题答案'), '正文标题写明收齐');
    assert.ok(body.includes('就选 a 吧'), '已记录展示自由文本答案');
    assert.ok(body.includes('第二个答案'), '已记录逐题展示');
    assert.ok(body.includes('点「✅ 提交」发送'), '指引写明提交入口');
    const buttons = buttonsOf(card);
    assert.equal(buttons.length, 1, '确认卡只有一个按钮');
    const btn = buttons[0];
    assert.equal(btn.action.type, 2, '指令型（type=2）');
    assert.equal(btn.action.enter, true, 'enter=true（点击即代发）');
    assert.equal(btn.action.click_limit, 1, 'click_limit=1 防连点');
    assert.equal(
      btn.action.data,
      '1: 就选 a 吧\n2: 第二个答案\n3: 3',
      'data = 全量 keyed（自由文本行 + 选项序号行），与手打模板同源',
    );
  } finally {
    unregisterGateway(ACCOUNT_ID, gw);
  }
});

await test('确认卡超长护栏：keyed > 300 字符时不挂按钮、只剩手打模板', () => {
  const qid = `ask_long_${Math.random().toString(36).slice(2, 10)}`;
  registerPendingMultiQuestion(ACCOUNT_ID, qid, 'c2c', 'USER_LONG', [
    { header: '甲', question: 'q1', options: ['a1'] },
    { header: '乙', question: 'q2', options: ['b1'] },
  ], 5000);
  recordSequentialTextAnswer(qid, '长'.repeat(320));
  recordSequentialTextAnswer(qid, '1');
  const card = renderSequentialTextConfirmCard(getPendingMultiQuestionState(qid)!);
  assert.ok(card, '渲染成功');
  assert.equal(card!.keyboard, undefined, '超长时不得挂按钮（平台 data 限额未知的风险护栏）');
  assert.ok(card!.text.includes('请直接回复下面这段提交'), '只剩手打模板指引');
  assert.ok(card!.text.includes('长'.repeat(320)), '模板保留完整答案（可复制）');
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
