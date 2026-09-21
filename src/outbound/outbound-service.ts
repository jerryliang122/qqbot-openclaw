/**
 * 出站消息服务
 *
 * 负责将 AI 回复通过 QQBotGateway 发送到 QQ。
 * 超时保护由 QQBotGateway 内部统一处理，本层做 target 解析 + 被动回复限额管控。
 */
import * as path from 'node:path';
import { MediaFileType } from '@tencent-connect/qqbot-nodejs';
import type { QQBotGateway } from '../gateway/index.js';
import type { ResolvedQQBotAccount } from '../types.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import { parseTarget } from './target.js';
import {
  checkAndConsumePassiveReplyQuota,
  clearQuotaCacheForAccount,
  rollbackPassiveReplyQuota,
} from '../features/quota-manager.js';

// ── Gateway 注册表（生命周期由 channel.ts 管理）──

/**
 * 进程级注册表桥（issue #15）：
 *
 * openclaw 的 message 工具在部分执行上下文（后台任务 / bootstrap 兜底注册表）
 * 会经 jiti/二次加载产生插件的**另一个模块实例**——模块级 Map 在两个实例里
 * 各持一份，第二实例的注册表为空，getGateway 恒 miss，主动发送全部报
 * `Bot "<accountId>" not running`（账号 id 本身解析是对的）。gateway 是
 * 进程级资源（WebSocket 连接），注册表挂到 globalThis（Symbol.for 跨副本
 * 共享）让所有模块实例看到同一份。
 */
const GATEWAYS_REGISTRY_KEY = Symbol.for('openclaw-qqbot.gateways');

interface QQBotGatewayRegistryGlobal {
  [GATEWAYS_REGISTRY_KEY]?: Map<string, QQBotGateway>;
}

const gateways: Map<string, QQBotGateway> =
  ((globalThis as unknown as QQBotGatewayRegistryGlobal)[GATEWAYS_REGISTRY_KEY] ??= new Map());

// 契约入口（框架直发 / message 工具 / cron）无调用方 logger 可传，
// 回退日志用模块级 logger 兜底（与 outbound-adapter.ts 的 alog 同模式）。
// 注意：本模块处于 bot-instance → outbound-service → plugin-logger → runtime
// → bot-instance 的循环依赖环上，logger 必须惰性创建（顶层求值会在模块
// 环半初始化状态下崩溃），且日志失败绝不影响发送。
let svcLog: ReturnType<typeof createPluginLogger> | undefined;

function logFallbackInfo(msg: string): void {
  try {
    svcLog ??= createPluginLogger({ prefix: '[outbound]' });
    svcLog.info(msg);
  } catch {
    /* logging must never break sends */
  }
}

/** 单账号回退的 INFO 日志去重：每个失效账号键只打一次，避免刷屏 */
const gatewayFallbackLogged = new Set<string>();

/**
 * 为一次实际 API 调用预留被动回复配额。
 * quotaReserved=true 表示上层 adapter 已经原子预留，避免同一发送重复计数。
 */
function reservePassiveReply(params: {
  replyToId?: string;
  accountId: string;
  scope: 'c2c' | 'group';
  quotaReserved?: boolean;
}): { msgId?: string; rollback: () => void } {
  if (!params.replyToId) return { rollback: () => {} };
  if (params.quotaReserved) {
    return { msgId: params.replyToId, rollback: () => {} };
  }
  const reservation = checkAndConsumePassiveReplyQuota({
    accountId: params.accountId,
    msgId: params.replyToId,
    scope: params.scope,
  });
  return {
    msgId: reservation.canReply ? params.replyToId : undefined,
    rollback: reservation.canReply ? reservation.rollback : () => {},
  };
}

/**
 * 尝试为 typing 指示器占用一个被动回复配额（带 msg_id 发送）。
 *
 * typing 通知与回复消息共享同一 msg_id 的被动回复配额，必须经统一
 * quota-manager 记账。配额不可用时调用方应降级为主动发送（不带 msg_id）。
 *
 * @returns 是否占得被动配额；false 表示应不带 msg_id 主动发送
 */
export function tryAcquirePassiveSlot(accountId: string, msgId: string | undefined): boolean {
  if (!msgId) return false; // 无 msg_id 无法走被动通道
  return checkAndConsumePassiveReplyQuota({ accountId, msgId, scope: 'c2c' }).canReply;
}

export function rollbackPassiveSlot(accountId: string, msgId: string | undefined): void {
  if (!msgId) return;
  rollbackPassiveReplyQuota({ accountId, msgId, scope: 'c2c' });
}

export function registerGateway(accountId: string, gw: QQBotGateway): void {
  gateways.set(accountId, gw);
}

export function unregisterGateway(accountId: string): void {
  gateways.delete(accountId);
  clearQuotaCacheForAccount(accountId);
}

export function getGateway(accountId: string): QQBotGateway | undefined {
  return gateways.get(accountId);
}

/** 注册表中所有运行中的账号 ID（诊断与单账号回退用） */
export function getRegisteredAccountIds(): string[] {
  return [...gateways.keys()];
}

/**
 * 发送路径的 gateway 解析（带单账号回退，issue #15）：
 * - 精确命中 → 直接返回
 * - 未命中且注册表里恰好只有一个运行中的账号 → 回退到它。单账号部署下
 *   请求键与注册键不一致只可能来自配置残影（如顶层 appId 残留的 "default"），
 *   不存在路由歧义；回退仅打一次 INFO 便于事后取证。
 * - 未命中且运行中账号为 0 或多个 → 返回 undefined 由调用方报错——
 *   OpenID 跨账号不通用，多账号下盲目回退会把消息发给错误的 bot。
 */
export function resolveGatewayForSend(accountId: string): QQBotGateway | undefined {
  const gw = gateways.get(accountId);
  if (gw) return gw;
  const running = getRegisteredAccountIds();
  if (running.length === 1) {
    const soleAccountId = running[0];
    if (!gatewayFallbackLogged.has(accountId)) {
      gatewayFallbackLogged.add(accountId);
      logFallbackInfo(
        `account "${accountId}" not running; falling back to sole running account "${soleAccountId}"`,
      );
    }
    return gateways.get(soleAccountId);
  }
  return undefined;
}

/** "not running" 错误（多账号时附运行中账号列表，便于排障） */
export function notRunningError(accountId: string): string {
  const running = getRegisteredAccountIds();
  return `Bot "${accountId}" not running${running.length ? ` (running accounts: ${running.join(', ')})` : ''}`;
}

// ── 媒体类型映射 ──

export type MediaKind = 'image' | 'voice' | 'video' | 'file';

const MEDIA_KIND_TO_FILE_TYPE: Record<MediaKind, MediaFileType> = {
  image: MediaFileType.IMAGE,
  voice: MediaFileType.VOICE,
  video: MediaFileType.VIDEO,
  file: MediaFileType.FILE,
};

export interface SendResult {
  messageId?: string;
  error?: string;
  errorCode?: string;
  qqBizCode?: number;
}

// ── 公开 API（channel.ts / deliver-pipeline.ts 调用）──

export async function sendText(params: {
  to: string;
  text: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = resolveGatewayForSend(accountId);
  if (!gw) return { error: notRunningError(accountId) };
  const target = parseTarget(params.to);
  const reservation = reservePassiveReply({
    replyToId: params.replyToId,
    accountId,
    scope: target.scope,
    quotaReserved: params.quotaReserved,
  });
  try {
    const result = await gw.sendText(target, params.text, { msgId: reservation.msgId });
    return { messageId: result.id };
  } catch (err: unknown) {
    reservation.rollback();
    return formatError(err);
  }
}

export async function sendMedia(params: {
  to: string;
  text?: string;
  mediaUrl: string;
  mediaKind?: MediaKind;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = resolveGatewayForSend(accountId);
  if (!gw) return { error: notRunningError(accountId) };
  const target = parseTarget(params.to);
  const reservation = reservePassiveReply({
    replyToId: params.replyToId,
    accountId,
    scope: target.scope,
    quotaReserved: params.quotaReserved,
  });
  try {
    const kind = params.mediaKind ?? 'image';
    const msgId = reservation.msgId;
    if (kind === 'voice') {
      const source = resolveVoiceSource(params.mediaUrl);
      const result = await gw.sendVoice(target, source, { text: params.text, msgId });
      return { messageId: result.id };
    }
    if (kind === 'video') {
      const result = await gw.sendVideo(target, params.mediaUrl, { text: params.text, msgId });
      return { messageId: result.id };
    }
    if (kind === 'file') {
      const result = await gw.sendFile(target, params.mediaUrl, { text: params.text, msgId });
      return { messageId: result.id };
    }
    const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
    const result = await gw.sendMedia(target, params.mediaUrl, { text: params.text, msgId, fileType });
    return { messageId: result.id };
  } catch (err: unknown) {
    reservation.rollback();
    return formatError(err);
  }
}

export async function sendVoice(params: {
  to: string;
  source: { url?: string; base64?: string };
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = resolveGatewayForSend(accountId);
  if (!gw) return { error: notRunningError(accountId) };
  const target = parseTarget(params.to);
  const reservation = reservePassiveReply({
    replyToId: params.replyToId,
    accountId,
    scope: target.scope,
    quotaReserved: params.quotaReserved,
  });
  try {
    const result = await gw.sendVoice(target, params.source, { msgId: reservation.msgId });
    return { messageId: result.id };
  } catch (err: unknown) {
    reservation.rollback();
    return formatError(err);
  }
}

export async function sendVideo(params: {
  to: string;
  videoUrl: string;
  accountId?: string;
  replyToId?: string;
  account: ResolvedQQBotAccount;
  quotaReserved?: boolean;
}): Promise<SendResult> {
  const accountId = params.account.accountId;
  const gw = resolveGatewayForSend(accountId);
  if (!gw) return { error: notRunningError(accountId) };
  const target = parseTarget(params.to);
  const reservation = reservePassiveReply({
    replyToId: params.replyToId,
    accountId,
    scope: target.scope,
    quotaReserved: params.quotaReserved,
  });
  try {
    const result = await gw.sendVideo(target, params.videoUrl, { msgId: reservation.msgId });
    return { messageId: result.id };
  } catch (err: unknown) {
    reservation.rollback();
    return formatError(err);
  }
}

// ── OutboundService（deliver-pipeline 专用）──

export class OutboundService {
  constructor(private readonly gw: QQBotGateway, private readonly accountId: string) {}

  async sendText(to: string, text: string, msgId?: string): Promise<SendResult> {
    const target = parseTarget(to);
    const reservation = reservePassiveReply({
      replyToId: msgId,
      accountId: this.accountId,
      scope: target.scope,
    });
    try {
      const result = await this.gw.sendText(target, text, { msgId: reservation.msgId });
      return { messageId: result.id };
    } catch (err: unknown) {
      reservation.rollback();
      return formatError(err);
    }
  }

  async sendMedia(to: string, source: string, opts?: { text?: string; msgId?: string; mediaKind?: MediaKind }): Promise<SendResult> {
    const target = parseTarget(to);
    const reservation = reservePassiveReply({
      replyToId: opts?.msgId,
      accountId: this.accountId,
      scope: target.scope,
    });
    try {
      const kind = opts?.mediaKind ?? 'image';
      const resolvedMsgId = reservation.msgId;
      if (kind === 'voice') {
        const voiceSource = resolveVoiceSource(source);
        const result = await this.gw.sendVoice(target, voiceSource, { text: opts?.text, msgId: resolvedMsgId });
        return { messageId: result.id };
      }
      if (kind === 'video') {
        const result = await this.gw.sendVideo(target, source, { text: opts?.text, msgId: resolvedMsgId });
        return { messageId: result.id };
      }
      if (kind === 'file') {
        const result = await this.gw.sendFile(target, source, { text: opts?.text, msgId: resolvedMsgId, fileName: path.basename(source) });
        return { messageId: result.id };
      }
      const fileType = MEDIA_KIND_TO_FILE_TYPE[kind];
      const result = await this.gw.sendMedia(target, source, { text: opts?.text, msgId: resolvedMsgId, fileType });
      return { messageId: result.id };
    } catch (err: unknown) {
      reservation.rollback();
      return formatError(err);
    }
  }
}

// ── 辅助 ──

function resolveVoiceSource(source: string): { url?: string; base64?: string; localPath?: string } {
  if (source.startsWith('http://') || source.startsWith('https://')) return { url: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../')) return { localPath: source };
  if (source.startsWith('data:')) {
    const i = source.indexOf(',');
    return { base64: i > 0 ? source.slice(i + 1) : source };
  }
  return { base64: source };
}

function formatError(err: unknown): SendResult {
  if (err instanceof Error) {
    const result: SendResult = { error: err.message };
    if ('code' in err) result.errorCode = String((err as any).code);
    if ('qqBizCode' in err) result.qqBizCode = (err as any).qqBizCode;
    return result;
  }
  return { error: String(err) };
}
