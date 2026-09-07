/**
 * 入站事件守卫
 *
 * 拦截三类「非真实用户输入」的入站推送（均有平台文档/SDK 注释背书，
 * 详见 AGENTS.md「入站事件守卫」条目）：
 * 1. 出站回声 —— QQ 会把 bot 自己发出的消息回投为入站事件
 *    （SDK message-filter 注释；c2c 事件无 author.bot，SDK 过滤不到），
 *    按 outbound-echo-store 登记的近期出站消息 id 比对。
 * 2. 重复推送 —— 平台事件文档要求按 msg_seq / message_scene.ext 的
 *    msg_idx 去重（「为确保消息可达，相同 msg_id 可能重复推送」），
 *    SDK 内置去重窗口仅 5s，这里补 30 分钟长窗口。
 * 3. 空内容事件 —— content 空白且无附件、无 msg_elements 的推送
 *    （重推副本 / 结构化回执形态）。注意：带 msg_elements 的 103
 *    引用/转发消息是真实用户操作，必须放行（quoteRef 会渲染引用块）。
 *
 * 每次拦截打 INFO 日志（含 msgType / scene / payload 摘要）——这是
 * 入站事件唯一的非 DEBUG 级痕迹，用于事后取证定位事件真身。
 *
 * 挂载位置：messageFilter 之后、policyInjector 之前（链条最前端，
 * 避免污染群历史、烧 typing 被动回复配额）。
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { isOutboundEcho } from '../features/outbound-echo-store.js';

const DEDUP_TTL_MS = 30 * 60 * 1000; // 覆盖 c2c msg_id 30 分钟被动回复有效期
const DEDUP_MAX = 5000;
const PAYLOAD_PREVIEW_CHARS = 300;

const dedupSeen = new Map<string, number>(); // dedupKey -> 首次见到的时间

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function payloadPreview(raw: unknown): string {
  try {
    return truncateText(JSON.stringify(raw ?? {}), PAYLOAD_PREVIEW_CHARS);
  } catch {
    return '<unserializable>';
  }
}

export interface InboundGuardParams {
  accountId: string;
}

export function inboundGuard(params: InboundGuardParams): Middleware {
  return async (ctx, next) => {
    const msg = ctx.message as Record<string, any> | undefined;
    const accountId = params.accountId;
    const messageId: string | undefined = msg?.messageId;
    const kind: string = msg?.kind ?? '?';

    // 1. 出站回声：入站 id 命中近期出站消息 id
    if (isOutboundEcho(accountId, messageId)) {
      ctx.log.info(`[guard] dropped outbound-echo msgId=${messageId ?? '?'} kind=${kind}`);
      ctx.stop('outbound-echo');
      return;
    }

    // 2. 重复推送：msgId + msgIdx 长窗口去重
    const msgIdx: string | undefined = msg?.msgIdx;
    const dedupKey = `${accountId}:${kind}:${messageId ?? ''}:${msgIdx ?? ''}`;
    const now = Date.now();
    const firstSeen = dedupSeen.get(dedupKey);
    if (firstSeen !== undefined && now - firstSeen <= DEDUP_TTL_MS) {
      ctx.log.info(
        `[guard] dropped duplicate-push msgId=${messageId ?? '?'} msgIdx=${msgIdx ?? ''} kind=${kind} ageMs=${now - firstSeen}`,
      );
      ctx.stop('duplicate-push');
      return;
    }
    dedupSeen.set(dedupKey, now);
    if (dedupSeen.size > DEDUP_MAX) {
      for (const [key, ts] of dedupSeen) {
        if (dedupSeen.size <= DEDUP_MAX && now - ts <= DEDUP_TTL_MS) break;
        dedupSeen.delete(key);
      }
    }

    // 3. 空内容事件：无文本、无附件、无消息元素
    const contentBlank = !String(msg?.content ?? '').trim();
    const hasAttachments = Array.isArray(msg?.attachments) && msg.attachments.length > 0;
    const hasElements = Array.isArray(msg?.msgElements) && msg.msgElements.length > 0;
    if (contentBlank && !hasAttachments && !hasElements) {
      ctx.log.info(
        `[guard] dropped contentless msgId=${messageId ?? '?'} kind=${kind}` +
          ` msgType=${msg?.msgType ?? '?'} scene=${msg?.messageScene?.source ?? '?'}` +
          ` payload=${payloadPreview(msg?.raw)}`,
      );
      ctx.stop('contentless');
      return;
    }

    await next();
  };
}

/** 测试用：清空去重表 */
export function clearInboundGuardDedup(): void {
  dedupSeen.clear();
}
