/**
 * QQBot Outbound 适配器
 *
 * 封装 sendText/sendMedia 流式等出站操作，提供配额感知的发送能力。
 *
 * 两层结构：
 * - createQQBotOutboundAdapter —— 内部配额包装（sendTextWithQuota / sendMediaWithQuota），
 *   供中间件/流式路径使用（显式锚点在此消耗配额并经 quotaReserved 链下传 msgSeq）；
 * - createQQBotChannelOutbound —— 框架 ChannelOutboundAdapter 契约入口
 *   （sendText / sendMedia / chunker / sanitizeText 等）。无显式 ctx.replyToId
 *   时不再做缓存兜底选取——被动锚点的选取（旧配额优先）/消耗/发号统一
 *   收敛到网关 attachMsgIdWithQuota 单点。
 *   openclaw 的 channel-selection 通过 outbound.sendText（或 message.send.text /
 *   deliveryMode === "gateway"）判定通道可用，缺失会导致
 *   "Channel is unavailable: qqbot"。
 */

import { checkAndConsumePassiveReplyQuota, checkPassiveReplyQuota, inferQQBotScope } from './features/quota-manager.js';
import { peekMsgIdReceivedAt } from './features/msgid-cache.js';
import type { PluginLogger } from './utils/plugin-logger.js';
import type { InlineKeyboard, ResolvedQQBotAccount } from './types.js';
import type { SendMediaParams, SendMediaResult } from './outbound/media-send.js';
import type { SendResult } from './outbound/outbound-service.js';
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type { MessagePresentation } from 'openclaw/plugin-sdk/interactive-runtime';
import { resolveQQBotAccount } from './config.js';
import { parseTarget } from './outbound/target.js';
import { sanitizeQQBotText } from './outbound/sanitize.js';
import { chunkQQBotMarkdown } from './outbound/chunker.js';
import {
  QQBOT_PRESENTATION_CAPABILITIES,
  backfillQQBotPresentationFallbackText,
  countDroppedPresentationControls,
  readQQQuestionContext,
  renderQQBotKeyboard,
} from './outbound/presentation-buttons.js';
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
  /** 显式锚点已发号的被动回复序号（quotaReserved 链透传到网关） */
  msgSeq?: number;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
  /** QQ 原生按钮（keyboard），见 `src/outbound/presentation-buttons.ts` */
  keyboard?: InlineKeyboard;
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
    /** QQ 原生按钮（keyboard），见 `src/outbound/presentation-buttons.ts` */
    keyboard?: InlineKeyboard;
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
    sendTextWithQuota: async ({ to, text, accountId, replyToId, account, log, keyboard }) => {
      const scope = inferQQBotScope(to);
      const resolvedAccountId = accountId || account.accountId;

      // 使用原子操作检查并消耗配额（同时发号 msg_seq；条目缺失时按
      // msgid-cache 登记的真实接收时刻诚实重建窗口）
      const { canReply, seq, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
        receivedAt: peekReceivedAtFor(scope, to, replyToId),
      });

      const sendTextFn = injectedSendText || await getSendText();
      const result = await sendTextFn({
        to,
        text,
        accountId: resolvedAccountId,
        replyToId: canReply ? replyToId : undefined,
        msgSeq: canReply ? seq : undefined,
        account,
        quotaReserved: canReply,
        ...(keyboard ? { keyboard } : {}),
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

      // 使用原子操作检查并消耗配额（条目缺失时按 msgid-cache 登记的
      // 真实接收时刻诚实重建窗口）
      const { canReply, rollback } = await checkAndConsumePassiveReplyQuota({
        accountId: resolvedAccountId,
        msgId: replyToId,
        scope,
        log,
        receivedAt: peekReceivedAtFor(scope, to, replyToId),
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

/** 框架 payload 上下文（带完整 ReplyPayload —— 承载 channelData 里的按钮） */
export interface ChannelOutboundPayloadContext extends ChannelOutboundSendContext {
  payload: {
    text?: string;
    channelData?: Record<string, unknown>;
  };
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
 * 从 payload 的 channelData 里读回 QQ 原生按钮。
 *
 * 与 Telegram 的 `channelData.telegram.buttons` 同构：渲染层
 * （`renderPresentation`）把按钮写进 `channelData.qqbot.keyboard`，
 * 发送层（本函数的使用方）再取出来下发。
 *
 * 形状校验：必须是 `{ content: { rows: [...] } }`，否则视为无按钮
 * （宁可降级为纯文本，也不把畸形结构发给平台）。
 */
function readQQBotKeyboardFromChannelData(
  channelData: Record<string, unknown> | undefined,
): InlineKeyboard | undefined {
  if (!channelData) return undefined;
  const qqbot = channelData.qqbot;
  if (!qqbot || typeof qqbot !== 'object') return undefined;
  const keyboard = (qqbot as Record<string, unknown>).keyboard;
  if (!keyboard || typeof keyboard !== 'object') return undefined;
  const content = (keyboard as Record<string, unknown>).content;
  if (!content || typeof content !== 'object') return undefined;
  const rows = (content as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return keyboard as InlineKeyboard;
}

/**
 * 显式锚点透传：框架给的 ctx.replyToId（turn 回复锚点）原样透传。
 *
 * 无显式锚点时（message 工具 / 框架直发路径）返回 undefined——被动锚点的
 * 选取（旧配额优先）、配额消耗与 msg_seq 发号统一收敛到网关
 * attachMsgIdWithQuota 单点完成（账号键含单账号回退，与记账一致）。
 */
function resolveExplicitReplyToId(explicitReplyToId?: string | null): string | undefined {
  return explicitReplyToId ?? undefined;
}

/**
 * 为显式锚点消耗查接收时刻（诚实重建用）：msgid-cache 里有登记则返回
 * 平台事件时间；未登记（旁路 msgId/测试注入）返回 undefined，消耗侧退回
 * now+TTL 旧兜底并打 DEBUG。
 */
function peekReceivedAtFor(scope: 'c2c' | 'group', to: string, msgId?: string | null): number | undefined {
  if (!msgId) return undefined;
  try {
    const { targetId } = parseTarget(to);
    if (!targetId) return undefined;
    return peekMsgIdReceivedAt(scope, targetId, msgId);
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

  /** 纯文本发送（sendText 与 sendPayload 无键盘分支共用） */
  const sendPlainText = async (
    ctx: ChannelOutboundSendContext,
  ): Promise<ChannelOutboundDeliveryResult> => {
    const account = resolveQQBotAccount(ctx.cfg, ctx.accountId ?? undefined);
    const result = await quotaAdapter.sendTextWithQuota({
      to: ctx.to,
      text: ctx.text ?? '',
      accountId: ctx.accountId ?? undefined,
      replyToId: resolveExplicitReplyToId(ctx.replyToId),
      account,
      log: alog,
    });
    if (result.error) throw new Error(result.error);
    return { channel: 'qqbot', messageId: result.messageId ?? '' };
  };

  return {
    ...quotaAdapter,
    deliveryMode: 'direct' as const,

    sendText: async (ctx: ChannelOutboundSendContext): Promise<ChannelOutboundDeliveryResult> =>
      sendPlainText(ctx),

    sendMedia: async (ctx: ChannelOutboundSendContext): Promise<ChannelOutboundDeliveryResult> => {
      const account = resolveQQBotAccount(ctx.cfg, ctx.accountId ?? undefined);
      const resolvedAccountId = ctx.accountId ?? account.accountId;
      const result = await quotaAdapter.sendMediaWithQuota({
        to: ctx.to,
        source: ctx.mediaUrl ?? '',
        text: ctx.text,
        accountId: resolvedAccountId,
        replyToId: resolveExplicitReplyToId(ctx.replyToId),
        account,
        agentId: resolveMCPAgentId(ctx.to, resolvedAccountId, ctx.cfg, alog),
        log: alog,
      });
      if (result.error) throw new Error(result.error);
      return { channel: 'qqbot', messageId: result.messageId ?? '' };
    },

    /**
     * 带原生按钮的 payload 发送。
     *
     * 框架在 payload 含 `channelData` 时走本路径（见框架
     * `payloadRequiresDurablePayloadTransport` → `hasReplyPayloadContent`
     * 对 `channelData` 的判定），因此 QQ 原生按钮由这里下发。
     *
     * 无 keyboard 的 payload 退化为普通文本发送（等价于 `sendText`），
     * 保证该路径对普通消息完全透明。
     */
    sendPayload: async (ctx: ChannelOutboundPayloadContext): Promise<ChannelOutboundDeliveryResult> => {
      const payload = ctx.payload;
      const keyboard = readQQBotKeyboardFromChannelData(payload.channelData);
      const text = payload.text ?? ctx.text ?? '';

      // 无按钮 → 走普通文本路径（不引入行为差异）
      if (!keyboard) {
        return sendPlainText(ctx);
      }

      const account = resolveQQBotAccount(ctx.cfg, ctx.accountId ?? undefined);
      const resolvedAccountId = ctx.accountId ?? account.accountId;
      const result = await quotaAdapter.sendTextWithQuota({
        to: ctx.to,
        text,
        accountId: resolvedAccountId,
        replyToId: resolveExplicitReplyToId(ctx.replyToId),
        account,
        keyboard,
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

    // ── presentation → QQ 原生按钮 ──────────────────────────────────
    // 框架在 deliver-prepare 装配这两个钩子（契约见 openclaw 的
    // `ChannelOutboundAdapter.presentationCapabilities` /
    // `.renderPresentation`）。缺失时框架会把模型的按钮块降级成
    // **纯文本列表**——这就是此前「声明了 inlineButtons 却落地不了」
    // 的根因。提供后模型生成的按钮在 QQ 客户端真实可点。
    presentationCapabilities: QQBOT_PRESENTATION_CAPABILITIES,

    /**
     * 把框架的 presentation 渲染为 QQ 原生 keyboard。
     *
     * 产物挂在 `payload.channelData.qqbot.keyboard`（与 Telegram 的
     * `channelData.telegram.buttons` 同构），由出站层取出发给平台。
     *
     * 失败语义：**绝不抛错**。任何映射异常都降级为「保留文本、丢弃按钮」，
     * 因为 QQ 消息一旦因异常丢失不可恢复。
     */
    renderPresentation: ({ payload, presentation }: {
      payload: Record<string, unknown>;
      presentation: MessagePresentation;
    }) => {
      try {
        // 防御层：fallback 模式下框架会把 payload.text 置空后再调本钩子
        //（期待通道自行合成文本，Telegram 即如此），先回填避免空正文。
        // 详见 presentation-buttons.ts 的 backfillQQBotPresentationFallbackText。
        const effectivePayload = backfillQQBotPresentationFallbackText(payload, presentation);
        const channelData = effectivePayload.channelData as Record<string, unknown> | undefined;
        // ask_user 上下文：把框架 question action 的 optionValue 映射回
        // QQ 回调所需的选项索引（无此上下文时 question 按钮被丢弃）。
        const questionContext = readQQQuestionContext(channelData);
        const keyboard = renderQQBotKeyboard(presentation, questionContext);
        if (!keyboard) {
          // 没有可落地的按钮 → 丢弃 presentation，保留正文。
          const { presentation: _p, ...rest } = effectivePayload;
          return rest as typeof payload;
        }
        const dropped = countDroppedPresentationControls(presentation, questionContext);
        if (dropped.dropped > 0) {
          alog.debug?.(
            `[qqbot] presentation: ${dropped.dropped} control(s) not renderable on QQ ` +
            `(${JSON.stringify(dropped.reasons)})`,
          );
        }
        const { presentation: _p, ...rest } = effectivePayload;
        return {
          ...rest,
          channelData: {
            ...channelData,
            qqbot: {
              ...(channelData?.qqbot as Record<string, unknown> | undefined),
              keyboard,
            },
          },
        } as typeof payload;
      } catch (err) {
        alog.warn?.(
          `[qqbot] renderPresentation failed, degrading to plain text: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        const { presentation: _p, ...rest } = payload;
        return rest as typeof payload;
      }
    },
  };
}

export const qqbotChannelOutbound = createQQBotChannelOutbound({
  shouldSuppressLocalPayloadPrompt: () => false,
  shouldTreatDeliveredTextAsVisible: () => true,
  preferFinalAssistantVisibleText: true,
});
