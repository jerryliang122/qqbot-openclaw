/**
 * 动态策略注入中间件
 *
 * 每条消息到达时，按 groupId 解析群配置并注入 `ctx.state.policy`。
 * SDK 内置中间件（mentionGate、historyBuffer 等）自动从 `ctx.state.policy`
 * 读取动态策略作为 fallback，无需各自注册 `resolveConfig`。
 *
 * 优先级链（与旧版一致）：
 *   具体群配置 > 通配符 "*" > defaultRequireMention > 硬编码默认值
 *
 * ## room_event（被动房间事件）
 *
 * 本中间件同时是**入站策略的唯一裁决点**：门控（requireMention）放不放行
 * 未被 @ 的消息，必须与 dispatch 侧的入站分类同源——两者若各算各的，
 * 会出现「门控放行 → 分类成 user_request → bot 把群里每条消息都回一遍」
 * 的刷屏，或反向的「门控拦掉 → room_event 永远收不到消息」。
 *
 * 因此这里算出的完整策略挂在 `ctx.state.roomEventPolicy` 上，dispatch 与
 * body 组装直接复用（见 features/room-event.ts）。
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { resolveGroupConfigFromAccount } from '../config.js';
import { resolveGroupRoomEventPolicy, type RoomEventPolicy } from '../features/room-event.js';

export interface PolicyInjectorOptions {
  /** 获取 runtime（用于读配置快照与解析 agent 路由） */
  getRuntime?: () => any;
}

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
 *     unmentionedInbound: "user_request" | "room_event",
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
export function createPolicyInjector(
  account: ResolvedQQBotAccount,
  opts: PolicyInjectorOptions = {},
): Middleware {
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

      // 入站策略裁决（群级 > per-agent > 全局 > 默认）+ message 工具守卫
      const resolved = resolveGroupRoomEventPolicy(account, groupOpenid, opts.getRuntime);

      // room_event 群：门控放行全部消息（mentionGate 以 requireMention=false
      // 通过并保留 wasMentioned 标记），未被 @/称呼/引用的消息在 dispatch 侧
      // 分类为 room_event 被动房间事件（仅全量模式群实际会有这类消息到达）
      const roomEvent = resolved.policy.effectiveMode === 'room_event';

      policy.group = {
        requireMention: roomEvent ? false : groupCfg.requireMention,
        ignoreOtherMentions: groupCfg.ignoreOtherMentions,
        historyLimit: groupCfg.historyLimit,
        prompt: groupCfg.prompt,
        unmentionedInbound: resolved.policy.effectiveMode,
      };

      // 完整策略挂到 state：dispatch / body 组装复用同一份裁决结果，
      // 避免热重载窗口内两处算出不同结论
      (ctx.state as Record<string, unknown>).roomEventPolicy = {
        ...resolved.policy,
        agentId: resolved.agentId,
        groupOpenid,
      };
      // 称呼唤醒用的 mentionPatterns 一并解析好：门控与入站分类共用同一份，
      // 避免两处各读一次配置、各自解析一次（per-agent 覆盖必须一致）
      (ctx.state as Record<string, unknown>).mentionPatterns = resolved.mentionPatterns;
    }

    ctx.state.policy = policy;
    await next();
  };
}
