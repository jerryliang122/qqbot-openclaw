import type { ResolvedQQBotAccount, QQBotAccountConfig, ToolPolicy, GroupConfig, GroupCoalesceConfig } from "./types.js";
import type { OpenClawConfig, GroupPolicy } from "openclaw/plugin-sdk";
import { loadCredentialBackup } from "./features/credential-backup.js";

// ============ Agent-aware mentionPatterns 解析 ============

type AgentEntry = { id?: string; groupChat?: { mentionPatterns?: string[]; historyLimit?: number } };

/**
 * 解析 mentionPatterns（agent → global → 空数组）
 *
 * 优先级：
 *   1. agents.list[agentId].groupChat.mentionPatterns
 *   2. messages.groupChat.mentionPatterns
 *   3. []
 */
export function resolveMentionPatterns(cfg: OpenClawConfig, agentId?: string): string[] {
  // 1. agent 级别
  if (agentId) {
    const agents = (cfg as Record<string, unknown>).agents as { list?: AgentEntry[] } | undefined;
    const entry = agents?.list?.find((a) => a.id?.trim().toLowerCase() === agentId.trim().toLowerCase());
    const agentGroupChat = entry?.groupChat;
    if (agentGroupChat && Object.hasOwn(agentGroupChat, "mentionPatterns")) {
      return agentGroupChat.mentionPatterns ?? [];
    }
  }
  // 2. 全局级别
  const globalGroupChat = (cfg as any)?.messages?.groupChat;
  if (globalGroupChat && typeof globalGroupChat === "object" && Object.hasOwn(globalGroupChat, "mentionPatterns")) {
    return (globalGroupChat as { mentionPatterns?: string[] }).mentionPatterns ?? [];
  }
  // 3. 空数组
  return [];
}

export const DEFAULT_ACCOUNT_ID = "default";

// 内联 evaluateMatchedGroupAccessForPolicy（openclaw dist 尚未导出，本地实现）

type MatchedGroupAccessReason = "allowed" | "disabled" | "missing_match_input" | "empty_allowlist" | "not_allowlisted";

interface MatchedGroupAccessDecision {
  allowed: boolean;
  groupPolicy: GroupPolicy;
  reason: MatchedGroupAccessReason;
}

function evaluateMatchedGroupAccessForPolicy(params: {
  groupPolicy: GroupPolicy;
  allowlistConfigured: boolean;
  allowlistMatched: boolean;
  requireMatchInput?: boolean;
  hasMatchInput?: boolean;
}): MatchedGroupAccessDecision {
  if (params.groupPolicy === "disabled") {
    return { allowed: false, groupPolicy: params.groupPolicy, reason: "disabled" };
  }
  if (params.groupPolicy === "allowlist") {
    if (params.requireMatchInput && !params.hasMatchInput) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "missing_match_input" };
    }
    if (!params.allowlistConfigured) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "empty_allowlist" };
    }
    if (!params.allowlistMatched) {
      return { allowed: false, groupPolicy: params.groupPolicy, reason: "not_allowlisted" };
    }
  }
  return { allowed: true, groupPolicy: params.groupPolicy, reason: "allowed" };
}

interface QQBotChannelConfig extends QQBotAccountConfig {
  /** HTTP/WebSocket User-Agent 追加后缀 */
  userAgentSuffix?: string;
  accounts?: Record<string, QQBotAccountConfig>;
}

// ============ 群消息策略 ============

const DEFAULT_GROUP_POLICY: GroupPolicy = "open";

/** 群历史缓存条数默认值 */
const DEFAULT_GROUP_HISTORY_LIMIT = 20;

/** 群消息合并默认配置 */
const DEFAULT_GROUP_COALESCE_CONFIG: Required<GroupCoalesceConfig> = {
  enabled: true,
};

const DEFAULT_GROUP_CONFIG: Omit<Required<GroupConfig>, "prompt" | "coalesce" | "historyMode" | "unmentionedInbound"> & { coalesce: Required<GroupCoalesceConfig>; historyMode: 'clear' | 'rolling'; unmentionedInbound: 'user_request' | 'room_event' } = {
  requireMention: true,
  ignoreOtherMentions: false,
  toolPolicy: "restricted",
  name: "",
  historyLimit: DEFAULT_GROUP_HISTORY_LIMIT,
  historyMode: "clear",
  unmentionedInbound: "user_request",
  coalesce: DEFAULT_GROUP_COALESCE_CONFIG,
};

/** 默认群消息行为 PE（可通过配置覆盖） */
const DEFAULT_GROUP_PROMPT = [
  "若发送者为机器人，仅在对方明确@你提问或请求协助具体任务时，以简洁明了的内容回复，",
  "避免与其他机器人产生抢答或多轮无意义对话。",
  "在群聊中优先让人类用户的消息得到响应，机器人之间保持协作而非竞争，确保对话有序不刷屏。",
].join("");

/** 解析群消息策略 */
export function resolveGroupPolicy(cfg: OpenClawConfig, accountId?: string): GroupPolicy {
  const account = resolveQQBotAccount(cfg, accountId);
  return account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
}

/** 解析群白名单（统一转大写） */
export function resolveGroupAllowFrom(cfg: OpenClawConfig, accountId?: string): string[] {
  const account = resolveQQBotAccount(cfg, accountId);
  return (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
}

/** 检查指定群是否被允许（使用标准策略引擎） */
export function isGroupAllowed(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  const account = resolveQQBotAccount(cfg, accountId);
  const policy = account.config?.groupPolicy ?? DEFAULT_GROUP_POLICY;
  const allowList = (account.config?.groupAllowFrom ?? []).map((id) => String(id).trim().toUpperCase());
  const allowlistConfigured = allowList.length > 0;
  const allowlistMatched = allowList.some((id) => id === "*" || id === groupOpenid.toUpperCase());

  return evaluateMatchedGroupAccessForPolicy({
    groupPolicy: policy,
    allowlistConfigured,
    allowlistMatched,
  }).allowed;
}

export type ResolvedGroupConfig = Omit<Required<GroupConfig>, "prompt" | "coalesce" | "historyMode" | "unmentionedInbound"> & {
  prompt: string;
  coalesce: Required<GroupCoalesceConfig>;
  historyMode: 'clear' | 'rolling';
  unmentionedInbound: 'user_request' | 'room_event';
};

export function resolveGroupConfigFromAccount(account: ResolvedQQBotAccount, groupOpenid: string): ResolvedGroupConfig {
  const groups = account.config?.groups ?? {};
  const wildcardCfg = groups["*"] ?? {};
  const specificCfg = groups[groupOpenid] ?? {};
  const accountDefaultRequireMention = account.config?.defaultRequireMention ?? DEFAULT_GROUP_CONFIG.requireMention;
  const accountDefaultCoalesce = account.config?.groupCoalesce ?? DEFAULT_GROUP_COALESCE_CONFIG;

  const coalesce = {
    enabled: specificCfg.coalesce?.enabled ?? wildcardCfg.coalesce?.enabled ?? accountDefaultCoalesce.enabled ?? DEFAULT_GROUP_COALESCE_CONFIG.enabled,
  };

  return {
    requireMention: specificCfg.requireMention ?? wildcardCfg.requireMention ?? accountDefaultRequireMention,
    ignoreOtherMentions: specificCfg.ignoreOtherMentions ?? wildcardCfg.ignoreOtherMentions ?? DEFAULT_GROUP_CONFIG.ignoreOtherMentions,
    toolPolicy: specificCfg.toolPolicy ?? wildcardCfg.toolPolicy ?? DEFAULT_GROUP_CONFIG.toolPolicy,
    name: specificCfg.name ?? wildcardCfg.name ?? DEFAULT_GROUP_CONFIG.name,
    prompt: specificCfg.prompt ?? wildcardCfg.prompt ?? DEFAULT_GROUP_PROMPT,
    historyLimit: specificCfg.historyLimit ?? wildcardCfg.historyLimit ?? DEFAULT_GROUP_CONFIG.historyLimit,
    historyMode: specificCfg.historyMode ?? wildcardCfg.historyMode ?? DEFAULT_GROUP_CONFIG.historyMode,
    unmentionedInbound: specificCfg.unmentionedInbound ?? wildcardCfg.unmentionedInbound ?? DEFAULT_GROUP_CONFIG.unmentionedInbound,
    coalesce,
  };
}

export function resolveGroupConfig(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ResolvedGroupConfig {
  return resolveGroupConfigFromAccount(resolveQQBotAccount(cfg, accountId), groupOpenid);
}

/** 解析群历史消息缓存条数 */
export function resolveHistoryLimit(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): number {
  return Math.max(0, resolveGroupConfig(cfg, groupOpenid, accountId).historyLimit);
}

/** 解析群行为 PE（具体群 > "*" > 默认值） */
export function resolveGroupPrompt(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): string {
  return resolveGroupConfig(cfg, groupOpenid, accountId).prompt;
}

/** 解析群是否需要 @机器人才响应 */
export function resolveRequireMention(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).requireMention;
}

/** 解析群是否忽略 @了其他人（非 bot）的消息 */
export function resolveIgnoreOtherMentions(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupConfig(cfg, groupOpenid, accountId).ignoreOtherMentions;
}

/** 解析群工具策略 */
export function resolveToolPolicy(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): ToolPolicy {
  return resolveGroupConfig(cfg, groupOpenid, accountId).toolPolicy;
}

/** 解析群名称（优先配置，fallback 为 openid 前 8 位） */
export function resolveGroupName(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): string {
  const name = resolveGroupConfig(cfg, groupOpenid, accountId).name;
  return name || groupOpenid.slice(0, 8);
}

/**
 * 解析 User-Agent 追加后缀（仅通道级：channels.qqbot.userAgentSuffix）
 */
export function resolveUserAgentSuffix(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  return qqbot?.userAgentSuffix ? String(qqbot.userAgentSuffix).trim() : "";
}

function normalizeAppId(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw).trim();
}

function firstNonEmptyEnv(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return "";
}

/** 文档变量名优先，同时兼容旧的下划线变量名。 */
export function resolveQQBotEnvAppId(): string {
  return firstNonEmptyEnv(process.env.QQBOT_APPID);
}

export function resolveQQBotEnvClientSecret(): string {
  return firstNonEmptyEnv(process.env.QQBOT_SECRET);
}

/**
 * 列出所有 QQBot 账户 ID
 */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>();
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  if (qqbot?.appId || resolveQQBotEnvAppId()) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }

  if (qqbot?.accounts) {
    for (const accountId of Object.keys(qqbot.accounts)) {
      if (qqbot.accounts[accountId]?.appId) {
        ids.add(accountId);
      }
    }
  }

  return Array.from(ids);
}

/**
 * 判断一个账号形状是否「可运行」：未被禁用，且要么配置内完整（appId + 任一
 * 凭证来源），要么存在凭证暂存备份（lifecycle 启动时会用备份同时恢复 appId
 * 与 secret——配置里缺 appId 不代表账号起不来）。
 *
 * 用于默认账号解析——只看 appId 是否存在会把已登出（secret 被删、appId 残留）
 * 或停用的顶层账号当成默认账号，导致 message 工具等框架侧主动发送解析到
 * 一个永远不会启动的账号（issue #15：Bot "default" not running）。
 */
function accountShapeRunnable(params: {
  appId: string;
  enabled: boolean;
  hasSecretSource: boolean;
  accountId: string;
}): boolean {
  if (!params.enabled) return false;
  if (params.appId && params.hasSecretSource) return true;
  // 凭证备份可恢复（带回 appId + secret），配置缺 appId/secret 也算可运行
  try {
    return loadCredentialBackup(params.accountId) !== null;
  } catch {
    return false;
  }
}

/**
 * 获取默认账户 ID
 *
 * 优先返回「可运行」的账号：
 *   1. 顶层 default 账号可运行（appId + 凭证来源 + enabled）→ default
 *   2. 否则第一个可运行的命名账号（accounts.<id>）
 *   3. 都不可运行 → 保持旧行为返回 default（错误信息指向配置根因）
 */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 1. 如果默认账户可运行，返回 default
  if (qqbot?.appId || resolveQQBotEnvAppId()) {
    const runnable = accountShapeRunnable({
      appId: normalizeAppId(qqbot?.appId) || normalizeAppId(resolveQQBotEnvAppId()),
      enabled: qqbot?.enabled !== false,
      hasSecretSource: Boolean(
        qqbot?.clientSecret
        || qqbot?.clientSecretFile
        || resolveQQBotEnvClientSecret(),
      ),
      accountId: DEFAULT_ACCOUNT_ID,
    });
    if (runnable) return DEFAULT_ACCOUNT_ID;
  }

  // 2. 否则返回第一个可运行的命名账户
  if (qqbot?.accounts) {
    for (const [accountId, account] of Object.entries(qqbot.accounts)) {
      if (!account) continue;
      const runnable = accountShapeRunnable({
        appId: normalizeAppId(account.appId),
        enabled: account.enabled !== false,
        hasSecretSource: Boolean(account.clientSecret || account.clientSecretFile),
        accountId,
      });
      if (runnable) return accountId;
    }
    // 兼容旧形态：命名账号均无 appId（凭 backup 恢复）时保持原顺序返回第一个
    const ids = Object.keys(qqbot.accounts);
    if (ids.length > 0 && ids.every((id) => !qqbot.accounts?.[id]?.appId)) {
      return ids[0];
    }
  }

  // 3. 旧回退
  return DEFAULT_ACCOUNT_ID;
}

/**
 * 解析 QQBot 账户配置
 */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null
): ResolvedQQBotAccount {
  const resolvedAccountId = accountId ?? resolveDefaultQQBotAccountId(cfg);
  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;

  // 基础配置
  let accountConfig: QQBotAccountConfig = {};
  let appId = "";
  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  if (resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    // 默认账户从顶层读取（展开所有字段，避免遗漏新增配置项）
    const { accounts: _accounts, ...topLevelConfig } = qqbot ?? {} as QQBotChannelConfig;
    accountConfig = {
      ...topLevelConfig,
      markdownSupport: qqbot?.markdownSupport ?? true,
    };
    appId = normalizeAppId(qqbot?.appId);
  } else {
    // 命名账户从 accounts 读取
    const account = qqbot?.accounts?.[resolvedAccountId];
    accountConfig = account ?? {};
    appId = normalizeAppId(account?.appId);
  }

  // 解析 clientSecret
  if (accountConfig.clientSecret) {
    clientSecret = accountConfig.clientSecret;
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    // 从文件读取（运行时处理）
    secretSource = "file";
  } else if (resolvedAccountId === DEFAULT_ACCOUNT_ID && resolveQQBotEnvClientSecret()) {
    clientSecret = resolveQQBotEnvClientSecret();
    secretSource = "env";
  }

  // AppId 也可以从环境变量读取
  if (!appId && resolvedAccountId === DEFAULT_ACCOUNT_ID) {
    appId = normalizeAppId(resolveQQBotEnvAppId());
  }

  return {
    accountId: resolvedAccountId,
    name: accountConfig.name,
    enabled: accountConfig.enabled !== false,
    appId,
    clientSecret,
    secretSource,
    systemPrompt: accountConfig.systemPrompt,
    markdownSupport: accountConfig.markdownSupport !== false,
    commandPanelNative: accountConfig.commands?.native !== false,
    userAgentSuffix: resolveUserAgentSuffix(cfg),
    config: accountConfig,
  };
}

/**
 * 应用账户配置
 */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: { appId?: string; clientSecret?: string; clientSecretFile?: string; name?: string }
): OpenClawConfig {
  const next = { ...cfg };

  if (accountId === DEFAULT_ACCOUNT_ID) {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingConfig = (next.channels?.qqbot as QQBotChannelConfig) || {};
    const allowFrom = existingConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        allowFrom,
        ...(input.appId ? { appId: input.appId } : {}),
        ...(input.clientSecret
          ? { clientSecret: input.clientSecret }
          : input.clientSecretFile
            ? { clientSecretFile: input.clientSecretFile }
            : {}),
        ...(input.name ? { name: input.name } : {}),
      },
    };
  } else {
    // 如果没有设置过 allowFrom，默认设置为 ["*"]
    const existingAccountConfig = (next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {};
    const allowFrom = existingAccountConfig.allowFrom ?? ["*"];
    
    next.channels = {
      ...next.channels,
      qqbot: {
        ...(next.channels?.qqbot as Record<string, unknown> || {}),
        enabled: true,
        accounts: {
          ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts || {}),
          [accountId]: {
            ...((next.channels?.qqbot as QQBotChannelConfig)?.accounts?.[accountId] || {}),
            enabled: true,
            allowFrom,
            ...(input.appId ? { appId: input.appId } : {}),
            ...(input.clientSecret
              ? { clientSecret: input.clientSecret }
              : input.clientSecretFile
                ? { clientSecretFile: input.clientSecretFile }
                : {}),
            ...(input.name ? { name: input.name } : {}),
          },
        },
      },
    };
  }

  return next;
}

/** 解析群消息合并配置 */
export function resolveGroupCoalesceConfig(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): Required<GroupCoalesceConfig> {
  return resolveGroupConfig(cfg, groupOpenid, accountId).coalesce;
}

/** 解析群消息合并是否启用 */
export function resolveGroupCoalesceEnabled(cfg: OpenClawConfig, groupOpenid: string, accountId?: string): boolean {
  return resolveGroupCoalesceConfig(cfg, groupOpenid, accountId).enabled;
}
