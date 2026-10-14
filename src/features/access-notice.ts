/**
 * 访问控制拒绝提示（allowFrom 未命中）
 *
 * 背景：`dmPolicy: "allowlist"`（默认）下，OpenID 不在 `allowFrom` 的消息
 * 此前被 `dynamicAccessControl` 直接 `ctx.stop('access:not_allowlisted')`
 * 静默丢弃，用户侧零反馈——「bot 挂了」「bot 装睡」「配置写错了」三种情况
 * 无法区分，排查只能翻服务端日志。OpenID 又是 per-account 的（A 账号拿到的
 * openid 在 B 账号上无意义），配错是高频操作，本模块把拒绝原因回告给用户。
 *
 * 三条边界（与决策一致，改动前请先读）：
 * 1. **仅 `allowlist` 拒绝分支提示**。`dmPolicy/groupPolicy: "disabled"` 是
 *    管理员显式拉下的总闸，此时回话等于架空该开关，保持静默；`"pairing"`
 *    模式本就已有配对挑战文案。
 * 2. **c2c 恒提示；群仅在被 @/引用 bot 时提示**。群提示是公开广播——bot 被
 *    拉进陌生群时，逐条回「本群不在白名单」等于对外广播该 bot 配了白名单，
 *    且全量推送群里会变刷屏。只有明确点名 bot 时对方才可能在等回复，此时
 *    提示才有诊断价值。@/引用判定与 `mentionGate` 同源（见
 *    `isMessageAddressedToBot`）。
 * 3. **节流**：同一被拒实体（c2c=发送者 openid / 群=groupOpenid）10 分钟
 *    冷却 + 每账号每日上限。诊断场景需要的是「第一条被拒消息给线索」，不是
 *    「每条都回」；无节流时陌生者可把 bot 当回声板持续刷屏，并在锚点缺失时
 *    逐条消耗每日 1000 条主动预算。
 *
 * 发送通道：提示经 `ctx.bot.sendText` 发出，不带显式 msgId，由网关
 * `attachMsgIdWithQuota` 自动选取被动锚点——入站 msg_id 在进入中间件链之前
 * 就已登记进 msgid-cache（见 event-handlers `cacheMsgId`），故正常路径吃被动
 * 回复额度、不占每日主动预算。
 */
import { isQuoteOfBotMessage } from './ref-index-store.js';

/** 同一被拒实体的提示冷却窗口（10 分钟） */
export const ACCESS_NOTICE_COOLDOWN_MS = 10 * 60 * 1000;

/** 每账号每日提示条数上限（跨被拒实体累计，防大量陌生者把 bot 当回声板） */
export const ACCESS_NOTICE_DAILY_CAP = 50;

/**
 * 提示发送的本地超时。中间件 await 的是裸 SDK 发送——请求挂住就永远走不到
 * `ctx.stop`，被拒消息的处理会一直悬着（占住防抖槽位）。
 *
 * 取值远小于网关出站 30s：提示是诊断消息，等 30s 没有收益，8s 足够覆盖
 * 正常 API 往返。
 */
export const ACCESS_NOTICE_SEND_TIMEOUT_MS = 8_000;

/** 冷却表容量上限：先扫过期条目；过期条目不足时宁可超出也不动未过期的 */
const MAX_TRACKED_KEYS = 2000;

export type AccessNoticeScope = 'c2c' | 'group';

export type AccessNoticeDenial = {
  allowed: false;
  reason: 'cooldown' | 'daily_cap';
};

/** 已发出的预留句柄：`release` 只在本次预留仍是持有者时才生效 */
export type AccessNoticeReservation = {
  allowed: true;
  release: () => void;
};

/** 冷却槽：accountId + scope + 被拒实体 id 维度；token 用于校验预留归属 */
const lastSentAt = new Map<string, { at: number; token: symbol }>();
/** 每日计数：accountId 维度，跨天自动重置 */
const dailyCounters = new Map<string, { date: string; count: number }>();

let tokenSeq = 0;

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function cooldownKey(accountId: string, scope: AccessNoticeScope, id: string): string {
  return `${accountId}:${scope}:${id}`;
}

/**
 * 容量控制：先扫过期（超冷却窗口）条目；**过期条目不足时宁可临时超出上限，
 * 也不淘汰未过期的条目**——淘汰会让被误伤的发送者在 10 分钟内再收一条，
 * 节流形同虚设。条目寿命上限即冷却窗口，稳态规模由「10 分钟内的被拒实体数」
 * 自然封顶，一个条目几十字节，不构成内存风险。
 */
function enforceCapacity(now: number): void {
  if (lastSentAt.size <= MAX_TRACKED_KEYS) return;
  for (const [key, slot] of lastSentAt) {
    if (now - slot.at >= ACCESS_NOTICE_COOLDOWN_MS) lastSentAt.delete(key);
  }
}

/**
 * 预留一条提示额度（冷却 + 每日上限）。
 *
 * 预留即写表，调用方在**确定发送失败**时必须调 `release()` 回滚——否则一次
 * 发送失败会让该用户在冷却窗口内彻底静默，等于把本次要修的 bug 换个入口复现。
 *
 * `release()` 校验 token：一次发送挂起超过冷却窗口后，同一实体的**新**预留
 * 可能已就位，此时旧请求的迟到失败若无条件删除 key，会把新冷却一并抹掉，
 * 让该用户紧接着又收到一条。
 */
export function reserveAccessNotice(params: {
  accountId: string;
  scope: AccessNoticeScope;
  id: string;
  now?: number;
}): AccessNoticeReservation | AccessNoticeDenial {
  const { accountId, scope, id } = params;
  const now = params.now ?? Date.now();
  const key = cooldownKey(accountId, scope, id);

  const last = lastSentAt.get(key);
  if (last !== undefined && now - last.at < ACCESS_NOTICE_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown' };
  }

  const date = today(now);
  let counter = dailyCounters.get(accountId);
  if (!counter || counter.date !== date) {
    counter = { date, count: 0 };
    dailyCounters.set(accountId, counter);
  }
  if (counter.count >= ACCESS_NOTICE_DAILY_CAP) {
    return { allowed: false, reason: 'daily_cap' };
  }

  counter.count += 1;
  const token = Symbol(`notice-${tokenSeq++}`);
  lastSentAt.set(key, { at: now, token });
  enforceCapacity(now);

  return {
    allowed: true,
    release: () => {
      // 仅当 key 仍由本次预留持有时才回滚，避免抹掉更新的预留
      if (lastSentAt.get(key)?.token !== token) return;
      lastSentAt.delete(key);
      const current = dailyCounters.get(accountId);
      if (current && current.date === date && current.count > 0) current.count -= 1;
    },
  };
}

/** 发送超时（**结果不明**：平台可能已投递）——与确定性失败区分对待 */
export class NoticeSendTimeoutError extends Error {
  constructor(ms: number) {
    super(`访问提示发送超时（${ms}ms，结果不明）`);
    this.name = 'NoticeSendTimeoutError';
  }
}

/**
 * 给提示发送套本地超时。原始 promise 仍会跑完：挂 `.catch` 吞掉它的迟到
 * 拒绝，否则超时后无人接管的 rejection 会变成 unhandledRejection 噪音。
 */
export function withNoticeTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise;
  promise.catch(() => {
    /* 迟到失败：调用方已按超时处理（结果不明），此处只防止 unhandledRejection */
  });
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new NoticeSendTimeoutError(ms)), ms)),
  ]);
}

/**
 * 是否把该群消息视为「明确在叫 bot」——决定拒绝时是否发公开提示。
 *
 * 判定优先级与 SDK `mentionGate` 逐条对齐（含 QQ 权威事件类型、结构化
 * mentions、`@appId` 内容标记三路），再叠加「引用 bot 出站消息 = 隐式被
 * 点名」（与本仓库 `isImplicitMention` 回调同一 ref-index 判定）。
 */
export function isMessageAddressedToBot(
  msg: {
    rawEventType?: string;
    mentions?: Array<{ is_you?: boolean }>;
    content?: string;
    refMsgIdx?: string;
  } | undefined,
  appId: string | undefined,
  accountId: string,
): boolean {
  if (!msg) return false;
  // 1. QQ 权威信号：该事件只在用户真的 @ 了 bot 时下发
  if (msg.rawEventType === 'GROUP_AT_MESSAGE_CREATE') return true;
  // 2. 服务端结构化 mentions（部分载荷带 is_you）
  if (Array.isArray(msg.mentions) && msg.mentions.some((m) => m?.is_you === true)) return true;
  // 3. 内容里的 @appId 标记（自建/私有域 bot 只会收到全量事件时的兜底扫描）
  if (msg.content && appId) {
    const escaped = appId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`<@!?${escaped}>`).test(msg.content)) return true;
  }
  // 4. 引用 bot 的出站消息 = 隐式被点名（仅全量模式下未 @ 消息才可能带引用）
  return isQuoteOfBotMessage(msg, accountId);
}

/**
 * 拒绝提示文案。刻意带出**被拒者自己的 ID**——用户拿到的第一手可粘贴线索，
 * 无需另跑 `/bot-me`；也不回显任何白名单内容（不泄露配置给陌生人）。
 *
 * 两处配置层级约束（改文案时务必保持）：
 * - **命名账号的主路径必须是 `accounts.<id>`**：顶层 `channels.qqbot.allowFrom`
 *   只属于 default 账号，让命名账号的用户去改顶层会改错地方、拒绝依旧。
 * - **群提示不得出现真实 accountId**：群提示是公开广播，任何触发者都能看到。
 *   命名账号在群里只给「同名键在 `accounts.<accountId>` 下」的泛化指引。
 */
export function buildAccessNoticeText(params: {
  scope: AccessNoticeScope;
  id: string;
  accountId: string;
}): string {
  const { scope, id, accountId } = params;
  const listKey = scope === 'group' ? 'groupAllowFrom' : 'allowFrom';
  const idLabel = scope === 'group' ? '本群 groupOpenid' : '你的 OpenID';
  const isNamedAccount = accountId !== 'default';

  // 私聊只有当事人看得到 → 直接给准确路径；群是公开广播 → 只给泛化指引，不暴露账号名
  const configPath =
    isNamedAccount && scope === 'c2c'
      ? `channels.qqbot.accounts.${accountId}.${listKey}`
      : `channels.qqbot.${listKey}`;
  const accountHint =
    isNamedAccount && scope === 'group'
      ? ['（多账号机器人在 `channels.qqbot.accounts.<accountId>` 下有同名键）']
      : [];
  const remedy =
    scope === 'group'
      ? '把上面的 ID 加进 `groupAllowFrom`，或设 `groupPolicy: "open"` 放行所有群；'
      : '把上面的 ID 加进 `allowFrom`，或改用配对模式 `dmPolicy: "pairing"` 由管理员放行；';

  return [
    `🚫 未接入：${scope === 'group' ? '本群' : '你的 OpenID'}不在本机器人的 \`${listKey}\` 白名单里，消息已拦截。`,
    '',
    `${idLabel}：\`${id}\``,
    `配置位置：openclaw.json → \`${configPath}\``,
    ...accountHint,
    '',
    remedy,
    '保存配置即生效（热更新，无需重启）。',
  ].join('\n');
}

/** 测试用：清空冷却与每日计数 */
export function _resetAccessNotice(): void {
  lastSentAt.clear();
  dailyCounters.clear();
}
