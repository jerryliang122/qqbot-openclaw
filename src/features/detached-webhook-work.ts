/**
 * openclaw/plugin-sdk/webhook-request-guards 的共享加载与包裹（issue #74）。
 *
 * `runDetachedWebhookWork` 让「ACK 之后还要继续干活」的 webhook 工作跑在
 * 独立的准入根上（回调 promise 挂起期间保持引用）。两个消费方：
 *   - src/adapter/webhook.ts 的 op:0 委托（主修复路径）；
 *   - src/features/group-merge.ts 的 flushGroupMergeQueue——busy 归零回调
 *     触发的冲刷运行在**上一轮 dispatch 的延续上下文**里，继承的准入根
 *     在 turn 结束时多半已释放，webhook 模式下批次 enqueue 会被当 drain
 *     拒掉；包一层让冲刷在「继承根缺失/已释放」时拿**全新独立根**
 *     （runWithGatewayRootWorkContinuation 对 released parent 正是走
 *     独立根分支）。
 *
 * 加载失败/导出缺失时降级为直跑（保持调用方原有行为）并 WARN——
 * 仅在全局 drain 期间新根会被拒（该语义本就如此）。
 */
import type { runDetachedWebhookWork } from 'openclaw/plugin-sdk/webhook-request-guards';
import type { PluginLogger } from '../utils/plugin-logger.js';

export type RunDetachedWebhookWork = typeof runDetachedWebhookWork;

let detachedGuards: { runDetachedWebhookWork: RunDetachedWebhookWork } | null | undefined;

/**
 * 加载 guards 模块（进程内缓存；不可用一次性 WARN）。
 *
 * 基线 2026.10.5 起该子路径即存在；模块加载失败与导出缺失都缓存为 null
 * ——这两种形态都是运行时环境的持久属性，重试无意义。
 */
export async function loadDetachedWebhookGuards(log: PluginLogger): Promise<{ runDetachedWebhookWork: RunDetachedWebhookWork } | null> {
  if (detachedGuards !== undefined) return detachedGuards;
  const mod = await import('openclaw/plugin-sdk/webhook-request-guards').catch((err) => {
    log.warn?.(
      `[webhook] webhook-request-guards unavailable (${err instanceof Error ? err.message : String(err)}) `
      + '— detached admission unavailable, falling back to inherited context (issue #74)',
    );
    return null;
  });
  if (mod && typeof mod.runDetachedWebhookWork === 'function') {
    detachedGuards = mod as { runDetachedWebhookWork: RunDetachedWebhookWork };
  } else {
    // 模块在、原语不在（上游改名/移除）——不静默，否则修复无声失效
    log.warn?.(
      '[webhook] webhook-request-guards loaded but runDetachedWebhookWork is missing '
      + '— detached admission unavailable, falling back to inherited context (issue #74)',
    );
    detachedGuards = null;
  }
  return detachedGuards;
}

/**
 * 在 detached 准入根下执行 run；guards 不可用时直跑（降级保持原行为）。
 *
 * 注意：**回调必须 await 全部真实工作**——detached 根只在回调挂起期间
 * 保持引用，fire-and-forget 的后台 promise 不在回调的 AsyncWorkScope 里。
 */
export async function withDetachedWebhookWork(
  run: () => Promise<unknown>,
  log: PluginLogger,
  guards?: { runDetachedWebhookWork: RunDetachedWebhookWork } | null,
): Promise<void> {
  const resolved = guards !== undefined ? guards : await loadDetachedWebhookGuards(log);
  if (!resolved) {
    await run();
    return;
  }
  await resolved.runDetachedWebhookWork(run);
}
