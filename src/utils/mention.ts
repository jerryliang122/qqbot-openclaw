/**
 * Mention 工具函数
 *
 * @mention 检测与清理，供 channel.ts 和 gateway 层使用。
 */

export interface MentionEntry {
  member_openid?: string;
  id?: string;
  user_openid?: string;
  is_you?: boolean;
  nickname?: string;
  username?: string;
}

/** 清理 @mention：替换 <@openid> 为 @用户名，去除 @机器人自身 */
export function stripMentionText(text: string, mentions?: MentionEntry[]): string {
  if (!text || !mentions?.length) return text;
  let cleaned = text;
  for (const m of mentions) {
    const openid = m.member_openid ?? m.id ?? m.user_openid;
    if (!openid) continue;
    if (m.is_you) {
      cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), '').trim();
    } else {
      const displayName = m.nickname ?? m.username;
      if (displayName) {
        cleaned = cleaned.replace(new RegExp(`<@!?${openid}>`, 'g'), `@${displayName}`);
      }
    }
  }
  return cleaned;
}

/**
 * 事件级 @提及判定（QQ 平台侧的权威信号）。
 *
 * - GROUP_AT_MESSAGE_CREATE：事件本身就是"用户真的 @ 了 bot"的权威信号
 * - mentions[].is_you：服务端标记的结构化 mention 列表
 *
 * 与 SDK mentionGate 的判定一致；单测里消息可能不经中间件链直达 dispatch，
 * 故 dispatch 侧仍需自查一次（SDK 的 ctx.state.mention 可能不存在）。
 */
export function detectEventMention({ eventType, mentions }: {
  eventType?: string;
  mentions?: Array<{ is_you?: boolean }>;
}): boolean {
  if (mentions?.some((m) => m.is_you)) return true;
  if (eventType === 'GROUP_AT_MESSAGE_CREATE') return true;
  return false;
}

/**
 * 称呼唤醒判定：内容命中 mentionPatterns 正则即视为"在叫 bot"。
 *
 * 与 @提及（SDK mentionGate 判定）、引用 bot（isImplicitMention）并列，
 * 是第三种唤醒方式。单独成函数的原因：门控（middleware-setup）与入站
 * 分类（dispatch）必须用**同一份**判定，否则会出现"门控放行但分类成
 * room_event"或"门控拦掉但分类成 user_request"的错配。
 */
export function matchesNamePattern({ content, mentionPatterns }: {
  content?: string;
  mentionPatterns?: string[];
}): boolean {
  if (!mentionPatterns?.length || !content) return false;
  for (const pattern of mentionPatterns) {
    try {
      if (new RegExp(pattern, 'i').test(content)) return true;
    } catch { /* 无效正则，跳过 */ }
  }
  return false;
}

/** 检测消息是否 @了机器人 */
export function detectWasMentioned({ eventType, mentions, content, mentionPatterns }: {
  eventType?: string;
  mentions?: Array<{ is_you?: boolean }>;
  content?: string;
  mentionPatterns?: string[];
}): boolean {
  if (detectEventMention({ eventType, mentions })) return true;
  return matchesNamePattern({ content, mentionPatterns });
}
