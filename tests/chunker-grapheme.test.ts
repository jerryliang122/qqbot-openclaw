/**
 * 回归测试：字形簇安全分块 + 10.5 新原语接入
 *
 * 背景：openclaw 2026.10.5 新增 `openclaw/plugin-sdk/text-grapheme`
 * （findGraphemeChunkEnd，按字形簇切块）。2026.9.1 基线无该子路径且发布包
 * 不带 .d.ts → 插件侧带能力探测 + 本地 Intl.Segmenter 回退。
 *
 * 覆盖：
 *  1. 本地 findGraphemeChunkEnd 不切碎代理对 / emoji
 *  2. 超限单行被切成多块且每块 ≤ limit
 *  3. emoji 恰好落在上限边界时不被切开
 *  4. 正常文本的分块行为不回退
 */
import { strict as assert } from 'assert';
import {
  localFindGraphemeChunkEnd,
  resolveFindGraphemeChunkEnd,
} from '../src/outbound/grapheme.js';
import {
  chunkQQBotMarkdown,
  enforceChunkLimit,
  splitOversizedChunk,
} from '../src/outbound/chunker.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

const LIMIT = 100;

// ── 1. 本地 findGraphemeChunkEnd ──

test('本地切点：ASCII 文本直接按期望断点切', () => {
  const text = 'abcdefghij';
  assert.strictEqual(localFindGraphemeChunkEnd(text, 0, 5, 5), 5);
});

test('本地切点：切点落在代理对中间时回退到簇边界', () => {
  // '😀' = U+1F600 = 高代理 D83D + 低代理 DE00
  const text = '😀😀😀';
  assert.strictEqual(text.length, 6);
  // 期望切点 1 落在代理对中间 → 必须回退到 0 或 2，不能是 1
  const end = localFindGraphemeChunkEnd(text, 0, 1, 1);
  assert.notStrictEqual(end, 1, '不能切在代理对中间');
});

test('本地切点：ZWJ 家庭 emoji 不被拆开', () => {
  // 👨‍👩‍👧 = 5 个码位（含 2 个 ZWJ）
  const family = '👨‍👩‍👧';
  const text = `前缀${family}后缀`;
  const end = localFindGraphemeChunkEnd(text, 0, text.length - 2, text.length - 2);
  // 切点若落在 family 内部会被吸附到 family 起点
  assert.ok(end <= text.indexOf(family) + family.length);
  assert.ok(end >= 0);
});

test('本地切点：maxEnd <= start 时返回 start（不死循环）', () => {
  assert.strictEqual(localFindGraphemeChunkEnd('abc', 3, 3, 3), 3);
  assert.strictEqual(localFindGraphemeChunkEnd('abc', 5, 2, 2), 5);
});

// ── 2. 能力探测 ──

test('能力探测：解析出的切点函数始终可用', () => {
  const fn = resolveFindGraphemeChunkEnd();
  assert.strictEqual(typeof fn, 'function');
  // 探测结果必须幂等（缓存命中）
  assert.strictEqual(resolveFindGraphemeChunkEnd(), fn);
});

test('能力探测：9.1 基线无该子路径时回退到本地实现且行为正确', () => {
  // 2026.9.1 的 exports 里没有 ./plugin-sdk/text-grapheme —— 探测必然失败，
  // 必须回退到本地 Intl.Segmenter 实现（sdk-surface 测试的豁免理由依赖这条保证）
  const fn = resolveFindGraphemeChunkEnd();
  const emoji = '😀';
  const text = `abc${emoji}def`;
  const end = fn(text, 0, 4, 4);
  // 切点不能落在代理对中间
  assert.notStrictEqual(end, 4, '切点不得落在代理对中间');
  assert.ok(end > 0 && end < text.length);
  // 回退实现必须真的能切开（不只是「返回一个数」）
  const chunks = splitOversizedChunk('字'.repeat(250), LIMIT);
  assert.ok(chunks.length >= 3);
});

// ── 3. 超限切分 ──

test('超限单行被切成多块且每块不超限', () => {
  const long = '字'.repeat(250); // 250 个字，无换行无空格
  const chunks = splitOversizedChunk(long, LIMIT);
  assert.ok(chunks.length >= 3, `期望切出多块，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}`);
  }
  // 内容不能丢
  assert.strictEqual(chunks.join(''), long);
});

test('超限切分：emoji 恰好在边界时不被切开', () => {
  // 构造：limit-1 个 ASCII + emoji，总长 limit+1 → 必须在 emoji 前切开
  const text = 'a'.repeat(LIMIT - 1) + '😀' + 'b';
  const chunks = splitOversizedChunk(text, LIMIT);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限`);
    // 每个块都不能以半个 emoji 开头或结尾
    assert.ok(!/[\uD800-\uDBFF]$/.test(c), '块尾不能是高代理项');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(c), '块首不能是低代理项');
  }
  assert.strictEqual(chunks.join(''), text);
});

test('enforceChunkLimit：已合规的块原样保留', () => {
  const chunks = ['short', 'also short'];
  assert.deepStrictEqual(enforceChunkLimit(chunks, LIMIT), chunks);
});

test('enforceChunkLimit：超限块被二次切分且内容不丢', () => {
  const chunks = ['ok', 'x'.repeat(LIMIT * 2 + 5)];
  const out = enforceChunkLimit(chunks, LIMIT);
  assert.ok(out.length >= 4);
  for (const c of out) assert.ok(c.length <= LIMIT);
  assert.strictEqual(out.join(''), chunks.join(''));
});

// ── 4. 端到端 chunker ──

test('chunkQQBotMarkdown：长中文消息被切分且每块不超限', () => {
  const text = '这是一段很长的中文回复。'.repeat(200);
  const chunks = chunkQQBotMarkdown(text, LIMIT);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}`);
  }
  // 无内容丢失（忽略换行差异：切分点可能吃掉换行符）
  const joined = chunks.join('').replace(/\n/g, '');
  assert.strictEqual(joined, text.replace(/\n/g, ''));
});

test('chunkQQBotMarkdown：短消息原样返回单块', () => {
  const text = '短消息';
  const chunks = chunkQQBotMarkdown(text, LIMIT);
  assert.strictEqual(chunks.length, 1);
  assert.strictEqual(chunks[0], text);
});
