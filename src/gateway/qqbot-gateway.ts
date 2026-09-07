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
    const result = await withTimeout(
      this.bot.sendText(attachMsgId(target, opts), text),
      this.textTimeout, 'sendText',
    );
    this.notifyTypingRefresh(target);
    return result;
  }

  async sendMedia(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileType?: MediaFileType },
  ): Promise<MessageResponse> {
    const resolvedTarget = attachMsgId(target, opts);
    const fileType = opts?.fileType ?? MediaFileType.IMAGE;
    const sourceOpts = resolveMediaSource(source);
    const result = await withTimeout(
      this.bot.sendMedia({ target: resolvedTarget, fileType, ...sourceOpts, content: opts?.text }),
      this.mediaTimeout, 'sendMedia',
    );
    this.notifyTypingRefresh(target);
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendVoice(
    target: ReplyTarget,
    source: { url?: string; base64?: string; localPath?: string },
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const resolvedTarget = attachMsgId(target, opts);

    if (source.base64) {
      const result = await withTimeout(
        this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.VOICE, fileData: source.base64, content: opts?.text }),
        this.mediaTimeout, 'sendVoice(base64)',
      );
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    }
    if (source.localPath) {
      const result = await withTimeout(
        this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.VOICE, localPath: source.localPath, content: opts?.text }),
        this.mediaTimeout, 'sendVoice(path)',
      );
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    }
    const result = await withTimeout(
      this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.VOICE, url: source.url!, content: opts?.text }),
      this.mediaTimeout, 'sendVoice(url)',
    );
    this.notifyTypingRefresh(target);
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendVideo(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions,
  ): Promise<MessageResponse> {
    const resolvedTarget = attachMsgId(target, opts);
    const sourceOpts = resolveMediaSource(source);
    const result = await withTimeout(
      this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.VIDEO, ...sourceOpts, content: opts?.text }),
      this.mediaTimeout, 'sendVideo',
    );
    this.notifyTypingRefresh(target);
    return result.message ?? { id: '', timestamp: Date.now() };
  }

  async sendFile(
    target: ReplyTarget,
    source: string,
    opts?: SendOptions & { fileName?: string },
  ): Promise<MessageResponse> {
    const resolvedTarget = attachMsgId(target, opts);
    const sourceOpts = resolveMediaSource(source);
    const result = await withTimeout(
      this.bot.sendMedia({ target: resolvedTarget, fileType: MediaFileType.FILE, ...sourceOpts, fileName: opts?.fileName, content: opts?.text }),
      this.mediaTimeout, 'sendFile',
    );
    this.notifyTypingRefresh(target);
    return result.message ?? { id: '', timestamp: Date.now() };
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

    const storeEntry = (msg: MessageResponse, content: string, scope: string, mediaKind?: string): void => {
      // 出站 id 先登记回声表（不依赖 ext_info.ref_idx 是否返回），
      // 供 inboundGuard 识别平台回投的 bot 自身消息
      recordOutboundMessageId(accountId, msg.id);
      const refIdx = msg.ext_info?.ref_idx;
      if (!refIdx) return;
      
      // 修复运算符优先级问题：当 content 非空时直接使用，否则回退到媒体标签
      let finalContent = content;
      if (!content && mediaKind) {
        finalContent = mediaKind === 'voice' ? '[语音]'
          : mediaKind === 'image' ? '[图片]'
          : mediaKind === 'video' ? '[视频]'
          : mediaKind === 'file' ? '[文件]'
          : `[${mediaKind}]`;
      }
      const entry = {
        messageId: msg.id, content: finalContent, senderId: appId, senderName,
        timestamp: typeof msg.timestamp === 'number' ? new Date(msg.timestamp).toISOString() : msg.timestamp,
        isBot: true, scope,
      };
      getPersistedRefIndexStore(accountId).set(refIdx, entry as any);
    };

    // sendText → 直接捕获 text content
    const origSendText = this.bot.sendText.bind(this.bot);
    this.bot.sendText = async (target, text, ...rest) => {
      const result = await origSendText(target, text, ...rest);
      storeEntry(result, text, target.scope);
      return result;
    };

    // sendMedia → ext_info 在 result.message 里
    const origSendMedia = this.bot.sendMedia.bind(this.bot);
    this.bot.sendMedia = async (params: any) => {
      const result = await origSendMedia(params);
      const msg = (result as any).message as MessageResponse | undefined;
      if (msg) storeEntry(msg, '', params.target?.scope ?? '', params.mediaKind);
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
}

function attachMsgId(target: ReplyTarget, opts?: SendOptions): ReplyTarget {
  if (opts?.msgId) return { ...target, msgId: opts.msgId };
  // 无显式 msgId 时尝试从缓存获取
  const cached = getCachedMsgId(target.scope, target.targetId);
  return cached ? { ...target, msgId: cached } : target;
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
