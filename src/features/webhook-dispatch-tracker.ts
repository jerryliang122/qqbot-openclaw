/**
 * webhook 模式入站派发的在途登记（issue #74）。
 *
 * 背景：SDK 的 WebhookTransport.handleRequest 对 op:0 是「先 ACK、后台
 * fire-and-forget 派发」——插件委托 SDK handler 后拿不到那条派发 promise。
 * 而 openclaw 的 root-work 准入挂在 HTTP 请求上、响应结束即释放；后台派发链
 * 经 AsyncLocalStorage 继承的是这个已释放的请求根，随后框架 enqueue 处的
 * `isGatewaySubordinateWorkAdmissionClosed()` 判定 `current.released === true`
 * → GatewayDrainingError（网关并未 drain，transport=webhook 入站 100% 被拒）。
 *
 * 修法（见 src/adapter/webhook.ts）：op:0 委托放进 `runDetachedWebhookWork`
 * 的回调里执行——detached 根在回调 promise 挂起期间保持引用。但 SDK 的
 * fire-and-forget 链不在回调的 AsyncWorkScope 里，回调本身只等 ACK 就 settle，
 * detached 根随即释放、bug 依旧。因此需要本模块把「SDK 派发链什么时候真正
 * 干完」暴露给 webhook 侧：
 *
 *   1. QQBotGateway（webhook 模式）包裹 bot 实例的 handleInboundMessage ——
 *      每条消息派发在这里同步进入（SDK 的 handleDispatch → onMessage →
 *      handleInboundMessage 在 handler 调用的同步级联里）；
 *   2. interaction listener 在 bot.emit 同步调用 listener 的时刻登记；
 *   3. webhook 侧用 **scope** 圈定「本次委托的同步级联里登记的条目」、
 *      等它们全部落地后才放行 detached 回调 —— detached 根因此覆盖到
 *      框架 enqueue。
 *
 * scope 相关性（而非按 marker/账号过滤）：并发 webhook 请求各自持各自的
 * detached 根；`beginWebhookDispatchScope()` 后**同步**调用委托——JS 单线程
 * 下委托的同步级联里发生的登记恰好属于本请求，同步段一结束立刻 `end()`
 * （await 期间他人登记不得混入）。
 *
 * 语义边界：
 * - 超时不中断被等的工作（它有自己的生命周期：c2c 防抖窗口、群合批的
 *   maxHoldMs 兜底等），只是不再为它撑住 detached 根——届时未入队的工作
 *   将以无根身份运行（群合批冲刷另有 detached 包裹兜底，见
 *   src/features/detached-webhook-work.ts）；
 * - 条目 settle 后留作计数凭证（防秒完成派发被快照漏拍、tripwire 误报），
 *   每账号已 settle 条目 FIFO 淘汰；
 * - 永不 settle 的卡死条目由**未 settle 条目上限**兜底（同 FIFO 淘汰最旧），
 *   防内存无界增长。
 */

interface TrackedWebhookDispatch {
  id: number;
  settled: boolean;
  promise: Promise<unknown>;
  /** 登记时活跃的 webhook 委托 scope（无则为 null：非 webhook 路径登记） */
  scope: WebhookDispatchScopeInternal | null;
}

interface WebhookDispatchScopeInternal {
  entries: TrackedWebhookDispatch[];
  ended: boolean;
}

export interface WebhookDispatchScope {
  /** 本 scope 圈定的登记条数（含已秒完成的） */
  readonly count: number;
  /** 同步段结束必须立刻调用（await 期间他人的登记不得混入） */
  end(): void;
  /** @internal 圈定的条目，settleWebhookDispatchScope 消费 */
  readonly entries: readonly TrackedWebhookDispatch[];
}

/** 已 settle 条目的每账号保留上限（FIFO 淘汰最旧） */
const MAX_SETTLED_ENTRIES_PER_ACCOUNT = 64;
/** 未 settle（卡死）条目的每账号保留上限（FIFO 淘汰最旧——settle 时照常标记） */
const MAX_UNSETTLED_ENTRIES_PER_ACCOUNT = 64;

/** 全局单调 id——排障日志用 */
let nextDispatchId = 1;
const byAccount = new Map<string, Set<TrackedWebhookDispatch>>();

/** 当前活跃的委托 scope（同步级联窗口内非 null） */
let currentDispatchScope: WebhookDispatchScopeInternal | null = null;

/**
 * 开一个委托 scope：此后**同步**执行委托调用，其同步级联里的登记
 * （包裹后的 handleInboundMessage / interaction listener）都圈进本 scope；
 * 同步段结束必须立刻 `end()`。
 */
export function beginWebhookDispatchScope(): WebhookDispatchScope {
  const scope: WebhookDispatchScopeInternal = { entries: [], ended: false };
  currentDispatchScope = scope;
  return {
    get count() {
      return scope.entries.length;
    },
    get entries() {
      return scope.entries;
    },
    end: () => {
      if (scope.ended) return;
      scope.ended = true;
      if (currentDispatchScope === scope) currentDispatchScope = null;
    },
  };
}

function pruneEntries(accountId: string, entries: Set<TrackedWebhookDispatch>, settledOnly: boolean, cap: number): void {
  let count = 0;
  for (const e of entries) if (e.settled === settledOnly) count++;
  if (count <= cap) return;
  for (const e of entries) {
    if (count <= cap) break;
    if (e.settled === settledOnly) {
      entries.delete(e);
      count--;
    }
  }
  if (entries.size === 0) byAccount.delete(accountId);
}

/** 登记一条在途派发（settle 后留作计数凭证；超上限 FIFO 淘汰） */
export function trackWebhookDispatch(accountId: string, promise: Promise<unknown>): void {
  const entry: TrackedWebhookDispatch = { id: nextDispatchId++, settled: false, promise, scope: currentDispatchScope };
  let entries = byAccount.get(accountId);
  if (!entries) {
    entries = new Set();
    byAccount.set(accountId, entries);
  }
  entries.add(entry);
  if (currentDispatchScope && !currentDispatchScope.ended) currentDispatchScope.entries.push(entry);

  void Promise.resolve(promise).then(
    () => {
      entry.settled = true;
      pruneEntries(accountId, entries!, true, MAX_SETTLED_ENTRIES_PER_ACCOUNT);
    },
    () => {
      entry.settled = true;
      pruneEntries(accountId, entries!, true, MAX_SETTLED_ENTRIES_PER_ACCOUNT);
    },
  );
  // 卡死条目兜底：永不 settle 的登记不许多到无界（淘汰后 settle 照常标记，无副作用）
  pruneEntries(accountId, entries, false, MAX_UNSETTLED_ENTRIES_PER_ACCOUNT);
}

export interface SettleWebhookDispatchesResult {
  /** scope 实际圈定的条目数（0 = 委托没有派生任何被跟踪工作） */
  awaited: number;
  /** true = 等待被超时截断（仍有条目未落地） */
  timedOut: boolean;
}

/**
 * 等 scope 圈定的全部派发落地（或超时）。只等**未 settle** 的条目；
 * `awaited` 数全部圈定条目（含已秒完成的）。
 */
export async function settleWebhookDispatchScope(
  scope: WebhookDispatchScope,
  timeoutMs: number,
): Promise<SettleWebhookDispatchesResult> {
  const entries = scope.entries;
  if (entries.length === 0) return { awaited: 0, timedOut: false };
  const unsettled = entries.filter((e) => !e.settled);
  if (unsettled.length === 0) return { awaited: entries.length, timedOut: false };

  const work = Promise.allSettled(unsettled.map((e) => e.promise));
  if (timeoutMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
        // 生产上不让持有上限的定时器拖住进程退出；测试环境用 keepAlive 保活。
        // race 结束即 clearTimeout（finally），不留悬挂定时器。
        timer.unref?.();
      });
      const raced = await Promise.race([work.then(() => 'done' as const), timeout]);
      return { awaited: entries.length, timedOut: raced === 'timeout' };
    } finally {
      clearTimeout(timer);
    }
  }
  await work;
  return { awaited: entries.length, timedOut: false };
}

/**
 * 把一个 async listener 包成「同步登记、settle 出表」的形态。
 *
 * 用于 bot.on('interaction')：SDK 的 onInteraction 回调对 bot.emit 是
 * fire-and-forget，派发 promise 同样不被 HTTP 请求持有；bot.emit 同步
 * 调用 listener，登记因此落在 webhook 委托的同步级联里。websocket 模式
 * 下无人消费登记表，仅多一次零成本记号。
 */
export function makeTrackedListener<A extends unknown[]>(
  accountId: string,
  run: (...args: A) => Promise<unknown>,
  onError?: (err: unknown) => void,
): (...args: A) => void {
  return (...args: A) => {
    let releaseTracked!: () => void;
    const tracked = new Promise<void>((resolve) => { releaseTracked = resolve; });
    trackWebhookDispatch(accountId, tracked);
    void run(...args)
      .catch((err: unknown) => {
        onError?.(err);
      })
      .finally(() => releaseTracked());
  };
}

/**
 * 在 bot 实例上包裹 handleInboundMessage，把每条消息派发登记为在途工作。
 *
 * SDK 的 handleDispatch → onMessage → handleInboundMessage 发生在 webhook
 * handler 委托的同步级联里，包裹实例方法即可保证「委托期间同步登记」
 * （SDK 侧 `this.handleInboundMessage(raw)` 是运行时查实例属性，晚绑定）。
 *
 * handleInboundMessage 是 SDK 的 TS-private 方法——缺失时 WARN 并放弃登记
 * （detached 根会随 ACK 释放，行为退回修复前；webhook 侧另有 tripwire WARN）。
 */
export function installWebhookDispatchTracking(
  bot: object,
  accountId: string,
  log: { warn?: (msg: string) => void },
): void {
  const botAny = bot as { handleInboundMessage?: (raw: unknown) => Promise<unknown> };
  const orig = botAny.handleInboundMessage;
  if (typeof orig !== 'function') {
    log.warn?.(
      '[webhook] SDK handleInboundMessage surface missing — webhook dispatch tracking disabled (issue #74)',
    );
    return;
  }
  const bound = orig.bind(bot);
  botAny.handleInboundMessage = (raw: unknown) => {
    const dispatch = Promise.resolve(bound(raw));
    trackWebhookDispatch(accountId, dispatch);
    return dispatch;
  };
}

/** 测试辅助：清空全部登记 */
export function resetWebhookDispatchTrackerForTest(): void {
  byAccount.clear();
  currentDispatchScope = null;
}

/** 测试辅助：每账号登记表规模（settled / unsettled）——容量上限断言用 */
export function webhookDispatchTrackerStatsForTest(): Record<string, { settled: number; unsettled: number }> {
  const out: Record<string, { settled: number; unsettled: number }> = {};
  for (const [accountId, entries] of byAccount) {
    let settled = 0;
    let unsettled = 0;
    for (const e of entries) e.settled ? settled++ : unsettled++;
    out[accountId] = { settled, unsettled };
  }
  return out;
}
