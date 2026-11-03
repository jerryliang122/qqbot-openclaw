/**
 * QQBot Typing 续期管理（心跳适配器路径）
 *
 * 续期时机：50 秒后
 * 最大续期：10 次（约 10 分钟）
 *
 * 配额口径（2026-11-03）：与 turn 内中间件（middleware/typing.ts）同口径——
 * typing 不占回复额度，但**绝不降级为主动形态**：锚点不可用（TTL 过期 /
 * 死锚点）⇒ 不启动 / 停止续期。主动额度留给正文与前置消息。
 */

import type { TypingParams, TypingState } from './types-plugin.js';
import { checkPassiveReplyQuota, inferQQBotScope } from './features/quota-manager.js';

const activeTypingSessions = new Map<string, TypingState>();

const TYPING_RENEWAL_MS = 50 * 1000;
const MAX_RENEWALS = 10;

export async function startTypingWithRenewal(
  params: TypingParams & {
    sendTyping: (params: { to: string; msgId?: string }) => Promise<boolean>;
  },
): Promise<void> {
  const { accountId, to, replyToId, log, sendTyping } = params;
  const sessionKey = `${accountId}:${to}:${replyToId}`;

  if (activeTypingSessions.has(sessionKey)) {
    return;
  }

  const scope = inferQQBotScope(to);

  if (scope !== 'c2c') {
    log?.debug?.(`[${accountId}] typing not supported for scope: ${scope}`);
    return;
  }

  if (!replyToId) {
    log?.debug?.(`[${accountId}] typing requires replyToId`);
    return;
  }

  // 锚点存活探测（不消耗——平台实测 typing 不占回复额度：2026-11-02 探针
  // 20 次 typing + 5 次回复同 msg_id 全部送达）。typing 的平台侧 msg_seq
  // 由 SDK sendInputNotify 准随机注入（无透传位），不受插件单调计数器控制
  // ——同 msg_id 上小概率与正文 seq 碰撞（单次 ~4/65536，失败自愈）。
  //
  // 锚点不可用 ⇒ **不启动 typing**（绝不降级为不带 msg_id 的主动形态：
  // 主动额度要留给正文与前置消息）。
  const anchorAlive = checkPassiveReplyQuota({
    accountId,
    msgId: replyToId,
    scope: 'c2c',
  });

  if (!anchorAlive) {
    log?.debug?.(`[${accountId}] typing not started: passive anchor unavailable (expired/dead)`);
    return;
  }

  const sent = await sendTyping({ to, msgId: replyToId });
  if (!sent) {
    log?.debug?.(`[${accountId}] typing start failed: send failed`);
    return;
  }

  log?.debug?.(`[${accountId}] typing started: ${sessionKey}`);

  const timer = setTimeout(() => {
    // promise 被 setTimeout 回调丢弃，失败不就地捕获会成为 unhandledRejection
    void handleTypingRenewal({
      sessionKey,
      accountId,
      to,
      replyToId,
      log,
      sendTyping,
    }).catch((err: unknown) => {
      log?.warn?.(`[${accountId}] typing renewal error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TYPING_RENEWAL_MS);

  activeTypingSessions.set(sessionKey, {
    timer,
    startedAt: Date.now(),
    renewalCount: 0,
  });
}

async function handleTypingRenewal(
  params: TypingParams & {
    sessionKey: string;
    sendTyping: (params: { to: string; msgId?: string }) => Promise<boolean>;
  },
): Promise<void> {
  const { sessionKey, accountId, to, replyToId, log, sendTyping } = params;

  const state = activeTypingSessions.get(sessionKey);
  if (!state) {
    return;
  }

  if (state.renewalCount >= MAX_RENEWALS) {
    log?.debug?.(`[${accountId}] typing stopped: max renewals reached`);
    activeTypingSessions.delete(sessionKey);
    return;
  }

  // 锚点存活探测（不消耗）——typing 的平台侧 msg_seq 由 SDK sendInputNotify
  // 准随机注入（无透传位），不受插件单调计数器控制——同 msg_id 上小概率
  // 与正文 seq 碰撞（失败自愈）。
  //
  // 锚点不可用 ⇒ **停止续期**（不降级为主动形态）。
  const anchorAlive = checkPassiveReplyQuota({
    accountId,
    msgId: replyToId,
    scope: 'c2c',
  });

  if (!anchorAlive) {
    log?.debug?.(`[${accountId}] typing renewal stopped: passive anchor unavailable (expired/dead)`);
    activeTypingSessions.delete(sessionKey);
    return;
  }

  const renewed = await sendTyping({ to, msgId: replyToId });
  if (!renewed) {
    log?.debug?.(`[${accountId}] typing renewal failed: send failed`);
    activeTypingSessions.delete(sessionKey);
    return;
  }

  state.renewalCount += 1;
  log?.debug?.(`[${accountId}] typing renewed #${state.renewalCount}: ${sessionKey}`);

  state.timer = setTimeout(() => {
    void handleTypingRenewal(params).catch((err: unknown) => {
      log?.warn?.(`[${accountId}] typing renewal error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, TYPING_RENEWAL_MS);

  activeTypingSessions.set(sessionKey, state);
}

export function stopTyping(params: {
  accountId: string;
  to: string;
  replyToId: string;
  log?: {
    debug?: (message: string) => void;
  };
}): void {
  const { accountId, to, replyToId, log } = params;
  const sessionKey = `${accountId}:${to}:${replyToId}`;

  const state = activeTypingSessions.get(sessionKey);
  if (state) {
    clearTimeout(state.timer);
    activeTypingSessions.delete(sessionKey);
    log?.debug?.(`[${accountId}] typing stopped: ${sessionKey}`);
  }
}

export function cleanupAllTyping(): void {
  for (const [, state] of activeTypingSessions.entries()) {
    clearTimeout(state.timer);
  }
  activeTypingSessions.clear();
}

export function isTypingActive(accountId: string, replyToId: string): boolean {
  for (const [key] of activeTypingSessions.entries()) {
    if (key.startsWith(`${accountId}:`) && key.endsWith(`:${replyToId}`)) {
      return true;
    }
  }
  return false;
}

/**
 * 清理指定账户的所有 typing session
 * 在账户停止时调用，防止旧 session 阻塞新 session
 */
export function cleanupTypingByAccount(accountId: string): void {
  const keysToDelete: string[] = [];
  
  for (const [key, state] of activeTypingSessions.entries()) {
    if (key.startsWith(`${accountId}:`)) {
      clearTimeout(state.timer);
      keysToDelete.push(key);
    }
  }
  
  for (const key of keysToDelete) {
    activeTypingSessions.delete(key);
  }
}
