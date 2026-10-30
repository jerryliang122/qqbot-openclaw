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
 *   3. webhook 侧在委托前后取 marker / settleSince，等「本次请求派生的工作」
 *      全部落地后才放行 detached 回调 —— detached 根因此覆盖到框架 enqueue。
 *
 * 语义边界：
 * - marker 是全局单调 id，settle 只等**该账号** id > marker 的条目——并发
 *   webhook 请求各自持各自的 detached 根，互不搭车；
 * - 超时不中断被等的工作（它有自己的生命周期：c2c 防抖窗口、群合批的
 *   maxHoldMs 兜底等），只是不再为它撑住 detached 根——届时未入队的工作
 *   将以无根身份运行（与群合批定时器冲刷的既有形态一致）；
 * - 条目 settle 后留作计数凭证（防秒完成派发被快照漏拍），每账号超
 *   上限 FIFO 淘汰已 settle 条目，稳态内存有界。
 */

interface TrackedWebhookDispatch {
  id: number;
  settled: boolean;
  promise: Promise<unknown>;
}

/**
 * 已 settle 条目的每账号保留上限（FIFO 淘汰最旧）。
 *
 * settle 后**不立即出表**：settleSince 要数「marker 之后登记过的工作」——
 * 秒完成的派发（如被 guard 拦截的消息）同样属于本请求的工作，立即出表
 * 会让快照漏拍、tripwire 误报。等待只针对未 settle 条目，已 settle 的
 * 只作计数凭证，用本上限约束稳态内存。
 */
const MAX_SETTLED_ENTRIES_PER_ACCOUNT = 64;

/** 全局单调 id —— 跨账号不重号，marker 无需按账号区分 */
let nextDispatchId = 1;
const byAccount = new Map<string, Set<TrackedWebhookDispatch>>();

export interface WebhookDispatchMarker {
  readonly lastId: number;
}

function markSettled(accountId: string, entries: Set<TrackedWebhookDispatch>, entry: TrackedWebhookDispatch): void {
  entry.settled = true;
  let settledCount = 0;
  for (const e of entries) if (e.settled) settledCount++;
  if (settledCount <= MAX_SETTLED_ENTRIES_PER_ACCOUNT) return;
  for (const e of entries) {
    if (settledCount <= MAX_SETTLED_ENTRIES_PER_ACCOUNT) break;
    if (e.settled) {
      entries.delete(e);
      settledCount--;
    }
  }
  if (entries.size === 0) byAccount.delete(accountId);
}

/** 登记一条在途派发（settle 后留作计数凭证，超上限 FIFO 淘汰） */
export function trackWebhookDispatch(accountId: string, promise: Promise<unknown>): void {
  const entry: TrackedWebhookDispatch = { id: nextDispatchId++, settled: false, promise };
  let entries = byAccount.get(accountId);
  if (!entries) {
    entries = new Set();
    byAccount.set(accountId, entries);
  }
  entries.add(entry);
  const registered = entries;
  void Promise.resolve(promise).then(
    () => markSettled(accountId, registered, entry),
    () => markSettled(accountId, registered, entry),
  );
}

/** 取当前登记水位（在委托 SDK handler **之前**取，委托中同步登记的条目必然 > 该水位） */
export function markWebhookDispatches(): WebhookDispatchMarker {
  return { lastId: nextDispatchId - 1 };
}

export interface SettleWebhookDispatchesResult {
  /** 本次实际等待的条目数（0 = 委托没有派生任何被跟踪工作） */
  awaited: number;
  /** true = 等待被超时截断（仍有条目未落地） */
  timedOut: boolean;
}

/**
 * 等「marker 之后登记到该账号」的全部在途派发落地（或超时）。
 *
 * `awaited` 数**登记过**的条目（含已秒完成的——它们也是本请求的工作），
 * 实际只等待其中未 settle 的。只快照调用时刻的集合：等待期间新登记的
 * 条目属于其他请求的 detached 根，不在这里搭车。
 */
export async function settleWebhookDispatchesSince(
  accountId: string,
  marker: WebhookDispatchMarker,
  timeoutMs: number,
): Promise<SettleWebhookDispatchesResult> {
  const registered = [...(byAccount.get(accountId) ?? [])].filter((e) => e.id > marker.lastId);
  if (registered.length === 0) return { awaited: 0, timedOut: false };

  const unsettled = registered.filter((e) => !e.settled);
  if (unsettled.length === 0) return { awaited: registered.length, timedOut: false };

  const work = Promise.allSettled(unsettled.map((e) => e.promise));
  if (timeoutMs > 0) {
    const timer = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs);
      // 生产上不让持有上限的定时器拖住进程退出；测试环境用 keepAlive 保活
      t.unref?.();
    });
    const raced = await Promise.race([work.then(() => 'done' as const), timer]);
    return { awaited: registered.length, timedOut: raced === 'timeout' };
  }
  await work;
  return { awaited: registered.length, timedOut: false };
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

/** 测试辅助：清空全部登记 */
export function resetWebhookDispatchTrackerForTest(): void {
  byAccount.clear();
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
