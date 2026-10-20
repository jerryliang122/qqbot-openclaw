/**
 * 回归测试：结构上下文（围栏 / 表头）开销封顶
 *
 * 背景：分支评审发现——`detectSplitContext` 把围栏行 marker 之后的**整行**
 * 当成 info string 塞进续段前缀，而切分预算又用 `Math.max(1, limit - overhead)`
 * 把负预算钳成 1，于是「上下文开销 ≥ limit」时：
 *   - 每个续段 = 超长前缀 + 1 字符 + 后缀 → **全部超限**（平台拒收）
 *   - 一条超限消息被炸成上千条垃圾消息
 *
 * 框架自己的 `resolveFenceReopenLine` 是范本：完整开栏行放得下就用 →
 * 否则降级为裸 marker → 再放不下就放弃围栏上下文。
 *
 * 覆盖：
 *  1. 评审复现输入（超长单行围栏）不再爆炸、且不超限
 *  2. 围栏 info string 只取首个 token（语言标识）
 *  3. 首刀不落在围栏开栏行内部（不产生孤零零的 ```js 块）
 *  4. 超宽表格（表头 + 分隔行 ≥ limit）同样不爆炸
 *  5. 上下文开销超限时整段放弃上下文，退回纯文本切
 *  6. 正常围栏 / 表格的结构保持行为不回退
 */
import { strict as assert } from 'assert';
import {
  chunkQQBotMarkdown,
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

const LIMIT = 5000;

/** 去掉续段补回的上下文，还原「原始内容」拼接 */
function stripContext(chunks: string[], prefix: string, suffix: string): string {
  return chunks
    .map((c, i) => {
      if (i === 0) return c;
      let s = c;
      if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
      if (suffix && s.endsWith(suffix)) s = s.slice(0, s.length - suffix.length);
      return s;
    })
    .join('');
}

// ── 1. 评审复现输入：超长单行围栏 ──

test('超长单行围栏：不再炸成上千条，且每块不超限', () => {
  // LLM 常输出的超长单行行内代码 / 单行 JSON
  const payload = 'x'.repeat(5100);
  const text = '```js {"k":"' + payload + '"}';
  assert.strictEqual(text.length, 5114);

  const chunks = chunkQQBotMarkdown(text, LIMIT);

  // 修复前是 5110 块（其中 5109 块各 5120 字、全部超限）
  assert.ok(chunks.length <= 4, `块数应保持在个位数，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}`);
  }
});

test('超长单行围栏：内容无丢失', () => {
  const payload = 'x'.repeat(5100);
  const text = '```js {"k":"' + payload + '"}';

  const chunks = chunkQQBotMarkdown(text, LIMIT);
  const restored = stripContext(chunks, '```js\n', '\n```').replace(/\n/g, '');

  assert.ok(restored.includes(payload), '原始 payload 必须完整保留');
});

test('超长单行围栏：续段前缀只带语言标识，不带整行 info string', () => {
  const payload = 'x'.repeat(5100);
  const text = '```js {"k":"' + payload + '"}';

  const chunks = chunkQQBotMarkdown(text, LIMIT);
  const continuation = chunks[1];

  assert.ok(
    continuation.startsWith('```js\n'),
    '续段应以 "```js\\n" 开头，实际 ' + JSON.stringify(continuation.slice(0, 20)),
  );
  assert.ok(
    !continuation.includes('{"k"'),
    '续段前缀不得把整行 info string 带进去',
  );
});

// ── 2. 首刀不落在围栏开栏行内部 ──

test('超长单行围栏：首块不是孤零零的开栏行', () => {
  const payload = 'x'.repeat(5100);
  const text = '```js {"k":"' + payload + '"}';

  const chunks = chunkQQBotMarkdown(text, LIMIT);

  // 修复前首块是 "```js"（5 字）——切点落在开栏行内部
  assert.ok(chunks[0].length > 100, `首块不应是孤儿开栏行，实际长度 ${chunks[0].length}`);
  assert.ok(chunks[0].startsWith('```js'), '首块应保留围栏开头');
});

// ── 3. 巨大 info string（内容另起一行） ──

test('巨大 info string：info string 超长时降级为裸 marker', () => {
  const text = '```' + 'i'.repeat(6000) + '\n' + 'body\n'.repeat(10);

  const chunks = chunkQQBotMarkdown(text, LIMIT);

  assert.ok(chunks.length <= 4, `块数应保持在个位数，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}`);
  }
  // 首个 token 超长 → 视为没有语言标识 → 续段用裸 marker
  assert.ok(chunks[1].startsWith('```\n'), '续段应降级为裸 marker');
});

// ── 4. 超宽表格 ──

test('超宽表格：表头 + 分隔行 ≥ limit 时不爆炸', () => {
  const header = '| ' + 'h'.repeat(2600) + ' |';
  const sep = '| ' + '-'.repeat(2600) + ' |';
  const text = [header, sep, ...Array.from({ length: 8 }, (_, i) => `| row ${i} |`)].join('\n');
  assert.ok(header.length + sep.length + 2 >= LIMIT, '前提：表头 + 分隔行已超限');

  const chunks = chunkQQBotMarkdown(text, LIMIT);

  assert.ok(chunks.length <= 4, `块数应保持在个位数，实际 ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}`);
  }
});

test('超宽表格：上下文放不下时整段放弃表头，不重复前缀', () => {
  const header = '| ' + 'h'.repeat(2600) + ' |';
  const sep = '| ' + '-'.repeat(2600) + ' |';
  const text = [header, sep, ...Array.from({ length: 8 }, (_, i) => `| row ${i} |`)].join('\n');

  const chunks = chunkQQBotMarkdown(text, LIMIT);

  // 续段不应把 2600 字的表头重复一遍（那会让每条消息大半都是表头）
  for (const c of chunks.slice(1)) {
    assert.ok(
      !c.startsWith('| hhhh'),
      '上下文开销过大时应放弃表头，而不是重复它',
    );
  }
});

// ── 5. 上下文预算规则（正常规模不得误伤） ──

test('正常表格：上下文开销在预算内时仍然保留表头', () => {
  const header = '| 列一 | 列二 |\n| --- | --- |\n';
  const chunk = header + '| a | b |\n'.repeat(30);

  const chunks = splitOversizedChunk(chunk, 100);

  assert.ok(chunks.length >= 2);
  for (const c of chunks.slice(1)) {
    assert.ok(c.startsWith(header), '续段应补回表头');
    assert.ok(c.length <= 100, `续段长度 ${c.length} 超过上限 100`);
  }
});

test('正常围栏：续段仍然补回围栏包裹并保留语言标识', () => {
  const body = 'const x = 1;\n'.repeat(30);
  const chunk = '```ts\n' + body;

  const chunks = splitOversizedChunk(chunk, 100);

  assert.ok(chunks.length >= 2);
  for (const c of chunks.slice(1)) {
    assert.ok(c.startsWith('```ts\n'), '续段应补回围栏开头');
    assert.ok(c.trimEnd().endsWith('```'), '续段应补回围栏结尾');
    assert.ok(c.length <= 100, `续段长度 ${c.length} 超过上限 100`);
  }
});

test('上下文预算规则：开销过半时放弃上下文', () => {
  // limit=100，表头 + 分隔行合计 60（> limit/2）→ 上下文应被放弃
  const header = '| ' + 'h'.repeat(28) + ' |\n| ' + '-'.repeat(28) + ' |\n';
  const chunk = header + '| row |\n'.repeat(20);
  assert.ok(header.length > 50, '前提：上下文开销已过半');

  const chunks = splitOversizedChunk(chunk, 100);

  for (const c of chunks.slice(1)) {
    assert.ok(!c.startsWith('| hhhh'), '开销过半时应放弃表头');
    assert.ok(c.length <= 100, `块长度 ${c.length} 超过上限 100`);
  }
});

// ── 6. 随机输入的不变量（伪随机 · 固定种子 · 可复现） ──

/** 线性同余伪随机（固定种子 → 结果可复现） */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** needle 是否为 haystack 的子序列 */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

test('随机输入不变量：每块不超限、内容不丢、块数不爆炸', () => {
  const rand = lcg(20261020);
  const pieces = [
    'x',
    '中文',
    '😀',
    '👨‍👩‍👧',
    '```ts\n',
    '```js {"k":"',
    '```',
    '| a | b |\n',
    '|---|---|\n',
    '\n',
    ' ',
  ];

  for (let iter = 0; iter < 300; iter++) {
    const n = 1 + Math.floor(rand() * 12);
    let text = '';
    for (let i = 0; i < n; i++) {
      const p = pieces[Math.floor(rand() * pieces.length)];
      text += p.repeat(1 + Math.floor(rand() * 400));
    }

    const chunks = chunkQQBotMarkdown(text, LIMIT);

    // ① 每块都不超限（平台硬上限，超限即拒收）
    for (const c of chunks) {
      assert.ok(c.length <= LIMIT, `块长度 ${c.length} 超过上限 ${LIMIT}（iter=${iter}）`);
    }

    // ② 块数不爆炸：续段最多携带 limit/2 的上下文 → 块数不超过纯文本硬切的 3 倍
    const pureTextChunks = Math.ceil(text.length / LIMIT) + 1;
    assert.ok(
      chunks.length <= pureTextChunks * 3 + 4,
      `块数 ${chunks.length} 异常膨胀（纯文本硬切约 ${pureTextChunks} 块，iter=${iter}）`,
    );

    // ③ 内容不丢：原文（去掉换行）应是拼接结果的子序列
    const joined = chunks.join('').replace(/\n/g, '');
    assert.ok(
      isSubsequence(text.replace(/\n/g, ''), joined),
      `内容丢失（iter=${iter}，原文 ${text.length} 字，拼接 ${joined.length} 字）`,
    );
  }
});
