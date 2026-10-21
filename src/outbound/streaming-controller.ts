/**
 * QQ Bot 流式消息控制器
 *
 * 核心约束：QQ 流式 API 替换模式下，已下发文本的**前缀不可变更**。
 *
 * 状态机：
 *   IDLE → (first chunk) → STREAMING → (complete) → DONE
 *                                      → (prefix changed) → DONE
 *                                      → (new reply) → IDLE → …
 *
 * onPartialReply(text) 输入：模型全量文本，持续增长。
 * finalize()           标记：框架通知回复结束，用 lastAccepted 收尾。
 *
 * sendMode='stream-all' 双道模式（v2，块驱动）：
 *   文本段经框架 deliver(kind:'block') 按**完成段**进入滚动道（token 级
 *   partial 不注册不处理）；每个中间条目（正文段 / 🔧 工具标题行）以
 *   markdown 分隔线隔开离散追加；final deliver 时滚动道收尾，终稿文本
 *   以第二条打字机消息（分片节奏）原样下发。终稿段从不进滚动道——
 *   held 块被 final 取代，无需差量对账。
 */

import type { ReplyTarget, StreamSession } from '@tencent-connect/qqbot-nodejs';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'done' | 'failed';

export type StreamingSendMode = 'stream' | 'static' | 'stream-all';

/**
 * 框架 final payload 文本与「已承接段落」的匹配结果。
 *
 * 早先把「完全没有命中」与「已完全承接」都折叠成空串（issue #44 的根因）：
 * 前者其实是**本段从未流出**，正文会静默丢失。区分成三态后，补发成为可能。
 *   - identical：final 即已承接内容，纯去重（正常路径）
 *   - extension：final 是已承接内容的扩展，增量即 remainder（典型即 usage footer）
 *   - unrelated：final 与已承接内容毫无关系（static = 本段从未流出 / stream = 模型重写）
 */
export type FinalTextMatch =
  | { kind: 'identical' }
  | { kind: 'extension'; remainder: string }
  | { kind: 'unrelated' };

export interface StreamingControllerDeps {
  gateway: QQBotGateway;
  target: ReplyTarget;
  accountId: string;
  replyToId: string;
  log?: PluginLogger;
  /**
   * 文本下发通道：
   *   - 'stream'（默认）QQ 流式打印机：openStream/update/complete
   *   - 'static'           流结束时用一条普通 sendText 发完整文本
   *   - 'stream-all'       双道流式：中间内容（每段正文 + 工具 title）汇入一条
   *                        滚动打字机消息；终稿由另一条打字机消息下发。
   * partial 接收逻辑（状态机/串行/去重）在各模式下保持一致。
   */
  sendMode?: StreamingSendMode;
  /**
   * static 模式专用：在 finalize 收尾时把累积的完整文本一次性发出。
   * stream 模式下不使用。未提供时 static 模式将降级为 shouldFallbackToStatic。
   */
  sendStatic?: (fullText: string) => Promise<void>;
}

// ── 控制器 ──

/**
 * stream-all 终稿道打字机分片大小（字符/次 update）
 *
 * 终稿文本在 final deliver 时已完整在手（非边生成边推），打字机效果靠
 * 分片 + 间隔人为制造。64 字/90ms ≈ 每秒 ~700 字的视觉节奏，5000 字满限
 * 终稿约 8 秒推完。
 */
const STREAM_ALL_FINAL_CHUNK_CHARS = 64;

/** stream-all 终稿道打字机分片间隔（ms） */
const STREAM_ALL_FINAL_CHUNK_DELAY_MS = 90;

/** stream-all 滚动道条目间的 markdown 分隔线（正文段 / 🔧 工具标题行） */
const STREAM_ALL_ITEM_SEPARATOR = '\n\n---\n\n';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export class StreamingController {
  private phase: StreamingPhase = 'idle';
  private session: StreamSession | null = null;

  /** QQ 已接受的最新文本 — 单源真理 */
  private lastAcceptedFull = '';

  /**
   * 最后一次流式 update 失败是否「结果不明」（网络层失败：超时/连接中断，
   * 平台可能已应用该 update、仅 ack 丢失）。结果不明时不补发未流出尾巴，
   * 防止与流内已存在的内容重复。
   */
  private lastUpdateFailureAmbiguous = false;

  /**
   * 最后一次被流式通道承接（已下发或 static 模式已缓冲待发）的段落全文。
   * 框架把 usage footer（/usage tokens|full）等追加在 final payload 文本尾部，
   * 流式增量永不包含——此字段是 final 差量补发（computeUnsentRemainder）的基准。
   */
  private lastDeliveredSegmentText = '';

  /** 已成功发送的分片数（降级：=0 且无外部投递则走静态消息兜底） */
  private sentChunkCount = 0;

  /**
   * 标记：内容已通过非流式通道成功投递（如 ask_user 按钮卡片）。
   * 置 true 后 handleFinalize 不再走 fallback 路径，避免框架误报 outcome=error。
   */
  private _deliveredExternally = false;

  /**
   * 标记：final payload 与已承接内容无关、且当前无待发缓冲时，已整段补发
   * （issue #44 恢复路径）。仅用于把终态原因与静默的 finalize:fallback 区分开。
   */
  private _finalRescued = false;

  /** 同步标志：收到第一个 onPartialReply 即置 true（不等 async 完成） */
  private _hasStarted = false;

  // ── stream-all 专属状态 ──

  /**
   * held 块（lookahead）：最新一个尚无法定性的文本块。
   *
   * 块到达时无法知道它是不是终稿段（终稿的身份是回溯性的——turn 结束时
   * 恰好是最后一块）。故每块先扣住；后继块 / 工具事件 / 新 assistant 段
   * 的出现都证明它是中间段 → 提交进滚动道；final deliver 到达则直接被
   * 终稿全文取代（丢弃，从未展示过故无重复）。
   */
  private saHeldBlock: string | null = null;

  /** 当前活跃道：null=尚未定道 / rolling=滚动道 / final=终稿道 */
  private saLane: 'rolling' | 'final' | null = null;

  /** 已追加过标题行的 item 主键（start/update 重复事件去重） */
  private saStartedItemKeys = new Set<string>();

  /** item 别名 → 主键映射（同一 item 的事件可能带不同标识组合：itemId / toolCallId / title） */
  private saItemAliases = new Map<string, string>();

  /** 标题行仍处于滚动道末尾的 item key（此时 end 事件可补 ✓，前缀不可回改） */
  private saTailItemKey: string | null = null;

  /** 终稿道已被平台接受的字符数（0 = 终稿一个字都没落地，可静态兜底） */
  private saFinalAcceptedChars = 0;

  /** 串行队列 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StreamingControllerDeps) {}

  /** 是否走静态（普通 sendText）下发通道 */
  private get isStaticMode(): boolean { return this.deps.sendMode === 'static'; }

  /** 是否走 stream-all 双道（滚动道 + 终稿道）下发通道 */
  get isStreamAllMode(): boolean { return this.deps.sendMode === 'stream-all'; }

  /**
   * 是否处于 static 下发模式（公开访问器，供 dispatch 协同判断）。
   * static 模式下 dispatch 不应在 tool/final 事件提前 finalize，
   * 由 controller 靠 new_reply 检测自主分段，避免终态与发送延迟。
   */
  get isStaticSendMode(): boolean { return this.isStaticMode; }

  // ── 公共访问器 ──

  get currentPhase(): StreamingPhase { return this.phase; }

  /** 是否已成功发送至少一个流式分片 */
  get hasSentChunks(): boolean { return this.sentChunkCount > 0; }

  /** 同步标志：流式已启动（不等异步完成），用于 final 去重 */
  get hasStarted(): boolean { return this._hasStarted; }

  get isTerminal(): boolean {
    return this.phase === 'done' || this.phase === 'failed';
  }

  get shouldFallbackToStatic(): boolean {
    return this.isTerminal && this.sentChunkCount === 0 && !this._deliveredExternally;
  }

  /**
   * final 尾巴兜底补发的失败抑制判定。
   *
   * 失败终态并不总意味着「正文没送达」：static 模式 sendStatic 失败 =
   * 正文整段未投递（footer 单发只会更怪，抑制）；stream 模式在已有分片被
   * 平台接受之后失败（典型：absorb 的 footer 增长 update 被拒，如合并文本
   * 超限）= 正文已可见，尾巴仍应走兜底补发，不能因 failed 一刀切丢弃。
   */
  get shouldSuppressFinalTailFallback(): boolean {
    if (this.currentPhase !== 'failed') return false;
    // stream 失败但「结果不明」（网络层失败，平台可能已应用最后的
    // update——含 footer 合并推送）：补发可能与流内内容重复，宁缺毋滥
    if (!this.isStaticMode && this.lastUpdateFailureAmbiguous) return true;
    if (this.isStaticMode) return true;
    return !this.hasSentChunks;
  }

  /**
   * stream-all 专属：终稿道启动后失败、且终稿一个字符都没被平台接受
   * （滚动道可能已有内容）——终稿文本应回落到普通 sendText 整段补发，
   * 否则用户只见中间过程不见答案。
   */
  get finalLaneNeedsStaticFallback(): boolean {
    return this.isStreamAllMode
      && this.saLane === 'final'
      && this.phase === 'failed'
      && this.saFinalAcceptedChars === 0
      && !this._deliveredExternally;
  }

  /**
   * 告知控制器内容已通过外部通道投递（如 ask_user 卡片）。
   * 后续 finalize() 不会走 fallback 路径，框架不会误报 outcome=error。
   */
  markDeliveredExternally(): void {
    this._deliveredExternally = true;
  }

  /**
   * 计算框架 final payload 文本中，流式通道尚未投递的尾部增量。
   *
   * 框架在模型输出完成后才把 usage footer（/usage tokens|full 的
   * "Usage: X in / Y out · …" 行，或 /usage full 自定义模板渲染结果）追加到
   * final payload 文本尾部（框架 appendUsageLine），onPartialReply 流式增量
   * 永远不会包含它。QQ 流式已下发文本的前缀不可回改，只能把「多出来的尾巴」
   * 作为新消息补发：
   *   - final 与已流出段落一致 → ''（纯去重，维持现有行为）
   *   - final 是已流出段落的扩展 → 扩展部分（典型即 usage footer）
   *   - 多段 turn 且 final 含全部段落（A+B+C+footer）→ 定位最后一段之后的部分
   *   - 完全不含已流出段落（模型重写）→ ''（维持现有 final 丢弃去重行为）
   *
   * 匹配规则见 matchFinalText；本方法保留空串语义，仅把「无命中」折叠回 ''。
   */
  computeUnsentRemainder(finalText: string): string {
    const match = this.matchFinalText(finalText);
    return match.kind === 'extension' ? match.remainder : '';
  }

  /**
   * final payload 文本与已承接段落的匹配判定（issue #44）。
   *
   * 判定规则与旧的 computeUnsentRemainder 逐条一致（identical → 前缀扩展 →
   * 行首边界的 lastIndexOf → 空白归一化前缀），区别只在于把「什么都没匹配上」
   * 显式标成 unrelated 而不是与「已完全承接」共用空串。
   */
  matchFinalText(finalText: string): FinalTextMatch {
    const tail = this.lastDeliveredSegmentText.trim();
    if (!tail || !finalText) return { kind: 'unrelated' };
    if (finalText === tail) return { kind: 'identical' };
    if (finalText.startsWith(tail)) return { kind: 'extension', remainder: finalText.slice(tail.length) };
    // 多段 turn：final 文本可能拼接了此前全部段落（A+B+C+footer），已流出的
    // 是最后一段——仅在段落边界（串首或行首）命中才认定，避免旧段内嵌在
    // 重写文本中间的伪匹配把未验证内容当增量发出
    const idx = finalText.lastIndexOf(tail);
    if (idx !== -1 && idx + tail.length < finalText.length && (idx === 0 || finalText[idx - 1] === '\n')) {
      return { kind: 'extension', remainder: finalText.slice(idx + tail.length) };
    }
    // 空白归一化兜底（流式文本与 final 文本的空白差异）：按非空白 token 序列
    // 验证并取匹配前缀的**原始结束偏移**切片——tail.length 与实际前缀的原始
    // 长度可能不一致（空白数不同），直接按 tail.length 切会截断 footer 或
    // 带入正文字符
    const normalizedEnd = normalizedPrefixEnd(finalText, tail);
    if (normalizedEnd > 0 && normalizedEnd < finalText.length) {
      return { kind: 'extension', remainder: finalText.slice(normalizedEnd) };
    }
    return { kind: 'unrelated' };
  }

  /**
   * 是否可以把「与已承接内容无关」的 final 文本整段补发（issue #44）。
   *
   * 四条同时成立才动手：static 下发通道可用 / **当前缓冲为空**（= 本段一条
   * partial 都没流出来，缓冲有内容说明本段已流出、final 与其无关属模型重写，
   * 那是 stream 模式同款的有意丢弃语义）/ 至少已发出一段（否则 final 压根
   * 不会走到流式分支）/ 未走外部投递通道。
   */
  private canRescueUndeliveredFinal(): boolean {
    return this.isStaticMode
      && !!this.deps.sendStatic
      && !this.lastAcceptedFull
      && this.sentChunkCount > 0
      && !this._deliveredExternally;
  }

  // ── 入口 ──

  onPartialReply(text: string): Promise<void> {
    this._hasStarted = true; // 同步置位：不等异步发送，final 就能感知流式已启动
    this.chain = this.chain.then(() => this.handleChunk(text)).catch((err) => {
      this.deps.log?.error(`onPartialReply error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'chunk_error');
    });
    return this.chain as Promise<void>;
  }

  finalize(): Promise<void> {
    this.chain = this.chain.then(() => this.handleFinalize()).catch((err) => {
      this.deps.log?.error(`finalize error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'finalize_error');
    });
    return this.chain as Promise<void>;
  }

  /**
   * static 模式：把当前累积段立即发出并重置缓冲，**不进入终态**。
   * 供框架 onAssistantMessageStart 回调调用（工具调用后新一段推理开始时触发）。
   * 对齐 telegram rotateLaneForNewMessage：固化旧段 + 开始新段。
   * 无累积内容时跳过（第一段开始时 lastAcceptedFull 为空）。
   */
  flushSegment(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.isTerminal || !this.isStaticMode) return;
      if (this.lastAcceptedFull && this.deps.sendStatic) {
        this.deps.log?.info(`flush segment chars=${this.lastAcceptedFull.length}`);
        try {
          await this.deps.sendStatic(this.lastAcceptedFull);
        } catch (err) {
          this.deps.log?.error(`flushSegment send failed: ${err instanceof Error ? err.message : String(err)}`);
          this.transition('failed', 'flush_send_error');
          return;
        }
        // 重置缓冲，开始新一段累积（保持 streaming 态，不进终态）
        this.lastAcceptedFull = '';
      }
    }).catch((err) => {
      this.deps.log?.error(`flushSegment error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'flush_error');
    });
    return this.chain as Promise<void>;
  }

  async abort(reason?: string): Promise<void> {
    if (this.isTerminal) return;
    this.deps.log?.warn(`aborting stream reason=${reason ?? 'manual'} sent=${this.sentChunkCount}`);
    if (this.session) {
      try { await this.session.complete(); } catch (e) {
        this.deps.log?.error(`abort complete failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.session = null;
    }
    this.transition('failed', `abort:${reason ?? 'manual'}`);
  }

  /**
   * 把框架 final payload 文本中未流出的尾巴（/usage tokens|full 的 footer
   * 等）**并入当前流式通道**，使其与正文呈现为同一条消息——QQ 无消息
   * 编辑 API，正文一旦发出不可追加（telegram 靠编辑最终消息实现同样效果）：
   * - stream 模式：作为前缀增长推入当前流式会话（随 finalize 的 complete 收尾）；
   * - static 模式：并入待发缓冲（随 finalize/flush 的 sendStatic 一条发出）；
   *   缓冲为空（正文已 flush）时尾巴独占缓冲，退化为单独一条。
   * 无尾巴 / 已终态 / stream 无会话时 no-op，残余场景由上层兜底单独补发。
   * 并入后同步推进 lastDeliveredSegmentText（差量基准），避免上层重复补发。
   *
   * **final 与已承接内容完全无关**时（matchFinalText → unrelated）分两种：
   * - static 且当前缓冲为空 = 本段一条 partial 都没流出来（issue #44：
   *   长回复 + 工具调用后，final 那 600+ 字正文既不进缓冲、差量又算不出，
   *   正文被静默丢弃）→ 整段补发一条，并推进基准让上层兜底不重复补发；
   * - static 缓冲非空 / stream 模式 = 模型重写，本段内容已可见，维持丢弃
   *   （stream 下补发会与流内已显示内容重复），仅留 INFO 日志便于排障。
   *
   * opts.signal：合并中止信号。dispatch 侧调用点的守卫只覆盖调用时刻，
   * 回调入队后、实际执行前仍可能中止（TOCTOU）——回调内重查，已取消的
   * 回复不得继续增长。
   */
  absorbFinalText(finalText: string, opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;
    this.chain = this.chain.then(() => this.runAbsorbFinalText(finalText, signal)).catch((err) => {
      this.deps.log?.error(`absorbFinalText error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'absorb_error');
    });
    return this.chain as Promise<void>;
  }

  // ── stream-all：滚动道/终稿道入口 ──

  /**
   * stream-all：文本块到达（deliver kind:'block' 的文本部分）。
   *
   * 后继块的存在证明 held 块是中间段 → 先提交进滚动道，新块进入 held
   * 扣住待定性（可能是终稿段）。滚动道以 markdown 分隔线隔开各条目，
   * 离散追加（不做 token 级打字机）。
   */
  onTextBlock(text: string): Promise<void> {
    this.chain = this.chain.then(() => this.runTextBlock(text)).catch((err) => {
      this.deps.log?.error(`onTextBlock error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'text_block_error');
    });
    return this.chain as Promise<void>;
  }

  /**
   * stream-all：工具 item 事件（onItemEvent）。
   *
   * phase=start → 先把 held 块提交进滚动道（工具的出现证明它是中间段），
   * 再以分隔线隔开追加 `🔧 <title>` 标题行；phase=end → 标题行仍是滚动道
   * 末尾时补 ` ✓`（QQ 流式前缀不可回改，只能追加；其后已有新内容则放弃）。
   * 只认工具类 item（toolCallId / kind ∈ tool|command|patch），preamble、
   * status 等不进滚动道。
   */
  onToolItem(payload: {
    itemId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
  }): Promise<void> {
    this.chain = this.chain.then(() => this.runToolItem(payload)).catch((err) => {
      this.deps.log?.error(`onToolItem error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'tool_item_error');
    });
    return this.chain as Promise<void>;
  }

  /**
   * stream-all：新 assistant 段开始（onAssistantMessageStart）。
   * held 块非空即被证明是中间段（它后面还有新段）→ 提交进滚动道。
   * 块投递经 SDK coalescer 有延迟时，这里是更早的提交触发点；即使本
   * 信号早于块到达（held 尚空），后继块到达时仍会正确提交。
   */
  beginSegment(): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (!this.isStreamAllMode || this.isTerminal || this.saLane === 'final') return;
      await this.commitHeldBlock();
    }).catch((err) => {
      this.deps.log?.error(`beginSegment error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'segment_error');
    });
    return this.chain as Promise<void>;
  }

  /**
   * stream-all：框架 final deliver（终稿文本权威到达）。
   *
   * held 块被终稿全文取代（从未展示，直接丢弃）。滚动道（若有）收尾后，
   * 开第二条流式会话把终稿按打字机节奏分片推完再收尾。终稿文本原样
   * 下发（含 usage footer）——滚动道里从来没有终稿内容，无需差量对账。
   */
  handleFinalDeliver(text: string, opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;
    this.chain = this.chain.then(() => this.runFinalDeliver(text, signal)).catch((err) => {
      this.deps.log?.error(`handleFinalDeliver error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'final_deliver_error');
    });
    return this.chain as Promise<void>;
  }
  /**
   * absorbFinalText 的核心实现。供 chain 包装器与 stream-all 的终稿路径
   * （runFinalDeliver）直接调用——**不得**在 chain 任务内再走 chain 包装
   * （嵌套 this.chain 赋值会互相等待，死锁）。
   */
  private async runAbsorbFinalText(finalText: string, signal?: AbortSignal): Promise<void> {
    if (this.isTerminal) return;
    if (signal?.aborted) return;
    const match = this.matchFinalText(finalText);
    if (match.kind === 'identical') return;
    if (match.kind === 'extension') {
      if (this.isStaticMode) {
        this.lastAcceptedFull = mergeSegmentBoundary(this.lastAcceptedFull, match.remainder);
        this.lastDeliveredSegmentText = this.lastAcceptedFull;
        this.deps.log?.info(`absorb final tail into static buffer chars=${match.remainder.length}`);
        return;
      }
      // stream：前缀增长推入当前会话；无会话（异常态）时留给上层兜底
      if (this.session) {
        await this.sendUpdate(mergeSegmentBoundary(this.lastAcceptedFull, match.remainder));
        this.deps.log?.info(`absorb final tail into stream chars=${match.remainder.length}`);
      }
      return;
    }
    // unrelated：final 与已承接内容毫无关系
    // 纯空白 final 直接忽略——那是一条空消息，白烧一条被动配额（dispatch 的
    // [stream-final] 差量兜底同样对 remainder 做 trim，两者口径一致）
    if (finalText.trim().length === 0) return;
    if (this.canRescueUndeliveredFinal()) {
      // issue #44 恢复路径：本段从未流出，整段补发。账本随之推进，上层
      // [stream-final] 差量兜底自动归零，不会重复补发。
      const sendStatic = this.deps.sendStatic;
      if (!sendStatic) return;
      try {
        await sendStatic(finalText);
      } catch (err) {
        this.deps.log?.error(`final rescue send failed: ${err instanceof Error ? err.message : String(err)}`);
        this.transition('failed', 'final_rescue_send_error');
        return;
      }
      this.lastDeliveredSegmentText = finalText;
      this.sentChunkCount++;
      this._finalRescued = true;
      this.deps.log?.info(
        `rescued undelivered final text chars=${finalText.length} segments=${this.sentChunkCount}`,
      );
      return;
    }
    if (this.isStaticMode) {
      // 缓冲非空 = 本段已流出内容，final 与其无关属模型重写，维持丢弃
      this.deps.log?.info(
        `final text rewritten mid-turn (bufferChars=${this.lastAcceptedFull.length}), dropped finalChars=${finalText.length}`,
      );
      return;
    }
    this.deps.log?.info(
      `stream: final text unrelated to streamed content, dropped finalChars=${finalText.length} (model rewrite)`,
    );
  }

  /**
   * stream-all：onToolItem 的核心实现（滚动道追加标题行 / 补 ✓）。
   */
  private async runToolItem(payload: {
    itemId?: string;
    toolCallId?: string;
    kind?: string;
    title?: string;
    name?: string;
    phase?: string;
    status?: string;
  }): Promise<void> {
    if (!this.isStreamAllMode || this.isTerminal || this.saLane === 'final') return;
    // 只认工具类 item（preamble/status 等不进滚动道）
    const isToolish = !!payload.toolCallId
      || payload.kind === 'tool'
      || payload.kind === 'command'
      || payload.kind === 'patch';
    if (!isToolish) return;

    // 主键优先 itemId，退化 toolCallId / title；别名全量登记，
    // 同一 item 后续事件（可能只带 toolCallId）也能解析回主键
    const aliases = [payload.itemId, payload.toolCallId, payload.title, payload.name]
      .map((v) => (typeof v === 'string' ? v.trim() : ''))
      .filter((v) => v.length > 0);
    const primary = this.resolveItemPrimary(aliases);
    if (!primary) return;

    if (payload.phase === 'end' || payload.phase === 'completed') {
      // 前缀不可回改：仅当该标题行仍是滚动道末尾（其后无新内容）时可补 ✓
      if (this.saTailItemKey === primary) {
        await this.appendRolling(' ✓');
        this.saTailItemKey = null;
      }
      return;
    }

    // start / update：同 key 只追加一次标题行（update 事件可能反复触发）
    if (this.saStartedItemKeys.has(primary)) return;
    this.saStartedItemKeys.add(primary);
    for (const alias of aliases) this.saItemAliases.set(alias, primary);

    // 先把 held 块提交进滚动道（工具的出现证明它是中间段），再挂标题行
    // （时间序：模型正文在前，工具调用在后）
    await this.commitHeldBlock();
    const label = (payload.title || payload.name || 'tool').trim() || 'tool';
    await this.appendRollingItem(`🔧 ${label}`);
    this.saTailItemKey = primary;
  }

  /**
   * stream-all：onTextBlock 的核心实现（held 块轮转）。
   */
  private async runTextBlock(text: string): Promise<void> {
    if (!this.isStreamAllMode || this.isTerminal || this.saLane === 'final') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // 后继块的存在证明 held 块是中间段 → 提交进滚动道；新块进入 held 待定性
    await this.commitHeldBlock();
    this.saHeldBlock = trimmed;
  }

  /** 从别名列表解析 item 主键：命中已登记的别名取其主键，否则取首个别名 */
  private resolveItemPrimary(aliases: string[]): string | null {
    for (const alias of aliases) {
      const mapped = this.saItemAliases.get(alias);
      if (mapped) return mapped;
    }
    return aliases[0] ?? null;
  }

  /**
   * stream-all：handleFinalDeliver 的核心实现（滚动道收尾 + 终稿道打字机）。
   */
  private async runFinalDeliver(finalText: string, signal?: AbortSignal): Promise<void> {
    if (this.isTerminal) return;
    if (signal?.aborted) return;

    // held 块被终稿全文取代（从未展示，丢弃不重复）；滚动道收尾、终稿走第二条消息
    this.saLane = 'final';
    this.saHeldBlock = null;
    this.saTailItemKey = null;
    await this.completeSession('rolling_done');
    // 对齐 new_reply 路径：收尾后清空账本，终稿道从零起账
    this.lastAcceptedFull = '';

    const text = finalText.trim();
    if (!text) {
      this.transition('done', 'finalize:empty_final');
      return;
    }

    // 终稿道打字机：分片 + 间隔推完（首片 lazy-open 第二条流式会话）。
    // sendUpdate 吞错内部转 failed——每片后查终态，失败即中断，
    // 不得继续记账（saFinalAcceptedChars 只统计平台已接受的字符）。
    const total = text.length;
    let acc = '';
    for (let off = 0; off < total; off += STREAM_ALL_FINAL_CHUNK_CHARS) {
      if (this.isTerminal || signal?.aborted) return; // abort() 已收尾当前会话
      acc += text.slice(off, off + STREAM_ALL_FINAL_CHUNK_CHARS);
      await this.sendUpdate(acc);
      if (this.isTerminal) return;
      this.saFinalAcceptedChars = acc.length;
      if (off + STREAM_ALL_FINAL_CHUNK_CHARS < total) {
        await delay(STREAM_ALL_FINAL_CHUNK_DELAY_MS);
      }
    }

    await this.completeSession('final_done');
    if (this.isTerminal) return;
    this.transition('done', 'finalize');
    this.deps.log?.info(
      `stream-all done rolling→final chars=${total} finalChunks=${Math.ceil(total / STREAM_ALL_FINAL_CHUNK_CHARS)}`,
    );
  }

  /**
   * stream-all：向滚动道追加内容（替换式 update 全量推送，QQ 流式的
   * 「前缀不可回改」约束下等价于尾部追加）。
   */
  private async appendRolling(next: string): Promise<void> {
    if (!next) return;
    await this.sendUpdate(this.lastAcceptedFull + next);
  }

  /**
   * stream-all：以 markdown 分隔线为界向滚动道追加一个中间条目
   * （正文段 / 🔧 工具标题行）。首条目不带前导分隔线。
   */
  private async appendRollingItem(content: string): Promise<void> {
    const sep = this.lastAcceptedFull ? STREAM_ALL_ITEM_SEPARATOR : '';
    await this.appendRolling(`${sep}${content}`);
  }

  /**
   * stream-all：把 held 块提交进滚动道（它已被后继事件证明是中间段）。
   * held 为空时 no-op；提交后 ✓ 标记资格清零（标题行后已有新内容）。
   */
  private async commitHeldBlock(): Promise<void> {
    const seg = this.saHeldBlock;
    this.saHeldBlock = null;
    if (!seg) return;
    await this.appendRollingItem(seg);
    this.saTailItemKey = null;
  }

  // ── 核心逻辑 ──

  private async handleChunk(text: string): Promise<void> {
    if (this.isTerminal || !text) return;

    // stream-all v2：文本经 deliver(kind:'block') 按完成段进入滚动道，
    // token 级 partial 不注册也不处理（防御：被误连时静默忽略）
    if (this.isStreamAllMode) return;

    // 正常续写：新文本前缀匹配（含空白归一化）
    if (prefixMatches(this.lastAcceptedFull, text)) {
      if (text.length !== this.lastAcceptedFull.length) {
        await this.sendUpdate(text);
      }
      return;
    }

    // 无已下发内容 → 首发
    if (!this.lastAcceptedFull) {
      await this.sendUpdate(text);
      return;
    }

    // static 模式：分段由框架 onAssistantMessageStart 明确驱动（flushSegment）。
    // 前缀不匹配时视为新一段开始 → 直接覆盖累积（不发送，发送由 flushSegment 负责）。
    // 不依赖"长度回退"启发式（长度相等时会误判为追加导致文本粘连）。
    if (this.isStaticMode) {
      this.deps.log?.info(`static new segment: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length}`);
      this.lastAcceptedFull = text;
      this.lastDeliveredSegmentText = text;
      this.sentChunkCount++;
      return;
    }

    // stream 模式：前缀不匹配 — 长度回退 → 新回复（工具调用后）
    if (text.length < this.lastAcceptedFull.length) {
      this.deps.log?.info(`new reply: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length}`);
      await this.completeSession('new_reply');
      this.lastAcceptedFull = '';
      await this.sendUpdate(text);
      return;
    }

    // 前缀不匹配但长度增长 → 模型重写尾部，同一条流追加
    const commonLen = longestCommonPrefix(this.lastAcceptedFull, text);
    const extra = text.slice(Math.max(commonLen, 0));
    const merged = this.lastAcceptedFull + extra;
    this.deps.log?.warn(
      `prefix retry: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length} common=${commonLen} extra=${extra.length}, appending`,
    );
    await this.sendUpdate(merged);
  }

  private async handleFinalize(): Promise<void> {
    if (this.isTerminal) return;

    // 静态模式：用累积的完整文本一次性 sendStatic 收尾
    if (this.isStaticMode) {
      if (this.sentChunkCount > 0 && this.lastAcceptedFull && this.deps.sendStatic) {
        await this.completeSession();
        // completeSession 内部 sendStatic 失败会先转 failed，此处不可回退为 done
        if (!this.isTerminal) {
          this.transition('done', 'finalize');
          this.deps.log?.info(`static done chunks=${this.sentChunkCount} chars=${this.lastAcceptedFull.length}`);
        }
      } else if (this.sentChunkCount > 0 && this.lastAcceptedFull) {
        // 未提供 sendStatic → 降级标记，由上层兜底发送
        this.transition('failed', 'finalize:no_sendstatic');
      } else if (this._deliveredExternally) {
        // 内容已通过外部通道投递（如 ask_user 卡片），非失败
        this.transition('done', 'finalize');
      } else if (this._finalRescued) {
        // final 正文已由 absorbFinalText 整段补发（issue #44 恢复路径），
        // 缓冲空是补发后重置的正常状态——不是「什么都没发」的降级
        this.transition('done', 'finalize:rescued');
      } else {
        this.transition('done', 'finalize:fallback');
      }
      return;
    }

    // stream 模式：用已下发文本收尾 — 不用框架 deliver 的文本（框架可能追加 ⚠️ 标记）
    if (this.session) {
      await this.completeSession();
      this.transition('done', 'finalize');
      this.deps.log?.info(`stream done chunks=${this.sentChunkCount} chars=${this.lastAcceptedFull.length}`);
      return;
    }

    // 无会话 — 视有无下发决定终态
    if (this.sentChunkCount > 0 || this._deliveredExternally) {
      this.transition('done', this.sentChunkCount > 0 ? 'finalize:no_session' : 'finalize');
    } else {
      this.transition('done', 'finalize:fallback');
    }
  }

  // ── QQ 交互 ──

  private async sendUpdate(text: string): Promise<void> {
    // 静态模式：仅累积文本到内存，不发任何网络请求；
    // 收尾时由 completeSession 一次性调用 sendStatic 发送完整文本。
    if (this.isStaticMode) {
      if (this.phase === 'idle') {
        this.transition('streaming', 'first_chunk');
        this.deps.log?.info(`static accumulate (firstChunk=${text.length})`);
      }
      this.lastAcceptedFull = text;
      this.lastDeliveredSegmentText = text;
      this.sentChunkCount++;
      return;
    }

    // stream 模式：打开/复用流式会话并下发分片
    if (!this.session) {
      this.session = this.deps.gateway.openStream(this.deps.target, this.deps.replyToId);
      this.transition('streaming', 'first_chunk');
      this.deps.log?.info(`stream opened (firstChunk=${text.length})`);
    }
    try {
      await this.session.update(text);
      this.lastAcceptedFull = text;
      this.lastDeliveredSegmentText = text;
      this.sentChunkCount++;
    } catch (err) {
      this.deps.log?.error(`update failed (len=${text.length}): ${err instanceof Error ? err.message : String(err)}`);
      // 失败分类：SDK ApiError httpStatus>0 = 平台明确拒绝（update 确定未
      // 应用）；httpStatus===0 / 非结构化错误 = 网络层失败，结果不明
      // （平台可能已应用、仅 ack 丢失）——后者不得补发尾巴，防与流内
      // 内容重复
      this.lastUpdateFailureAmbiguous = isAmbiguousStreamUpdateFailure(err);
      // 已有已接受文本的流必须收尾（发送 DONE 帧），否则用户端流式状态
      // 永久悬挂（典型：footer 合并 update 被拒，正文已可见）。complete
      // 失败只能容忍（连接已死的极端情形）。无已接受文本的空会话不收尾
      // （避免平台侧落一条空消息）。
      if (this.session && this.lastAcceptedFull) {
        await this.completeSession('update_failed');
      } else {
        this.session = null;
      }
      this.transition('failed', 'update_error');
    }
  }

  private async completeSession(reason?: string): Promise<void> {
    // 静态模式：把累积的完整文本一次性发出
    if (this.isStaticMode) {
      if (this.deps.sendStatic && this.lastAcceptedFull) {
        this.deps.log?.info(`static send (sent=${this.sentChunkCount} chars=${this.lastAcceptedFull.length} reason=${reason ?? 'done'})`);
        try {
          await this.deps.sendStatic(this.lastAcceptedFull);
        } catch (err) {
          this.deps.log?.error(`static send failed: ${err instanceof Error ? err.message : String(err)}`);
          this.transition('failed', 'static_send_error');
        }
      }
      return;
    }

    // stream 模式：关闭流式会话，发送 DONE 帧
    if (!this.session) return;
    this.deps.log?.info(`completing stream (sent=${this.sentChunkCount} chars=${this.lastAcceptedFull.length} reason=${reason ?? 'done'})`);
    try {
      await this.session.complete();
    } catch (err) {
      this.deps.log?.error(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.session = null;
  }

  // ── 状态机 ──

  private transition(next: StreamingPhase, reason: string): void {
    if (this.phase === next) return;
    this.deps.log?.info(`phase: ${this.phase} → ${next} (${reason})`);
    this.phase = next;
  }
}

/** 归一化空白符：连续换行/空格合并为单个空格 */
function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ');
}

/** 忽略空白前缀比较 */
function prefixMatches(accepted: string, incoming: string): boolean {
  if (incoming.startsWith(accepted)) return true;
  return normalizeWs(incoming).startsWith(normalizeWs(accepted));
}

function longestCommonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * 流式 update 失败是否「结果不明」。SDK 的 ApiError 带 httpStatus：
 * httpStatus > 0 = 收到了平台明确响应（拒绝/业务错误），update 确定
 * 未应用；httpStatus === 0 = 网络层失败（超时、连接中断），请求可能已
 * 被平台应用、只是 ack 丢失。非结构化错误一律按结果不明处理（保守）。
 */
function isAmbiguousStreamUpdateFailure(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const status = (err as { httpStatus?: unknown }).httpStatus;
    if (typeof status === 'number') return status === 0;
  }
  return true;
}

/**
 * 合并已流出段落与未流出尾巴的边界：差量基准是 trim 后的段落文本，而
 * 段落原文可能带尾随空白（provider 末帧常带 "\n"），直接拼接会与 final
 * 文本（已 trim，分隔符是 appendUsageLine 的单个 "\n"）叠加出重复空行
 * （如 "回答\n" + "\nUsage" → 双空行）。以 final 文本的边界为准：基座
 * 右去空白后原样接尾巴；基座为空（正文已 flush 的 static 退化路径）时
 * 去掉尾巴的前导空白，避免独立消息以空行开头。
 */
function mergeSegmentBoundary(base: string, remainder: string): string {
  const trimmedBase = base.replace(/\s+$/, '');
  if (!trimmedBase) return remainder.replace(/^\s+/, '');
  return trimmedBase + remainder;
}

/**
 * tail 以「非空白 token 序列一致、空白可有差异」的形式构成 finalText 的
 * 前缀时，返回该前缀在 finalText 中的**原始结束偏移**（最后一个匹配 token
 * 的末尾位置）；不构成前缀返回 -1。归一化前缀匹配的切片必须用这个偏移，
 * 而不是 tail.length（两者空白长度可能不同）。
 */
function normalizedPrefixEnd(finalText: string, tail: string): number {
  const tailTokens = tail.match(/\S+/g) ?? [];
  if (tailTokens.length === 0) return -1;
  let cursor = 0;
  let end = -1;
  for (const token of tailTokens) {
    while (cursor < finalText.length && /\s/.test(finalText[cursor] ?? '')) cursor++;
    if (!finalText.startsWith(token, cursor)) return -1;
    cursor += token.length;
    end = cursor;
  }
  return end;
}

// ── 入口判断 ──

import type { ResolvedQQBotAccount } from '../types.js';

export function shouldUseStreaming(
  account: ResolvedQQBotAccount,
  targetScope: 'c2c' | 'group' | 'channel',
): boolean {
  if (targetScope !== 'c2c') return false;
  const streaming = account.config?.streaming;
  return !!streaming && streaming.mode !== 'off';
}
