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
import { sendMedia } from '../outbound/media-send.js';
import { deliverReply, type DeliverPayload, type DeliverInfo, type DeliverContext } from '../outbound/deliver-pipeline.js';
import { buildCtxPayload } from './ctx-builder.js';

import { DeliverDebouncer } from '../outbound/debounce.js';
import { StreamingController, shouldUseStreaming } from '../outbound/streaming-controller.js';
import { getAdapters } from '../adapter/resolve.js';
import { clearGroupHistory, trimGroupHistoryAfterLastBot } from '../features/history-store.js';
import {
  isAskUserPayload,
  isNonSingleAskUserPayload,
  buildQuestionKeyboard,
  buildMultiQuestionKeyboard,
  formatMultiQuestionCard,
  parseMultiQuestionPrompt,
  registerPendingMultiQuestion,
  getQuestionGatewayRuntime,
} from '../features/question-helpers.js';
import { tryGetBotForAccount } from '../bot-instance.js';
import { resolveGroupConfigFromAccount, resolveMentionPatterns } from '../config.js';
import { detectWasMentioned } from '../utils/mention.js';

/** 失败兜底文案（对齐 telegram：Something went wrong while processing your request.） */
const FAILURE_FALLBACK_TEXT = 'Something went wrong while processing your request. Please try again.';

/** 每进程只打一次「框架排队已接管线」INFO（排障锚点，确认 collect 真实生效） */
let frameworkQueueAnnounced = false;

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


/**
 * 将经过中间件处理的入站消息转发给 OpenClaw AI
 */
export async function dispatchToOpenClaw(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<void> {
  const dlog = log?.child('dispatch');
  const adapters = getAdapters(runtime, dlog);
  const envelope = buildEnvelope(ctx, msg, account);

  dlog?.debug(`received sender=${envelope.senderId} scope=${envelope.chatScope} msgId=${envelope.messageId}`);

  if (!adapters.inboundRun || !adapters.dispatchReply) {
    dlog?.error(`runtime adapter inboundRun/dispatchReply not available (openclaw=${adapters.version}, requires >=2026.9.2)`);
    return;
  }

  const assembled: AssembledBody =
    ((ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
    assembleBody(ctx, msg, account);

  const cfg = adapters.getConfig?.() ?? {};

  const isGroup = envelope.chatScope === 'group';

  // 群聊/私聊差异化 sessionKey：
  // - 群聊：group:{groupId}:coalescing 后缀（历史遗留命名，保留以延续存量群会话 lane；
  //   排队/合并现已由框架 followup 队列按该 sessionKey 处理）
  // - 私聊：保持原有格式，允许用户"插嘴"（新消息取消旧消息）
  const peerId = envelope.chatScope === 'group' 
    ? (envelope.groupId ?? envelope.senderId) 
    : envelope.senderId;

  const route = adapters.resolveAgentRoute?.({
    cfg,
    channel: 'qqbot',
    accountId: account.accountId,
    peer: {
      kind: envelope.chatScope === 'group' ? 'group' : 'direct',
      id: peerId,
    },
  }) ?? { 
    sessionKey: isGroup 
      ? `qqbot:${account.accountId}:group:${peerId}:coalescing`
      : `qqbot:${account.accountId}:${peerId}`, 
    accountId: account.accountId 
  };

  const qualifiedTarget = envelope.targetId;
  const agentId = route.agentId ?? 'default';

  // ── 群聊排队策略（排队/合并交给框架 followup 队列）──
  // - enabled=true  → collect：活动 turn 期间到达的消息排队并在其后合并批处理
  // - enabled=false → followup：排队但不合并（尊重「关闭合并」的意图，
  //                   仍保证不打断活动 turn——远比框架默认 steer 插嘴安全）
  const groupCfg = isGroup && envelope.groupId
    ? resolveGroupConfigFromAccount(account, envelope.groupId)
    : undefined;
  const queueModeOverride = groupCfg
    ? (groupCfg.coalesce.enabled ? 'collect' as const : 'followup' as const)
    : undefined;

  // ── room_event 分类（全量模式群的被动房间事件）──
  // wasMentioned 三种唤醒方式：@（AT 事件 / mentions.is_you / 内容标记，由
  // mentionGate 判定）、称呼（mentionPatterns，如「沈处」）、引用 bot 出站
  // （mentionGate isImplicitMention）。均未命中且群开启 room_event 时，
  // 该消息作为被动房间事件进框架：AI 只读上下文，最终文本不投递
  // （message_tool_only），想发言走主动 message 工具；框架自动压 typing/
  // 流式、排队不 steer。斜杠命令始终是显式用户意图 → user_request。
  const mentionState = (ctx.state as { mention?: { wasMentioned?: boolean; implicit?: boolean } }).mention;
  const nameMentioned = isGroup
    ? detectWasMentioned({
        eventType: (msg as { rawEventType?: string }).rawEventType,
        mentions: (msg as { mentions?: Array<{ is_you?: boolean }> }).mentions,
        content: msg.content,
        mentionPatterns: resolveMentionPatterns(cfg, agentId),
      })
    : false;
  const wasMentioned = !!(mentionState?.wasMentioned || mentionState?.implicit || nameMentioned);
  const isSlash = /^\//.test(assembled.rawBody ?? '');
  const inboundEventKind =
    isGroup && groupCfg?.unmentionedInbound === 'room_event' && !wasMentioned && !isSlash
      ? 'room_event' as const
      : 'user_request' as const;

  // 分类可观测性：room_event 事件触发一次推理 pass（成本排障命门），必须留痕；
  // room_event 群里被唤醒为 user_request 时标注唤醒来源（@/称呼/引用），
  // 便于观察 mentionPatterns 与引用唤醒的实际命中
  if (inboundEventKind === 'room_event') {
    dlog?.info(
      `[room-event] passive room event group=${envelope.groupId} sender=${envelope.senderId} contentLen=${(msg.content ?? '').length}`,
    );
  } else if (isGroup && groupCfg?.unmentionedInbound === 'room_event' && !isSlash) {
    const wakeSource = mentionState?.wasMentioned
      ? 'mention'
      : mentionState?.implicit
        ? 'quote-bot'
        : nameMentioned
          ? 'name-pattern'
          : 'unknown';
    dlog?.info(`[wake] ${wakeSource} → user_request group=${envelope.groupId} sender=${envelope.senderId}`);
  }

  if (queueModeOverride && !frameworkQueueAnnounced) {
    frameworkQueueAnnounced = true;
    dlog?.info(`[queue] group turn queueing delegated to framework followup queue (mode=${queueModeOverride}); plugin coalescer bypassed`);
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
      })
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

  const deliveredMediaUrls = new Set<string>();
  const deliveredTexts = new Set<string>();
  let deliverErrorCount = 0;
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

      // ── 0. ask_user 按钮投递（优先于所有其他处理）──
      // 单问题单选场景：用 inline keyboard 替代纯文本
      const payloadWithChannelData = payload as DeliverPayload & { channelData?: unknown };
      if (isAskUserPayload(payloadWithChannelData as any) && text) {
        const { questionId, optionValues } = (payloadWithChannelData as any).channelData.askUser;
        const questionRuntime = await getQuestionGatewayRuntime();
        {
          const keyboard = buildQuestionKeyboard(questionId, optionValues);
          const bot = tryGetBotForAccount(account.accountId);
          if (bot) {
            const replyTarget = {
              scope: envelope.chatScope === 'group' ? 'group' as const : 'c2c' as const,
              targetId: peerId,
            };
            try {
              await bot.sendTextWithKeyboard(replyTarget, text, keyboard as never);
              outboundSendOk++;
              dlog?.debug(`[question] sent ask_user with keyboard questionId=${questionId} options=${optionValues.length}`);
              return;
            } catch (err) {
              outboundSendFail++;
              dlog?.error(`[question] sendTextWithKeyboard failed: ${err instanceof Error ? err.message : String(err)}`);
              // fallback 到纯文本发送
            }
          }
        }
      }

      // ── 0b. ask_user 多问题投递：每题一条带按钮的消息。
      // 框架对多问题只投递纯文本（无结构化选项），这里从文本反解题目结构；
      // 按钮点选 / isOther 题的文字回复在回调与入站侧缓冲，
      // 集齐后合成一条"用户文本回复"走入站通道，由框架的文本应答
      // 解析器 resolve 挂起的 ask_user ──
      if (isNonSingleAskUserPayload(payloadWithChannelData as any) && text) {
        const { questionId } = (payloadWithChannelData as any).channelData.askUser;
        const questions = parseMultiQuestionPrompt(text);
        if (questions) {
          const bot = tryGetBotForAccount(account.accountId);
          if (bot) {
            const scope = envelope.chatScope === 'group' ? 'group' as const : 'c2c' as const;
            const replyTarget = { scope, targetId: peerId };
            // 先登记再发送，避免用户先点按钮时查无此单
            registerPendingMultiQuestion(questionId, scope, peerId, questions);
            try {
              for (const [index, question] of questions.entries()) {
                const cardText = formatMultiQuestionCard(question, index, questions.length);
                const keyboard = buildMultiQuestionKeyboard(questionId, index, question);
                await bot.sendTextWithKeyboard(replyTarget, cardText, keyboard as never);
                outboundSendOk++;
              }
              dlog?.debug(`[question] sent multi-question ask_user questionId=${questionId} questions=${questions.length}`);
              return;
            } catch (err) {
              outboundSendFail++;
              dlog?.error(`[question] multi-question send failed: ${err instanceof Error ? err.message : String(err)}`);
              // 已发出的卡片仍可点选；此处走纯文本兜底补全未送达部分
            }
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
          await deliverReply(payload, info, deliverCtx);
        } else {
          await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
        }
      }

      // ── 2. 流式路径：流式已启动且未降级 -> 跳过静态发送 ──
      if (streamingController?.hasStarted && !streamingController?.shouldFallbackToStatic) {
        if (streamingController.isStaticSendMode) {
          // static 模式：flush 主路径由 onToolStart 驱动（工具开始前，绕开 SDK
          // block streaming 的 coalescer，避免 minChars=800/idleMs=1000 buffer 延迟）。
          // 这里仅兜底：deliver(kind:'tool') 时再 flush 一次（controller 内部去重，
          // buffer 已空时 flushSegment 无副作用）。
          if (kind === 'tool') {
            await streamingController.flushSegment();
          }
          // static 模式不 finalize（finalize 会进入终态并造成后续丢失）
        } else if (kind !== 'block') {
          // stream 模式：tool/final 时收尾当前打字机流（原行为）
          await streamingController.finalize();
        }
        if (!streamingController.shouldFallbackToStatic) return;
        dlog?.warn(`streaming fallback to static`);
      }

      // ── 3. 文本去重：同文本已发过 -> 跳过 ──
      if (kind === 'final' && !hasMedia && text && deliveredTexts.has(text)) {
        return;
      }

      // ── 4. tool 媒体：立即转发（static 流式路径已在上方 flush 文本）──
      if (kind === 'tool') {
        await forwardMediaUrls(payload, deliverCtx, deliveredMediaUrls, dlog);
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

  const turnAdoptionLifecycle = {
    admission,
    abortSignal: interruptible ? turnAbort.signal : undefined,
    onAdopted: () => {
      dlog?.debug(`turn adopted (exclusive, ${isGroup ? 'group' : 'c2c'}) sessionKey=${route.sessionKey}`);
    },
    onDeferred: () => {
      dlog?.debug(`turn deferred behind active turn sessionKey=${route.sessionKey}`);
    },
    onAbandoned: () => {
      if (interruptible) {
        dlog?.info(`turn abandoned (superseded) — aborting sessionKey=${route.sessionKey}`);
        turnAbort.abort();
      } else {
        dlog?.info(`group turn abandoned without owning reply lane sessionKey=${route.sessionKey}`);
      }
    },
  };
  const combinedAbortSignal = interruptible
    ? combineAbortSignals(ctx.signal, turnAbort.signal)
    : ctx.signal;

  let dispatchError: unknown;
  const hadDispatchError = () => dispatchError !== undefined;

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
                ...(inboundEventKind === 'room_event' ? { sourceReplyDeliveryMode: 'message_tool_only' as const } : {}),
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
                      // （不等工具执行完，对齐 telegram prepareAnswerLaneForToolProgress）
                      onToolStart: async () => { await streamingController.flushSegment(); },
                    }
                  : {}),
                ...(streamingController
                  ? {
                      onPartialReply: async (p: { text?: string }) => {
                        if (p.text) await streamingController.onPartialReply(p.text);
                      },
                      // 兜底：block 信号未覆盖的边界（如部分 provider 不发 text_end）
                      // 仍由 onAssistantMessageStart 触发分段。stream 模式不传，保持原行为。
                      onAssistantMessageStart: streamingController.isStaticSendMode
                        ? async () => { await streamingController.flushSegment(); }
                        : undefined,
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

  if (streamingController && !streamingController.isTerminal) {
    await streamingController.finalize();
  }

  if (debouncer) {
    await debouncer.flushAll();
  }

  // 失败兜底（对齐 telegram）：dispatch 抛错、deliver 抛错或底层发送失败，
  // 且用户未收到任何可见回复时，发送兜底消息而非静默失败。
  if ((hadDispatchError() || deliverErrorCount > 0 || outboundSendFail > 0) && !turnAbort.signal.aborted) {
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

  // static 模式：finalize 收尾时用一条普通 sendText 发完整文本
  const sendStatic = sendMode === 'static'
    ? async (fullText: string) => {
        const result = await sendText({
          to: envelope.senderId,
          text: fullText,
          accountId: account.accountId,
          replyToId: envelope.messageId,
          account,
        });
        if (result.error) {
          log?.error(`static sendText failed: ${result.error}`);
        }
      }
    : undefined;

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

/** 提取 payload 中的媒体 URL 并逐个发送（去重） */
async function forwardMediaUrls(
  payload: DeliverPayload,
  ctx: DeliverContext,
  delivered: Set<string>,
  log?: PluginLogger,
): Promise<void> {
  const urls: string[] = [];
  if (payload.mediaUrls?.length) urls.push(...payload.mediaUrls);
  if (payload.mediaUrl && !urls.includes(payload.mediaUrl)) urls.push(payload.mediaUrl);
  const newUrls = urls.filter((u) => !delivered.has(u));
  for (const url of newUrls) {
    try {
      await sendMedia({
        to: ctx.qualifiedTarget,
        source: url,
        text: '',
        replyToId: ctx.replyToId,
        accountId: ctx.accountId,
        log: ctx.log,
        agentId: ctx.agentId,
      });
      delivered.add(url);
    } catch (err) {
      log?.error(`media forward failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** 过滤已发送的媒体 URL */
function filterDeliveredMedia(
  payload: DeliverPayload,
  delivered: Set<string>,
): DeliverPayload {
  if (delivered.size === 0) return payload;
  return {
    ...payload,
    mediaUrl: payload.mediaUrl && !delivered.has(payload.mediaUrl) ? payload.mediaUrl : undefined,
    mediaUrls: payload.mediaUrls?.filter((u) => !delivered.has(u)),
  };
}
