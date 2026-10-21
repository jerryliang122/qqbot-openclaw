/**
 * room_event（被动房间事件）策略解析
 *
 * ## 背景
 *
 * openclaw 2026.10.5 把群聊里"未被 @ 的消息"分成两种处理：
 *
 *   - **user_request**（默认）：未被 @ 的消息被门禁挡下，只进历史、不起 turn。
 *   - **room_event**：未被 @ 的消息作为"安静上下文"跑一个 turn；最终文本不投递
 *     （结构性沉默），想发言必须显式调 `message` 工具。
 *
 * 框架侧的裁决入口是 core 的 `resolveUnmentionedGroupInboundPolicy`
 * （openclaw/plugin-sdk/channel-inbound，9.1 起可用），回落链是：
 *
 *   agents.entries.<id>.groupChat.unmentionedInbound   （per-agent，最高）
 *     > messages.groupChat.unmentionedInbound          （全局）
 *     > "user_request"                                  （默认）
 *
 * 本插件此前只认自己的 `channels.qqbot.groups.<id>.unmentionedInbound`，
 * **不读框架任何一级**——用户照官方文档配 `messages.groupChat.unmentionedInbound`
 * 对本插件完全无效（表现为"配了 room_event 但群里毫无反应"）。本模块把回落链
 * 补齐，并让插件自有的 per-group 键保持最高优先级（比框架更具体）。
 *
 * ## 可见回复模式
 *
 * `messages.groupChat.visibleReplies`（"automatic" | "message_tool"）决定群消息
 * 的最终文本是否自动投递。room_event **强制** message_tool（严格投递），
 * 其余群消息按配置走（默认 automatic = 现状）。
 *
 * ## message 工具可用性守卫
 *
 * 框架在 message 工具不可用时会把"自动投递"降级为 automatic
 * （9.1 `source-reply-delivery-mode` 的 messageToolAvailable 分支），
 * **但 room_event 分支直接 return message_tool_only，不走该降级**——agent 没有
 * message 工具时，群里就是永久沉默。2026-10-06 线上事故正是如此：群工具策略
 * 被映射成空允许清单 → message 工具被过滤 → room_event 群彻底没声。
 *
 * 插件侧因此自己保守判定一次 message 工具是否可用：只在**确定不可用**时
 * （群策略显式 deny / 群白名单不含 message / agent profile 不含 message）把
 * 该群降级回 user_request 并打 WARN，避免"配了 room_event 却全场静默"。
 * 判定不确定时一律按可用处理（乐观），宁可多跑一次 turn 也不误伤。
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import {
  findAgentEntry,
  resolveGroupConfigFromAccount,
  resolveGroupToolPolicyConfig,
  resolveMentionPatterns,
} from '../config.js';
import { getAdapters } from '../adapter/resolve.js';

/** 未被 @ 消息的入站策略 */
export type UnmentionedInbound = 'user_request' | 'room_event';

/** 群消息可见回复模式 */
export type VisibleRepliesMode = 'automatic' | 'message_tool';

/** 入站策略的来源（用于日志与排障） */
export type UnmentionedInboundSource = 'group' | 'agent' | 'global' | 'default';

export interface UnmentionedInboundResolution {
  /** 生效的入站策略 */
  mode: UnmentionedInbound;
  /** 策略来源 */
  source: UnmentionedInboundSource;
}

export interface MessageToolAvailability {
  /** 是否确定可用（不确定时按可用处理） */
  available: boolean;
  /** 不可用原因（仅 available=false 时有值） */
  reason?: string;
}

export interface RoomEventPolicy extends UnmentionedInboundResolution {
  /** 可见回复模式（按 effectiveMode 计算） */
  visibleReplies: VisibleRepliesMode;
  /** message 工具是否可用（room_event 守卫的判定结果） */
  messageToolAvailable: boolean;
  /**
   * 实际生效的入站策略。与 `mode` 的差异：mode 是配置层裁决结果，
   * effectiveMode 是叠加"message 工具不可用则降级"后的最终结果。
   */
  effectiveMode: UnmentionedInbound;
  /** 是否发生过降级（room_event → user_request） */
  degraded: boolean;
  /** 降级原因 */
  degradedReason?: string;
}

// ── 入站策略回落链 ─────────────────────────────────────────────

function normalizeUnmentionedInbound(raw: unknown): UnmentionedInbound | undefined {
  return raw === 'room_event' || raw === 'user_request' ? raw : undefined;
}

/**
 * 解析未被 @ 消息的入站策略。
 *
 * 优先级（从具体到通用）：
 *   1. 群级显式配置（插件自有 `channels.qqbot.groups.<id>.unmentionedInbound`）
 *   2. per-agent（`agents.entries.<id>.groupChat.unmentionedInbound`，
 *      兼容 `agents.list` 旧形态）
 *   3. 全局（`messages.groupChat.unmentionedInbound`）
 *   4. 默认 `user_request`
 */
export function resolveUnmentionedInboundMode(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  /** 群级显式值（未显式配置时传 undefined，勿传默认 'user_request'） */
  groupMode?: UnmentionedInbound;
}): UnmentionedInboundResolution {
  const groupMode = normalizeUnmentionedInbound(params.groupMode);
  if (groupMode) return { mode: groupMode, source: 'group' };

  if (params.agentId) {
    const agentGroupChat = findAgentEntry(params.cfg, params.agentId)?.groupChat as
      | { unmentionedInbound?: unknown }
      | undefined;
    if (agentGroupChat && Object.hasOwn(agentGroupChat, 'unmentionedInbound')) {
      const mode = normalizeUnmentionedInbound(agentGroupChat.unmentionedInbound);
      if (mode) return { mode, source: 'agent' };
    }
  }

  const globalGroupChat = (params.cfg as any)?.messages?.groupChat;
  if (globalGroupChat && typeof globalGroupChat === 'object' && Object.hasOwn(globalGroupChat, 'unmentionedInbound')) {
    const mode = normalizeUnmentionedInbound(globalGroupChat.unmentionedInbound);
    if (mode) return { mode, source: 'global' };
  }

  return { mode: 'user_request', source: 'default' };
}

// ── 可见回复模式 ───────────────────────────────────────────────

/**
 * 解析群消息的可见回复模式。
 *
 * - room_event：强制 `message_tool`（严格投递：最终文本不投递，只能走 message 工具）
 * - 群/频道的普通 turn：`messages.groupChat.visibleReplies` → `messages.visibleReplies`
 * - 非群（c2c/dm）：**只读** `messages.visibleReplies`
 *
 * ⚠️ `groupChat.*` 只作用于群/频道：早先不分会话类型统一读 groupChat，
 * 会让"群里配 visibleReplies=message_tool"把**私聊**的终稿也压成静默
 * （框架的 c2c 分支只读 messages.visibleReplies）。
 */
export function resolveVisibleRepliesMode(params: {
  cfg: OpenClawConfig;
  mode: UnmentionedInbound;
  /** 会话类型；缺省按群处理（调用方未区分时保持旧行为） */
  chatType?: 'group' | 'channel' | 'direct' | 'other';
}): VisibleRepliesMode {
  if (params.mode === 'room_event') return 'message_tool';
  const messages = (params.cfg as any)?.messages;
  const groupLike = params.chatType === undefined || params.chatType === 'group' || params.chatType === 'channel';
  const configured = groupLike
    ? (messages?.groupChat?.visibleReplies ?? messages?.visibleReplies)
    : messages?.visibleReplies;
  return configured === 'message_tool' ? 'message_tool' : 'automatic';
}

// ── message 工具可用性 ─────────────────────────────────────────

interface AgentToolsConfig {
  profile?: string;
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}

/**
 * 读取 agent 的工具配置（对齐框架 `resolveEffectiveToolPolicy` 的取值顺序）：
 *   agent 条目 > agents.defaults（无 agent 花名册时）> 全局 tools
 */
function resolveAgentToolsConfig(cfg: OpenClawConfig, agentId?: string): AgentToolsConfig | undefined {
  const raw = cfg as any;
  const agents = raw?.agents;
  const hasRoster = Boolean(agents && (Array.isArray(agents.list) || (agents.entries && Object.keys(agents.entries).length > 0)));
  const agentEntry = agentId ? findAgentEntry(cfg, agentId) as (AgentToolsConfig & { id?: string }) | undefined : undefined;
  const agentTools = (agentEntry as any)?.tools as AgentToolsConfig | undefined;
  const implicitDefaults = hasRoster ? undefined : (agents?.defaults?.tools as AgentToolsConfig | undefined);
  const globalTools = raw?.tools as AgentToolsConfig | undefined;
  return agentTools ?? implicitDefaults ?? globalTools;
}

/** 工具策略的一层（群 / agent / 全局同形） */
interface ToolPolicyLayer {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
}

/**
 * 按框架语义合成一层的有效允许集。
 *
 * 对齐 core `unionAllow`（9.1 dist `sandbox-tool-policy-bkx-xmDc.js`）：
 * - `allow` 非空 → 与 `alsoAllow` 取并集（白名单语义）
 * - `allow` **缺失或为空数组** → `unionAllow` 产出 `["*", ...alsoAllow]`
 *   ——**隐式全放行**（core 另打 `IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW` 标记）
 * - 两者都缺 → 不限制（空允许清单 = 允许一切未被 deny 的）
 *
 * ⚠️ 「只有 alsoAllow」不是排他白名单——早先按排他白名单判会把
 * `tools: { alsoAllow: [...] }` 的群误判成"message 不可用"而降级，
 * 与框架结论正好相反。
 */
function effectiveAllowList(policy?: ToolPolicyLayer): string[] | undefined {
  if (!policy) return undefined;
  const allow = Array.isArray(policy.allow) ? policy.allow : undefined;
  const alsoAllow = Array.isArray(policy.alsoAllow) ? policy.alsoAllow : undefined;
  if (!allow || allow.length === 0) {
    // allow 缺失/为空 → core 合成 ["*", ...alsoAllow]（含通配 = 实际不限制）
    return alsoAllow && alsoAllow.length > 0 ? ['*', ...alsoAllow] : undefined;
  }
  return alsoAllow && alsoAllow.length > 0 ? [...allow, ...alsoAllow] : allow;
}

/**
 * 判断一个 allow/deny 条目是否命中工具名（对齐 core 的 glob 匹配）。
 *
 * 对齐 core `compileGlobPattern` / `matchesAnyGlobPattern`
 * （9.1 dist `glob-pattern-DFVWJ-hh.js`）：
 * - `*` → 命中一切
 * - 不含 `*` → 精确匹配（双方都经 `normalizeLowercaseStringOrEmpty` 小写化）
 * - 含 `*` → 正则 `^...$`（`*` → `.*`；`?` 不是通配符，按字面量处理）
 *
 * ⚠️ 字面量比较会漏判 `deny: ["mess*"]` 这类通配写法——框架会拦下 message，
 * 守卫却看不见，于是该群真的被静默。
 */
function toolPatternMatches(pattern: string, tool: string): boolean {
  const normalizedPattern = (pattern ?? '').trim().toLowerCase();
  const normalizedTool = tool.toLowerCase();
  if (!normalizedPattern) return false;
  if (normalizedPattern === '*') return true;
  if (!normalizedPattern.includes('*')) return normalizedPattern === normalizedTool;
  const escaped = normalizedPattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\*/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(normalizedTool);
  } catch {
    return false;
  }
}

/**
 * 判定某一层策略是否**确定屏蔽**了 message 工具，返回屏蔽原因。
 *
 * 对齐 core `createToolPolicyMatcher`：deny 优先；非空 allow 清单是白名单，
 * 清单外的工具一律不可用（空清单 = 不限制；含 `*` 通配 = 实际不限制）。
 */
function layerBlocksMessage(policy?: ToolPolicyLayer): string | undefined {
  if (!policy) return undefined;
  const deny = policy.deny ?? [];
  if (deny.some((pattern) => toolPatternMatches(pattern, 'message'))) {
    return '显式禁用 message 工具';
  }
  const allow = effectiveAllowList(policy);
  if (!allow || allow.length === 0) return undefined;
  if (allow.some((pattern) => toolPatternMatches(pattern, 'message'))) return undefined;
  return '工具白名单不含 message 工具';
}

/**
 * 保守判定 message 工具是否可用。
 *
 * 只在**确定不可用**时返回 available=false——即某一层（群 / agent / 全局）
 * 的显式 allow/deny 清单把 message 排除掉了。
 *
 * **agent profile 不算阻塞**：框架在 `message_tool_only` / `room_event` turn
 * 会把 `message` 强制并入 profile 的允许集（core `runtimeProfileAlsoAllow`，
 * 9.1 与 10.5 一致），所以 `minimal` / `coding` profile 的 agent 在房间事件里
 * **依然能说话**（core 的 `CORE_TOOL_PROFILES` 里 message 只登记在 `messaging`
 * profile，但那层会被运行时的强制授权覆盖）——早先按 profile 判不可用会把
 * 这类群误降级。
 *
 * 其余情况（未声明任何清单、profile 未知）一律按**可用**处理：
 * 宁可多跑一次 turn，也不要把能说话的群误判成沉默。
 */
export function resolveMessageToolAvailability(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  /** 群级工具策略（插件交给框架的那份） */
  groupToolPolicy?: ToolPolicyLayer | undefined;
}): MessageToolAvailability {
  const groupBlock = layerBlocksMessage(params.groupToolPolicy);
  if (groupBlock) return { available: false, reason: `群${groupBlock}` };

  const agentTools = resolveAgentToolsConfig(params.cfg, params.agentId);
  if (agentTools) {
    const agentBlock = layerBlocksMessage(agentTools);
    if (agentBlock) return { available: false, reason: `agent ${agentBlock}` };
  }

  const globalTools = (params.cfg as any)?.tools as ToolPolicyLayer | undefined;
  const globalBlock = layerBlocksMessage(globalTools);
  if (globalBlock) return { available: false, reason: `全局${globalBlock}` };

  return { available: true };
}

// ── 汇总 ───────────────────────────────────────────────────────

/**
 * 解析群 room_event 策略（配置快照 + agent 路由 + 工具守卫）。
 *
 * 这是**唯一**的策略裁决入口：门控（middleware）、入站分类（dispatch）、
 * 历史缓冲跳过（middleware / gateway）都调用它，保证三处结论一致。
 *
 * agent 路由的解析需要 runtime（config + routing），故单独一层：
 * 没有 runtime 时（如部分单测）按"无框架配置"处理——只认群级配置。
 */
export function resolveGroupRoomEventPolicy(
  account: ResolvedQQBotAccount,
  groupOpenid: string,
  getRuntime?: () => any,
): { policy: RoomEventPolicy; agentId?: string; mentionPatterns: string[] } {
  let cfg: any = {};
  let agentId: string | undefined;

  try {
    const runtime = getRuntime?.();
    if (runtime) {
      const adapters = getAdapters(runtime);
      cfg = adapters.getConfig?.() ?? {};
      // agent 路由决定 per-agent 的入站策略覆盖（agents.entries.<id>.groupChat.*）
      agentId = adapters.resolveAgentRoute?.({
        cfg,
        channel: 'qqbot',
        accountId: account.accountId,
        peer: { kind: 'group', id: groupOpenid },
      })?.agentId;
    }
  } catch {
    // 配置/路由不可用时按"无框架配置"处理：只认群级配置，不阻断消息流
  }

  const policy = resolveRoomEventPolicy({ cfg, account, groupOpenid, agentId });
  return { policy, agentId, mentionPatterns: resolveMentionPatterns(cfg, agentId) };
}

/**
 * 解析某个群的完整 room_event 策略（入站模式 + 可见回复 + 工具守卫）。
 *
 * 降级规则：配置裁决出 room_event、但 message 工具**确定不可用**时，
 * 该群降级回 user_request（bot 恢复正常回复权），避免"配了 room_event 却群里
 * 永久沉默"。用户可用 `groups.<id>.roomEventRequireMessageTool: false` 关掉
 * 降级（接受严格静默语义）。
 */
export function resolveRoomEventPolicy(params: {
  cfg: OpenClawConfig;
  account: ResolvedQQBotAccount;
  groupOpenid: string;
  agentId?: string;
}): RoomEventPolicy {
  const groupCfg = resolveGroupConfigFromAccount(params.account, params.groupOpenid);
  const resolution = resolveUnmentionedInboundMode({
    cfg: params.cfg,
    agentId: params.agentId,
    groupMode: groupCfg.unmentionedInboundExplicit,
  });

  if (resolution.mode !== 'room_event') {
    return {
      ...resolution,
      visibleReplies: resolveVisibleRepliesMode({ cfg: params.cfg, mode: resolution.mode }),
      messageToolAvailable: true,
      effectiveMode: resolution.mode,
      degraded: false,
    };
  }

  const groupToolPolicy = resolveGroupToolPolicyConfig(params.cfg, params.account.accountId, params.groupOpenid);
  const availability = resolveMessageToolAvailability({
    cfg: params.cfg,
    agentId: params.agentId,
    groupToolPolicy,
  });

  const requireMessageTool = groupCfg.roomEventRequireMessageTool ?? true;
  const degraded = !availability.available && requireMessageTool;
  const effectiveMode: UnmentionedInbound = degraded ? 'user_request' : 'room_event';

  return {
    ...resolution,
    visibleReplies: resolveVisibleRepliesMode({ cfg: params.cfg, mode: effectiveMode }),
    messageToolAvailable: availability.available,
    effectiveMode,
    degraded,
    degradedReason: degraded ? availability.reason : undefined,
  };
}

// ── 唤醒判定与入站分类 ─────────────────────────────────────────
/** 唤醒来源 */
export type WakeSource = 'mention' | 'quote-bot' | 'name-pattern' | 'none';

export interface WakeDecision {
  /** 是否为"在叫 bot"（任一唤醒方式命中） */
  wasMentioned: boolean;
  /** 命中来源（wasMentioned=true 时有效） */
  source: WakeSource;
}

/**
 * 统一的唤醒判定。
 *
 * 三种唤醒方式（README 的"三种唤醒模式"）：
 *   1. `mention`   —— @提及（SDK mentionGate 判定：AT 事件 / mentions.is_you / 内容标记）
 *   2. `quote-bot` —— 引用 bot 出站消息（SDK mentionGate 的 implicit 判定）
 *   3. `name-pattern` —— 称呼唤醒（`mentionPatterns` 正则命中）
 *
 * **口径必须单一**：门控（middleware-setup）、body 组装（@you 标记 / 历史注入）、
 * 入站分类（dispatch）三处此前各算各的——body 组装只认 SDK 标志，导致"称呼唤醒"
 * 的群消息既没有 `(@you)` 标记也拿不到群历史。本函数是唯一口径来源。
 */
export function resolveWakeDecision(params: {
  /** SDK mentionGate 的判定结果 */
  mentionState?: { wasMentioned?: boolean; implicit?: boolean };
  /** 称呼唤醒判定结果 */
  nameMentioned: boolean;
}): WakeDecision {
  const mentioned = params.mentionState?.wasMentioned === true;
  const implicit = params.mentionState?.implicit === true;
  if (mentioned) return { wasMentioned: true, source: 'mention' };
  if (implicit) return { wasMentioned: true, source: 'quote-bot' };
  if (params.nameMentioned) return { wasMentioned: true, source: 'name-pattern' };
  return { wasMentioned: false, source: 'none' };
}

/**
 * 入站事件分类：room_event 还是 user_request。
 *
 * - 非群消息 → user_request
 * - 斜杠命令 → user_request（显式用户意图）
 * - 被叫醒（@ / 引用 / 称呼）→ user_request（保留正常回复权）
 * - 其余且群处于 room_event → room_event
 */
export function classifyInboundEventKind(params: {
  isGroup: boolean;
  /** 原始正文（斜杠命令判定） */
  rawBody: string;
  wake: WakeDecision;
  unmentionedInbound: UnmentionedInbound;
}): 'user_request' | 'room_event' {
  if (!params.isGroup) return 'user_request';
  if (params.unmentionedInbound !== 'room_event') return 'user_request';
  if (params.wake.wasMentioned) return 'user_request';
  if (/^\//.test(params.rawBody ?? '')) return 'user_request';
  return 'room_event';
}
