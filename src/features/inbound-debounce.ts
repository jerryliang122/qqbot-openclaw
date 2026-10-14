/**
 * C2C 入站消息防抖合并（文件 + 伴随文字 → 单个 turn）
 *
 * 背景（2026-10-14）：QQ 私聊除图片外，文件与文字只能是两条独立消息
 * （QQ 无"文件描述"附件窗口），而 c2c turn 是可插嘴的（exclusive +
 * abortSignal）——先发的文件 turn 会被随后到达的文字消息直接打断
 * （onAbandoned → abort），文件处理半途而废。本模块在 dispatch 之前
 * 把同一私聊发送者在防抖窗口内的连续消息合并为一次 dispatch。
 *
 * 机制：复用框架官方防抖原语（openclaw/plugin-sdk/channel-inbound 的
 * createInboundDebouncer / resolveInboundDebounceMs / shouldDebounceTextInbound，
 * telegram 通道同款），计时器语义为滑动窗口（每条新消息重置窗口），
 * 框架硬上限 debounceMs × 5 防连珠炮无限延期。
 *
 * 关键决策（与 telegram 的差异，勿"对齐"回去）：
 * - telegram 默认 lane 只防抖纯文本、媒体直发（shouldDebounceTextInbound
 *   的 hasMedia 分支返回 false）；本插件相反——纯附件消息（文件/图片/
 *   语音）必须开窗等待伴随文本，这正是本功能的存在理由。因此
 *   shouldDebounceTextInbound 仅用于文本消息的控制命令旁路判定，
 *   hasMedia 刻意传 false，纯附件消息独立判定为 true。
 * - 控制命令（框架 abort 触发词 stop/esc/abort/exit 等）旁路防抖即时
 *   dispatch（对齐 telegram）；若旁路时同 key 已有 pending buffer，
 *   debouncer 会先冲刷 buffer 再执行命令，顺序保持。
 *
 * 合并语义（onFlush 多条时）：
 * - 载体 = 最后一条消息的 ctx/msg（messageId = 被动回复锚点，窗口最新、
 *   配额最全；request context 同样取自最后一条）；
 * - ctx.state.assembledBody ← 各条 agentBody/webBody 按序拼接（[消息 i/N]
 *   分节头），rawBody 按行拼接；各条 assembledBody 由 envelopeFormatter
 *   中间件在入站时逐条产出（附件下载/STT 已完成），缺失时兜底现场组装；
 * - ctx.state.processedAttachments ← 各条字段合并（media 数组按序 concat，
 *   保住框架正规媒体通道的 media facts，文件 localPath 才能进 MediaPaths）；
 * - 单条 flush → 原路径直发，零行为变化。
 *
 * per-message 记账（msgid-cache 被动锚点登记、recordKnownUser、群模式
 * 推断）在 enqueue 之前由 handleMessage 照常逐条立即执行，不受防抖影响。
 *
 * 群聊不经过本模块（框架 followup 队列已承担群合并，且群有 mention
 * 门控语义，合并会破坏唤醒判定）。
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import {
  createInboundDebouncer,
  resolveInboundDebounceMs as resolveFrameworkInboundDebounceMs,
  shouldDebounceTextInbound,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { AssembledBody } from '../dispatch/body-assembler.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { assembleBody } from '../dispatch/body-assembler.js';
import { getAdapters } from '../adapter/resolve.js';
import { runWithRequestContext } from '../request-context.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';

/** 默认防抖窗口：3 秒（QQ 客户端连发"文件 + 说明"的典型间隔内） */
export const DEFAULT_C2C_INBOUND_DEBOUNCE_MS = 3000;
/** 防抖窗口上限（钳制） */
export const MAX_C2C_INBOUND_DEBOUNCE_MS = 60_000;

/** 防抖队列条目：一条已完成中间件链处理的 c2c 入站消息 */
export interface C2CInboundDebounceItem {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  account: ResolvedQQBotAccount;
  runtime: PluginRuntime;
  log?: PluginLogger;
  /** 入队时的框架配置快照（控制命令判定用，逐条取新） */
  cfg: Record<string, unknown>;
}

type Debouncer = ReturnType<typeof createInboundDebouncer<C2CInboundDebounceItem>>;

/** accountId → { debouncer, 活跃 key 集 }（key 含 senderId 隔离不同用户） */
const debouncers = new Map<string, { debouncer: Debouncer; keys: Set<string> }>();
/** 每账号只打一次「防抖已接管」INFO（对齐 [queue] 接管留痕惯例） */
const announced = new Set<string>();

/** 防抖 key：账号 + 发送者（与 buildKey 回调同一实现，退出冲刷时复用） */
function buildC2CDebounceKey(item: C2CInboundDebounceItem): string {
  return `qqbot:${item.account.accountId}:c2c:${item.msg.senderId}`;
}

function clampDebounceMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_C2C_INBOUND_DEBOUNCE_MS, Math.trunc(value)));
}

/**
 * 解析 c2c 入站防抖窗口（毫秒），0 = 关闭。
 *
 * 优先级：插件 channels.qqbot.inboundDebounce.debounceMs（显式，0 关闭）
 * → 框架 messages.inbound.byChannel.qqbot / messages.inbound.debounceMs
 * → 默认 3000。注意框架配置无法表达"显式 0"（未设与设 0 同为 0），
 * 要关闭请用插件侧 inboundDebounce: { debounceMs: 0 } 或 { enabled: false }。
 */
export function resolveC2CInboundDebounceMs(
  account: ResolvedQQBotAccount,
  cfg: Record<string, unknown> | undefined,
): number {
  const conf = account.config?.inboundDebounce;
  if (conf?.enabled === false) return 0;
  if (typeof conf?.debounceMs === 'number') {
    return clampDebounceMs(conf.debounceMs);
  }
  const frameworkMs = resolveFrameworkInboundDebounceMs({
    cfg: cfg as never,
    channel: 'qqbot',
  });
  if (frameworkMs > 0) return clampDebounceMs(frameworkMs);
  return DEFAULT_C2C_INBOUND_DEBOUNCE_MS;
}

/** shouldDebounce 策略：c2c 全量防抖，唯控制命令旁路（见模块头注释） */
function shouldDebounceC2CItem(item: C2CInboundDebounceItem): boolean {
  const text = String(item.msg?.content ?? '').trim();
  if (!text) return true; // 纯附件消息（文件/图片/语音）必须开窗等待伴随文本
  return shouldDebounceTextInbound({ text, cfg: item.cfg as never, hasMedia: false });
}

/**
 * 合并多条消息的 assembledBody。
 * agentBody/webBody 加 [消息 i/N] 分节头按序拼接；rawBody 按行拼接
 * （下游斜杠命令判定只看首字符，拼接后语义与首条一致）。
 */
export function mergeAssembledBodies(list: AssembledBody[]): AssembledBody {
  if (list.length === 1) return list[0]!;
  const header = (i: number) => `[消息 ${i + 1}/${list.length}]`;
  const agentBody = list.map((b, i) => `${header(i)}\n${b.agentBody}`).join('\n\n');
  const webBody = list.map((b, i) => `${header(i)}\n${b.webBody}`).join('\n\n');
  const rawBody = list
    .map((b) => (b.rawBody ?? '').trim())
    .filter(Boolean)
    .join('\n');
  const systemPrompt = list.map((b) => b.systemPrompt).find((v) => v !== undefined);
  return { webBody, agentBody, rawBody, systemPrompt };
}

/**
 * 合并多条消息的 ProcessedAttachments。
 * media 按消息顺序 concat（框架 media facts 顺序即用户发送顺序）；
 * localMediaPaths/localMediaTypes 是平行数组，各自 concat 保持配对；
 * URL 列表去重（同一 URL 重复推送无意义）。
 */
export function mergeProcessedAttachments(list: ProcessedAttachments[]): ProcessedAttachments {
  if (list.length === 1) return list[0]!;
  const joinLines = (parts: Array<string | undefined>) =>
    parts.filter((p): p is string => !!p && p.length > 0).join('\n');
  const concatUnique = (arrays: string[][]) => [...new Set(arrays.flat())];
  return {
    voiceText: joinLines(list.map((p) => p.voiceText)),
    imageUrls: concatUnique(list.map((p) => p.imageUrls)),
    otherInfo: joinLines(list.map((p) => p.otherInfo)),
    transcripts: list.flatMap((p) => p.transcripts),
    localMediaPaths: list.flatMap((p) => p.localMediaPaths),
    localMediaTypes: list.flatMap((p) => p.localMediaTypes),
    remoteMediaUrls: concatUnique(list.map((p) => p.remoteMediaUrls)),
    media: list.flatMap((p) => p.media),
  };
}

/** 单条/合并后的统一 dispatch 入口（请求级上下文取自载体消息） */
async function dispatchItem(item: C2CInboundDebounceItem): Promise<void> {
  const targetId = `qqbot:c2c:${item.msg.replyTarget.targetId}`;
  await runWithRequestContext(
    {
      accountId: item.account.accountId,
      messageId: item.msg.messageId,
      openId: item.msg.senderId,
      target: targetId,
    },
    () => dispatchToOpenClaw(item.ctx, item.msg, item.account, item.runtime, item.log),
  );
}

/**
 * 构造合并载体：直接改写最后一条消息 ctx 的 state（dispatch 侧只从
 * ctx.state.assembledBody / ctx.state.processedAttachments 读取，不复制
 * ctx——上面还挂着 bot/replyTarget/log 等原语，复制丢语义）。
 * assembledBody 缺失时兜底现场组装（envelopeFormatter 正常都会产出，
 * 这里是防御路径，保证任何情况下不丢用户内容）。
 */
function buildMergedCarrier(items: C2CInboundDebounceItem[]): MiddlewareContext {
  const last = items[items.length - 1]!;
  const assembledList = items.map(
    (i) =>
      ((i.ctx.state as Record<string, unknown>).assembledBody as AssembledBody | undefined) ??
      assembleBody(i.ctx, i.msg, i.account),
  );
  const processedList = items
    .map((i) => (i.ctx.state as Record<string, unknown>).processedAttachments as ProcessedAttachments | undefined)
    .filter((p): p is ProcessedAttachments => !!p);

  const state = last.ctx.state as Record<string, unknown>;
  state.assembledBody = mergeAssembledBodies(assembledList);
  if (processedList.length > 0) {
    state.processedAttachments = mergeProcessedAttachments(processedList);
  }
  return last.ctx;
}

function getOrCreateDebouncer(item: C2CInboundDebounceItem, initialDebounceMs: number): Debouncer {
  const existing = debouncers.get(item.account.accountId);
  if (existing) return existing.debouncer;

  const dlog = item.log?.child('inbound-debounce');
  const debouncer = createInboundDebouncer<C2CInboundDebounceItem>({
    debounceMs: initialDebounceMs,
    serializeImmediate: true,
    // 逐条解析窗口（账号配置热更新生效；框架实现里每条新消息都会刷新 buffer 的 debounceMs）
    resolveDebounceMs: (i) => resolveC2CInboundDebounceMs(i.account, i.cfg),
    buildKey: buildC2CDebounceKey,
    shouldDebounce: shouldDebounceC2CItem,
    onFlush: (items) => {
      const completion = (async () => {
        if (items.length === 1) {
          await dispatchItem(items[0]!);
          return;
        }
        const last = items[items.length - 1]!;
        dlog?.info(
          `[inbound-debounce] merged ${items.length} c2c messages sender=${last.msg.senderId} anchorMsgId=${last.msg.messageId}`,
        );
        await dispatchItem({ ...last, ctx: buildMergedCarrier(items) });
      })();
      return { admission: completion, completion };
    },
    onError: (err, items) => {
      const first = items[0];
      dlog?.error(
        `c2c debounce flush failed (${items.length} items, first msgId=${first?.msg.messageId ?? '?'}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });
  debouncers.set(item.account.accountId, { debouncer, keys: new Set() });
  return debouncer;
}

/**
 * c2c 入站消息入防抖队列。
 *
 * 返回 true = 已接管（进缓冲区，或控制命令旁路的立即 dispatch 已在
 * enqueue 内完成）；返回 false = 未接管（防抖关闭或非 c2c 消息），
 * 调用方走原直发路径。
 */
export async function enqueueC2CInboundMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<boolean> {
  if (msg.replyTarget?.scope !== 'c2c') return false;

  const cfg = (getAdapters(runtime).getConfig?.() ?? {}) as Record<string, unknown>;
  const debounceMs = resolveC2CInboundDebounceMs(account, cfg);
  if (!(debounceMs > 0)) return false;

  const item: C2CInboundDebounceItem = { ctx, msg, account, runtime, log, cfg };
  getOrCreateDebouncer(item, debounceMs);
  const entry = debouncers.get(account.accountId)!;
  entry.keys.add(buildC2CDebounceKey(item));

  if (!announced.has(account.accountId)) {
    announced.add(account.accountId);
    log
      ?.child('inbound-debounce')
      ?.info(`[inbound-debounce] c2c inbound debounce armed (debounceMs=${debounceMs}, sliding window, framework cap ×5)`);
  }

  await entry.debouncer.enqueue(item);
  return true;
}

/**
 * 进程退出前强制冲刷全部 pending 缓冲。
 *
 * 框架 debouncer 的 drain() 只等待在途任务、不冲刷 pending buffer
 * （buffer 的 flush timer 是 unref 的，退出时永不触发）——必须对每个
 * 活跃 key 显式 flushKey 才能把窗口内的消息发出去。SIGINT/SIGTERM 下
 * best-effort（process.exit 不等待）；beforeExit 下 flush 的异步 dispatch
 * 会重新拉起事件循环自然完成。
 */
export async function flushAllC2CInboundDebouncers(): Promise<void> {
  await Promise.allSettled(
    [...debouncers.values()].flatMap(({ debouncer, keys }) =>
      [...keys].map((key) => debouncer.flushKey(key)),
    ),
  );
}

/** 测试用：清空 debouncer 注册表与一次性公告标记 */
export function resetC2CInboundDebouncersForTest(): void {
  debouncers.clear();
  announced.clear();
}
