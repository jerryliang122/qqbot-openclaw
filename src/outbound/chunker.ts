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

/**
 * 围栏 info string 里语言标识的最大长度
 *
 * CommonMark 的 info string 理论上可以是任意长文本，但把整行当语言标识会让
 * 「重开前缀」膨胀到超限 → 切分预算被吃光 → 续段只剩 1 个字符。
 * 现实中的语言标识都很短（ts / js / python / json …），超长即视为没有语言标识。
 */
const MAX_FENCE_LANG_LENGTH = 32;

/**
 * 保留结构上下文时，正文预算至少要占 limit 的比例
 *
 * 上下文开销吃掉太多预算时，续段会退化成「一大段重复表头 + 几行正文」，
 * 消息条数随预算反向膨胀（极端情况下一条超限消息炸成几千条）。
 * 此时宁可丢掉结构上下文、按纯文本切。
 *
 * 取 0.5 = 上下文开销不得超过正文预算——重复的上下文不该比它承载的内容还长。
 */
const MIN_CONTENT_BUDGET_RATIO = 0.5;

/** Markdown 表格分隔行（如 `| --- | :--- |`） */
function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|') || !t.includes('-')) return false;
  return /^\|?[\s:|\-]+\|?$/.test(t);
}

/** 切分上下文（续段要补回的结构语义） */
interface SplitContext {
  /** 续段前缀（围栏开栏行 / 表格表头） */
  prefix: string;
  /** 续段后缀（围栏收尾行） */
  suffix: string;
  /** 首刀下限：表头 + 首条数据行必须留在同一段 */
  minSafeCut: number;
  /** 围栏开栏行的结束偏移（0 = 本块没有未闭合的围栏） */
  fenceOpenLineEnd: number;
}

/** 无结构上下文 */
const EMPTY_CONTEXT: SplitContext = {
  prefix: '',
  suffix: '',
  minSafeCut: 0,
  fenceOpenLineEnd: 0,
};

/**
 * 上下文开销是否还留得住正文
 *
 * 判据：保留上下文后，正文预算不得小于上下文开销（等价 overhead ≤ limit/2）。
 */
function fitsContentBudget(overhead: number, limit: number): boolean {
  return limit - overhead >= limit * MIN_CONTENT_BUDGET_RATIO;
}

/**
 * 探测未闭合的代码围栏
 *
 * 返回围栏 marker、语言标识，以及开栏行的结束偏移。
 * 语言标识只取 info string 的**首个 token**
 * （CommonMark 里那是语言名，后面的部分是 info string 本身，可以任意长）。
 */
function detectFenceContext(
  lines: string[],
): { marker: string; lang: string; openLineEnd: number } | null {
  let openMarker: string | null = null;
  let openLang = '';
  let openLineEnd = 0;
  let offset = 0;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    offset += line.length + 1;
    if (!m) continue;
    if (openMarker === null) {
      openMarker = m[1];
      openLineEnd = offset;
      // m[0] 含前导空白，用它切才拿得到真正的 info string
      // （用 m[1].length 会把 marker 的头几个字符当成 info string 的一部分）
      const info = line.slice(m[0].length).trim();
      const firstToken = info.split(/\s+/)[0] ?? '';
      openLang = firstToken.length <= MAX_FENCE_LANG_LENGTH ? firstToken : '';
    } else if (m[1][0] === openMarker[0] && m[1].length >= openMarker.length) {
      openMarker = null;
      openLang = '';
    }
  }
  return openMarker ? { marker: openMarker, lang: openLang, openLineEnd } : null;
}

/**
 * 解析代码围栏的重开前缀（逐级降级）
 *
 * 与框架 `resolveFenceReopenLine` 同一套思路：完整开栏行放得下就用 →
 * 否则降级为裸 marker → 再放不下就放弃围栏上下文。
 *
 * 缺了这道封顶，info string 很长时前缀会超过 limit，切分预算被吃光 →
 * 每个续段只剩 1 个字符（消息爆炸 + 全部超限被平台拒收）。
 */
function resolveFenceReopen(
  marker: string,
  lang: string,
  limit: number,
): { prefix: string; suffix: string } | null {
  const suffix = `\n${marker}`;
  const candidates = lang ? [`${marker}${lang}`, marker] : [marker];
  for (const openLine of candidates) {
    const prefix = `${openLine}\n`;
    if (prefix.length + suffix.length <= limit) return { prefix, suffix };
  }
  return null;
}

/** 探测表格表头（某行含 '|' 且下一行是分隔行） */
function detectTableContext(lines: string[]): { header: string; minSafeCut: number } | null {
  let tableStart = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i].includes('|') && isTableSeparatorLine(lines[i + 1])) {
      tableStart = i;
      break;
    }
  }
  if (tableStart < 0) return null;
  // 表头两行（表头 + 分隔行）之后的偏移
  let headerEnd = 0;
  for (let i = 0; i <= tableStart + 1; i++) headerEnd += lines[i].length + 1;
  // 第一条数据行结束后的偏移 = 首刀下限
  let minSafeCut = headerEnd;
  if (tableStart + 2 < lines.length) {
    minSafeCut = headerEnd + lines[tableStart + 2].length + 1;
  }
  return {
    header: `${lines[tableStart]}\n${lines[tableStart + 1]}\n`,
    minSafeCut,
  };
}

/**
 * 探测被切块的结构上下文
 *
 * 超限块被切成多段后，续段会丢失结构语义：
 * - 代码围栏：没有围栏标记 → 代码块降级成普通文本
 * - 表格：没有表头 + 分隔行 → 续段渲染成散落的行
 *
 * 故为续段补回围栏包裹 / 表头。但**上下文开销必须封顶**：
 * 前缀比 limit 还长时，切分预算被吃光 → 续段只剩 1 个字符，
 * 一条超限消息会炸成几千条 1 字符垃圾消息（且每条都超限被平台拒收）。
 * 故：放不下就降级（围栏 → 裸 marker → 放弃），预算不足就整段放弃上下文。
 *
 * `minSafeCut` 额外约束**首刀**位置：表格的「表头 + 分隔行」与「第一条数据行」
 * 必须留在同一段（否则续段只剩一个空表头，渲染成孤儿表头），
 * 故首刀不能落在表头区与首行数据行之间。
 */
function detectSplitContext(chunk: string, limit: number): SplitContext {
  const lines = chunk.split('\n');

  // ── 代码围栏 ──
  const fence = detectFenceContext(lines);
  if (fence) {
    const reopen = resolveFenceReopen(fence.marker, fence.lang, limit);
    if (reopen && fitsContentBudget(reopen.prefix.length + reopen.suffix.length, limit)) {
      return {
        prefix: reopen.prefix,
        suffix: reopen.suffix,
        minSafeCut: 0,
        fenceOpenLineEnd: fence.openLineEnd,
      };
    }
    // 前缀放不下 / 预算不足 → 放弃围栏上下文，按纯文本切
    return EMPTY_CONTEXT;
  }

  // ── 表格表头 ──
  const table = detectTableContext(lines);
  if (table && fitsContentBudget(table.header.length, limit)) {
    return {
      prefix: table.header,
      suffix: '',
      minSafeCut: table.minSafeCut,
      fenceOpenLineEnd: 0,
    };
  }

  return EMPTY_CONTEXT;
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
 * 上下文开销计入切分上限（否则补完反而超限），且开销本身有封顶
 * （见 `detectSplitContext`：前缀放不下就降级或整段放弃，不会把预算吃光）。
 */
export function splitOversizedChunk(chunk: string, limit: number): string[] {
  if (limit <= 0 || chunk.length <= limit) return [chunk];

  const findEnd = resolveFindGraphemeChunkEnd();
  const context = detectSplitContext(chunk, limit);
  // 续段要补回上下文（围栏包裹 / 表头），这部分也占长度 → 切分时先扣掉，
  // 否则补完之后续段会超出上限。
  // detectSplitContext 已保证「上下文开销 ≤ 正文预算」，故这里算不出负预算。
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

    // 首刀不能落在围栏开栏行内部（否则首段只剩一个孤零零的 ``` / ```ts）。
    // 框架同义约束是 `minProgressIdx`（切点必须落在开栏行之后）；
    // 落不进去时框架切硬上限，这里同理——切硬上限而不是切在开栏行中间。
    if (
      out.length === 0
      && context.fenceOpenLineEnd > 0
      && preferred <= context.fenceOpenLineEnd
    ) {
      preferred = budget;
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
 *
 * 只处理**严格超限**（`length > limit`）的块。长度恰好等于 limit 的块原样放行——
 * 框架 chunker 在无空白长串上就是切出恰好等于 limit 的块，其切点只受
 * `avoidTrailingHighSurrogateBreak`（代理对级）保护，切点落在 ZWJ 序列或组合符号
 * 中间时仍会切碎字形。这条残留边界需要「在切点处重锚定」才能根治，
 * 成本另议（见 AGENTS.md「分块路径的已知残留」），此处不做处理。
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
 * 两条路径都过一遍 `enforceChunkLimit`——**超限块**（长中文句 / 超长表格行 /
 * 超长单行围栏）在这里按字形簇安全切开；长度恰好等于 limit 的块由框架自身的
 * 切点保护负责（代理对级，字形簇级残留见 `enforceChunkLimit` 注释）。
 */
export function chunkQQBotMarkdown(text: string, limit: number): string[] {
  const rt = tryGetQQBotRuntime();
  const adapterChunker = rt ? getAdapters(rt).chunkMarkdownText : null;
  const chunks = adapterChunker
    ? adapterChunker(text, limit)
    : chunkMarkdownPreservingTables(text, limit);
  return enforceChunkLimit(chunks, limit);
}
