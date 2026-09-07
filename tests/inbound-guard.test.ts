/**
 * 入站事件守卫测试（inboundGuard + outbound-echo-store）
 *
 * 覆盖三类拦截：出站回声 / 重复推送 / 空内容事件，
 * 以及必须放行的真实用户消息形态（纯文本、仅附件、引用/转发消息）。
 *
 * 运行方式: npx tsx tests/inbound-guard.test.ts
 */
import assert from 'node:assert';
import { inboundGuard, clearInboundGuardDedup } from '../src/middleware/inbound-guard.js';
import {
  recordOutboundMessageId,
  isOutboundEcho,
  clearOutboundEchoStore,
} from '../src/features/outbound-echo-store.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗ ${name}\n    ${msg}`);
      failed++;
      failedTests.push(name);
    });
}

// ── Mock 工具 ──────────────────────────────────────────

interface GuardOutcome {
  stopped: boolean;
  stopReason?: string;
  nextCalled: boolean;
  infoLogs: string[];
}

function runGuard(message: Record<string, unknown>): Promise<GuardOutcome> {
  const outcome: GuardOutcome = { stopped: false, nextCalled: false, infoLogs: [] };
  const ctx = {
    message,
    state: {},
    log: {
      info: (m: string) => outcome.infoLogs.push(m),
      debug: () => {},
      warn: () => {},
      error: () => {},
    },
    stop(reason?: string) {
      outcome.stopped = true;
      outcome.stopReason = reason;
    },
  };
  const middleware = inboundGuard({ accountId: 'test-account' });
  return Promise.resolve(
    (middleware as any)(ctx, async () => {
      outcome.nextCalled = true;
    }),
  ).then(() => outcome);
}

function c2cMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'c2c',
    messageId: `msg-${Math.random().toString(36).slice(2, 10)}`,
    content: '你好',
    senderId: 'user-openid',
    msgType: 0,
    raw: { id: 'raw', content: '你好' },
    ...overrides,
  };
}

// ── outbound-echo-store ────────────────────────────────

group('outbound-echo-store');

await test('登记后命中出站回声，未登记/清空后不命中', () => {
  clearOutboundEchoStore();
  recordOutboundMessageId('test-account', 'out-1');
  assert.strictEqual(isOutboundEcho('test-account', 'out-1'), true, '登记后应命中');
  assert.strictEqual(isOutboundEcho('test-account', 'out-2'), false, '未登记不应命中');
  assert.strictEqual(isOutboundEcho('other-account', 'out-1'), false, '跨账号不应命中');
  clearOutboundEchoStore();
  assert.strictEqual(isOutboundEcho('test-account', 'out-1'), false, '清空后不应命中');
});

await test('空 id 不登记、不命中', () => {
  clearOutboundEchoStore();
  recordOutboundMessageId('test-account', undefined);
  recordOutboundMessageId('test-account', '');
  assert.strictEqual(isOutboundEcho('test-account', undefined), false);
  assert.strictEqual(isOutboundEcho('test-account', ''), false);
});

// ── inboundGuard：出站回声 ─────────────────────────────

group('inboundGuard 出站回声拦截');

await test('入站 messageId 命中近期出站 id → 拦截且不进入下游', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  recordOutboundMessageId('test-account', 'echoed-1');
  const outcome = await runGuard(c2cMsg({ messageId: 'echoed-1', content: 'bot 自己的回复' }));
  assert.strictEqual(outcome.stopped, true, '应被拦截');
  assert.strictEqual(outcome.stopReason, 'outbound-echo');
  assert.strictEqual(outcome.nextCalled, false, 'next 不应被调用');
  assert.ok(outcome.infoLogs.some((l) => l.includes('outbound-echo')), '应有 INFO 留痕');
});

// ── inboundGuard：重复推送 ─────────────────────────────

group('inboundGuard 重复推送去重');

await test('相同 msgId+msgIdx 二次推送 → 拦截', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const msg = c2cMsg({ messageId: 'dup-1', msgIdx: '5' });
  const first = await runGuard(msg);
  assert.strictEqual(first.stopped, false, '首次应放行');
  assert.strictEqual(first.nextCalled, true);
  const second = await runGuard(c2cMsg({ messageId: 'dup-1', msgIdx: '5', content: '你好' }));
  assert.strictEqual(second.stopped, true, '重推应拦截');
  assert.strictEqual(second.stopReason, 'duplicate-push');
  assert.strictEqual(second.nextCalled, false);
  assert.ok(second.infoLogs.some((l) => l.includes('duplicate-push')));
});

await test('相同 msgId 不同 msgIdx → 放行（新逻辑消息）', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  await runGuard(c2cMsg({ messageId: 'dup-2', msgIdx: '1' }));
  const second = await runGuard(c2cMsg({ messageId: 'dup-2', msgIdx: '2' }));
  assert.strictEqual(second.stopped, false, '不同 msgIdx 应放行');
  assert.strictEqual(second.nextCalled, true);
});

// ── inboundGuard：空内容事件 ───────────────────────────

group('inboundGuard 空内容拦截');

await test('content 空、无附件、无 msg_elements → 拦截并留 payload 取证', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(
    c2cMsg({
      messageId: 'empty-1',
      content: '',
      msgType: 101,
      messageScene: { source: 'chat_window' },
      raw: { id: 'empty-1', content: '', message_type: 101 },
    }),
  );
  assert.strictEqual(outcome.stopped, true, '空内容应拦截');
  assert.strictEqual(outcome.stopReason, 'contentless');
  assert.strictEqual(outcome.nextCalled, false);
  const log = outcome.infoLogs.find((l) => l.includes('contentless'));
  assert.ok(log, '应有 contentless INFO 日志');
  assert.ok(log!.includes('msgType=101'), '日志应含 msgType');
  assert.ok(log!.includes('payload='), '日志应含 payload 摘要');
});

await test('content 纯空白 → 拦截', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(c2cMsg({ messageId: 'empty-2', content: '   ' }));
  assert.strictEqual(outcome.stopped, true);
  assert.strictEqual(outcome.stopReason, 'contentless');
});

await test('content 缺省（undefined）→ 拦截', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(c2cMsg({ messageId: 'empty-3', content: undefined }));
  assert.strictEqual(outcome.stopped, true);
  assert.strictEqual(outcome.stopReason, 'contentless');
});

// ── inboundGuard：真实用户消息必须放行 ─────────────────

group('inboundGuard 真实消息放行');

await test('纯文本消息 → 放行', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(c2cMsg({ messageId: 'text-1', content: '帮我查一下' }));
  assert.strictEqual(outcome.stopped, false);
  assert.strictEqual(outcome.nextCalled, true);
});

await test('仅图片消息（content 空 + attachments）→ 放行', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(
    c2cMsg({
      messageId: 'img-1',
      content: '',
      attachments: [{ content_type: 'image/jpeg', url: 'https://example.test/a.jpg' }],
    }),
  );
  assert.strictEqual(outcome.stopped, false, '附件消息不得误杀');
  assert.strictEqual(outcome.nextCalled, true);
});

await test('引用/转发消息（content 空白 + msg_elements）→ 放行', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(
    c2cMsg({
      messageId: 'quote-1',
      content: ' ',
      msgType: 103,
      msgIdx: '9',
      msgElements: [{ msg_idx: '7', content: '被引用的旧消息' }],
    }),
  );
  assert.strictEqual(outcome.stopped, false, '103 引用消息是真实用户操作，必须放行');
  assert.strictEqual(outcome.nextCalled, true);
});

await test('仅 @bot 的群消息（原始 content 含 mention 标记，非空白）→ 放行', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(
    c2cMsg({
      kind: 'group',
      messageId: 'mention-1',
      content: ' <@!bot-openid> ',
      groupOpenid: 'group-1',
    }),
  );
  assert.strictEqual(outcome.stopped, false);
  assert.strictEqual(outcome.nextCalled, true);
});

await test('语音消息（content 空 + voice 附件）→ 放行', async () => {
  clearOutboundEchoStore();
  clearInboundGuardDedup();
  const outcome = await runGuard(
    c2cMsg({
      messageId: 'voice-1',
      content: '',
      attachments: [{ content_type: 'voice', url: 'https://example.test/v.ptt' }],
    }),
  );
  assert.strictEqual(outcome.stopped, false, '语音走 STT，附件存在即放行');
  assert.strictEqual(outcome.nextCalled, true);
});

// ── 输出测试结果 ──────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach(name => console.log(`  - ${name}`));
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  process.exit(0);
}
