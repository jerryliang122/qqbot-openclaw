/**
 * 群消息插件侧合批（忙时攒批，turn 结束一次性发给框架）
 *
 * 背景（2026-10-23）：群消息合并此前完全交给框架的 followup 队列
 * （collect 模式）。但框架的 collect 分组键含 `execution.senderId`
 * （drain-CXUPS5dw.mjs 的 resolveFollowupAuthorizationKey →
 * resolveFollowupDeliveryStorageKey → prepareNextDeliveryGroup，且该函数
 * **遇到第一个 key 不同就 break**）——**同群不同发言人发的消息永远合并不了**，
 * 哪怕它们在同一秒到达。而"群里几个人同时问、bot 忙完一次性回"恰恰是
 * 群聊最常见的诉求。
 *
 * 本模块在插件内部实现合批：
 * - **忙碌信号自建**：框架没有向通道插件暴露"某会话是否正在工作"的查询
 *   API，但插件自己知道——dispatchToOpenClaw 的 promise 覆盖整个 turn。
 *   计数见 features/group-session-busy.ts。
 * - **合批原语用框架现成的**：createInboundDebouncer（与 c2c 防抖同款）
 *   的 shouldHoldFlush（静默期到点后再检查，true 则继续压住并重排定时器）
 *   + flushKey（显式冲刷、**绕过** hold 检查）正好是"忙时攒、turn 结束
 *   一次性发"。turn 结束由 busy 计数归零事件触发。
 * - **批次键按群**（不是按人）：同群不同发言人可进同一批。
 *
 * 参与范围：**群里所有消息**（含未 @ 的）。批内只要有一条是"在叫 bot"
 * （@ / 引用 bot / 称呼唤醒），整批按 user_request 投递；全是被动消息则按
 * room_event——与 dispatch 侧 classifyInboundEventKind 的口径一致。
 *
 * 旁路（不参与合批，立即直发；框架 debouncer 会先冲刷同 key 的 pending
 * buffer 再执行旁路项，顺序保持）：
 * - 控制命令（stop/esc/abort/exit 等）：合并会吞掉取消语义；
 * - 斜杠命令（'/' 开头）：合并会破坏 buildCtxPayload 的命令标记；
 * - 多问题 ask_user 的 keyed 答案文本（"1: 3\n2: 1"）：合并会改写答案
 *   文本，框架 keyed 认领失败 → 挂起的 ask_user 永远等不到答案；
 * - stt / fallback 来源语音（真实音频语义：本地文件 / 待理解媒体）。
 *   平台转写语音（source:'asr'）= 纯文本，**参与合批**——见
 *   needsStandaloneVoiceTurn。
 *
 * 容量：默认最多 10 条。超出时**丢弃较早的消息**（保留最新 10 条），
 * 并在合并正文里留一行丢弃说明——避免模型静默缺内容（与框架
 * `[Queue overflow] Dropped N messages due to cap.` 同样式）。
 *
 * 安全阀：框架 debouncer 的 maxWaitMs 兜底——持有超过 maxHoldMs（默认
 * 5 分钟）后强制冲刷。设 0 = 永不强制（只在 turn 结束时冲刷）。
 * 这是对"直到 turn 结束才一次性全发"的**显式偏离**：turn 永久挂起时
 * 批次会滞留内存且随进程重启丢失。
 */
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import { createInboundDebouncer, shouldDebounceTextInbound } from 'openclaw/plugin-sdk/channel-inbound';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { ProcessedAttachments } from '../middleware/attachment.js';
import { assembleMergedGroupBody } from '../dispatch/body-assembler.js';
import { getAdapters } from '../adapter/resolve.js';
import { runWithRequestContext } from '../request-context.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { resolveGroupConfigFromAccount } from '../config.js';
import { findPendingMultiQuestionByConversation } from './question-helpers.js';
import { isGroupBusy, onGroupIdle } from './group-session-busy.js';
import { withDetachedWebhookWork } from './detached-webhook-work.js';

/** dlog 缺席时 onFlush 冲刷包裹用的静默 logger（guards 不可用的 WARN 才会用到） */
const SILENT_GROUP_MERGE_LOG: PluginLogger = {
  info: () => {}, debug: () => {}, warn: () => {}, error: () => {},
  child: () => SILENT_GROUP_MERGE_LOG,
};
import { detectEventMention } from '../utils/mention.js';
import { resolveWakeDecision } from './room-event.js';
import { mergeProcessedAttachments } from './inbound-debounce.js';

/** 静默期窗口（仅用于 hold 检查的重排节奏；实际放行由 turn 结束事件驱动） */
export const DEFAULT_GROUP_MERGE_WINDOW_MS = 3000;
/** 批次条数上限（超出丢弃较早的消息） */
export const DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE = 10;
/** 最长持有时长（兜底强制冲刷；0 = 永不强制） */
export const DEFAULT_GROUP_MERGE_MAX_HOLD_MS = 300_000;
/** 合并正文字符上限（超出按丢弃规则处理，防上下文膨胀） */
export const GROUP_MERGE_MAX_BODY_CHARS = 8000;

/** 合批条目：一条已完成中间件链处理的群入站消息 */
export interface GroupMergeItem {
  ctx: MiddlewareContext;
  msg: QQBotInboundMessage;
  account: ResolvedQQBotAccount;
  runtime: PluginRuntime;
  log?: PluginLogger;
  /** 入队时的框架配置快照（控制命令判定用，逐条取新） */
  cfg: Record<string, unknown>;
}

type Debouncer = ReturnType<typeof createInboundDebouncer<GroupMergeItem>>;

/** accountId → { debouncer, 活跃 key 集, 每 key 的空闲订阅 } */
const debouncers = new Map<string, {
  debouncer: Debouncer;
  keys: Set<string>;
  unsubscribes: Map<string, () => void>;
}>();
/** 在途 flush 的 completion（已 catch，永不 reject）。退出冲刷第二段等待用 */
const activeCompletions = new Set<Promise<void>>();

/** 合批 key：账号 + 群（**按群**，不同发言人可同批） */
export function buildGroupMergeKey(item: GroupMergeItem): string {
  return `qqbot:${item.account.accountId}:group:${item.msg.replyTarget.targetId}`;
}

/** 该群的 openid */
function groupOpenidOf(item: GroupMergeItem): string {
  return item.msg.replyTarget?.targetId ?? '';
}

/**
 * 该条消息是否"明确在叫 bot"（@ / 引用 bot / 称呼唤醒 / 斜杠命令）。
 *
 * 口径与 dispatch 侧一致（resolveWakeDecision + detectEventMention），
 * 但**不**依赖 agentId 解析 mentionPatterns——中间件已把门控结论写进
 * ctx.state.nameMentioned（middleware-setup 的 buildMentionGateResolveConfig），
 * 门控与分类共用同一份判定。
 */
function isExplicitlyWoken(item: GroupMergeItem): boolean {
  const mentionState = item.ctx.state.mention as { wasMentioned?: boolean; implicit?: boolean } | undefined;
  const eventMentioned = detectEventMention({
    eventType: (item.msg as { rawEventType?: string }).rawEventType,
    mentions: (item.msg as { mentions?: Array<{ is_you?: boolean }> }).mentions,
  });
  const nameMentioned = (item.ctx.state as { nameMentioned?: boolean }).nameMentioned === true;
  const wake = resolveWakeDecision({
    mentionState: {
      wasMentioned: mentionState?.wasMentioned === true || eventMentioned,
      implicit: mentionState?.implicit === true,
    },
    nameMentioned,
  });
  return wake.wasMentioned;
}

/**
 * 该条语音是否需要独立成轮：仅 stt / fallback 来源——stt 有真实本地音频
 * （时长、框架媒体理解在跑），fallback 是占位文本且媒体 fact `transcribed:false`
 * （框架可能自行尝试音频理解）。**平台转写（全部 transcript source==='asr'）
 * 已是纯文本**（正文含全文、媒体 fact 为 transcribed:true 的惰性引用——框架
 * 不产 prompt 媒体注记、不二次转写），按普通文本参与合批。
 *
 * 框架 `requiresIndividualCollectDrain` 的 `currentInboundAudio` 约束作用于
 * 框架队列**多个 pending item 之间**的 collect 合批；插件把一批消息合成一条
 * turn 只会减少队列 item 数，不触发该路径——按来源收窄旁路不与框架冲突。
 */
function needsStandaloneVoiceTurn(item: GroupMergeItem): boolean {
  const processed = item.ctx.state.processedAttachments as ProcessedAttachments | undefined;
  if (!processed) return false;
  return processed.transcripts.some((t) => t.source !== 'asr');
}

/**
 * 旁路判定：返回 true 表示**不参与合批**（立即直发）。
 */
function isBypassItem(item: GroupMergeItem): boolean {
  // 斜杠命令：合并会破坏命令标记（rawBody 拼接后可能不以 '/' 开头）。
  // 判定同时看**原始**与**清洗后**两份文本：单条路径的 agentBody 直通
  // 用的是清洗后的 userContent（body-assembler 的 buildAgentBody），
  // 而 ctxPayload 的命令标记用原始 rawBody（ctx-builder）——任一份以
  // '/' 开头都要旁路，否则「@bot /cmd」这类（原文以 @ 开头、清洗后以
  // / 开头）在合并路径里会退化成普通文本、命令语义丢失。
  const rawText = String(item.msg?.content ?? '').trim();
  const sanitizedText = String((item.ctx.message as { content?: string } | undefined)?.content ?? '').trim();
  if (rawText.startsWith('/') || sanitizedText.startsWith('/')) return true;

  // 控制命令（stop/esc/abort/exit 等）：hasMedia 刻意传 false——框架默认策略
  // 不防抖媒体，本插件场景相反，仅借它的控制命令判定
  const text = rawText || sanitizedText;
  if (text && !shouldDebounceTextInbound({ text, cfg: item.cfg as never, hasMedia: false })) return true;

  // 多问题 ask_user 的 keyed 答案文本：合并会改写答案、认领失败。
  // 会话键含 accountId（openid 是 per-account 的）
  if (findPendingMultiQuestionByConversation(item.account.accountId, 'group', groupOpenidOf(item))) {
    return true;
  }

  // stt/fallback 来源语音：真实音频语义，独立成轮；平台转写语音=纯文本可合批
  // （2026-11-01 修复：任何语音都旁路会在忙时拆散批次——语音单独成 turn、
  // 且 SDK 对旁路项先冲刷 pending buffer 再单独发，把已攒的文本批也拆了）
  if (needsStandaloneVoiceTurn(item)) return true;

  return false;
}

/**
 * shouldDebounce 策略：**只有该群正在工作时才攒批**。
 *
 * 返回 false ⇒ 框架 debouncer 走"不防抖"分支，立即单条冲刷（零延迟，
 * 与合批前的直发路径完全一致）；返回 true ⇒ 进缓冲区，等 turn 结束。
 */
function shouldDebounceGroupItem(item: GroupMergeItem): boolean {
  const groupOpenid = groupOpenidOf(item);
  if (!groupOpenid) return false;

  const groupCfg = resolveGroupConfigFromAccount(item.account, groupOpenid);
  // 合并总开关关闭 → 不合批（由调用方直发）
  if (!groupCfg.coalesce.enabled) return false;
  // 策略不是 plugin → 交回框架队列（保持现状）
  if (groupCfg.coalesce.strategy !== 'plugin') return false;

  // 旁路项立即直发
  if (isBypassItem(item)) return false;

  // 只有"正在工作"才攒批；空闲时零延迟直发
  return isGroupBusy(item.account.accountId, groupOpenid);
}

/** 平台事件 timestamp → epoch ms（不可解析回退 0，排序时沉到最前＝最旧） */
function arrivalMs(item: GroupMergeItem): number {
  const parsed = Date.parse(String((item.msg as { timestamp?: unknown }).timestamp ?? ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 构造合并载体：改写最后一条消息的 ctx.state（dispatch 侧只从
 * ctx.state.assembledBody / ctx.state.processedAttachments 读取，不复制
 * ctx——上面还挂着 bot/replyTarget/log 等原语，复制丢语义）。
 */
function buildMergedCarrier(
  items: GroupMergeItem[],
  droppedCount: number,
  droppedNote: string | undefined,
): MiddlewareContext {
  const last = items[items.length - 1]!;
  const account = last.account;
  const getRuntime = () => last.runtime;

  const state = last.ctx.state as Record<string, unknown>;
  state.assembledBody = assembleMergedGroupBody(
    items.map((i) => ({ ctx: i.ctx, msg: i.msg })),
    account,
    getRuntime,
    droppedNote ? { droppedNote } : undefined,
  );

  const processedList = items
    .map((i) => (i.ctx.state as Record<string, unknown>).processedAttachments as ProcessedAttachments | undefined)
    .filter((p): p is ProcessedAttachments => !!p);
  if (processedList.length > 0) {
    state.processedAttachments = mergeProcessedAttachments(processedList);
  }
  return last.ctx;
}

/**
 * 强制把整批判为 user_request。
 *
 * 载体（最后一条）可能本身是被动消息（room_event），而批内另有被 @ 的
 * 消息——按载体分类会让整批被压成静默（最终文本不投递），用户 @ 了 bot
 * 却没回音。dispatch 侧用 resolveWakeDecision 判定，这里把载体的 mention
 * 标志置位，让 dispatch 走同一条 user_request 路径。
 */
function forceUserRequestOnCarrier(carrier: GroupMergeItem): void {
  const state = carrier.ctx.state as Record<string, unknown>;
  const mention = (state.mention as { wasMentioned?: boolean; implicit?: boolean } | undefined) ?? {};
  if (mention.wasMentioned === true) return;
  state.mention = { ...mention, wasMentioned: true };
}

/** 单条/合并后的统一 dispatch 入口（请求级上下文取自载体消息） */
async function dispatchItem(
  item: GroupMergeItem,
  opts?: Parameters<typeof dispatchToOpenClaw>[5],
): Promise<void> {
  const targetId = `qqbot:group:${item.msg.replyTarget.targetId}`;
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

/**
 * 按容量上限裁剪批次：保留**最新**的消息，超限的较早消息被丢弃。
 *
 * 两个上限同时生效：
 * - 条数上限 `maxBatchSize`（默认 10）
 * - 正文字符上限 `maxBodyChars`（默认 8000）——一批 10 条各接近 QQ 单条
 *   5000 字上限时，agentBody 可膨胀到数万字（上下文爆炸）。以消息正文
 *   长度作代价度量（正文的支配项），从最新往最旧累加。
 *
 * 单条超限的消息**仍会保留**（不因超上限而整批丢弃），只在加入下一条
 * 会超限时停止。
 */
function trimToCapacity(
  items: GroupMergeItem[],
  maxBatchSize: number,
  maxBodyChars: number,
): { kept: GroupMergeItem[]; dropped: number } {
  // 正文体量 = 原文 + userContent 层的附加文本：语音转写全文（voiceText）与
  // 其他附件描述（otherInfo）都随 buildUserContent 进合并正文，必须计入
  // 上限——ASR 语音参与合批后（2026-11-01）转写可达数百上千字，漏计会让
  // 批次超过 maxBodyChars 上限。（- Images 等 dynamicCtx 元数据行沿现状不计。）
  const sizeOf = (i: GroupMergeItem) => {
    const processed = i.ctx.state.processedAttachments as ProcessedAttachments | undefined;
    return (
      (i.msg.content ?? '').length +
      (processed?.voiceText?.length ?? 0) +
      (processed?.otherInfo?.length ?? 0)
    );
  };
  const keptReversed: GroupMergeItem[] = [];
  let total = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (keptReversed.length >= maxBatchSize) break;
    const size = sizeOf(items[i]!);
    if (maxBodyChars > 0 && keptReversed.length > 0 && total + size > maxBodyChars) break;
    keptReversed.push(items[i]!);
    total += size;
  }
  const kept = keptReversed.reverse();
  return { kept, dropped: items.length - kept.length };
}

function getOrCreateDebouncer(item: GroupMergeItem): Debouncer {
  const existing = debouncers.get(item.account.accountId);
  if (existing) return existing.debouncer;

  const dlog = item.log?.child('group-merge');
  const entryHolder: { current?: { debouncer: Debouncer; keys: Set<string>; unsubscribes: Map<string, () => void> } } = {};

  const debouncer = createInboundDebouncer<GroupMergeItem>({
    debounceMs: DEFAULT_GROUP_MERGE_WINDOW_MS,
    // 最长持有时长（兜底强制冲刷；0 = 永不强制 → 用极大值表达）
    maxWaitMs: (i) => {
      const groupCfg = resolveGroupConfigFromAccount(i.account, groupOpenidOf(i));
      const maxHoldMs = groupCfg.coalesce.maxHoldMs ?? DEFAULT_GROUP_MERGE_MAX_HOLD_MS;
      return maxHoldMs > 0 ? maxHoldMs : Number.MAX_SAFE_INTEGER;
    },
    serializeImmediate: true,
    buildKey: buildGroupMergeKey,
    shouldDebounce: shouldDebounceGroupItem,
    // 一直攒到 turn 结束（由 busy 计数归零事件显式 flushKey 放行）
    shouldHoldFlush: () => true,
    onFlush: (rawItems) => {
      const entry = entryHolder.current;
      for (const i of rawItems) {
        const key = buildGroupMergeKey(i);
        entry?.keys.delete(key);
        // 退订该群的空闲回调：批次已发出，下次入队时按需重新订阅
        // （避免长期运行下 unsubscribes 无限累积）
        const unsub = entry?.unsubscribes.get(key);
        if (unsub) {
          unsub();
          entry?.unsubscribes.delete(key);
        }
      }

      // 到达顺序排序：中间件链并发，入队顺序 ≠ 平台到达顺序
      const sorted = rawItems.length > 1
        ? [...rawItems].sort((a, b) => arrivalMs(a) - arrivalMs(b))
        : rawItems;

      // 容量裁剪：超出上限（条数 / 正文字数）丢弃较早的消息
      const last = sorted[sorted.length - 1]!;
      const groupCfg = resolveGroupConfigFromAccount(last.account, groupOpenidOf(last));
      const maxBatchSize = groupCfg.coalesce.maxBatchSize ?? DEFAULT_GROUP_MERGE_MAX_BATCH_SIZE;
      const { kept, dropped } = trimToCapacity(sorted, Math.max(1, maxBatchSize), GROUP_MERGE_MAX_BODY_CHARS);
      const droppedNote = dropped > 0
        ? `[已丢弃 ${dropped} 条较早的群消息（批次上限 ${maxBatchSize} 条 / ${GROUP_MERGE_MAX_BODY_CHARS} 字）]`
        : undefined;
      if (dropped > 0) {
        dlog?.info(
          `[group-merge] dropped ${dropped} older group message(s) (cap=${maxBatchSize} msgs / ${GROUP_MERGE_MAX_BODY_CHARS} chars, group=${groupOpenidOf(last)}, kept=${kept.length})`,
        );
      }

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

      const completion = withDetachedWebhookWork(
        async () => {
          try {
            if (kept.length === 1 && dropped === 0) {
              await dispatchItem(kept[0]!, { onTurnSubmitted: admit });
              return;
            }
            const carrier = kept[kept.length - 1]!;
            dlog?.info(
              `[group-merge] merged ${kept.length} group messages group=${groupOpenidOf(carrier)} anchorMsgId=${carrier.msg.messageId}`,
            );
            // 批内任一条"在叫 bot" ⇒ 整批按 user_request 投递。
            // ⚠️ 置位必须在**装配之后**：装配器按各成员自己的 mention 状态渲染
            // `(@you)`，先置位会把载体（最后一条）虚标成"叫了 bot"（实际叫 bot
            // 的是批内更早的成员）——对模型是归因误导。装配后再置位，载体
            // 的正文已定，置位只影响 dispatch 侧的入站分类。
            const anyWoken = kept.some((i) => isExplicitlyWoken(i));
            const ctx = buildMergedCarrier(kept, dropped, droppedNote);
            if (anyWoken) forceUserRequestOnCarrier(carrier);
            await dispatchItem({ ...carrier, ctx }, { onTurnSubmitted: admit });
          } finally {
            admit();
          }
        },
        // **包在 onFlush 的 completion 这一层**（而非 flushGroupMergeQueue）：
        // 这是全部冲刷路径的唯一咽喉——maxWait 兜底定时器直接调 onFlush、
        // busy 归零的显式 flushKey、退出冲刷都经过这里。冲刷运行在「上一轮
        // dispatch 的延续 / 定时器」上下文里，继承的准入根可能已释放
        // （webhook 模式下批次 enqueue 会被当 drain 拒掉，issue #74）——
        // withDetachedWebhookWork 在继承根缺失/已释放时给批次一个全新
        // 独立根；websocket 模式继承根本就常活，行为等价。真处 drain 时
        // 新根被拒 = 与不包时的 enqueue 拒绝同结果，无退化。
        dlog ?? SILENT_GROUP_MERGE_LOG,
      );

      const tracked = completion.catch(() => {});
      activeCompletions.add(tracked);
      void tracked.finally(() => activeCompletions.delete(tracked));
      return { admission, completion };
    },
    onError: (err, items) => {
      const first = items[0];
      dlog?.error(
        `[group-merge] flush failed (${items.length} items, first msgId=${first?.msg.messageId ?? '?'}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    },
    onCancel: (items) => {
      dlog?.warn(`[group-merge] flush cancelled (${items.length} items) — 群消息未发出`);
    },
  });

  const entry: { debouncer: Debouncer; keys: Set<string>; unsubscribes: Map<string, () => void> } = {
    debouncer,
    keys: new Set<string>(),
    unsubscribes: new Map<string, () => void>(),
  };
  entryHolder.current = entry;
  debouncers.set(item.account.accountId, entry);

  return debouncer;
}

/**
 * 订阅「该群变闲」→ 显式冲刷该群批次（绕过 shouldHoldFlush）。
 *
 * **按群订阅**（不是按账号）：debouncer 是账号级单例，若只在创建时订阅
 * 首个群，同账号的其它群攒批后永远等不到冲刷（busy 归零无回调）。
 * 订阅在首次入队该群时惰性建立，批次发出时退订（见 onFlush）。
 */
function ensureGroupIdleSubscription(
  accountId: string,
  groupOpenid: string,
  key: string,
  log?: PluginLogger,
): void {
  const entry = debouncers.get(accountId);
  if (!entry || entry.unsubscribes.has(key)) return;
  const unsubscribe = onGroupIdle(accountId, groupOpenid, () => {
    void flushGroupMergeQueue(accountId, groupOpenid).catch((err) => {
      log?.child('group-merge')?.error(
        `[group-merge] flush on idle failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  });
  entry.unsubscribes.set(key, unsubscribe);
}

/**
 * 群入站消息入合批队列。
 *
 * 返回 true = 已接管（进缓冲区，或旁路/空闲路径的直发已在内部完成）；
 * 返回 false = 未接管（合并关闭 / 非群消息），调用方走原直发路径。
 */
export async function enqueueGroupInboundMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log?: PluginLogger,
): Promise<boolean> {
  if (msg.replyTarget?.scope !== 'group') return false;

  const groupOpenid = msg.replyTarget.targetId;
  if (!groupOpenid) return false;

  const groupCfg = resolveGroupConfigFromAccount(account, groupOpenid);
  if (!groupCfg.coalesce.enabled) return false;
  if (groupCfg.coalesce.strategy !== 'plugin') return false;

  const cfg = (getAdapters(runtime).getConfig?.() ?? {}) as Record<string, unknown>;
  const item: GroupMergeItem = { ctx, msg, account, runtime, log, cfg };
  const key = buildGroupMergeKey(item);

  const debouncer = getOrCreateDebouncer(item);
  const entry = debouncers.get(account.accountId)!;
  entry.keys.add(key);
  // 惰性订阅该群的「变闲」事件（按群，不是按账号——见 ensureGroupIdleSubscription）
  ensureGroupIdleSubscription(account.accountId, groupOpenid, key, log);

  await debouncer.enqueue(item);
  return true;
}

/**
 * 显式冲刷某群的合批缓冲（turn 结束 → busy 归零 → 调用）。
 *
 * flushKey 走框架的 flushBuffer，**绕过** shouldHoldFlush —— 这正是
 * "攒到 turn 结束一次性发"的放行口。批次派发本身的 detached 准入包裹
 * 在 onFlush 的 completion 里（见 getOrCreateDebouncer），这里无需重复包。
 */
export async function flushGroupMergeQueue(accountId: string, groupOpenid: string): Promise<void> {
  const entry = debouncers.get(accountId);
  if (!entry) return;
  await entry.debouncer.flushKey(`qqbot:${accountId}:group:${groupOpenid}`);
}

/**
 * 进程退出前强制冲刷全部 pending 缓冲（两段式，对齐 c2c 防抖）：
 * 1. 逐 key flushKey —— 冲到"lane 已决策"；
 * 2. 等待全部在途 completion —— 宽限期内能跑完的 turn 把回复发完。
 */
export async function flushAllGroupMergeQueues(): Promise<void> {
  await Promise.allSettled(
    [...debouncers.values()].flatMap(({ debouncer, keys }) =>
      [...keys].map((key) => debouncer.flushKey(key)),
    ),
  );
  await Promise.allSettled([...activeCompletions]);
}

/** 测试用：清空 debouncer 注册表 */
export function resetGroupMergeStateForTest(): void {
  for (const entry of debouncers.values()) {
    for (const unsub of entry.unsubscribes.values()) unsub();
  }
  debouncers.clear();
  activeCompletions.clear();
}
