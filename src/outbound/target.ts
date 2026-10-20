/**
 * 出站目标地址解析
 *
 * 将 OpenClaw 规范的目标地址字符串（如 qqbot:c2c:xxx / qqbot:group:xxx）
 * 转换为 SDK 的 ReplyTarget 结构。
 *
 * 也导出共享的正则常量供 channel.ts messaging 段复用。
 */
import type { ReplyTarget } from '@tencent-connect/qqbot-nodejs';

// ── 共享正则常量 ──

/** 32 位十六进制 OpenID（不带连字符） */
export const OPENID_HEX_RE = /^[0-9a-fA-F]{32}$/;

/** UUID 格式的 OpenID（带连字符） */
export const OPENID_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 带 qqbot: 前缀的目标格式 */
export const QQBOT_PREFIX_RE = /^qqbot:(c2c|group|channel):/i;

/** 不带前缀但有 scope 标识 */
export const SCOPE_PREFIX_RE = /^(c2c|group|channel):/i;

/**
 * 判断 ID 是否看起来像 QQ Bot 目标格式
 */
export function isQQBotTarget(id: string): boolean {
  if (QQBOT_PREFIX_RE.test(id)) return true;
  if (SCOPE_PREFIX_RE.test(id)) return true;
  if (OPENID_HEX_RE.test(id)) return true;
  return OPENID_UUID_RE.test(id);
}

/**
 * 规范化目标地址字符串
 */
export function normalizeTarget(target: string): string | undefined {
  const id = target.replace(/^qqbot:/i, '');
  if (id.startsWith('c2c:') || id.startsWith('group:') || id.startsWith('channel:')) {
    return `qqbot:${id}`;
  }
  if (OPENID_HEX_RE.test(id)) return `qqbot:c2c:${id}`;
  if (OPENID_UUID_RE.test(id)) return `qqbot:c2c:${id}`;
  return undefined;
}

/**
 * 推断目标地址对应的会话类型（OpenClaw `ChatType` 语义）
 *
 * 10.5 官方通道插件指南：宿主做「隐式 owner 心跳投递」时依赖通道直接给出
 * 会话类型分类；通道不提供 `inferTargetChatType` 时，Gateway 状态会一直
 * 报 `waiting for route`（路由等不到可判定的会话类型）。
 *
 * 映射：
 *   - `qqbot:c2c:<openid>` / 裸 openid（32 位 hex / UUID）→ `direct`
 *   - `qqbot:group:<groupid>`                              → `group`
 *   - 其余（空、无法判定、QQ 频道等本插件不支持的 scope）   → `undefined`
 *     （交回宿主走常规路由，不猜）
 */
export function inferQQBotChatType(to: string): 'direct' | 'group' | undefined {
  if (!to || typeof to !== 'string') return undefined;

  const id = to.replace(/^qqbot:/i, '');

  if (id.startsWith('c2c:')) {
    return id.length > 'c2c:'.length ? 'direct' : undefined;
  }
  if (id.startsWith('group:')) {
    return id.length > 'group:'.length ? 'group' : undefined;
  }
  // 裸 openid 形态按私聊处理（与 parseTarget 的默认分支一致）
  if (OPENID_HEX_RE.test(id) || OPENID_UUID_RE.test(id)) {
    return 'direct';
  }
  return undefined;
}

/**
 * 解析目标地址字符串为 SDK ReplyTarget
 * 
 * 注意：此函数总是返回 ReplyTarget，即使输入无效（targetId 可能为空字符串）
 * 如果需要严格验证，请使用 tryParseTarget
 */
export function parseTarget(to: string): ReplyTarget {
  // 空字符串或无效输入返回默认值
  if (!to || typeof to !== 'string') {
    return { scope: 'c2c', targetId: '' };
  }

  const id = to.replace(/^qqbot:/i, '');

  if (id.startsWith('c2c:')) {
    return { scope: 'c2c', targetId: id.slice(4) };
  }
  if (id.startsWith('group:')) {
    return { scope: 'group', targetId: id.slice(6) };
  }
  // channel 不被 SDK ChatScope 支持，当作 c2c 处理
  if (id.startsWith('channel:')) {
    return { scope: 'c2c', targetId: id.slice(8) };
  }

  // 默认当作 c2c（32 位十六进制 / UUID 格式的 openid）
  return { scope: 'c2c', targetId: id };
}

/**
 * 严格解析目标地址字符串，验证输入有效性
 * @returns ReplyTarget 或 null（如果输入无效）
 */
export function tryParseTarget(to: string): ReplyTarget | null {
  // 空字符串或无效输入返回 null
  if (!to || typeof to !== 'string') {
    return null;
  }

  const id = to.replace(/^qqbot:/i, '');

  // 检查是否是有效的目标格式
  if (id.startsWith('c2c:')) {
    const targetId = id.slice(4);
    if (!targetId) return null; // c2c: 后面必须有内容
    return { scope: 'c2c', targetId };
  }
  if (id.startsWith('group:')) {
    const targetId = id.slice(6);
    if (!targetId) return null; // group: 后面必须有内容
    return { scope: 'group', targetId };
  }

  // 默认当作 c2c（32 位十六进制 / UUID 格式的 openid）
  // 但必须匹配有效的 openid 格式
  if (OPENID_HEX_RE.test(id) || OPENID_UUID_RE.test(id)) {
    return { scope: 'c2c', targetId: id };
  }

  // 无效格式返回 null
  return null;
}
