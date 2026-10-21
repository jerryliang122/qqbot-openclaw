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
 *
 * 运行方式：npx tsx tests/message-adapter-capabilities.test.ts
 */

import assert from 'node:assert';
import { qqbotMessageAdapter } from '../src/message-adapter.js';
import { qqbotAgentPromptAdapter } from '../src/agent-prompt-adapter.js';

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
