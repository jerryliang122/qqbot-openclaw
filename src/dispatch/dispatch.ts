/**
 * 消息转发 — 入站消息 → OpenClaw AI
 *
 * 核心职责：
 * 1. 从 SDK MiddlewareContext 构建 OpenClaw 标准信封
 * 2. 通过 runtime-adapter 将消息交给 AI 处理
 *
 * 架构说明：
 * - 所有 runtime.channel.* 访问均通过 runtime-adapter 隔离
 * - log: 前缀由 PluginLogger + 框架自动注入，消息体不重复 accountId
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { buildEnvelope } from './envelope-builder.js';
import { assembleBody, type AssembledBody } from './body-assembler.js';
import { sendText, getGateway } from '../outbound/outbound-service.js';
import { sendQuestionMessage } from '../outbound/question-send.js';
import { sendMedia } from '../outbound/media-send.js';
import { deliverReply, resolveMediaUrls, formatMediaFailureNotice, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { buildCtxPayload } from './ctx-builder.js';

import { DeliverDebouncer } from '../outbound/debounce.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';
import { ProgressCardPublisher } from '../outbound/progress-card-publisher.js';
import { getAdapters, type RuntimeAdapters } from '../adapter/resolve.js';
import { clearGroupHistory, trimGroupHistoryAfterLastBot } from '../features/history-store.js';
import {
  isAskUserPayload,
  isNonSingleAskUserPayload,
  buildQuestionKeyboard,
  buildMultiQuestionKeyboard,
  formatMultiQuestionCard,
  parseMultiQuestionPrompt,
  registerPendingMultiQuestion,
} from '../features/question-helpers.js';
import { resolveGroupConfigFromAccount, resolveMentionPatterns, resolveProgressCardConfig } from '../config.js';
import { markGroupTurnFinished, markGroupTurnStarted } from '../features/group-session-busy.js';
import { detectEventMention, matchesNamePattern } from '../utils/mention.js';
import {
  classifyInboundEventKind,
  resolveRoomEventPolicy,
  resolveVisibleRepliesMode,
  resolveWakeDecision,
  type RoomEventPolicy,
  type VisibleRepliesMode,
} from '../features/room-event.js';

/** 失败兜底文案（对齐 telegram：Something went wrong while processing your request.） */
const FAILURE_FALLBACK_TEXT = 'Something went wrong while processing your request. Please try again.';

/** 每进程只打一次「框架排队已接管线」INFO（排障锚点，确认 collect 真实生效） */
let frameworkQueueAnnounced = false;

/**
 * room_event 降级告警去重集合（account+group 维度）。
 *
 * 降级是配置级问题（工具面缺 message），每条消息都 WARN 会刷屏——
 * 每个群只报一次，修复配置后重启即恢复。
 */
const roomEventDegradedGroups = new Set<string>();

function warnRoomEventDegraded(
  dlog: PluginLogger | undefined,
  accountId: string,
  groupId: string | undefined,
  reason: string | undefined,
): void {
  const key = `${accountId}:${groupId ?? '-'}`;
  if (roomEventDegradedGroups.has(key)) return;
  roomEventDegradedGroups.add(key);
  dlog?.warn(
    `[room-event] group=${groupId} 降级为 user_request：${reason ?? 'message 工具不可用'}。`
    + 'room_event 的唯一发声通道是 message 工具，缺它会导致群里永久沉默。'
    + '修法：把 message 加进该群工具白名单（channels.qqbot.groups.<id>.tools.allow），'
    + '或设 groups.<id>.roomEventRequireMessageTool=false 保持严格静默。',
  );
}

/** 测试用：清空降级告警去重集合 */
export function _resetRoomEventDegradedWarnings(): void {
  roomEventDegradedGroups.clear();
}

/**
 * 取本条消息生效的 room_event 策略。
 *
 * 优先复用中间件链里 policyInjector 已裁决好的结果（挂在 ctx.state），
 * 保证「门控放行与否」与「入站分类」同源；中间件链不存在时（如单测直接调
 * dispatch）就地复算。
 */
function resolveDispatchRoomEventPolicy(params: {
  ctx: MiddlewareContext;
  cfg: unknown;
  account: ResolvedQQBotAccount;
  groupOpenid: string;
  agentId: string;
}): RoomEventPolicy {
  const stored = (params.ctx.state as { roomEventPolicy?: (RoomEventPolicy & { agentId?: string; groupOpenid?: string }) } | undefined)
    ?.roomEventPolicy;
  if (
    stored &&
    stored.agentId === params.agentId &&
    stored.groupOpenid === params.groupOpenid
  ) {
    return stored;
  }
  return resolveRoomEventPolicy({
    cfg: params.cfg as any,
    account: params.account,
    groupOpenid: params.groupOpenid,
    agentId: params.agentId,
  });
}

/**
 * 合并 AbortSignal（Node >= 20.3 使用 AbortSignal.any，低版本手工 fan-in）。
 * turnAdoptionLifecycle 的 pre-adoption abort 需要与请求级 signal 共同生效。
 */
function combineAbortSignals(
  requestSignal: AbortSignal | undefined,
  turnSignal: AbortSignal,
): AbortSignal {
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === 'function') {
    return any.call(AbortSignal, requestSignal ? [requestSignal, turnSignal] : [turnSignal]);
  }
  if (!requestSignal) return turnSignal;

  const controller = new AbortController();
  const cleanup = () => {
    requestSignal.removeEventListener('abort', onRequestAbort);
    turnSignal.removeEventListener('abort', onTurnAbort);
  };
  const abortFrom = (signal: AbortSignal) => {
    cleanup();
    controller.abort(signal.reason);
  };
  const onRequestAbort = () => abortFrom(requestSignal);
  const onTurnAbort = () => abortFrom(turnSignal);

  if (requestSignal.aborted) abortFrom(requestSignal);
  else if (turnSignal.aborted) abortFrom(turnSignal);
  else {
    requestSignal.addEventListener('abort', onRequestAbort, { once: true });
    turnSignal.addEventListener('abort', onTurnAbort, { once: true });
  }
  return controller.signal;
}


/** dispatchToOpenClaw 可选行为开关（c2c 防抖 admission 信号等） */
export interface DispatchToOpenClawOptions {
  /**
   * turn 已入队框架网关（session lane 已决策：onAdopted / onDeferred /
   * onAbandoned 任一触发）时通知，恰好一次。
   *
   * 用途：c2c 入站防抖（inbound-debounce.ts）据此释放框架 debouncer 的
   * 同 key 任务链——框架 enqueue 对旁路项（/stop 等控制命令）在同 key
   * 存在 in-flight 任务时会排队等待其 settle，而防抖 onFlush 的 completion
   * 覆盖整个 turn run；若不提前放行，任务运行期间到达的 /stop 要等
   * turn 跑完才 dispatch，插嘴语义（exclusive + abortSignal 取消旧 turn）
   * 完全失效。
   *
   * 信号必须取 lane 决策钩子而非「adapters.inboundRun 已调用」：框架
   * runChannelTurn 在真正入队前还有 ingest → classify → preflight →
   * resolveTurn 多个异步段（dist/run-channel-turn-*.js），调用时放行会让
   * 后续 /stop 抢在本 turn 入队前到达 lane、无处可取消（Sourcery 意见 2）；
   * onAdopted/onDeferred 即「已进 lane 队列」，此时放行后续 dispatch 必然
   * 晚于本 turn，顺序确定。onAbandoned 为防御路径（未经采纳即被弃）。
   * 钩子未触发的路径（ingest 丢弃 / classify handled / dispatch 抛错 /
   * adapters 缺失提前返回）由调用方以 completion settle 兜底放行，
   * 链不会悬挂。
   */
  onTurnSubmitted?: () => void;
}

/** 框架 canonical agent id（非法值回退 'main'）——与 openclaw normalizeAgentId 同形。 */
function normalizeFallbackIdStrict(value: string | undefined): string | undefined {
  const trimmed = (value ?? '').trim();
  const normalized = trimmed.toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(trimmed)) return normalized;
  const sanitized = normalized
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 64);
  return sanitized || undefined;
}

/** 框架 canonical account id（非法/空值回退 'default'）——与 openclaw normalizeAccountId 同形。 */
function normalizeFallbackAccountId(value: string | undefined): string {
  const sanitized = normalizeFallbackIdStrict(value);
  // 框架额外排除原型污染键（__proto__ / constructor / prototype）
  if (!sanitized || sanitized === '__proto__' || sanitized === 'constructor' || sanitized === 'prototype') {
    return 'default';
  }
  return sanitized;
}

/** 兜底路由 sessionKey 的入参（与框架 buildAgentSessionKey 的参数一一对应）。 */
export interface FallbackRouteSessionKeyParams {
  /** 群聊（true）还是私聊（false） */
  isGroup: boolean;
  accountId: string;
  peerId: string;
  /** agent id（框架默认 'main'） */
  agentId?: string;
  /** 会话主键（框架默认 'main'） */
  mainKey?: string;
  /** 框架 cfg.session.dmScope（默认 'main'） */
  dmScope?: string;
  /** 框架 cfg.session.groupScope（默认 'per-group'） */
  groupScope?: string;
}

/**
 * 兜底路由 sessionKey（runtime 缺 `channel.routing.resolveAgentRoute` 时的安全网）。
 *
 * 必须与框架 `buildAgentPeerSessionKey` 的产物**逐字同形**——两条硬约束：
 *
 * 1. **canonical**（openclaw 2026.10.x state worker 写 session 时校验）：
 *    `parseAgentSessionKey(key)` 非 null（`agent:<agentId>:<rest>` 文法）且
 *    `normalizeStoreSessionKey(key) === key`（key 等于其全小写折叠形）。
 *    违反即抛 `SessionCanonicalKeyMigrationRequiredError`，该 session 读写瘫痪。
 *    旧版 `qqbot:<account>:...` 兜底在 10.x 下等于全量静默瘫痪（已实测复现）。
 *
 * 2. **route 文法**：框架反解投递目标用的是 `<channel>[:<accountId>]:<peerKind>:<peerId>`
 *    （`parseSessionDeliveryRoute`）。把 accountId 或历史遗留的 `:coalescing` 后缀
 *    塞进 peer 段，框架会把它们当成 peerId 的一部分 → 框架自发回复 / 投递恢复 /
 *    子代理路由全部指向不存在的 peer。
 *
 * 作用域语义也必须与框架一致（dmScope / groupScope 取自 `cfg.session`），
 * 否则兜底与主路径（框架 resolveAgentRoute）会话粒度不同：c2c 默认
 * `dmScope="main"` 共享 `agent:main:main`，兜底却按 peer 分裂。
 *
 * 优先用框架自己的 `runtime.channel.routing.buildAgentSessionKey`（见 adapter/resolve.ts），
 * 本函数只作为「框架原语也缺失」时的等价镜像。
 */
export function buildFallbackRouteSessionKey(params: FallbackRouteSessionKeyParams): string {
  const agentId = normalizeFallbackIdStrict(params.agentId) ?? 'main';
  const mainKey = (params.mainKey ?? '').trim().toLowerCase() || 'main';
  const channel = 'qqbot';
  const accountId = normalizeFallbackAccountId(params.accountId);
  // qqbot 非 signal/matrix，框架的 normalizeSessionPeerId 一律折叠为小写
  const peerId = (params.peerId ?? '').trim().toLowerCase();

  if (!params.isGroup) {
    const dmScope = params.dmScope ?? 'main';
    if (dmScope === 'per-account-channel-peer' && peerId) {
      return `agent:${agentId}:${channel}:${accountId}:direct:${peerId}`;
    }
    if (dmScope === 'per-channel-peer' && peerId) {
      return `agent:${agentId}:${channel}:direct:${peerId}`;
    }
    if (dmScope === 'per-peer' && peerId) {
      return `agent:${agentId}:direct:${peerId}`;
    }
    return `agent:${agentId}:${mainKey}`;
  }

  const groupScope = params.groupScope ?? 'per-group';
  if (groupScope === 'main') return `agent:${agentId}:${mainKey}`;
  return `agent:${agentId}:${channel}:group:${peerId || 'unknown'}`;
}

/**
 * 路由 peerId：群聊用 groupId（群内不同用户共享同一 session lane，避免同群
 * 并发触发 QQ 平台 500），私聊用 senderId。
 */
export function resolveDispatchPeerId(
  chatScope: 'direct' | 'group',
  groupId: string | undefined,
  senderId: string,
): string {
  return chatScope === 'group' ? (groupId ?? senderId) : senderId;
}

/**
 * 兜底路由对象（runtime 缺 `channel.routing.resolveAgentRoute` 时的安全网）。
 *
 * 优先用框架自己的 `runtime.channel.routing.buildAgentSessionKey`——它与
 * resolveAgentRoute 同源，文法/作用域语义永远跟随框架；框架原语也缺失时
 * 才退到本地等价镜像（buildFallbackRouteSessionKey）。
 *
 * agentId 取框架默认 'main'（DEFAULT_AGENT_ID）——必须与 sessionKey 的 agent 段
 * 一致，否则 session key 说 main、turn 却按别的 agent 跑。
 */
function buildFallbackRoute(
  adapters: RuntimeAdapters,
  cfg: any,
  accountId: string,
  isGroup: boolean,
  peerId: string,
): { sessionKey: string; agentId: string; accountId: string } {
  const agentId = 'main';
  const sessionCfg = (cfg as { session?: { mainKey?: string; dmScope?: string; groupScope?: string } }).session;
  const peer = { kind: isGroup ? ('group' as const) : ('direct' as const), id: peerId };
  const frameworkKey = adapters.buildAgentSessionKey?.({
    agentId,
    channel: 'qqbot',
    accountId,
    peer,
    mainKey: sessionCfg?.mainKey,
    dmScope: sessionCfg?.dmScope,
    groupScope: sessionCfg?.groupScope,
  });
  return {
    sessionKey: frameworkKey ?? buildFallbackRouteSessionKey({
      isGroup,
      accountId,
      peerId,
      agentId,
      mainKey: sessionCfg?.mainKey,
      dmScope: sessionCfg?.dmScope,
      groupScope: sessionCfg?.groupScope,
    }),
    agentId,
    accountId,
  };
}

/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
  opts?: DispatchToOpenClawOptions,
): Promise<void> {
  const dlog = log?.child('dispatch');
  const adapters = getAdapters(runtime, dlog);
  const envelope = buildEnvelope(ctx, msg, account);

  dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

  if (!adapters.inboundRun || !adapters.dispatchReply) {
    dlog?.error(`runtime adapter inboundRun/dispatchReply not available (openclaw=${adapters.version}, requires >=2026.10.5)`);
    return;
  }

  const groupTurnOpenid = envelope.chatScope === 'group' ? envelope.groupId : undefined;

  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

  const isGroup = envelope.chatScope === 'group';

  // 路由 peerId：群聊用 groupId（群内不同用户共享同一 session lane，避免同群
  // 并发触发 QQ 平台 500），私聊用 senderId（允许用户"插嘴"，新消息取消旧消息）。
  const peerId = resolveDispatchPeerId(envelope.chatScope, envelope.groupId, envelope.senderId);

  const route = adapters.resolveAgentRoute?.({
    cfg,
    channel: 'qqbot',
    accountId: account.accountId,
    peer: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      id: peerId,
    },
  }) ?? buildFallbackRoute(adapters, cfg, account.accountId, isGroup, peerId);

  const qualifiedTarget = envelope.targetId;
  const agentId = route.agentId ?? 'default';

  // ── 群消息合并的归属分工（2026-10-23）──
  // - strategy='plugin'（默认）：插件侧合批——该群 agent 忙时到达的消息
  //   （含不同发言人）攒成一批，turn 结束后一次性作为**一条**消息发给
  //   框架。框架队列在此只是**兜底**（插件漏判 busy 时接管），单条消息
  //   对 collect 无副作用，故仍传 'collect'。
  // - strategy='framework'：交回框架 followup 队列的 collect 模式。
  //   注意框架 collect 的分组键含 senderId 且遇首个不同键即断——同群
  //   不同发言人**永远合并不了**（这是插件侧合批存在的原因）。
  // - enabled=false：followup——排队但不合并（尊重「关闭合并」的意图，
  //   仍保证不打断活动 turn——远比框架默认 steer 插嘴安全）。
  const groupCfg = isGroup && envelope.groupId
    ? resolveGroupConfigFromAccount(account, envelope.groupId)
    : undefined;
  const queueModeOverride = groupCfg
    ? (groupCfg.coalesce.enabled ? 'collect' as const : 'followup' as const)
    : undefined;

  // ── room_event 分类（全量模式群的被动房间事件）──
  // 唤醒判定（唯一口径，见 features/room-event.ts 的 resolveWakeDecision）：
  //   @（AT 事件 / mentions.is_you / 内容标记）→ 引用 bot 出站（implicit）
  //   → 称呼（mentionPatterns，如「沈处」）
  // 三者均未命中且群处于 room_event 时，该消息作为被动房间事件进框架：
  // AI 只读上下文，最终文本不投递（message_tool_only），想发言走主动 message
  // 工具；框架自动压 typing/流式、排队不 steer。斜杠命令始终是显式用户意图
  // → user_request。
  const mentionState = (ctx.state as { mention?: { wasMentioned?: boolean; implicit?: boolean } }).mention;
  const mentionPatterns = (ctx.state as { mentionPatterns?: string[] }).mentionPatterns
    ?? resolveMentionPatterns(cfg, agentId);
  // 事件级 @ 信号兜底：单测里消息可能不经中间件链直达 dispatch，
  // 此时 ctx.state.mention 不存在
  const eventMentioned = isGroup
    ? detectEventMention({
        eventType: (msg as { rawEventType?: string }).rawEventType,
        mentions: (msg as { mentions?: Array<{ is_you?: boolean }> }).mentions,
      })
    : false;
  const nameMentioned = isGroup
    ? ((ctx.state as { nameMentioned?: boolean }).nameMentioned
      ?? matchesNamePattern({ content: msg.content, mentionPatterns }))
    : false;
  const wake = resolveWakeDecision({
    mentionState: {
      wasMentioned: mentionState?.wasMentioned === true || eventMentioned,
      implicit: mentionState?.implicit === true,
    },
    nameMentioned,
  });

  // 入站策略（群级 > per-agent > 全局 > 默认）+ message 工具守卫
  const roomEventPolicy = resolveDispatchRoomEventPolicy({
    ctx,
    cfg,
    account,
    groupOpenid: isGroup ? (envelope.groupId ?? '') : '',
    agentId,
  });
  if (roomEventPolicy.degraded) {
    warnRoomEventDegraded(dlog, account.accountId, envelope.groupId, roomEventPolicy.degradedReason);
  }

  const inboundEventKind = classifyInboundEventKind({
    isGroup,
    rawBody: assembled.rawBody ?? '',
    wake,
    unmentionedInbound: roomEventPolicy.effectiveMode,
  });

  // 可见回复模式按 **turn** 判定，不是按群：
  // - room_event turn → 严格投递（最终文本不投递，只能走 message 工具）
  // - user_request turn → 配置驱动（群读 messages.groupChat.visibleReplies，
  //   非群只读 messages.visibleReplies——框架的 c2c 分支同样不读 groupChat，
  //   混读会把「群里配 visibleReplies=message_tool」扩散到私聊，把 DM 终稿压成静默）
  // 同一群里两种 turn 交替出现时，可见性必须逐 turn 判定——
  // 否则 room_event 群里被 @ 的那条消息也会被压成静默（= 用户 @ 了 bot 却没回音）。
  const turnVisibleReplies: VisibleRepliesMode = inboundEventKind === 'room_event'
    ? 'message_tool'
    : resolveVisibleRepliesMode({
        cfg,
        mode: 'user_request',
        chatType: envelope.chatScope === 'group' ? 'group' : 'direct',
      });

  // 分类可观测性：room_event 事件触发一次推理 pass（成本排障命门），必须留痕；
  // room_event 群里被唤醒为 user_request 时标注唤醒来源（@/称呼/引用），
  // 便于观察 mentionPatterns 与引用唤醒的实际命中
  if (inboundEventKind === 'room_event') {
    dlog?.info(
      `[room-event] passive room event group=${envelope.groupId} sender=${envelope.senderId} contentLen=${(msg.content ?? '').length}`,
    );
  } else if (isGroup && roomEventPolicy.effectiveMode === 'room_event' && !/^\//.test(assembled.rawBody ?? '')) {
    dlog?.info(`[wake] ${wake.source} → user_request group=${envelope.groupId} sender=${envelope.senderId}`);
  }

  if (queueModeOverride && !frameworkQueueAnnounced) {
    frameworkQueueAnnounced = true;
    dlog?.info(
      `[queue] group turn queueing delegated to framework followup queue (mode=${queueModeOverride}, ` +
      `mergeStrategy=${groupCfg?.coalesce.strategy ?? 'framework'}); plugin-side batching handles cross-sender merges`,
    );
  }
  const storePath = adapters.resolveStorePath?.((cfg as any)?.session?.store, { agentId }) ?? '';

  const ctxPayload = buildCtxPayload({ assembled, envelope, route, msg, ctx, adapters });
  // room_event 分类标记：框架据此压制自动回复投递 / typing / steer
  // （对齐 telegram 的 ctxPayload.InboundEventKind 约定）
  ctxPayload.InboundEventKind = inboundEventKind;

  // TTS 扩展点探测（runtime.tts / runtimeContexts），非核心 channel API
  const ttsRuntime = (runtime as any)?.tts ?? (runtime as any)?.channel?.runtimeContexts?.get?.('tts'); // @adapter-bypass: TTS extension point probe

  const debounceConfig = account.config?.deliverDebounce;
  const debouncer = debounceConfig?.enabled !== false
    ? new DeliverDebouncer(debounceConfig, async (targetId, mergedText) => {
        const result = await sendText({ to: targetId, text: mergedText, accountId: account.accountId, replyToId: envelope.messageId, account });
        trackOutbound(result, 'debounce');
      }, dlog)
    : undefined;

  const deliverCtx: DeliverContext = {
    qualifiedTarget,
    accountId: account.accountId,
    replyToId: envelope.messageId,
    chatScope: envelope.chatScope === 'group' ? 'group' : 'direct',
    cfg,
    debouncer: debouncer?.enabled ? debouncer : undefined,
    sendText: (to, text) => sendText({ to, text, accountId: account.accountId, replyToId: envelope.messageId, account })
      .then((result) => trackOutbound(result, 'deliverCtx.sendText')),
    sendMedia: (to, source, opts) => sendMedia({
      to,
      source,
      text: opts?.text ?? '',
      replyToId: envelope.messageId,
      accountId: account.accountId,
      agentId: route.agentId,
      log: deliverCtx.log,
    }).then((result) => trackOutbound(result, 'deliverCtx.sendMedia')),
    textToSpeech: ttsRuntime?.textToSpeech
      ? (params) => ttsRuntime.textToSpeech(params)
      : undefined,
    audioFileToSilkBase64: ttsRuntime?.audioFileToSilkBase64
      ? (audioPath: string) => ttsRuntime.audioFileToSilkBase64(audioPath)
      : undefined,
    log: log?.child('deliver'),
    agentId: route.agentId ?? 'default',
  };

  const streamingEnabled = shouldUseStreaming(
    account,
    envelope.chatScope === 'group' ? 'group' : 'c2c',
  );

  const streamingController = streamingEnabled
    ? createStreamingController(envelope, account, log?.child('streaming'))
    : null;

  if (streamingController) {
    dlog?.debug(`streaming enabled for ${envelope.senderId}`);
  }

  /**
   * 已认领的尾巴文本（同一 dispatch 生命周期内）。
   *
   * 两个重叠的 final 投递会在任一排队的 finalize() 执行前各自读到 parked；
   * 最后一个 stream 段此前已封口时 absorbFinalText 无法在没有 session 的
   * 情况下推进差量基准 → 两个回调算出**同一份** remainder 并各发一次
   * （usage footer 发两遍，PR #81 评审 N8）。认领制：发送前先登记，同一
   * remainder 只发一次。
   */
  const claimedFinalTails = new Set<string>();

  /**
   * 流式 final 尾巴差量补发（usage footer 等，PR #81 评审 L3 抽取）。
   * 两处消费——park 场景 deliver 回调内 / dispatch 末尾兜底——共用同一实现，
   * 防止两份四条件逻辑各自演化分叉。调用方负责各自的门控条件
   * （!aborted / !shouldSuppressFinalTailFallback 等）。返回是否实际发送。
   *
   * sendText 失败返回 {error} 而**不抛错**：不检查就是把失败当成功——parked
   * 场景 dispatch 已收尾，末尾兜底不会再跑，footer 就此静默丢失
   * （PR #81 评审 N5）。失败重试一次，仍失败记 ERROR 并返回 false。
   */
  const sendFinalTailRemainder = async (finalText: string, via: string): Promise<boolean> => {
    if (!streamingController) return false;
    const remainder = streamingController.computeUnsentRemainder(finalText).trim();
    if (!remainder) return false;
    if (claimedFinalTails.has(remainder)) {
      dlog?.info(`[stream-final] ${via} skipped: tail already claimed chars=${remainder.length}`);
      return false;
    }
    claimedFinalTails.add(remainder);
    dlog?.info(`[stream-final] ${via} chars=${remainder.length}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const result = await deliverCtx.sendText(qualifiedTarget, remainder);
        if (!result.error) return true;
        dlog?.warn(`[stream-final] ${via} send failed (attempt ${attempt}/2): ${String(result.error)}`);
      } catch (err) {
        dlog?.warn(
          `[stream-final] ${via} send threw (attempt ${attempt}/2): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    dlog?.error(`[stream-final] ${via} tail dropped after retries chars=${remainder.length}`);
    return false;
  };

  const deliveredMediaUrls = new Set<string>();
  const deliveredTexts = new Set<string>();
  // 流式 turn 的 final payload 文本暂存：框架把 usage footer（/usage tokens|full）
  // 等追加在 final 文本尾部（框架 appendUsageLine），流式增量永不包含——
  // 收尾后按前缀差量补发未流出部分（见 dispatch 末尾 [stream-final] 段）
  let pendingStreamFinalText: string | undefined;
  let deliverErrorCount = 0;
  // 流式收尾时因 turn 被取消而主动 abort（PR #81 复审 R2）：此状态下用户
  // 主动放弃了本轮，不应再发「失败兜底」消息（那是对一次被取消的回复的噪声）
  let streamingCancelled = false;
  // 出站发送成功/失败计数：deliver-pipeline 对 sendText {error} 只记日志不抛错，
  // 这里在 dispatch 拥有的发送闭包边界上统计，作为"用户是否收到可见回复"的判据。
  let outboundSendOk = 0;
  let outboundSendFail = 0;
  const trackOutbound = <T extends { error?: string }>(result: T, via: string): T => {
    if (result.error) {
      outboundSendFail++;
      dlog?.error(`outbound send failed via ${via}: ${String(result.error)}`);
    } else {
      outboundSendOk++;
    }
    return result;
  };

  /**
   * deliver 回调（两个分支共用）。
   *
   * 失败语义（对齐 telegram）：捕获后计数并记录日志，不中断后续 payload；
   * dispatch 结束后若 (deliver 失败 || dispatch 抛错) 且用户未收到任何可见回复，
   * 发送兜底消息，避免静默失败。
   */
  const deliverHandler = async (payload: DeliverPayload, info?: DeliverInfo): Promise<void> => {
    try {
      const kind = (info as any)?.kind as string | undefined;
      const text = payload.text?.trim() ?? '';
      const hasMedia = !!(payload.mediaUrl || payload.mediaUrls?.length);
      dlog?.debug(`deliver kind=${kind ?? 'none'} textLen=${text.length} voice=${!!payload.audioAsVoice} media=${hasMedia}`);

      // Progress card：正文级投递开始（final/媒体/ask_user/审批等；kind 'tool'
      // 是 verbose 工具进度通知，不算）后停止卡片发布，并等待 in-flight 的
      // 卡片发送落地再放行正文——保证卡片永不晚于答案
      if (progressPublisher && kind !== 'tool') {
        progressPublisher.stop(`deliver kind=${kind ?? 'none'}`);
        await progressPublisher.drain();
      }

      // ── 0. ask_user 按钮投递（优先于所有其他处理）──
      // 单问题单选场景：用 inline keyboard 替代纯文本
      const payloadWithChannelData = payload as DeliverPayload & { channelData?: unknown };
      if (isAskUserPayload(payloadWithChannelData as any) && text) {
        // 已取消的 turn 不发问题卡片，也不发送取消前累积的内容
        // （PR #81 评审 N2：取消后仍发排队内容/卡片，用户看到过时输出）
        if (combinedAbortSignal.aborted) {
          dlog?.info('[question] skipped: turn cancelled');
          return;
        }
        const { questionId, optionValues } = (payloadWithChannelData as any).channelData.askUser;
        const keyboard = buildQuestionKeyboard(questionId, optionValues);
        // ask_user 前先固化已累积的流式内容（评审意见 6）：stream 模式封口
        // 当前段（等待用户作答期间草稿气泡不该悬挂）；static 模式 flush 缓冲
        // （问题卡片之前的前置文本先落地）。两者均不终态化——作答后 run
        // 续跑，新一段照常另起。
        // static 的 flush 走 tolerant：前置文本发送失败**不**终态化 controller
        // ——终态化会让作答后的 partial/final 全被 isTerminal 守卫丢弃，
        // 用户看到问题卡片却看不到答案（PR #81 评审 N1）。
        if (streamingController?.isStaticSendMode) {
          await streamingController.flushSegment({ signal: combinedAbortSignal, tolerant: true });
        } else {
          await streamingController?.closeSegment('ask_user', { signal: combinedAbortSignal });
        }
        // 前置文本发送失败 → 缓冲处于「未送达残留」状态。此时**不能**标记
        // 「内容已外部投递」：那会关掉终稿的 rescue 补发路径，作答后的
        // 答案正文将永久丢失（PR #81 复审 R1）。
        const preambleFailed = streamingController?.hasStaleBuffer === true;
        if (preambleFailed) {
          dlog?.warn('[question] ask_user preamble not delivered — keeping final rescue path open');
        }
        // 卡片发送前二次复查取消信号：flush/close 是 await 期间可能已被取消
        // （PR #81 复审 R1：取消后仍发卡片）
        if (combinedAbortSignal.aborted) {
          dlog?.info('[question] skipped: turn cancelled before card');
          return;
        }
        // 问题卡走**被动回复**（锚点 = 本轮 inbound 的 msg_id）：不耗每日
        // 主动预算，用户关闭「允许主动发送」时也能收到问题；锚点不可用
        // （TTL 过期 / 平台判死）时自动降级为主动发送一次。
        try {
          const cardResult = await sendQuestionMessage({
            account,
            accountId: account.accountId,
            to: qualifiedTarget,
            text,
            keyboard: keyboard as never,
            anchorMsgId: envelope.messageId,
            log: dlog,
          });
          if (!cardResult.error) {
            outboundSendOk++;
            // 标记流式控制器：内容已通过外部通道投递，finalize 不走 fallback
            // （前置文本没能送达时不标记——否则终稿救不回来）
            if (!preambleFailed) streamingController?.markDeliveredExternally();
            dlog?.debug(`[question] sent ask_user with keyboard questionId=${questionId} options=${optionValues.length}`);
            return;
          }
          outboundSendFail++;
          dlog?.error(`[question] question card send failed: ${cardResult.error}`);
        } catch (err) {
          outboundSendFail++;
          dlog?.error(
            `[question] question card send threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        // fallback 到纯文本发送
      }

      // ── 0b. ask_user 多问题投递：每题一条带按钮的消息。
      // 框架对多问题只投递纯文本（无结构化选项），这里从文本反解题目结构；
      // 按钮点选 / isOther 题的文字回复在回调与入站侧缓冲，
      // 集齐后合成一条"用户文本回复"走入站通道，由框架的文本应答
      // 解析器 resolve 挂起的 ask_user ──
      if (isNonSingleAskUserPayload(payloadWithChannelData as any) && text) {
        if (combinedAbortSignal.aborted) {
          dlog?.info('[question] skipped: turn cancelled (multi)');
          return;
        }
        const { questionId } = (payloadWithChannelData as any).channelData.askUser;
        const questions = parseMultiQuestionPrompt(text);
        if (questions) {
          const scope = envelope.chatScope === 'group' ? 'group' as const : 'c2c' as const;
          // 先登记再发送，避免用户先点按钮时查无此单；锚点（本轮 inbound
          // 的 msg_id）一并登记——续卡 / 确认卡 / 状态回执据此走被动回复。
          registerPendingMultiQuestion(
            account.accountId,
            questionId,
            scope,
            peerId,
            questions,
            undefined,
            envelope.messageId,
          );
          // ask_user 前先固化已累积的流式内容（同单问题分支，评审意见 6）
          // static 的 flush 走 tolerant：前置文本发送失败不终态化 controller
          // （PR #81 评审 N1）
          if (streamingController?.isStaticSendMode) {
            await streamingController.flushSegment({ signal: combinedAbortSignal, tolerant: true });
          } else {
            await streamingController?.closeSegment('ask_user', { signal: combinedAbortSignal });
          }
          // 前置文本未送达 → 不标记「内容已外部投递」（保住终稿 rescue 路径）
          const preambleFailed = streamingController?.hasStaleBuffer === true;
          if (preambleFailed) {
            dlog?.warn('[question] ask_user preamble not delivered (multi) — keeping final rescue path open');
          }
          // 卡片发送前二次复查取消信号（await 期间可能已取消）
          if (combinedAbortSignal.aborted) {
            dlog?.info('[question] skipped: turn cancelled before cards (multi)');
            return;
          }
          try {
            for (const [index, question] of questions.entries()) {
              const cardText = formatMultiQuestionCard(question, index, questions.length);
              const keyboard = buildMultiQuestionKeyboard(questionId, index, question);
              // 每张卡都挂**同一个显式锚点**（本轮 inbound msg_id）走被动
              // 回复；锚点不可用时逐张降级主动。
              const cardResult = await sendQuestionMessage({
                account,
                accountId: account.accountId,
                to: qualifiedTarget,
                text: cardText,
                keyboard: keyboard as never,
                anchorMsgId: envelope.messageId,
                log: dlog,
              });
              if (cardResult.error) {
                throw new Error(`question card send failed: ${cardResult.error}`);
              }
              outboundSendOk++;
            }
            // 标记流式控制器：内容已通过外部通道投递，finalize 不走 fallback
            if (!preambleFailed) streamingController?.markDeliveredExternally();
            dlog?.debug(`[question] sent multi-question ask_user questionId=${questionId} questions=${questions.length}`);
            return;
          } catch (err) {
            outboundSendFail++;
            dlog?.error(`[question] multi-question send failed: ${err instanceof Error ? err.message : String(err)}`);
            // 已发出的卡片仍可点选；此处走纯文本兜底补全未送达部分
          }
        } else {
          dlog?.debug(`[question] multi-question prompt unparseable questionId=${questionId}; plain text`);
        }
      }

      // ── 1. block: 媒体/语音立即发送，文本留给流式 ──
      // 注：static 模式已显式 disableBlockStreaming:true，kind:'block' 不会再触发；
      // 此分支保留以兼容 stream 模式与未来变化。
      if (kind === 'block') {
        if (payload.audioAsVoice) {
          // 已取消的 turn 不发语音（TTS 合成 + 投递都是耗时操作，取消后仍发
          // 等于把用户已经放弃的回复推过去——PR #81 复审 R1）
          if (!combinedAbortSignal.aborted) {
            await deliverReply(payload, info, deliverCtx);
          }
        } else if (!combinedAbortSignal.aborted) {
          // 已取消的 turn 不发附件（PR #81 评审 N3：取消后仍收到媒体）
          outboundSendFail += await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog, combinedAbortSignal);
        }
      }

      // ── 2. 流式路径：流式已启动且未降级 -> 跳过静态发送 ──
      // 例外：isError payload（agent run 失败通知）必须落到默认路径发出。
      // 失败文案从未进入流式通道（模型死在半路），「final 已由流式发过」的
      // 去重假设不成立——早退 return 会把通知吞掉，用户只见首分片后静默
      // （issue #8：静态流式首分片 1062 字符已发，模型超时后无任何提示）。
      if (streamingController?.hasStarted && !streamingController?.shouldFallbackToStatic) {
        // final 的未流出尾巴（usage footer 等）先**并入流式通道**，与正文合成
        // 同一条消息（QQ 无消息编辑 API，正文发出后不可追加；telegram 靠编辑
        // 最终消息实现同样效果）：stream → 前缀增长推入当前流式会话，随
        // complete 收尾；static → 并入待发缓冲，随 sendStatic 一条发出。
        // isError payload 走默认路径整段重发，不吸收（会与正文重复）。
        // 吸收不了的残余场景（终态 / stream 无会话 / static 缓冲已 flush）
        // 由 dispatch 末尾 [stream-final] 段兜底单独补发。已取消的 turn
        // （合并 signal 中止）不吸收——取消的回复不应继续增长（finalize
        // 仍会关闭会话，只是不再追加内容）。
        if (kind === 'final' && text && payload.isError !== true && !combinedAbortSignal.aborted) {
          // 观测：framework 确实投递了带文本的 final payload（issue #44 排障的
          // 决定性事实——没有这条说明问题不在差量对账，而在框架未投递 final）
          dlog?.info(`[stream-final] payload received chars=${text.length}`);
          // signal 同时传入：回调入队后、执行前的中止窗口（TOCTOU）在
          // controller 内重查
          await streamingController.absorbFinalText(text, { signal: combinedAbortSignal });
        }
        if (streamingController.isStaticSendMode) {
          // static 模式：flush 主路径由 onToolStart 驱动（工具开始前，绕开 SDK
          // block streaming 的 coalescer，避免 minChars=800/idleMs=1000 buffer 延迟）。
          // 这里仅兜底：deliver(kind:'tool') 时再 flush 一次（controller 内部去重，
          // buffer 已空时 flushSegment 无副作用）。
          if (kind === 'tool') {
            await streamingController.flushSegment({ signal: combinedAbortSignal });
          }
          // park 补位（issue #80）：dispatch 已收尾（inboundRun 因 follow-up 注入
          // 提前 resolve，controller 被 park 而非终态化），不会再有「dispatch 末尾
          // 的 finalize」——final 是这个 delivery context 的最后一个事件，上方
          // absorb 已把终稿并入缓冲，此处补位收尾把最后一段发出。
          // 已取消的 turn 不补位（评审意见 3）：取消的回复不应再发出内容。
          if (kind === 'final' && streamingController.parked && !combinedAbortSignal.aborted) {
            await streamingController.finalize();
            // 补位收尾发送失败（sendStatic 抛错 → failed）：终稿未送达，且
            // dispatch 已 return、末尾差量/失败兜底都不会再跑——落回默认路径
            // 整段补发（评审意见 1；isError 本就自然走默认路径，不在此重复）
            if (streamingController.currentPhase === 'failed' && text && payload.isError !== true) {
              dlog?.warn(`parked finalize send failed — delivering final via default path chars=${text.length}`);
              const rescuePayload = filterDeliveredMedia(payload, deliveredMediaUrls);
              await deliverReply(rescuePayload, info, deliverCtx);
              deliveredTexts.add(text);
              return;
            }
          }
          // 其余情况 static 模式不 finalize（finalize 会进入终态并造成后续丢失）
        } else if (kind === 'tool') {
          // stream 模式：工具调用 = **段边界**（工具执行前模型的文本已经说完）
          // → 封口当前段（收尾这条消息），**不终止整轮**：工具返回后的正文
          // 另起一条消息完整送达。旧实现在这里直接 finalize（进入终态），
          // 工具后的整段正文既不进缓冲又算不出差量 → 静默丢失
          // （issue #67 的丢内容面）。
          await streamingController.closeSegment('tool_call', { signal: combinedAbortSignal });
        } else if (kind === 'final') {
          // stream 模式：**仅**在终稿时收尾整轮。段边界由框架
          // onAssistantMessageStart（+ 工具调用）驱动。
          // 快照 park 状态：finalize 的终态转移会清掉 _parked（评审 L1），
          // 下方补发门控须用进入分支前的值
          const wasParked = streamingController.parked;
          await streamingController.finalize();
          // park 场景（issue #80）：dispatch 已 return，末尾 [stream-final] 差量
          // 兜底不会再跑——final 的未流出尾巴（usage footer 等）在此直接补发。
          // 覆盖「上一段已封口、无活动会话，absorb 接不住 extension」的残余
          // 路径（评审意见 5）；非 park 时 dispatch 末尾兜底仍兜得住（absorb
          // 已把尾巴推入会话时 remainder 为空串，不会重复发送）。
          // isError payload 不补尾巴：它随后由默认路径整段发出（正文 + 错误
          // 提示），先发尾巴再发整段 = 用户看到两份内容（PR #81 评审 N6）。
          if (
            wasParked && text
            && payload.isError !== true
            && !combinedAbortSignal.aborted
            && !streamingController.shouldSuppressFinalTailFallback
          ) {
            await sendFinalTailRemainder(text, 'parked late tail');
          }
        }
        // 流式早退前转发 final/tool 携带的媒体（评审意见 4）：早退 return 后
        // 默认路径（含媒体发送）不可达，不在此转发即丢失。block 媒体已在上方
        // kind==='block' 分支转发；deliveredMediaUrls 去重防双重发送，失败
        // 不标记（forwardMediaUrls 内处理）并计入失败统计（评审 M1）。
        if ((kind === 'final' || kind === 'tool') && !combinedAbortSignal.aborted) {
          // 已取消的 turn 不发附件（PR #81 评审 N3：取消后仍收到媒体）
          outboundSendFail += await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog, combinedAbortSignal);
        }
        if (payload.isError === true) {
          dlog?.info(`run-failure notice bypasses streaming dedup (kind=${kind ?? 'none'} textLen=${text.length})`);
        } else if (!streamingController.shouldFallbackToStatic) {
          // final 文本暂存：absorbFinalText 未能并入（终态 / stream 无会话 /
          // static 缓冲已 flush 后重算仍有增量等）的残余场景，由 dispatch
          // 末尾 [stream-final] 段按前缀差量兜底单独补发。
          // ⚠️ parked 场景（dispatch 已 return）此暂存无人消费——消费者在
          // dispatch 尾部、早已跑完；尾巴已由上方 parked 分支就地补发。这里
          // 是为非 parked 路径维持既有契约，读起来别误当「已被覆盖」
          // （PR #81 评审 L2）
          if (kind === 'final' && text) {
            pendingStreamFinalText = text;
          }
          return;
        } else {
          dlog?.warn(`streaming fallback to static`);
        }
      }

      // ── 3. 文本去重：同文本已发过 -> 跳过 ──
      if (kind === 'final' && !hasMedia && text && deliveredTexts.has(text)) {
        return;
      }

      // ── 4. tool 媒体：立即转发（static 流式路径已在上方 flush 文本）──
      if (kind === 'tool') {
        if (!combinedAbortSignal.aborted) {
          outboundSendFail += await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog, combinedAbortSignal);
        }
        return;
      }

      // ── 5. 默认路径：过滤已发媒体 + 发送 ──
      const filteredPayload = filterDeliveredMedia(payload, deliveredMediaUrls);
      await deliverReply(filteredPayload, info, deliverCtx);
      if (text) deliveredTexts.add(text);
    } catch (err) {
      deliverErrorCount++;
      dlog?.error(`deliver error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // Turn adoption lifecycle（群聊/私聊差异化）：
  // - 私聊：exclusive + abortSignal，新消息取消旧消息（用户可"插嘴"）
  // - 群聊：exclusive（框架 durable ingress 约定，对齐 telegram；cancel-only 是
  //   gateway chat.send 的取消身份语义，不适用于通道入站）且不传 abortSignal——
  //   新消息由框架 followup 队列排队，不打断正在处理的 turn
  const turnAbort = new AbortController();
  const admission = 'exclusive' as const;
  // 仅私聊允许插嘴取消；群聊不打断（排队由框架 followup 队列处理）
  const interruptible = !isGroup;

  // turn 入队信号：恰好一次（deferred → adopted 等多次 lane 决策不重复触发）。
  // 从 lane 决策钩子触发（见 DispatchToOpenClawOptions.onTurnSubmitted 注释），
  // 不在 inboundRun 调用时触发——那会在 turn 真正入队前放行同 key 链。
  let turnSubmittedNotified = false;
  const notifyTurnSubmitted = () => {
    if (turnSubmittedNotified) return;
    turnSubmittedNotified = true;
    opts?.onTurnSubmitted?.();
  };

  const turnAdoptionLifecycle = {
    admission,
    abortSignal: interruptible ? turnAbort.signal : undefined,
    onAdopted: () => {
      dlog?.debug(`turn adopted (exclusive, ${isGroup ? 'group' : 'c2c'}) sessionKey=${route.sessionKey}`);
      notifyTurnSubmitted();
    },
    onDeferred: () => {
      dlog?.debug(`turn deferred behind active turn sessionKey=${route.sessionKey}`);
      notifyTurnSubmitted();
    },
    onAbandoned: () => {
      if (interruptible) {
        dlog?.info(`turn abandoned (superseded) — aborting sessionKey=${route.sessionKey}`);
        turnAbort.abort();
      } else {
        dlog?.info(`group turn abandoned without owning reply lane sessionKey=${route.sessionKey}`);
      }
      // 防御路径：未经采纳/排队即被弃的 turn，链同样该放行
      notifyTurnSubmitted();
    },
  };
  const combinedAbortSignal = interruptible
    ? combineAbortSignals(ctx.signal, turnAbort.signal)
    : ctx.signal;

  // ── Progress Card（进度卡片）──
  // agent 更新 progress_card 时把 checklist 快照作为独立 QQ 消息发送
  // （QQ 无消息编辑 API，做不到 telegram 的单条 draft 反复编辑）。
  // 启用条件：总开关 + scope 匹配（默认仅 c2c）+ 非 room_event（room_event
  // 群框架本就不转发 plan 回调，这里是双保险）。卡片**先走被动回复**
  // （passiveOnly）；反应式配额下无本地次数门。锚点无存活 / 平台判死
  // （40034005·40034128）⇒ 卡片按「前置消息」降级为主动发送（烧每日
  // 1000 条主动预算，用户仍能看到进度），由发布器请求 allowActiveFallback。
  const progressCardConfig = resolveProgressCardConfig(account);
  const progressCardScopeMatch = envelope.chatScope === 'group'
    ? progressCardConfig.scope === 'group' || progressCardConfig.scope === 'both'
    : progressCardConfig.scope === 'c2c' || progressCardConfig.scope === 'both';
  const progressPublisher = progressCardConfig.enabled && progressCardScopeMatch && inboundEventKind !== 'room_event'
    ? new ProgressCardPublisher({
        config: progressCardConfig,
        sendCard: (text, opts) => sendText({
          to: qualifiedTarget,
          text,
          accountId: account.accountId,
          // 主动降级 ⇒ 不挂锚点、不走 passiveOnly ⇒ 网关走主动通道并计入
          // 每日主动预算；否则挂 turn 源消息锚点走被动回复。
          replyToId: opts?.allowActiveFallback ? undefined : envelope.messageId,
          account,
          passiveOnly: !opts?.allowActiveFallback,
        }),
        signal: combinedAbortSignal,
        log: log?.child('progress-card'),
      })
    : null;

  let dispatchError: unknown;
  const hadDispatchError = () => dispatchError !== undefined;

  // ── 群 turn 在途标记（"正在工作"信号，2026-10-23）──
  // 框架没有向通道插件暴露"某会话是否正在工作"的查询 API，但插件自己知道：
  // 下面的 `await adapters.inboundRun!(...)` 在**该 turn 被采纳并跑完**时
  // resolve。计数供 features/group-merge.ts 判定"该攒批还是直发"，并在归零
  // 时触发合批冲刷（turn 结束 → 攒下的消息一次性发出）。
  // ⚠️ 被框架**排队**（defer）的 turn 会在仅入队时就 resolve ⇒ busy 提前
  //    归零（口径失真，详见 features/group-session-busy.ts 头注释）。
  //
  // **标记点必须紧贴 try/finally**（评审修复）：早前放在函数入口，与
  // 归零点之间隔着数百行同步代码——其中任一处同步抛错都会让异常直接
  // 传播出本函数、finally 根本不执行 ⇒ 该群 busy 永久为 1 ⇒ 之后所有
  // 群消息全部进批、且只能靠 maxHoldMs 兜底放出（系统性延迟 5 分钟，
  // 静默无感）。挪到 try 前无行为差异：此处到 try 之间全是同步代码
  // （无顶层 await），单线程下不会有别的入站消息在此窗口被处理。
  if (groupTurnOpenid) markGroupTurnStarted(account.accountId, groupTurnOpenid);

  try {
    await adapters.inboundRun!({
      channel: 'qqbot',
      accountId: route.accountId,
      raw: envelope,
      adapter: {
        ingest: (raw: any) => ({
          id: envelope.messageId,
          rawText: assembled.rawBody,
          textForAgent: assembled.agentBody,
          textForCommands: assembled.rawBody,
          raw,
        }),
        resolveTurn: (_input: unknown, _eventClass: unknown, _preflight: unknown) => ({
          channel: 'qqbot',
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: adapters.recordInboundSession,
          record: {
            onRecordError: (err: unknown) => {
              dlog?.error(`Session record error: ${err}`);
            },
          },
          runDispatchLifecycle: {
            // 同一 lifecycle 对象必须同时出现在 runDispatchLifecycle 与
            // replyOptions.turnAdoptionLifecycle（框架校验所有权一致性）。
            turnAdoptionLifecycle,
            onDispatchSkipped: (reason: string) => {
              dlog?.info(`dispatch skipped reason=${reason} sessionKey=${route.sessionKey}`);
            },
          },
          runDispatch: () => {
            return adapters.dispatchReply!({
              ctx: ctxPayload,
              cfg,
              dispatcherOptions: {
                deliver: deliverHandler,
              },
              replyOptions: {
                abortSignal: combinedAbortSignal,
                runId: envelope.messageId,
                turnAdoptionLifecycle,
                ...(queueModeOverride ? { queueModeOverride } : {}),
                // 可见回复模式（对齐框架 source-reply-delivery-mode 的裁决）：
                // - room_event turn → 严格投递（message_tool_only）：最终文本不投递，
                //   发言必须走 message 工具
                // - user_request turn → 按 messages.groupChat.visibleReplies 走
                //   （默认 automatic = 现状：最终文本自动投递）
                // 传 undefined 时框架会按自己的配置裁决，这里显式传是为了让
                // "房间静默"这件事在插件侧可断言、可观测。
                ...(turnVisibleReplies === 'message_tool'
                  ? { sourceReplyDeliveryMode: 'message_tool_only' as const }
                  : {}),
                ...(streamingController?.isStaticSendMode
                  ? {
                      // 对齐 telegram 模式一：显式关掉 SDK block streaming，绕开 coalescer
                      // （minChars=800/idleMs=1000 的 buffer 会造成文本延迟）。
                      // 文本由 onPartialReply 累积，边界由 onToolStart 自己监听 flush。
                      disableBlockStreaming: true,
                      // 让 onToolStart 在 verbose 关闭时也能触发
                      // （默认受 requiresToolSummaryVisibility 门控，verbose off 时不触发）
                      allowToolLifecycleWhenProgressHidden: true,
                      // 工具【开始执行前】触发：把已累积的上一段文本立即发出
                      // （不等工具执行完，对齐 telegram prepareAnswerLaneForToolProgress）。
                      // 已取消的 turn（评审意见 3）：中止信号已置位时不再承接/发送。
                      onToolStart: async () => {
                        if (combinedAbortSignal.aborted) return;
                        await streamingController.flushSegment({ signal: combinedAbortSignal });
                      },
                    }
                  : {}),
                ...(streamingController
                  ? {
                      onPartialReply: async (p: { text?: string }) => {
                        if (p.text && !combinedAbortSignal.aborted) {
                          // signal 传入：回调入队后、执行前仍可能中止（TOCTOU），
                          // controller 内在实际执行时复查（PR #81 评审 N2）
                          await streamingController.onPartialReply(p.text, { signal: combinedAbortSignal });
                        }
                      },
                      // 兜底：block 信号未覆盖的边界（如部分 provider 不发 text_end）
                      // 仍由 onAssistantMessageStart 触发分段。
                      // static 模式 = 固化上一段；stream 模式 = 封口上一段
                      // （整段保留、拼进同一条消息），两种模式都不再靠长度
                      // 启发式猜边界（issue #67）。已取消的 turn 同样不承接（评审意见 3）。
                      onAssistantMessageStart: streamingController.isStaticSendMode
                        ? async () => {
                            if (combinedAbortSignal.aborted) return;
                            await streamingController.flushSegment({ signal: combinedAbortSignal });
                          }
                        : async () => {
                            if (combinedAbortSignal.aborted) return;
                            await streamingController.beginSegment({ signal: combinedAbortSignal });
                          },
                    }
                  : {}),
                ...(progressPublisher
                  ? {
                      // progress_card 卡片快照：每次步骤更新发一条独立消息
                      // （渲染/节流/配额语义见 progress-card-publisher.ts 头注释）
                      onPlanUpdate: async (p: {
                        phase?: string;
                        title?: string;
                        explanation?: string;
                        // 契约字段：note 形态（markdown-only）投影的 "plain"
                        // 标记——与 PlanUpdatePayload 保持一致，将来重构做字段
                        // 挑选时不静默丢字段（评审 #87-F3）
                        explanationFormat?: string;
                        source?: string;
                        steps?: Array<{ step?: unknown; status?: unknown }>;
                      }) => {
                        await progressPublisher.onPlanUpdate(p);
                      },
                      // 解锁 verbose 关闭时的 plan 回调转发（quiet channel-owned
                      // progress 标志）。该标志本身不抑制任何框架行为——插件
                      // 未注册 onApprovalEvent/onPatchSummary，解锁对其是 no-op；
                      // 抑制框架默认计划状态消息的是另一个标志（刻意不传，
                      // verbose 用户的工具进度状态消息现状保持不变）。
                      suppressDefaultToolProgressMessages: true,
                    }
                  : {}),
              },
            });
          },
        }),
      },
    });
  } catch (err) {
    dispatchError = err;
    dlog?.error(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // 群 turn 在途计数归零 → 触发合批冲刷（攒批的消息一次性发出）
    if (groupTurnOpenid) markGroupTurnFinished(account.accountId, groupTurnOpenid);
  }

  dlog?.debug(`dispatch completed sessionKey=${route.sessionKey}`);

  // 群消息回复后处理历史缓存：
  // - clear（默认）：整清，下次 @ 时组包"自上次回复以来"的窗口
  // - rolling：裁剪到最后一条 bot 出站之后（bot 发言也计入历史，
  //   AI 下次可看到自己上次说到哪；对齐 telegram selectAfterLastSelf）
  if (envelope.chatScope === 'group' && envelope.groupId) {
    const groupCfg = resolveGroupConfigFromAccount(account, envelope.groupId);
    if (groupCfg.historyMode === 'rolling') {
      const kept = trimGroupHistoryAfterLastBot(account.accountId, envelope.groupId, groupCfg.historyLimit);
      dlog?.debug(`[history] rolling trim group=${envelope.groupId} kept=${kept}`);
    } else {
      clearGroupHistory(account.accountId, envelope.groupId);
    }
  } else if (envelope.chatScope === 'group') {
    clearGroupHistory(account.accountId, envelope.senderId);
  }

  // Progress card：dispatch 收尾，停止发布（无定时器，纯状态关闭）
  progressPublisher?.dispose();

  // 流式收尾：**取消感知的 finalize**（PR #81 复审 R2）
  // 已取消 / 被插嘴取代的 turn 不发取消前累积的内容（static 模式的 finalize
  // 会把缓冲整段发出）——改为 abort：只收尾流式会话（DONE 帧，防草稿气泡
  // 永久悬挂），缓冲内容丢弃并留 WARN。
  //
  // 依据：combinedAbortSignal 在**正常完成的 c2c turn 收尾时不会中止**
  // ——同一处的 [stream-final] 尾巴兜底同样以 `!combinedAbortSignal.aborted`
  // 为前提，/usage footer 能正常送达即证明这一点（该信号只在取消 / 被取代
  // 时置位）。
  if (streamingController) {
    if (combinedAbortSignal.aborted) {
      streamingCancelled = true;
      await streamingController.abort('cancelled');
    } else if (!streamingController.isTerminal) {
      await streamingController.finalize();
    }
  }

  // ── 流式 final 差量补发（/usage tokens|full footer 等）──
  // 框架在模型输出完成后才把 usage 行追加到 final payload 文本尾部（框架
  // appendUsageLine）；telegram 用 final 文本整体收尾天然带上，QQ 流式已发
  // 前缀不可回改 → 按前缀差量把未流出尾巴作为独立消息补发。放在 finalize
  // 之后保证顺序（static 模式最后一段先落地，footer 随后）。
  // 两类不补发：请求已取消（合并信号 = ctx.signal + turnAbort，任一中止
  // 都不发已取消 turn 的 footer）；正文确定未送达（shouldSuppressFinalTail-
  // Fallback：static 模式 sendStatic 失败、或 stream 无任何已接受分片——
  // stream 在正文已可见后 failed 的情形【如 absorb 的 footer update 被拒】
  // 不抑制，footer 仍走兜底）。
  if (
    streamingController
    && pendingStreamFinalText !== undefined
    && !combinedAbortSignal.aborted
    && !streamingController.shouldSuppressFinalTailFallback
  ) {
    const tailSent = await sendFinalTailRemainder(pendingStreamFinalText, 'appending unsent final tail');
    if (!tailSent) {
      // 三种「没发」：无尾巴（已由流式承接）/ 已被其他投递认领 / 发送失败
      // （失败路径内部已记 ERROR）——文案别把失败说成「已被覆盖」
      dlog?.debug?.(`[stream-final] no unsent final tail to send (covered / claimed / failed) chars=${pendingStreamFinalText.length}`);
    }
  }

  if (debouncer) {
    await debouncer.flushAll();
  }

  // 失败兜底（对齐 telegram）：dispatch 抛错、deliver 抛错或底层发送失败，
  // 且用户未收到任何可见回复时，发送兜底消息而非静默失败。
  //
  // room_event turn 例外：被动房间事件的语义是"AI 只在被叫醒时说话"，
  // 错误兜底属于系统噪声——群里每条消息都跑一次 turn，provider 抖动会刷屏。
  // 该场景只记日志（下方 warn/error 已覆盖），房间保持安静。
  // 注意：room_event 群里**被 @ 的那条**是 user_request turn，仍会发兜底。
  if (
    (hadDispatchError() || deliverErrorCount > 0 || outboundSendFail > 0)
    && !turnAbort.signal.aborted
    && !streamingCancelled
    && inboundEventKind !== 'room_event'
  ) {
    const streamedVisible = !!streamingController
      && streamingController.currentPhase !== 'failed'
      && (streamingController.currentPhase === 'done' || streamingController.hasSentChunks);
    const deliveredVisible =
      streamedVisible || outboundSendOk > 0 || deliveredMediaUrls.size > 0;
    if (!deliveredVisible) {
      dlog?.warn(
        `sending failure fallback (deliverErrors=${deliverErrorCount} sendFails=${outboundSendFail} dispatchError=${hadDispatchError()}) to ${qualifiedTarget}`,
      );
      try {
        const result = await sendText({
          to: qualifiedTarget,
          text: FAILURE_FALLBACK_TEXT,
          accountId: account.accountId,
          replyToId: envelope.messageId,
          account,
        });
        if (result.error) {
          dlog?.error(`failure fallback sendText failed: ${result.error}`);
        }
      } catch (err) {
        dlog?.error(`failure fallback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 保持原有错误传播语义：错误上报给 event-handlers 记录日志
  if (hadDispatchError()) {
    throw dispatchError;
  }
}

function createStreamingController(
  envelope: ReturnType<typeof buildEnvelope>,
  account: ResolvedQQBotAccount,
  log?: PluginLogger,
): StreamingController | null {
  const gw = getGateway(account.accountId);
  if (!gw) {
    log?.error(`cannot enable streaming — gateway not running`);
    return null;
  }

  // sendMode: 默认 'stream'（QQ 流式打印机），可选 'static'（普通 sendText 收尾）
  const streamingCfg = account.config?.streaming as
    | { sendMode?: 'stream' | 'static' }
    | undefined;
  const sendMode = streamingCfg?.sendMode === 'static' ? 'static' : 'stream';

  // 普通消息通道（sendText）：
  // - static 模式：finalize 收尾时用一条普通 sendText 发完整文本（主通道）；
  // - stream 模式：仅兜底补发通道——终稿与已流出内容无关且本段从未流出时，
  //   整段补发（否则那段正文会静默丢失，issue #67）。
  // 失败必须抛错——controller 的 completeSession/flushSegment 靠异常把
  // 终态转为 failed（吞错会让它把失败的正文记为已投递，进而照常补发
  // footer，用户只见 footer 不见正文）
  const sendStatic = async (fullText: string) => {
    const result = await sendText({
      to: envelope.senderId,
      text: fullText,
      accountId: account.accountId,
      replyToId: envelope.messageId,
      account,
    });
    if (result.error) {
      throw new Error(`static sendText failed: ${result.error}`);
    }
  };

  return new StreamingController({
    gateway: gw,
    target: {
      scope: 'c2c',
      targetId: envelope.senderId,
      msgId: envelope.messageId,
    },
    accountId: account.accountId,
    replyToId: envelope.messageId,
    log,
    sendMode,
    sendStatic,
  });
}

// ── 辅助函数 ──

/**
 * 提取 payload 中的媒体 URL 并逐个发送（去重），返回发送失败数。
 *
 * 媒体集合口径与默认路径（deliver-pipeline 的 resolveMediaUrls）**完全一致**：
 * mediaUrls → mediaUrl → attachments[].url/path，列表内去重——流式早退路径
 * 与默认路径必须对同一 payload 解析出同一组媒体，否则会出现「一边发一边丢」
 * 或「重复发送」（PR #81 评审 N4：attachments 被丢弃 / N7：重复 URL 重复发送）。
 *
 * 发送失败时给用户一条可见提示（与默认路径 sendMediaUrls 同口径，评审 N5）：
 * 流式早退路径绕过了 deliverReply，失败若只记日志，附件静默丢失、用户毫无察觉。
 */
async function forwardMediaUrls(
  payload: DeliverPayload,
  ctx: DeliverContext,
  delivered: Set<string>,
  log?: PluginLogger,
  signal?: AbortSignal,
): Promise<number> {
  const urls = resolveMediaUrls(payload);
  const newUrls = urls.filter((u) => !delivered.has(u));
  let failures = 0;
  for (const url of newUrls) {
    // 逐条复查取消信号：媒体转发是逐个 await 的长过程，取消后不应继续发
    // （PR #81 复审 R1：取消后仍收到媒体）
    if (signal?.aborted) {
      log?.info('media forward skipped: turn cancelled');
      break;
    }
    try {
      const result = await sendMedia({
        to: ctx.qualifiedTarget,
        source: url,
        text: '',
        replyToId: ctx.replyToId,
        accountId: ctx.accountId,
        log: ctx.log,
        agentId: ctx.agentId,
      });
      if (result.error) {
        // 发送失败【不】标记已投递：sendMedia 失败时返回 {error} 而非抛错
        // （media-send 各失败路径均不 throw），无条件 add 会让
        // filterDeliveredMedia 把该 URL 从默认路径剥掉——重试与 deliverReply
        // 的「媒体发送失败」提示双双失效，媒体静默丢失（PR #81 评审 M1）
        failures++;
        log?.error(`media forward failed: ${result.error}`);
        continue;
      }
      delivered.add(url);
    } catch (err) {
      failures++;
      log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures > 0) {
    const notice = formatMediaFailureNotice(failures, urls.length);
    try {
      const result = await ctx.sendText(ctx.qualifiedTarget, notice);
      if (result.error) {
        log?.error(`media failure notice send failed: ${result.error}`);
      }
    } catch (err) {
      log?.error(`media failure notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return failures;
}

/** 过滤已发送的媒体 URL */
function filterDeliveredMedia(
  payload: DeliverPayload,
  delivered: Set<string>,
): DeliverPayload {
  if (delivered.size === 0) return payload;
  const attachments = (payload as any).attachments as Array<{ path?: string; url?: string }> | undefined;
  return {
    ...payload,
    mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
    mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
    // attachments 同样可能被流式早退路径转发过（resolveMediaUrls 的第三档来源）
    // ——不过滤会在补发路径重复发送同一附件（PR #81 评审 N4）
    ...(attachments
      ? {
          attachments: attachments.filter((a) => {
            const key = a?.url ?? a?.path;
            return !(typeof key === 'string' && delivered.has(key));
          }),
        }
      : {}),
  };
}
