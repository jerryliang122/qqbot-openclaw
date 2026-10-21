/**
 * QQ 原生按钮（presentation → keyboard）渲染测试
 *
 * 背景：框架的可移植 presentation（`MessagePresentation`）需要由通道侧
 * 落地为平台原生结构。QQ 的落地物是 `keyboard`（与 `markdown`/`content`
 * 平级的一等发送字段）。
 *
 * 本测试锁定：
 * - 框架按钮 action → QQ `action.type` 的映射（url→0 / command→2 /
 *   approval→1 / question→1）
 * - 不可落地控件（web-app / model-picker / callback）**丢弃控件保留文本**
 * - `presentationCapabilities` 各字段取值
 * - 渲染异常不冒泡（降级为纯文本）
 * - 同消息内按钮 id 唯一
 * - ask_user 上下文：optionValue → 选项索引的映射
 *
 * 运行方式：npx tsx tests/presentation-buttons.test.ts
 */

import assert from 'node:assert';
import {
  QQBOT_PRESENTATION_CAPABILITIES,
  countDroppedPresentationControls,
  readQQQuestionContext,
  renderQQBotKeyboard,
} from '../src/outbound/presentation-buttons.js';
import type { MessagePresentation } from 'openclaw/plugin-sdk/interactive-runtime';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.error(`✗ ${name}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 构造一个仅含按钮块的 presentation */
function presentationWithButtons(
  buttons: Array<Record<string, unknown>>,
): MessagePresentation {
  return {
    blocks: [
      {
        type: 'buttons',
        buttons: buttons as never,
      },
    ],
  } as unknown as MessagePresentation;
}

async function main() {
  // ── 能力声明 ──────────────────────────────────────────────────────

  await test('presentationCapabilities: buttons=true 且 selects/tables/charts/context/divider=false', () => {
    const caps = QQBOT_PRESENTATION_CAPABILITIES;
    assert.strictEqual(caps.supported, true, 'supported 应为 true');
    assert.strictEqual(caps.buttons, true, 'buttons 应为 true（QQ 支持原生按钮）');
    assert.strictEqual(caps.selects, false, 'QQ 无 select/菜单形态');
    assert.strictEqual(caps.tables, false, 'QQ 无表格块');
    assert.strictEqual(caps.charts, false, 'QQ 无图表块');
    assert.strictEqual(caps.context, false, 'QQ 无 context 低强调块');
    assert.strictEqual(caps.divider, false, 'QQ 无 divider 块');
  });

  await test('presentationCapabilities: limits 声明了按钮数与长度上限', () => {
    const limits = QQBOT_PRESENTATION_CAPABILITIES.limits.actions;
    assert.ok(limits.maxActions && limits.maxActions > 0, 'maxActions 应为正');
    assert.ok(limits.maxActionsPerRow && limits.maxActionsPerRow > 0, 'maxActionsPerRow 应为正');
    assert.ok(limits.maxLabelLength && limits.maxLabelLength > 0, 'maxLabelLength 应为正');
    assert.strictEqual(limits.supportsStyles, false, 'QQ 按钮 style 语义与框架不同，不支持');
  });

  // ── url 按钮 ──────────────────────────────────────────────────────

  await test('url 按钮 → QQ action.type=0（跳转链接），data 为 URL', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: '打开文档', action: { type: 'url', url: 'https://example.com/doc' } },
      ]),
    );
    assert.ok(kb, '应渲染出 keyboard');
    const rows = kb.content.rows;
    assert.strictEqual(rows.length, 1);
    const btn = rows[0].buttons[0];
    assert.strictEqual(btn.action.type, 0, 'url 应映射为 QQ action.type=0');
    assert.strictEqual(btn.action.data, 'https://example.com/doc');
    assert.strictEqual(btn.render_data.label, '打开文档');
    assert.ok(btn.id, '按钮应有 id');
  });

  await test('非 http(s) URL 被丢弃（不产生按钮）', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: '危险链接', action: { type: 'url', url: 'javascript:alert(1)' } },
      ]),
    );
    assert.strictEqual(kb, null, '非 http(s) URL 不应产生键盘');
  });

  // ── command 按钮 ──────────────────────────────────────────────────

  await test('command 按钮 → QQ action.type=2（指令型），enter=true', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: '查看状态', action: { type: 'command', command: '/bot-status' } },
      ]),
    );
    assert.ok(kb);
    const btn = kb.content.rows[0].buttons[0];
    assert.strictEqual(btn.action.type, 2, 'command 应映射为 QQ action.type=2');
    assert.strictEqual(btn.action.data, '/bot-status');
    assert.strictEqual(btn.action.enter, true, '指令型应 enter=true（点击后直接发出）');
  });

  // ── approval 按钮 ─────────────────────────────────────────────────

  await test('approval 按钮 → QQ action.type=1，data 为 approve:v2: 格式', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '允许',
          action: {
            type: 'approval',
            approvalId: 'ap_123',
            approvalKind: 'exec',
            decision: 'allow-once',
          },
        },
      ]),
    );
    assert.ok(kb);
    const btn = kb.content.rows[0].buttons[0];
    assert.strictEqual(btn.action.type, 1, 'approval 应映射为 QQ action.type=1');
    assert.strictEqual(btn.action.data, 'approve:v2:exec:ap_123:allow-once');
  });

  // ── question 按钮（需 ask_user 上下文）────────────────────────────

  await test('question 按钮：无 ask_user 上下文时丢弃控件', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '选项A',
          action: { type: 'question', questionId: 'ask_1', optionValue: '选项A' },
        },
      ]),
    );
    assert.strictEqual(kb, null, '缺少 ask_user 上下文时不应产生按钮');
  });

  await test('question 按钮：有 ask_user 上下文时映射为索引并生成 qqbot:q: 回调', () => {
    const context = readQQQuestionContext({
      askUser: { questionId: 'ask_1', optionValues: ['选项A', '选项B'] },
    });
    assert.ok(context, '应解析出 ask_user 上下文');

    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '选项B',
          action: { type: 'question', questionId: 'ask_1', optionValue: '选项B' },
        },
      ]),
      context,
    );
    assert.ok(kb);
    const btn = kb.content.rows[0].buttons[0];
    assert.strictEqual(btn.action.type, 1);
    assert.strictEqual(btn.action.data, 'qqbot:q:ask_1:1', '选项B 应映射为索引 1');
  });

  await test('question 按钮：optionValue 大小写/空白不敏感匹配', () => {
    const context = readQQQuestionContext({
      askUser: { questionId: 'ask_1', optionValues: ['Yes', 'No'] },
    });
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '是',
          action: { type: 'question', questionId: 'ask_1', optionValue: '  YES  ' },
        },
      ]),
      context,
    );
    assert.ok(kb);
    assert.strictEqual(kb.content.rows[0].buttons[0].action.data, 'qqbot:q:ask_1:0');
  });

  await test('question 按钮：intent=custom-input 被丢弃（QQ 无对应路由）', () => {
    const context = readQQQuestionContext({
      askUser: { questionId: 'ask_1', optionValues: ['A', 'B'] },
    });
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '其他',
          action: { type: 'question', questionId: 'ask_1', intent: 'custom-input' },
        },
      ]),
      context,
    );
    assert.strictEqual(kb, null, 'custom-input 应被丢弃');
  });

  // ── 不可落地的控件 ────────────────────────────────────────────────

  await test('callback 按钮被丢弃（QQ 无按钮点击回流通道）', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([{ label: '回调', value: 'some-value' }]),
    );
    assert.strictEqual(kb, null, 'callback 不应产生按钮');
  });

  await test('web-app 按钮被丢弃', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: 'Web', action: { type: 'web-app', url: 'https://example.com' } },
      ]),
    );
    assert.strictEqual(kb, null, 'web-app 不应产生按钮');
  });

  await test('model-picker 按钮被丢弃', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        {
          label: '换模型',
          action: {
            type: 'model-picker',
            version: 1,
            snapshotToken: 'tok_123',
            intent: 'show-models',
          },
        },
      ]),
    );
    assert.strictEqual(kb, null, 'model-picker 不应产生按钮');
  });

  await test('dropped 统计按 action 类型分桶', () => {
    const stats = countDroppedPresentationControls(
      presentationWithButtons([
        { label: 'A', value: 'v' },
        {
          label: 'B',
          action: { type: 'web-app', url: 'https://example.com' },
        },
      ]),
    );
    assert.strictEqual(stats.dropped, 2);
    assert.ok(stats.reasons['callback'] === 1, 'callback 应计 1');
    assert.ok(stats.reasons['web-app'] === 1, 'web-app 应计 1');
  });

  // ── id 唯一性 ─────────────────────────────────────────────────────

  await test('同消息内多个按钮的 id 唯一', () => {
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: 'A', action: { type: 'url', url: 'https://example.com/a' } },
        { label: 'B', action: { type: 'url', url: 'https://example.com/b' } },
        { label: 'C', action: { type: 'url', url: 'https://example.com/c' } },
      ]),
    );
    assert.ok(kb);
    const ids = kb.content.rows.flatMap((row) => row.buttons.map((b) => b.id));
    assert.strictEqual(ids.length, 3);
    assert.strictEqual(new Set(ids).size, 3, '按钮 id 必须唯一');
  });

  // ── 行拆分 ────────────────────────────────────────────────────────

  await test('按钮按 maxActionsPerRow 拆行', () => {
    const buttons = Array.from({ length: 7 }, (_, i) => ({
      label: `B${i}`,
      action: { type: 'url', url: `https://example.com/${i}` },
    }));
    const kb = renderQQBotKeyboard(presentationWithButtons(buttons));
    assert.ok(kb);
    const perRow = QQBOT_PRESENTATION_CAPABILITIES.limits.actions.maxActionsPerRow ?? 3;
    for (const row of kb.content.rows) {
      assert.ok(row.buttons.length <= perRow, `每行不应超过 ${perRow} 个按钮`);
    }
    const total = kb.content.rows.reduce((n, row) => n + row.buttons.length, 0);
    assert.strictEqual(total, 7, '按钮总数不应丢失');
  });

  // ── 边界 ──────────────────────────────────────────────────────────

  await test('空 presentation 返回 null', () => {
    const kb = renderQQBotKeyboard({ blocks: [] } as unknown as MessagePresentation);
    assert.strictEqual(kb, null);
  });

  await test('label 超长被截断', () => {
    const longLabel = 'x'.repeat(200);
    const kb = renderQQBotKeyboard(
      presentationWithButtons([
        { label: longLabel, action: { type: 'url', url: 'https://example.com' } },
      ]),
    );
    assert.ok(kb);
    const label = kb.content.rows[0].buttons[0].render_data.label;
    const max = QQBOT_PRESENTATION_CAPABILITIES.limits.actions.maxLabelLength ?? 40;
    assert.ok(label.length <= max, `label 应截断到 ${max} 以内，实际 ${label.length}`);
  });

  await test('非 http 块（纯文本块）不产生键盘', () => {
    const kb = renderQQBotKeyboard({
      blocks: [{ type: 'text', text: 'hello' }],
    } as unknown as MessagePresentation);
    assert.strictEqual(kb, null, '纯文本块不应产生键盘');
  });

  // ── ask_user 上下文解析 ───────────────────────────────────────────

  await test('readQQQuestionContext: 缺少 askUser 返回 undefined', () => {
    assert.strictEqual(readQQQuestionContext(undefined), undefined);
    assert.strictEqual(readQQQuestionContext({}), undefined);
    assert.strictEqual(readQQQuestionContext({ askUser: 'bad' }), undefined);
  });

  await test('readQQQuestionContext: optionValues 数量越界返回 undefined', () => {
    assert.strictEqual(
      readQQQuestionContext({ askUser: { questionId: 'q', optionValues: ['only'] } }),
      undefined,
      '少于 2 个选项应拒绝',
    );
    assert.strictEqual(
      readQQQuestionContext({
        askUser: { questionId: 'q', optionValues: ['a', 'b', 'c', 'd', 'e'] },
      }),
      undefined,
      '多于 4 个选项应拒绝',
    );
  });

  await test('readQQQuestionContext: 重复选项应拒绝（映射不明确）', () => {
    assert.strictEqual(
      readQQQuestionContext({
        askUser: { questionId: 'q', optionValues: ['same', 'SAME'] },
      }),
      undefined,
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\n失败用例：\n${failedTests.map((t) => `  - ${t}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
