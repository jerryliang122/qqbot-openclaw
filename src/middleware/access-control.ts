/**
 * 动态访问控制中间件。
 *
 * 从 ctx.state.policy（由 policy-injector 注入）动态读取策略，支持配置热更新。
 * 模式：disabled | open | allowlist | pairing（仅 c2c）
 *
 * 白名单未命中一律 `ctx.stop`，但**必须让用户看得见**：c2c 恒回一条带自身
 * OpenID 的诊断提示、群仅在被 @/引用 bot 时回告（见 features/access-notice.ts）。
 * `disabled`（管理员显式总闸）与 `pairing`（已有配对挑战文案）保持原样。
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { getPairingApi } from '../adapter/pairing.js';
import {
  ACCESS_NOTICE_SEND_TIMEOUT_MS,
  buildAccessNoticeText,
  isMessageAddressedToBot,
  NoticeSendTimeoutError,
  reserveAccessNotice,
  withNoticeTimeout,
} from '../features/access-notice.js';


/**
 * 创建动态访问控制中间件。
 *
 * 决策优先级：
 *   1. disabled → 拒绝
 *   2. open → 放行
 *   3. allowlist → allowFrom 匹配（默认模式）
 *   4. pairing → allowFrom + pairing store，未配对发起挑战
 */
export function dynamicAccessControl(params: {
  accountId: string;
  getRuntime: () => any;
  /**
   * 拒绝提示发送的本地超时上限。生产用默认值；测试注入极短值以复现
   * 「发送请求挂住」而不必等满 8s。
   */
  noticeTimeoutMs?: number;
}): Middleware {
  const { accountId, getRuntime, noticeTimeoutMs = ACCESS_NOTICE_SEND_TIMEOUT_MS } = params;

  return async (ctx, next) => {
    const p = ctx.state.policy as Record<string, unknown> | undefined;
    const isGroup = ctx.message.kind === 'group';
    const mode: string = isGroup
      ? (p?.groupMode as string) ?? 'open'
      : (p?.c2cMode as string) ?? 'allowlist';

    if (mode === 'disabled') {
      ctx.log?.info?.(`[access] blocked ${isGroup ? 'group' : 'c2c'} from ${ctx.message.senderId}: policy disabled`);
      ctx.stop('access:policy_disabled');
      return;
    }
    if (mode === 'open') {
      await next();
      return;
    }

    // allowlist / pairing：c2c 用 allowFrom，group 用 groupAllowFrom
    const allowList = isGroup
      ? ((p?.groupAllowFrom as string[]) ?? [])
      : ((p?.allowFrom as string[]) ?? []);
    if (!allowList.length || allowList.includes('*')) {
      await next();
      return;
    }

    const id = isGroup
      ? (ctx.message.groupOpenid ?? '')
      : (ctx.message.senderId as string);
    if (allowList.includes(id)) {
      await next();
      return;
    }

    // allowlist 未匹配 → pairing 模式尝试 pairing store（仅 c2c）
    if (mode === 'pairing' && !isGroup) {
      await checkPairingMode(ctx, next, {
        accountId,
        getRuntime,
        senderId: ctx.message.senderId as string,
      });
      return;
    }

    // 未匹配 → 拒绝 + 回告原因（诊断入口，见 features/access-notice.ts 边界说明）
    const listLabel = isGroup ? 'groupAllowFrom' : 'allowFrom';
    ctx.log?.info?.(
      `[access] blocked ${isGroup ? 'group' : 'c2c'} from ${id}: not in ${listLabel}`,
    );
    await notifyNotAllowlisted(ctx, { accountId, isGroup, id, timeoutMs: noticeTimeoutMs });
    ctx.stop('access:not_allowlisted');
  };
}

/**
 * 白名单未命中时给被拒者回一条可操作提示（受节流保护）。
 *
 * c2c 恒回告；群仅在被 @/引用 bot 时回告——群提示是公开广播，bot 被拉进
 * 陌生群时逐条回「本群不在白名单」等于对外广播白名单配置，全量推送群里
 * 还会变刷屏。发送失败只降级为静默（记 WARN），绝不让提示失败反过来把
 * `ctx.stop` 之外的链路带崩。
 */
async function notifyNotAllowlisted(
  ctx: any,
  opts: { accountId: string; isGroup: boolean; id: string; timeoutMs: number },
): Promise<void> {
  const { accountId, isGroup, id } = opts;
  const scope = isGroup ? 'group' : 'c2c';

  if (isGroup && !isMessageAddressedToBot(ctx.message, ctx.bot?.appId, accountId)) {
    ctx.log?.info?.(
      `[access] group ${id} not in groupAllowFrom; skipping notice (message not addressed to bot)`,
    );
    return;
  }

  const reservation = reserveAccessNotice({ accountId, scope, id });
  if (!reservation.allowed) {
    ctx.log?.info?.(
      `[access] notice suppressed for ${scope} ${id}: ${reservation.reason} throttle hit`,
    );
    return;
  }

  const text = buildAccessNoticeText({ scope, id, accountId });
  try {
    // 被动回复靠 ctx.replyTarget.msgId —— SDK 的 deriveReplyTarget 已把当前
    // 入站消息的 messageId 挂在上面，sendText 见 msgId 即带 body.msg_id 下发。
    // 被拒消息没有 turn，不存在跟别的 turn 抢配额的问题，故不必绕网关锚点选取
    // （绕过去反而会挑到更早的缓存 msg_id，或在死锚点时降级主动、把每日预算
    // 暴露给刷屏者）。套本地超时：请求挂住就永远走不到 ctx.stop。
    await withNoticeTimeout(ctx.bot.sendText(ctx.replyTarget, text), opts.timeoutMs);
    ctx.log?.info?.(`[access] sent not-allowlisted notice to ${scope} ${id}`);
  } catch (err) {
    // 超时 = 结果不明（平台可能已投递）→ **保留冷却不回滚**，否则紧接着的
    // 下一条被拒消息会再发一遍，用户收到重复诊断；等冷却窗口过去自然恢复。
    if (!(err instanceof NoticeSendTimeoutError)) {
      reservation.release();
    }
    ctx.log?.warn?.(
      `[access] not-allowlisted notice send failed for ${scope} ${id}` +
        `${err instanceof NoticeSendTimeoutError ? ' (timeout, cooldown kept)' : ''}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * pairing 模式：检查 pairing store + 发起配对挑战。
 */
async function checkPairingMode(
  ctx: any,
  next: () => Promise<void>,
  opts: { accountId: string; getRuntime: () => any; senderId: string },
): Promise<void> {
  const api = getPairingApi();

  try {
    const storeIds = await api.readAllowFromStore({
      channel: 'qqbot',
      accountId: opts.accountId,
    });
    if (storeIds.includes(opts.senderId) || storeIds.includes('*')) {
      await next();
      return;
    }

    const challenge = await api.issueChallenge({
      channel: 'qqbot',
      id: opts.senderId,
      accountId: opts.accountId,
    });
    const frameworkReply = api.buildReply({
      code: challenge.code,
      channel: 'qqbot',
    });
    const reply = [
      frameworkReply,
      '',
      'QQ 管理员可直接执行：',
      '',
      '```',
      `/bot-pairing approve ${challenge.code}`,
      '```',
    ].join('\n');

    ctx.log?.info?.(`[access] pairing required for ${opts.senderId}`);
    await ctx.bot.sendText(ctx.replyTarget, reply).catch((err: unknown) => {
      ctx.log?.warn?.(`[access] pairing challenge send failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    ctx.stop('access:pairing_required');
  } catch (err) {
    ctx.log?.error?.(`[access] pairing error: ${(err as Error).message}`);
    ctx.stop(`access:pairing_error: ${(err as Error).message}`);
  }
}
