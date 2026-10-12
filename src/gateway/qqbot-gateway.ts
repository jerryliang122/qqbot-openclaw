/**
 * QQBotGateway — 封装单个 Bot 实例的完整生命周期
 */
import {
  QQBot,
  ApiError,
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
import { checkAndConsumePassiveReplyQuota, invalidateMsgIdQuota } from '../features/quota-manager.js';
import { recordProactiveSend } from '../features/proactive-budget.js';
import { selectMsgIdForPassiveReply, evictMsgId, peekMsgIdReceivedAt } from '../features/msgid-cache.js';
import { notifyOutboundMessageSent } from '../features/typing-refresh.js';

export interface GatewayCallbacks {
  onReady?: () => void;
  onError?: (error: Error) => void;
}

export interface SendOptions {
  msgId?: string;
  /** 显式锚点链透传的被动回复序号（quotaReserved 链已在上游发号） */
  msgSeq?: number;
  /**
   * 只走被动（progress card 等非正文消息）：死锚点被平台确定性拒绝时
   * 剔除锚点后**原错误上抛、不转主动重发**——上游按 passiveOnly 语义
   * 丢弃（绝不烧每日主动预算）。无显式 msgId 时预留阶段已拦截，不会到网关。
   */
  passiveOnly?: boolean;
  text?: string;
}

/**
 * 「锚点失效」平台业务码集合——均为**确定性拒绝**（内容未投递，主动重发
 * 无重复风险），触发死锚点剔除 + 同内容转主动重发一次：
 * - 40034005：回复消息 msg_id 已过期
 * - 40034128：回复次数超限（本仓库历史事故记载的硬失败码）
 * 线上发现其他确定性未投递的平台码加入本集合即可。网络/超时
 * （httpStatus===0，结果不明）与其他业务码不重发。
 */
const ANCHOR_DEAD_CODES = new Set<number>([40034005, 40034128]);

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
    const { target: resolved, msgSeq, rollback } = this.attachMsgIdWithQuota(target, opts);
    if (!resolved.msgId) recordProactiveSend(this.account.accountId);
    try {
      const result = await withTimeout(
        resolved.msgId
          // 被动文本：显式 msg_seq（插件自持单调计数器，替代 SDK 准随机注入）。
          // 等价性：markdownSupport（插件配置默认 true）时传 markdown 字段
          // （msg_type=2），否则 content（msg_type=0）——与 bot.sendText 的
          // buildMessageBody 分支一致；extra.msg_seq 先于 SDK 自动注入合入 body
          ? this.bot.send({
              target: resolved,
              ...(this.account.markdownSupport
                ? { markdown: { content: text } }
                : { content: text }),
              extra: { msg_seq: msgSeq },
            })
          : this.bot.sendText(resolved, text),
        this.textTimeout, 'sendText',
      );
      this.notifyTypingRefresh(target);
      return result;
    } catch (err) {
      const retried = await this.retryOnDeadAnchor(err, {
        target,
        resolved,
        rollback,
        passiveOnly: opts?.passiveOnly,
        retry: () =>
          withTimeout(
            this.bot.sendText({ scope: target.scope, targetId: target.targetId }, text),
            this.textTimeout, 'sendText(proactive-retry)',
          ),
      });
      if (retried) {
        this.notifyTypingRefresh(target);
        return retried;
      }
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
    const send = (dst: ReplyTarget) =>
      withTimeout(
        this.bot.sendMedia({ target: dst, fileType, ...sourceOpts, content: opts?.text }),
        this.mediaTimeout, 'sendMedia',
      );
    try {
      const result = await send(resolvedTarget);
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      const retried = await this.retryOnDeadAnchor(err, {
        target,
        resolved: resolvedTarget,
        rollback,
        passiveOnly: opts?.passiveOnly,
        retry: () => send({ scope: target.scope, targetId: target.targetId }),
      });
      if (retried) {
        this.notifyTypingRefresh(target);
        return retried.message ?? { id: '', timestamp: Date.now() };
      }
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

    const send = (dst: ReplyTarget, label: string) =>
      withTimeout(
        this.bot.sendMedia({
          target: dst,
          fileType: MediaFileType.VOICE,
          ...(source.base64
            ? { fileData: source.base64 }
            : source.localPath
              ? { localPath: source.localPath }
              : { url: source.url! }),
          content: opts?.text,
        } as any),
        this.mediaTimeout, label,
      );
    try {
      const result = await send(resolvedTarget, 'sendVoice');
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      const retried = await this.retryOnDeadAnchor(err, {
        target,
        resolved: resolvedTarget,
        rollback,
        passiveOnly: opts?.passiveOnly,
        retry: () => send({ scope: target.scope, targetId: target.targetId }, 'sendVoice(proactive-retry)'),
      });
      if (retried) {
        this.notifyTypingRefresh(target);
        return retried.message ?? { id: '', timestamp: Date.now() };
      }
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
    const send = (dst: ReplyTarget, label: string) =>
      withTimeout(
        this.bot.sendMedia({ target: dst, fileType: MediaFileType.VIDEO, ...sourceOpts, content: opts?.text }),
        this.mediaTimeout, label,
      );
    try {
      const result = await send(resolvedTarget, 'sendVideo');
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      const retried = await this.retryOnDeadAnchor(err, {
        target,
        resolved: resolvedTarget,
        rollback,
        passiveOnly: opts?.passiveOnly,
        retry: () => send({ scope: target.scope, targetId: target.targetId }, 'sendVideo(proactive-retry)'),
      });
      if (retried) {
        this.notifyTypingRefresh(target);
        return retried.message ?? { id: '', timestamp: Date.now() };
      }
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
    const send = (dst: ReplyTarget, label: string) =>
      withTimeout(
        this.bot.sendMedia({ target: dst, fileType: MediaFileType.FILE, ...sourceOpts, fileName: opts?.fileName, content: opts?.text }),
        this.mediaTimeout, label,
      );
    try {
      const result = await send(resolvedTarget, 'sendFile');
      this.notifyTypingRefresh(target);
      return result.message ?? { id: '', timestamp: Date.now() };
    } catch (err) {
      const retried = await this.retryOnDeadAnchor(err, {
        target,
        resolved: resolvedTarget,
        rollback,
        passiveOnly: opts?.passiveOnly,
        retry: () => send({ scope: target.scope, targetId: target.targetId }, 'sendFile(proactive-retry)'),
      });
      if (retried) {
        this.notifyTypingRefresh(target);
        return retried.message ?? { id: '', timestamp: Date.now() };
      }
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

    // 出站成功的统一 INFO 痕迹：gateway 的 sendText/sendMedia/sendVoice/sendVideo/
    // sendFile 与中间件对 bot.sendText 的直调全部落到这两个被包装的方法上。
    // 此前成功发送在插件层零日志，只能靠 SDK 的 `<<< Status` 状态行倒推。
    const MEDIA_KIND_BY_TYPE = new Map<number, string>([
      [1, 'image'], [2, 'video'], [3, 'voice'], [4, 'file'],
    ]);
    const logTx = (
      kind: string,
      target: { scope?: string; targetId?: string; msgId?: string },
      msg: { id?: string },
      contentLen?: number,
    ): void => {
      this.log.info(
        `[tx] sent kind=${kind} scope=${target.scope ?? '?'} target=${target.targetId ?? '?'}`
        + ` msgId=${msg.id || '-'} passive=${target.msgId ? 'true' : 'false'}`
        + (contentLen !== undefined ? ` contentLen=${contentLen}` : ''),
      );
    };

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
      logTx('text', target, result, text.length);
      storeEntry(result, text, target);
      return result;
    };

    // send（显式 msg_seq 的被动文本路径）→ 与 sendText 同等对待：
    // 不包装会丢失 [tx] 日志、回声登记与 ref-index 记录。
    // 仅处理文本形态（content/markdown）；其他形态（media 等）直接透传。
    const origSend = this.bot.send.bind(this.bot);
    this.bot.send = async (opts) => {
      const result = await origSend(opts);
      if (opts.content !== undefined || opts.markdown) {
        const textContent = opts.content ?? opts.markdown?.content ?? '';
        logTx('text', opts.target, result, textContent.length);
        storeEntry(result, textContent, opts.target);
      }
      return result;
    };

    // sendMedia → ext_info 在 result.message 里
    const origSendMedia = this.bot.sendMedia.bind(this.bot);
    this.bot.sendMedia = async (params: any) => {
      const result = await origSendMedia(params);
      const msg = (result as any).message as MessageResponse | undefined;
      if (msg) {
        logTx(MEDIA_KIND_BY_TYPE.get(params.fileType) ?? 'media', params.target ?? {}, msg);
        storeEntry(msg, '', params.target ?? { scope: '' }, params.mediaKind);
      }
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
   * 配额感知的 msg_id 挂接（被动优先，旧配额优先选取）。
   *
   * - 显式 msgId（opts.msgId）：上游 adapter/service 已做配额记账与发号
   *   （quotaReserved 链），直接透传（msgSeq 一并透传），不重复消费。
   * - 无显式 msgId：selectMsgIdForPassiveReply 按接收时间从旧到新选第一条
   *   「平台窗口未过期 且 剩余额度 > 0」的候选（旧配额先用先耗尽，为最新
   *   消息保留完整额度）；选中后原子消耗并发号 msg_seq。
   * - 无候选/配额耗尽：不挂（降级主动）；API 抛错时由调用方 rollback
   *   释放已扣减的额度。
   */
  private attachMsgIdWithQuota(
    target: ReplyTarget,
    opts?: SendOptions,
  ): { target: ReplyTarget; msgSeq?: number; rollback: () => void } {
    if (opts?.msgId) {
      return { target: { ...target, msgId: opts.msgId }, msgSeq: opts.msgSeq, rollback: () => {} };
    }
    const candidate = selectMsgIdForPassiveReply({
      accountId: this.account.accountId,
      scope: target.scope,
      targetId: target.targetId,
    });
    if (!candidate) return { target, rollback: () => {} };

    const reservation = checkAndConsumePassiveReplyQuota({
      accountId: this.account.accountId,
      msgId: candidate,
      scope: target.scope,
      // 诚实重建：配额条目被容量控制淘汰时按真实接收时刻重建窗口
      receivedAt: peekMsgIdReceivedAt(target.scope, target.targetId, candidate),
    });
    if (!reservation.canReply) {
      // INFO：降级主动消耗每日预算，是出站行为的可观测分界点
      this.log.info?.(`[quota] passive quota exhausted for msgId=${candidate}; falling back to proactive send`);
      return { target, rollback: () => {} };
    }
    return { target: { ...target, msgId: candidate }, msgSeq: reservation.seq, rollback: reservation.rollback };
  }

  /**
   * 锚点失效兜底：被动发送被平台以 40034005（msg_id 已过期）/40034128
   * （回复次数超限）**确定性拒绝**（内容未投递）时——剔除死锚点、回滚配额
   * 计数、同内容转主动重发一次（烧每日预算，记账）。
   *
   * 返回 null 表示非兜底场景（调用方 rollback 后照常上抛）；重发失败直接
   * 抛出重发错误交上层既有处理（主动路径无 msg_id，不可能再触发同码）。
   * 网络/超时（httpStatus===0，结果不明，重发有重复风险）与其他业务码
   * （内容超长等，重发必然同错）不做兜底。
   *
   * passiveOnly（progress card 等非正文消息）：死锚点同样剔除（防后续
   * 选取再撞），但**不转主动重发、不计每日预算**——原错误上抛，由上游
   * 按「发送失败=丢弃」处理。注意此时直接 throw 而非 return null，跳过
   * 调用方 catch 尾部的 rollback()（rollback 已在本方法内执行过一次）。
   */
  private async retryOnDeadAnchor<T>(
    err: unknown,
    params: {
      target: ReplyTarget;
      resolved: ReplyTarget;
      rollback: () => void;
      passiveOnly?: boolean;
      retry: () => Promise<T>;
    },
  ): Promise<T | null> {
    const { target, resolved, rollback, passiveOnly, retry } = params;
    const anchorDead = err instanceof ApiError && ANCHOR_DEAD_CODES.has(err.bizCode ?? -1);
    if (!anchorDead || !resolved.msgId) return null;

    rollback();
    evictMsgId(target.scope, target.targetId, resolved.msgId);
    invalidateMsgIdQuota({
      accountId: this.account.accountId,
      msgId: resolved.msgId,
      scope: target.scope,
    });
    if (passiveOnly) {
      this.log.warn?.(
        `[quota] passive anchor rejected by platform (code=${err.bizCode}) msgId=${resolved.msgId}; evicted, passiveOnly — dropping without proactive retry`,
      );
      throw err;
    }
    this.log.warn?.(
      `[quota] passive anchor rejected by platform (code=${err.bizCode}) msgId=${resolved.msgId}; evicted, retrying proactively`,
    );
    recordProactiveSend(this.account.accountId);
    return retry();
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
