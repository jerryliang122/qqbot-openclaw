/**
 * body-assembler 单元测试
 *
 * 锁定五层组装协议（webBody / agentBody / rawBody / systemPrompt）的输出格式，
 * 防止后续重构破坏协议兼容性。
 *
 * 运行方式:  npx tsx tests/body-assembler.test.ts
 */
import assert from 'node:assert';
import { assembleBody } from '../src/dispatch/body-assembler.js';
import type { VoiceTranscript } from '../src/utils/voice-text.js';
import type { ProcessedAttachments } from '../src/gateway/attachment-middleware.js';

// ── 测试基础设施 ──────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

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

// ── ctx / msg / account 最小可用 mock ─────────────────────

interface MakeCtxInput {
  rawContent?: string;
  sanitizedContent?: string;
  kind?: 'group' | 'c2c';
  senderId?: string;
  senderName?: string;
  groupOpenid?: string;
  state?: Record<string, unknown>;
}

function makeCtx(input: MakeCtxInput = {}) {
  const sanitized = input.sanitizedContent ?? input.rawContent ?? '';
  const message = {
    content: sanitized,
    kind: input.kind ?? 'c2c',
    senderId: input.senderId ?? 'sender-1',
    senderName: input.senderName,
    groupOpenid: input.groupOpenid,
    messageId: 'msg-1',
    timestamp: '0',
    rawEventType: 'group_at_message_create',
    attachments: [],
    raw: {},
  } as unknown;
  // 注：assembleBody 只读 ctx.state / ctx.message，不需要完整 MiddlewareContext
  return {
    message,
    state: input.state ?? {},
  } as never;
}

function makeMsg(input: MakeCtxInput = {}) {
  const sanitized = input.sanitizedContent ?? input.rawContent ?? '';
  return {
    content: input.rawContent ?? sanitized,
    kind: input.kind ?? 'c2c',
    senderId: input.senderId ?? 'sender-1',
    senderName: input.senderName,
    groupOpenid: input.groupOpenid,
    messageId: 'msg-1',
    timestamp: '0',
    rawEventType: 'group_at_message_create',
    attachments: [],
    raw: {},
  } as never;
}

const fakeAccount = {
  accountId: 'acc-1',
  systemPrompt: undefined,
  config: {},
} as never;

// ── Layer 4 · buildDynamicCtx 表驱动 ─────────────────────

group('buildDynamicCtx · Voice/ASR 投影与去重');
interface DynCtxCase {
  name: string;
  processed: ProcessedAttachments;
  expectedContains?: string[];
  expectedNotContains?: string[];
  expectedExact?: string;
}

const dynCtxCases: DynCtxCase[] = [
  {
    name: 'STT 成功：- Voice 用 localPath，- ASR 用 asrReferText',
    processed: makeProcessed({
      transcripts: [
        {
          text: 'hello world',
          source: 'stt',
          localPath: '/tmp/a.wav',
          remoteUrl: 'https://x/a.silk',
          asrReferText: '哈喽 world',
        },
      ],
    }),
    expectedContains: [
      '- Voice: /tmp/a.wav, https://x/a.silk',
      '- ASR: 哈喽 world',
    ],
  },
  {
    name: 'STT 未配置仅有 ASR：- Voice 仅 remoteUrl，- ASR 等于 text',
    processed: makeProcessed({
      transcripts: [
        {
          text: '语音里的话',
          source: 'asr',
          remoteUrl: 'https://x/b.silk',
          asrReferText: '语音里的话',
        },
      ],
    }),
    expectedContains: [
      '- Voice: https://x/b.silk',
      '- ASR: 语音里的话',
    ],
  },
  {
    name: '多条语音：paths/urls 跨条聚合 + 去重',
    processed: makeProcessed({
      transcripts: [
        { text: 't1', source: 'stt', localPath: '/tmp/a.wav', remoteUrl: 'https://x/a.silk' },
        { text: 't2', source: 'stt', localPath: '/tmp/a.wav', remoteUrl: 'https://x/b.silk' }, // localPath 重复
      ],
    }),
    expectedContains: [
      '- Voice: /tmp/a.wav, https://x/a.silk, https://x/b.silk',
    ],
    expectedNotContains: ['/tmp/a.wav, /tmp/a.wav'], // 去重生效
  },
  {
    name: 'fallback 来源：无 ASR 文本时不输出 - ASR 行',
    processed: makeProcessed({
      transcripts: [
        {
          text: '[Voice message - transcription failed]',
          source: 'fallback',
          remoteUrl: 'https://x/c.silk',
        },
      ],
    }),
    expectedContains: ['- Voice: https://x/c.silk'],
    expectedNotContains: ['- ASR'],
  },
  {
    name: '无附件：返回空字符串',
    processed: makeProcessed({}),
    expectedExact: '',
  },
  {
    name: '仅图片：仅输出 - Images',
    processed: makeProcessed({ imageUrls: ['https://x/img1.jpg', 'https://x/img2.jpg'] }),
    expectedContains: ['- Images: https://x/img1.jpg, https://x/img2.jpg'],
    expectedNotContains: ['- Voice', '- ASR'],
  },
];

for (const c of dynCtxCases) {
  test(c.name, () => {
    const ctx = makeCtx({ state: { processedAttachments: c.processed } });
    const msg = makeMsg();
    const { agentBody } = assembleBody(ctx, msg, fakeAccount);
    if (c.expectedExact !== undefined) {
      // 没附件时 dynamicCtx='' & userMessage=''（content 也为空），整体应为空
      assert.strictEqual(agentBody, c.expectedExact, `agentBody:\n${agentBody}`);
      return;
    }
    for (const need of c.expectedContains ?? []) {
      assert.ok(agentBody.includes(need), `期望包含 [${need}]，实际:\n${agentBody}`);
    }
    for (const noNeed of c.expectedNotContains ?? []) {
      assert.ok(!agentBody.includes(noNeed), `期望不含 [${noNeed}]，实际:\n${agentBody}`);
    }
  });
}

// ── Layer 1-3 · userContent / quotePart / userMessage ────

group('userMessage · 群消息带 [Sender] + (@you)');

test('群被@：[Nick (openid)] content (@you)', () => {
  const ctx = makeCtx({
    sanitizedContent: 'hi bot',
    kind: 'group',
    senderId: 'u123',
    senderName: 'Alice',
    state: { mention: { wasMentioned: true } },
  });
  const msg = makeMsg({
    sanitizedContent: 'hi bot',
    kind: 'group',
    senderId: 'u123',
    senderName: 'Alice',
  });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(agentBody, '[Alice (u123)] hi bot (@you)', agentBody);
});

test('群未被@：无 (@you) 后缀', () => {
  const ctx = makeCtx({
    sanitizedContent: 'random chat',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Bob',
    state: { mention: { wasMentioned: false } },
  });
  const msg = makeMsg({ sanitizedContent: 'random chat', kind: 'group', senderId: 'u1', senderName: 'Bob' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(agentBody, '[Bob (u1)] random chat', agentBody);
});

test('DM：无 sender 前缀、无 (@you)', () => {
  const ctx = makeCtx({ sanitizedContent: 'hello', kind: 'c2c', senderId: 'u1' });
  const msg = makeMsg({ sanitizedContent: 'hello', kind: 'c2c', senderId: 'u1' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(agentBody, 'hello', agentBody);
});

test('senderName 已含 senderId：避免双重包裹', () => {
  const ctx = makeCtx({
    sanitizedContent: 'msg',
    kind: 'group',
    senderId: 'abc',
    senderName: 'Nick (abc)',
  });
  const msg = makeMsg({ sanitizedContent: 'msg', kind: 'group', senderId: 'abc', senderName: 'Nick (abc)' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(agentBody, '[Nick (abc)] msg', agentBody);
});

// ── Layer 2 · quotePart ──────────────────────────────────

group('quotePart · 引用消息块');

test('有 quote.text：标准 begins/ends 块', () => {
  const ctx = makeCtx({
    sanitizedContent: '回复内容',
    kind: 'c2c',
    state: { quote: { refKey: 'r1', source: 'store', text: '原话' } },
  });
  const msg = makeMsg({ sanitizedContent: '回复内容' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.ok(agentBody.startsWith('[Quoted message begins]\n原话\n[Quoted message ends]\n'), agentBody);
  assert.ok(agentBody.endsWith('回复内容'), agentBody);
});

test('quote 无 text：fallback Original content unavailable', () => {
  const ctx = makeCtx({
    sanitizedContent: 'reply',
    kind: 'c2c',
    state: { quote: { refKey: 'r1', source: 'store', text: '' } },
  });
  const msg = makeMsg({ sanitizedContent: 'reply' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.ok(agentBody.includes('Original content unavailable'), agentBody);
});

// ── Layer 5 · agentBody 历史前缀 / 命令直通 ──────────────

group('agentBody · history 前缀 / 命令直通');

test('群被@且有 history：前置 [Chat messages since...] 块', () => {
  const ctx = makeCtx({
    sanitizedContent: '问题',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Me',
    state: {
      mention: { wasMentioned: true },
      history: [
        { senderId: 'a', senderName: 'A', content: 'msg-a', timestamp: 0, messageId: 'm1' },
        { senderId: 'b', senderName: 'B', content: 'msg-b', timestamp: 0, messageId: 'm2' },
      ],
    },
  });
  const msg = makeMsg({ sanitizedContent: '问题', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.ok(
    agentBody.startsWith('[Chat history begins]\n'),
    `agentBody=\n${agentBody}`,
  );
  assert.ok(agentBody.includes('[A (a)] msg-a\n[B (b)] msg-b'), agentBody);
  assert.ok(agentBody.includes('[Chat history ends]\n[Current message]\n[Me (u1)] 问题 (@you)'), agentBody);
});

test('群未被@：不前置 history 块', () => {
  const ctx = makeCtx({
    sanitizedContent: 'plain',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Me',
    state: {
      mention: { wasMentioned: false },
      history: [{ senderId: 'a', senderName: 'A', content: 'msg-a', timestamp: 0, messageId: 'm1' }],
    },
  });
  const msg = makeMsg({ sanitizedContent: 'plain', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.ok(!agentBody.includes('[Chat messages since'), agentBody);
});

test('斜杠命令：直通 userContent，去除一切装饰', () => {
  const ctx = makeCtx({
    sanitizedContent: '/help',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Me',
    state: {
      mention: { wasMentioned: true },
      history: [{ senderId: 'a', senderName: 'A', content: 'noise', timestamp: 0, messageId: 'm1' }],
    },
  });
  const msg = makeMsg({ sanitizedContent: '/help', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(agentBody, '/help', agentBody);
});

// ── 字段语义 · webBody / rawBody / systemPrompt ──────────

group('字段语义');

test('rawBody = msg.content 原文，与 sanitized 区分', () => {
  const ctx = makeCtx({
    sanitizedContent: '清洗后',
    kind: 'c2c',
  });
  const msg = makeMsg({ rawContent: '原始<@xxx> 清洗后', sanitizedContent: '清洗后' });
  const { rawBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(rawBody, '原始<@xxx> 清洗后', rawBody);
});

test('webBody 当前等于 userContent（未对接 formatInboundEnvelope）', () => {
  const ctx = makeCtx({ sanitizedContent: 'hi', kind: 'c2c' });
  const msg = makeMsg({ sanitizedContent: 'hi' });
  const { webBody } = assembleBody(ctx, msg, fakeAccount);
  assert.strictEqual(webBody, 'hi', webBody);
});

test('systemPrompt：account.systemPrompt trim 后取值；空字符串变 undefined', () => {
  const ctx = makeCtx({ sanitizedContent: 'hi' });
  const msg = makeMsg({ sanitizedContent: 'hi' });
  const sp1 = assembleBody(ctx, msg, { ...fakeAccount, systemPrompt: '  你是助手  ' } as never).systemPrompt;
  assert.strictEqual(sp1, '你是助手');
  const sp2 = assembleBody(ctx, msg, { ...fakeAccount, systemPrompt: '   ' } as never).systemPrompt;
  assert.strictEqual(sp2, undefined);
});

// ── 辅助 ─────────────────────────────────────────────────

function makeProcessed(input: {
  imageUrls?: string[];
  transcripts?: VoiceTranscript[];
  voiceText?: string;
  otherInfo?: string;
}): ProcessedAttachments {
  return {
    imageUrls: input.imageUrls ?? [],
    transcripts: input.transcripts ?? [],
    voiceText: input.voiceText ?? '',
    otherInfo: input.otherInfo ?? '',
  };
}

// ── msg_elements 上下文渲染（AT+最近N / 引用 / 转发） ──────

group('buildDynamicCtx · msg_elements 渲染');

function makeElementsMsg(elements: unknown[], kind: 'group' | 'c2c' = 'group') {
  return {
    ...makeMsg({ sanitizedContent: '看看这个', kind, senderId: 'u1', senderName: 'Me' }),
    msgElements: elements,
  } as never;
}

test('普通元素：渲染 消息N/内容/发送者', () => {
  const msg = makeElementsMsg([
    { content: '今天的学习计划已完成', author: { username: '小明' } },
    { content: '很棒！继续保持', author: { username: '小红' } },
  ]);
  const ctx = makeCtx({ sanitizedContent: '看看这个', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg as never, fakeAccount);
  assert.ok(agentBody.includes('[Reference message begins]'), agentBody);
  assert.ok(agentBody.includes('=== 消息 1 ===\n[消息内容] 今天的学习计划已完成\n[发送者] 小明'), agentBody);
  assert.ok(agentBody.includes('=== 消息 2 ===\n[消息内容] 很棒！继续保持\n[发送者] 小红'), agentBody);
});

test('平台预渲染文本：直接透传不二次包裹', () => {
  const prerendered = '=== 消息 1 ===\n[消息内容] 今天的学习计划已完成\n\n=== 消息 2 ===\n[消息内容] 很棒！继续保持';
  const msg = makeElementsMsg([{ content: prerendered, author: { username: '小明' } }]);
  const ctx = makeCtx({ sanitizedContent: '看看这个', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg as never, fakeAccount);
  // 只应有一层 "=== 消息 1 ==="，且原文完整保留
  assert.equal(agentBody.split('=== 消息 1 ===').length - 1, 1, `agentBody=\n${agentBody}`);
  assert.ok(agentBody.includes(prerendered), agentBody);
  assert.ok(!agentBody.includes('[消息内容] === 消息 1 ==='), '不得把预渲染文本再包一层 [消息内容]');
});

test('quote 与 msg_elements 上下文并列：quote 消费第 0 个元素时跳过该元素、渲染其余', () => {
  const msg = makeElementsMsg([
    { content: '被引用的那条消息', author: { username: '小明' } },
    { content: '最近消息记录里的另一条', author: { username: '小红' } },
  ]);
  const ctx = makeCtx({
    sanitizedContent: '关于这个',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Me',
    state: {
      quote: { refKey: 'REF_1', source: 'msg_elements', rawContent: '被引用的那条消息', text: '被引用的那条消息' },
    },
  });
  const { agentBody } = assembleBody(ctx, msg as never, fakeAccount);
  // 引用块渲染（quotePart）
  assert.ok(agentBody.includes('[Quoted message begins]'), agentBody);
  assert.ok(agentBody.includes('被引用的那条消息'), agentBody);
  // 其余元素仍渲染为上下文
  assert.ok(agentBody.includes('[Reference message begins]'), 'quote 存在时其余 msg_elements 上下文不应被吞掉');
  assert.ok(agentBody.includes('最近消息记录里的另一条'), agentBody);
  // 被引用元素不再重复出现在 Reference 块中
  const refBlock = agentBody.split('[Reference message begins]')[1]?.split('[Reference message ends]')[0] ?? '';
  assert.ok(!refBlock.includes('被引用的那条消息'), 'quote 消费的元素不应在 Reference 块重复渲染');
});

test('quote 来自 store（bot 出站）：msg_elements 全量渲染不互斥', () => {
  const msg = makeElementsMsg([
    { content: '上下文消息', author: { username: '小明' } },
  ]);
  const ctx = makeCtx({
    sanitizedContent: '接着说',
    kind: 'group',
    senderId: 'u1',
    senderName: 'Me',
    state: {
      quote: { refKey: 'REF_BOT', source: 'store', text: 'bot 之前说的话' },
    },
  });
  const { agentBody } = assembleBody(ctx, msg as never, fakeAccount);
  assert.ok(agentBody.includes('[Quoted message begins]'), agentBody);
  assert.ok(agentBody.includes('bot 之前说的话'), agentBody);
  assert.ok(agentBody.includes('上下文消息'), 'store 来源的 quote 不应吞掉 msg_elements 上下文');
});

test('元素级 attachments：渲染为 [附件] 行', () => {
  const msg = makeElementsMsg([
    {
      content: '',
      author: { username: '小明' },
      attachments: [{ url: 'https://example.com/a.jpg', content_type: 'image/jpeg' }],
    },
  ]);
  const ctx = makeCtx({ sanitizedContent: '看看图', kind: 'group', senderId: 'u1', senderName: 'Me' });
  const { agentBody } = assembleBody(ctx, msg as never, fakeAccount);
  assert.ok(agentBody.includes('[附件] image/jpeg: https://example.com/a.jpg'), agentBody);
  assert.ok(agentBody.includes('[消息内容] （无文本）'), agentBody);
});

// ── 总结 ─────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`);
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) {
  console.error(`\nFailed tests:`);
  for (const t of failedTests) console.error(`  - ${t}`);
  process.exit(1);
}
console.log('All tests passed.');
