/**
 * question-helpers 单元测试
 */
import { strict as assert } from 'node:assert';
import {
  buildQuestionKeyboard,
  buildMultiQuestionKeyboard,
  buildButtonLabel,
  buildMultiQuestionAnswerText,
  buildMultiQuestionConfirmKeyboard,
  formatMultiQuestionConfirmCard,
  estimateLabelWidth,
  formatMultiQuestionCard,
  getPendingMultiQuestions,
  splitOptionLabel,
  parseQuestionButtonData,
  parseMultiQuestionButtonData,
  parseMultiQuestionPrompt,
  isAskUserPayload,
  isNonSingleAskUserPayload,
  registerPendingMultiQuestion,
  recordMultiQuestionTap,
  findPendingMultiQuestionByConversation,
  markMultiQuestionResolved,
  markMultiQuestionResolveFailed,
  type MultiQuestionAnswer,
} from '../src/features/question-helpers.js';

/** 把 complete 结果的答案快照渲染成 "题号: 值" 文本便于断言（选项序号 1-based） */
function answerSnapshotText(result: {
  answers: ReadonlyMap<number, MultiQuestionAnswer>;
}): string {
  return buildMultiQuestionAnswerText(result.answers);
}

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

console.log('\n=== 1. isAskUserPayload ===');

test('有效单问题 payload -> true', () => {
  const payload = {
    channelData: {
      askUser: {
        questionId: 'ask_0123456789abcdef0123456789abcdef',
        optionValues: ['Yes', 'No'],
      },
    },
  };
  assert.equal(isAskUserPayload(payload), true);
});

test('4 个选项 -> true', () => {
  const payload = {
    channelData: {
      askUser: {
        questionId: 'ask_0123456789abcdef0123456789abcdef',
        optionValues: ['A', 'B', 'C', 'D'],
      },
    },
  };
  assert.equal(isAskUserPayload(payload), true);
});

test('缺少 channelData -> false', () => {
  assert.equal(isAskUserPayload({}), false);
});

test('缺少 askUser -> false', () => {
  assert.equal(isAskUserPayload({ channelData: {} }), false);
});

test('questionId 格式错误 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: { askUser: { questionId: 'bad_id', optionValues: ['A', 'B'] } },
    }),
    false,
  );
});

test('只有 1 个选项 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: ['Only'],
        },
      },
    }),
    false,
  );
});

test('5 个选项 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: ['A', 'B', 'C', 'D', 'E'],
        },
      },
    }),
    false,
  );
});

test('optionValues 非数组 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: 'not-array',
        },
      },
    }),
    false,
  );
});

test('optionValues 含非字符串元素 -> false', () => {
  assert.equal(
    isAskUserPayload({
      channelData: {
        askUser: {
          questionId: 'ask_0123456789abcdef0123456789abcdef',
          optionValues: ['A', 123 as any],
        },
      },
    }),
    false,
  );
});

console.log('\n=== 2. buildQuestionKeyboard ===');

test('构建 2 个按钮', () => {
  const keyboard = buildQuestionKeyboard(
    'ask_0123456789abcdef0123456789abcdef',
    ['Yes', 'No'],
  );
  assert.ok(keyboard.content);
  assert.equal(keyboard.content.rows.length, 1);
  assert.equal(keyboard.content.rows[0].buttons.length, 2);

  const [btn1, btn2] = keyboard.content.rows[0].buttons;
  assert.equal(btn1.id, 'q0');
  assert.equal(btn1.render_data?.label, 'Yes');
  assert.equal(btn1.render_data?.visited_label, '已回答');
  assert.equal(btn1.render_data?.style, 1);
  assert.equal(btn1.action?.type, 1);
  assert.equal(btn1.action?.data, 'qqbot:q:ask_0123456789abcdef0123456789abcdef:0');
  assert.equal(btn1.action?.permission?.type, 2);
  assert.equal(btn1.action?.click_limit, 1);
  assert.equal(btn1.group_id, 'question');

  assert.equal(btn2.id, 'q1');
  assert.equal(btn2.render_data?.label, 'No');
  assert.equal(btn2.action?.data, 'qqbot:q:ask_0123456789abcdef0123456789abcdef:1');
});

test('构建 4 个按钮', () => {
  const keyboard = buildQuestionKeyboard(
    'ask_abcdef0123456789abcdef0123456789',
    ['Staging', 'Production', 'Cancel', 'Skip'],
  );
  assert.equal(keyboard.content!.rows[0].buttons.length, 4);
  assert.equal(
    keyboard.content!.rows[0].buttons[3].action?.data,
    'qqbot:q:ask_abcdef0123456789abcdef0123456789:3',
  );
});

console.log('\n=== 3. parseQuestionButtonData ===');

test('有效 button_data -> 解析成功', () => {
  const result = parseQuestionButtonData(
    'qqbot:q:ask_0123456789abcdef0123456789abcdef:0',
  );
  assert.ok(result);
  assert.equal(result.questionId, 'ask_0123456789abcdef0123456789abcdef');
  assert.equal(result.optionIndex, 0);
});

test('optionIndex=3 -> 解析成功', () => {
  const result = parseQuestionButtonData(
    'qqbot:q:ask_0123456789abcdef0123456789abcdef:3',
  );
  assert.ok(result);
  assert.equal(result.optionIndex, 3);
});

test('非 qqbot:q: 前缀 -> null', () => {
  assert.equal(parseQuestionButtonData('approve:v2:exec:xxx:allow-once'), null);
});

test('缺少 optionIndex -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef'),
    null,
  );
});

test('questionId 格式错误 -> null', () => {
  assert.equal(parseQuestionButtonData('qqbot:q:bad_id:0'), null);
});

test('optionIndex 超出范围 -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef:4'),
    null,
  );
});

test('optionIndex 为负数 -> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef:-1'),
    null,
  );
});

test('button_data 以 : 结尾（空 indexStr）-> null', () => {
  assert.equal(
    parseQuestionButtonData('qqbot:q:ask_0123456789abcdef0123456789abcdef:'),
    null,
  );
});

test('round-trip: buildQuestionKeyboard -> parseQuestionButtonData', () => {
  const questionId = 'ask_0123456789abcdef0123456789abcdef';
  const keyboard = buildQuestionKeyboard(questionId, ['A', 'B', 'C']);
  for (let i = 0; i < 3; i++) {
    const data = keyboard.content!.rows[0].buttons[i].action!.data!;
    const parsed = parseQuestionButtonData(data);
    assert.ok(parsed);
    assert.equal(parsed.questionId, questionId);
    assert.equal(parsed.optionIndex, i);
  }
});

console.log('\n=== 4. isNonSingleAskUserPayload ===');

const MULTI_ID = 'ask_0123456789abcdef0123456789abcdef';

test('只有 questionId（无 optionValues）-> true', () => {
  assert.equal(
    isNonSingleAskUserPayload({ channelData: { askUser: { questionId: MULTI_ID } } }),
    true,
  );
});

test('带 optionValues（单问题已被认领）-> false', () => {
  assert.equal(
    isNonSingleAskUserPayload({
      channelData: { askUser: { questionId: MULTI_ID, optionValues: ['A', 'B'] } },
    }),
    false,
  );
});

test('questionId 格式错误 / 缺 askUser -> false', () => {
  assert.equal(
    isNonSingleAskUserPayload({ channelData: { askUser: { questionId: 'bad_id' } } }),
    false,
  );
  assert.equal(isNonSingleAskUserPayload({ channelData: {} }), false);
});

console.log('\n=== 5. parseMultiQuestionPrompt（真实投递文本） ===');

// 用户实际遇到的 2 题样例（框架 formatAgentHarnessUserInputPrompt 生成格式）
const REAL_TWO_QUESTION_TEXT = [
  'Question for you:',
  '',
  '1. 硬功夫方向',
  '现在 Eleos 最该往哪边补硬功夫？',
  '1. 调研/方案 (Recommended) - 搜索、分析、对比、出方案。',
  '2. 数据/文档 - PDF/Excel/邮件解析、出报表。',
  '3. 写小工具/脚本 - Shell/Python 脚本、自动化批处理。',
  '4. 沟通/写作 - 中文润色、邮件起草、翻译。',
  '',
  '2. 最近烦心',
  '最近哪类事最让你烦？',
  '1. 客户/代理反复追问 (Recommended) - 同一件事反复回答或被催。',
  '2. 仓库/物流状态对不上 - 多个源头信息冲突，查不清。',
  '3. 内部协调/扯皮 - 跟同事/代理/平台来回磨。',
  '4. 系统/工具卡壳 - SSH/网盘/平台接口出问题。',
  '',
  'Reply by number or question id. Use a declared option where choices are fixed.',
].join('\n');

test('用户样例：2 题 4 选项 -> 解析成功', () => {
  const questions = parseMultiQuestionPrompt(REAL_TWO_QUESTION_TEXT);
  assert.ok(questions);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].header, '硬功夫方向');
  assert.equal(questions[0].question, '现在 Eleos 最该往哪边补硬功夫？');
  assert.equal(questions[0].options.length, 4);
  assert.equal(questions[0].options[0], '调研/方案 (Recommended) - 搜索、分析、对比、出方案。');
  assert.equal(questions[1].header, '最近烦心');
  assert.equal(questions[1].options[3], '系统/工具卡壳 - SSH/网盘/平台接口出问题。');
});

test('3 题（gateway 上限）-> 解析成功', () => {
  const text = [
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
  const questions = parseMultiQuestionPrompt(text);
  assert.ok(questions);
  assert.equal(questions.length, 3);
  assert.deepEqual(questions[2].options, ['c1', 'c2']);
});

test('选项后的下一题 header 不被误吞为选项（空行判别）', () => {
  // Q1 只有 2 个选项，紧跟空行 + "2. header"：不能把 header 当成 Q1 的第 3 个选项
  const text = [
    'Question for you:',
    '',
    '1. 甲', '第一题？', '1. a1', '2. a2',
    '',
    '2. 乙', '第二题？', '1. b1', '2. b2',
    '',
    'Reply by number.',
  ].join('\n');
  const questions = parseMultiQuestionPrompt(text);
  assert.ok(questions);
  assert.equal(questions[0].options.length, 2);
  assert.equal(questions[1].header, '乙');
});

test('单问题格式（无编号 header）-> null（由单问题路径处理）', () => {
  const singleText = [
    'Question for you:',
    '',
    '改进方向',
    '最近最值得我多花心思的是哪一块？',
    '1. 主动推送与巡检节奏 (Recommended) - 什么时候自动报、报什么。',
    '2. 货运专项技能',
    '',
    'Reply with the number, the option text, or your own answer.',
  ].join('\n');
  // 注意：单问题格式下第一个 "1. " 行是选项且前面无空行 —— 不满足 header 判别
  assert.equal(parseMultiQuestionPrompt(singleText), null);
});

test('secret 警告行 -> null（回退纯文本）', () => {
  const text = [
    'Question for you:',
    '',
    '1. 甲', '第一题？', 'This channel may show your reply to other participants.', '1. a1', '2. a2',
    '',
    '2. 乙', '第二题？', '1. b1', '2. b2',
  ].join('\n');
  assert.equal(parseMultiQuestionPrompt(text), null);
});

test('isOther 声明行 -> 解析成功并标记 isOther', () => {
  const text = [
    'Question for you:',
    '',
    '1. 甲', '第一题？', '1. a1', '2. a2', 'Other: reply with your own answer.',
    '',
    '2. 乙', '第二题？', '1. b1', '2. b2',
    '',
    'Reply by number or question id.',
  ].join('\n');
  const questions = parseMultiQuestionPrompt(text);
  assert.ok(questions);
  assert.equal(questions.length, 2);
  assert.equal(questions[0].isOther, true);
  assert.equal(questions[1].isOther, undefined);
  assert.deepEqual(questions[0].options, ['a1', 'a2']);
});

test('只有 1 个题 -> null（数量校验）', () => {
  const text = [
    'Question for you:',
    '',
    '1. 甲', '第一题？', '1. a1', '2. a2',
    '',
    'Reply by number.',
  ].join('\n');
  assert.equal(parseMultiQuestionPrompt(text), null);
});

test('普通闲聊文本 -> null', () => {
  assert.equal(parseMultiQuestionPrompt('今天天气不错\n出去走走吧'), null);
  assert.equal(parseMultiQuestionPrompt(''), null);
});

console.log('\n=== 6. 标签截断 / 宽度估算 / 卡片格式 ===');

test('estimateLabelWidth：汉字 2、ASCII 1', () => {
  assert.equal(estimateLabelWidth('ab'), 2);
  assert.equal(estimateLabelWidth('硬功夫'), 6);
  assert.equal(estimateLabelWidth('调研/方案'), 9);
});

test('splitOptionLabel 按 " - " 拆出标签', () => {
  assert.equal(splitOptionLabel('调研/方案 (Recommended) - 搜索、分析、对比、出方案。'), '调研/方案 (Recommended)');
  assert.equal(splitOptionLabel('没有描述的选项'), '没有描述的选项');
});

test('buildButtonLabel：剥 (Recommended) 后缀', () => {
  assert.equal(buildButtonLabel('调研/方案 (Recommended) - 搜索、分析。'), '调研/方案');
});

test('buildButtonLabel：超宽截断加省略号', () => {
  const long = '这是一个非常非常长的选项名称需要被截断处理才行';
  const label = buildButtonLabel(long);
  assert.ok(label.endsWith('…'));
  assert.ok(estimateLabelWidth(label) <= 24);
});

test('formatMultiQuestionCard：正文含加粗序号 + 完整选项与描述，剥 (Recommended)', () => {
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

test('formatMultiQuestionCard：isOther 题带文字作答提示', () => {
  const card = formatMultiQuestionCard(
    { header: '乙', question: '第二题？', options: ['b1', 'b2'], isOther: true },
    1,
    2,
  );
  assert.ok(card.includes('✍️ 其他'));
  assert.ok(card.includes('"2: 你的答案"'));
});

console.log('\n=== 7. buildMultiQuestionKeyboard（自适应分行 + 其他按钮） ===');

test('短标签：所有选项一行放满，标签带 ①② 序号前缀', () => {
  const keyboard = buildMultiQuestionKeyboard(MULTI_ID, 0, {
    header: '甲', question: 'q', options: ['a1', 'a2'],
  });
  assert.equal(keyboard.content!.rows.length, 1);
  assert.equal(keyboard.content!.rows[0].buttons.length, 2);
  assert.equal(keyboard.content!.rows[0].buttons[0].render_data!.label, '① a1');
  assert.equal(keyboard.content!.rows[0].buttons[1].render_data!.label, '② a2');
  assert.equal(keyboard.content!.rows[0].buttons[0].action!.data, `qqbot:qm:${MULTI_ID}:0:0`);
  assert.equal(keyboard.content!.rows[0].buttons[0].group_id, 'question-0');
});

test('长标签：自动改为每行 2 个', () => {
  const longOption = '这是一个足够长的选项名称用来触发分行逻辑展示';
  const keyboard = buildMultiQuestionKeyboard(MULTI_ID, 0, {
    header: '甲', question: 'q', options: [longOption, longOption, longOption, longOption],
  });
  assert.equal(keyboard.content!.rows.length, 2);
  assert.equal(keyboard.content!.rows[0].buttons.length, 2);
  assert.equal(keyboard.content!.rows[1].buttons.length, 2);
});

test('isOther 题：追加「✍️ 其他」指令按钮（type=2 预填、不自动发送）', () => {
  const keyboard = buildMultiQuestionKeyboard(MULTI_ID, 1, {
    header: '乙', question: 'q', options: ['b1', 'b2'], isOther: true,
  });
  const allButtons = keyboard.content!.rows.flatMap((r) => r.buttons);
  const otherButton = allButtons.find((b) => b.id === 'q1_other');
  assert.ok(otherButton);
  assert.equal(otherButton.render_data!.label, '✍️ 其他');
  assert.equal(otherButton.action!.type, 2);
  assert.equal(otherButton.action!.data, '2: ');
  assert.equal(otherButton.action!.enter, false);
  assert.ok(otherButton.action!.unsupport_tips);
  // 指令按钮不进互斥组
  assert.equal(otherButton.group_id, undefined);
  // 选项按钮保持回调型
  const optionButton = allButtons.find((b) => b.id === 'q1_0');
  assert.ok(optionButton);
  assert.equal(optionButton.action!.type, 1);
  assert.equal(optionButton.action!.data, `qqbot:qm:${MULTI_ID}:1:0`);
});

console.log('\n=== 7. parseMultiQuestionButtonData ===');

test('有效 button_data -> 解析成功', () => {
  const parsed = parseMultiQuestionButtonData(`qqbot:qm:${MULTI_ID}:2:3`);
  assert.ok(parsed);
  assert.equal(parsed.questionId, MULTI_ID);
  assert.equal(parsed.questionIndex, 2);
  assert.equal(parsed.optionIndex, 3);
});

test('单问题格式 -> null（不混淆）', () => {
  assert.equal(parseMultiQuestionButtonData(`qqbot:q:${MULTI_ID}:0`), null);
});

test('多问题格式不会被单问题解析器误收', () => {
  assert.equal(parseQuestionButtonData(`qqbot:qm:${MULTI_ID}:0:1`), null);
});

test('questionIndex 超界(3) -> null', () => {
  assert.equal(parseMultiQuestionButtonData(`qqbot:qm:${MULTI_ID}:3:0`), null);
});

test('optionIndex 超界(4) -> null', () => {
  assert.equal(parseMultiQuestionButtonData(`qqbot:qm:${MULTI_ID}:0:4`), null);
});

test('字段数不对 -> null', () => {
  assert.equal(parseMultiQuestionButtonData(`qqbot:qm:${MULTI_ID}:0`), null);
  assert.equal(parseMultiQuestionButtonData(`qqbot:qm:${MULTI_ID}:0:1:2`), null);
});

test('round-trip: buildMultiQuestionKeyboard -> parseMultiQuestionButtonData', () => {
  const keyboard = buildMultiQuestionKeyboard(MULTI_ID, 0, {
    header: '甲', question: 'q', options: ['A', 'B'],
  });
  const buttons = keyboard.content!.rows.flatMap((r) => r.buttons);
  for (let i = 0; i < 2; i++) {
    const data = buttons[i]!.action!.data!;
    const parsed = parseMultiQuestionButtonData(data);
    assert.ok(parsed);
    assert.equal(parsed.questionId, MULTI_ID);
    assert.equal(parsed.questionIndex, 0);
    assert.equal(parsed.optionIndex, i);
  }
});

console.log('\n=== 8. 多问题暂存 store ===');

const PARSED_QUESTIONS = parseMultiQuestionPrompt(REAL_TWO_QUESTION_TEXT)!;
const PARSED_ISOTHER_QUESTIONS = parseMultiQuestionPrompt([
  'Question for you:',
  '',
  '1. 甲', '第一题？', '1. a1', '2. a2', 'Other: reply with your own answer.',
  '',
  '2. 乙', '第二题？', '1. b1', '2. b2',
].join('\n'))!;

function resetPending(questions = PARSED_QUESTIONS): void {
  registerPendingMultiQuestion('test-account', MULTI_ID, 'c2c', 'peer-1', questions);
}

test('未登记 -> unknown', () => {
  const result = recordMultiQuestionTap(MULTI_ID, 0, 0);
  assert.deepEqual(result, { status: 'unknown' });
});

test('会话索引：登记后可按会话查到，终态后查不到', () => {
  resetPending();
  assert.deepEqual(findPendingMultiQuestionByConversation('test-account', 'c2c', 'peer-1'), { questionId: MULTI_ID });
  assert.equal(findPendingMultiQuestionByConversation('test-account', 'group', 'peer-1'), undefined);
  // 账号维度隔离：openid 是 per-account 的，他账号同 targetId 查不到
  assert.equal(findPendingMultiQuestionByConversation('other-account', 'c2c', 'peer-1'), undefined);
  markMultiQuestionResolved(MULTI_ID);
  assert.equal(findPendingMultiQuestionByConversation('test-account', 'c2c', 'peer-1'), undefined);
});

test('逐题缓冲 -> 集齐后 complete 并携带答案快照', () => {
  resetPending();

  const first = recordMultiQuestionTap(MULTI_ID, 0, 2);
  assert.equal(first.status, 'buffered');
  if (first.status === 'buffered') {
    assert.equal(first.answeredCount, 1);
    assert.equal(first.total, 2);
    assert.equal(first.pendingQuestions.length, 1);
    assert.equal(first.pendingQuestions[0].header, '最近烦心');
  }

  const second = recordMultiQuestionTap(MULTI_ID, 1, 0);
  assert.equal(second.status, 'complete');
  if (second.status === 'complete') {
    // 第 1 题选第 3 项；第 2 题选第 1 项
    assert.equal(answerSnapshotText(second), '1: 3\n2: 1');
    assert.deepEqual(second.answers.get(0), { optionIndex: 2 });
    assert.deepEqual(second.answers.get(1), { optionIndex: 0 });
  }

  // 提交后为终态
  markMultiQuestionResolved(MULTI_ID);
  assert.equal(recordMultiQuestionTap(MULTI_ID, 0, 0).status, 'terminal');
});

test('同题重复点选，最后一次为准', () => {
  resetPending();
  recordMultiQuestionTap(MULTI_ID, 0, 0);
  recordMultiQuestionTap(MULTI_ID, 0, 1);
  const second = recordMultiQuestionTap(MULTI_ID, 1, 1);
  assert.equal(second.status, 'complete');
  if (second.status === 'complete') {
    assert.equal(answerSnapshotText(second), '1: 2\n2: 2');
  }
});

test('乱序作答也按题序输出', () => {
  resetPending();
  recordMultiQuestionTap(MULTI_ID, 1, 3);
  const first = recordMultiQuestionTap(MULTI_ID, 0, 0);
  assert.equal(first.status, 'complete');
  if (first.status === 'complete') {
    assert.equal(answerSnapshotText(first), '1: 1\n2: 4');
  }
});

test('complete 后 resolving 期间的新点选 -> resolving', () => {
  resetPending();
  assert.equal(recordMultiQuestionTap(MULTI_ID, 0, 0).status, 'buffered');
  assert.equal(recordMultiQuestionTap(MULTI_ID, 1, 0).status, 'complete');
  assert.equal(recordMultiQuestionTap(MULTI_ID, 0, 1).status, 'resolving');
});

test('派发失败复位后可再次触发 complete', () => {
  resetPending();
  recordMultiQuestionTap(MULTI_ID, 0, 0);
  assert.equal(recordMultiQuestionTap(MULTI_ID, 1, 0).status, 'complete');
  markMultiQuestionResolveFailed(MULTI_ID);
  // 重新点选任一题（已齐）再次 complete，且取最后一次选择
  const retry = recordMultiQuestionTap(MULTI_ID, 1, 1);
  assert.equal(retry.status, 'complete');
  if (retry.status === 'complete') {
    assert.equal(answerSnapshotText(retry), '1: 1\n2: 2');
  }
});

test('索引越界 -> unknown', () => {
  resetPending();
  assert.equal(recordMultiQuestionTap(MULTI_ID, 5, 0).status, 'unknown');
  assert.equal(recordMultiQuestionTap(MULTI_ID, 0, 9).status, 'unknown');
});

test('TTL 过期 -> unknown', async () => {
  // 独立 recordId，避免与后续同步用例的重注册交错
  const TTL_ID = 'ask_ffffffffffffffffffffffffffffffff';
  registerPendingMultiQuestion('test-account', TTL_ID, 'c2c', 'peer-ttl', PARSED_QUESTIONS, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recordMultiQuestionTap(TTL_ID, 0, 0).status, 'unknown');
  assert.equal(getPendingMultiQuestions(TTL_ID), null);
  assert.equal(findPendingMultiQuestionByConversation('test-account', 'c2c', 'peer-ttl'), undefined);
});

console.log('\n=== 9. 确认卡答案文本 ===');

test('答案快照 -> keyed 文本（数字选项 1-based，按题序）', () => {
  const answers = new Map<number, MultiQuestionAnswer>([
    [1, { optionIndex: 0 }],
    [0, { optionIndex: 2 }],
  ]);
  assert.equal(buildMultiQuestionAnswerText(answers), '1: 3\n2: 1');
});

test('isOther 自由文本按原文进入 keyed 文本', () => {
  const answers = new Map<number, MultiQuestionAnswer>([
    [0, { text: '我想自己写答案' }],
    [1, { optionIndex: 0 }],
  ]);
  assert.equal(buildMultiQuestionAnswerText(answers), '1: 我想自己写答案\n2: 1');
});

console.log('\n=== 10. 确认卡（正文 + 指令按钮） ===');

test('确认卡正文按题展示已选标签', () => {
  resetPending();
  const questions = getPendingMultiQuestions(MULTI_ID)!;
  const answers = new Map<number, MultiQuestionAnswer>([
    [0, { optionIndex: 2 }],
    [1, { optionIndex: 0 }],
  ]);
  const text = formatMultiQuestionConfirmCard(questions, answers);
  assert.ok(text.startsWith('**✅ 答案确认**'));
  assert.ok(text.includes(`**1.** ${PARSED_QUESTIONS[0]!.header}：`));
  assert.ok(text.includes(`**2.** ${PARSED_QUESTIONS[1]!.header}：`));
  // 第 1 题第 3 项的标签应出现在正文里
  assert.ok(text.includes(splitOptionLabel(PARSED_QUESTIONS[0]!.options[2]!)));
});

test('确认卡正文：isOther 文本答案原样展示，未答题标注', () => {
  resetPending();
  const questions = getPendingMultiQuestions(MULTI_ID)!;
  const text = formatMultiQuestionConfirmCard(
    questions,
    new Map<number, MultiQuestionAnswer>([[0, { text: '自由内容' }]]),
  );
  assert.ok(text.includes(`**1.** ${PARSED_QUESTIONS[0]!.header}：自由内容`));
  assert.ok(text.includes(`**2.** ${PARSED_QUESTIONS[1]!.header}：（未作答）`));
});

test('确认卡键盘：两个指令按钮携带完整答案文本', () => {
  const kb = buildMultiQuestionConfirmKeyboard('1: 3\n2: 1');
  const rows = kb.content.rows;
  assert.equal(rows.length, 1);
  const [submit, edit] = rows[0]!.buttons;
  assert.equal(submit!.render_data.label, '✅ 提交');
  assert.equal(submit!.action.type, 2);
  assert.equal(submit!.action.data, '1: 3\n2: 1');
  assert.equal(submit!.action.enter, true);
  assert.equal(edit!.render_data.label, '✏️ 改一改');
  assert.equal(edit!.action.type, 2);
  assert.equal(edit!.action.data, '1: 3\n2: 1');
  assert.equal(edit!.action.enter, false);
});

test('getPendingMultiQuestions：未登记 -> null，登记后返回题目定义', () => {
  assert.equal(getPendingMultiQuestions('ask_00000000000000000000000000000000'), null);
  resetPending();
  assert.equal(getPendingMultiQuestions(MULTI_ID)!.length, 2);
});

console.log('\n==================================================');
const failed = process.exitCode ?? 0;
console.log(`测试结果: ${failed === 0 ? '全部通过' : `${failed} 个失败`}`);
