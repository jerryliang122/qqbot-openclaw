/**
 * question-card 单元测试（单题 / 多题共用卡片渲染层，PR1）
 *
 * 覆盖：
 * - parseSingleQuestionPrompt：单题框架文本反解（含失败路径）
 * - formatQuestionCard：单题版式逐字断言 + 多题版式回归（与迁移前一致）
 * - buildQuestionOptionKeyboard：单题按钮结构 + 多题按钮回归
 */
import { strict as assert } from 'node:assert';
import {
  parseSingleQuestionPrompt,
  formatQuestionCard,
  formatMultiQuestionCard,
  buildQuestionOptionKeyboard,
  buildMultiQuestionKeyboard,
  buildButtonLabel,
  estimateLabelWidth,
} from '../src/features/question-card.js';

const QID = 'ask_0123456789abcdef0123456789abcdef';

/**
 * 框架真实单题文本（`buildAgentHarnessQuestionPromptPayload` 实测产出，
 * 见 openclaw/dist/gateway-question-DpxoLEYe.mjs）。
 */
const REAL_SINGLE_TEXT = [
  'Question for you:',
  '',
  '6336条款',
  'HWMD0176336（澳大利亚，Perth）的贸易条款按哪个落？字段里选的是 DAP，门点文字写的是「DDU 送货地址」。',
  '1. DDU - 以门点文字原文为准',
  '2. DAP - 以伙伴云字段选中值为准',
  'Other: reply with your own answer.',
  '',
  'Reply with the number, the option text, or your own answer.',
].join('\n');

const REAL_OPTION_VALUES = ['DDU', 'DAP'];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (err) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

console.log('\n=== 1. parseSingleQuestionPrompt（真实框架文本）===');

test('真实单题文本 -> header/question/options/isOther', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  assert.equal(def.header, '6336条款');
  assert.equal(
    def.question,
    'HWMD0176336（澳大利亚，Perth）的贸易条款按哪个落？字段里选的是 DAP，门点文字写的是「DDU 送货地址」。',
  );
  assert.deepEqual(def.options, [
    'DDU - 以门点文字原文为准',
    'DAP - 以伙伴云字段选中值为准',
  ]);
  assert.equal(def.isOther, true);
});

test('题干多行 -> 完整保留换行', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '第一行题干',
    '第二行题干',
    '1. 甲',
    '2. 乙',
    'Other: reply with your own answer.',
    '',
    'Reply with the number.',
  ].join('\n');
  const def = parseSingleQuestionPrompt(text, ['甲', '乙']);
  assert.ok(def);
  assert.equal(def.question, '第一行题干\n第二行题干');
  assert.deepEqual(def.options, ['甲', '乙']);
});

test('选项无描述 -> 只有 label', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '题干',
    '1. 甲',
    '2. 乙',
  ].join('\n');
  const def = parseSingleQuestionPrompt(text, ['甲', '乙']);
  assert.ok(def);
  assert.deepEqual(def.options, ['甲', '乙']);
  assert.equal(def.isOther, false);
});

test('label 带 (Recommended) -> 原样保留在选项行里（渲染时再剥）', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '题干',
    '1. 调研/方案 (Recommended) - 搜索、分析',
    '2. 直接实现',
  ].join('\n');
  const def = parseSingleQuestionPrompt(text, ['调研/方案 (Recommended)', '直接实现']);
  assert.ok(def);
  assert.deepEqual(def.options, ['调研/方案 (Recommended) - 搜索、分析', '直接实现']);
});

console.log('\n=== 2. parseSingleQuestionPrompt（失败路径 → null）===');

test('尾部出现未知内容 -> null', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '题干',
    '1. DDU',
    '2. DAP',
    'Unexpected trailing line',
  ].join('\n');
  assert.equal(parseSingleQuestionPrompt(text, REAL_OPTION_VALUES), null);
});

test('选项行缺失 -> null', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '题干',
    '1. DDU',
  ].join('\n');
  assert.equal(parseSingleQuestionPrompt(text, REAL_OPTION_VALUES), null);
});

test('header 缺失（intro 后直接是选项）-> null', () => {
  const text = ['Question for you:', '', '1. DDU', '2. DAP'].join('\n');
  assert.equal(parseSingleQuestionPrompt(text, REAL_OPTION_VALUES), null);
});

test('optionValues 与文本不匹配 -> null', () => {
  assert.equal(parseSingleQuestionPrompt(REAL_SINGLE_TEXT, ['XXX', 'YYY']), null);
});

test('label 内含 " - " -> null（渲染层无法按首个分隔符还原标签）', () => {
  const text = [
    'Question for you:',
    '',
    '标题',
    '题干',
    '1. A - B - 说明',
    '2. 丙',
  ].join('\n');
  assert.equal(parseSingleQuestionPrompt(text, ['A - B', '丙']), null);
});

test('题干为空 -> null', () => {
  const text = ['Question for you:', '', '标题', '1. DDU', '2. DAP'].join('\n');
  assert.equal(parseSingleQuestionPrompt(text, REAL_OPTION_VALUES), null);
});

test('空文本 / 选项数不足 -> null', () => {
  assert.equal(parseSingleQuestionPrompt('', REAL_OPTION_VALUES), null);
  assert.equal(parseSingleQuestionPrompt(REAL_SINGLE_TEXT, ['DDU']), null);
});

console.log('\n=== 3. formatQuestionCard（单题版式，逐字）===');

test('单题卡正文：标题 + 题干 + 加粗编号选项 + 中文引导', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  const card = formatQuestionCard(def, { variant: 'single' });
  assert.equal(
    card,
    [
      '**6336条款**',
      '',
      'HWMD0176336（澳大利亚，Perth）的贸易条款按哪个落？字段里选的是 DAP，门点文字写的是「DDU 送货地址」。',
      '',
      '**1.** DDU —— 以门点文字原文为准',
      '',
      '**2.** DAP —— 以伙伴云字段选中值为准',
      '',
      '👇 点下方按钮作答',
      '',
      '不想选按钮？直接回复「序号 / 选项名 / 你的答案」',
    ].join('\n'),
  );
});

test('单题卡正文不含框架英文脚手架', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  const card = formatQuestionCard(def, { variant: 'single' });
  assert.ok(!card.includes('Question for you:'));
  assert.ok(!card.includes('Other: reply with your own answer.'));
  assert.ok(!card.includes('Reply with the number'));
  assert.ok(!card.includes('第 1/1 题'));
});

test('单题卡正文：剥 (Recommended) 后缀', () => {
  const def = parseSingleQuestionPrompt(
    [
      'Question for you:',
      '',
      '标题',
      '题干',
      '1. 调研/方案 (Recommended) - 搜索、分析',
      '2. 直接实现',
    ].join('\n'),
    ['调研/方案 (Recommended)', '直接实现'],
  );
  assert.ok(def);
  const card = formatQuestionCard(def, { variant: 'single' });
  assert.ok(card.includes('**1.** 调研/方案 —— 搜索、分析'));
  assert.ok(!card.includes('(Recommended)'));
});

test('单题卡正文：无描述时不留悬空破折号', () => {
  const def = parseSingleQuestionPrompt(
    ['Question for you:', '', '标题', '题干', '1. 甲', '2. 乙'].join('\n'),
    ['甲', '乙'],
  );
  assert.ok(def);
  const card = formatQuestionCard(def, { variant: 'single' });
  assert.ok(card.includes('**1.** 甲'));
  assert.ok(!card.includes('甲 ——'));
});

console.log('\n=== 3b. formatQuestionCard（keyboardAttached:false 纯文本兜底形态）===');

test('单题 isOther：不指引点按钮，引导改为「直接回复」', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  const card = formatQuestionCard(def, { variant: 'single', keyboardAttached: false });
  assert.ok(!card.includes('👇 点下方按钮作答'), '兜底正文不得指引点按钮');
  assert.ok(!card.includes('不想选按钮？'), '没有按钮就谈不上「不想选按钮」');
  assert.ok(card.includes('直接回复「序号 / 选项名 / 你的答案」'));
  // 主体内容保留：标题 / 题干 / 编号选项
  assert.ok(card.includes('**6336条款**'));
  assert.ok(card.includes('**1.** DDU —— 以门点文字原文为准'));
});

test('单题非 isOther：仍给「序号 / 选项名」引导（没有按钮时直接回复是唯一作答方式）', () => {
  const def = parseSingleQuestionPrompt(
    ['Question for you:', '', '标题', '题干', '1. 甲', '2. 乙'].join('\n'),
    ['甲', '乙'],
  );
  assert.ok(def);
  assert.equal(def.isOther, false);
  const card = formatQuestionCard(def, { variant: 'single', keyboardAttached: false });
  assert.ok(!card.includes('👇 点下方按钮作答'));
  assert.ok(card.includes('直接回复「序号 / 选项名」'));
  assert.ok(!card.includes('你的答案」'), '非 isOther 题不引导自由文本作答');
});

test('多题 isOther：兜底形态的「其他」引导不带按钮字样', () => {
  const card = formatQuestionCard(
    { header: '乙', question: '第二题？', options: ['b1', 'b2'], isOther: true },
    { variant: 'multi', index: 1, total: 2, keyboardAttached: false },
  );
  assert.ok(!card.includes('👇 点下方按钮作答'));
  assert.ok(!card.includes('「✍️ 其他」'));
  assert.ok(card.includes('选项不合适？直接回复 "2: 你的答案"'));
});

console.log('\n=== 4. buildQuestionOptionKeyboard（单题按钮）===');

test('单题按钮：① 前缀 + 回调 data + group_id + click_limit', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  const keyboard = buildQuestionOptionKeyboard(def, {
    questionId: QID,
    buildActionData: (i) => `qqbot:q:${QID}:${i}`,
    groupId: 'question',
    idPrefix: 'q',
    visitedLabel: '已回答',
  });
  assert.equal(keyboard.content!.rows.length, 1);
  const buttons = keyboard.content!.rows[0].buttons;
  assert.equal(buttons.length, 2);
  assert.equal(buttons[0].id, 'q0');
  assert.equal(buttons[0].render_data!.label, '① DDU');
  assert.equal(buttons[0].render_data!.visited_label, '已回答');
  assert.equal(buttons[0].action!.type, 1);
  assert.equal(buttons[0].action!.data, `qqbot:q:${QID}:0`);
  assert.equal(buttons[0].action!.click_limit, 1);
  assert.equal(buttons[0].group_id, 'question');
  assert.equal(buttons[1].render_data!.label, '② DAP');
  assert.equal(buttons[1].action!.data, `qqbot:q:${QID}:1`);
});

test('单题按钮：长标签截断 + 宽标签每行 2 个（4 选项）', () => {
  const long = '这是一个足够长的选项名称用来触发截断与分行逻辑展示效果';
  const values = [long, long, long, long];
  const def = parseSingleQuestionPrompt(
    ['Question for you:', '', '标题', '题干', `1. ${long}`, `2. ${long}`, `3. ${long}`, `4. ${long}`].join('\n'),
    values,
  );
  assert.ok(def);
  const keyboard = buildQuestionOptionKeyboard(def, {
    questionId: QID,
    buildActionData: (i) => `qqbot:q:${QID}:${i}`,
    groupId: 'question',
    idPrefix: 'q',
  });
  // 标签过宽 → 每行 2 个（4 个按钮 = 2 行）
  assert.equal(keyboard.content!.rows.length, 2);
  assert.equal(keyboard.content!.rows[0].buttons.length, 2);
  const label = keyboard.content!.rows[0].buttons[0].render_data!.label;
  assert.ok(label.endsWith('…'));
  assert.ok(estimateLabelWidth(label) <= 24);
});

test('单题按钮：2 个按钮恒为一行（与多题卡同款规则）', () => {
  const long = '这是一个足够长的选项名称用来触发截断与分行逻辑展示效果';
  const def = parseSingleQuestionPrompt(
    ['Question for you:', '', '标题', '题干', `1. ${long}`, `2. ${long}`].join('\n'),
    [long, long],
  );
  assert.ok(def);
  const keyboard = buildQuestionOptionKeyboard(def, {
    questionId: QID,
    buildActionData: (i) => `qqbot:q:${QID}:${i}`,
    groupId: 'question',
    idPrefix: 'q',
  });
  assert.equal(keyboard.content!.rows.length, 1);
  assert.equal(keyboard.content!.rows[0].buttons.length, 2);
});

test('单题按钮：短标签一行放满', () => {
  const def = parseSingleQuestionPrompt(REAL_SINGLE_TEXT, REAL_OPTION_VALUES);
  assert.ok(def);
  const keyboard = buildQuestionOptionKeyboard(def, {
    questionId: QID,
    buildActionData: (i) => `qqbot:q:${QID}:${i}`,
    groupId: 'question',
    idPrefix: 'q',
  });
  assert.equal(keyboard.content!.rows.length, 1);
  assert.equal(keyboard.content!.rows[0].buttons.length, 2);
});

console.log('\n=== 5. 多题回归（迁移后输出必须逐字不变）===');

test('formatMultiQuestionCard：与迁移前一致', () => {
  const card = formatMultiQuestionCard(
    {
      header: '硬功夫方向',
      question: '往哪边补？',
      options: ['调研/方案 (Recommended) - 搜索、分析', '数据/文档'],
    },
    0,
    2,
  );
  assert.ok(card.includes('第 1/2 题'));
  assert.ok(card.includes('硬功夫方向'));
  assert.ok(card.includes('往哪边补？'));
  assert.ok(card.includes('**1.** 调研/方案 —— 搜索、分析'));
  assert.ok(card.includes('**2.** 数据/文档'));
  assert.ok(!card.includes('(Recommended)'));
  assert.ok(card.includes('👇 点下方按钮作答'));
});

test('formatMultiQuestionCard：isOther 题带「✍️ 其他」提示（逐字）', () => {
  const card = formatMultiQuestionCard(
    { header: '乙', question: '第二题？', options: ['b1', 'b2'], isOther: true },
    1,
    2,
  );
  assert.equal(
    card,
    [
      '**第 2/2 题 · 乙**',
      '',
      '第二题？',
      '',
      '**1.** b1',
      '',
      '**2.** b2',
      '',
      '👇 点下方按钮作答',
      '',
      '选项不合适？点「✍️ 其他」后输入，或直接回复 "2: 你的答案"',
    ].join('\n'),
  );
});

test('formatQuestionCard(variant=multi) 与 formatMultiQuestionCard 逐字一致', () => {
  const def = { header: '甲', question: '第一题？', options: ['a1', 'a2'], isOther: true };
  assert.equal(
    formatQuestionCard(def, { variant: 'multi', index: 0, total: 3 }),
    formatMultiQuestionCard(def, 0, 3),
  );
});

test('buildMultiQuestionKeyboard：与迁移前一致（结构 + 按钮数据）', () => {
  const keyboard = buildMultiQuestionKeyboard(QID, 1, {
    header: '乙',
    question: '第二题？',
    options: ['b1', 'b2'],
    isOther: true,
  });
  const buttons = keyboard.content!.rows.flatMap((r) => r.buttons);
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].id, 'q1_0');
  assert.equal(buttons[0].render_data!.label, '① b1');
  assert.equal(buttons[0].render_data!.visited_label, '已选');
  assert.equal(buttons[0].action!.data, `qqbot:qm:${QID}:1:0`);
  assert.equal(buttons[0].group_id, 'question-1');
  const other = buttons[2]!;
  assert.equal(other.id, 'q1_other');
  assert.equal(other.render_data!.label, '✍️ 其他');
  assert.equal(other.action!.type, 2);
  assert.equal(other.action!.data, '2: ');
  assert.equal(other.action!.enter, false);
});

test('buildButtonLabel：剥 (Recommended) / 超宽截断（与迁移前一致）', () => {
  assert.equal(buildButtonLabel('调研/方案 (Recommended) - 搜索、分析。'), '调研/方案');
  const long = '这是一个非常非常长的选项名称需要被截断处理才行';
  const label = buildButtonLabel(long);
  assert.ok(label.endsWith('…'));
  assert.ok(estimateLabelWidth(label) <= 24);
});

console.log('\n==================================================');
if (process.exitCode) {
  console.error('测试结果: 存在失败用例');
} else {
  console.log('测试结果: 全部通过');
}
