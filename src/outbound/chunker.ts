/**
 * QQBot Markdown 文本分块
 *
 * 优先使用框架 runtime 提供的 chunkMarkdownText（高版本）；
 * 不可用时回退到本地 GFM 表格感知 chunker —— 保证不在表格内部切分。
 */

import { getAdapters } from '../adapter/resolve.js';
import { tryGetQQBotRuntime } from '../runtime.js';
import { resolveFindGraphemeChunkEnd } from './grapheme.js';

// ── GFM 表格检测 ──

/** GFM 表格数据行: | col1 | col2 | */
const GFM_TABLE_DATA_RE = /^\|.+\|.*\|/;
/** GFM 表格分隔行: |---|:---:|---| (1 个或多于 1 个破折号，支持对齐冒号) */
const GFM_TABLE_SEP_RE = /^\|[\s:-]+\|/;

/**
 * 判断一行是否为 GFM 表格行（数据行或分隔行）。
 * 保障 table-aware chunker 不会在表格内部切分。
 */
function isGfmTableLine(line: string): boolean {
  return GFM_TABLE_DATA_RE.test(line) || GFM_TABLE_SEP_RE.test(line);
}

/**
 * 表格感知 fallback chunker：按换行边界切分，整块缓冲表格行。
 */
export function chunkMarkdownPreservingTables(text: string, limit: number): string[] {
  const lines = text.split('\n');
  const chunks: string[] = [];
  let current = '';
  let tableBuffer: string[] = [];

  const flushTable = () => {
    if (tableBuffer.length === 0) return;
    const tableBlock = tableBuffer.join('\n');
    const candidate = current ? `${current}\n${tableBlock}` : tableBlock;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = tableBlock;
    } else {
      current = candidate;
    }
    tableBuffer = [];
  };

  for (const line of lines) {
    if (isGfmTableLine(line)) {
      tableBuffer.push(line);
      continue;
    }

    // 遇到非表格行，先刷新缓冲的表格
    flushTable();

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  // 处理末尾的表格缓冲
  flushTable();
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

/** 代码围栏行（``` 或 ~~~） */
const FENCE_RE = /^\s*(```+|~~~+)/;

/** Markdown 表格分隔行（如 `| --- | :--- |`） */
function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|') || !t.includes('-')) return false;
  return /^\|?[\s:|\-]+\|?$/.test(t);
}

/**
 * 探测被切块的结构上下文
 *
 * 超限块被切成多段后，续段会丢失结构语义：
 * - 代码围栏：没有围栏标记 → 代码块降级成普通文本
 * - 表格：没有表头 + 分隔行 → 续段渲染成散落的行
 *
 * 故为续段补回围栏包裹 / 表头。
 *
 * `minSafeCut` 额外约束**首刀**位置：表格的「表头 + 分隔行」与「第一条数据行」
 * 必须留在同一段（否则续段只剩一个空表头，渲染成孤儿表头），
 * 故首刀不能落在表头区与首行数据行之间。
 */
function detectSplitContext(chunk: string): {
  prefix: string;
  suffix: string;
  minSafeCut: number;
} {
  const lines = chunk.split('\n');

  // ── 代码围栏 ──
  let openMarker: string | null = null;
  let openLang = '';
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (!m) continue;
    if (openMarker === null) {
      openMarker = m[1];
      openLang = line.slice(m[1].length).trim();
    } else if (m[1][0] === openMarker[0] && m[1].length >= openMarker.length) {
      openMarker = null;
      openLang = '';
    }
  }
  if (openMarker) {
    return { prefix: `${openMarker}${openLang}\n`, suffix: `\n${openMarker}`, minSafeCut: 0 };
  }

  // ── 表格表头 ──
  // 定位表格区：某行含 '|' 且下一行是分隔行
  let tableStart = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && isTableSeparatorLine(lines[i + 1])) {
      tableStart = i;
      break;
    }
  }
  if (tableStart >= 0) {
    // 表头两行（表头 + 分隔行）之后的偏移
    let headerEnd = 0;
    for (let i = 0; i <= tableStart + 1; i++) headerEnd += lines[i].length + 1;
    // 第一条数据行结束后的偏移 = 首刀下限
    let minSafeCut = headerEnd;
    if (tableStart + 2 < lines.length) {
      minSafeCut = headerEnd + lines[tableStart + 2].length + 1;
    }
    return {
      prefix: `${lines[tableStart]}\n${lines[tableStart + 1]}\n`,
      suffix: '',
      minSafeCut,
    };
  }

  return { prefix: '', suffix: '', minSafeCut: 0 };
}

/**
 * 切分超限块（字形簇安全 + 结构保持）
 *
 * 框架 chunker 按「换行 / 空白」断点切块：中文长句没有空白时会**在硬上限处
 * 直接截断**，切点正好落在 emoji 中间就把字形切碎；本地 GFM fallback 则是
 * 整块不切，超限消息被平台直接拒收（消息丢失）。
 *
 * 这里对「仍然超限」的块做二次切分：优先换行断点 → 空格断点 → 字形簇边界，
 * 保证每块 ≤ limit 且不切碎 emoji / ZWJ 序列 / 组合符号。
 *
 * 续段会补回结构上下文（代码围栏包裹 / 表格表头），避免切完结构塌掉；
 * 上下文开销计入切分上限（否则补完反而超限）。
 */
export function splitOversizedChunk(chunk: string, limit: number): string[] {
  if (limit <= 0 || chunk.length <= limit) return [chunk];

  const findEnd = resolveFindGraphemeChunkEnd();
  const context = detectSplitContext(chunk);
  // 续段要补回上下文（围栏包裹 / 表头），这部分也占长度 → 切分时先扣掉，
  // 否则补完之后续段会超出上限
  const overhead = context.prefix.length + context.suffix.length;
  const effectiveLimit = Math.max(1, limit - overhead);

  const out: string[] = [];
  let rest = chunk;

  while (rest.length > effectiveLimit) {
    // 首段不需要补上下文 → 用满额预算；续段要补上下文 → 扣掉开销
    const budget = out.length === 0 ? limit : effectiveLimit;
    if (rest.length <= budget) break;

    const window = rest.slice(0, budget + 1);
    // 优先换行断点，其次空格断点，都没有则用硬上限
    let preferred = window.lastIndexOf('\n');
    if (preferred <= 0) preferred = window.lastIndexOf(' ');
    if (preferred <= 0) preferred = budget;

    // 首刀不能落在「表头区」与「第一条数据行」之间（否则首段只剩孤儿表头）
    if (out.length === 0 && context.minSafeCut > 0 && preferred < context.minSafeCut) {
      preferred = context.minSafeCut;
    }

    const end = findEnd(rest, 0, budget, preferred);
    // 无法切分（极端输入）→ 原样保留，不制造空块 / 死循环
    if (end <= 0) break;

    const piece = rest.slice(0, end);
    rest = rest.slice(end);
    if (out.length === 0) {
      out.push(piece);
    } else {
      // 续段：补回结构上下文。prefix 末尾已带换行，piece 的前导换行要去掉——
      // GFM 里表头与首行数据之间出现空行会让表格**断成两截**（表头独立成表）
      out.push(context.prefix + piece.replace(/^\n+/, '') + context.suffix);
    }
  }

  if (rest) {
    if (out.length === 0) {
      out.push(rest);
    } else {
      out.push(context.prefix + rest.replace(/^\n+/, '') + context.suffix);
    }
  }
  return out.length > 0 ? out : [chunk];
}

/**
 * 保证每个块都不超限
 */
export function enforceChunkLimit(chunks: string[], limit: number): string[] {
  if (limit <= 0) return chunks;
  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= limit) {
      out.push(chunk);
      continue;
    }
    out.push(...splitOversizedChunk(chunk, limit));
  }
  return out;
}

/**
 * chunker 入口（框架 ChannelOutboundAdapter.chunker 契约）：
 * runtime adapter 的 chunkMarkdownText 优先，低版本降级到本地实现。
 *
 * 两条路径都过一遍 `enforceChunkLimit`——超限块（长中文句 / 超长表格行 /
 * 落在 emoji 边界的硬截断）在这里按字形簇安全切开。
 */
export function chunkQQBotMarkdown(text: string, limit: number): string[] {
  const rt = tryGetQQBotRuntime();
  const adapterChunker = rt ? getAdapters(rt).chunkMarkdownText : null;
  const chunks = adapterChunker
    ? adapterChunker(text, limit)
    : chunkMarkdownPreservingTables(text, limit);
  return enforceChunkLimit(chunks, limit);
}
