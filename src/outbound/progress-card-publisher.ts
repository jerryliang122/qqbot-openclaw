/**
 * Progress Card（进度卡片）发布器
 *
 * openclaw 的 progress_card 工具维护会话级多步计划（checklist，整体替换式
 * 更新）。框架把每次成功的卡片更新投影为 plan 流事件，经
 * replyOptions.onPlanUpdate 送到本发布器；这里把 checklist 快照渲染成
 * 文本，作为独立 QQ 消息逐条发送。
 *
 * 为什么逐条发送：QQ Bot 无消息编辑 API（telegram 是同一条 draft 消息反复
 * edit）；流式 openStream/update 只接受前缀增长文本，而 checklist 更新必然
 * 改动已下发行（✅/▸ 标记移动），不符合前缀不变约束。
 *
 * 配额红线（QQ 平台被动回复限额 c2c 4 条/msg_id、group 5 条/msg_id）：
 * - 卡片消息**只走被动回复**：发送前用 getPassiveReplyQuotaRemaining 纯探测，
 *   剩余额度不足（≤ reserveQuota，为最终回复保槽）直接丢弃，绝不烧每日
 *   主动预算；outbound sendText 的 passiveOnly 兜住探测→发送之间的竞态。
 * - 发送结果未知的失败（平台报错/网络异常——消息可能已落地）记录为
 *   「已发送」防重发；passive-quota-exhausted（本地拦截，确定未发出）
 *   不记录，同状态更新仍可重试。
 * - 卡片是锦上添花，正文优先：任何失败都不重试、不影响 turn。
 *
 * 渲染复用框架共享渲染器 formatPlanChecklistLines（与 telegram 文本模式
 * checklist 同源）：✅ completed / ▸ in_progress / ▢ pending，步数超限时
 * 压缩为 "✅ N/M done" 头 + 完成尾部 + 当前步 + 待办尾部。
 *
 * 生命周期：每 turn 一次性对象（dispatch 闭包内创建）。
 * - stop()：正文级投递开始时调用，同时清掉待补发的尾随快照；
 *   drain() 供 deliverHandler 等待 in-flight 发送落地后再放行正文，
 *   保证卡片永不晚于答案。
 * - dispose()：dispatch 收尾调用。
 * - 防抖（minIntervalMs）只拦连击：窗口内到达的新快照记为 pending，由
 *   尾随定时器在窗口到期后补发——agent 更新完就不管时，用户也能看到
 *   最新进度（而不是停在旧快照上直到答案到来）。
 *
 * 内部 promise chain 保证卡片串行。
 */

import { formatPlanChecklistLines } from 'openclaw/plugin-sdk/channel-message';
import type { ProgressCardConfig } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';

/** 框架 plan 事件载荷（宽容解析：未知字段忽略，2026.9.1 只保证 phase/steps） */
export interface PlanUpdatePayload {
  phase?: string;
  title?: string;
  explanation?: string;
  source?: string;
  steps?: Array<{ step?: unknown; status?: unknown }>;
}

/** 归一化后的步骤 */
export interface NormalizedPlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface ProgressCardPublisherDeps {
  /** 已解析的运行配置（resolveProgressCardConfig 产物） */
  config: Required<ProgressCardConfig>;
  /** 发送一条卡片消息（返回 error 时视为失败/配额不可用，静默丢弃） */
  sendCard: (text: string) => Promise<{ error?: string } | void>;
  /** 被动配额剩余额度探测（getPassiveReplyQuotaRemaining 的绑定） */
  quotaRemaining: () => number;
  /** turn 级中止信号（combinedAbortSignal） */
  signal?: AbortSignal;
  log?: PluginLogger;
}

/** explanation 行截断长度（字符） */
const EXPLANATION_MAX_CHARS = 80;
/** checklist 单行截断长度（与框架 compact renderer 默认上限对齐的保守值） */
const LINE_MAX_CHARS = 80;

/**
 * 归一化 plan 事件 steps：丢掉 step 非字符串/为空、status 非法的条目
 * （宽容解析——未来框架版本字段形态变化时宁可少渲染也不抛错）。
 */
export function normalizePlanSteps(steps: Array<{ step?: unknown; status?: unknown }>): NormalizedPlanStep[] {
  const result: NormalizedPlanStep[] = [];
  for (const entry of Array.isArray(steps) ? steps : []) {
    if (!entry || typeof entry !== 'object') continue;
    const step = typeof (entry as { step?: unknown }).step === 'string'
      ? ((entry as { step?: string }).step ?? '').replace(/\s+/g, ' ').trim()
      : '';
    if (!step) continue;
    const rawStatus = (entry as { status?: unknown }).status;
    if (rawStatus !== 'pending' && rawStatus !== 'in_progress' && rawStatus !== 'completed') continue;
    result.push({ step, status: rawStatus });
  }
  return result;
}

/** 截断字符串（按字符，超出加省略号） */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * 渲染一条卡片消息：
 *
 *   📋 进度 1/4
 *   ✅ 分析现有包结构
 *   ▸ pack 8.0(覆盖 8.0.tar, 沿用现有 logs.txt)
 *   ▢ 运行回归测试
 *   ▢ 清理临时文件
 *
 * explanation 存在时（2026.9.1 事件不含该字段，纯前向兼容）插在头部之后。
 */
export function renderProgressCardText(
  steps: NormalizedPlanStep[],
  explanation?: string,
  maxLines = 8,
): string {
  const completed = steps.filter((s) => s.status === 'completed').length;
  const header = `📋 进度 ${completed}/${steps.length}`;
  const lines = formatPlanChecklistLines(steps, {
    maxLines,
    maxLineChars: LINE_MAX_CHARS,
  });
  const note = explanation?.trim() ? truncate(explanation.replace(/\s+/g, ' ').trim(), EXPLANATION_MAX_CHARS) : undefined;
  return [header, ...(note ? [note] : []), ...lines].join('\n');
}

export class ProgressCardPublisher {
  private stopped = false;
  private cleared = false;
  private sentCount = 0;
  private lastSentText = '';
  private lastSentAt = 0;
  /** 防抖窗口内被跳过的最新快照（尾随补发用；只保留最新一条） */
  private pendingText: string | undefined;
  private trailingTimer: ReturnType<typeof setTimeout> | undefined;
  /** 串行队列（对齐 StreamingController 的 chain 模式） */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ProgressCardPublisherDeps) {}

  /** 本 turn 已发送的卡片条数（测试/日志观测用） */
  get sentCards(): number {
    return this.sentCount;
  }

  /**
   * replyOptions.onPlanUpdate 入口。chain 串行执行；回调内异常只记日志
   * （卡片绝不影响 turn）。
   */
  onPlanUpdate(payload: PlanUpdatePayload): Promise<void> {
    this.enqueue(() => this.handle(payload));
    return this.chain as Promise<void>;
  }

  /**
   * 等待 in-flight 的卡片发送落地。deliverHandler 在正文级投递开始时
   * 先 stop() 再 await drain()——保证正在路上的卡片先于答案完成，
   * 用户不会看到「答案之后才来的卡片」。
   */
  drain(): Promise<void> {
    return this.chain as Promise<void>;
  }

  /** 正文级投递开始后关闭发布（deliverHandler 非 tool kind 首次触发时调用） */
  stop(reason?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTrailingTimer();
    this.pendingText = undefined;
    this.deps.log?.debug(`[progress-card] publishing stopped (${reason ?? 'final delivery started'}), sent=${this.sentCount}`);
  }

  /** dispatch 收尾（清掉尾随定时器，等价于 stop） */
  dispose(): void {
    this.stop('dispatch disposed');
  }

  private enqueue(fn: () => Promise<void>): void {
    this.chain = this.chain.then(fn).catch((err) => {
      this.deps.log?.error(`[progress-card] handle error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async handle(payload: PlanUpdatePayload): Promise<void> {
    if (this.stopped) return;
    if (this.deps.signal?.aborted) return;
    if (!payload || payload.phase !== 'update') return;

    const steps = normalizePlanSteps(payload.steps ?? []);

    // 清空卡片：不发消息，本 turn 停止发布（后续再有非空 update 则恢复）。
    // 同时重置去重状态——恢复的同文本 checklist 是新一轮，必须重新发布。
    if (steps.length === 0) {
      if (!this.cleared) {
        this.cleared = true;
        this.lastSentText = '';
        this.pendingText = undefined;
        this.clearTrailingTimer();
        this.deps.log?.debug('[progress-card] card cleared; suppressing further publishing until next non-empty update');
      }
      return;
    }
    this.cleared = false;

    const text = renderProgressCardText(steps, payload.explanation, this.deps.config.maxLines);

    // 去重：无任何状态变化的重复写卡不重发（步骤状态变化必然改变 ✅/▸ 标记）
    if (text === this.lastSentText) return;

    // 防抖级轻节流：窗口内到达的新快照记为 pending，由尾随定时器在窗口
    // 到期后补发——agent 之后不再更新卡片时，用户也能看到最新进度。
    if (this.sentCount > 0 && Date.now() - this.lastSentAt < this.deps.config.minIntervalMs) {
      this.deps.log?.debug('[progress-card] deferred by debounce window; trailing send scheduled');
      this.pendingText = text;
      this.scheduleTrailing();
      return;
    }

    await this.trySend(text);
  }

  /**
   * 执行一次快照发送（handle 直发与尾随补发共用）。包含全部守卫：
   * stop/abort、去重、maxPerTurn 保险丝、配额探测。
   */
  private async trySend(text: string): Promise<void> {
    if (this.stopped) return;
    if (this.deps.signal?.aborted) return;
    if (text === this.lastSentText) return;

    // 保险丝：每 turn 上限
    if (this.sentCount >= this.deps.config.maxPerTurn) {
      this.deps.log?.info(`[progress-card] skipped (maxPerTurn=${this.deps.config.maxPerTurn} reached)`);
      return;
    }

    // 配额红线：剩余额度不足（为最终回复保槽）直接丢弃
    const remaining = this.deps.quotaRemaining();
    if (remaining <= this.deps.config.reserveQuota) {
      this.deps.log?.info(`[progress-card] skipped (passive quota remaining=${remaining} ≤ reserve=${this.deps.config.reserveQuota})`);
      return;
    }

    let result: { error?: string } | void;
    try {
      result = await this.deps.sendCard(text);
    } catch (err) {
      // 结果未知（消息可能已落地）：记为已发送防重发；丢弃、不重试、不影响 turn
      this.deps.log?.warn(`[progress-card] send failed: ${err instanceof Error ? err.message : String(err)}`);
      this.markSent(text);
      return;
    }
    if (result?.error === 'passive-quota-exhausted') {
      // 本地拦截（探测→发送竞态）：确定未发出，同状态更新仍可重试
      this.deps.log?.warn('[progress-card] send rejected: passive-quota-exhausted');
      return;
    }
    if (result?.error) {
      // 平台报错但结果未知（可能已落地）：记为已发送防重发；丢弃、不重试
      this.deps.log?.warn(`[progress-card] send rejected: ${String(result.error)}`);
      this.markSent(text);
      return;
    }

    this.markSent(text);
    const [done, total] = this.countFromText(text);
    this.deps.log?.info(`[progress-card] sent snapshot ${done}/${total} (turn count=${this.sentCount})`);
  }

  /** 记录快照为已发送并清掉更早的 pending（新快照已落地，旧补发无意义） */
  private markSent(text: string): void {
    this.lastSentText = text;
    this.lastSentAt = Date.now();
    this.sentCount++;
    this.pendingText = undefined;
    this.clearTrailingTimer();
  }

  /** 从渲染文本头部提取 N/M（仅日志用） */
  private countFromText(text: string): [string, string] {
    const m = /^📋 进度 (\d+)\/(\d+)$/.exec(text.split('\n')[0] ?? '');
    return m ? [m[1]!, m[2]!] : ['?', '?'];
  }

  /** 安排尾随补发定时器（已有定时器则不重复安排——pendingText 已更新为最新） */
  private scheduleTrailing(): void {
    if (this.trailingTimer) return;
    const wait = Math.max(1, this.deps.config.minIntervalMs - (Date.now() - this.lastSentAt));
    const timer = setTimeout(() => {
      this.trailingTimer = undefined;
      const text = this.pendingText;
      this.pendingText = undefined;
      if (text === undefined || this.stopped || this.cleared || this.deps.signal?.aborted) return;
      this.enqueue(() => this.trySend(text));
    }, wait);
    // 不阻止进程退出（turn 结束即被 dispose 清理；即使泄漏也不挂住进程）
    timer.unref?.();
    this.trailingTimer = timer;
  }

  private clearTrailingTimer(): void {
    if (this.trailingTimer) {
      clearTimeout(this.trailingTimer);
      this.trailingTimer = undefined;
    }
  }
}
