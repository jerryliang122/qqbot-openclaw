/**
 * 密钥捕获中间件
 *
 * 当会话存在 pending 密钥输入（secret-input-store）时，拦截该 c2c 用户的
 * 下一条文本消息：就地执行 `openclaw secrets store set` 并把结果直接回复
 * 给用户，消息本身不进入框架 —— 密钥值绝不进入 AI 转录 / 框架日志。
 *
 * 挂载位置：slashCommand 之后、groupMessageCoalescer 之前
 * （/bot-* 命令优先可用；拦截后不再触发 typing 与 envelope 组装）。
 *
 * 红线：多问题 ask_user 答案 / 确认卡消息必须放行 —— 吞掉真实用户消息
 * 会导致挂起的 ask_user 永不成单（AGENTS.md 2026-08-24 事故）。
 */
import type { Middleware } from '@tencent-connect/qqbot-nodejs';
import { findPendingMultiQuestionByConversation } from '../features/question-helpers.js';
import { checkAndConsumePassiveReplyQuota } from '../features/quota-manager.js';
import {
  runSecretsReload,
  runSecretsStoreSet,
  maskSecret,
  type SecretsStoreSetResult,
} from '../features/secret-store-cli.js';
import {
  cancelPendingSecretInput,
  findPendingSecretInput,
  takePendingSecretInput,
} from '../features/secret-input-store.js';

const CANCEL_KEYWORDS = new Set(['取消', 'cancel', '#cancel', '/cancel']);

export function isSecretInputCancelKeyword(text: string): boolean {
  return CANCEL_KEYWORDS.has(text.trim().toLowerCase());
}

/** 配额感知的直接回复：优先被动（msg_id），配额耗尽/发送失败降级主动 */
async function replyToUser(
  ctx: any,
  accountId: string,
  text: string,
): Promise<void> {
  const msgId = ctx.replyTarget?.msgId as string | undefined;
  if (msgId) {
    const { canReply, rollback } = checkAndConsumePassiveReplyQuota({
      accountId,
      msgId,
      scope: 'c2c',
    });
    if (canReply) {
      try {
        await ctx.bot.sendText(ctx.replyTarget, text);
        return;
      } catch (err) {
        rollback();
        ctx.log?.warn?.(`[secret] passive reply failed, falling back to proactive: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const proactiveTarget = { scope: 'c2c' as const, targetId: ctx.message.senderId as string };
  await ctx.bot.sendText(proactiveTarget, text).catch((err: unknown) => {
    ctx.log?.warn?.(`[secret] proactive reply failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

function formatSetFailure(name: string, result: SecretsStoreSetResult): string {
  const reason = result.timedOut
    ? '执行超时'
    : result.error
      ? result.error
      : `退出码 ${result.exitCode ?? '无'}`;
  const lines = [`❌ 保存 \`${name}\` 失败（${reason}）。`];
  if (!result.error && result.output) {
    lines.push('', '```', result.output, '```');
  }
  lines.push(
    '',
    '可能原因：openclaw 版本过旧（需支持 `openclaw secrets store set`），或本机 CLI 不可用。',
    '密钥未被保存，可稍后重试或改在终端执行。',
  );
  return lines.join('\n');
}

export interface SecretCaptureParams {
  accountId: string;
  /** 测试注入：替换 secrets store set 执行器 */
  runSet?: typeof runSecretsStoreSet;
  /** 测试注入：替换 secrets reload */
  runReload?: typeof runSecretsReload;
}

export function secretCapture(params: SecretCaptureParams): Middleware {
  const { accountId, runSet = runSecretsStoreSet, runReload = runSecretsReload } = params;

  return async (ctx, next) => {
    // 仅 c2c：密钥不应出现在群聊（工具侧发卡时已限制，此处双保险）
    if (ctx.message.kind !== 'c2c') {
      await next();
      return;
    }
    const senderId = ctx.message.senderId as string;
    const pending = findPendingSecretInput(accountId, senderId);
    if (!pending) {
      await next();
      return;
    }

    // 红线：多问题 ask_user 进行中 → 其答案/确认卡消息优先，绝不拦截
    if (findPendingMultiQuestionByConversation('c2c', senderId)) {
      await next();
      return;
    }

    const text = ((ctx.message.content as string | undefined) ?? '').trim();

    if (isSecretInputCancelKeyword(text)) {
      cancelPendingSecretInput(accountId, senderId);
      ctx.log?.info?.(`[secret-input] cancelled by user (${pending.name})`);
      await replyToUser(ctx, accountId, `已取消 \`${pending.name}\` 的密钥输入。需要时请重新发起。`);
      ctx.stop('secret-capture:cancelled');
      return;
    }

    // 空文本 / 纯附件：提示重发，保留 pending 继续等待
    if (!text) {
      await replyToUser(
        ctx,
        accountId,
        `请直接以文本形式发送 **${pending.name}** 的值（可发送「取消」退出）。`,
      );
      ctx.stop('secret-capture:empty_input');
      return;
    }

    // 一次性消费，防重复处理
    const entry = takePendingSecretInput(accountId, senderId);
    if (!entry) {
      await next();
      return;
    }

    const result = await runSet({ name: entry.name, kind: entry.kind, value: text });
    let reloadOk = false;
    if (result.ok) {
      reloadOk = await runReload();
    }
    const masked = maskSecret(text);
    const kindLabel = entry.kind === 'env' ? '代理可读环境变量' : `kind: ${entry.kind}`;
    const reply = result.ok
      ? [
          `✅ 已保存 \`${entry.name}\`（${kindLabel}，值已隐藏：\`${masked}\`）`,
          reloadOk
            ? '已触发 `secrets reload`。'
            : '提示：若该名称被 SecretRef 引用，可执行 `openclaw secrets reload` 使其立即生效。',
        ].join('\n')
      : formatSetFailure(entry.name, result);

    ctx.log?.info?.(
      `[secret-input] store set ${entry.name} kind=${entry.kind} ok=${result.ok}` +
        ` exit=${result.exitCode ?? 'n/a'}${result.timedOut ? ' (timeout)' : ''}`,
    );
    await replyToUser(ctx, accountId, reply);
    ctx.stop('secret-capture:consumed');
  };
}
