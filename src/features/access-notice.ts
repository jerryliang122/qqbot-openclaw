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

/** 冷却表容量上限：先扫过期条目，仍超限再按插入序淘汰 */
const MAX_TRACKED_KEYS = 2000;

export type AccessNoticeScope = 'c2c' | 'group';

export type AccessNoticeDenial = {
  allowed: false;
  reason: 'cooldown' | 'daily_cap';
};

/** 冷却槽：accountId + scope + 被拒实体 id 维度 */
const lastSentAt = new Map<string, number>();
/** 每日计数：accountId 维度，跨天自动重置 */
const dailyCounters = new Map<string, { date: string; count: number }>();

function today(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function cooldownKey(accountId: string, scope: AccessNoticeScope, id: string): string {
  return `${accountId}:${scope}:${id}`;
}

/** 先扫过期（超冷却窗口）条目，再按插入序 FIFO 淘汰，避免长期运行无限累积 */
function enforceCapacity(now: number): void {
  if (lastSentAt.size <= MAX_TRACKED_KEYS) return;
  for (const [key, at] of lastSentAt) {
    if (now - at >= ACCESS_NOTICE_COOLDOWN_MS) lastSentAt.delete(key);
  }
  while (lastSentAt.size > MAX_TRACKED_KEYS) {
    const oldest = lastSentAt.keys().next().value;
    if (oldest === undefined) break;
    lastSentAt.delete(oldest);
  }
}

/**
 * 预留一条提示额度（冷却 + 每日上限）。
 *
 * 预留即写表，调用方发送失败必须调 `release()` 回滚——否则一次发送失败
 * 会让该用户在冷却窗口内彻底静默，等于把本次要修的 bug 换个入口复现。
 */
export function reserveAccessNotice(params: {
  accountId: string;
  scope: AccessNoticeScope;
  id: string;
  now?: number;
}): { allowed: true; release: () => void } | AccessNoticeDenial {
  const { accountId, scope, id } = params;
  const now = params.now ?? Date.now();
  const key = cooldownKey(accountId, scope, id);

  const last = lastSentAt.get(key);
  if (last !== undefined && now - last < ACCESS_NOTICE_COOLDOWN_MS) {
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
  lastSentAt.set(key, now);
  enforceCapacity(now);

  return {
    allowed: true,
    release: () => {
      lastSentAt.delete(key);
      const current = dailyCounters.get(accountId);
      if (current && current.date === date && current.count > 0) current.count -= 1;
    },
  };
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
 */
export function buildAccessNoticeText(params: {
  scope: AccessNoticeScope;
  id: string;
  accountId: string;
}): string {
  const { scope, id, accountId } = params;
  const listKey = scope === 'group' ? 'groupAllowFrom' : 'allowFrom';
  const idLabel = scope === 'group' ? '本群 groupOpenid' : '你的 OpenID';
  // 非 default 账号的配置在 accounts.<id> 下——配错层级是常见误配，直接点破
  const accountHint =
    accountId === 'default' ? [] : [`多账号机器人请改：channels.qqbot.accounts.${accountId}.${listKey}`];
  const remedy =
    scope === 'group'
      ? '把上面的 ID 加进 `groupAllowFrom`，或设 `groupPolicy: "open"` 放行所有群；'
      : '把上面的 ID 加进 `allowFrom`，或改用配对模式 `dmPolicy: "pairing"` 由管理员放行；';

  return [
    `🚫 未接入：${scope === 'group' ? '本群' : '你的 OpenID'}不在本机器人的 \`${listKey}\` 白名单里，消息已拦截。`,
    '',
    `${idLabel}：\`${id}\``,
    `配置位置：openclaw.json → \`channels.qqbot.${listKey}\``,
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
