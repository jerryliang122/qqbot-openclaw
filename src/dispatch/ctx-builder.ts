/**
 * ctxPayload 构建器
 *
 * 与内置版 outbound-dispatch.ts:buildCtxPayload 对齐，
 * 将 SDK 消息数据转换为 OpenClaw 框架标准的入站上下文。
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import type { AssembledBody } from './body-assembler.js';
import type { OpenClawInboundMessage } from './envelope-builder.js';
import type { RuntimeAdapters } from '../adapter/resolve.js';

export interface CtxPayloadParams {
  assembled: AssembledBody;
  envelope: OpenClawInboundMessage;
  route: { sessionKey: string; accountId: string; agentId?: string };
  msg: QQBotInboundMessage;
  ctx: MiddlewareContext;
  adapters: RuntimeAdapters;
}

export function buildCtxPayload(params: CtxPayloadParams): any {
  const { assembled, envelope, route, msg, ctx, adapters } = params;

  const isSlashCommand = /^\//.test(assembled.rawBody ?? '');
  const convKind = envelope.chatScope === 'group' ? 'group' : 'direct';
  const peerId = convKind === 'group'
    ? (envelope.groupId ?? envelope.senderId)
    : envelope.senderId;
  const groupId = convKind === 'group' ? envelope.groupId : undefined;

  const processed = ctx.state.processedAttachments as any;

  /**
   * 正规媒体通道（对齐 core ChannelInboundMediaInput）：
   * 全部附件（图片/语音/文件）按原始顺序作为 media facts 传入，
   * 字段名必须是 path（不是 localPath）；url 用本地路径（QQ CDN URL 有时效），
   * 与 telegram toInboundMedia 的 { path, url: path, contentType, kind, transcribed } 一致。
   * media facts 经 core 归一化后生成 MediaPath/MediaPaths/MediaTypes/MediaTranscribedIndexes。
   */
  const mediaFacts = (processed?.media as Array<{
    kind: 'image' | 'audio' | 'video' | 'document';
    localPath?: string;
    remoteUrl?: string;
    contentType?: string;
    transcribed?: boolean;
  }> | undefined)?.map((m) => ({
    kind: m.kind,
    ...(m.localPath
      ? { path: m.localPath, url: m.localPath }
      : m.remoteUrl
        ? { url: m.remoteUrl }
        : {}),
    ...(m.contentType ? { contentType: m.contentType } : {}),
    ...(m.transcribed ? { transcribed: true } : {}),
  })) ?? [];

  const msgTimestamp = (msg as any).timestamp ?? (msg as any).Timestamp;

  // 群成员角色（平台 member_role：admin/owner）→ sender.roles，
  // 供框架群权限/工具策略分级使用；c2c / 未标注为空
  const memberRole = (msg as { raw?: { author?: { member_role?: string } } }).raw?.author?.member_role;
  const senderRoles = memberRole === 'admin' || memberRole === 'owner' ? [memberRole] : undefined;

  return adapters.buildInboundContext?.({
    channel: 'qqbot',
    accountId: route.accountId,
    provider: 'qqbot',
    surface: 'qqbot',
    messageId: envelope.messageId,
    timestamp: msgTimestamp ? new Date(msgTimestamp).getTime() : Date.now(),
    from: envelope.targetId,
    sender: { id: envelope.senderId, name: envelope.senderName, ...(senderRoles ? { roles: senderRoles } : {}) },
    conversation: {
      kind: convKind,
      id: peerId,
      label: assembled.systemPrompt,
    },
    message: {
      body: assembled.webBody,
      bodyForAgent: assembled.agentBody,
      rawBody: assembled.rawBody,
      commandBody: assembled.rawBody,
    },
    route: {
      agentId: route.agentId ?? 'default',
      routeSessionKey: route.sessionKey,
      accountId: route.accountId,
    },
    reply: {
      to: envelope.targetId,
      /**
       * ReplyToId 契约语义 = 当前消息回复(引用)的那条消息的 ID —— 对齐
       * telegram 原生通道（replyHead?.messageId ?? visibleReplyTarget?.id），
       * 无引用时必须为 undefined。框架将其渲染为模型可见 Conversation info
       * 的 reply_to_id 字段。
       *
       * 历史版本误填 envelope.messageId（消息自身 ID），导致每条消息都呈现
       * message_id == reply_to_id —— 被上层 agent 的 AGENTS 规则判为「内部
       * 回灌、非新指令」而拒绝响应（2026-09-22 事故）。
       *
       * QQ 被动回复锚点不依赖此字段：deliverCtx.replyToId 显式透传 /
       * 网关 attachMsgIdWithQuota 旧配额优先选取均独立取值，
       * threading resolveReplyToMode='off' 阻断框架隐式回复线程。
       *
       * 防御守卫：即使上游异常传入当前消息 ID（自引用），也强制置空——
       * 「reply_to_id == message_id」这一假回灌签名在任何路径都不允许再现。
       */
      replyToId: envelope.quote?.messageId && envelope.quote.messageId !== envelope.messageId
        ? envelope.quote.messageId
        : undefined,
      originatingTo: envelope.targetId,
    },
    access: {
      commands: { authorized: isSlashCommand },
    },
    command: isSlashCommand
      ? { kind: 'text-slash' as const, body: assembled.rawBody!, authorized: true }
      : undefined,
    media: mediaFacts.length > 0 ? mediaFacts : undefined,
    supplemental: {
      // quote.id 同样必须是「被引用消息」的真实 ID（ref-index 命中时），
      // 而非当前消息 ID——框架经 applySupplementalContext 映射为
      // ctx.ReplyToId / "Reply target of current user message"。
      quote: envelope.quote
        ? {
            ...(envelope.quote.messageId && envelope.quote.messageId !== envelope.messageId
              ? { id: envelope.quote.messageId }
              : {}),
            body: envelope.quote.content,
            sender: envelope.quote.senderId,
          }
        : undefined,
      groupSystemPrompt: envelope.systemPrompt,
    },
    extra: {
      ...(isSlashCommand ? { CommandSource: 'text' } : {}),
      ...(groupId ? { QQGroupOpenid: groupId } : {}),
      // ── room_event 环境行的 transcript 正文（2026-10-23）──
      // 框架默认把 room_event 的 transcript 正文渲染成
      // `#<messageId> <sender>: <body>`（core 的 formatRoomEventLine）——
      // 消息 id 与正文被合并成一行，Web UI 上表现为群消息正文头部带
      // `#ROBOT1.0_<id>! ` 前缀。id 在平台层与正文本是分开的（id 是事件体
      // 的 `id` 字段 / 被动回复锚点 msg_id），不该混进正文。
      //
      // 框架的 resolveRoomEventTranscriptBody 优先取 ctx.AmbientTranscriptBody
      // （再退到 formatRoomEventLine），且 ctxPayload 的 extra 会被框架
      // 展开进 ctx（core 的 buildChannelInboundEventContextValue 末尾
      // `...params.extra`）——插件据此**覆盖**该行的格式，不做入站剥离
      // （入站 content 里本来就没有这个前缀，剥了是剥错地方）。
      // 合批时 assembled.agentBody 已是合并正文（逐条归属 + 单份历史），
      // 无需额外处理。
      ...(groupId
        ? {
            AmbientTranscriptBody: assembled.agentBody,
            AmbientTranscriptMessageId: envelope.messageId,
            AmbientTranscriptTimestampMs: msgTimestamp ? new Date(msgTimestamp).getTime() : Date.now(),
          }
        : {}),
      ...(processed?.localMediaPaths?.length
        ? {
            MediaPaths: processed.localMediaPaths,
            MediaPath: processed.localMediaPaths[0],
            MediaTypes: processed.localMediaTypes,
            MediaType: processed.localMediaTypes?.[0],
          }
        : {}),
      ...(processed?.remoteMediaUrls?.length
        ? {
            MediaUrls: processed.remoteMediaUrls,
            MediaUrl: processed.remoteMediaUrls[0],
          }
        : {}),
    },
  });
}
