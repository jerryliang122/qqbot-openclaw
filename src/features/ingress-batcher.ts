/**
 * 群聊持久化入站的**组批与派发**。
 *
 * ## 职责
 *
 * drain 领到一条队首行后，本模块负责：
 * 1. **组批**：把同 lane（同群）里已入队但未派发的消息并进本批；
 * 2. **排序**：按**本地到达时刻**排（不用平台 timestamp——群成员设备时钟
 *    不一致，用平台时间排序会把批次排错）；
 * 3. **裁剪**：沿用既有的条数 / 正文字数上限，丢弃较早的消息并留说明；
 * 4. **装配**：复用 `assembleMergedGroupBody`，正文格式与改造前逐字一致；
 * 5. **幂等**：批次指纹走 `createIngressEffectOnce`，崩溃重投不重复回复；
 * 6. **派发**：走 `dispatchToOpenClaw`，并把 drain lifecycle 接到回复车道
 *    的 turnAdoptionLifecycle 上（turn 被采纳 ⇒ claim 结算）。
 *
 * ## 与内存合批路径的差异
 *
 * 内存路径靠「busy 计数归零」触发冲刷；本模块靠 **durable lane claim**
 * 判定忙闲——框架把 turn defer（仅入队）时 busy 会提前归零，claim 不会。
 *
 * @see features/ingress-queue.ts 队列与 drain 生命周期
 * @see features/ingress-payload.ts 载荷编解码与 ctx 重建
 */

import { createHash } from 'node:crypto';
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ChannelIngressQueueRecord } from 'openclaw/plugin-sdk/channel-outbound';
import { resolveInboundDebounceMs } from 'openclaw/plugin-sdk/channel-inbound';
import { createIngressEffectOnce } from 'openclaw/plugin-sdk/ingress-effect-once';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { assembleMergedGroupBody } from '../dispatch/body-assembler.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { getAdapters } from '../adapter/resolve.js';
import { runWithRequestContext } from '../request-context.js';
import { resolveGroupConfigFromAccount, resolveQQBotAccount } from '../config.js';
import { detectEventMention } from '../utils/mention.js';
import { withDetachedWebhookWork } from './detached-webhook-work.js';
import { mergeProcessedAttachments } from './inbound-debounce.js';
import { resolveWakeDecision } from './room-event.js';
import {
  decodeIngressPayload,
  ingressPayloadOrderKey,
  rebuildIngressMember,
  type QQBotIngressPayload,
} from './ingress-payload.js';
import {
  buildIngressLaneKey,
  setIngressDispatchHandlers,
  type IngressAccountHandle,
  type QQBotIngressClaim,
  type QQBotIngressLifecycle,
} from './ingress-queue.js';
import {
  DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE,
  GROUP_MERGE_MAX_BODY_CHARS,
} from './group-merge.js';

/** 日志缺席时的静默 logger（detached 包裹必须传 logger） */
const SILENT_INGRESS_LOG: PluginLogger = {
  info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
  child: () => SILENT_INGRESS_LOG,
};

/** 幂等守卫的命名空间（**跨版本必须稳定**——改了等于放过一次重复回复） */const EFFECT_NAMESPACE = 'qqbot-group-batch';
/** 幂等记录存活时长：覆盖「副作用提交 → tombstone」的延迟 + 队列墓碑保留期 */
const EFFECT_TTL_MS = 24 * 60 * 60_000;
/** 幂等记录条数上限 */
const EFFECT_MAX_ENTRIES = 5_000;

/**
 * 合批窗口时长上限（毫秒）。
 *
 * 窗口期内 claim 一直持有（租约 5 分钟），窗口过长会让「一条消息等窗口」
 * 变成用户可感知的延迟；框架 c2c 侧同款上限（60s）。
 */
const MAX_GROUP_MERGE_WINDOW_MS = 60_000;

/** 收集窗口内的重读间隔（毫秒）——窗口期内按此节奏重读 lane backlog */
const COLLECT_POLL_MS = 100;

/** 不可重试失败：重投多少次都不会变（载荷版本不认识等） */
export class NonRetryableIngressError extends Error {
  readonly reason: string;
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'NonRetryableIngressError';
    this.reason = reason;
  }
}

/** 幂等守卫（per-account 一个就够：eventId 内含 laneKey，天然跨账号不撞） */
const effectGuards = new Map<string, ReturnType<typeof createIngressEffectOnce>>();

function getEffectGuard(accountId: string): ReturnType<typeof createIngressEffectOnce> {
  const existing = effectGuards.get(accountId);
  if (existing) return existing;
  const guard = createIngressEffectOnce({
    pluginId: 'openclaw-qqbot',
    namespacePrefix: EFFECT_NAMESPACE,
    ttlMs: EFFECT_TTL_MS,
    stateMaxEntries: EFFECT_MAX_ENTRIES,
  });
  effectGuards.set(accountId, guard);
  return guard;
}

/** 批次成员（一条待派发的群消息） */
export interface BatchMember {
  payload: QQBotIngressPayload;
  /** 该成员对应的 claim（队首行由 drain 持有，其余是我们自己领的） */
  claim: QQBotIngressClaim | null;
}

/**
 * 该条消息是否"明确在叫 bot"（@ / 引用 bot / 称呼唤醒）。
 *
 * 口径与 `features/room-event.ts` 的 `resolveWakeDecision` 一致：
 * 门控与分类共用同一份判定，避免"门控放行 + 分类成 room_event"的分裂。
 */
export function isExplicitlyWoken(payload: QQBotIngressPayload): boolean {
  const eventMentioned = detectEventMention({
    eventType: payload.rawEventType,
    mentions: payload.mentions as Array<{ is_you?: boolean }> | undefined,
  });
  const wake = resolveWakeDecision({
    mentionState: {
      wasMentioned: payload.mention.wasMentioned === true || eventMentioned,
      implicit: payload.mention.implicit === true,
    },
    nameMentioned: payload.nameMentioned,
  });
  return wake.wasMentioned;
}

/** 正文体量（与内存路径同款口径：原文 + 语音转写全文 + 附件描述） */
function bodySizeOf(payload: QQBotIngressPayload): number {
  const processed = payload.processedAttachments as ProcessedAttachments | undefined;
  return (
    (payload.rawContent ?? '').length +
    (processed?.voiceText?.length ?? 0) +
    (processed?.otherInfo?.length ?? 0)
  );
}

/**
 * 按容量上限裁剪批次：保留**最新**的消息，超限的较早消息被丢弃。
 *
 * 与内存路径 `trimToCapacity` 同款语义（单条超限仍保留）。
 */
export function trimToCapacity(
  members: BatchMember[],
  maxBatchSize: number,
  maxBodyChars: number,
): { kept: BatchMember[]; dropped: number } {
  const keptReversed: BatchMember[] = [];
  let total = 0;
  for (let i = members.length - 1; i >= 0; i -= 1) {
    if (keptReversed.length >= maxBatchSize) break;
    const size = bodySizeOf(members[i]!.payload);
    if (maxBodyChars > 0 && keptReversed.length > 0 && total + size > maxBodyChars) break;
    keptReversed.push(members[i]!);
    total += size;
  }
  const kept = keptReversed.reverse();
  return { kept, dropped: members.length - kept.length };
}

/**
 * 批次指纹：跨重投必须**完全一致**（幂等守卫的 key）。
 *
 * 用「laneKey + 批内最小/最大 messageId + 条数」——同一批消息无论被重投
 * 多少次、无论谁先谁后，集合相同 ⇒ 指纹相同 ⇒ 只派发一次。
 */
export function batchFingerprint(laneKey: string, kept: BatchMember[]): string {
  const ids = kept.map((m) => m.payload.messageId).sort();
  const min = ids[0] ?? '';
  const max = ids[ids.length - 1] ?? '';
  return createHash('sha256')
    .update(`${laneKey}|${min}|${max}|${ids.length}`)
    .digest('hex');
}

/** 解析账号（热路径：不读盘，凭据已在账号启动时缓存） */
function resolveAccount(handle: IngressAccountHandle): ResolvedQQBotAccount {
  const cfg = (getAdapters(handle.runtime).getConfig?.() ?? {}) as never;
  return resolveQQBotAccount(cfg, handle.accountId);
}

/**
 * 合批窗口时长（毫秒）——**来源是框架的 `resolveInboundDebounceMs(cfg,'qqbot')`**。
 *
 * 不新增群专属配置键 ⇒ `openclaw.plugin.json` 的 `coalesce` 段逐字不动
 * ⇒ 用户已有的 `messages.inbound.byChannel.qqbot.debounceMs` 旋钮**直接生效**
 * （此前群路径用的是插件内硬编码的 `DEFAULT_GROUP_MERGE_WINDOW_MS`，旋钮无效）。
 *
 * ⚠️ 框架该原语**默认返回 0**（不读插件默认、不套 c2c 的 3000）⇒ 未配框架
 * `messages.inbound.*` 时窗口为 0 ⇒ 领到队首行即刻派发（**零延迟**，与改造前
 * 的「空闲时零延迟直发」一致）。只有用户显式配了旋钮才会进入窗口收集。
 */
export function resolveGroupMergeWindowMs(runtime: PluginRuntime): number {
  try {
    const cfg = (getAdapters(runtime).getConfig?.() ?? {}) as never;
    const ms = resolveInboundDebounceMs({ cfg, channel: 'qqbot' });
    if (!Number.isFinite(ms) || ms <= 0) return 0;
    return Math.min(ms, MAX_GROUP_MERGE_WINDOW_MS);
  } catch {
    return 0;
  }
}

/**
 * 可被中止打断的等待（收集窗口用）。
 *
 * claim 被取消（进程退出 / drain dispose）时立刻返回——不让关停等满窗口。
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        resolve();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 读同 lane 的 pending 行（drain 提供；缺失时退化为空） */
async function readLaneBacklog(
  lifecycle: QQBotIngressLifecycle,
): Promise<readonly ChannelIngressQueueRecord<QQBotIngressPayload>[]> {
  if (typeof lifecycle.readLaneBacklog !== 'function') return [];
  try {
    const rows = await lifecycle.readLaneBacklog();
    return rows ?? [];
  } catch {
    return [];
  }
}

/** 结算额外 claim（组批时我们自己领的那些行） */
async function settleExtraClaims(
  claims: QQBotIngressClaim[],
  handle: IngressAccountHandle,
  mode: 'complete' | 'release',
): Promise<void> {
  for (const claim of claims) {
    try {
      if (mode === 'complete') await handle.queue.complete(claim);
      else await handle.queue.release(claim, { recordAttempt: false });
    } catch {
      /* 结算失败不影响主流程：残留 claim 会被 recoverStaleClaims 回收 */
    }
  }
}

/** 派发一批（重建 ctx → dispatch）。异常向上抛，由 drain 走失败处置。 */
async function dispatchBatch(params: {
  kept: BatchMember[];
  dropped: number;
  droppedNote: string | undefined;
  handle: IngressAccountHandle;
  account: ResolvedQQBotAccount;
  log: PluginLogger | undefined;
  lifecycle: QQBotIngressLifecycle;
}): Promise<void> {
  const { kept, dropped, droppedNote, handle, account, log, lifecycle } = params;

  // 重建每个成员的 ctx/msg（不重跑中间件链——载荷里已是快照）
  const rebuilt = kept.map((member) =>
    rebuildIngressMember({ payload: member.payload, signal: lifecycle.abortSignal }),
  );

  // 整批按 user_request 投递：批内任一条"在叫 bot" ⇒ 整批不能被压成静默。
  //
  // ⚠️ 置位必须在**装配之后**：装配器按各成员自己的 mention 状态渲染 `(@you)`，
  // 先置位会把载体（最后一条）虚标成"叫了 bot"（实际叫 bot 的是批内更早的成员）。
  const anyWoken = kept.some((m) => isExplicitlyWoken(m.payload));

  const assembled = assembleMergedGroupBody(
    rebuilt.map((r) => ({ ctx: r.ctx, msg: r.msg })),
    account,
    () => handle.runtime,
    droppedNote ? { droppedNote } : undefined,
  );

  const carrierIndex = kept.length - 1;
  const carrier = rebuilt[carrierIndex]!;
  if (anyWoken) {
    const state = carrier.ctx.state as Record<string, unknown>;
    const mention = (state.mention as { wasMentioned?: boolean; implicit?: boolean } | undefined) ?? {};
    if (mention.wasMentioned !== true) {
      state.mention = { ...mention, wasMentioned: true };
    }
  }

  // 合并后的附件（多成员 concat）
  const processedList = kept
    .map((m) => m.payload.processedAttachments)
    .filter((p): p is ProcessedAttachments => !!p);
  if (processedList.length > 0) {
    (carrier.ctx.state as Record<string, unknown>).processedAttachments =
      mergeProcessedAttachments(processedList);
  }
  (carrier.ctx.state as Record<string, unknown>).assembledBody = assembled;

  const carrierMsg = carrier.msg as QQBotInboundMessage;
  const targetId = `qqbot:group:${carrierMsg.replyTarget.targetId}`;

  log?.info(
    `[ingress] dispatch batch count=${kept.length} dropped=${dropped} anchor=${carrierMsg.messageId} group=${carrierMsg.replyTarget.targetId}`,
  );

  await runWithRequestContext(
    {
      accountId: handle.accountId,
      messageId: carrierMsg.messageId,
      openId: carrierMsg.senderId,
      target: targetId,
    },
    () =>
      dispatchToOpenClaw(
        carrier.ctx as MiddlewareContext,
        carrierMsg,
        account,
        handle.runtime,
        log,
        { ingressLifecycle: lifecycle },
      ),
  );
}

/**
 * drain 的 `dispatchClaimedEvent` 实现。
 *
 * 流程：解码 → 组批 → 领取 backlog 行 → 裁剪 → 幂等 → 派发 → 结算。
 */
export async function dispatchClaimedGroupEvent(
  claim: QQBotIngressClaim,
  lifecycle: QQBotIngressLifecycle,
  handle: IngressAccountHandle,
  log?: PluginLogger,
): Promise<{ kind: 'completed' } | { kind: 'deferred' } | { kind: 'failed-retryable'; error: unknown }> {
  const decoded = decodeIngressPayload(claim.payload);
  if (!decoded.ok) {
    // 载荷版本不认识 / 结构损坏 ⇒ 重投也不会变 ⇒ 不可重试
    throw new NonRetryableIngressError(decoded.error, decoded.reason);
  }
  const primary = decoded.payload;
  const account = resolveAccount(handle);
  const groupCfg = resolveGroupConfigFromAccount(account, primary.groupOpenid);
  const laneKey = buildIngressLaneKey(handle.accountId, primary.groupOpenid);

  // ① 组批：同 lane 的其它 pending 行
  //
  // 合批只在「合并开启」且「队首不是旁路项」时发生：
  // - coalesce.enabled=false ⇒ 语义是"排队但不合并"（每条一个 turn）
  // - 队首是旁路项（斜杠命令 / 控制命令 / keyed 答案 / 独立语音）⇒ 单独成轮
  //
  // 窗口收集：领到队首行后，在**合批窗口**内反复重读 lane backlog，把窗口期内
  // 到达的同群消息并进本批；**收满（maxBatchSize）即发**，不等窗口走完。
  // 窗口时长来自框架 `resolveInboundDebounceMs(cfg,'qqbot')`（默认 0 ⇒ 立即派发）。
  const batchingEnabled = groupCfg.coalesce.enabled && primary.bypass !== true;
  const maxBatchSize = Math.max(1, groupCfg.coalesce.maxBatchSize ?? DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE);
  const members: BatchMember[] = [{ payload: primary, claim }];
  const extraClaims: QQBotIngressClaim[] = [];
  const claimedIds = new Set<string>([claim.id]);

  if (batchingEnabled) {
    const windowMs = resolveGroupMergeWindowMs(handle.runtime);
    const deadline = windowMs > 0 ? Date.now() + windowMs : 0;
    for (;;) {
      const backlog = await readLaneBacklog(lifecycle);
      for (const row of backlog) {
        if (claimedIds.has(row.id)) continue;
        const rowDecoded = decodeIngressPayload((row as { payload?: unknown }).payload);
        if (!rowDecoded.ok) continue;
        // 旁路项不并入本批（它必须单独成轮）——留在队列里后续单独派发
        if (rowDecoded.payload.bypass === true) continue;
        // 自己领下这一行（拿到所有权，才能安全地一并结算）
        const extraClaim = await handle.queue.claim(row.id, { ownerId: handle.ownerId });
        if (!extraClaim) continue; // 已被别的 worker 领走 ⇒ 跳过，不阻塞整批
        claimedIds.add(row.id);
        extraClaims.push(extraClaim);
        members.push({ payload: rowDecoded.payload, claim: extraClaim });
      }
      // 收满即发（不等窗口走完）／窗口耗尽 ⇒ 用当前批次派发
      if (members.length >= maxBatchSize) break;
      if (!deadline || Date.now() >= deadline) break;
      if (lifecycle.abortSignal?.aborted) break;
      await sleepAbortable(
        Math.min(COLLECT_POLL_MS, Math.max(0, deadline - Date.now())),
        lifecycle.abortSignal,
      );
    }
  }

  // ② 排序：本地到达时刻（**不是**平台 timestamp）
  members.sort((a, b) => ingressPayloadOrderKey(a.payload) - ingressPayloadOrderKey(b.payload));

  // ③ 容量裁剪（与内存路径同款语义）
  const { kept, dropped } = trimToCapacity(members, maxBatchSize, GROUP_MERGE_MAX_BODY_CHARS);
  const droppedNote =
    dropped > 0
      ? `[已丢弃 ${dropped} 条较早的群消息（批次上限 ${maxBatchSize} 条 / ${GROUP_MERGE_MAX_BODY_CHARS} 字）]`
      : undefined;
  if (dropped > 0) {
    log?.info(
      `[ingress] dropped ${dropped} older group message(s) (cap=${maxBatchSize} msgs / ${GROUP_MERGE_MAX_BODY_CHARS} chars, group=${primary.groupOpenid}, kept=${kept.length})`,
    );
  }

  // ④ 幂等：批次指纹跨重投稳定 ⇒ 只派发一次
  const fingerprint = batchFingerprint(laneKey, kept);
  const guard = getEffectGuard(handle.accountId);

  try {
    const outcome = await guard.runOnce({
      eventId: fingerprint,
      effect: 'group-batch-dispatch',
      run: async () => {
        // detached 包裹：批次派发不能继承已释放的准入根（webhook 模式）
        await withDetachedWebhookWork(
          () =>
            dispatchBatch({
              kept,
              dropped,
              droppedNote,
              handle,
              account,
              log,
              lifecycle,
            }),
          log ?? SILENT_INGRESS_LOG,
        );
        return true;
      },
    });

    // 结算我们自己领的那些行（队首行由 drain 在 turn 被采纳时结算）
    await settleExtraClaims(extraClaims, handle, 'complete');

    if (outcome.kind === 'replayed') {
      // 崩溃重投：这批已经派发过了 ⇒ 不重复回复，直接结算队首行
      log?.info(
        `[ingress] batch already dispatched (replayed) group=${primary.groupOpenid} count=${kept.length} — 跳过重复回复`,
      );
      return { kind: 'completed' };
    }
    // turn 的所有权交给回复车道：drain 在 turn 被采纳时结算队首行
    return { kind: 'deferred' };
  } catch (err) {
    // 派发失败 ⇒ 释放额外行（它们会被重投），队首行由 drain 走失败处置
    await settleExtraClaims(extraClaims, handle, 'release');
    throw err;
  }
}

/** 注册派发回调（模块加载即注册，避免调用方忘记） */
export function registerIngressDispatch(): void {
  setIngressDispatchHandlers({
    dispatchClaimedEvent: (claim, lifecycle, handle) =>
      dispatchClaimedGroupEvent(claim, lifecycle, handle, handle.log),
    resolveNonRetryableFailure: (err) =>
      err instanceof NonRetryableIngressError ? { reason: err.reason, message: err.message } : null,
  });
}

/** 测试用：清空幂等守卫 */
export function resetIngressEffectGuardsForTest(): void {
  effectGuards.clear();
}
