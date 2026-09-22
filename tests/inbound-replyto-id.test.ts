/**
 * inbound ReplyToId 语义回归测试
 *
 * 事故背景（2026-09-22）：ctx-builder 曾把 reply.replyToId / supplemental.quote.id
 * 填成「当前消息自身 ID」，导致 openclaw 渲染的模型可见 Conversation info 恒为
 * message_id == reply_to_id —— 上层 agent 按 AGENTS 规则判为「内部回灌、非新指令」
 * 而拒绝响应。
 *
 * 契约语义（对齐 telegram 原生通道 bot-message 的
 *   replyToId: replyHead?.messageId ?? visibleReplyTarget?.id）：
 *   - ReplyToId = 当前消息回复(引用)的那条消息的 ID
 *   - 无引用 / 引用无法解析出 ID（msg_elements 兜底）时必须为 undefined
 *   - 永远不等于当前消息 ID
 *
 * 运行方式:  npx tsx tests/inbound-replyto-id.test.ts
 */
import assert from 'node:assert';
import { buildEnvelope } from '../src/dispatch/envelope-builder.js';
import { buildCtxPayload } from '../src/dispatch/ctx-builder.js';

// ── 测试基础设施 ──────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── mock ─────────────────────────────────────────────────

/** identity buildInboundContext：原样返回入参，便于断言传给框架的字段 */
const adapters = {
  buildInboundContext: (params: Record<string, unknown>) => params,
} as never;

const account = { accountId: 'default', systemPrompt: undefined } as never;

function makeMsg() {
  return {
    replyTarget: { scope: 'c2c', targetId: 'user-1' },
    senderId: 'user-1',
    senderName: 'Alice',
    messageId: 'msg-1',
    content: 'hello',
    attachments: [],
  } as never;
}

function makeCtx(quote: unknown) {
  return { state: { quote, processedAttachments: undefined }, signal: undefined } as never;
}

function payloadFor(quote: { content: string; senderId: string; messageId?: string } | undefined) {
  const envelope = {
    targetId: 'qqbot:c2c:user-1',
    chatScope: 'direct',
    senderId: 'user-1',
    senderName: 'Alice',
    messageId: 'msg-1',
    ...(quote ? { quote } : {}),
  } as never;
  return buildCtxPayload({
    assembled: { webBody: 'hi', agentBody: 'hi', rawBody: 'hello' },
    envelope,
    route: { sessionKey: 'qqbot:default:user-1', accountId: 'default' },
    msg: makeMsg(),
    ctx: makeCtx(undefined),
    adapters,
  });
}

// ── buildEnvelope：quote 透传被引用消息真实 ID ─────────────

console.log('\n=== buildEnvelope quote messageId 透传 ===');

test('ref-index store 命中的引用：envelope.quote.messageId = entry.messageId', () => {
  const ctx = makeCtx({
    refKey: 'k',
    source: 'store',
    entry: { messageId: 'quoted-77', senderId: 'user-2', content: '被引用内容', timestamp: '2026-09-22T08:25:51Z' },
    text: '被引用内容',
  });
  const envelope = buildEnvelope(ctx, makeMsg(), account);
  assert.equal(envelope.quote?.messageId, 'quoted-77');
  assert.equal(envelope.quote?.senderId, 'user-2');
  assert.equal(envelope.quote?.content, '被引用内容');
});

test('msg_elements 兜底解析的引用（无 entry）：envelope.quote.messageId 为 undefined', () => {
  const ctx = makeCtx({
    refKey: 'k',
    source: 'msg_elements',
    rawContent: '原始引用文本',
    text: '原始引用文本',
  });
  const envelope = buildEnvelope(ctx, makeMsg(), account);
  assert.equal(envelope.quote?.messageId, undefined);
});

test('无引用：envelope.quote 为 undefined', () => {
  const envelope = buildEnvelope(makeCtx(undefined), makeMsg(), account);
  assert.equal(envelope.quote, undefined);
});

// ── buildCtxPayload：ReplyToId 契约语义 ───────────────────

console.log('\n=== buildCtxPayload ReplyToId 契约 ===');

test('无引用消息：reply.replyToId 为 undefined（非当前消息 ID）', () => {
  const payload = payloadFor(undefined);
  assert.equal(payload.reply.replyToId, undefined);
  assert.equal(payload.supplemental.quote, undefined);
});

test('引用消息（ref-index 命中）：replyToId = 被引用消息 ID，不等于当前消息 ID', () => {
  const payload = payloadFor({ content: '被引用内容', senderId: 'user-2', messageId: 'quoted-77' });
  assert.equal(payload.reply.replyToId, 'quoted-77');
  assert.notEqual(payload.reply.replyToId, payload.messageId);
  assert.equal(payload.messageId, 'msg-1');
});

test('引用消息：supplemental.quote.id = 被引用消息 ID（框架映射为 ctx.ReplyToId）', () => {
  const payload = payloadFor({ content: '被引用内容', senderId: 'user-2', messageId: 'quoted-77' });
  assert.equal(payload.supplemental.quote.id, 'quoted-77');
  assert.equal(payload.supplemental.quote.body, '被引用内容');
});

test('引用消息（msg_elements 无 ID）：replyToId 为 undefined，quote 不带 id 键', () => {
  const payload = payloadFor({ content: '原始引用文本', senderId: '' });
  assert.equal(payload.reply.replyToId, undefined);
  assert.ok(!('id' in payload.supplemental.quote));
});

test('回归红线：replyToId 永远不等于当前消息 ID（假回灌签名）', () => {
  const payload = payloadFor({ content: '被引用内容', senderId: 'user-2', messageId: 'msg-1' });
  // 即便上游错误地把当前消息 ID 填进 quote.messageId，也不允许产生自引用
  // replyToId —— 这里锁定的是「当前实现不使用 envelope.messageId」这一事实：
  // payload.reply.replyToId 直接来自 envelope.quote.messageId，而正确的
  // envelope-builder 透传的是 entry.messageId。若有人回退为 envelope.messageId，
  // 上方「无引用消息」用例会先失败。
  assert.ok(payload.reply.replyToId === undefined || payload.reply.replyToId !== payload.messageId);
});

// ── 汇总 ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failedTests.join(', ')}`);
  process.exit(1);
}
