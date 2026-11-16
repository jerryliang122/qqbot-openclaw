/**
 * 持久化入站载荷 回归测试
 *
 * 覆盖：
 * 1. 载荷编解码往返（buildIngressPayload → decodeIngressPayload）；
 * 2. 版本不认识 / 结构损坏 → 判为不可重试（错误分类，不许无限重投）；
 * 3. ctx 重建：dispatch 与正文装配器读到的字段与原 ctx 一致
 *    （assembledBody / mention / nameMentioned / mentionPatterns /
 *     processedAttachments / quote / history / roomEventPolicy）；
 * 4. **排序键 = 本地到达时刻**（不是平台 timestamp——群成员设备时钟
 *    不一致，用平台时间排序会把批次排错）。
 *
 * 运行方式: npx tsx tests/ingress-payload.test.ts
 */
import assert from 'node:assert/strict';
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import {
  buildIngressPayload,
  decodeIngressPayload,
  ingressPayloadOrderKey,
  rebuildIngressMember,
  INGRESS_PAYLOAD_VERSION,
  type QQBotIngressPayload,
} from '../src/features/ingress-payload.js';

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
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

/** 造一个最小的活 ctx（只需中间件链会写的那些 state 字段） */
function makeCtx(state: Record<string, unknown>, content = 'hello'): MiddlewareContext {
  return {
    message: { content } as unknown as QQBotInboundMessage,
    state,
    signal: new AbortController().signal,
  } as unknown as MiddlewareContext;
}

/** 造一个最小的群消息 */
function makeMsg(overrides: Record<string, unknown> = {}): QQBotInboundMessage {
  return {
    kind: 'group',
    content: 'hello',
    messageId: 'm1',
    senderId: 'u1',
    senderName: '张三',
    timestamp: '1700000000',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    replyTarget: { scope: 'group', targetId: 'g1' },
    ...overrides,
  } as unknown as QQBotInboundMessage;
}

group('载荷编解码');

await test('build → decode 往返：关键字段逐字一致', () => {
  const ctx = makeCtx({
    mention: { wasMentioned: true, implicit: false },
    nameMentioned: true,
    mentionPatterns: ['沈处'],
    processedAttachments: { voiceText: '', imageUrls: [], otherInfo: '', transcripts: [], localMediaPaths: [], localMediaTypes: [], remoteMediaUrls: [], media: [] },
    assembledBody: { webBody: 'w', agentBody: 'a', rawBody: 'r' },
    envelope: 'env',
    quote: { content: 'q', senderId: 'u0' },
    history: [{ role: 'user', content: 'h' }],
    roomEventPolicy: { mode: 'room_event', source: 'group', visibleReplies: 'automatic', messageToolAvailable: true, effectiveMode: 'room_event', degraded: false },
  });
  const payload = buildIngressPayload({
    ctx,
    msg: makeMsg(),
    accountId: 'acc1',
    groupOpenid: 'g1',
    receivedAtMs: 1234,
    cfg: {},
  });

  assert.equal(payload.v, INGRESS_PAYLOAD_VERSION);
  assert.equal(payload.accountId, 'acc1');
  assert.equal(payload.groupOpenid, 'g1');
  assert.equal(payload.messageId, 'm1');
  assert.equal(payload.senderId, 'u1');
  assert.equal(payload.receivedAtMs, 1234);
  assert.equal(payload.mention.wasMentioned, true);
  assert.equal(payload.nameMentioned, true);
  assert.deepEqual(payload.mentionPatterns, ['沈处']);
  assert.equal(payload.assembledBody?.agentBody, 'a');
  assert.equal(payload.envelope, 'env');
  assert.equal(payload.quote?.content, 'q');
  assert.equal(payload.history?.length, 1);
  assert.equal(payload.roomEventPolicy?.effectiveMode, 'room_event');

  const decoded = decodeIngressPayload(JSON.parse(JSON.stringify(payload)));
  assert.ok(decoded.ok);
  assert.equal(decoded.payload.messageId, 'm1');
  assert.equal(decoded.payload.receivedAtMs, 1234);
});

await test('版本不认识 → unsupported_version（不可重试）', () => {
  const decoded = decodeIngressPayload({ v: 999, messageId: 'm1', groupOpenid: 'g1' });
  assert.equal(decoded.ok, false);
  assert.ok(!decoded.ok && decoded.error === 'unsupported_version');
});

await test('结构损坏 → malformed', () => {
  assert.equal(decodeIngressPayload(null).ok, false);
  assert.equal(decodeIngressPayload('x').ok, false);
  const noVersion = decodeIngressPayload({ messageId: 'm1' });
  assert.ok(!noVersion.ok && noVersion.error === 'malformed');
  const noIds = decodeIngressPayload({ v: INGRESS_PAYLOAD_VERSION });
  assert.ok(!noIds.ok && noIds.error === 'malformed');
});

group('ctx 重建');

await test('重建后 dispatch 读到的字段与原 ctx 一致', () => {
  const payload: QQBotIngressPayload = {
    v: INGRESS_PAYLOAD_VERSION,
    accountId: 'acc1',
    groupOpenid: 'g1',
    messageId: 'm1',
    senderId: 'u1',
    senderName: '张三',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    content: '清洗后的正文',
    rawContent: '原始正文',
    platformTimestamp: '1700000000',
    receivedAtMs: 999,
    mention: { wasMentioned: true, implicit: false },
    nameMentioned: true,
    mentionPatterns: ['沈处'],
    quote: { content: 'q', senderId: 'u0' },
    history: [{ role: 'user', content: 'h' }],
    roomEventPolicy: { mode: 'room_event', source: 'group', visibleReplies: 'automatic', messageToolAvailable: true, effectiveMode: 'room_event', degraded: false },
    processedAttachments: { voiceText: 'vt', imageUrls: [], otherInfo: 'oi', transcripts: [], localMediaPaths: [], localMediaTypes: [], remoteMediaUrls: [], media: [] },
    assembledBody: { webBody: 'w', agentBody: 'a', rawBody: 'r' },
  };

  const { ctx, msg } = rebuildIngressMember({ payload });
  const state = ctx.state as Record<string, unknown>;

  assert.equal(state.assembledBody && (state.assembledBody as { agentBody: string }).agentBody, 'a');
  assert.deepEqual(state.mention, { wasMentioned: true, implicit: false });
  assert.equal(state.nameMentioned, true);
  assert.deepEqual(state.mentionPatterns, ['沈处']);
  assert.equal(state.quote && (state.quote as { content: string }).content, 'q');
  assert.equal(Array.isArray(state.history) ? state.history!.length : -1, 1);
  assert.ok(state.roomEventPolicy);
  assert.equal(
    (state.processedAttachments as { voiceText: string }).voiceText,
    'vt',
  );
  assert.equal((ctx.message as { content: string }).content, '清洗后的正文');
  assert.equal(msg.messageId, 'm1');
  assert.equal(msg.replyTarget.scope, 'group');
  assert.equal(msg.replyTarget.targetId, 'g1');
  assert.equal(msg.kind, 'group');
});

await test('重建的 ctx 带 signal（来自 ingress lifecycle）', () => {
  const payload: QQBotIngressPayload = {
    v: INGRESS_PAYLOAD_VERSION,
    accountId: 'acc1',
    groupOpenid: 'g1',
    messageId: 'm1',
    senderId: 'u1',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    content: 'x',
    rawContent: 'x',
    platformTimestamp: '1',
    receivedAtMs: 1,
    mention: { wasMentioned: false, implicit: false },
    nameMentioned: false,
  };
  const controller = new AbortController();
  const { ctx } = rebuildIngressMember({ payload, signal: controller.signal });
  assert.equal(ctx.signal, controller.signal);
});

group('排序键');

await test('排序键取本地到达时刻，不是平台 timestamp', () => {
  const base: QQBotIngressPayload = {
    v: INGRESS_PAYLOAD_VERSION,
    accountId: 'acc1',
    groupOpenid: 'g1',
    messageId: 'm1',
    senderId: 'u1',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    content: 'x',
    rawContent: 'x',
    platformTimestamp: '1700000000',
    receivedAtMs: 111,
    mention: { wasMentioned: false, implicit: false },
    nameMentioned: false,
  };
  assert.equal(ingressPayloadOrderKey(base), 111);

  // 平台 timestamp 乱序（成员设备时钟不一致）时，到达序仍是权威
  const a = { ...base, messageId: 'a', platformTimestamp: '200', receivedAtMs: 1 };
  const b = { ...base, messageId: 'b', platformTimestamp: '100', receivedAtMs: 2 };
  const c = { ...base, messageId: 'c', platformTimestamp: '300', receivedAtMs: 3 };
  const sorted = [a, b, c].sort((x, y) => ingressPayloadOrderKey(x) - ingressPayloadOrderKey(y));
  assert.deepEqual(sorted.map((s) => s.messageId), ['a', 'b', 'c']);
  // 平台时间排序会把 b 排到最前——这正是"群消息错乱"的来源
  const byPlatform = [a, b, c].sort(
    (x, y) => Date.parse(x.platformTimestamp) - Date.parse(y.platformTimestamp),
  );
  assert.deepEqual(byPlatform.map((s) => s.messageId), ['b', 'a', 'c']);
});

await test('旁路判定：斜杠命令被标记为 bypass', () => {
  const ctx = makeCtx({}, '/stop');
  const payload = buildIngressPayload({
    ctx,
    msg: makeMsg({ content: '/stop' }),
    accountId: 'acc1',
    groupOpenid: 'g1',
    cfg: {},
  });
  assert.equal(payload.bypass, true);
});

await test('旁路判定：普通文本不是 bypass', () => {
  const ctx = makeCtx({}, '今天天气不错');
  const payload = buildIngressPayload({
    ctx,
    msg: makeMsg({ content: '今天天气不错' }),
    accountId: 'acc1',
    groupOpenid: 'g1',
    cfg: {},
  });
  assert.equal(payload.bypass, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
