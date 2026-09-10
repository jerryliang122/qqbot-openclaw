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
 */
export interface QuotaState {
  count: number;
  expiresAt: number;
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
