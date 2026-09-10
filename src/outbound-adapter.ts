/**
 * QQBot Outbound 适配器
 *
 * 封装 sendText/sendMedia 流式等出站操作，提供配额感知的发送能力。
 *
 * 两层结构：
 * - createQQBotOutboundAdapter —— 内部配额包装（sendTextWithQuota / sendMediaWithQuota），
 *   供中间件/流式路径使用；
 * - createQQBotChannelOutbound —— 框架 ChannelOutboundAdapter 契约入口
 *   （sendText / sendMedia / chunker / sanitizeText 等）。
 *   openclaw 的 channel-selection 通过 outbound.sendText（或 message.send.text /
 *   deliveryMode === "gateway"）判定通道可用，缺失会导致
 *   "Channel is unavailable: qqbot"。
 */

import { checkAndConsumePassiveReplyQuota, checkPassiveReplyQuota, inferQQBotScope } from './features/quota-manager.js';
import type { PluginLogger } from './utils/plugin-logger.js';
import type { ResolvedQQBotAccount } from './types.js';
import type { SendMediaParams, SendMediaResult } from './outbound/media-send.js';
import type { SendResult } from './outbound/outbound-service.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import { resolveQQBotAccount } from './config.js';
import { parseTarget } from './outbound/target.js';
import { getCachedMsgId } from './features/msgid-cache.js';
import { sanitizeQQBotText } from './outbound/sanitize.js';
import { chunkQQBotMarkdown } from './outbound/chunker.js';
import { isApprovalPayload } from './features/approval-utils.js';
import { TEXT_CHUNK_LIMIT } from './constants.js';
import { tryGetQQBotRuntime } from './runtime.js';
import { getAdapters } from './adapter/resolve.js';
import { createPluginLogger } from './utils/plugin-logger.js';

// 契约入口（框架直发 / message 工具 / cron announce）无调用方 logger 可传，
// 用模块级 logger 兜底——frameworkSink 每次调用时 resolve，register 早期自动降级 console
const alog = createPluginLogger({ prefix: '[outbound]' });

export type SendTextFn = (params: {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
}) => Promise<SendResult>;

export type SendMediaFn = (params: SendMediaParams) => Promise<SendMediaResult>;

export interface QQBotOutboundAdapterParams {
  sendText?: SendTextFn;
  sendMedia?: SendMediaFn;
  shouldSuppressLocalPayloadPrompt?: (params: { payload: unknown }) => boolean;
  shouldTreatDeliveredTextAsVisible?: (params: { kind: string; text?: string }) => boolean;
  preferFinalAssistantVisibleText?: boolean;
  beforeDeliverPayload?: (params: {
    cfg: unknown;
    target: { to: string; accountId?: string; replyToId?: string };
    hint?: unknown;
    payload?: unknown;
  }) => Promise<{ mode: 'passive' | 'proactive'; msgId?: string } | void>;
}

export interface QQBotOutboundAdapter {
  sendTextWithQuota: (params: {
    to: string;
    text: string;
    accountId?: string;
    replyToId?: string;
    account: ResolvedQQBotAccount;
    log?: PluginLogger;
  }) => Promise<{ messageId?: string; error?: string }>;
  sendMediaWithQuota: (params: {
    to: string;
    source: string;
    text?: string;
    accountId?: string;
    replyToId?: string;
    account: ResolvedQQBotAccount;
    agentId?: string;
    log?: PluginLogger;
  }) => Promise<{ messageId?: string; error?: string }>;
  canSendTyping: (params: {
    to: string;
    accountId: string;
    replyToId: string;
    log?: PluginLogger;
  }) => Promise<boolean>;
  shouldSuppressLocalPayloadPrompt: (params: { payload: unknown }) => boolean;
  shouldTreatDeliveredTextAsVisible: (params: { kind: string; text?: string }) => boolean;
  preferFinalAssistantVisibleText: boolean;
}

let lazySendText: SendTextFn | undefined;
let lazySendMedia: SendMediaFn | undefined;

async function getSendText(): Promise<SendTextFn> {
  if (!lazySendText) {
    const mod = await import('./outbound/outbound-service.js');
    lazySendText = mod.sendText;
  }
  return lazySendText;
}

async function getSendMedia(): Promise<SendMediaFn> {
  if (!lazySendMedia) {
    const mod = await import('./outbound/media-send.js');
    lazySendMedia = mod.sendMedia;
  }
  return lazySendMedia;
}

/**
 * 创建 QQBot Outbound 适配器
 */
export function createQQBotOutboundAdapter(params: QQBotOutboundAdapterParams): QQBotOutboundAdapter {
  const {
    sendText: injectedSendText,
    sendMedia: injectedSendMedia,
    shouldSuppressLocalPayloadPrompt = () => false,
    shouldTreatDeliveredTextAsVisible = () => true,
    preferFinalAssistantVisibleText = true,
    beforeDeliverPayload,
  } = params;

  return {
    sendTextWithQuota: async ({ to, text, accountId, replyToId, account, log }) => {
      const scope = inferQQBotScope(to);
      const resolvedAccountId = accountId || account.accountId;

      // 使用原子操作检查并消耗配额
      const { canReply, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
      });

      const sendTextFn = injectedSendText || await getSendText();
      const result = await sendTextFn({
        to,
        text,
        accountId: resolvedAccountId,
        replyToId: canReply ? replyToId : undefined,
        account,
        quotaReserved: canReply,
      });

      // 发送失败时回滚配额
      if (canReply && replyToId && result.error) {
        rollback();
        log?.debug?.(`[${resolvedAccountId}] rollback quota: send failed`);
      } else if (!canReply) {
        log?.info?.(`[${resolvedAccountId}] [quota] fallback to proactive send: quota exhausted or no msgId`);
      }

      return result;
    },

    sendMediaWithQuota: async ({ to, source, text, accountId, replyToId, account, agentId, log }) => {
      const scope = inferQQBotScope(to);
      const resolvedAccountId = accountId || account.accountId;

      // 使用原子操作检查并消耗配额
      const { canReply, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
      });

      const sendMediaFn = injectedSendMedia || await getSendMedia();
      const result = await sendMediaFn({
        to,
        source,
        text,
        replyToId: canReply ? replyToId : undefined,
        accountId: resolvedAccountId,
        agentId,
        log,
        quotaReserved: canReply,
      });

      // 发送失败时回滚配额
      if (canReply && replyToId && result.error) {
        rollback();
        log?.debug?.(`[${resolvedAccountId}] rollback quota: send failed`);
      } else if (!canReply) {
        log?.info?.(`[${resolvedAccountId}] [quota] fallback to proactive media send: quota exhausted or no msgId`);
      }

      return result;
    },

    canSendTyping: async ({ to, accountId, replyToId, log }) => {
      const scope = inferQQBotScope(to);

      if (scope !== 'c2c' || !replyToId) {
        return false;
      }

      const canPassiveReply = await checkPassiveReplyQuota({
        accountId,
        msgId: replyToId,
        scope: 'c2c',
      });

      if (!canPassiveReply) {
        return false;
      }

      return true;
    },

    shouldSuppressLocalPayloadPrompt,
    shouldTreatDeliveredTextAsVisible,
    preferFinalAssistantVisibleText,
  };
}

// ── 框架契约入口（openclaw ChannelOutboundAdapter）──

/** 框架 sendText / sendMedia 上下文（openclaw ChannelOutboundContext 子集） */
export interface ChannelOutboundSendContext {
  to: string;
  text?: string;
  mediaUrl?: string;
  accountId?: string | null;
  replyToId?: string | null;
  cfg: OpenClawConfig;
}

export interface ChannelOutboundDeliveryResult {
  channel: 'qqbot';
  messageId: string;
}

/** 恢复 MCP agentId 路由：media-send 用它解析相对路径的工作区 */
function resolveMCPAgentId(
  to: string,
  accountId: string,
  cfg: unknown,
  log?: PluginLogger,
): string | undefined {
  try {
    const parts = to.split(':');
    const scope = parts[1];
    const peerId = parts[2];
    if (!scope || !peerId) return undefined;
    const rt = tryGetQQBotRuntime();
    if (!rt) return undefined;
    const route = getAdapters(rt).resolveAgentRoute?.({
      cfg, channel: 'qqbot', accountId,
      peer: { kind: scope === 'group' ? 'group' : 'direct', id: peerId },
    });
    log?.debug?.(`resolveMCPAgentId to=${to} => agentId=${route?.agentId ?? 'none'}`);
    return route?.agentId;
  } catch { return undefined; }
}

/**
 * 被动优先的 replyToId 解析：框架未显式给 replyToId 时（message 工具 / 框架
 * 直发路径），从 msgid-cache 取该会话最新未过期 msg_id，让发送走配额感知的
 * 被动通道（保每日主动预算）。无缓存（静群超 TTL）→ undefined → 主动发送。
 */
function resolvePassiveFirstReplyToId(to: string, explicitReplyToId?: string | null): string | undefined {
  if (explicitReplyToId) return explicitReplyToId;
  try {
    const { scope, targetId } = parseTarget(to);
    if (!targetId) return undefined;
    return getCachedMsgId(scope, targetId);
  } catch {
    return undefined;
  }
}

/**
 * 创建框架 ChannelOutboundAdapter 契约入口。
 *
 * 框架可用性判定要求 outbound.sendText 存在（channel-resolution.ts /
 * channel-bootstrap.runtime.ts），sendText/sendMedia 内部走配额感知包装，
 * 配额耗尽时自动降级主动消息。
 */
export function createQQBotChannelOutbound(params: QQBotOutboundAdapterParams = {}) {
  const quotaAdapter = createQQBotOutboundAdapter(params);

  return {
    ...quotaAdapter,
    deliveryMode: 'direct' as const,

    sendText: async (ctx: ChannelOutboundSendContext): Promise<ChannelOutboundDeliveryResult> => {
      const account = resolveQQBotAccount(ctx.cfg, ctx.accountId ?? undefined);
      const result = await quotaAdapter.sendTextWithQuota({
        to: ctx.to,
        text: ctx.text ?? '',
        accountId: ctx.accountId ?? undefined,
        replyToId: resolvePassiveFirstReplyToId(ctx.to, ctx.replyToId),
        account,
        log: alog,
      });
      if (result.error) throw new Error(result.error);
      return { channel: 'qqbot', messageId: result.messageId ?? '' };
    },

    sendMedia: async (ctx: ChannelOutboundSendContext): Promise<ChannelOutboundDeliveryResult> => {
      const account = resolveQQBotAccount(ctx.cfg, ctx.accountId ?? undefined);
      const resolvedAccountId = ctx.accountId ?? account.accountId;
      const result = await quotaAdapter.sendMediaWithQuota({
        to: ctx.to,
        source: ctx.mediaUrl ?? '',
        text: ctx.text,
        accountId: resolvedAccountId,
        replyToId: resolvePassiveFirstReplyToId(ctx.to, ctx.replyToId),
        account,
        agentId: resolveMCPAgentId(ctx.to, resolvedAccountId, ctx.cfg, alog),
        log: alog,
      });
      if (result.error) throw new Error(result.error);
      return { channel: 'qqbot', messageId: result.messageId ?? '' };
    },

    sanitizeText: ({ text }: { text: string }) => sanitizeQQBotText(text),
    chunker: (text: string, limit: number) => chunkQQBotMarkdown(text, limit),
    chunkerMode: 'markdown' as const,
    textChunkLimit: TEXT_CHUNK_LIMIT,
    shouldSuppressLocalPayloadPrompt: ({ payload }: { payload: unknown }) => isApprovalPayload(payload),
  };
}

export const qqbotChannelOutbound = createQQBotChannelOutbound({
  shouldSuppressLocalPayloadPrompt: () => false,
  shouldTreatDeliveredTextAsVisible: () => true,
  preferFinalAssistantVisibleText: true,
});
