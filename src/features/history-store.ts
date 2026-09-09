import { MemoryHistoryStore } from '@tencent-connect/qqbot-nodejs';
import type { HistoryStore, HistoryEntry } from '@tencent-connect/qqbot-nodejs';

/** 出站历史条目（在 HistoryEntry 上附加 isBot 标记，rolling 模式裁剪用） */
export type OutboundHistoryEntry = HistoryEntry & { isBot: true };

let _store: HistoryStore | null = null;

export function getHistoryStore(): HistoryStore {
  if (!_store) _store = new MemoryHistoryStore();
  return _store;
}

/** 用 accountId 前缀隔离多账号，避免同群历史串用 */
export function historyGroupKey(accountId: string, groupId: string): string {
  return `${accountId}:${groupId}`;
}

/** 清空群历史（dispatch 完成后调用，historyMode=clear 语义） */
export function clearGroupHistory(accountId: string, groupId: string): void {
  _store?.clear?.(historyGroupKey(accountId, groupId));
}

/**
 * bot 出站消息记入群历史（historyMode=rolling 语义）。
 * 仅群消息回复需要；条目带 isBot=true，供裁剪定位"bot 最后一条发言"。
 */
export function recordOutboundToGroupHistory(
  accountId: string,
  groupOpenid: string,
  entry: { messageId: string; senderId: string; senderName?: string; content: string },
  limit: number,
): void {
  if (limit <= 0) return;
  const historyEntry: OutboundHistoryEntry = {
    messageId: entry.messageId,
    senderId: entry.senderId,
    senderName: entry.senderName,
    content: entry.content,
    timestamp: Date.now(),
    isBot: true,
  };
  void _store?.append?.(historyGroupKey(accountId, groupOpenid), historyEntry, limit);
}

/**
 * rolling 模式裁剪：删除最后一条 bot 出站（含）之前的全部条目，
 * 保留其后的人类消息（下次 @ 时组包，AI 由此知道自己上次说到哪）。
 * 无 bot 出站记录时不动（保守：等价于不清）。返回保留的条数（供日志）。
 */
export function trimGroupHistoryAfterLastBot(accountId: string, groupId: string, limit: number): number {
  const store = _store;
  if (!store?.list || !store.clear || !store.append) return 0;
  const key = historyGroupKey(accountId, groupId);
  const listed = store.list(key, 1_000_000);
  if (listed instanceof Promise) return 0; // 异步后端不支持同步裁剪（当前为 MemoryHistoryStore 同步实现）
  const entries: HistoryEntry[] = listed;
  if (entries.length === 0) return 0;

  let lastBotIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if ((entries[i] as { isBot?: boolean }).isBot === true) {
      lastBotIdx = i;
      break;
    }
  }
  if (lastBotIdx < 0) return 0;

  const kept = entries.slice(lastBotIdx + 1);
  store.clear(key);
  for (const e of kept) {
    store.append(key, e, Math.max(limit, kept.length));
  }
  return kept.length;
}
