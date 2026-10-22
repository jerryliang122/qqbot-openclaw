/**
 * QQ Bot 流式消息控制器
 *
 * 核心约束：QQ 流式 API 替换模式下，已下发文本的**前缀不可变更**。
 *
 * stream 模式的「段」模型（issue #67）：
 * - **段** = openclaw 发来的一段 assistant 文本（框架每次 assistant 消息开始
 *   时触发 onAssistantMessageStart）。同一轮内的多次模型调用（工具调用续写 /
 *   provider 断流后 core 的 visible-answer 重试）会产生多段，段与段之间
 *   **没有公共前缀**。
 * - **一段 = 一条 QQ 流式消息**：段边界处收尾当前流式会话（DONE 帧）并另起
 *   一条，**每段内容原样送达、互不重叠**（对齐 telegram 的「每个 assistant
 *   消息一条气泡」）。这是本插件一直以来的形态，不得改成多段合并成一条。
 * - **绝不跨段截断拼接**：旧实现把「前缀不匹配的新文本」截断后拼到已发文本
 *   后面（`prefix retry` 支），产出两次尝试缝合的「草稿」——用户看到的是
 *   「第一条是第二条的一部分」「同一条回复被重发了一遍」。现场 A 的两条 QQ
 *   消息（收尾帧与开流帧相隔 343ms）就是这么来的。
 * - 长度启发式（"chunk 变短 ⇒ 新回复"）已废除：它把同轮重发误判成新回复，
 *   且对「新段比旧段长」完全失效（那种情况旧代码会走拼接支）。段边界改由
 *   框架信号 + 「新块不延续当前段」兜底判定。
 *
 * 状态机：
 *   IDLE → (first chunk) → STREAMING → (finalize) → DONE
 *                                      → (update failed) → FAILED
 *
 * onPartialReply(text) 输入：当前段的文本，段内持续增长。
 * beginSegment()        输入：框架 onAssistantMessageStart——新段开始，封口上一段。
 * closeSegment()        输入：段边界（工具调用等）——封口当前段，不终止整轮。
 * finalize()            标记：框架通知回复结束，用已下发文本收尾。
 */

import type { ReplyTarget, StreamSession } from '@tencent-connect/qqbot-nodejs';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'done' | 'failed';

export type StreamingSendMode = 'stream' | 'static';

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
   * partial 接收逻辑（状态机/串行/去重）在两种模式下完全一致。
   */
  sendMode?: StreamingSendMode;
  /**
   * 普通消息下发通道（sendText）：
   *   - 'static' 模式下是**主通道**——流结束时把累积的完整文本一次性发出；
   *   - 'stream' 模式下仅作**兜底补发**通道——终稿与已流出内容无关且本段
   *     从未流出时，整段补发（绝不静默丢弃，issue #67 的「内容丢失」面）。
   * 未提供时上述路径降级（static → shouldFallbackToStatic；stream → 交由
   * 上层兜底）。
   */
  sendStatic?: (fullText: string) => Promise<void>;
}

// ── 控制器 ──

export class StreamingController {
  private phase: StreamingPhase = 'idle';
  private session: StreamSession | null = null;

  /** QQ 已接受的最新文本 — 单源真理 */
  private lastAcceptedFull = '';

  /**
   * stream 模式：当前段的忠实文本（框架 partial 逐块增长，段内单调）。
   * 段边界由 beginSegment()/closeSegment()（框架 onAssistantMessageStart /
   * 工具调用）或「新块不延续当前段」兜底判定，**不再**用长度启发式猜
   * （issue #67 的根因）。
   */
  private currentSegmentText = '';

  /** stream 模式：当前段是否已推送到平台（false = 本段从未流出） */
  private currentSegmentPushed = false;

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

  /** 串行队列 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: StreamingControllerDeps) {}

  /** 是否走静态（普通 sendText）下发通道 */
  private get isStaticMode(): boolean { return this.deps.sendMode === 'static'; }

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
   * 是否可以把「与已承接内容无关」的 final 文本整段补发。
   *
   * - static 模式：四条同时成立才动手——普通消息通道可用 / **当前缓冲为空**
   *   （= 本段一条 partial 都没流出来，缓冲有内容说明本段已流出、final 与其
   *   无关属模型重写）/ 至少已发出一段 / 未走外部投递通道（issue #44）。
   * - stream 模式：**当前段从未推送到平台**（= 终稿是这一段的唯一文本，
   *   用户还没看到任何这段内容）→ 必须整段补发，绝不静默丢弃
   *   （issue #67 的「内容丢失」面）。当前段已推送时 final 与其无关 =
   *   同段内模型改写尾段，流内内容即答案，维持丢弃（补发会重复）。
   */
  private canRescueUndeliveredFinal(): boolean {
    if (!this.deps.sendStatic) return false;
    if (this._deliveredExternally) return false;
    if (this.sentChunkCount === 0) return false;
    if (this.isStaticMode) return !this.lastAcceptedFull;
    return !this.currentSegmentPushed;
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

  /**
   * 框架 onAssistantMessageStart：新一段 assistant 文本开始。
   *
   * stream 模式：封口上一段——收尾当前流式会话（DONE 帧）并另起一条，
   * **每段一条 QQ 消息、内容原样送达**（issue #67）。段结束 ≠ 整轮结束。
   * static 模式：语义不变（分段由 flushSegment 负责），此方法为空操作。
   *
   * 与 onPartialReply 共用同一条串行队列，避免与增量处理交叉。
   */
  beginSegment(): Promise<void> {
    return this.closeSegment('assistant_message_start');
  }

  /**
   * 封口当前段：收尾当前流式会话（DONE 帧），**不终止整轮**。
   *
   * 段边界有两个来源：
   * - 框架 onAssistantMessageStart（新一段 assistant 文本开始）；
   * - 工具调用（deliver(kind:'tool')）——工具执行前模型的文本已经说完。
   *
   * 旧实现是在工具事件上直接 `finalize()`（进入终态），于是工具调用之后的
   * 正文既不进缓冲又算不出差量 → **整段正文静默丢失**（issue #67 的丢内容面）。
   * 现在这里只封口「段」，整轮由 finalize() 收尾。
   */
  closeSegment(reason: string): Promise<void> {
    this.chain = this.chain.then(() => this.doCloseSegment(reason)).catch((err) => {
      this.deps.log?.error(`closeSegment error: ${err instanceof Error ? err.message : String(err)}`);
    });
    return this.chain as Promise<void>;
  }

  /**
   * 封口当前段的实际动作——**必须在控制器串行队列内执行**。
   * 不可在此再入队（chain.then），否则队列内的调用方 await 自己排队的任务
   * → 自锁（handleChunk → closeSegment → 等待排在 handleChunk 之后的自己）。
   */
  private async doCloseSegment(reason: string): Promise<void> {
    if (this.isTerminal || this.isStaticMode) return;
    if (!this.currentSegmentText) return;
    this.deps.log?.info(`segment sealed chars=${this.currentSegmentText.length} reason=${reason}`);
    await this.completeSession(`segment_boundary:${reason}`);
    this.currentSegmentText = '';
    this.currentSegmentPushed = false;
    this.lastAcceptedFull = '';
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
    this.chain = this.chain.then(async () => {
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
          const merged = mergeSegmentBoundary(this.lastAcceptedFull, match.remainder);
          await this.sendUpdate(merged);
          // 推送失败（phase=failed）时**不推进基准**——尾巴仍未进流，
          // 交由上层 [stream-final] 差量兜底补发（否则正文/footer 会丢）
          if (this.isTerminal) return;
          // 终稿是本段的权威文本 → 段基准推进到终稿（避免上层重复补发尾巴）
          this.currentSegmentText = finalText;
          this.currentSegmentPushed = true;
          this.lastDeliveredSegmentText = finalText;
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
          `final text rewritten mid-turn (final match=unrelated → action=dropped, bufferChars=${this.lastAcceptedFull.length}) dropped finalChars=${finalText.length}`,
        );
        return;
      }
      this.deps.log?.info(
        `stream: final text unrelated to streamed content (final match=unrelated → action=dropped, currentSegmentChars=${this.currentSegmentText.length}) dropped finalChars=${finalText.length} (model rewrite)`,
      );
    }).catch((err) => {
      this.deps.log?.error(`absorbFinalText error: ${err instanceof Error ? err.message : String(err)}`);
      this.transition('failed', 'absorb_error');
    });
    return this.chain as Promise<void>;
  }

  // ── 核心逻辑 ──

  private async handleChunk(text: string): Promise<void> {
    if (this.isTerminal || !text) return;

    if (this.isStaticMode) {
      // ── static 模式（语义不变）──
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
      // 分段由框架 onAssistantMessageStart 明确驱动（flushSegment）。
      // 前缀不匹配时视为新一段开始 → 直接覆盖累积（不发送，发送由 flushSegment 负责）。
      // 不依赖"长度回退"启发式（长度相等时会误判为追加导致文本粘连）。
      this.deps.log?.info(`static new segment: lastAccepted=${this.lastAcceptedFull.length}→chunk=${text.length}`);
      this.lastAcceptedFull = text;
      this.lastDeliveredSegmentText = text;
      this.sentChunkCount++;
      return;
    }

    // ── stream 模式（段模型，issue #67）──
    // 段内增长：新文本延续当前段 → 同一条消息继续增长
    if (this.currentSegmentText && prefixMatches(this.currentSegmentText, text)) {
      this.currentSegmentText = text;
      await this.sendUpdate(text);
      return;
    }
    // 段边界：新文本不延续当前段（同轮第二次模型调用 / 模型重写整段 / 工具
    //   调用后开启新一段）→ 封口当前段（收尾旧消息）并**另起一条消息**，
    //   新段内容原样送达。
    // 绝不把新文本截断后拼到旧文本后面——那会产生「草稿」式内容重叠
    // （用户看到两次尝试被缝在一起），且前缀不可变更的约束下也无法回改。
    if (this.currentSegmentText) {
      this.deps.log?.info(
        `new segment detected: prevChars=${this.currentSegmentText.length} newChars=${text.length} (new message, verbatim, no splicing)`,
      );
      await this.doCloseSegment('new_segment');
    }
    this.currentSegmentText = text;
    this.currentSegmentPushed = false;
    await this.sendUpdate(text);
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
      this.lastAcceptedFull = text;                              // 平台已见正文（整段拼接结果）
      this.lastDeliveredSegmentText = this.currentSegmentText;   // 差量基准 = 当前段
      if (this.currentSegmentText) this.currentSegmentPushed = true;
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
