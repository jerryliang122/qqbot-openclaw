/**
 * QQBot Typing 续期管理
 *
 * 续期时机：50 秒后
 * 最大续期：10 次（约 10 分钟）
 */

import type { TypingParams, TypingState } from './types-plugin.js';
import { checkAndConsumePassiveReplyQuota, inferQQBotScope } from './features/quota-manager.js';

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

  const { canReply: canPassiveReply, rollback } = checkAndConsumePassiveReplyQuota({
    accountId,
    msgId: replyToId,
    scope: 'c2c',
    log,
  });

  const msgIdToSend = canPassiveReply ? replyToId : undefined;

  if (!canPassiveReply) {
    log?.debug?.(`[${accountId}] typing falling back to proactive mode: quota exhausted`);
  }

  const sent = await sendTyping({ to, msgId: msgIdToSend });
  if (!sent) {
    rollback();
    log?.debug?.(`[${accountId}] typing start failed: send failed`);
    return;
  }

  log?.debug?.(`[${accountId}] typing started: ${sessionKey}`);

  const timer = setTimeout(async () => {
    await handleTypingRenewal({
      sessionKey,
      accountId,
      to,
      replyToId,
      log,
      sendTyping,
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

  const { canReply: canPassiveReply, rollback } = checkAndConsumePassiveReplyQuota({
    accountId,
    msgId: replyToId,
    scope: 'c2c',
    log,
  });

  const msgIdToSend = canPassiveReply ? replyToId : undefined;

  if (!canPassiveReply) {
    log?.debug?.(`[${accountId}] typing renewal falling back to proactive mode: quota exhausted`);
  }

  const renewed = await sendTyping({ to, msgId: msgIdToSend });
  if (!renewed) {
    rollback();
    log?.debug?.(`[${accountId}] typing renewal failed: send failed`);
    activeTypingSessions.delete(sessionKey);
    return;
  }

  state.renewalCount += 1;
  log?.debug?.(`[${accountId}] typing renewed #${state.renewalCount}: ${sessionKey}`);

  state.timer = setTimeout(async () => {
    await handleTypingRenewal(params);
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
