/**
 * 持久化入站载荷（群聊）：可序列化的入站快照 + 中间件上下文重建。
 *
 * ## 为什么需要它
 *
 * 群聊入站改成持久化队列后，消息要**先落盘、再处理**。落盘的东西必须
 * 是纯数据（不能持有 bot / log / AbortSignal 这类活对象），而 dispatch
 * 与正文装配器读的是**中间件上下文**（`ctx.state.*` + `msg.*`）。
 *
 * 本模块负责两侧的转换：
 * - `buildIngressPayload`：活上下文 → 纯数据快照（入队时调用）
 * - `rebuildIngressMember`：纯数据快照 → 最小可用的 ctx/msg（claim 时调用）
 *
 * ## ctx 重建面（已逐项核对，勿随意扩大）
 *
 * `dispatch.ts` 只读 `ctx.state.roomEventPolicy` / `ctx.state.assembledBody`
 * / `ctx.state.mention` / `ctx.state.mentionPatterns` / `ctx.state.nameMentioned`
 * / `ctx.signal`；`ctx-builder.ts` 只读 `ctx.state.processedAttachments`；
 * `assembleMergedGroupBody` 经 `buildMemberLayers` 读
 * `ctx.state.mention` / `nameMentioned` / `mentionPatterns` /
 * `processedAttachments` / `quote` / `history` + `ctx.message.content`
 * + `msg.{content,kind,msgElements,senderId,senderName,timestamp,replyTarget}`。
 *
 * 上述字段全部在本模块的载荷里 ⇒ **无需重跑中间件链**即可复现原行为。
 *
 * @see features/ingress-queue.ts 持久化队列与 drain 生命周期
 * @see features/ingress-batcher.ts 组批与幂等
 */

import type { HistoryEntry, QQBotInboundMessage, ResolvedQuote } from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import type { AssembledBody } from '../dispatch/body-assembler.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { isBypassGroupItem } from './group-merge.js';
import type { RoomEventPolicy } from './room-event.js';

/** 载荷版本。**不认识的版本一律判为不可重试**（避免无限重投打转） */
export const INGRESS_PAYLOAD_VERSION = 1;

/** 群消息的入站快照（纯数据，可 JSON 序列化） */
export interface QQBotIngressPayload {
  /** 载荷版本 */
  v: number;
  /** 账号 id */
  accountId: string;
  /** 群 openid */
  groupOpenid: string;
  /** 平台消息 id（**被动回复锚点**） */
  messageId: string;
  /** 发送者 openid */
  senderId: string;
  /** 发送者昵称 */
  senderName?: string;
  /** 平台原始事件类型 */
  rawEventType: string;
  /** 清洗后的正文（对应 `ctx.message.content`） */
  content: string;
  /** 平台原始正文（对应 `msg.content`） */
  rawContent: string;
  /** 平台事件时间戳（**仅留档，不用于排序**——客户端时钟不可信） */
  platformTimestamp: string;
  /** 本地到达时刻（**排序权威来源**） */
  receivedAtMs: number;
  /** @ 列表 */
  mentions?: unknown;
  /** 平台原始 msg_elements（引用上下文） */
  msgElements?: unknown;
  /** 平台附件元数据（媒体 rehydrate 用） */
  attachments?: unknown;
  /** 引用消息信息 */
  quote?: ResolvedQuote;
  /** 附件处理结果（localMediaPaths 为 best-effort，可能已失效） */
  processedAttachments?: ProcessedAttachments;
  /** 已装配好的正文（中间件链产出；dispatch 直接消费） */
  assembledBody?: AssembledBody;
  /** envelopeFormatter 输出的字符串（buildEnvelope 用；当前无消费方，留作保真） */
  envelope?: string;
  /** @ 判定 */
  mention: { wasMentioned: boolean; implicit: boolean };
  /** 称呼唤醒判定 */
  nameMentioned: boolean;
  /** 唤醒词模式 */
  mentionPatterns?: string[];
  /** 群历史快照（批前基线） */
  history?: HistoryEntry[];
  /** 房间事件策略裁决结果（dispatch 的分类依据） */
  roomEventPolicy?: RoomEventPolicy;
  /**
   * 旁路项：**不参与合批**，必须单独成轮。
   *
   * 判定在**入队时**做（与改造前的内存路径同款口径、同时机）：
   * - 斜杠命令（合并会破坏命令标记）
   * - 控制命令（stop/esc/abort/exit 等）
   * - 多问题 ask_user 的 keyed 答案文本（合并会改写答案、认领失败）
   * - stt/fallback 来源语音（真实音频语义，独立成轮）
   *
   * 判定结果冻结进载荷：合批发生在 claim 之后，那时已读不到活状态。
   */
  bypass?: boolean;
}

/** 载荷解码失败的原因 */
export type IngressPayloadDecodeError = 'malformed' | 'unsupported_version';

/** 从活上下文构建入站快照。 */
export function buildIngressPayload(params: {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  accountId: string;
  groupOpenid: string;
  /** 本地到达时刻（默认取当前时间） */
  receivedAtMs?: number;
  /** 框架配置快照（控制命令判定用） */
  cfg?: Record<string, unknown>;
}): QQBotIngressPayload {
  const { ctx, msg, accountId, groupOpenid } = params;
  const state = ctx.state as Record<string, unknown>;
  const mentionState = (state.mention ?? {}) as { wasMentioned?: boolean; implicit?: boolean };
  const msgView = msg as unknown as Record<string, unknown>;

  return {
    v: INGRESS_PAYLOAD_VERSION,
    accountId,
    groupOpenid,
    messageId: msg.messageId,
    senderId: msg.senderId,
    senderName: msg.senderName,
    rawEventType: String(msgView.rawEventType ?? ''),
    content: String((ctx.message as { content?: unknown } | undefined)?.content ?? ''),
    rawContent: String(msgView.content ?? ''),
    platformTimestamp: String(msgView.timestamp ?? ''),
    receivedAtMs: params.receivedAtMs ?? Date.now(),
    mentions: msgView.mentions,
    msgElements: msgView.msgElements,
    attachments: msgView.attachments,
    quote: state.quote as ResolvedQuote | undefined,
    processedAttachments: state.processedAttachments as ProcessedAttachments | undefined,
    assembledBody: state.assembledBody as AssembledBody | undefined,
    envelope: typeof state.envelope === 'string' ? state.envelope : undefined,
    mention: {
      wasMentioned: mentionState.wasMentioned === true,
      implicit: mentionState.implicit === true,
    },
    nameMentioned: (state.nameMentioned as boolean | undefined) === true,
    mentionPatterns: state.mentionPatterns as string[] | undefined,
    history: state.history as HistoryEntry[] | undefined,
    roomEventPolicy: state.roomEventPolicy as RoomEventPolicy | undefined,
    bypass: isBypassGroupInbound({
      ctx,
      msg,
      accountId: params.accountId,
      groupOpenid: params.groupOpenid,
      cfg: params.cfg,
    }),
  };
}

/**
 * 该条群消息是否**旁路**（不参与合批，必须单独成轮）。
 *
 * 判定口径**共用**内存合批路径的实现（features/group-merge.ts 的
 * isBypassGroupItem）——两处各写一份必然漂移。
 *
 * ⚠️ 判定必须在**入队时**做：合批发生在 claim 之后，那时读不到活状态
 * （pending question store 是进程内的、附件是活对象）。
 */
function isBypassGroupInbound(params: {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  accountId: string;
  groupOpenid: string;
  cfg?: Record<string, unknown>;
}): boolean {
  return isBypassGroupItem({ ...params, cfg: params.cfg });
}

/**
 * 解码载荷。
 *
 * **版本不认识的载荷不重试**：它是不可恢复的（重投多少次都不会变），
 * 让它在重试队列里打转只会拖垮 drain。调用方应据此判为不可重试失败。
 */
export function decodeIngressPayload(raw: unknown): {
  ok: true;
  payload: QQBotIngressPayload;
} | {
  ok: false;
  error: IngressPayloadDecodeError;
  reason: string;
} {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'malformed', reason: '载荷不是对象' };
  }
  const view = raw as Record<string, unknown>;
  const version = typeof view.v === 'number' ? view.v : Number.NaN;
  if (!Number.isFinite(version)) {
    return { ok: false, error: 'malformed', reason: '载荷缺少版本号' };
  }
  if (version !== INGRESS_PAYLOAD_VERSION) {
    return {
      ok: false,
      error: 'unsupported_version',
      reason: `载荷版本 ${version} 不受支持（当前支持 ${INGRESS_PAYLOAD_VERSION}）`,
    };
  }
  if (typeof view.messageId !== 'string' || typeof view.groupOpenid !== 'string') {
    return { ok: false, error: 'malformed', reason: '载荷缺少 messageId / groupOpenid' };
  }
  return { ok: true, payload: view as unknown as QQBotIngressPayload };
}

/** 重建出来的群成员（ctx + msg 的最小可用组合） */
export interface RebuiltIngressMember {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
}

/**
 * 从快照重建中间件上下文与平台消息。
 *
 * 只重建 dispatch 与装配器真正读到的字段（见文件头「ctx 重建面」）。
 * 重建出的 ctx 是**结构化子集**，`bot` / `stop` 等 SDK 原语不在其中——
 * dispatch 路径不触碰它们（已逐处核对），因此不会因缺原语而改变行为。
 */
export function rebuildIngressMember(params: {
  payload: QQBotIngressPayload;
  /** 取消信号（来自 ingress lifecycle 的 abortSignal） */
  signal?: AbortSignal;
  /** 重建后的 assembledBody 覆盖（组批时由装配器写入） */
  assembledBody?: AssembledBody;
}): RebuiltIngressMember {
  const { payload } = params;
  const state: Record<string, unknown> = {
    mention: { ...payload.mention },
    nameMentioned: payload.nameMentioned,
    processedAttachments: payload.processedAttachments,
  };
  if (payload.mentionPatterns) state.mentionPatterns = payload.mentionPatterns;
  if (payload.quote) state.quote = payload.quote;
  if (payload.history) state.history = payload.history;
  if (payload.roomEventPolicy) state.roomEventPolicy = payload.roomEventPolicy;
  const assembled = params.assembledBody ?? payload.assembledBody;
  if (assembled) state.assembledBody = assembled;
  if (payload.envelope) state.envelope = payload.envelope;

  const message = {
    kind: 'group',
    content: payload.content,
    messageId: payload.messageId,
    senderId: payload.senderId,
    senderName: payload.senderName,
    timestamp: payload.platformTimestamp,
    rawEventType: payload.rawEventType,
    mentions: payload.mentions,
    msgElements: payload.msgElements,
    attachments: payload.attachments,
    replyTarget: { scope: 'group', targetId: payload.groupOpenid },
  } as unknown as QQBotInboundMessage;

  const ctx = {
    message,
    replyTarget: message.replyTarget,
    state,
    signal: params.signal ?? new AbortController().signal,
    stopped: false,
    stopReason: undefined,
    stop: () => {},
  } as unknown as MiddlewareContext;

  return { ctx, msg: message };
}

/** 载荷排序键：本地到达时刻。**不用平台 timestamp**（客户端时钟不可信）。 */
export function ingressPayloadOrderKey(payload: QQBotIngressPayload): number {
  return payload.receivedAtMs;
}
