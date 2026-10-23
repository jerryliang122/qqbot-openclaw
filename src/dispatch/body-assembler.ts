/**
 * Body 组装器（消息入站 body 组装）
 *
 * SDK 中间件链已经完成了所有预处理：
 *   - ctx.message.content              ← contentSanitizer（face 解析 + mention 清洗）
 *   - ctx.state.quote                  ← quoteRef
 *   - ctx.state.history                ← historyBuffer
 *   - ctx.state.mention                ← mentionGate
 *   - ctx.state.processedAttachments   ← attachmentProcessor（语音 STT、图片 URL）
 *
 * 本模块仅负责"按框架协议把上述上下文拼成最终字符串"，是纯函数。
 *
 * 输出字段语义（与框架 buildCtxPayload 语义一致）：
 *   - webBody    → ctxPayload.Body         （Web UI 展示）
 *   - agentBody  → ctxPayload.BodyForAgent （AI 看到的）
 *   - rawBody    → ctxPayload.RawBody / CommandBody（命令解析、审计）
 *   - systemPrompt → ctxPayload.GroupSystemPrompt
 */
import type {
  MiddlewareContext,
  QQBotInboundMessage,
  ResolvedQuote,
  HistoryEntry,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { getAdapters } from '../adapter/resolve.js';
import { matchesNamePattern } from '../utils/mention.js';
import { resolveWakeDecision } from '../features/room-event.js';

// ── 协议常量 ─────────────────────────────
const QUOTE_BEGIN = '[Quoted message begins]';
const QUOTE_END = '[Quoted message ends]';
const REF_BEGIN = '[Reference message begins]';
const REF_END = '[Reference message ends]';
const HISTORY_BEGIN = '[Chat history begins]';
const HISTORY_END = '[Chat history ends]';
const CURRENT_MSG = '[Current message]';

export interface AssembledBody {
  /** Web UI 展示用 body */
  webBody: string;
  /** AI 实际接收的 body（dynamicCtx + userMessage [+ history 前缀]） */
  agentBody: string;
  /** 原始 content（命令解析 / 审计用） */
  rawBody: string;
  /** 群系统提示（account.systemPrompt + 群级提示拼接） */
  systemPrompt?: string;
}

/**
 * 把 SDK 中间件链产出的所有上下文组装为框架规约的 body。
 */
export function assembleBody(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  getRuntime?: () => any,
): AssembledBody {
  const layers = buildMemberLayers(ctx, msg);

  // ── Layer 5: agentBody（命令直通 / 群被@时前置历史） ──
  const agentBody = buildAgentBody({
    userContent: layers.userContent,
    base: layers.base,
    isGroup: layers.isGroup,
    wasMentioned: layers.wasMentioned,
    history: layers.history,
  });

  // ── webBody ──
  const bodyContent = `${layers.quotePart}${layers.userContent}`;

  // ── webBody 外层 envelope 渲染（用 formatInboundEnvelope 包装） ──
  const webBody = getRuntime
    ? renderWebBody(getRuntime, bodyContent, msg, layers.isGroup)
    : bodyContent;

  const systemPrompt = account.systemPrompt?.trim() || undefined;

  return { webBody, agentBody, rawBody: msg.content ?? '', systemPrompt };
}

/** 单条消息的分层产物（单条装配与合批装配共用的复用单元） */
interface MemberLayers {
  /** 清洗后的正文（不含 sender 前缀） */
  userContent: string;
  /** 引用块 */
  quotePart: string;
  /** 带 [sender] 前缀与 (@you) 的用户消息 */
  userMessage: string;
  /** 媒体元数据块 + msg_elements 上下文 */
  dynamicCtx: string;
  /** dynamicCtx + userMessage（**不含** history 前缀） */
  base: string;
  isGroup: boolean;
  wasMentioned: boolean;
  history: HistoryEntry[] | undefined;
}

/** 分层装配单条消息（assembleBody 与 assembleMergedGroupBody 共用） */
function buildMemberLayers(ctx: MiddlewareContext, msg: QQBotInboundMessage): MemberLayers {
  const isGroup = msg.kind === 'group';

  // 唤醒判定唯一口径（features/room-event.ts 的 resolveWakeDecision）：
  // @提及 / 引用 bot 出站 / 称呼唤醒，三者任一命中即"在叫 bot"。
  // 此前本模块只认 SDK 的 wasMentioned 标志，导致「称呼唤醒」既拿不到
  // `(@you)` 标记、也拿不到群历史（与 dispatch 的分类口径不一致）。
  const mentionState = ctx.state.mention as { wasMentioned?: boolean; implicit?: boolean } | undefined;
  const nameMentioned = isGroup
    ? ((ctx.state as { nameMentioned?: boolean }).nameMentioned
      ?? matchesNamePattern({
        content: msg.content,
        mentionPatterns: ctx.state.mentionPatterns as string[] | undefined,
      }))
    : false;
  const wake = resolveWakeDecision({
    mentionState: {
      wasMentioned: mentionState?.wasMentioned === true,
      implicit: mentionState?.implicit === true,
    },
    nameMentioned,
  });
  const wasMentioned = wake.wasMentioned;
  const processed = ctx.state.processedAttachments as ProcessedAttachments | undefined;
  const quote = ctx.state.quote as ResolvedQuote | undefined;
  const history = ctx.state.history as HistoryEntry[] | undefined;

  // ── Layer 1: userContent（清洗后的文本 + 语音转录 + 附件描述） ──
  const userContent = buildUserContent(ctx.message.content ?? '', processed);

  // ── Layer 2: quotePart ──
  const quotePart = buildQuotePart(quote);

  // ── Layer 3: userMessage（群带 [sender] 前缀 + (@you)） ──
  const userMessage = buildUserMessage({ msg, userContent, quotePart, isGroup, wasMentioned });

  // ── Layer 4: dynamicCtx（媒体元数据块 + msg_elements 上下文） ──
  const dynamicCtx = buildDynamicCtx(processed, msg, quote);

  return {
    userContent,
    quotePart,
    userMessage,
    dynamicCtx,
    base: dynamicCtx + userMessage,
    isGroup,
    wasMentioned,
    history,
  };
}

// ── 群消息合批装配 ───────────────────────────────────────────

/** 合批成员（一条待合并的群消息） */
export interface MergedGroupMember {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
}

/**
 * 把 N 条群消息装配成**一个** turn 的 body（插件侧合批用）。
 *
 * 与「直接拼 N 条 agentBody」的关键差别：历史块**只出现一次**。
 * `buildAgentBody` 在「群被@且有历史」时会给每条各加一份
 * `[Chat history begins]…[Chat history ends]`，直接拼接会让历史重复 N 次；
 * 这里改为整批共享**最新成员**的历史快照。
 *
 * 逐条归属（`[消息 i/N]` + 各条自带的 `[sender (openid)]` 前缀）是必须的：
 * 合批允许混入**不同发言人**的消息，模型必须能分清每条是谁说的。
 */
export function assembleMergedGroupBody(
  members: MergedGroupMember[],
  account: ResolvedQQBotAccount,
  getRuntime?: () => any,
  opts?: { droppedNote?: string },
): AssembledBody {
  const layers = members.map((m) => buildMemberLayers(m.ctx, m.msg));
  const total = layers.length;

  const sections = layers.map((l, i) => `[消息 ${i + 1}/${total}]\n${l.base}`);
  const mergedBody = sections.join('\n\n');
  // 丢弃说明放在最前（与框架 `[Queue overflow] …` 同样式：让模型知道有内容缺失）
  const body = opts?.droppedNote ? `${opts.droppedNote}\n\n${mergedBody}` : mergedBody;

  // 整批只一份历史：取**最新**成员的非空历史快照
  const history = pickLatestHistory(layers);
  // 批内只要有一条是"在叫 bot"（user_request），整批就带历史 + (@you) 语义
  const anyMentioned = layers.some((l) => l.wasMentioned);
  const isGroup = layers[0]?.isGroup === true;
  const agentBody = isGroup && anyMentioned && history && history.length > 0
    ? [HISTORY_BEGIN, buildHistoryText(history), '', HISTORY_END, CURRENT_MSG, body].join('\n')
    : body;

  // rawBody：各条原始 content 按行拼接（斜杠命令已旁路，不会进入合并路径）
  const rawBody = members.map((m) => m.msg.content ?? '').join('\n');

  // webBody：合并正文，from 用**群**（批次跨发言人，单 sender 标签会误导）
  const lastMsg = members[members.length - 1]?.msg;
  const webBody = getRuntime && lastMsg
    ? renderWebBody(getRuntime, body, lastMsg, true, lastMsg.replyTarget?.targetId)
    : body;

  const systemPrompt = account.systemPrompt?.trim() || undefined;

  return { webBody, agentBody, rawBody, systemPrompt };
}

/** 取最新成员的非空历史快照 */
function pickLatestHistory(layers: MemberLayers[]): HistoryEntry[] | undefined {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const history = layers[i]?.history;
    if (history && history.length > 0) return history;
  }
  return undefined;
}

/** 历史块文本（每条一行 `[sender] content`） */
function buildHistoryText(history: HistoryEntry[]): string {
  return history
    .map((h) => {
      const label = formatSenderLabel(h.senderName, h.senderId);
      return `[${label}] ${h.content}`;
    })
    .join('\n');
}

// ── 局部组装函数 ─────────────────────────────────────────────

/** Layer 1：sanitized + 语音转录 + 附件描述 */
function buildUserContent(sanitizedRaw: string, processed: ProcessedAttachments | undefined): string {
  const sanitized = sanitizedRaw.trim();
  const voiceText = processed?.voiceText ?? '';
  const attachmentInfo = processed?.otherInfo ? `\n${processed.otherInfo}` : '';

  if (voiceText) {
    return (sanitized ? `${sanitized}\n${voiceText}` : voiceText) + attachmentInfo;
  }
  return sanitized + attachmentInfo;
}

/** Layer 2：[Quoted message begins]…[Quoted message ends] */
function buildQuotePart(quote: ResolvedQuote | undefined): string {
  if (!quote) return '';
  const text = quote.text || 'Original content unavailable';
  return `${QUOTE_BEGIN}\n${text}\n${QUOTE_END}\n${CURRENT_MSG}\n`;
}

/** Layer 3：quote + [Sender] {content}{(@you)?} */
function buildUserMessage(input: {
  msg: QQBotInboundMessage;
  userContent: string;
  quotePart: string;
  isGroup: boolean;
  wasMentioned: boolean;
}): string {
  const { msg, userContent, quotePart, isGroup, wasMentioned } = input;
  const atYouTag = isGroup && wasMentioned ? ' (@you)' : '';

  if (isGroup) {
    const senderLabel = formatSenderLabel(msg.senderName, msg.senderId);
    return `${quotePart}[${senderLabel}] ${userContent}${atYouTag}`;
  }
  return `${quotePart}${userContent}`;
}

/** Layer 3（合并版）：消息合并处理已移除——群消息合并完全交给框架队列
 * （coalesce.enabled → dispatch 侧 queueModeOverride collect/followup）。
 */

/** Layer 4：- Images / - Voice / - ASR 元数据块 + msg_elements 引用上下文 */
function buildDynamicCtx(
  processed: ProcessedAttachments | undefined,
  msg: QQBotInboundMessage,
  quote: ResolvedQuote | undefined,
): string {
  const lines: string[] = [];

  // Images
  if (processed?.imageUrls.length) {
    lines.push(`- Images: ${processed.imageUrls.join(', ')}`);
  }

  // Voice：从 transcripts 行存投影出 paths + urls，去重后拼接
  const transcripts = processed?.transcripts ?? [];
  const voiceRefs = unique([
    ...transcripts.map((t) => t.localPath).filter(isNonEmpty),
    ...transcripts.map((t) => t.remoteUrl).filter(isNonEmpty),
  ]);
  if (voiceRefs.length > 0) {
    lines.push(`- Voice: ${voiceRefs.join(', ')}`);
  }

  // ASR：仅平台转写来源（source==='asr'）——严格信框架后 stt/fallback
  // transcript 不再携带 asrReferText
  const asrTexts = unique(
    transcripts
      .filter((t) => t.source === 'asr')
      .map((t) => t.text)
      .filter(isNonEmpty),
  );
  if (asrTexts.length > 0) {
    lines.push(`- ASR: ${asrTexts.join(' | ')}`);
  }

  // msg_elements 上下文（引用内容本身来自 msg_elements[0] 时跳过该元素避免重复，
  // 其余元素——如 AT+最近N 模式平台附带的消息记录——仍照常渲染）
  const quoteConsumedFirstElement = quote?.source === 'msg_elements';
  const elementsCtx = buildMsgElementsContext(msg, quoteConsumedFirstElement);
  if (elementsCtx.length > 0) {
    lines.push(REF_BEGIN, ...elementsCtx, REF_END);
  }

  return lines.length > 0 ? `${lines.join('\n')}\n\n` : '';
}

/** 检测平台预渲染文本（示例3形态：`=== 消息 1 ===` + `[消息内容]` 行） */
function isPlatformPrerenderedContent(content: string): boolean {
  return /^===\s*消息\s*\d+\s*===/.test(content.trimStart()) && content.includes('[消息内容]');
}

/** 从 msg_elements 提取上下文（非引用消息也解析，如被回复的 bot 消息等） */
function buildMsgElementsContext(msg: QQBotInboundMessage, skipFirstElement = false): string[] {
  const elements = msg.msgElements;
  if (!elements || elements.length === 0) return [];

  const lines: string[] = [];
  let index = 0;
  for (let i = 0; i < elements.length; i++) {
    if (skipFirstElement && i === 0) continue;
    const el = elements[i]!;
    const content = el.content?.trim();
    const attachments = Array.isArray(el.attachments) ? el.attachments : [];
    if (!content && attachments.length === 0) continue;
    index += 1;

    // 平台已预渲染的多消息文本（如聊天记录转发）直接透传，避免二次包裹
    if (content && isPlatformPrerenderedContent(content)) {
      lines.push(`=== 消息记录 ${index} ===`, content);
      continue;
    }

    const author = (el as Record<string, unknown>).author as
      | { username?: string }
      | undefined;
    const sender = author?.username ?? '未知';

    lines.push(
      `=== 消息 ${index} ===`,
      `[消息内容] ${content || '（无文本）'}`,
    );
    for (const att of attachments) {
      const a = att as { url?: string; content_type?: string };
      const kind = a.content_type ?? 'attachment';
      const url = a.url ?? '';
      lines.push(`[附件] ${kind}${url ? `: ${url}` : ''}`);
    }
    lines.push(`[发送者] ${sender}`);
  }

  return lines;
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isNonEmpty(x: string | undefined): x is string {
  return typeof x === 'string' && x.length > 0;
}

/** Layer 5：base = dynamicCtx+userMessage；命令直通；群被@叠历史前缀 */
function buildAgentBody(input: {
  userContent: string;
  base: string;
  isGroup: boolean;
  wasMentioned: boolean;
  history: HistoryEntry[] | undefined;
}): string {
  const { userContent, base, isGroup, wasMentioned, history } = input;

  // 斜杠命令直通：去除一切装饰及首尾空白
  if (userContent.trim().startsWith('/')) {
    return userContent;
  }

  // 群被@ + 有历史 → 叠历史前缀
  if (isGroup && wasMentioned && history && history.length > 0) {
    return [HISTORY_BEGIN, buildHistoryText(history), '', HISTORY_END, CURRENT_MSG, base].join('\n');
  }

  return base;
}

/** "Nick (openid)" 标签；当 name 已含 id 时避免双重包裹 */
function formatSenderLabel(name: string | undefined, id: string): string {
  if (!name) return id;
  return name.includes(id) ? name : `${name} (${id})`;
}

/** webBody 外层 envelope 渲染 */
function renderWebBody(
  getRuntime: () => any,
  bodyContent: string,
  msg: QQBotInboundMessage,
  isGroup: boolean,
  fromOverride?: string,
): string {
  try {
    const { formatEnvelope } = getAdapters(getRuntime());
    if (!formatEnvelope) return bodyContent;
    return formatEnvelope({
      channel: 'qqbot',
      // 合批时用群 id（批次跨发言人，单 sender 标签会误导）；单条时用发送者
      from: fromOverride ?? msg.senderName ?? msg.senderId,
      timestamp: normalizeTimestamp(msg.timestamp),
      body: bodyContent,
      chatType: isGroup ? 'group' : 'direct',
    });
  } catch {
    return bodyContent;
  }
}

/** timestamp 归一化到 epoch ms */
function normalizeTimestamp(ts: string | number | undefined): number {
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'string') {
    const d = new Date(ts).getTime();
    if (!Number.isNaN(d)) return d;
  }
  return Date.now();
}
