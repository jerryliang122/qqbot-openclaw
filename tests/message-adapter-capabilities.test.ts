/**
 * 通道能力声明回归测试（message adapter + agent prompt）
 *
 * 背景：框架给模型开放哪些通道能力，取决于插件声明的
 * `messageToolCapabilities`（提示词侧）与 message adapter 的
 * `live.capabilities`（运行时侧）。声明与实现一旦错配，就会出现
 * 「模型以为能用、实际落地不了」的错配——本仓库此前就踩过：
 * `inlineButtons` 被无条件声明，但 QQ 侧没有通用按钮落地通路，
 * 模型的按钮块被框架降级成纯文本列表。
 *
 * 本测试锁定：
 * - `live.capabilities.nativeStreaming === true`（QQ 私聊原生流式）
 * - `draftPreview` 保持 false（QQ 无「草稿占位 + 原地改写」两阶段结构）
 * - `inlineButtons` 声明**必须**有对应的落地实现（renderPresentation +
 *   presentationCapabilities）——防止将来回退成「声明但不落地」
 * - `questionInputMode === 'buttons'`（openclaw 2026.11.5 起 core 按频道
 *   能力发放 `ask_user`；漏声明 ⇒ 工具目录里没有 ask_user ⇒ agent 静默
 *   退化为纯文本提问，issue #113），且该声明**必须**有原生按钮落地实现
 *
 * 运行方式：npx tsx tests/message-adapter-capabilities.test.ts
 */

import assert from 'node:assert';
import { qqbotMessageAdapter } from '../src/message-adapter.js';
import { qqbotAgentPromptAdapter } from '../src/agent-prompt-adapter.js';
import {
  readQQQuestionContext,
  renderQQBotKeyboard,
} from '../src/outbound/presentation-buttons.js';
import { buildQuestionOptionKeyboard } from '../src/features/question-card.js';
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

/** 框架的合法 live 能力键（与 openclaw 的 channelMessageLiveCapabilities 一致） */
const VALID_LIVE_CAPABILITIES = [
  'draftPreview',
  'previewFinalization',
  'progressUpdates',
  'nativeStreaming',
  'quietFinalization',
] as const;

async function main() {
  // ── live.capabilities ─────────────────────────────────────────────

  await test('live.capabilities 声明 nativeStreaming（QQ 私聊原生流式）', () => {
    const caps = qqbotMessageAdapter.live.capabilities;
    assert.strictEqual(caps.nativeStreaming, true, 'nativeStreaming 应为 true');
  });

  await test('live.capabilities 的 draftPreview 保持 false（QQ 无草稿占位语义）', () => {
    const caps = qqbotMessageAdapter.live.capabilities;
    assert.strictEqual(
      caps.draftPreview,
      false,
      'draftPreview 是 Telegram 的 edit-preview 模型；QQ 流式是单消息前缀增长，不适用',
    );
  });

  await test('live.capabilities 保留 progressUpdates: true', () => {
    assert.strictEqual(qqbotMessageAdapter.live.capabilities.progressUpdates, true);
  });

  await test('live.capabilities 只使用框架白名单内的键', () => {
    const caps = qqbotMessageAdapter.live.capabilities as Record<string, unknown>;
    for (const key of Object.keys(caps)) {
      assert.ok(
        (VALID_LIVE_CAPABILITIES as readonly string[]).includes(key),
        `非法 live 能力键：${key}（框架白名单：${VALID_LIVE_CAPABILITIES.join(', ')}）`,
      );
    }
  });

  await test('live.finalizer.capabilities 保留 finalEdit: false（QQ 无编辑接口）', () => {
    assert.strictEqual(qqbotMessageAdapter.live.finalizer.capabilities.finalEdit, false);
  });

  // ── messageToolCapabilities ───────────────────────────────────────

  await test('messageToolCapabilities 声明 inlineButtons', () => {
    const caps = qqbotAgentPromptAdapter.messageToolCapabilities({
      cfg: undefined,
      accountId: null,
    });
    assert.ok(Array.isArray(caps), '应返回数组');
    assert.ok(caps.includes('inlineButtons'), '应包含 inlineButtons');
  });

  await test('messageToolCapabilities 只使用框架认可的两个值', () => {
    const caps = qqbotAgentPromptAdapter.messageToolCapabilities({
      cfg: undefined,
      accountId: null,
    }) as string[];
    for (const cap of caps) {
      assert.ok(
        cap === 'inlineButtons' || cap === 'markdownDetails',
        `非法 messageToolCapabilities 值：${cap}`,
      );
    }
  });

  // ── 声明与实现的一致性守卫 ─────────────────────────────────────────

  await test('声明 inlineButtons 则必须存在落地实现（renderPresentation + presentationCapabilities）', () => {
    const outbound = qqbotMessageAdapter.outbound as unknown as Record<string, unknown>;
    assert.ok(
      typeof outbound.renderPresentation === 'function',
      '声明了 inlineButtons 就必须有 renderPresentation 实现，否则模型按钮会被降级成纯文本',
    );
    assert.ok(
      outbound.presentationCapabilities &&
        typeof outbound.presentationCapabilities === 'object',
      '声明了 inlineButtons 就必须有 presentationCapabilities 声明',
    );
    const caps = outbound.presentationCapabilities as { buttons?: boolean; supported?: boolean };
    assert.strictEqual(caps.supported, true, 'presentationCapabilities.supported 应为 true');
    assert.strictEqual(caps.buttons, true, 'presentationCapabilities.buttons 应为 true');
  });

  await test('outbound 提供 sendPayload（按钮经 channelData 传递到发送层）', () => {
    const outbound = qqbotMessageAdapter.outbound as unknown as Record<string, unknown>;
    assert.ok(
      typeof outbound.sendPayload === 'function',
      '框架对含 channelData 的 payload 走 sendPayload 路径；缺它按钮到不了发送层',
    );
  });

  // ── questionInputMode（ask_user 工具目录闸门）──────────────────────
  //
  // ⚠️ openclaw 2026.11.5 起，core 按频道能力发放 `ask_user`：
  // `shouldIncludePrimarySessionToolForOpenClawTools` 读
  // `questionInputMode`，既不是 "native" 也不是 "buttons" 就把 ask_user
  // 从**工具目录**里剔除（缺省 "none"）。core 的解析来源是入站频道插件：
  //   getChannelPlugin(channel)?.agentPrompt?.questionInputMode ?? "none"
  //
  // 漏声明的后果是**静默降级**：插件不报错、编译不通过也不会提示，
  // 只是 ask_user 从目录消失 ⇒ agent 改用纯文本提问，QQ 用户看到的
  // 单题 / 多题卡片与按钮全部消失（issue #113，11.4 → 11.5 升级触发）。

  await test('questionInputMode 声明为 buttons（ask_user 进入工具目录的前提）', () => {
    assert.strictEqual(
      qqbotAgentPromptAdapter.questionInputMode,
      'buttons',
      'questionInputMode 必须是 "buttons"——删掉/写错会让 core 把 ask_user ' +
        '从工具目录剔除，agent 静默退化为纯文本提问（issue #113）',
    );
  });

  await test('questionInputMode 只使用 core 认可的字面量', () => {
    const mode = qqbotAgentPromptAdapter.questionInputMode as string;
    assert.ok(
      mode === 'buttons' || mode === 'native' || mode === 'none',
      `非法 questionInputMode 值：${mode}（core 字面量联合：buttons | native | none）`,
    );
    assert.notStrictEqual(
      mode,
      'none',
      '"none" 等同于未声明——core 会把 ask_user 从工具目录剔除',
    );
  });

  await test('声明 buttons 则必须存在原生按钮落地实现（question action → qqbot:q: 回调）', () => {
    // 框架 presentation 的 question action → QQ 回调型按钮的落地通路。
    // 声明 questionInputMode = "buttons" 是对「QQ 有原生 ask_user 控件」
    // 的承诺，这条通路消失时声明就成了空头支票。
    const context = readQQQuestionContext({
      askUser: { questionId: 'ask_1', optionValues: ['选项A', '选项B'] },
    });
    assert.ok(context, '应解析出 ask_user 上下文');

    const kb = renderQQBotKeyboard(
      {
        blocks: [
          {
            type: 'buttons',
            buttons: [
              {
                label: '选项B',
                action: { type: 'question', questionId: 'ask_1', optionValue: '选项B' },
              },
            ],
          },
        ],
      } as unknown as MessagePresentation,
      context,
    );
    assert.ok(kb, 'question action 应渲染出 QQ 原生键盘');
    const btn = kb.content.rows[0].buttons[0];
    assert.strictEqual(btn.action.type, 1, 'question action 应落地为 QQ 回调型按钮');
    assert.strictEqual(
      btn.action.data,
      'qqbot:q:ask_1:1',
      'question action 应生成 qqbot:q:<questionId>:<optionIndex> 回调',
    );
  });

  await test('ask_user 选项键盘渲染原语存在（question-card）', () => {
    assert.strictEqual(
      typeof buildQuestionOptionKeyboard,
      'function',
      '单题/多题共用的选项键盘渲染原语必须存在——它是 ask_user 卡片按钮的来源',
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
