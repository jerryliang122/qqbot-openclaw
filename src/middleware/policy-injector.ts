/**
 * 动态策略注入中间件
 *
 * 每条消息到达时，按 groupId 解析群配置并注入 `ctx.state.policy`。
 * SDK 内置中间件（mentionGate、historyBuffer 等）自动从 `ctx.state.policy`
 * 读取动态策略作为 fallback，无需各自注册 `resolveConfig`。
 *
 * 优先级链（与旧版一致）：
 *   具体群配置 > 通配符 "*" > defaultRequireMention > 硬编码默认值
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { resolveGroupConfigFromAccount } from '../config.js';

/**
 * 创建 policy injector 中间件。
 *
 * 注入的 `ctx.state.policy` 结构：
 * ```
 * {
 *   scope: "c2c" | "group",
 *   group: {
 *     requireMention: boolean,
 *     ignoreOtherMentions: boolean,
 *     historyLimit: number,
 *     // ... 可扩展任意字段
 *   }
 * }
 * ```
 *
 * 使用者可在 `policy.group` 上添加自定义字段，如：
 * ```
 * ctx.state.policy.toolPolicy = "full";
 * ```
 * 自定义中间件通过 `ctx.state.policy` 读取即可。
 */
export function createPolicyInjector(account: ResolvedQQBotAccount): Middleware {
  return async (ctx, next) => {
    const msg = ctx.message as any;
    const scope = msg.kind as 'c2c' | 'group' | 'dm' | 'channel';

    const policy: Record<string, unknown> = {
      scope,
      accountId: account.accountId,
      // 访问控制：dmPolicy（c2c） / groupPolicy（group），默认 allowlist
      c2cMode: account.config?.dmPolicy ?? 'allowlist',
      groupMode: account.config?.groupPolicy ?? 'allowlist',
      allowFrom: account.config?.allowFrom ?? [],
      groupAllowFrom: account.config?.groupAllowFrom ?? [],
    };

    if (scope === 'group') {
      const groupOpenid = msg.groupOpenid ?? '';
      const groupCfg = resolveGroupConfigFromAccount(account, groupOpenid);
      // room_event 群：门控放行全部消息（mentionGate 以 requireMention=false
      // 通过并保留 wasMentioned 标记），未 @/称呼/引用的消息在 dispatch 侧
      // 分类为 room_event 被动房间事件（仅全量模式群实际会有这类消息到达）
      const roomEvent = groupCfg.unmentionedInbound === 'room_event';
      policy.group = {
        requireMention: roomEvent ? false : groupCfg.requireMention,
        ignoreOtherMentions: groupCfg.ignoreOtherMentions,
        historyLimit: groupCfg.historyLimit,
        prompt: groupCfg.prompt,
        unmentionedInbound: groupCfg.unmentionedInbound,
      };
    }

    ctx.state.policy = policy;
    await next();
  };
}
