/**
 * 出站消息回声登记
 *
 * SDK message-filter 文档注明：QQ 可能把机器人自己的出站消息回投为入站
 * 事件（群聊尤其常见）。c2c 事件不映射 author.bot，SDK 的 skipSelfEcho
 * 过滤对私聊回声无效 —— 这里按「近期出站消息 id」自行比对。
 *
 * 出站 id 来源：wrapBotSendForRefIndex（sendText / sendMedia / 流式
 * complete 的返回值 msg.id）。若平台回声携带新 id 而非原 id，比对会
 * miss —— 由 inbound-guard 的空内容/去重检查兜底。
 */

const TTL_MS = 30 * 60 * 1000; // 与 msgid-cache 的 c2c TTL 对齐
const MAX_ENTRIES = 2000;

const seen = new Map<string, number>(); // `${accountId}:${messageId}` -> 记录时间

function prune(now: number): void {
  for (const [key, ts] of seen) {
    if (seen.size <= MAX_ENTRIES && now - ts <= TTL_MS) break;
    seen.delete(key);
  }
}

export function recordOutboundMessageId(accountId: string, messageId: string | undefined | null): void {
  if (!messageId) return;
  seen.set(`${accountId}:${messageId}`, Date.now());
  prune(Date.now());
}

export function isOutboundEcho(accountId: string, messageId: string | undefined | null): boolean {
  if (!messageId) return false;
  const key = `${accountId}:${messageId}`;
  const ts = seen.get(key);
  if (ts === undefined) return false;
  if (Date.now() - ts > TTL_MS) {
    seen.delete(key);
    return false;
  }
  return true;
}

/** 测试用：清空登记表 */
export function clearOutboundEchoStore(): void {
  seen.clear();
}
