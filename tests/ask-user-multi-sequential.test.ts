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
  registerPendingMultiQuestion,
  getPendingMultiQuestionState,
  recordSequentialAnswer,
} = await import('../src/features/question-helpers.ts');

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

await test('最后一题带「✍️ 其他」时，中间题正文要指路过去（说明怎么自由作答）', async () => {
  clearQuotaCache();
  const payload = {
    text: TWO_QUESTION_WITH_OTHER_TEXT,
    channelData: { askUser: { questionId: QID } },
  };
  const { sent, gw } = await deliverAskUserKeepingGateway(payload, { messageId: 'M_SEQ_6D' });
  try {
    const body = String(sent[0]!.text);
    assert.ok(body.includes('想自己写答案'), '中间题正文要说明「想自己写答案怎么办」');
    assert.ok(body.includes('最后一道题'), '指路必须说清入口在最后一题');
    assert.ok(body.includes('✍️ 其他'), '指路要写明按钮名');
    // 该题自己没有这个按钮——正文不得让人以为它就在这张卡上
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

// ── 结果 ──

console.log('\n' + '='.repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('全部通过');
