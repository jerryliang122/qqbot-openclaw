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
 */

import type { ReplyTarget, StreamSession } from '@tencent-connect/qqbot-nodejs';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { QQBotGateway } from '../gateway/qqbot-gateway.js';

// ── 类型 ──

export type StreamingPhase = 'idle' | 'streaming' | 'done' | 'failed';

export type StreamingSendMode = 'stream' | 'static';

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
   * static 模式专用：在 finalize 收尾时把累积的完整文本一次性发出。
   * stream 模式下不使用。未提供时 static 模式将降级为 shouldFallbackToStatic。
   */
  sendStatic?: (fullText: string) => Promise<void>;
}

// ── 控制器 ──

export class StreamingController {
  private phase: StreamingPhase = 'idle';
  private session: StreamSession | null = null;

  /** QQ 已接受的最新文本 — 单源真理 */
  private lastAcceptedFull = '';

  /** 已成功发送的分片数（降级：=0 则走静态消息兜底） */
  private sentChunkCount = 0;

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
    return this.isTerminal && this.sentChunkCount === 0;
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

  // ── 核心逻辑 ──

  private async handleChunk(text: string): Promise<void> {
    if (this.isTerminal || !text) return;

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
    if (this.sentChunkCount > 0) {
      this.transition('done', 'finalize:no_session');
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
      this.sentChunkCount++;
    } catch (err) {
      this.deps.log?.error(`update failed (len=${text.length}): ${err instanceof Error ? err.message : String(err)}`);
      this.session = null;
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
