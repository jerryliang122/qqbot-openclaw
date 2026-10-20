/**
 * 字形簇（grapheme cluster）安全切分
 *
 * ## 为什么需要
 *
 * QQ 单条消息上限 5000 字（`TEXT_CHUNK_LIMIT`）。框架自带的 `chunkMarkdownText`
 * 按「换行 / 空白」断点切块；中文长句没有空白时它会**在硬上限处直接截断**——
 * 正好落在 emoji（代理对 / ZWJ 序列 / 组合符号）中间就会把字形切碎，QQ 侧
 * 渲染成豆腐块。本地 GFM 表格 fallback 则是**整块不切**，超限消息被平台
 * 直接拒收（消息丢失）。
 *
 * 两条路都要修：切点必须落在**完整字形簇**边界上。
 *
 * ## 能力探测
 *
 * openclaw 2026.10.5 新增 `openclaw/plugin-sdk/text-grapheme` 子路径，提供
 * `findGraphemeChunkEnd`（基于 `Intl.Segmenter`）。但：
 *
 * - 2026.9.1 基线**没有**该子路径 → 运行时 require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED
 * - 该子路径在 openclaw 发布包里**没有 .d.ts** → 类型靠本仓库的 ambient stub
 *
 * 故：优先用官方原语，取不到时回退到本地的 `Intl.Segmenter` 等价实现
 * （语义与官方一致：优先期望断点，吸附到字形簇边界，必要时代理对安全兜底）。
 * 这符合 AGENTS.md 的「不得使用仅存在于更新版本中的 API，除非带能力探测与回退」。
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// CJS 兼容：__filename 在 CJS 中可用，ESM 中使用 import.meta.url
const __file = typeof __filename !== 'undefined'
  ? __filename
  : fileURLToPath(import.meta.url);
const req = createRequire(__file);

/** 官方原语的签名（与 ambient stub 一致） */
export type FindGraphemeChunkEnd = (
  text: string,
  start: number,
  maxEnd: number,
  preferredEnd?: number,
  allowPartial?: boolean,
) => number;

let cachedResolver: FindGraphemeChunkEnd | null | undefined;

/**
 * 解析字形簇切点函数
 *
 * - 命中 openclaw ≥ 2026.10.5 → 用官方 `text-grapheme`
 * - 未命中 → 本地 `Intl.Segmenter` 等价实现
 *
 * 探测失败（子路径不存在 / 抛错）一律静默回退，绝不让分块路径因可选能力失败。
 */
export function resolveFindGraphemeChunkEnd(): FindGraphemeChunkEnd {
  if (cachedResolver !== undefined) return cachedResolver ?? localFindGraphemeChunkEnd;

  let official: FindGraphemeChunkEnd | null = null;
  try {
    const mod = req('openclaw/plugin-sdk/text-grapheme') as
      | { findGraphemeChunkEnd?: FindGraphemeChunkEnd }
      | undefined;
    if (typeof mod?.findGraphemeChunkEnd === 'function') {
      official = mod.findGraphemeChunkEnd;
    }
  } catch {
    // 9.1 基线无该子路径（ERR_PACKAGE_PATH_NOT_EXPORTED）→ 永久回退本地实现
    official = null;
  }

  cachedResolver = official;
  return official ?? localFindGraphemeChunkEnd;
}

/** 本地字形簇切分器（与官方实现语义一致） */
let segmenter: Intl.Segmenter | null = null;
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter) return segmenter;
  if (typeof Intl === 'undefined' || typeof (Intl as { Segmenter?: unknown }).Segmenter !== 'function') {
    return null;
  }
  segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return segmenter;
}

/**
 * 本地 `findGraphemeChunkEnd` 等价实现
 *
 * 规则（对齐 openclaw 2026.10.5 的 dist/grapheme-*.mjs）：
 * 1. 期望切点落在两个 ASCII 字符之间且不是 CRLF 中间 → 直接用（不必分段）
 * 2. 否则吸附到所在字形簇的起点
 * 3. 吸附后无进展 → 退回硬上限；再不行 → 代理对安全的部分切
 */
export function localFindGraphemeChunkEnd(
  text: string,
  start: number,
  maxEnd: number,
  preferredEnd: number = maxEnd,
  allowPartial: boolean = true,
): number {
  const hardEnd = Math.min(maxEnd, text.length);
  if (hardEnd <= start) return start;

  const preferred =
    Number.isInteger(preferredEnd) && preferredEnd > start && preferredEnd <= hardEnd
      ? preferredEnd
      : hardEnd;

  if (preferred === text.length) return preferred;

  const before = text.charCodeAt(preferred - 1);
  const after = text.charCodeAt(preferred);
  // 切点两侧都是 ASCII 且不是 CRLF → 无需字形吸附
  if (before <= 127 && after <= 127 && !(before === 13 && after === 10)) {
    return preferred;
  }

  const seg = getSegmenter();
  if (!seg) {
    // 无 Intl.Segmenter：至少保证不切碎代理对
    return allowPartial ? avoidTrailingHighSurrogateBreak(text, start, hardEnd) : start;
  }

  const segments = seg.segment(text);
  const codePoint = text.codePointAt(preferred);
  const segIndex = codePoint !== undefined && codePoint > 0xffff ? preferred + 1 : preferred;
  const containing = segments.containing(segIndex);
  let end = containing?.index ?? preferred;

  if (end <= start && preferred < hardEnd) {
    const fallbackCodePoint = text.codePointAt(hardEnd);
    const fallbackIndex =
      fallbackCodePoint !== undefined && fallbackCodePoint > 0xffff ? hardEnd + 1 : hardEnd;
    end = segments.containing(fallbackIndex)?.index ?? hardEnd;
  }

  if (end > start) return end;
  return allowPartial ? avoidTrailingHighSurrogateBreak(text, start, hardEnd) : start;
}

/**
 * 代理对安全的部分切：不在高代理项（emoji 的后半个 UTF-16 码元）之后断开
 */
function avoidTrailingHighSurrogateBreak(text: string, start: number, hardEnd: number): number {
  if (hardEnd <= start) return start;
  const last = text.charCodeAt(hardEnd - 1);
  // 0xD800–0xDBFF 是高代理项（emoji 前半）
  if (last >= 0xd800 && last <= 0xdbff && hardEnd < text.length) {
    return hardEnd - 1;
  }
  return hardEnd;
}
