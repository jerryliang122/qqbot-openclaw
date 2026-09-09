/**
 * 群推送模式推断存储（内存，跨重启不保留）
 *
 * 群主把 bot 拉进群时会选推送模式（AT 纯 / AT+最近N≤10 / 全量），这是群主侧
 * 的设置，插件不可控、同账号各群混合存在。平台只通过事件类型暴露这个事实：
 * - GROUP_AT_MESSAGE_CREATE → AT 系（纯 AT 或 AT+最近N，两者无法区分）
 * - GROUP_MESSAGE_CREATE    → 全量模式（bot 像普通群成员收到所有消息）
 *
 * 推断结果供 /bot-group-info 展示与排障（"这个群为什么没上下文"——群主设的
 * 是纯 AT 模式）。模式变化打 INFO 日志留痕。
 */

/** 平台推送模式（按事件类型推断） */
export type GroupPushMode = 'at' | 'full';

export interface GroupModeFacts {
  /** 推断的推送模式（按最近一次事件类型） */
  mode: GroupPushMode;
  /** 最近一次见到的事件类型（原文保留） */
  lastEventType: string;
  /** 曾见过 msg_elements（AT+最近N 的上下文载体，或用户引用/转发消息） */
  sawMsgElements: boolean;
  /** 首次/最近观测时间（epoch ms） */
  firstSeenAt: number;
  updatedAt: number;
}

const MAX_TRACKED_GROUPS = 1000;

const store = new Map<string, GroupModeFacts>();

function storeKey(accountId: string, groupOpenid: string): string {
  return `${accountId}:${groupOpenid}`;
}

/** 记录一次群事件观测；推断模式变化时返回新模式（供调用方打日志），否则 null */
export function recordGroupEvent(
  accountId: string,
  groupOpenid: string,
  eventType: string,
  hasMsgElements: boolean,
): GroupPushMode | null {
  const key = storeKey(accountId, groupOpenid);
  const now = Date.now();
  const mode: GroupPushMode = eventType === 'GROUP_MESSAGE_CREATE' ? 'full' : 'at';
  const prev = store.get(key);

  if (prev) {
    const modeChanged = prev.mode !== mode;
    prev.lastEventType = eventType;
    prev.mode = mode;
    prev.sawMsgElements = prev.sawMsgElements || hasMsgElements;
    prev.updatedAt = now;
    return modeChanged ? mode : null;
  }

  if (store.size >= MAX_TRACKED_GROUPS) {
    // 简单防膨胀：丢弃最早观测的一半（推断数据可随时重建，不值得引入 LRU 复杂度）
    const keys = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [k] of keys.slice(0, Math.floor(keys.length / 2))) store.delete(k);
  }
  store.set(key, {
    mode,
    lastEventType: eventType,
    sawMsgElements: hasMsgElements,
    firstSeenAt: now,
    updatedAt: now,
  });
  return null; // 首次观测不视为「变化」
}

export function getGroupModeFacts(accountId: string, groupOpenid: string): GroupModeFacts | undefined {
  return store.get(storeKey(accountId, groupOpenid));
}

/** 测试用：清空存储 */
export function _resetGroupModeStore(): void {
  store.clear();
}
