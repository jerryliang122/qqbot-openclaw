/**
 * 斜杠命令注册表
 *
 * 通过 SDK 的 slashCommand 中间件统一注册所有内置命令。
 * 每个命令拆分为独立文件，此处仅编排。
 */
import type { SlashCommand, SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import { botHelp } from './bot-help.js';
import { botPing } from './bot-ping.js';
import { botVersion } from './bot-version.js';
import { botMe } from './bot-me.js';
import { botStreaming } from './bot-streaming.js';
import { botClearStorage } from './bot-clear-storage.js';
import { botLogs } from './bot-logs.js';
import { botApprove } from './bot-approve.js';
import { botGroupAlways } from './bot-group-always.js';
import { botGroupInfo } from './bot-group-info.js';
import { botPairing } from './bot-pairing.js';

export interface CommandBuildOptions {
  getRuntime: () => PluginRuntime;
}

// ========== 命令执行审计 ==========

const CMD_AUDIT_RAW_LIMIT = 80;

/**
 * 审计包装：每个 /bot-* 调用留一条 [cmd] INFO（命令、执行者、scope、
 * 原始输入截断），授权拒绝留 [cmd] WARN。SDK 的 slashCommand 中间件只在
 * handler 抛错时输出 ERROR——成功执行与越权尝试此前零痕迹，含
 * /bot-clear-storage（删存储）、/bot-approve（安全相关）这类操作。
 *
 * ctx.log 即网关注入 SDK 的 PluginLogger（带账号前缀与 request-context
 * 元数据）；warn/debug 在 SDK Logger 接口上是可选方法，须可选链调用。
 */
export function withAudit(cmd: SlashCommand): SlashCommand {
  const name = Array.isArray(cmd.name) ? cmd.name.join('|') : cmd.name;
  const origHandler = cmd.handler;
  const origAuthorized = cmd.authorized;

  return {
    ...cmd,
    authorized: origAuthorized
      ? (ctx: SlashCommandHandlerContext) => {
          const verdict = origAuthorized(ctx);
          if (verdict !== true) {
            ctx.log?.warn?.(`[cmd] unauthorized ${name} sender=${ctx.message?.senderId ?? '?'} scope=${ctx.message?.kind ?? '?'}`);
          }
          return verdict;
        }
      : undefined,
    handler: async (ctx: SlashCommandHandlerContext) => {
      const raw = (ctx.command?.raw ?? '').slice(0, CMD_AUDIT_RAW_LIMIT);
      ctx.log?.info?.(`[cmd] ${name} sender=${ctx.message?.senderId ?? '?'} scope=${ctx.message?.kind ?? '?'} raw="${raw}"`);
      return origHandler(ctx);
    },
  };
}

/**
 * 构建标准命令列表（匹配后直接回复，不进入 AI）
 */
export function buildCommandList(account: ResolvedQQBotAccount, opts: CommandBuildOptions): SlashCommand[] {
  const commands: SlashCommand[] = [];

  // help 需要访问完整命令列表，延迟绑定
  const help = botHelp(account, () => commands);
  commands.push(
    withAudit(help),
    withAudit(botPing()),
    withAudit(botVersion(account)),
    withAudit(botMe()),
    withAudit(botLogs(opts.getRuntime())),
    withAudit(botStreaming(account, opts.getRuntime)),
    withAudit(botClearStorage(account)),
    withAudit(botApprove(opts.getRuntime)),
    withAudit(botGroupAlways(account, opts.getRuntime)),
    withAudit(botGroupInfo(account)),
    withAudit(botPairing(opts.getRuntime)),
  );

  return commands;
}
