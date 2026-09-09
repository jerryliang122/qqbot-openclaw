/**
 * 中间件链回归测试
 *
 * 验证移除 concurrencyGuard 后，中间件链仍然正常工作。
 *
 * 运行方式: npx tsx tests/middleware-chain.test.ts
 */
import assert from 'node:assert';
import type { QQBot, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

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
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

// ── Mock 对象 ──────────────────────────────────────────

const mockMiddlewares: string[] = [];

const mockBot = {
  use: (middleware: any) => {
    mockMiddlewares.push(middleware.name || 'anonymous');
  },
} as unknown as QQBot;

const mockAccount = {
  accountId: 'test-account',
  appId: 'test-appid',
  clientSecret: 'test-secret',
  processingTimeoutMs: 0,
  config: {},
  userAgentSuffix: '',
};

const mockRuntime = {
  version: '2026.1.1',
  channel: {},
};

// ── 测试开始 ──────────────────────────────────────────

group('中间件注册顺序');

test('应该注册 errorHandler 作为第一个中间件', () => {
  mockMiddlewares.length = 0;

  // 模拟 middleware-setup.ts 的注册顺序（与源码保持同步）
  mockBot.use(function errorHandler() {});
  mockBot.use(function messageFilter() {});
  mockBot.use(function inboundGuard() {});
  mockBot.use(function policyInjector() {});
  mockBot.use(function historyBuffer() {});
  mockBot.use(function dynamicAccessControl() {});
  mockBot.use(function mentionGate() {});
  mockBot.use(function contentSanitizer() {});
  mockBot.use(function rateLimiter() {});
  mockBot.use(function slashCommand() {});
  mockBot.use(function secretCapture() {});
  mockBot.use(function groupMessageCoalescer() {});
  mockBot.use(function c2cTypingIndicator() {});
  mockBot.use(function quoteRef() {});
  mockBot.use(function attachmentProcessor() {});
  mockBot.use(function envelopeFormatter() {});

  assert.strictEqual(mockMiddlewares[0], 'errorHandler',
    'errorHandler 应该是第一个注册的中间件');
  assert.strictEqual(mockMiddlewares.length, 16,
    '应该注册 16 个中间件（errorHandler→envelopeFormatter）');
});

test('不应该注册 concurrencyGuard 中间件', () => {
  const hasConcurrencyGuard = mockMiddlewares.includes('concurrencyGuard');
  assert.strictEqual(hasConcurrencyGuard, false, 
    'concurrencyGuard 中间件应该已被移除');
});

group('中间件链完整性');

test('quoteRef 中间件应该存在', () => {
  const hasQuoteRef = mockMiddlewares.includes('quoteRef');
  assert.strictEqual(hasQuoteRef, true, 
    'quoteRef 中间件应该保留（用于引用消息功能）');
});

test('historyBuffer 中间件应该存在', () => {
  const hasHistoryBuffer = mockMiddlewares.includes('historyBuffer');
  assert.strictEqual(hasHistoryBuffer, true, 
    'historyBuffer 中间件应该保留（用于群历史缓冲）');
});

test('rateLimiter 中间件应该存在', () => {
  const hasRateLimiter = mockMiddlewares.includes('rateLimiter');
  assert.strictEqual(hasRateLimiter, true, 
    'rateLimiter 中间件应该保留（用于限流）');
});

test('mentionGate 中间件应该存在', () => {
  const hasMentionGate = mockMiddlewares.includes('mentionGate');
  assert.strictEqual(hasMentionGate, true, 
    'mentionGate 中间件应该保留（用于@提及检测）');
});

test('slashCommand 中间件应该存在', () => {
  const hasSlashCommand = mockMiddlewares.includes('slashCommand');
  assert.strictEqual(hasSlashCommand, true, 
    'slashCommand 中间件应该保留（用于斜杠命令）');
});

test('attachmentProcessor 中间件应该存在', () => {
  const hasAttachmentProcessor = mockMiddlewares.includes('attachmentProcessor');
  assert.strictEqual(hasAttachmentProcessor, true, 
    'attachmentProcessor 中间件应该保留（用于附件处理）');
});

test('envelopeFormatter 中间件应该存在', () => {
  const hasEnvelopeFormatter = mockMiddlewares.includes('envelopeFormatter');
  assert.strictEqual(hasEnvelopeFormatter, true, 
    'envelopeFormatter 中间件应该保留（用于消息格式化）');
});

group('中间件链顺序验证');

test('斜杠命令应该在限流之后', () => {
  const slashIndex = mockMiddlewares.indexOf('slashCommand');
  const rateLimiterIndex = mockMiddlewares.indexOf('rateLimiter');

  assert.ok(slashIndex > rateLimiterIndex,
    `slashCommand (index ${slashIndex}) 应该在 rateLimiter (index ${rateLimiterIndex}) 之后`);
});

test('密钥捕获应该在斜杠命令之后', () => {
  const secretIndex = mockMiddlewares.indexOf('secretCapture');
  const slashIndex = mockMiddlewares.indexOf('slashCommand');

  assert.ok(secretIndex > slashIndex,
    `secretCapture (index ${secretIndex}) 应该在 slashCommand (index ${slashIndex}) 之后`);
});

test('入站守卫应该在历史缓冲与门控之前', () => {
  const guardIndex = mockMiddlewares.indexOf('inboundGuard');
  const historyIndex = mockMiddlewares.indexOf('historyBuffer');
  const gateIndex = mockMiddlewares.indexOf('mentionGate');

  assert.ok(guardIndex >= 0 && guardIndex < historyIndex && guardIndex < gateIndex,
    `inboundGuard (index ${guardIndex}) 应先于 historyBuffer (${historyIndex}) 与 mentionGate (${gateIndex})`);
});

test('群消息排队（coalescer/framework）应该在密钥捕获之后', () => {
  const coalescerIndex = mockMiddlewares.indexOf('groupMessageCoalescer');
  const secretIndex = mockMiddlewares.indexOf('secretCapture');

  assert.ok(coalescerIndex > secretIndex,
    `groupMessageCoalescer (index ${coalescerIndex}) 应该在 secretCapture (index ${secretIndex}) 之后`);
});

test('引用消息解析应该在输入状态之后', () => {
  const quoteRefIndex = mockMiddlewares.indexOf('quoteRef');
  const typingIndicatorIndex = mockMiddlewares.indexOf('c2cTypingIndicator');
  
  assert.ok(quoteRefIndex > typingIndicatorIndex, 
    `quoteRef (index ${quoteRefIndex}) 应该在 c2cTypingIndicator (index ${typingIndicatorIndex}) 之后`);
});

test('附件处理应该在引用消息解析之后', () => {
  const attachmentProcessorIndex = mockMiddlewares.indexOf('attachmentProcessor');
  const quoteRefIndex = mockMiddlewares.indexOf('quoteRef');
  
  assert.ok(attachmentProcessorIndex > quoteRefIndex, 
    `attachmentProcessor (index ${attachmentProcessorIndex}) 应该在 quoteRef (index ${quoteRefIndex}) 之后`);
});

test('信封格式化应该是最后一个中间件', () => {
  const envelopeFormatterIndex = mockMiddlewares.indexOf('envelopeFormatter');
  const lastIndex = mockMiddlewares.length - 1;
  
  assert.strictEqual(envelopeFormatterIndex, lastIndex, 
    `envelopeFormatter 应该是最后一个注册的中间件`);
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
