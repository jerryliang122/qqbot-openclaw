/**
 * QQBot Channel Plugin 类型定义
 */

import type { ResolvedQQBotAccount } from './types.js';

/**
 * QQBot 探测结果
 */
export interface QQBotProbe {
  ok: boolean;
  bot?: {
    id?: string;
    username?: string;
  };
  status?: number;
}

/**
 * QQBot 审计结果
 */
export interface QQBotAudit {
  ok: boolean;
  checkedGroups: number;
  unresolvedGroups: number;
}

/**
 * QQBot 会话路由
 */
export interface QQBotSessionRoute {
  to: string;
  threadId?: string | number;
  chatType: 'direct' | 'group';
  sessionKey: string;
  baseSessionKey: string;
}

/**
 * 配额状态
 *
 * `seq`：该 msg_id 已发号到的被动回复序号（msg_seq）最大值，从 0 起、
 * 每次消耗配额时 +1——QQ 平台「相同 msg_id + msg_seq 重复发送会失败」，
 * 同一 msg_id 的多次回复必须逐条区分。seq 单调递增、从不回滚
 * （浪费序号无害，精确重复才是平台硬错误）。
 */
export interface QuotaState {
  count: number;
  expiresAt: number;
  seq?: number;
}

/**
 * 配额管理参数
 */
export interface QuotaCheckParams {
  accountId: string;
  msgId?: string;
  scope: 'c2c' | 'group';
}

export interface QuotaConsumeParams extends QuotaCheckParams {
  msgId: string;
  log?: {
    debug?: (message: string) => void;
  };
}

/**
 * Typing 续期参数
 */
export interface TypingParams {
  accountId: string;
  to: string;
  replyToId: string;
  log?: {
    debug?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/**
 * Typing 状态
 */
export interface TypingState {
  timer: NodeJS.Timeout;
  startedAt: number;
  renewalCount: number;
}
