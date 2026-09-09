/**
 * QQBotGateway — 封装单个 Bot 实例的完整生命周期
 */
import {
  QQBot,
  FileKVStore,
  kvSessionPersistence,
  MediaFileType,
  type ReplyTarget,
  type QQBotInboundMessage,
  type MiddlewareContext,
  type InteractionEvent,
  type MessageResponse,
  type StreamSession,
} from '@tencent-connect/qqbot-nodejs';
import os from 'node:os';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import { setupMiddlewares } from './middleware-setup.js';
import { handleMessage, handleInteraction } from './event-handlers.js';
import { getQQBotDataDir } from '../utils/platform.js';
import { buildUserAgent } from '../bot-instance.js';
import { createPluginWebhookAdapter } from '../adapter/webhook.js';
import { getPersistedRefIndexStore } from '../features/ref-index-store.js';
import { recordOutboundMessageId } from '../features/outbound-echo-store.js';
import { recordOutboundToGroupHistory } from '../features/history-store.js';
import { resolveGroupConfigFromAccount } from '../config.js';
import { checkAndConsumePassiveReplyQuota } from '../features/quota-manager.js';
import { recordProactiveSend } from '../features/proactive-budget.js';
import { getCachedMsgId } from '../features/msgid-cache.js';
import { notifyOutboundMessageSent } from '../features/typing-refresh.js';

export interface GatewayCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export interface SendOptions {
  msgId?: string;
  text?: string;
}

// ── 超时常量 ──

const TEXT_TIMEOUT_MS = 30_000;
const MEDIA_TIMEOUT_MS = 300_000;

function resolveMs(envKey: string, defaultMs: number): number {
  const env = process.env[envKey];
  if (env) {
    const v = Number(env);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  return defaultMs;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return promise;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`出站超时: ${label} (${ms}ms)`)), ms),
    ),
  ]);
}

export class QQBotGateway {
  readonly bot: QQBot;
  private readonly account: ResolvedQQBotAccount;
  private readonly runtime: PluginRuntime;
  readonly log: PluginLogger;
  private readonly textTimeout: number;
  private readonly mediaTimeout: number;

  constructor(account: ResolvedQQBotAccount, runtime: PluginRuntime, log?: PluginLogger) {
    this.textTimeout = resolveMs('OPENCLAW_OUTBOUND_TIMEOUT_MS', TEXT_TIMEOUT_MS);
    this.mediaTimeout = resolveMs('OPENCLAW_OUTBOUND_MEDIA_TIMEOUT_MS', MEDIA_TIMEOUT_MS);
    this.account = account;
    this.runtime = runtime;
    this.log = log ?? createPluginLogger({ prefix: `[qqbot:${account.accountId}]` });

    const dataDir = getQQBotDataDir(account.accountId);

    const isWebhook = account.config.transport === 'webhook';

    this.bot = new QQBot({
      appId: account.appId,
      appSecret: account.clientSecret,
      accountId: account.accountId,
      markdownSupport: account.markdownSupport,
      userAgent: buildUserAgent(account.userAgentSuffix),
      baseUrl: process.env.QQBOT_BASE_URL?.replace(/\/+$/, '') || 'https://api.sgroup.qq.com',
      tokenBaseUrl: process.env.QQBOT_TOKEN_BASE_URL?.replace(/\/+$/, '') || 'https://bots.qq.com',
      transport: account.config.transport,
      webhook: isWebhook ? { path: account.config.webhook?.path, server: createPluginWebhookAdapter({ account, log: this.log }) } : undefined,
      sessionPersistence: kvSessionPersistence({
        store: new FileKVStore({ dir: dataDir, fileName: 'session.json' }),
        accountId: account.accountId,
      }),
      tokenPrefetch: 'sync',
      logger: this.log,
    });

    // 包装 sendText/sendMedia，回复后自动写入 ref-index store
    this.wrapBotSendForRefIndex();

    // concurrencyGuard 已移除，消息不再在此处合并
    // 所有消息都直接走完中间件链，由 bot.on('message') 处理转发
    // 并发控制由 OpenClaw 框架的 session lane 机制处理
    setupMiddlewares(this.bot, account, {
      getRuntime: () => runtime,
    });
  }

  async start(callbacks?: GatewayCallbacks, signal?: AbortSignal): Promise<void> {
    const handleReady = () => {
      this.log.info(`Gateway ready`);
      callbacks?.onReady?.();
    };
    this.bot.on(`ready`, handleReady);
    this.bot.on(`resumed`, handleReady);


    this.bot.on('error', (err: Error) => {
      this.log.error(`Gateway error: ${err.message}`);
      callbacks?.onError?.(err);
    });

    const gatewayLog = this.log.child('gateway');

    this.bot.on('message', async (ctx: MiddlewareContext, msg: QQBotInboundMessage) => {
      gatewayLog.debug(`message msgId=${msg.messageId}`);
      try {
        await handleMessage(ctx, msg, this.account, this.runtime, this.log);
      } catch (err) {
        gatewayLog.error(`Dispatch error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.bot.on('interaction', (_ctx, event: InteractionEvent) => {
      handleInteraction(event, this.account, this.runtime, this.log, (id, code, data) =>
        this.bot.acknowledgeInteraction(id, code, data),
      ).catch((err) => {
        this.log.error(`Interaction error: ${err}`);
      });
    });

    // 平台原始事件观测：一切未被 SDK 映射为 message/interaction 的推送
    // （入群申请、好友变动、reaction、media_upload_finish、未来新增类型）
    // 都走这里 —— 此前被静默丢弃，是入站诊断的主要盲区
    this.bot.on('rawEvent', (evt: { eventType?: string; data?: unknown }) => {
      let preview = '{}';
      try {
        preview = JSON.stringify(evt?.data ?? {});
      } catch {
        preview = '<unserializable>';
      }
      if (preview.length > 300) preview = `${preview.slice(0, 300)}…`;
      this.log.info(`[rawEvent] t=${evt?.eventType ?? '?'} payload=${preview}`);
    });

    await this.bot.start(signal);
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async sendText(target: ReplyTarget, text: string, opts?: SendOptions): Promise<MessageResponse> {
    const { target: resolved, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolved.msgId) recordProactiveSend(this.account.accountId);
    try {
      const result = await withTimeout(
        this.bot.sendText(resolved, text),
        this.textTimeout, 'sendText',
      );
      this.notifyTypingRefresh(target);
      return result;
    } catch (err) {
      rollback();
      throw err;
    }
  }

  async sendMedia(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileType?: MediaFileType },
  ): Promise<MessageResponse> {
    const { target: resolvedTarget, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolvedTarget.msgId) recordProactiveSend(this.account.accountId);
    const fileType = opts?.fileType ?? MediaFileType.IMAGE;
    const sourceOpts = resolveMediaSource(source);
    try {
      const result = await withTimeout(
        this.bot.sendMedia({ target: resolvedTarget, fileType, ...sourceOpts, content: opts?.text }),
        this.mediaTimeout, 'sendMedia',
      );
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      rollback();
      throw err;
    }
  }

  async sendVoice(
    target: ReplyTarget,
    source: { url?: string; base64?: string; localPath?: string },
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const { target: resolvedTarget, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolvedTarget.msgId) recordProactiveSend(this.account.accountId);

    const send = (params: Record<string, unknown>, label: string) =>
      withTimeout(
        this.bot.sendMedia({
          target: resolvedTarget,
          fileType: MediaFileType.VOICE,
          ...params,
          content: opts?.text,
        } as any),
        this.mediaTimeout, label,
      );
    try {
      let result: { message?: MessageResponse };
      if (source.base64) {
        result = await send({ fileData: source.base64 }, 'sendVoice(base64)');
      } else if (source.localPath) {
        result = await send({ localPath: source.localPath }, 'sendVoice(path)');
      } else {
        result = await send({ url: source.url! }, 'sendVoice(url)');
      }
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      rollback();
      throw err;
    }
  }

  async sendVideo(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const { target: resolvedTarget, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolvedTarget.msgId) recordProactiveSend(this.account.accountId);
    const sourceOpts = resolveMediaSource(source);
    try {
      const result = await withTimeout(
        this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.VIDEO, ...sourceOpts, content: opts?.text }),
        this.mediaTimeout, 'sendVideo',
      );
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      rollback();
      throw err;
    }
  }

  async sendFile(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileName?: string },
  ): Promise<MessageResponse> {
    const { target: resolvedTarget, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolvedTarget.msgId) recordProactiveSend(this.account.accountId);
    const sourceOpts = resolveMediaSource(source);
    try {
      const result = await withTimeout(
        this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.FILE, ...sourceOpts, fileName: opts?.fileName, content: opts?.text }),
        this.mediaTimeout, 'sendFile',
      );
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      rollback();
      throw err;
    }
  }

  openStream(target: ReplyTarget, msgId: string): StreamSession {
    return this.bot.openStream({
      target: { ...target, msgId },
    });
  }

  async sendTyping(target: ReplyTarget): Promise<void> {
    await this.bot.sendTyping(target);
  }

  /**
   * 消息发送成功后通知活跃的 typing 会话补发续期。
   * QQ 客户端收到机器人消息（含思维链等中间输出）会终止"正在输入"
   * 显示；若框架任务仍在进行，typing 中间件会在 5s 后补发恢复显示。
   */
  private notifyTypingRefresh(target: ReplyTarget): void {
    notifyOutboundMessageSent(this.account.accountId, target.scope, target.targetId);
  }

  private wrapBotSendForRefIndex(): void {
    const { accountId, appId } = this.account;
    const senderName = this.account.config.name ?? appId;

    const storeEntry = (msg: MessageResponse, content: string, target: { scope: string; targetId?: string }, mediaKind?: string): void => {
      // 出站 id 先登记回声表（不依赖 ext_info.ref_idx 是否返回），
      // 供 inboundGuard 识别平台回投的 bot 自身消息
      recordOutboundMessageId(accountId, msg.id);

      // 修复运算符优先级问题：当 content 非空时直接使用，否则回退到媒体标签
      let finalContent = content;
      if (!content && mediaKind) {
        finalContent = mediaKind === 'voice' ? '[语音]'
          : mediaKind === 'image' ? '[图片]'
          : mediaKind === 'video' ? '[视频]'
          : mediaKind === 'file' ? '[文件]'
          : `[${mediaKind}]`;
      }

      // rolling 历史模式：群出站记入 historyBuffer（isBot 标记，
      // 供"裁剪到最后一条 bot 发言"定位；historyLimit=0 或 room_event 群
      // ——上下文以框架 transcript 为准——时 no-op）
      if (
        target.scope === 'group' &&
        target.targetId &&
        resolveGroupConfigFromAccount(this.account, target.targetId).unmentionedInbound !== 'room_event'
      ) {
        recordOutboundToGroupHistory(accountId, target.targetId, {
          messageId: msg.id,
          senderId: appId,
          senderName,
          content: finalContent || '[消息]',
        }, resolveGroupConfigFromAccount(this.account, target.targetId).historyLimit);
      }

      const refIdx = msg.ext_info?.ref_idx;
      if (!refIdx) return;

      const entry = {
        messageId: msg.id, content: finalContent, senderId: appId, senderName,
        timestamp: typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString() : msg.timestamp,
        isBot: true, scope: target.scope,
      };
      getPersistedRefIndexStore(accountId).set(refIdx, entry as any);
    };

    // sendText → 直接捕获 text content
    const origSendText = this.bot.sendText.bind(this.bot);
    this.bot.sendText = async (target, text, ...rest) => {
      const result = await origSendText(target, text, ...rest);
      storeEntry(result, text, target);
      return result;
    };

    // sendMedia → ext_info 在 result.message 里
    const origSendMedia = this.bot.sendMedia.bind(this.bot);
    this.bot.sendMedia = async (params: any) => {
      const result = await origSendMedia(params);
      const msg = (result as any).message as MessageResponse | undefined;
      if (msg) storeEntry(msg, '', params.target ?? { scope: '' }, params.mediaKind);
      return result;
    };

    // openStream → 流式消息 complete() 时才返回 ext_info.ref_idx
    const origOpenStream = this.bot.openStream.bind(this.bot);
    this.bot.openStream = (opts) => {
      const session = origOpenStream(opts);
      let lastContent = '';
      const origUpdate = session.update.bind(session);
      session.update = async (content: string) => {
        lastContent = content;
        return origUpdate(content);
      };
      const origComplete = session.complete.bind(session);
      session.complete = async (): Promise<any> => {
        const result = await origComplete();
        recordOutboundMessageId(accountId, result?.id);
        if (result?.ext_info?.ref_idx) {
          getPersistedRefIndexStore(accountId).set(result.ext_info.ref_idx, {
            messageId: result.id, content: lastContent, senderId: appId, senderName,
            timestamp: typeof result.timestamp === 'number' ? new Date(result.timestamp).toISOString() : result.timestamp,
            isBot: true, scope: opts.target?.scope ?? '',
          } as any);
        }
        return result;
      };
      return session;
    };
  }

  /**
   * 配额感知的 msg_id 挂接（被动优先）。
   *
   * - 显式 msgId（opts.msgId）：上游 adapter 已做配额记账（quotaReserved），
   *   直接透传，不重复消费。
   * - 无显式 msgId：尝试挂 msgid-cache 最新条目；挂接前经 quota-manager
   *   原子预检+扣减——配额耗尽则不挂（降级主动，避免平台 40034128 硬失败），
   *   API 抛错时由调用方 rollback 释放已扣减的额度。
   */
  private attachMsgIdWithQuota(
    target: ReplyTarget,
    opts?: SendOptions,
  ): { target: ReplyTarget; rollback: () => void } {
    if (opts?.msgId) {
      return { target: { ...target, msgId: opts.msgId }, rollback: () => {} };
    }
    const cached = getCachedMsgId(target.scope, target.targetId);
    if (!cached) return { target, rollback: () => {} };

    const reservation = checkAndConsumePassiveReplyQuota({
      accountId: this.account.accountId,
      msgId: cached,
      scope: target.scope,
    });
    if (!reservation.canReply) {
      // INFO：降级主动消耗每日预算，是出站行为的可观测分界点
      this.log.info?.(`[quota] passive quota exhausted for msgId=${cached}; falling back to proactive send`);
      return { target, rollback: () => {} };
    }
    return { target: { ...target, msgId: cached }, rollback: reservation.rollback };
  }
}

function resolveMediaSource(source: string): { url?: string; localPath?: string; fileData?: string } {
  if (source.startsWith('data:')) {
    const commaIdx = source.indexOf(',');
    if (commaIdx > 0) {
      return { fileData: source.slice(commaIdx + 1) };
    }
    return { fileData: source };
  }
  if (source.startsWith('http://') || source.startsWith('https://')) {
    return { url: source };
  }
  if (source.startsWith('file://')) {
    let p = source.slice('file://'.length);
    if (/^\/[a-zA-Z]:[\\/]/.test(p)) p = p.slice(1);
    try { p = decodeURIComponent(p); } catch {}
    return { localPath: p };
  }
  if (source === '~' || source.startsWith('~/') || source.startsWith('~\\')) {
    return { localPath: source.replace(/^~/, os.homedir()) };
  }
  if (
    source.startsWith('/') ||
    source.startsWith('./') || source.startsWith('../') ||
    source.startsWith('.\\') || source.startsWith('..\\') ||
    /^[a-zA-Z]:[\\/]/.test(source) ||
    source.startsWith('\\\\')
  ) {
    return { localPath: source };
  }
  return { url: source };
}
