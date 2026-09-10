/**
 * Gateway 生命周期管理
 *
 * 封装 startAccount / logoutAccount 的业务逻辑：
 * - 凭证恢复
 * - QQBotGateway 实例创建与注册
 * - 注册 "approval.native" 运行时上下文（框架据此自动引导 native 审批 handler）
 * - 登出时凭证清除
 */
import type { OpenClawConfig } from 'openclaw/plugin-sdk/config-contracts';
import type { ResolvedQQBotAccount } from '../types.js';
import {
  DEFAULT_ACCOUNT_ID,
  resolveQQBotAccount,
  applyQQBotAccountConfig,
  resolveQQBotEnvClientSecret,
} from '../config.js';
import { getQQBotRuntime } from '../runtime.js';
import { getAdapters } from '../adapter/resolve.js';
import { QQBotGateway } from './qqbot-gateway.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { registerGateway, unregisterGateway, getGateway } from '../outbound/outbound-service.js';
import { saveCredentialBackup, loadCredentialBackup } from '../features/credential-backup.js';
import { syncCommandPanels } from '../features/command-panel.js';
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from '../features/approval-capability.js';
import { cleanupTypingByAccount } from '../typing-lifecycle.js';

export interface StartAccountContext {
  account: ResolvedQQBotAccount;
  abortSignal?: AbortSignal;
  cfg: any;
  /**
   * 框架传入的基础 logger（无 child 方法）。内部会自动包装为 PluginLogger。
   * 写日志的优先级：info > warn > error > debug，方法均为必选。
   */
  log?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug: (msg: string) => void };
  getStatus: () => Record<string, unknown>;
  setStatus: (s: Record<string, unknown>) => void;
  [key: string]: unknown;
}

/**
 * 启动账户（含凭证恢复 + features 初始化）
 */
export async function startAccountWithCredentialRecovery(ctx: StartAccountContext): Promise<void> {
  let { account } = ctx;
  const { abortSignal, cfg } = ctx;
  const log: PluginLogger = createPluginLogger({
    prefix: `[${account.accountId}]`,
    ...(ctx.log?.info ? { output: ctx.log as PluginLogger } : {}),
  });
  const runtime = getQQBotRuntime();

  // 凭证恢复：配置中 appId/secret 为空时尝试从暂存文件恢复
  if (!account.appId || !account.clientSecret) {
    const backup = loadCredentialBackup(account.accountId);
    if (backup) {
      log?.info(`[qqbot:${account.accountId}] 从暂存文件恢复凭证 (appId=${backup.appId})`);
      try {
        const restoredCfg = applyQQBotAccountConfig(cfg, account.accountId, {
          appId: backup.appId,
          clientSecret: backup.clientSecret,
            });
        const adapters = getAdapters(runtime);
        if (adapters.persistConfig) {
          await adapters.persistConfig(() => restoredCfg);
        }
        account = resolveQQBotAccount(restoredCfg, account.accountId);
      } catch (e) {
        log?.error(`[qqbot:${account.accountId}] 凭证恢复失败: ${e}`);
      }
    }
  }

  // 创建 gateway 实例并注册
  const gw = new QQBotGateway(account, runtime, log);
  registerGateway(account.accountId, gw);

  await gw.start(
    {
      onReady: () => {
        saveCredentialBackup(account.accountId, account.appId, account.clientSecret);
        ctx.setStatus({
          ...ctx.getStatus(),
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
            });

        // ── Features 初始化（gateway ready 后触发）──
        initFeatures(account, ctx, log).catch((e) => {
          log?.error(`[qqbot:${account.accountId}] initFeatures error: ${e}`);
            });
      },
      onError: (error) => {
        log?.error(`[qqbot:${account.accountId}] Gateway error: ${error.message}`);
        ctx.setStatus({ ...ctx.getStatus(), lastError: error.message });
      },
    },
    abortSignal,
  );
}

/**
 * Gateway ready 后初始化各 feature 模块
 */
async function initFeatures(
  account: ResolvedQQBotAccount,
  ctx: StartAccountContext,
  log: PluginLogger,
): Promise<void> {
  // 1. 注册 "approval.native" 运行时上下文。框架的 approval bootstrap 监听此上下文，
  //    据此为该账户自动 spawn native 审批 handler（消费 exec/plugin approval 事件，
  //    回调 qqbotPlugin.approvalCapability.nativeRuntime 的 availability/presentation/transport）。
  //    账户停止时 abortSignal 触发，上下文自动注销。
  registerApprovalNativeContext(account.accountId, ctx);

  // 2. 指令面板同步：把 openclaw essential 原生指令注册到 QQ Bot 指令面板（/v2/panels）。
  //    每进程每账号仅一次；失败只记日志并由 once-guard 释放等待重连重试，不影响消息收发。
  syncCommandPanels(account, ctx.cfg, log).catch((e) => {
    log?.error(`[qqbot:${account.accountId}] command panel sync error: ${e}`);
  });
}

/**
 * 注册 qqbot 的 native approval 运行时上下文（若框架已提供 channelRuntime）。
 */
function registerApprovalNativeContext(accountId: string, ctx: StartAccountContext): void {
  const channelRuntime = (ctx as { channelRuntime?: { runtimeContexts?: any } }).channelRuntime;
  const registry = channelRuntime?.runtimeContexts;
  if (!registry) {
    return;
  }
  try {
    registry.register({
      channelId: 'qqbot',
      accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: { accountId },
      abortSignal: ctx.abortSignal,
    });
  } catch {
    // 重复注册或 registry 异常时静默 — 框架会按 accountId 去重。
  }
}

/**
 * 停止账户 — 主动调用，与 abort 信号双保险。
 *
 * 框架先 abort.abort() 让 startAccount promise 自然 resolve，
 * 再调用 stopAccount 给插件机会做主动清理（关 WebSocket、注销处理器、刷新持久化）。
 *
 * 实现策略：
 *   1. 主动调用 bot.stop() — 比 abort 信号更立刻、不依赖事件循环时机
 *   2. 注销 gateway（native 审批上下文由 abortSignal 自动注销，无需手动清理）
 *   3. 立即返回；剩余资源（typing keepalive 定时器等）由 abort 信号触发收尾
 */
export async function stopAccountGracefully(params: {
  accountId: string;
  log?: PluginLogger;
}): Promise<void> {
  const { accountId, log } = params;
  const gw = getGateway(accountId);

  // 1. 清理 typing session（防止账户重启后旧 session 阻塞新 session）
  cleanupTypingByAccount(accountId);

  // 2. 主动停止 bot
  if (gw) {
    try {
      await gw.stop();
      log?.info(`[qqbot:${accountId}] gateway stopped`);
    } catch (err) {
      log?.error(`[qqbot:${accountId}] gateway stop error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  unregisterGateway(accountId);
}

/**
 * 登出账户（清除凭证）
 */
export async function logoutAndClearCredentials(params: {
  accountId: string;
  cfg: any;
}): Promise<{ ok: boolean; cleared: boolean; envToken: boolean; loggedOut: boolean }> {
  const { accountId, cfg } = params;
  unregisterGateway(accountId);

  const nextCfg = { ...cfg } as OpenClawConfig;
  const nextQQBot = cfg.channels?.qqbot ? { ...cfg.channels.qqbot } : undefined;
  let cleared = false;
  let changed = false;

  if (nextQQBot) {
    const qqbot = nextQQBot as Record<string, unknown>;
    if (accountId === DEFAULT_ACCOUNT_ID && qqbot.clientSecret) {
      delete qqbot.clientSecret;
      cleared = true;
      changed = true;
    }
    const accounts = qqbot.accounts as Record<string, Record<string, unknown>> | undefined;
    if (accounts && accountId in accounts) {
      const entry = accounts[accountId];
      if (entry && 'clientSecret' in entry) {
        delete entry.clientSecret;
        cleared = true;
        changed = true;
      }
      if (entry && Object.keys(entry).length === 0) {
        delete accounts[accountId];
        changed = true;
      }
    }
  }

  if (changed && nextQQBot) {
    nextCfg.channels = { ...nextCfg.channels, qqbot: nextQQBot };
    const runtime = getQQBotRuntime();
    const adapters = getAdapters(runtime);
    if (adapters.persistConfig) {
      await adapters.persistConfig(() => nextCfg);
    }
  }

  const resolved = resolveQQBotAccount(changed ? nextCfg : cfg, accountId);
  const loggedOut = resolved.secretSource === 'none';
  const envToken = Boolean(resolveQQBotEnvClientSecret());
  return { ok: true, cleared, envToken, loggedOut };
}
