/**
 * 群会话「正在工作」信号（插件自建）
 *
 * 背景（2026-10-23）：框架没有向通道插件暴露「某会话当前是否有 turn 在跑」的
 * 查询 API（SDK 导出面已逐一核对，无此类能力）。但插件自己知道——
 * `dispatchToOpenClaw` 里 `await adapters.inboundRun!(...)` 覆盖整个 turn
 * （turn 提交到结束才 resolve；typing 中间件的「处理链完成 = 会话结束」与
 * c2c 防抖的「载体项在 dispatch 完成后 resolve」都依赖这一点）。
 *
 * 因此本模块在 dispatch 侧维护 per-群的 in-flight 计数：
 * - `markGroupTurnStarted` —— dispatch 进入时 +1
 * - `markGroupTurnFinished` —— dispatch 退出时 -1（finally 兜底，异常路径也归零）
 * - 归零时通知订阅者 → 冲刷群合批队列（见 features/group-merge.ts）
 *
 * 计数语义含框架 followup 队列中排队的 turn：排队中的 dispatch promise
 * 同样未结束，故 busy=true。这正是「正在工作」的真实含义。
 *
 * 本模块是**纯状态**，不 import dispatch —— dispatch.ts 反向 import 本模块，
 * 若本模块再 import dispatch 会形成循环引用。
 */

/** 归零回调（该群从忙变闲时触发） */
export type GroupIdleListener = () => void;

/** key: `${accountId}:${groupOpenid}` → in-flight turn 计数 */
const inflight = new Map<string, number>();

/** key → 归零回调集合 */
const idleListeners = new Map<string, Set<GroupIdleListener>>();

function buildKey(accountId: string, groupOpenid: string): string {
  return `${accountId}:${groupOpenid}`;
}

/** 群 turn 开始（dispatch 进入） */
export function markGroupTurnStarted(accountId: string, groupOpenid: string): void {
  if (!accountId || !groupOpenid) return;
  const key = buildKey(accountId, groupOpenid);
  inflight.set(key, (inflight.get(key) ?? 0) + 1);
}

/**
 * 群 turn 结束（dispatch 退出）。
 *
 * 计数归零时触发该群的空闲回调（合批队列据此冲刷）。
 * 归零前不会触发——同群多个 turn 在途时只由最后一个的退出决定。
 */
export function markGroupTurnFinished(accountId: string, groupOpenid: string): void {
  if (!accountId || !groupOpenid) return;
  const key = buildKey(accountId, groupOpenid);
  const next = (inflight.get(key) ?? 0) - 1;
  if (next > 0) {
    inflight.set(key, next);
    return;
  }
  inflight.delete(key);
  notifyGroupIdle(key);
}

/** 该群当前是否有 turn 在跑 */
export function isGroupBusy(accountId: string, groupOpenid: string): boolean {
  if (!accountId || !groupOpenid) return false;
  return (inflight.get(buildKey(accountId, groupOpenid)) ?? 0) > 0;
}

/**
 * 订阅「该群变闲」事件，返回取消订阅函数。
 *
 * 订阅即刻生效：若订阅时该群已经空闲，则下一次归零前不会有回调
 * （回调只在「由忙变闲」的那一刻触发）。
 */
export function onGroupIdle(accountId: string, groupOpenid: string, listener: GroupIdleListener): () => void {
  if (!accountId || !groupOpenid) return () => {};
  const key = buildKey(accountId, groupOpenid);
  let set = idleListeners.get(key);
  if (!set) {
    set = new Set();
    idleListeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) idleListeners.delete(key);
  };
}

/** 触发某群的空闲回调（单个回调异常不影响其它回调） */
function notifyGroupIdle(key: string): void {
  const set = idleListeners.get(key);
  if (!set || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener();
    } catch {
      // 回调异常不得影响计数归零与其它回调
    }
  }
}

/**
 * 清空全部状态（仅测试用）。
 *
 * 生产代码不应调用：计数与回调都是进程级单例，测试之间需隔离。
 */
export function resetGroupBusyStateForTests(): void {
  inflight.clear();
  idleListeners.clear();
}
