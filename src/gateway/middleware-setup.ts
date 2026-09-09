/**
 * SDK 中间件编排
 *
 * 根据账户配置组装 SDK 内置中间件链。
 * 中间件负责过滤和上下文富化。
 * 
 * 并发控制说明（群聊/私聊差异化）：
 * - 群聊：使用消息合并中间件，所有消息都应该被处理，快速消息应该被合并
 * - 私聊：依赖 OpenClaw 框架的 session lane 机制，用户可以"插嘴"（新消息取消旧消息）
 * - 这样与 Telegram 等其他 channel 保持一致
 */
import type { QQBot, MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  messageFilter,
  contentSanitizer,
  rateLimiter,
  mentionGate,
  quoteRef,
  historyBuffer,
  envelopeFormatter,
  slashCommand,
  errorHandler,
} from '@tencent-connect/qqbot-nodejs';
import type { ResolvedQQBotAccount } from '../types.js';
import { buildCommandList } from '../commands/index.js';
import { attachmentProcessor } from '../middleware/attachment.js';
import { assembleBody } from '../dispatch/body-assembler.js';
import { getPersistedRefIndexStore } from '../features/ref-index-store.js';
import { createPolicyInjector } from '../middleware/policy-injector.js';
import { getHistoryStore, historyGroupKey } from '../features/history-store.js';
import { dynamicAccessControl } from '../middleware/access-control.js';
import { inboundGuard } from '../middleware/inbound-guard.js';
import { secretCapture } from '../middleware/secret-capture.js';
import { c2cTypingIndicator } from '../middleware/typing.js';
import { stripMentionText } from '../utils/mention.js';
import { groupMessageCoalescer } from '../features/message-coalescer.js';
import { resolveGroupConfigFromAccount } from '../config.js';

export interface MiddlewareSetupOptions {
  /** 获取 runtime */
  getRuntime: () => any;
}

/**
 * 为 QQBot 实例编排完整的中间件链
 */
export function setupMiddlewares(bot: QQBot, account: ResolvedQQBotAccount, opts: MiddlewareSetupOptions): void {
  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  //    skipSelfEcho 必须开启：SDK 注明 QQ 会把 bot 自身出站消息回投为入站
  //    事件（群聊尤其常见，按 author.bot 识别）；私聊回声无该标记，
  //    由 inboundGuard 的出站 id 比对兜底
  bot.use(messageFilter({ skipSelfEcho: true }));

  // 2.5 入站事件守卫：出站回声（c2c）+ 重复推送长窗口去重 + 空内容事件
  //     三个检查都打 INFO 日志留痕；详见 src/middleware/inbound-guard.ts
  bot.use(inboundGuard({ accountId: account.accountId }));

  // 3. 动态策略注入 — 每条消息注入 ctx.state.policy
  //    后续 dynamicAccessControl / mentionGate / historyBuffer 自动读取
  bot.use(createPolicyInjector(account));

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  //    limit 从 ctx.state.policy.group.historyLimit 读取，key 带 accountId 前缀隔离多账号；
  //    room_event 群返回 undefined 跳过记录——该模式下每条消息已作为入站事件
  //    进框架持久化 transcript，插件历史快照会造成双份上下文
  bot.use(historyBuffer({
    store: getHistoryStore(),
    groupKey: (ctx) => {
      const gid = ctx.message.groupOpenid;
      if (ctx.message.kind !== 'group' || !gid) return undefined;
      if (resolveGroupConfigFromAccount(account, gid).unmentionedInbound === 'room_event') {
        return undefined;
      }
      return historyGroupKey(account.accountId, gid);
    },
  }));

  // 5. 动态访问控制 — 从 ctx.state.policy 动态读取，支持 pairing
  bot.use(dynamicAccessControl({
    accountId: account.accountId,
    getRuntime: opts.getRuntime,
  }));

  // 6. 群聊 @bot 门控（从 ctx.state.policy.group 读取动态配置）
  //    isImplicitMention：引用 bot 出站消息 = 隐式被点名（对齐 telegram
  //    reply-to-bot 语义）。ref-index get 为同步内存查询，可直接放同步回调；
  //    仅全量模式（GROUP_MESSAGE_CREATE）下未 @ 消息才可能带引用进到这里。
  bot.use(mentionGate({
      isImplicitMention: (ctx) => {
        const msg = ctx.message as { refMsgIdx?: string };
        if (!msg?.refMsgIdx) return false;
        try {
          const entry = getPersistedRefIndexStore(account.accountId).get(msg.refMsgIdx) as
            | { isBot?: boolean }
            | undefined;
          return entry?.isBot === true;
        } catch (err) {
          ctx.log.debug?.(`[mention] implicit quote-bot check failed: ${err instanceof Error ? err.message : String(err)}`);
          return false;
        }
      },
    }));
  // 7. 内容清洗（去 @marker、表情标签、多余空白）
  // SDK 用 appId 匹配 @标记，但 QQ openid 不等于 appId，追加 stripMentionText 正确剥离
  bot.use(contentSanitizer({
    parseFaceTags: true,
    transform: (content, ctx) => stripMentionText(content, (ctx.message as any).mentions),
  }));

  // 8. 三层限流（sender / group / global）
  //    默认启用保守阈值（20/min、60/min、300/min），正常使用不会触发；
  //    触发即 INFO 留痕（不自动回复，避免烧被动配额/刷屏）。账号级
  //    channels.qqbot.rateLimit 可覆盖或 {enabled:false} 关闭。
  {
    const rl = account.config.rateLimit ?? {};
    if (rl.enabled !== false) {
      bot.use(rateLimiter({
        perSender: rl.perSender ?? { max: 20, windowMs: 60_000 },
        perGroup: rl.perGroup ?? { max: 60, windowMs: 60_000 },
        global: rl.global ?? { max: 300, windowMs: 60_000 },
        onLimit: (ctx, tier) => {
          ctx.log.info?.(
            `[rate-limit] dropped (${tier}) sender=${(ctx.message as any).senderId ?? '-'} group=${(ctx.message as any).groupOpenid ?? '-'}`,
          );
        },
      }));
    }
  }

  // 9. 斜杠命令（命令匹配后直接 reply + stop）
  //    依赖：ctx.state.policy（policyInjector, #3）、ctx.message.*（原始消息）
  const slash = slashCommand({ commands: buildCommandList(account, { getRuntime: opts.getRuntime }) });
  bot.use(slash.middleware);

  // 9.5 密钥捕获 — pending 密钥输入时拦截该 c2c 用户的下一条文本消息，
  //     就地执行 openclaw secrets store set 并直接回执，消息不进框架
  //     （密钥绝不进入 AI 转录）。放在斜杠命令之后：/bot-* 优先可用；
  //     拦截后不再触发 typing / envelope；多问题 ask_user 答案消息红线放行
  bot.use(secretCapture({ accountId: account.accountId }));

  // 10. 群聊消息排队
  //     - strategy=framework（默认）：本中间件整段跳过，消息逐条立即 dispatch，
  //       排队/合并交给框架 followup 队列（dispatch 侧传 queueModeOverride）
  //     - strategy=plugin：插件内建 busy-buffering coalescer（旧版行为，回退用）
  //     - 配置从 ctx.state.policy.group 读取（由 policyInjector 注入）
  bot.use(groupMessageCoalescer({
      accountId: account.accountId,
      isEnabled: (ctx) => {
        const groupOpenid = ctx.message.groupOpenid;
        if (!groupOpenid) return false;
        const coalesce = resolveGroupConfigFromAccount(account, groupOpenid).coalesce;
        return coalesce.strategy === "plugin" && coalesce.enabled;
      },
      maxBuffer: (ctx) => {
        const groupOpenid = ctx.message.groupOpenid;
        return groupOpenid
          ? resolveGroupConfigFromAccount(account, groupOpenid).coalesce.maxBuffer
          : 50;
      },
      onCoalesce: (buffered) => {
        if (buffered.length === 1) {
          return buffered[0]!;
        }
        
        const last = buffered[buffered.length - 1]!;
        
        // 合并附件
        const attachments = buffered.flatMap((c) => c.message.attachments ?? []);
        if (attachments.length > 0) {
          last.message.attachments = attachments;
        }
        
        // 透传原始消息列表，供 assembleBody 使用
        last.state.mergedMessages = buffered;
        
        // 清除 assembledBody，让下游重新构建
        delete last.state.assembledBody;
        
        return last;
      },
      onBufferFull: (ctx) => {
        ctx.log.warn?.(`[coalescer] buffer full for group ${ctx.message.groupOpenid}`);
      },
    }));

  // 11. C2C 输入状态指示器（配额感知：优先占被动回复配额，耗尽后与回复
  //     消息一样降级为主动发送；续期间隔默认 20s 且不低于 20s，
  //     详见 src/middleware/typing.ts）
  const typingCfg = account.config.typing;
  if (typingCfg?.enabled !== false) {
    bot.use(c2cTypingIndicator({
      accountId: account.accountId,
      intervalMs: typingCfg?.intervalMs,
    }));
  }

  // 12. 引用消息解析（默认优先 msg_elements 获取文件名等丰富信息）
  bot.use(quoteRef({
    store: getPersistedRefIndexStore(account.accountId),
  }));

  // 13. 附件处理（语音 STT 转录 + 图片/文件下载）
  bot.use(attachmentProcessor({ getRuntime: opts.getRuntime }));

  // 14. 上下文组装（构建框架规约的 body）
  bot.use(envelopeFormatter({
    format: (ctx) => {
      const assembled = assembleBody(ctx, ctx.message as never, account, opts.getRuntime);
      (ctx.state as Record<string, unknown>).assembledBody = assembled;
      return assembled.agentBody;
    },
  }));
}
