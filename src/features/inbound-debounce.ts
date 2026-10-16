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
 *
 * 三类旁路（shouldDebounce 返回 false，经框架 debouncer 序列化：
 * 若同 key 有 pending buffer 会先冲刷再执行，顺序保持；同 key 有
 * in-flight 任务链时等其放行——见下「admission 放行」段）：
 * - 控制命令（框架 abort 触发词 stop/esc/abort/exit 等，判定来自
 *   shouldDebounceTextInbound / isControlCommandMessage）；
 * - 斜杠命令（rawBody 以 '/' 开头）：合并会破坏 buildCtxPayload 的
 *   命令标记（rawBody 拼接后可能不以 '/' 开头），必须原样直发；
 * - 多问题 ask_user 的 keyed 答案文本（"1: 3\n2: 1"）：合并会改写答案
 *   文本，框架 keyed 文本认领失败 → 挂起的 ask_user 永远等不到答案；
 *   按 findPendingMultiQuestionByConversation(accountId, 'c2c', peer) 识别
 *   （会话键含账号维度——openid 是 per-account 的，跨账号不共享 pending）。
 *
 * admission 放行（2026-10-16 修复，红线）：onFlush 返回的 admission 与
 * completion 必须解耦——框架 debouncer 的同 key 任务链持有到 admission
 * settle，enqueue 对旁路项在同 key 有 in-flight 任务时会排队等它。若
 * admission === completion（覆盖整个 turn run），任务 turn 运行期间到达的
 * /stop 要等 turn 跑完才 dispatch（插嘴失效），挂起 ask_user 的 keyed
 * 答案更会被自己等待的 turn 死锁。admission 必须在「turn 已提交进框架
 * 网关」（dispatchToOpenClaw 的 onTurnSubmitted = adapters.inboundRun
 * 已调用）时 resolve，completion settle 时兜底；网关按提交序 FIFO，
 * 旁路仍晚于同 key 前一批次的提交，顺序保持。
 *
 * 合并语义（onFlush 多条时）：
 * - 先按平台事件 timestamp 稳定排序（中间件链并发执行，附件下载慢的
 *   早到消息可能晚于快消息完成 enqueue——入队顺序 ≠ 到达顺序）；
 * - 载体 = 排序后最后一条（最新到达）消息的 ctx/msg（messageId = 被动
 *   回复锚点，窗口最新、配额最全；request context 同样取自它）；
 * - ctx.state.assembledBody ← 各条 agentBody/webBody 按序拼接（[消息 i/N]
 *   分节头），rawBody 按行拼接；各条 assembledBody 由 envelopeFormatter
 *   中间件在入站时逐条产出（附件下载/STT 已完成），缺失时兜底现场组装；
 * - ctx.state.processedAttachments ← 各条字段合并（media 数组按序 concat，
 *   保住框架正规媒体通道的 media facts，文件 localPath 才能进 MediaPaths）；
 * - 单条 flush → 原路径直发，零行为变化。
 *
 * 入队 await 语义（typing 续命，Sourcery 意见 6）：enqueueC2CInboundMessage
 * 不在入队时返回，而是等到该项所在 batch 的 dispatch 完成才 resolve——
 * SDK 的 handleInboundMessage 并发执行（onMessage 不 await），held-open
 * 的中间件链不会阻塞其他消息；typing 中间件的续期 timer 恰好活到 turn
 * 结束（与防抖前行为一致）。非载体项在 flush 开始时先 resolve（它们的
 * typing 实例立即退场，只留载体一个续期源，避免 N 条消息 N 个 typing
 * 推送烧配额）。deferred 在 onError / onCancel 也必须 resolve，否则
 * handleMessage 永久挂起。
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
import { dispatchToOpenClaw, type DispatchToOpenClawOptions } from '../dispatch/index.js';
import { findPendingMultiQuestionByConversation } from './question-helpers.js';

/** 默认防抖窗口：3 秒（QQ 客户端连发"文件 + 说明"的典型间隔内） */
export const DEFAULT_C2C_INBOUND_DEBOUNCE_MS = 3000;
/** 防抖窗口上限（钳制） */
export const MAX_C2C_INBOUND_DEBOUNCE_MS = 60_000;

/** 入队项的完成信号：flush dispatch 完成时 resolve（见模块头「typing 续命」段） */
interface ItemDone {
  promise: Promise<void>;
  resolve: () => void;
}

/** 防抖队列条目：一条已完成中间件链处理的 c2c 入站消息 */
export interface C2CInboundDebounceItem {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  account: ResolvedQQBotAccount;
  runtime: PluginRuntime;
  log?: PluginLogger;
  /** 入队时的框架配置快照（控制命令判定用，逐条取新） */
  cfg: Record<string, unknown>;
  /** 完成信号（enqueueC2CInboundMessage 内部创建，onFlush/onError/onCancel resolve） */
  done?: ItemDone;
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

/**
 * shouldDebounce 策略：c2c 全量防抖，三类旁路（见模块头注释）。
 * 旁路经框架 debouncer 序列化（先冲刷同 key pending buffer 再执行）。
 */
function shouldDebounceC2CItem(item: C2CInboundDebounceItem): boolean {
  const text = String(item.msg?.content ?? '').trim();
  if (!text) return true; // 纯附件消息（文件/图片/语音）必须开窗等待伴随文本

  // 斜杠命令：合并会破坏命令标记（rawBody 拼接后可能不以 '/' 开头）
  if (text.startsWith('/')) return false;

  // 多问题 ask_user 的 keyed 答案文本：合并会改写答案、认领失败。
  // 会话键含 accountId（openid 是 per-account 的，跨账号同 targetId
  // 不共享 pending 记录）
  if (findPendingMultiQuestionByConversation(item.account.accountId, 'c2c', item.msg.replyTarget.targetId)) {
    return false;
  }

  // 控制命令（stop/esc/abort/exit 等）：hasMedia 刻意传 false——框架默认
  // 策略不防抖媒体，本插件场景相反，仅借它的控制命令判定
  return shouldDebounceTextInbound({ text, cfg: item.cfg as never, hasMedia: false });
}

/**
 * 合并多条消息的 assembledBody。
 * agentBody/webBody 加 [消息 i/N] 分节头按序拼接；rawBody 按行拼接
 * （下游斜杠命令判定只看首字符，拼接后语义与首条一致——斜杠命令本身
 * 已经旁路防抖，不会进入合并路径）。
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
async function dispatchItem(
  item: C2CInboundDebounceItem,
  opts?: DispatchToOpenClawOptions,
): Promise<void> {
  const targetId = `qqbot:c2c:${item.msg.replyTarget.targetId}`;
  await runWithRequestContext(
    {
      accountId: item.account.accountId,
      messageId: item.msg.messageId,
      openId: item.msg.senderId,
      target: targetId,
    },
    () => dispatchToOpenClaw(item.ctx, item.msg, item.account, item.runtime, item.log, opts),
  );
}

/** 平台事件 timestamp → epoch ms（不可解析回退 0，排序时沉到最前＝最旧） */
function arrivalMs(item: C2CInboundDebounceItem): number {
  const parsed = Date.parse(String((item.msg as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
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

function settleItems(items: C2CInboundDebounceItem[]): void {
  for (const i of items) i.done?.resolve();
}

function getOrCreateDebouncer(item: C2CInboundDebounceItem, initialDebounceMs: number): Debouncer {
  const existing = debouncers.get(item.account.accountId);
  if (existing) return existing.debouncer;

  const dlog = item.log?.child('inbound-debounce');
  // onFlush 闭包晚于 debouncers.set 生效（flush 只能发生在首次 enqueue 之后），
  // 用 holder 引用避免「创建时 entry 尚未入表」的先有鸡先有蛋
  const entryHolder: { current?: { debouncer: Debouncer; keys: Set<string> } } = {};

  const debouncer = createInboundDebouncer<C2CInboundDebounceItem>({
    debounceMs: initialDebounceMs,
    serializeImmediate: true,
    // 逐条解析窗口（账号配置热更新生效；框架实现里每条新消息都会刷新 buffer 的 debounceMs）
    resolveDebounceMs: (i) => resolveC2CInboundDebounceMs(i.account, i.cfg),
    buildKey: buildC2CDebounceKey,
    shouldDebounce: shouldDebounceC2CItem,
    onFlush: (rawItems) => {
      // 同步前缀（JS 单线程，不会与并发 enqueue 交错）：
      // 1. key 清理——batch 即被冲刷的 buffer，对应 key 立即出表，
      //    防止长期运行下 entry.keys 无限累积（Sourcery 意见 7）；
      //    之后到达的同 key 消息会重新 add，语义正确。
      // 2. 到达顺序排序——中间件链并发，入队顺序 ≠ 平台到达顺序
      //    （Sourcery 意见 5），按平台 timestamp 稳定排序。
      // 3. 非载体项的完成信号立即 resolve——它们的 typing 中间件实例
      //    退场，只留载体一个续期源（Sourcery 意见 6）。
      const entry = entryHolder.current;
      for (const i of rawItems) entry?.keys.delete(buildC2CDebounceKey(i));
      const items = rawItems.length > 1
        ? [...rawItems].sort((a, b) => arrivalMs(a) - arrivalMs(b))
        : rawItems;
      if (items.length > 1) settleItems(items.slice(0, -1));

      // admission（放行）与 completion（typing 续命）解耦（2026-10-16 修复）：
      // 框架 debouncer 的同 key 任务链持有到 onFlush 返回的 admission settle
      // 为止；而旁路消息（/stop 等控制命令、斜杠命令、keyed 答案）在 enqueue
      // 时若同 key 有 in-flight 任务会被排队等其 settle（inbound-debounce
      // 框架实现 enqueue 的 keyChains 分支）。此前 admission === completion
      // （覆盖整个 turn run），任务运行期间到达的 /stop 要等 turn 跑完才
      // dispatch——插嘴语义（c2c exclusive + abortSignal 取消旧 turn）完全
      // 失效，且挂起 ask_user 的 keyed 答案会被自己等待的 turn 死锁。
      // 现 admission 在 turn 提交进框架网关（onTurnSubmitted，即
      // adapters.inboundRun 已调用）时 resolve：链及时释放，旁路立即
      // dispatch；网关按提交序 FIFO，顺序仍保持。completion settle 时兜底
      // admit（覆盖 adapters 缺失提前返回 / 提交前抛错——链永不悬挂）。
      // 语义对齐框架 createInboundDebounceFlush 的 admission 设计
      // （adopted/deferred/failed 任一即放行），但不依赖框架回调时机。
      let markAdmitted!: () => void;
      const admission = new Promise<void>((resolve) => {
        markAdmitted = resolve;
      });
      let admitted = false;
      const admit = () => {
        if (admitted) return;
        admitted = true;
        markAdmitted();
      };

      const completion = (async () => {
        try {
          if (items.length === 1) {
            await dispatchItem(items[0]!, { onTurnSubmitted: admit });
            return;
          }
          const last = items[items.length - 1]!;
          dlog?.info(
            `[inbound-debounce] merged ${items.length} c2c messages sender=${last.msg.senderId} anchorMsgId=${last.msg.messageId}`,
          );
          await dispatchItem({ ...last, ctx: buildMergedCarrier(items) }, { onTurnSubmitted: admit });
        } finally {
          // 载体项在 dispatch 完成后 resolve：其 typing 链活到 turn 结束
          settleItems(items);
          admit();
        }
      })();
      return { admission, completion };
    },
    onError: (err, items) => {
      const first = items[0];
      dlog?.error(
        `c2c debounce flush failed (${items.length} items, first msgId=${first?.msg.messageId ?? '?'}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
      // flush 失败也必须放行完成信号，否则 handleMessage 永久挂起
      settleItems(items);
    },
    onCancel: (items) => {
      // 防御路径：cancelKey（当前无调用方）导致的丢弃，同样放行信号
      settleItems(items);
    },
  });
  const entry = { debouncer, keys: new Set<string>() };
  entryHolder.current = entry;
  debouncers.set(item.account.accountId, entry);
  return debouncer;
}

/**
 * c2c 入站消息入防抖队列。
 *
 * 返回 true = 已接管（进缓冲区，或旁路的立即 dispatch 已在内部完成）；
 * 返回 false = 未接管（防抖关闭或非 c2c 消息），调用方走原直发路径。
 * 注意：返回 true 时本函数阻塞至该项所在 batch 的 dispatch 完成
 * （见模块头「入队 await 语义」），调用方的中间件链（含 typing 续期）
 * 据此活到 turn 结束。
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
  const item: C2CInboundDebounceItem = { ctx, msg, account, runtime, log, cfg };
  const key = buildC2CDebounceKey(item);

  if (!(debounceMs > 0)) {
    // 防抖中途被禁用：先冲刷该发送者的 pending buffer 再交还调用方直发，
    // 否则旧 buffer 晚于新消息 flush，消息乱序且新 turn 可能被旧 turn 打断
    const entry = debouncers.get(account.accountId);
    if (entry) await entry.debouncer.flushKey(key);
    return false;
  }

  let resolveDone!: () => void;
  const done: ItemDone = {
    promise: new Promise<void>((resolve) => {
      resolveDone = resolve;
    }),
    resolve: resolveDone,
  };
  item.done = done;

  const debouncer = getOrCreateDebouncer(item, debounceMs);
  debouncers.get(account.accountId)!.keys.add(key);

  if (!announced.has(account.accountId)) {
    announced.add(account.accountId);
    log
      ?.child('inbound-debounce')
      ?.info(`[inbound-debounce] c2c inbound debounce armed (debounceMs=${debounceMs}, sliding window, framework cap ×5)`);
  }

  await debouncer.enqueue(item);
  await done.promise;
  return true;
}

/**
 * 进程退出前强制冲刷全部 pending 缓冲。
 *
 * 框架 debouncer 的 drain() 只等待在途任务、不冲刷 pending buffer
 * （buffer 的 flush timer 是 unref 的，退出时永不触发）——必须对每个
 * 活跃 key 显式 flushKey 才能把窗口内的消息发出去。
 *
 * 等待深度（2026-10-16 admission/completion 解耦后）：onFlush 的
 * admission 在 turn 提交进网关（onTurnSubmitted）时 resolve，框架
 * runFlush 的 race([admission, completion]) 随之 settle——flushAll 对
 * 每个 key 等到的是「dispatch 已提交（或已完成/失败）」而非整个
 * turn run。批次的载体完成信号（done.promise）仍覆盖完整
 * dispatchToOpenClaw，但 flushKey 不等它。turn 被框架队列 defer 时
 * inboundRun 先 resolve、turn 后台继续；无界等 turn 是刻意拒绝的设计
 * （Ctrl+C 卡死）；调用方（runtime.ts shutdown）以有界上限（1.5s）封顶。
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
