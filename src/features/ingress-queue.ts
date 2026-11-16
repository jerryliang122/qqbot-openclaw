/**
 * 持久化入站队列（群聊）：per-account 的 queue + drain 单例。
 *
 * ## 为什么要有这层
 *
 * 改造前的群聊入站是**纯内存**的插件侧合批：
 * - 进程重启 → 攒到一半的批次直接蒸发；
 * - 忙闲判定挂在 dispatch promise 生命周期上，框架把 turn **defer**
 *   （仅入队）时 promise 就 resolve → busy 提前归零 → 合批散架；
 * - 框架 followup 队列 `cap` 溢出时**丢弃最老的消息**。
 *
 * 改造后群消息**先落盘再处理**：SQLite 队列 + 租约（claim/complete/
 * release/fail）+ 本地到达时刻（排序权威）+ 持久化幂等守卫。
 *
 * ## 与 openclaw 的关系
 *
 * 用的是框架已有的通道入站抽象（`runtime.state.openChannelIngressQueue`
 * / `openChannelIngressDrain`），**不是**自造一套：
 * - 队列 kernel（claim/complete/release/fail/resubmit/prune）在 core，
 *   租约与 stale claim 回收由 core 负责；
 * - drain 负责 lane 串行、deferred 持有、stall watchdog、失败重试。
 *
 * ⚠️ 这些 API 在部分 loader 路径下是 `unavailable(...)` stub——**必须探测**，
 * 不可用时回落内存合批路径（见 `isIngressDurableAvailable`）。
 *
 * @see features/ingress-payload.ts 载荷编解码与 ctx 重建
 * @see features/ingress-batcher.ts 组批、幂等与派发
 */

import type {
  ChannelIngressDrain,
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from 'openclaw/plugin-sdk/channel-outbound';
import { CHANNEL_INGRESS_RETENTION_DEFAULTS } from 'openclaw/plugin-sdk/channel-outbound';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import { createPluginLogger } from '../utils/plugin-logger.js';
import { shortId } from '../utils/redaction.js';
import type { ResolvedQQBotAccount } from '../types.js';
import { getAdapters } from '../adapter/resolve.js';
import { resolveGroupConfigFromAccount } from '../config.js';
import { buildIngressPayload, type QQBotIngressPayload } from './ingress-payload.js';

/** 插件 id（同时是队列的 channelId——core 按插件隔离队列） */
const PLUGIN_ID = 'openclaw-qqbot';

/**
 * 队列行 id 前缀。core 的队列 id 是全局唯一键，群消息用平台 msg_id，
 * 但**跨账号可能撞号**（OpenID 跨账号不通用但也不保证唯一）⇒ 加前缀隔离。
 */
const QUEUE_ID_PREFIX = 'qqbot-group:';

/** drain 空转轮询间隔（毫秒）。有 wake 时立即被唤醒，不等这个间隔。 */
const DRAIN_IDLE_POLL_MS = 200;

/** claim 租约时长（毫秒）。过短会让长 turn 的 claim 被判 stale。 */
const CLAIM_LEASE_MS = 5 * 60_000;

/** claim→adoption 的超时（毫秒）。超过则 drain 判死并按重试策略处理。 */
const ADOPTION_STALL_MS = 5 * 60_000;

/**
 * 队列生命周期（框架未从 plugin-sdk 导出该类型，这里按结构声明）。
 *
 * 字段与 core 的 `ChannelIngressDispatchLifecycle` 逐字对齐——
 * `bindIngressLifecycleToReplyOptions` 按结构接收它。
 */
export interface QQBotIngressLifecycle {
  /** 采纳前的取消信号（claim 被取消/进程退出时 abort） */
  abortSignal: AbortSignal;
  /** 同 lane 其它已入队但未派发的行（组批用） */
  readLaneBacklog?: () => Promise<readonly ChannelIngressQueueRecord<QQBotIngressPayload>[]>;
  /** turn 已被回复车道采纳 ⇒ drain 在此 tombstone claim */
  onAdopted: () => void | Promise<void>;
  /** turn 所有权延后到回复车道采纳 ⇒ claim 继续持有 */
  onDeferred: () => void;
  /** 延后期间的心跳（重置 stall watchdog） */
  onDeferredHeartbeat?: () => void;
  /** 心跳间隔（毫秒） */
  deferredHeartbeatIntervalMs?: number;
  /** 采纳收尾中（清 stall watchdog） */
  onAdoptionFinalizing: () => void;
  /** 延后的工作终局失败 */
  onFailed?: (error: unknown) => void | Promise<void>;
  /** 采纳前被显式取消 */
  onCancelled?: () => void | Promise<void>;
  /** 延后的 turn 未拿到回复车道即结束 ⇒ 释放 claim 供重试 */
  onAbandoned: () => void | Promise<void>;
}

/** 队列里的一行（含 claim 引用） */
export type QQBotIngressClaim = ChannelIngressQueueClaim<QQBotIngressPayload>;

/** 队列里的 pending 行 */
export type QQBotIngressRecord = ChannelIngressQueueRecord<QQBotIngressPayload>;

/** 单账号的入站句柄 */
export interface IngressAccountHandle {
  accountId: string;
  /** 插件运行时（派发时需要：账号解析、adapters、bot 原语） */
  runtime: PluginRuntime;
  queue: ChannelIngressQueue<QQBotIngressPayload>;
  drain: ChannelIngressDrain;
  /** claim 归属者（进程内唯一）。多进程下互不抢同一行。 */
  ownerId: string;
  /** 日志器（派发时用） */
  log?: ReturnType<typeof createPluginLogger>;
  /** 唤醒 drain 循环（新入队时调用，避免等轮询间隔） */
  wake: () => void;
  /** 停止 drain 循环 */
  stop: () => void;
}

/** accountId → 句柄 */
const handles = new Map<string, IngressAccountHandle>();

/** 已判定不可用（不再重复探测，避免每次入队都走 stub） */
const unavailableAccounts = new Set<string>();

/** 入队与派发的回调（由 ingress-batcher 注入，避免模块循环依赖） */
export interface IngressDispatchHandlers {
  /** drain 的 dispatchClaimedEvent 实现 */
  dispatchClaimedEvent: (
    claim: QQBotIngressClaim,
    lifecycle: QQBotIngressLifecycle,
    handle: IngressAccountHandle,
  ) => Promise<{ kind: 'completed' } | { kind: 'deferred' } | { kind: 'failed-retryable'; error: unknown }>;
  /** 不可重试失败的判定（返回 null 表示可重试） */
  resolveNonRetryableFailure?: (err: unknown) => { reason: string; message: string } | null;
}

let handlers: IngressDispatchHandlers | null = null;

/** 注册派发回调（由 ingress-batcher 在初始化时调用） */
export function setIngressDispatchHandlers(next: IngressDispatchHandlers): void {
  handlers = next;
}

/**
 * 取派发回调；未注册时**动态**载入 ingress-batcher 并注册。
 *
 * ⚠️ 必须动态 import：ingress-batcher → dispatch → plugin-logger → runtime
 * 构成静态环（与 c2c 防抖同款事故，见 runtime.ts 的说明）。动态载入还
 * 顺带解决了「首条消息早于注册」的竞态——drain 的第一次派发会等它就绪。
 */
async function resolveDispatchHandler(): Promise<IngressDispatchHandlers['dispatchClaimedEvent']> {
  const registered: IngressDispatchHandlers | null = handlers;
  if (registered) return registered.dispatchClaimedEvent;
  const m = await import('./ingress-batcher.js');
  m.registerIngressDispatch();
  const next = handlers as IngressDispatchHandlers | null;
  if (!next) throw new Error('[ingress] 派发回调注册失败');
  return next.dispatchClaimedEvent;
}

/** 群 lane key：**按群**（不同发言人可同批），与现状一致 */
export function buildIngressLaneKey(accountId: string, groupOpenid: string): string {
  return `qqbot:${accountId}:group:${groupOpenid}`;
}

/**
 * 脱敏 drain 的内部日志（core 的 onLog 原文里**内嵌 lane key**）。
 *
 * lane key 形如 `qqbot:{accountId}:group:{groupOpenid}` ⇒ core 的日志行
 * （如「…on lane <laneKey> reached retry limit…」）会把**完整群 openid**带出来。
 * `/bot-logs` 原样导出本地日志文件 ⇒ 桥接处必须脱敏（根 AGENTS.md § Security）。
 */
export function redactIngressLog(message: string): string {
  return message.replace(/group:([A-Za-z0-9_-]{8,})/g, (_m, id: string) => `group:${shortId(id)}`);
}

/** 队列行 id */
export function buildIngressQueueId(accountId: string, messageId: string): string {
  return `${QUEUE_ID_PREFIX}${accountId}:${messageId}`;
}

/**
 * 探测持久化入站能力是否可用。
 *
 * core 的 loader 在部分路径下把 `openChannelIngressQueue` 打成
 * `unavailable(...)` stub——调用会抛。**必须探测**，不可用时回落内存合批。
 */
export function isIngressDurableAvailable(runtime: PluginRuntime): boolean {
  const state = (runtime as { state?: { openChannelIngressQueue?: unknown } }).state;
  if (!state || typeof state.openChannelIngressQueue !== 'function') return false;
  try {
    const probe = state.openChannelIngressQueue as (options?: unknown) => unknown;
    // 只探测函数存在性；真正调用留到 getIngressAccount（避免产生副作用）
    return typeof probe === 'function';
  } catch {
    return false;
  }
}

/** 取（或创建）账号的入站句柄。返回 null = 持久化不可用，调用方须降级。 */
export function getIngressAccount(
  runtime: PluginRuntime,
  accountId: string,
  log?: ReturnType<typeof createPluginLogger>,
): IngressAccountHandle | null {
  const existing = handles.get(accountId);
  if (existing) return existing;
  if (unavailableAccounts.has(accountId)) return null;

  const state = (runtime as { state?: Record<string, unknown> }).state;
  const openQueue = state?.openChannelIngressQueue as
    | ((options: Record<string, unknown>) => ChannelIngressQueue<QQBotIngressPayload>)
    | undefined;
  const openDrain = state?.openChannelIngressDrain as
    | ((options: Record<string, unknown>) => ChannelIngressDrain)
    | undefined;
  if (typeof openQueue !== 'function' || typeof openDrain !== 'function') {
    unavailableAccounts.add(accountId);
    log?.warn(
      '[ingress] 持久化入站不可用（openclaw 未提供 openChannelIngressQueue/openChannelIngressDrain）——回落内存合批路径',
    );
    return null;
  }

  let queue: ChannelIngressQueue<QQBotIngressPayload>;
  let drain: ChannelIngressDrain;
  try {
    queue = openQueue({ accountId });
    drain = openDrain({
      queue,
      accountId,
      ownerId: `${PLUGIN_ID}:${accountId}:${process.pid}`,
      orderBy: 'received',
      claimLeaseMs: CLAIM_LEASE_MS,
      adoptionStallTimeoutMs: ADOPTION_STALL_MS,
      deferredLaneOccupancy: 'hold',
      dispatchClaimedEvent: async (
        claim: QQBotIngressClaim,
        lifecycle: QQBotIngressLifecycle,
      ) => {
        const active = handles.get(accountId);
        if (!active) {
          return { kind: 'failed-retryable', error: new Error('[ingress] 入站句柄已释放') };
        }
        const dispatch = await resolveDispatchHandler();
        return dispatch(claim, lifecycle, active);
      },
      resolveNonRetryableFailure: (err: unknown) =>
        handlers?.resolveNonRetryableFailure?.(err) ?? null,
      onLog: (message: string) => log?.debug(`[ingress] ${redactIngressLog(message)}`),
    });
  } catch (err) {
    unavailableAccounts.add(accountId);
    log?.warn(
      `[ingress] 持久化入站初始化失败，已回落内存合批路径：${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }

  let wakeResolve: (() => void) | null = null;
  let stopped = false;

  const handle: IngressAccountHandle = {
    accountId,
    runtime,
    queue,
    drain,
    ownerId: `${PLUGIN_ID}:${accountId}:${process.pid}`,
    log,
    wake: () => {
      wakeResolve?.();
    },
    stop: () => {
      stopped = true;
      wakeResolve?.();
    },
  };
  handles.set(accountId, handle);

  // drain 循环：空转时按间隔轮询，有新入队时被 wake 立即唤醒。
  //
  // ⚠️ drain 内部的 claim 是**并发**跑的（runClaimed 不 await），因此
  // 单个 lane 的长耗时不会阻塞其它 lane。
  void (async () => {
    let lastPrunedAt = Date.now();
    while (!stopped) {
      try {
        await drain.drainOnce({ shouldStop: () => stopped });
      } catch (err) {
        log?.error(
          `[ingress] drain 轮询失败 account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (stopped) break;
      // 队列清理（保留策略取框架默认，与 core 的 ingress monitor 同款）：
      // 只清 completed / failed 的墓碑行，**pending 行永不按 TTL 清理**
      // ——pending 是「还没送达的消息」，按 TTL 清就是丢用户消息。
      const now = Date.now();
      if (now - lastPrunedAt >= CHANNEL_INGRESS_RETENTION_DEFAULTS.pruneIntervalMs) {
        lastPrunedAt = now;
        try {
          await handle.queue.prune({
            completedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.completedTtlMs,
            completedMaxEntries: CHANNEL_INGRESS_RETENTION_DEFAULTS.completedMaxEntries,
            failedTtlMs: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedTtlMs,
            failedMaxEntries: CHANNEL_INGRESS_RETENTION_DEFAULTS.failedMaxEntries,
          });
        } catch (err) {
          log?.warn(
            `[ingress] 队列清理失败 account=${accountId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wakeResolve = null;
          resolve();
        }, DRAIN_IDLE_POLL_MS);
        // unref：不让轮询定时器吊住进程退出
        if (typeof timer.unref === 'function') timer.unref();
        wakeResolve = () => {
          clearTimeout(timer);
          wakeResolve = null;
          resolve();
        };
      });
    }
  })();

  log?.info(`[ingress] 持久化入站已就绪 account=${accountId}`);
  return handle;
}

/**
 * 群消息入队（持久化）。
 *
 * 返回 false = 入队失败（调用方**必须**回落直发——宁可失去耐久性，不可丢消息）。
 */
export async function enqueueGroupInbound(
  runtime: PluginRuntime,
  accountId: string,
  payload: QQBotIngressPayload,
  log?: ReturnType<typeof createPluginLogger>,
): Promise<boolean> {
  const handle = getIngressAccount(runtime, accountId, log);
  if (!handle) return false;
  try {
    await handle.queue.enqueue(buildIngressQueueId(accountId, payload.messageId), payload, {
      receivedAt: payload.receivedAtMs,
      laneKey: buildIngressLaneKey(accountId, payload.groupOpenid),
    });
    handle.wake();
    return true;
  } catch (err) {
    log?.error(
      `[ingress] 入队失败 account=${accountId} msgId=${payload.messageId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * 群消息入站入口（durable 路径）的结果。
 *
 * - `handled`：消息已持久化，后续由 drain 派发。
 * - `not_applicable`：本条不走 durable 路径（用户选了交回框架队列），
 *   调用方走直发即可，**不要**再试内存合批。
 * - `unavailable`：持久化入站不可用 / 入队失败 ⇒ 调用方**应**回落内存合批，
 *   回落不了再直发（宁可失去耐久性，不可丢消息）。
 */
export type DurableGroupInboundResult = 'handled' | 'not_applicable' | 'unavailable';

/**
 * 群消息入站入口（durable 路径）。
 *
 * 未接管的三种情形：
 * 1. 非群消息 → `not_applicable`；
 * 2. `coalesce.strategy !== 'plugin'`——用户显式选择交回框架队列
 *    （strategy:'framework'），保持既有语义不动 → `not_applicable`；
 * 3. 持久化入站不可用（core 未提供队列 API）或入队失败 → `unavailable`
 *    （调用方回落内存合批路径）。
 *
 * ⚠️ `coalesce.enabled === false` **仍然走 durable 路径**（只是不合批）：
 * 语义从「框架 followup 队列（内存、cap 溢出丢最老）」升级为
 * 「持久化串行（严格保序、不丢）」。
 */
export async function enqueueDurableGroupInbound(params: {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  account: ResolvedQQBotAccount;
  runtime: PluginRuntime;
  log?: ReturnType<typeof createPluginLogger>;
}): Promise<DurableGroupInboundResult> {
  const { ctx, msg, account, runtime, log } = params;
  if (msg.replyTarget?.scope !== 'group') return 'not_applicable';
  const groupOpenid = msg.replyTarget.targetId;
  if (!groupOpenid) return 'not_applicable';

  const groupCfg = resolveGroupConfigFromAccount(account, groupOpenid);
  // strategy !== 'plugin' ⇒ 交回框架队列（legacy 路径，不动）
  if (groupCfg.coalesce.strategy !== 'plugin') return 'not_applicable';

  const cfg = (getAdapters(runtime).getConfig?.() ?? {}) as Record<string, unknown>;
  const payload = buildIngressPayload({
    ctx,
    msg,
    accountId: account.accountId,
    groupOpenid,
    cfg,
  });
  const queued = await enqueueGroupInbound(runtime, account.accountId, payload, log);
  return queued ? 'handled' : 'unavailable';
}

/** 该 lane 当前是否被占用（有在途 claim ⇒ 该群正在工作） */
export function isIngressLaneBusy(handle: IngressAccountHandle, laneKey: string): boolean {
  return handle.drain.activeLaneKeys().has(laneKey);
}

/**
 * 退出前冲刷：把队列里还 pending 的行尽量派发出去。
 *
 * 与 c2c 防抖的两段式冲刷同款语义：
 * 1. 反复 drainOnce 直到没有可领的行（每轮之间等在途 turn 结束）；
 * 2. 之后由 disposeIngressQueues 停摆 drain。
 *
 * ⚠️ 只保证「退出宽限内能跑完的 turn 把回复发完」——deferred 的 turn 由
 * 框架队列在后台继续，无界等待会让 Ctrl+C 卡死（同 c2c 路径的取舍）。
 */
export async function flushIngressQueues(rounds = 3): Promise<void> {
  for (const handle of [...handles.values()]) {
    for (let i = 0; i < rounds; i += 1) {
      try {
        const { started } = await handle.drain.drainOnce();
        if (!started) break;
        await handle.drain.waitForIdle();
      } catch {
        break;
      }
    }
  }
}

/** 停掉全部 drain 循环并等待在途结算（进程退出用） */
export async function disposeIngressQueues(): Promise<void> {
  const list = [...handles.values()];
  for (const handle of list) {
    handle.stop();
    try {
      await handle.drain.waitForIdle();
    } catch {
      /* 退出路径：忽略 */
    }
    try {
      handle.drain.dispose();
    } catch {
      /* 退出路径：忽略 */
    }
  }
  handles.clear();
  unavailableAccounts.clear();
}

/** 测试用：清空句柄注册表 */
export function resetIngressStateForTest(): void {
  for (const handle of handles.values()) handle.stop();
  handles.clear();
  unavailableAccounts.clear();
  handlers = null;
}
