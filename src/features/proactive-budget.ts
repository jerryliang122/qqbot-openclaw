/**
 * 主动消息每日预算观测
 *
 * QQ Bot 平台主动消息（不带 msg_id）有每日额度（接收方维度约 1000 条/天），
 * 被动回复（带 msg_id）不占此预算。插件全链路被动优先（msgid-cache 挂接 +
 * 配额预检），主动仅在「静群超 TTL」或「被动配额耗尽」时触发——本模块对
 * 这些残余的主动发送按账号计数，接近阈值告警，供排障与预算复核。
 */
import { createPluginLogger } from '../utils/plugin-logger.js';

const log = createPluginLogger({ prefix: '[proactive-budget]' });

/** 平台每日主动消息额度（保守取 1000） */
export const DAILY_PROACTIVE_LIMIT = 1000;

/** 告警阈值比例（80%）与之后的步进 */
const WARN_RATIO = 0.8;
const WARN_EVERY = 100;

const counters = new Map<string, { date: string; count: number }>();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 记录一次主动发送（无 msg_id 的出站）；跨天自动重置 */
export function recordProactiveSend(accountId: string): void {
  let counter = counters.get(accountId);
  if (!counter || counter.date !== today()) {
    counter = { date: today(), count: 0 };
    counters.set(accountId, counter);
  }
  counter.count += 1;

  const warnAt = Math.floor(DAILY_PROACTIVE_LIMIT * WARN_RATIO);
  if (counter.count === warnAt || (counter.count > warnAt && counter.count % WARN_EVERY === 0)) {
    log.warn(
      `proactive daily budget ${counter.count}/${DAILY_PROACTIVE_LIMIT} used (accountId=${accountId}); ` +
        `passive replies (msg_id) don't count — check msgid-cache TTL / passive quota if unexpected`,
    );
  }
}

/** 查询当日用量（诊断/命令展示用） */
export function getProactiveUsage(accountId: string): { date: string; count: number; limit: number } {
  const counter = counters.get(accountId);
  return {
    date: counter?.date ?? today(),
    count: counter?.date === today() ? counter.count : 0,
    limit: DAILY_PROACTIVE_LIMIT,
  };
}

/** 测试用：清空计数 */
export function _resetProactiveBudget(): void {
  counters.clear();
}
