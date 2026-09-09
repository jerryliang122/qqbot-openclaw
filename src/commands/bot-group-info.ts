import type { SlashCommand, SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { resolveGroupConfigFromAccount } from '../config.js';
import { getGroupModeFacts } from '../features/group-mode-store.js';
import { getProactiveUsage } from '../features/proactive-budget.js';

/** /bot-group-info — 展示当前群的推送模式推断与生效配置（排障用） */
export function botGroupInfo(account: ResolvedQQBotAccount): SlashCommand {
  return {
    name: 'bot-group-info',
    description: '查看当前群的推送模式与生效配置',
    scope: 'group',
    usage: '/bot-group-info  在群内发送，查看该群的推送模式推断与生效配置',
    handler: async (ctx: SlashCommandHandlerContext) => {
      const groupOpenid = (ctx.message as { groupOpenid?: string }).groupOpenid;
      if (!groupOpenid) return '❌ 仅可在群聊中使用';

      const facts = getGroupModeFacts(account.accountId, groupOpenid);
      const cfg = resolveGroupConfigFromAccount(account, groupOpenid);
      const usage = getProactiveUsage(account.accountId);

      const modeLine = !facts
        ? '推送模式：尚未观测到事件（发一条群消息后可推断）'
        : facts.mode === 'full'
          ? '推送模式：**全量**（群主开启了"接收所有消息"，bot 收到群里每条消息）'
          : '推送模式：**AT 系**（仅被 @ 时收到消息；可能带最近 N 条上下文，也可能不带）';

      const contextLine = facts?.sawMsgElements
        ? '上下文证据：曾收到 msg_elements（最近消息记录/引用内容）'
        : '上下文证据：未收到过 msg_elements（纯 AT 模式或用户从未引用）';

      return [
        `🤖 群信息（${groupOpenid.slice(0, 8)}…）`,
        '',
        modeLine,
        contextLine,
        '',
        `requireMention：${cfg.requireMention ? '是（需 @ 才响应）' : '否（所有消息都响应）'}`,
        `未 @ 消息入站：${cfg.unmentionedInbound === 'room_event' ? '**room_event**（被动房间事件进框架，AI 只读、想发言走主动 message 工具）' : '拦截（只进历史，不上报）'}`,
        `排队策略：${cfg.coalesce.strategy === 'framework' ? `框架队列（${cfg.coalesce.enabled ? 'collect 合并批处理' : 'followup 排队不合并'}）` : '插件 coalescer（旧版行为）'}`,
        `历史缓存：${cfg.historyLimit} 条（0=禁用，模式 ${cfg.historyMode === 'rolling' ? 'rolling（bot 发言计入）' : 'clear（回复后清空）'}）`,
        `工具策略：${cfg.toolPolicy}`,
        '',
        `今日主动消息用量：${usage.count}/${usage.limit}（被动回复不计数；异常增长说明 msgid-cache 常过期或被动配额常耗尽）`,
      ].join('\n');
    },
  };
}
