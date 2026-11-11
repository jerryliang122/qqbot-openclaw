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
 * 入队口的两道**消费**（在 debounceMs 判定之前，防抖开/关行为一致）：
 * - 已认领 keyed 答案的逐字副本 → 直接终止（issue #99）；
 * - 文本作答拦截（sequential-text-answer）：多题 pending 武装期间的非
 *   keyed 文本 → 记为当前题答案并续卡/发确认卡，**不转发框架**（窗口
 *   内文本即作答意图，仓库主人拍板的红线再界定）——见
 *   tryCaptureSequentialTextAnswer。
 *
 * admission 放行（2026-10-16 修复，红线）：onFlush 返回的 admission 与
 * completion 必须解耦——框架 debouncer 的同 key 任务链持有到 admission
 * settle，enqueue 对旁路项在同 key 有 in-flight 任务时会排队等它。若
 * admission === completion（覆盖整个 turn run），任务 turn 运行期间到达的
 * /stop 要等 turn 跑完才 dispatch（插嘴失效），挂起 ask_user 的 keyed
 * 答案更会被自己等待的 turn 死锁。admission 必须在「turn 已入队框架
 * lane」（dispatchToOpenClaw 的 onTurnSubmitted = 框架
 * turnAdoptionLifecycle 的 onAdopted/onDeferred/onAbandoned 任一——注意
 * 不是「inboundRun 已调用」，那到真正入队还有多个异步段，提前放行会让
 * /stop 抢先入队而无处可取消，Sourcery 评审意见 2）时 resolve，
 * completion settle 时兜底；此后同 key 旁路必然晚于本 turn 入队，
 * 顺序确定。
 *
 * 跨窗口语义（2026-10-16 二轮评审显式拍板，勿"修"回去）：放行在 lane
 * 决策处意味着**窗口外**的同发送者消息（如 10s 后再发的第二个文件）
 * 不再串行在运行中的 turn 之后——turn B 以 exclusive 入场会 abort 运行
 * 中的 turn A，c2c 恢复 pre-v2.5.0 的插嘴语义（对齐框架
 * createInboundDebounceFlush 在 adopted/deferred 即 markAdmitted 的契约）；
 * 窗口内合并（本模块存在理由）不受影响。刻意不做「只放旁路项插队」的
 * 收窄：那需要 enqueue 早退式旁路（设计红线已否决）或对抗框架
 * debouncer 的链管理，且会让普通文字消息（改需求、追问）重现
 * 「等长任务跑完才 dispatch」的同款缺陷——/stop 只是这类消息里最典型的。
 *
 * 退出冲刷两段式：flushKey 等 lane 决策，再等在途
 * completion（activeCompletions）——宽限内能完成的 turn 把回复发完。
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
 * 群聊不经过本模块（群走 features/group-merge.ts 的插件侧合批：忙时攒批、
 * turn 结束一次性发出，可跨发言人合并——框架的 collect 队列按 senderId
 * 分组、遇首个不同键即断，跨发言人合并不了）。
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
import { findPendingMultiQuestionByConversation, findPendingSingleQuestionByConversation, getPendingMultiQuestionState, buildSequentialFullAnswerDraft, containsKeyedAnswerLine, matchFullKeyedAnswer, applyFullKeyedAnswer, recordSequentialTextAnswer } from './question-helpers.js';
import { sendSequentialQuestionCard, submitSequentialAnswers } from './question-flow.js';
import { sendText } from '../outbound/outbound-service.js';

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
/**
 * 在途 flush 的 completion（已 catch，永不 reject）。退出冲刷第二段等待
 * 用（见 flushAllC2CInboundDebouncers）：pending buffer 冲到「lane 已决策」
 * 只是第一段，turn 本身还要跑完——宽限期内能完成的 turn 应把回复发完。
 */
const activeCompletions = new Set<Promise<void>>();

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

  // 多问题 ask_user 武装期间的文本：合并会改写答案（`[消息 i/N]` 分节体）
  // ⇒ 认领/提交必然失败。pending 期间该会话的文本**一律不合并**。
  // 会话键含 accountId（openid 是 per-account 的，跨账号同 targetId
  // 不共享 pending 记录）。
  //
  // ⚠️ 这里**只做旁路判定，不做认领/提交**：多题文本的处置在
  // `planSequentialTextCapture`（入队口）统一完成——插件直提整单答案，
  // 不再依赖框架的入站 keyed 认领。保留本旁路的意义：万一文本未被拦截层
  // 识别而原样转发框架（兜底第 3 层），它**不能被防抖合并**。
  const pendingMulti = findPendingMultiQuestionByConversation(item.account.accountId, 'c2c', item.msg.replyTarget.targetId);
  if (pendingMulti) {
    return false;
  }

  // 单问题 ask_user 的作答文本（PR1）：单题卡正文明确引导「直接回复」，
  // 而合并会把答案改写成 `[消息 1/N]` 分节体 ⇒ 框架认领到的答案被污染。
  // 与多问题 keyed 答案同款旁路：pending 期间该会话的文本一律不合并。
  if (findPendingSingleQuestionByConversation(item.account.accountId, 'c2c', item.msg.replyTarget.targetId)) {
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
 *
 * **历史块只保留第 1 条的那一份**（2026-10-23 修复）：SDK 的 historyBuffer
 * 暴露的 `ctx.state.history` 是「不含当前消息、但含此前所有消息」的快照
 * ⇒ 第 2..N 条各自的 agentBody 里带的历史块**包含批次内的前面几条**
 * （与分节重复，消息被说两遍，且历史块重复 N 份）。第 1 条的历史块恰好
 * 是「批次开始之前」的基线，保留它、剥掉其余的即可。
 */
export function mergeAssembledBodies(list: AssembledBody[]): AssembledBody {
  if (list.length === 1) return list[0]!;
  const header = (i: number) => `[消息 ${i + 1}/${list.length}]`;
  const agentBody = list
    .map((b, i) => `${header(i)}\n${i === 0 ? b.agentBody : stripHistoryBlock(b.agentBody)}`)
    .join('\n\n');
  const webBody = list.map((b, i) => `${header(i)}\n${b.webBody}`).join('\n\n');
  const rawBody = list
    .map((b) => (b.rawBody ?? '').trim())
    .filter(Boolean)
    .join('\n');
  const systemPrompt = list.map((b) => b.systemPrompt).find((v) => v !== undefined);
  return { webBody, agentBody, rawBody, systemPrompt };
}

/** 剥掉 agentBody 里的 `[Chat history begins]…[Chat history ends]` 块（保留其后的 `[Current message]` 标记） */
function stripHistoryBlock(body: string): string {
  return body.replace(/\[Chat history begins\][\s\S]*?\[Chat history ends\]\n?/g, '');
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
      // 现 admission 在 turn 入队框架 lane（onTurnSubmitted = 框架
      // turnAdoptionLifecycle 的 onAdopted/onDeferred/onAbandoned 任一）时
      // resolve：此时 turn 已在 lane 队列里，链及时释放，旁路立即 dispatch
      // 且必然晚于本 turn 入队，顺序确定（信号取 lane 决策而非
      // 「inboundRun 已调用」——后者到入队还有 ingest/classify/preflight/
      // resolveTurn 多个异步段，提前放行会让 /stop 抢先入队而无处可取消，
      // Sourcery 评审意见 2）。completion settle 时兜底 admit（覆盖
      // ingest 丢弃 / dispatch 抛错 / adapters 缺失——链永不悬挂）。
      // 语义对齐框架 createInboundDebounceFlush 的 admission 设计
      // （adopted/deferred/failed 任一即放行）。刻意**不用**它本身（onFlush
      // 的第 2 个参数，当前被忽略）：采用它会用框架包装的 lifecycle 替换
      // 我方传入的对象，而 dispatch.ts 刻意让同一个 lifecycle 对象同时
      // 出现在 runDispatchLifecycle 与 replyOptions.turnAdoptionLifecycle
      // 以满足框架的所有权校验（assertPreparedDispatchLifecycle）——换对象
      // 会破坏该校验。此处手搓等价语义（钩子触发 + completion 兜底），
      // 勿"简化"回去。
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
      // 登记在途 completion（已 catch，永不 reject）供退出冲刷第二段等待
      // （flushAllC2CInboundDebouncers）；settle 后自移除，防长期运行累积。
      // 派生 promise 不影响 completion 本身的 rejection 传播（runFlush 自会
      // catch → onError），也不产生 unhandled rejection。
      const tracked = completion.catch(() => {});
      activeCompletions.add(tracked);
      void tracked.finally(() => activeCompletions.delete(tracked));
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
 * 文本作答拦截（多题顺序发题）。
 *
 * 多题 pending 武装期间，用户**直接回复的文本**被消费为答案，**不转发
 * 框架**（仓库主人拍板的红线再界定：窗口内文本即作答意图——框架侧对
 * 单条 partial 答案只会拒收重问，转发没有意义）。
 *
 * **三种文本形态**（判据只看形态，不猜内容语义）：
 *
 * | 形态 | 判据 | 动作 |
 * |---|---|---|
 * | **整单** | 行数 = 题数、题号 1..N 顺序、每行 `N: 值` | 用文本里的值**覆盖全部答案**；全部答齐 ⇒ 组合 + 提交；未答齐 ⇒ 更新答案 + 续发当前题卡 |
 * | **形态错误** | 含「题号:」行但不满足整单形态 | 回执「格式不对」+ **保持 pending 武装**；不改答案、不提交 |
 * | **本题答案** | 不含题号行（单行或多行，多行压平成一行） | 记为**当前题**答案；末题 ⇒ 组合 + 提交，否则续发下一题卡 |
 *
 * **同步规划、异步执行**：本函数必须完全同步返回（决策 + 状态推进），
 * 出站（续卡/回执）封装成 thunk 交给调用方 await——enqueue 的
 * 「防抖器同步注册」时序不能被任何 await 打断（调用方在同一宏任务里
 * 就可能 flushAll，注册被推迟到微任务后 = 冲刷扑空、消息滞留缓冲）。
 *
 * 分支（返回 null = 不接管，走原路径）：
 * - 纯附件 / 斜杠命令 / 无 pending → null
 *   （附件走原路径；斜杠是逃生通道）；
 * - pending 已终态（已提交 / 已被框架结束）→ null（文本照旧转发框架）。
 *
 * 提交红线：提交走框架官方认领通道（`claimPendingAgentQuestionAnswer`），
 * 插件只**搬运**用户真实作答，不代替用户作答、不合成入站消息。
 */
function planSequentialTextCapture(params: {
  msg: QQBotInboundMessage;
  account: ResolvedQQBotAccount;
  log?: PluginLogger;
}): (() => Promise<void>) | null {
  const { msg, account, log } = params;
  const text = String(msg.content ?? '').trim();
  if (!text) return null; // 纯附件：不做答案（已知边界：图片走框架 image-steer 取消问题）
  if (text.startsWith('/')) return null; // 斜杠命令：逃生通道，照旧放行

  const pending = findPendingMultiQuestionByConversation(
    account.accountId,
    'c2c',
    msg.replyTarget.targetId,
  );
  if (!pending) return null;

  const dlog = log?.child('inbound-debounce');
  const to = `qqbot:c2c:${msg.replyTarget.targetId}`;
  const replyToId = String(msg.messageId ?? '');
  const bestEffortText = async (body: string): Promise<void> => {
    try {
      await sendText({ to, text: body, account, ...(replyToId ? { replyToId } : {}) });
    } catch {
      // 尽力而为的通知：失败不阻断消费语义
    }
  };

  const stateBefore = getPendingMultiQuestionState(pending.questionId);
  if (!stateBefore) return null; // 竞态：pending 刚失效 → 走原路径
  // 只处理**顺序发题**形态（c2c）：群聊 legacy 路径的文本不走「当前题
  // 答案」语义（它靠确认卡的客户端代发提交）。
  if (stateBefore.mode !== 'sequential') return null;

  const questions = stateBefore.questions;

  // ── 形态 1：整单 ──
  const full = matchFullKeyedAnswer(questions, text);
  if (full) {
    // 空值 = 该题未答（框架的 keyed 正则要求值至少一个字符，空值行会被
    // 行序兜底捡成字面量 `"N:"` 静默收下——必须插件先拦下）
    const empty = [...full.values()].some((value) => value.trim().length === 0);
    if (empty) {
      return async () => {
        await bestEffortText(
          '每道题都要填上答案——请把空的冒号后补上答案后**整段**发送。',
        );
        dlog?.info(`[question] full-keyed text has empty value (rejected) msgId=${msg.messageId}`);
      };
    }
    // 覆盖全部答案（任一题空/非法 ⇒ applyFullKeyedAnswer 拒绝 ⇒ 保持武装）
    if (!applyFullKeyedAnswer(pending.questionId, full)) {
      return async () => {
        await bestEffortText('这组答案没能解析成功，请每行一题重发一次。');
        dlog?.info(`[question] full-keyed text rejected by state msgId=${msg.messageId}`);
      };
    }
    const state = getPendingMultiQuestionState(pending.questionId);
    if (!state) return null; // 竞态
    dlog?.info(
      `[question] full-keyed answer captured id=${pending.questionId} msgId=${msg.messageId}`,
    );
    if (state.answers.size < state.questions.length) {
      // 理论不可达（整单形态要求行数 = 题数 ⇒ 每题都有值 ⇒ 全部答齐）；
      // 保留作防御：万一判定口径放宽，这里不会静默提交一份缺题的答案
      // （框架会整单拒绝，白白让用户多点一次）。
      return async () => {
        const sent = await sendSequentialQuestionCard({
          state,
          index: state.cursor,
          account,
          to,
          log,
        });
        if (sent.error) {
          await bestEffortText('题目卡片发送失败，请稍后重新点选或直接回复答案。');
        }
      };
    }
    // 全部答齐 ⇒ 组合 + 提交
    return async () => {
      await submitSequentialAnswers({ state, account, to, log });
    };
  }

  // ── 形态 2：形态错误（含题号行但不合整单）──
  if (containsKeyedAnswerLine(text)) {
    return async () => {
      await bestEffortText(
        `格式不对——请每行一题、题号 ${questions.length} 道题按 1..${questions.length} 顺序写（例如「1: 3」），整段发送。`,
      );
      dlog?.info(`[question] malformed keyed text consumed with guidance msgId=${msg.messageId}`);
    };
  }

  // ── 形态 3：本题答案（不含题号行）──
  const result = recordSequentialTextAnswer(pending.questionId, text);
  if (result.status === 'unknown') return null; // 竞态：走原路径
  if (result.status === 'terminal') {
    return async () => {
      await bestEffortText('该问题已提交或已过期');
    };
  }
  dlog?.info(
    `[question] text answer captured id=${pending.questionId}`
    + ` q=${stateBefore.cursor + 1}/${stateBefore.questions.length} msgId=${msg.messageId}`,
  );

  const state = getPendingMultiQuestionState(pending.questionId);
  if (!state) return null;

  if (result.status === 'complete') {
    // 末题收齐 ⇒ 组合 + 提交（不再发确认卡）
    return async () => {
      await submitSequentialAnswers({ state, account, to, log });
    };
  }

  // status === 'ok'：续发下一题卡（失败按 F1 口径回执手打草稿）
  return async () => {
    const sent = await sendSequentialQuestionCard({
      state,
      index: result.nextIndex,
      account,
      to,
      log,
    });
    if (sent.error) {
      const draft = buildSequentialFullAnswerDraft(state.answers, state.questions.length);
      await bestEffortText(
        `下一题发送失败——请直接回复下面这段提交（空白处补上答案）：\n\n${draft}`,
      );
    }
  };
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

  // ── 文本作答拦截（多题顺序发题）──
  // 多题 pending 武装期间，用户的直接文本回复被消费为答案，**不转发框架**
  // （仓库主人拍板的红线再界定：窗口内文本即作答意图）。必须在
  // debounceMs 判定之前——防抖开/关配置行为一致。决策与状态推进同步完成
  // （planSequentialTextCapture 不得含 await——防抖器的同步注册时序不能被
  // 打断），出站在 thunk 里异步执行。
  const textCapture = planSequentialTextCapture({ msg, account, log });
  if (textCapture) {
    await textCapture();
    return true; // 已接管（记答案 + 续卡 / 提交 / 引导 / 回执）
  }

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
 * 两段式等待（Sourcery 评审意见 1，2026-10-16 二轮）：
 * 1. 逐 key flushKey——onFlush 的 admission 在 lane 决策时 resolve，
 *    故这一段等到「全部 pending 消息已 dispatch 且 turn 已入 lane 队列」；
 * 2. 等待全部在途 completion（activeCompletions，含完整 dispatchToOpenClaw
 *    = 整个 turn run）——退出宽限内能跑完的 turn 把回复发完再退，不因
 *    admission 提前放行而丢已提交 turn 的回复。
 * 两段都在调用方的有界封顶之内（runtime.ts shutdown ≤1.5s，二次信号
 * 幂等、超时定时器兜底强退）——不会无界等 turn（Ctrl+C 卡死是刻意
 * 拒绝的），defer 的 turn 后台继续属于既有语义。
 */
export async function flushAllC2CInboundDebouncers(): Promise<void> {
  // 先冲刷 pending buffer（第一段：等到 lane 决策）。冲刷触发的 onFlush
  // 在 admission resolve 前已同步登记 completion，故第二段的快照必然包含
  await Promise.allSettled(
    [...debouncers.values()].flatMap(({ debouncer, keys }) =>
      [...keys].map((key) => debouncer.flushKey(key)),
    ),
  );
  // 第二段：等在途 dispatch 的 completion（turn 跑完或失败）
  await Promise.allSettled([...activeCompletions]);
}

/** 测试用：清空 debouncer 注册表与一次性公告标记 */
export function resetC2CInboundDebouncersForTest(): void {
  debouncers.clear();
  announced.clear();
  activeCompletions.clear();
}
