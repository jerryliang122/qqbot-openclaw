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
 * 配额口径（2026-11-03 反应式 + 卡片降级主动）：
 * - 卡片消息**先走被动回复**（sendText 的 passiveOnly）：本地无次数门
 *   （平台实测不执行「c2c 4 条/group 5 条每 msg_id」，见
 *   features/quota-manager.ts 文件头），唯一本地保险丝是 maxPerTurn。
 * - 锚点无存活（无 msg_id / TTL 过期 / 判死）或平台判死
 *   （40034005 / 40034128）⇒ 卡片**降级为主动发送**（allowActiveFallback：
 *   不挂锚点、不走 passiveOnly）——计入每日 1000 条主动预算，但用户仍能看到
 *   进度。卡片按「前置消息」处理（正文之外的进度消息，与正文/流式分段
 *   同等待遇）。
 * - 降级状态**本轮记忆**（anchorLost）：后续快照直接走主动，不再重复本地
 *   拦截与刷 WARN。
 * - 发送结果未知的失败（平台报错/网络异常——消息可能已落地）记录为
 *   「已发送」防重发，不重发。
 * - 卡片是锦上添花，正文优先：任何失败都不影响 turn。
 *
 * 双形态（2026-11-03 note 形态支持）：框架把 progress_card 工具调用投影为
 * plan 事件（projectProgressCardChannelUpdate）：
 * - checklist 形态（带 plan）→ steps + 自动计数 explanation（"N/M complete"）
 *   → 渲染 `📋 进度 N/M` 头 + checklist
 * - note 形态（仅 markdown）→ steps=[] + explanation=剥格式纯文本单行
 *   （explanationFormat:"plain"）→ 渲染 `📋 状态` 头 + note（截断
 *   NOTE_MAX_CHARS）。框架引导把 markdown 列为首选形态（可测量工作
 *   prefer a leading progress bar；阻塞状态 in markdown and omit plan），
 *   此前 steps=[] 一律当清卡会让该形态被静默丢弃。
 * - 清卡（双空）→ steps=[] 且无 explanation 键 → 不发消息、抑制发布。
 * 已知限制：混合形态（plan+markdown）的 markdown 叙事在**框架投影层**
 * 就被丢弃（explanation 被自动计数覆盖），插件只能收到 steps——无法
 * 插件侧修复。
 *
 * checklist 渲染复用框架共享渲染器 formatPlanChecklistLines（与 telegram
 * 文本模式同源）：✅ completed / ▸ in_progress / ▢ pending，步数超限时
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

import { formatPlanChecklistLines } from 'openclaw/plugin-sdk/channel-outbound';
import type { ProgressCardConfig } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { isAnchorDeadBizCode } from '../features/quota-manager.js';
import { resolveFindGraphemeChunkEnd } from './grapheme.js';

/** 框架 plan 事件载荷（宽容解析：未知字段忽略，2026.9.1 只保证 phase/steps） */
export interface PlanUpdatePayload {
  phase?: string;
  title?: string;
  explanation?: string;
  /**
   * note 形态（markdown-only 卡片）的投影标记，框架恒传 "plain"。
   * 不参与 noteOnly 判定——steps>0 时 explanation 恒为框架自动计数
   * （"N/M complete"），steps=[] + explanation 非空已无歧义；记入接口
   * 仅为契约留档（宽容解析、可缺省）。
   */
  explanationFormat?: string;
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
  /**
   * 发送一条卡片消息（返回 error 时视为失败/配额不可用，静默丢弃）。
   *
   * `opts.allowActiveFallback` = true 时**不挂被动锚点**（走主动通道、
   * 计入每日主动预算）——锚点已失效时的降级路径。
   */
  sendCard: (
    text: string,
    opts?: { allowActiveFallback?: boolean },
  ) => Promise<{ error?: string; qqBizCode?: number } | void>;
  /** turn 级中止信号（combinedAbortSignal） */
  signal?: AbortSignal;
  log?: PluginLogger;
}

/** explanation 行截断长度（字符） */
const EXPLANATION_MAX_CHARS = 80;
/**
 * note 形态（markdown-only 卡片）截断长度（字符）。框架引导 markdown 为
 * "compact narrative"，QQ 卡片定位一眼可读；框架投影已剥格式并折叠空白
 * 为单行，截断只做长度保险。
 */
const NOTE_MAX_CHARS = 300;
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
 * 字形簇安全截断（**note 形态专用**）。
 *
 * 为什么不能用上面的 truncate()：它按 UTF-16 码元硬切，切点落在代理对
 * （emoji / 增补平面字符）中间会留下**落单高代理**——编码后变成 U+FFFD
 * 豆腐块或被平台拒收。AGENTS.md 的分块红线同样适用本路径：note 是第一
 * 条会截断 agent 自撰文本的路径（checklist 形态的 explanation 恒为框架
 * 的 ASCII 自动计数 "N/M complete"，永远触发不了截断）。
 *
 * 复用 outbound/grapheme.ts 的合规助手：官方 findGraphemeChunkEnd（字形
 * 簇边界吸附）+ 本地 Intl.Segmenter 等价回退——两者都保证不切开代理对。
 */
function truncateGraphemeSafe(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  // 为省略号留 1 个码元
  const budget = Math.max(0, maxChars - 1);

  let cut = 0;
  try {
    cut = resolveFindGraphemeChunkEnd()(text, 0, budget);
  } catch {
    cut = 0;
  }

  if (cut <= 0) {
    // 助手不可用/异常 → 手工兜底：退到不切开代理对的切点
    cut = budget;
    const code = text.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // 高代理后半 → 前移
  } else if (cut > budget) {
    // 本地回退的 avoidTrailingHighSurrogateBreak 在「预算只剩 1 码元且是
    // 高代理前半」时会返回 end+1（带走完整代理对、超预算 1 码元）——宁可
    // 略超也不产生落单代理。
    cut = Math.min(cut, text.length);
  }

  return `${text.slice(0, cut)}…`;
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

/**
 * 渲染一条 note 形态卡片消息（markdown-only 卡片，框架投影为纯文本单行）：
 *
 *   📋 状态
 *   Update remains open and paused. Waiting for the source owner…
 *
 * 无计数头（与 checklist 的 `📋 进度 N/M` 区分——note 没有步骤计数）。
 */
export function renderProgressCardNoteText(note: string): string {
  return ['📋 状态', truncateGraphemeSafe(note, NOTE_MAX_CHARS)].join('\n');
}

export class ProgressCardPublisher {
  private stopped = false;
  private cleared = false;
  private sentCount = 0;
  private lastSentText = '';
  private lastSentAt = 0;
  /**
   * 本轮锚点已失效（TTL 过期 / 平台判死 / 无 msg_id）⇒ 后续卡片直接走
   * 主动通道（allowActiveFallback），不再重复被动尝试与本地拦截。
   */
  private anchorLost = false;
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

    // note 形态（markdown-only 卡片）：steps=[] 但 explanation 非空——框架
    // 投影把 markdown 剥成纯文本单行放这里。必须与清卡区分，否则该形态
    // （框架引导的首选形态）被静默丢弃。
    const noteOnly = steps.length === 0 && Boolean(payload.explanation?.trim());

    // 清空卡片：不发消息，本 turn 停止发布（后续再有非空 update 则恢复）。
    // 同时重置去重状态——恢复的同文本 checklist/note 是新一轮，必须重新发布。
    if (steps.length === 0 && !noteOnly) {
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

    // checklist 形态：框架投影恒设 explanation = "N/M complete"（自动计数，
    // 与 `📋 进度 N/M` 头重复）。抑制该行——只保留框架自动计数之外的
    // explanation（理论上的自定义注记），避免卡片出现「N/M complete」
    // 这种与中文头重复的英文行（评审 #87-F2）。
    const completed = steps.filter((s) => s.status === 'completed').length;
    const autoCount = `${completed}/${steps.length} complete`;
    const note = payload.explanation === autoCount ? undefined : payload.explanation;

    const text = noteOnly
      ? renderProgressCardNoteText(payload.explanation!.trim())
      : renderProgressCardText(steps, note, this.deps.config.maxLines);

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
   * stop/abort、去重、maxPerTurn 保险丝、锚点失效降级主动。
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

    let result: { error?: string; qqBizCode?: number } | void;
    try {
      result = await this.deps.sendCard(text, { allowActiveFallback: this.anchorLost });
    } catch (err) {
      // 结果未知（消息可能已落地）：记为已发送防重发；丢弃、不重试、不影响 turn
      this.deps.log?.warn(`[progress-card] send failed: ${err instanceof Error ? err.message : String(err)}`);
      this.markSent(text);
      return;
    }

    // 锚点失效判定：
    // - passive-quota-exhausted：本地拦截（TTL 过期 / 死锚点 / 无 msg_id）
    // - qqBizCode ∈ {40034005, 40034128}：平台判死该 msg_id
    // ⇒ 该 msg_id 本轮已不可被动回复 ⇒ 降级为主动发送一次（用户仍见进度）。
    const anchorUnavailable =
      result?.error === 'passive-quota-exhausted' ||
      isAnchorDeadBizCode(result?.qqBizCode);

    if (anchorUnavailable) {
      this.anchorLost = true;
      this.deps.log?.warn(
        '[progress-card] passive anchor unavailable (expired/dead); falling back to proactive send',
      );
      try {
        result = await this.deps.sendCard(text, { allowActiveFallback: true });
      } catch (err) {
        // 结果未知（可能已落地）：记为已发送防重发；丢弃、不重试、不影响 turn
        this.deps.log?.warn(
          `[progress-card] proactive fallback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.markSent(text);
        return;
      }
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

  /** 从渲染文本头部提取 N/M（仅日志用；note 形态头无计数） */
  private countFromText(text: string): [string, string] {
    const m = /^📋 进度 (\d+)\/(\d+)$/.exec(text.split('\n')[0] ?? '');
    if (m) return [m[1]!, m[2]!];
    if (text.split('\n')[0] === '📋 状态') return ['note', 'note'];
    return ['?', '?'];
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
