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
      replyToId: envelope.messageId,
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
      quote: envelope.quote
        ? { id: envelope.messageId, body: envelope.quote.content, sender: envelope.quote.senderId }
        : undefined,
      groupSystemPrompt: envelope.systemPrompt,
    },
    extra: {
      ...(isSlashCommand ? { CommandSource: 'text' } : {}),
      ...(groupId ? { QQGroupOpenid: groupId } : {}),
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
