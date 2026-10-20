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
  // 👨‍👩‍👧 = 8 个 UTF-16 码元（👨2 + ZWJ1 + 👩2 + ZWJ1 + 👧2）
  const family = '👨‍👩‍👧';
  const text = `前缀${family}后缀`;
  const familyStart = text.indexOf(family);
  const familyEnd = familyStart + family.length;

  const end = localFindGraphemeChunkEnd(text, 0, text.length - 2, text.length - 2);
  // 切点必须落在 family 的**边界**上（起点或终点），不能落在 family 内部
  assert.ok(
    end === familyStart || end === familyEnd,
    `切点 ${end} 必须等于 family 起点 ${familyStart} 或终点 ${familyEnd}，不能落在 family 内部`,
  );
  // 无论落在哪一端，都不能切出半个字形簇
  assert.ok(end >= 0 && end <= text.length);
});

test('本地切点：ZWJ 家庭 emoji 不会被切成两半（任意预算）', () => {
  const family = '👨‍👩‍👧';
  const text = `前缀${family}后缀`;
  const familyStart = text.indexOf(family);
  const familyEnd = familyStart + family.length;

  for (let maxEnd = 1; maxEnd <= text.length; maxEnd++) {
    const end = localFindGraphemeChunkEnd(text, 0, maxEnd);
    // 切点要么在 family 之前，要么在 family 之后（末尾），不能插进 family 内部
    const inside = end > familyStart && end < familyEnd;
    assert.ok(!inside, `maxEnd=${maxEnd} 切点 ${end} 落在 family 内部 [${familyStart},${familyEnd})`);
  }
});

test('本地切点：切点必须落在完整字形簇边界（不产生半个 emoji）', () => {
  // 用 Intl.Segmenter 作为「真值」：当预算内放得下一个完整字形簇时，
  // 切点必须落在簇边界。
  // 注意官方契约允许例外：预算内**放不下**完整字形簇时，允许「代理对安全的
  // 部分切」（前导代理对可以比 maxEnd 多一个码元）——见下方差分测试。
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const samples = ['😀😀😀', 'a😀b😀c', '👨‍👩‍👧👨‍👩‍👧', '中😀文😀', 'e\u0301😀'];

  for (const text of samples) {
    const boundaries = new Set<number>([0, text.length]);
    let firstClusterLen = text.length;
    for (const seg of segmenter.segment(text)) {
      boundaries.add(seg.index);
      if (seg.index === 0) firstClusterLen = seg.segment.length;
    }

    for (let maxEnd = 1; maxEnd <= text.length; maxEnd++) {
      const end = localFindGraphemeChunkEnd(text, 0, maxEnd, maxEnd);
      // 恒不切碎代理对（UTF-16 不变量）
      if (end > 0 && end < text.length) {
        const before = text.charCodeAt(end - 1);
        const after = text.charCodeAt(end);
        assert.ok(
          !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff),
          `text=${JSON.stringify(text)} maxEnd=${maxEnd} 切在代理对中间`,
        );
      }
      // 预算内放得下完整首簇时，切点必须落在簇边界
      if (maxEnd >= firstClusterLen) {
        assert.ok(
          boundaries.has(end),
          `text=${JSON.stringify(text)} maxEnd=${maxEnd} end=${end} 不是字形簇边界`,
        );
      }
    }
  }
});

test('本地切点：与 openclaw 10.5 官方实现逐例一致（差分测试）', () => {
  // 期望值由 openclaw@2026.10.5 的 dist/grapheme-*.mjs 实跑产出。
  // 本地实现必须与官方**逐例相同**——否则 9.1 用户与 10.5 用户的切分结果会分叉。
  const cases: Array<[string, number, number, number]> = [
    ['😀😀😀', 0, 1, 2],
    ['😀😀😀', 0, 2, 2],
    ['😀😀😀', 0, 3, 2],
    ['😀😀😀', 0, 6, 6],
    ['👨‍👩‍👧👨‍👩‍👧', 0, 2, 2],
    ['👨‍👩‍👧👨‍👩‍👧', 0, 5, 5],
    ['👨‍👩‍👧👨‍👩‍👧', 0, 11, 8],
    ['👨‍👩‍👧👨‍👩‍👧', 0, 12, 8],
    ['a😀b', 0, 2, 1],
    ['a😀b', 0, 3, 3],
    ['中文😀中文', 0, 3, 2],
    ['中文😀中文', 0, 4, 4],
    ['abcdefghij', 0, 5, 5],
    ['abcdefghij', 0, 3, 3],
    ['e\u0301😀', 0, 2, 2],
    ['e\u0301😀', 0, 3, 2],
    ['😀x', 0, 1, 2],
    ['x😀', 0, 2, 1],
    ['\r\nabc', 0, 1, 1],
    ['\r\nabc', 0, 2, 2],
  ];

  for (const [text, start, maxEnd, expected] of cases) {
    assert.strictEqual(
      localFindGraphemeChunkEnd(text, start, maxEnd),
      expected,
      `text=${JSON.stringify(text)} start=${start} maxEnd=${maxEnd}`,
    );
  }
});

test('本地切点：始终能推进（不零进展卡死分块）', () => {
  // 官方注释：前导代理对可以比 maxEnd 多一个码元——切点必须 > start，
  // 否则分块循环会 break、整块原样超限被平台拒收。
  const samples = ['😀x', '😀', '👨‍👩‍👧abc', 'e\u0301abc'];
  for (const text of samples) {
    for (let maxEnd = 1; maxEnd <= text.length; maxEnd++) {
      const end = localFindGraphemeChunkEnd(text, 0, maxEnd);
      assert.ok(end > 0, `text=${JSON.stringify(text)} maxEnd=${maxEnd} 零进展`);
    }
  }
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

// ── 5. 结构保持（续段补回围栏 / 表头） ──

test('超限切分：代码围栏的续段补回围栏包裹', () => {
  const body = 'const x = 1;\n'.repeat(30);
  const chunk = '```ts\n' + body;
  const chunks = splitOversizedChunk(chunk, LIMIT);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].startsWith('```ts'), '首段应保留围栏开头');
  for (const c of chunks.slice(1)) {
    assert.ok(c.startsWith('```ts\n'), '续段应补回围栏开头');
    assert.ok(c.trimEnd().endsWith('```'), '续段应补回围栏结尾');
    assert.ok(c.length <= LIMIT, `续段长度 ${c.length} 超过上限 ${LIMIT}`);
  }
});

test('超限切分：表格的续段补回表头', () => {
  const header = '| 列一 | 列二 |\n| --- | --- |\n';
  const chunk = header + '| a | b |\n'.repeat(30);
  const chunks = splitOversizedChunk(chunk, LIMIT);
  assert.ok(chunks.length >= 2);
  for (const c of chunks.slice(1)) {
    assert.ok(c.startsWith('| 列一 | 列二 |\n| --- | --- |\n'), '续段应补回表头');
    assert.ok(c.length <= LIMIT, `续段长度 ${c.length} 超过上限 ${LIMIT}`);
  }
});

test('超限切分：表格不被切在行中间（表头与数据行同段、无空行）', () => {
  const row = '| a | b |';
  const table = ['| h1 | h2 |', '|---|---|', row, row, row, row].join('\n');
  const text = `${'x'.repeat(40)}\n${table}\n${'y'.repeat(40)}`;
  const chunks = chunkQQBotMarkdown(text, 50);

  for (const chunk of chunks) {
    if (!chunk.includes('|---|---|')) continue;
    // 含表头的段必须同时含数据行（不能只剩孤儿表头）
    assert.ok(chunk.includes(row), '表格数据行必须与表头在同一个 chunk');
    // 表头与首行数据行之间不能有空行（GFM 里空行会把表格断成两截）
    assert.ok(
      !chunk.includes('|---|---|\n\n'),
      '表头与首行数据行之间不能有空行',
    );
    // 不能切在行中间
    assert.ok(chunk.includes('| a | b |') || !chunk.includes('| a | '), '不能切在表格行中间');
  }
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 50, `块长度 ${chunk.length} 超过上限`);
  }
});

test('超限切分：无结构的纯文本不添加任何前缀', () => {
  const long = '字'.repeat(250);
  const chunks = splitOversizedChunk(long, LIMIT);
  assert.strictEqual(chunks.join(''), long);
});
