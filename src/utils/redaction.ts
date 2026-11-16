/**
 * 日志脱敏工具（**根级 Security 红线的唯一实现**）。
 *
 * ## 为什么必须有
 *
 * 本地日志文件会被 `/bot-logs` **原样导出**给 c2c 用户（默认 allowFrom
 * 为空即开放）⇒ INFO 及以上级别的日志里**不得出现完整 openid / sessionKey**。
 *
 * 根 [`AGENTS.md`](../../AGENTS.md) § Security：
 * - openid 一律走 `shortId()`；
 * - sessionKey 一律记 sha256 前 8 位摘要（见 `sessionKeyDigest`）。
 *
 * ## 为什么放在 utils 而不是各文件各写一份
 *
 * 各文件各写一份 ⇒ 迟早有一处漏改（本仓历史上 group-merge / event-handlers
 * 就各有一份拷贝）。**唯一事实源**放 utils，各处 import。
 */

import { createHash } from 'node:crypto';

/**
 * 标识符截断（openid / group openid / messageId 等）。
 *
 * 统一取前 8 字符 + 省略号（openid 是 32 位 hex，前缀已足够定位排障；
 * 对齐 `/bot-group-info` 的展示惯例）。
 */
export function shortId(id: string | undefined | null): string {
  if (!id) return '?';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * sessionKey 摘要（**不可逆**）。
 *
 * sessionKey 含账号 / 对端标识，落进日志等于落 openid ⇒ 只记 sha256 前 8 位。
 */
export function sessionKeyDigest(sessionKey: string | undefined | null): string {
  if (!sessionKey) return '?';
  return createHash('sha256').update(sessionKey).digest('hex').slice(0, 8);
}
