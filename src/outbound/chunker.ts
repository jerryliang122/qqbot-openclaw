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

/**
 * 切分超限块（字形簇安全）
 *
 * 框架 chunker 按「换行 / 空白」断点切块：中文长句没有空白时会**在硬上限处
 * 直接截断**，切点正好落在 emoji 中间就把字形切碎；本地 GFM fallback 则是
 * 整块不切，超限消息被平台直接拒收（消息丢失）。
 *
 * 这里对「仍然超限」的块做二次切分：优先换行断点 → 空格断点 → 字形簇边界，
 * 保证每块 ≤ limit 且不切碎 emoji / ZWJ 序列 / 组合符号。
 */
export function splitOversizedChunk(chunk: string, limit: number): string[] {
  if (limit <= 0 || chunk.length <= limit) return [chunk];

  const findEnd = resolveFindGraphemeChunkEnd();
  const out: string[] = [];
  let rest = chunk;

  while (rest.length > limit) {
    const window = rest.slice(0, limit + 1);
    // 优先换行断点，其次空格断点，都没有则用硬上限
    let preferred = window.lastIndexOf('\n');
    if (preferred <= 0) preferred = window.lastIndexOf(' ');
    if (preferred <= 0) preferred = limit;

    const end = findEnd(rest, 0, limit, preferred);
    // 无法切分（极端输入）→ 原样保留，不制造空块 / 死循环
    if (end <= 0) break;

    out.push(rest.slice(0, end));
    rest = rest.slice(end);
  }

  if (rest) out.push(rest);
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
