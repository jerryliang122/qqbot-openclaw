/**
 * QQ Bot ChannelPlugin 定义
 *
 * 使用 createChatChannelPlugin 构建标准插件
 */

import { createChatChannelPlugin } from 'openclaw/plugin-sdk/channel-core';
import { DEFAULT_ACCOUNT_ID } from 'openclaw/plugin-sdk/account-id';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { ResolvedQQBotAccount } from './types.js';
import {
  setAccountEnabledInConfigSection,
  deleteAccountFromConfigSection,
  applyAccountNameToChannelSection,
} from 'openclaw/plugin-sdk/core';
import {
  listQQBotAccountIds,
  resolveQQBotAccount,
  resolveDefaultQQBotAccountId,
  resolveRequireMention,
  resolveGroupConfig,
  resolveGroupToolPolicyConfig,
  applyQQBotAccountConfig,
  inspectQQBotAccount,
} from './config.js';
import { loadCredentialBackup } from './features/credential-backup.js';
import { qqbotSetupWizard } from './setup/surface.js';
import { qqbotLogin } from './setup/login.js';
import { createQQBotPluginBase } from './plugin-base.js';
import { qqbotMessageAdapter } from './message-adapter.js';
import { qqbotMessagingAdapter } from './messaging-adapter.js';
import { qqbotStatusAdapter } from './status-adapter.js';
import { qqbotGatewayAdapter } from './gateway-adapter.js';
import { qqbotChannelOutbound } from './outbound-adapter.js';
import { qqbotHeartbeatAdapter } from './heartbeat-adapter.js';
import { qqbotAgentPromptAdapter } from './agent-prompt-adapter.js';
import { getQQBotApprovalCapability } from './features/approval-capability.js';
import { stripMentionText } from './utils/mention.js';

/**
 * QQBot Threading Adapter
 *
 * QQBot 无 thread/topic（replyToMode 恒 off），但 buildToolContext **不能**
 * 返回 undefined：框架在 message_tool_only（room_event）模式下，靠它提供的
 * currentChannelId/currentMessagingTarget 解析 message 工具的隐式当前来源
 * 路由——缺失时发送会落入 internal-ui sink（只进 openclaw 会话记录/WebUI，
 * QQ 侧无消息、无出站 HTTP 请求；2026-09-09 用户反馈事故）。context.To 即
 * 限定可路由目标（qqbot:group:{gid} / qqbot:c2c:{openid}），直接透传即可。
 */
export const qqbotThreadingAdapter = {
  resolveReplyToMode: () => 'off' as const,
  buildToolContext: ({ context }: {
    context: { To?: string; From?: string; ChatType?: string };
  }) => {
    const target = context.To || context.From;
    if (!target) return undefined;
    return {
      currentChannelId: target,
      currentMessagingTarget: target,
      ...(context.ChatType === 'group' || context.ChatType === 'direct'
        ? { currentChatType: context.ChatType as 'group' | 'direct' }
        : {}),
      replyToMode: 'off' as const,
    };
  },
  resolveAutoThreadId: () => undefined,
};

/**
 * restricted 群的工具白名单与工具策略解析已移到 `config.ts`
 * （`RESTRICTED_DEFAULT_TOOLS` / `resolveGroupToolPolicyConfig`）。
 *
 * 移走的原因：room_event 的 message 工具守卫必须与本 adapter 算出**同一份**
 * 工具策略——两边结果不一致就会出现"框架允许发消息、插件却判定不能发"
 * （或反之）的错配。
 *
 * ⚠️ 红线（2026-10-06 线上事故，openclaw 9.5→9.7 升级后复发）：
 * 2026.9.6+ 框架会把 groups.resolveToolPolicy 的返回值作为会话工具策略真正
 * 应用到 run 的工具集——`{ allow: [] }`（空允许清单）= 什么都不允许，连
 * message 工具都会被过滤掉。room_event 群的最终文本被结构性压制
 * （message_tool_only），发言必须走 message 工具——工具没了 = 群彻底沉默。
 * 旧框架（≤9.5）不把该返回值应用到 run 工具集，所以旧的
 * `restricted → { allow: [] }` 映射当时无害、升级后致命。
 *
 * 现行语义（对齐最新 telegram 的群聊处理：群聊不收紧 conversation 级策略，
 * 群限制交给配置显式声明）：
 * - full → undefined（完全交给 agent 自身 tools.profile）
 * - restricted → 安全白名单（信息类/会话类工具；**必须含 message**；
 *   不含 exec/process/文件写入/控制面/平台写操作——qqbot_platform_api
 *   支持任意 method+path 的平台写请求，提示词诱导即可变更/删除平台资源，
 *   不得进 restricted 白名单）
 * - none → { allow: [], deny: ['*'] }（管理员显式全禁，保持原义）
 */

/**
 * QQBot Groups Adapter
 */
export const qqbotGroupsAdapter = {
  resolveRequireMention: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    return resolveRequireMention(cfg, groupId, accountId ?? undefined);
  },

  resolveToolPolicy: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    // 统一走 config.ts 的共享解析（与 room_event 的 message 工具守卫同源）：
    // 用户显式配置的 groups.<id>.tools 原样透传；未声明时按 toolPolicy 兜底。
    return resolveGroupToolPolicyConfig(cfg, accountId ?? undefined, groupId);
  },

  resolveGroupIntroHint: ({ cfg, accountId, groupId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
  }) => {
    if (!groupId) return undefined;
    const groupCfg = resolveGroupConfig(cfg, groupId, accountId ?? undefined);
    return groupCfg.name ? `当前群: ${groupCfg.name}` : undefined;
  },
};

/**
 * QQBot Mentions Adapter
 */
const qqbotMentionsAdapter = {
  stripMentions: ({ text, ctx }: { text: string; ctx: unknown }) => {
    const mentions = (ctx as any)?.mentions;
    return stripMentionText(text, mentions);
  },
};

/**
 * QQBot Setup Adapter
 */
const qqbotSetupAdapter = {
  resolveAccountId: ({ accountId }: { cfg: OpenClawConfig; accountId?: string }) =>
    accountId?.trim().toLowerCase() || DEFAULT_ACCOUNT_ID,
  applyAccountName: ({ cfg, accountId, name }: {
    cfg: OpenClawConfig;
    accountId: string;
    name?: string;
  }) =>
    applyAccountNameToChannelSection({ cfg, channelKey: 'qqbot', accountId, name }),
  validateInput: ({ input }: {
    cfg: OpenClawConfig;
    accountId: string;
    input: { token?: string; tokenFile?: string; useEnv?: boolean };
  }) => {
    if (!input.token && !input.tokenFile && !input.useEnv) {
      return 'QQBot requires --token (format: appId:clientSecret) or --use-env';
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }: {
    cfg: OpenClawConfig;
    accountId: string;
    input: { token?: string; tokenFile?: string; name?: string; useEnv?: boolean };
  }) => {
    let appId = '';
    let clientSecret = '';
    if (input.token) {
      const parts = input.token.split(':');
      if (parts.length === 2) { appId = parts[0]; clientSecret = parts[1]; }
    }
    return applyQQBotAccountConfig(cfg, accountId, {
      appId, clientSecret,
      clientSecretFile: input.tokenFile,
      name: input.name,
    }) as OpenClawConfig;
  },
};

/**
 * QQBot Config Adapter
 */
const qqbotConfigAdapter = {
  listAccountIds: (cfg: OpenClawConfig) => listQQBotAccountIds(cfg),
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveQQBotAccount(cfg, accountId),
  defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultQQBotAccountId(cfg),
  // 只读巡检：供 `openclaw status` / `openclaw channels status` / doctor 等
  // 只读命令路径使用——不 materialize 运行期凭据（不做 token 交换、不触发扫码），
  // 缺凭据时如实上报状态而不是抛错。10.5 官方推荐的只读巡检面。
  inspectAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    inspectQQBotAccount(cfg, accountId),
  isConfigured: (account: ResolvedQQBotAccount, _cfg: OpenClawConfig) => {
    if (account?.appId && account?.clientSecret) return true;
    // 凭据文件：文件在账号启动时读一次，此处不读盘但配置来源已就位 → 视为已配置
    if (account?.appId && account?.secretSource === 'file' && account?.clientSecretFile) return true;
    return loadCredentialBackup(account?.accountId) !== null;
  },
  describeAccount: (account: ResolvedQQBotAccount, _cfg: OpenClawConfig) => ({
    accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
    name: account?.name,
    enabled: account?.enabled ?? false,
    configured: Boolean(
      account?.appId
      && (account?.clientSecret || (account?.secretSource === 'file' && account?.clientSecretFile)),
    ),
    tokenSource: account?.secretSource,
    appIdSource: account?.appIdSource,
  }),
  setAccountEnabled: ({ cfg, accountId, enabled }: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) =>
    setAccountEnabledInConfigSection({
      cfg, sectionKey: 'qqbot', accountId, enabled, allowTopLevel: true
    }),
  deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
    deleteAccountFromConfigSection({
      cfg, sectionKey: 'qqbot', accountId,
      clearBaseFields: ['appId', 'clientSecret', 'clientSecretFile', 'name'],
    }),
  resolveAllowFrom: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string | null }) => {
    const account = resolveQQBotAccount(cfg, accountId ?? undefined);
    return (account.config?.allowFrom ?? []).map((e: string | number) => String(e)) as (string | number)[];
  },
  formatAllowFrom: ({ cfg, allowFrom }: { cfg: OpenClawConfig; allowFrom: (string | number)[] }) =>
    allowFrom
      .map((e: string | number) => String(e).trim())
      .filter(Boolean)
      .map((e: string) => e.replace(/^qqbot:/i, '').toUpperCase()),
};

/**
 * QQBot Channel Plugin
 */
export const qqbotPlugin = createChatChannelPlugin({
  base: {
    ...createQQBotPluginBase(),

    config: qqbotConfigAdapter,

    message: qqbotMessageAdapter,
    messaging: qqbotMessagingAdapter,
    status: qqbotStatusAdapter,
    gateway: qqbotGatewayAdapter,
    outbound: qqbotChannelOutbound,

    agentPrompt: qqbotAgentPromptAdapter,
    heartbeat: qqbotHeartbeatAdapter,
    threading: qqbotThreadingAdapter,
    groups: qqbotGroupsAdapter,
    mentions: qqbotMentionsAdapter,

    setup: qqbotSetupAdapter,
    // setupWizard 类型断言：ChannelSetupWizard 与框架期望的接口存在差异
    // 主要差异在于 credentials 字段的结构，运行时行为正确
    setupWizard: qqbotSetupWizard as unknown as Parameters<typeof createChatChannelPlugin>[0]['base']['setupWizard'],
    // auth.login 类型断言：框架接口可能不包含 login 字段
    // 运行时行为正确，类型断言确保类型安全
    auth: { login: qqbotLogin as unknown as NonNullable<Parameters<typeof createChatChannelPlugin>[0]['base']['auth']>['login'] },

    approvalCapability: getQQBotApprovalCapability(),
  },
});
