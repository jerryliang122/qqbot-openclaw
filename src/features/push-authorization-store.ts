/**
 * 主动推送授权事件存储（内存，跨重启不保留）
 *
 * 官方 INTERACTION_CREATE 互动事件的扩展类型（2026-07 文档扩容）：
 * 用户/群主在 QQ 客户端的机器人设置页操作「主动消息推送」授权开关时，
 * 平台推送 USER_AUTHORIZE(18) / GROUP_AUTHORIZE(19) / GROUP_AUTHORIZE_STATUS(20)。
 *
 * 事件只携带操作场景（opt_scene=setting|dialog）与授权范围（scope=c2c_push|group_push），
 * 不携带授权结果（开/关）——本存储只做「最近一次授权操作」的可观测记录，
 * 供 /bot-group-info 展示，与主动消息用量（proactive-budget）排障关联：
 * 群主动推送平台侧默认关闭，群主不开开关则主动消息送不达；用量为 0 或
 * 突增时先看这里有没有授权事件。
 *
 * 乱序防护：网关重连可能补发旧事件（平台事件要求按 msg_seq 去重，但授权
 * 事件不带 seq），记录时携带事件自身时间戳——仅当事件比已存事实更新时才
 * 替换最新字段；缺时间戳时退化为按到达顺序（无法判定乱序）。
 */

/** 授权类互动事件类型（INTERACTION_CREATE 外层 type） */
export type PushAuthorizeEventType = 18 | 19 | 20;

export interface PushAuthorizeFacts {
  /** 最近一次事件类型：18=用户授权 19=群授权 20=群授权状态变更 */
  lastEventType: PushAuthorizeEventType;
  /** 授权范围：c2c_push=C2C 主动推送 / group_push=群主动推送 / ''=事件未携带 */
  scope: string;
  /** 操作场景：setting=资料页设置 / dialog=弹窗授权 / ''=事件未携带 */
  optScene: string;
  /** 累计收到的事件数（同一 peer，含乱序补发的旧事件） */
  eventCount: number;
  /** 最近一次事实的**事件自身时间**（epoch ms）；null=事件未携带时间戳 */
  lastEventAt: number | null;
  firstSeenAt: number;
  /** 最近一次事实应用时的处理时间（epoch ms） */
  updatedAt: number;
}

const MAX_TRACKED_PEERS = 1000;

const store = new Map<string, PushAuthorizeFacts>();

function storeKey(accountId: string, peerOpenid: string): string {
  return `${accountId}:${peerOpenid}`;
}

/**
 * 记录一次授权事件观测，返回累计 facts。
 * peer 维度：群授权事件为 group_openid，用户授权事件为 user_openid。
 *
 * eventTimestampMs 为事件自身时间戳（RFC3339 解析）：
 * - 与已存事实均有时间戳且事件更旧（乱序补发）→ 只累计计数，不回退最新字段；
 * - 任一方缺时间戳 → 按到达顺序应用（无法判定乱序）。
 */
export function recordPushAuthorizeEvent(
  accountId: string,
  peerOpenid: string,
  info: {
    eventType: PushAuthorizeEventType;
    scope?: string;
    optScene?: string;
    eventTimestampMs?: number;
  },
): PushAuthorizeFacts {
  const key = storeKey(accountId, peerOpenid);
  const now = Date.now();
  const eventTs = Number.isFinite(info.eventTimestampMs) ? info.eventTimestampMs! : null;
  const prev = store.get(key);

  if (prev) {
    prev.eventCount += 1;
    const outOfOrder =
      eventTs !== null && prev.lastEventAt !== null && eventTs < prev.lastEventAt;
    if (!outOfOrder) {
      prev.lastEventType = info.eventType;
      prev.scope = info.scope ?? '';
      prev.optScene = info.optScene ?? '';
      prev.lastEventAt = eventTs;
      prev.updatedAt = now;
    }
    return { ...prev };
  }

  if (store.size >= MAX_TRACKED_PEERS) {
    // 简单防膨胀：丢弃最早更新的一半（观测数据可随时重建，不值得引入 LRU 复杂度）
    const keys = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k] of keys.slice(0, Math.floor(keys.length / 2))) store.delete(k);
  }

  const facts: PushAuthorizeFacts = {
    lastEventType: info.eventType,
    scope: info.scope ?? '',
    optScene: info.optScene ?? '',
    eventCount: 1,
    lastEventAt: eventTs,
    firstSeenAt: now,
    updatedAt: now,
  };
  store.set(key, facts);
  return { ...facts };
}

export function getPushAuthorizeFacts(
  accountId: string,
  peerOpenid: string,
): PushAuthorizeFacts | undefined {
  const facts = store.get(storeKey(accountId, peerOpenid));
  return facts ? { ...facts } : undefined;
}

/** 测试用：清空存储 */
export function _resetPushAuthorizeStore(): void {
  store.clear();
}
