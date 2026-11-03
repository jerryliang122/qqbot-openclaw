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
 *
 * `dead`：死锚点标记，平台 40034005/40034128 判死后由 invalidateMsgIdQuota
 * 置位。置位后该 msg_id 永不再被消耗，rollback 也不得复活——否则上游发送
 * 失败的补偿回滚会把死锚点再次挂接、再吃一次平台确定性拒绝。
 *
 * `count`：观测计数（反应式模型，2026-11-03）——平台实测不执行文档口径
 * 的 4/5 次上限，count 超限不阻断发送，仅触发 `overLimitLogged` 一次的
 * INFO 留证。
 */
export interface QuotaState {
  count: number;
  expiresAt: number;
  seq?: number;
  dead?: boolean;
  /** 超文档上限的观测日志已打过（每 msg_id 一次） */
  overLimitLogged?: boolean;
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
