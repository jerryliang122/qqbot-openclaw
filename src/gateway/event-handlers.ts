/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 配置更新 / 审批按钮 / ask_user 按钮
 */

import type { MiddlewareContext, QQBotInboundMessage, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { dispatchToOpenClaw } from '../dispatch/index.js';
import { runWithRequestContext } from '../request-context.js';
import { authorizeQQBotApprovalAction } from '../features/approval-capability.js';
import { parseApprovalButtonData } from '../features/approval-helpers.js';
import {
  getQuestionGatewayRuntime,
  parseQuestionButtonData,
  parseMultiQuestionButtonData,
  recordMultiQuestionTap,
  markMultiQuestionResolveFailed,
  getPendingMultiQuestions,
  buildMultiQuestionAnswerText,
  formatMultiQuestionConfirmCard,
  buildMultiQuestionConfirmKeyboard,
  type MultiQuestionAnswer,
} from '../features/question-helpers.js';
import { recordKnownUser } from '../features/proactive.js';
import { cacheMsgId } from '../features/msgid-cache.js';
import { recordGroupEvent, getGroupModeFacts } from '../features/group-mode-store.js';
import { getAdapters } from '../adapter/resolve.js';
import { resolveGroupConfigFromAccount, resolveGroupPolicy, resolveMentionPatterns } from '../config.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { getOpenClawVersion, tryGetBotForAccount } from '../bot-instance.js';
import type { ParsedMultiQuestionAction } from '../features/question-helpers.js';

export async function handleMessage(
  ctx: MiddlewareContext,
  msg: QQBotInboundMessage,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const hlog = log.child('handle');
  const scope = msg.replyTarget.scope;
  const targetId = scope === 'group'
    ? `qqbot:group:${msg.replyTarget.targetId}`
    : `qqbot:c2c:${msg.replyTarget.targetId}`;

  const mergedCount = (ctx.state.mergedMessages as unknown[] | undefined)?.length;
  // mergedMessages 由插件 coalescer（coalesce.strategy=plugin 回退路径）合并批次时写入
  if (mergedCount) {
    hlog.info(`merged batch count=${mergedCount} msgId=${msg.messageId}`);
  } else {
    hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? '').length}`);
  }

  try {
    // 群推送模式推断（AT 系 vs 全量）：按事件类型记录；首次观测与模式变化都打 INFO
    // 留痕（模式由群主设置、可随时变，事后排障靠这两条日志定位「为什么收得到/收不到消息」）
    if (scope === 'group') {
      const seenBefore = getGroupModeFacts(account.accountId, msg.replyTarget.targetId);
      const modeChange = recordGroupEvent(
        account.accountId,
        msg.replyTarget.targetId,
        (msg as { rawEventType?: string }).rawEventType ?? '',
        Array.isArray((msg as { msgElements?: unknown[] }).msgElements),
      );
      const current = getGroupModeFacts(account.accountId, msg.replyTarget.targetId);
      if (modeChange) {
        hlog.info(`[group-mode] push mode changed to ${modeChange} for group=${msg.replyTarget.targetId}`);
      } else if (!seenBefore && current) {
        hlog.info(`[group-mode] first observation mode=${current.mode} group=${msg.replyTarget.targetId}`);
      }
    }

    cacheMsgId(scope, msg.replyTarget.targetId, msg.messageId);

    recordKnownUser({
      type: scope === 'group' ? 'group' : 'c2c',
      openid: scope === 'group' ? msg.replyTarget.targetId : msg.senderId,
      accountId: account.accountId,
      nickname: msg.senderName,
      lastInteractionAt: Date.now(),
    });

    // ── 多问题 ask_user 的最终答案不在此拦截 ──
    // 确认卡的指令按钮代发（或用户手打）的 "1: 3\n2: 1" 是真实用户消息，
    // 必须原样放行走框架原生 keyed 文本认领；任何拦截都会破坏认领链路。

    await runWithRequestContext(
      {
        accountId: account.accountId,
        messageId: msg.messageId,
        openId: msg.senderId,
        target: targetId,
      },
      () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
    );
  } catch (err) {
    hlog.error(`dispatch error: ${err}`);
  }
  hlog.debug(`done msgId=${msg.messageId}`);
}

const INTERACTION_QUERY  = 2001;
const INTERACTION_UPDATE = 2002;

export async function handleInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  acknowledgeInteraction: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (event.data?.type === INTERACTION_QUERY) {
    await handleConfigQuery(event, account, runtime, log, acknowledgeInteraction);
    return;
  }
  if (event.data?.type === INTERACTION_UPDATE) {
    await handleConfigUpdate(event, account, runtime, log);
    try {
      const adapters = getAdapters(runtime);
      const cfg = adapters.getConfig?.() ?? {};
      const groupOpenid = (event as any).group_openid ?? '';
      const updatedCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
      const requireMention = updatedCfg?.requireMention ?? true;
      const clawCfg = buildClawCfg(requireMention, [], resolveGroupPolicy(cfg, account.accountId));
      await acknowledgeInteraction(event.id, 0, { claw_cfg: clawCfg });
    } catch {
      try { await acknowledgeInteraction(event.id); } catch { /* ignore */ }
    }
    return;
  }

  // question 按钮（ask_user，含单问题 qqbot:q: 与多问题 qqbot:qm:）优先于审批按钮
  const buttonData = event.data?.resolved?.button_data;
  if (buttonData?.startsWith('qqbot:q:') || buttonData?.startsWith('qqbot:qm:')) {
    await handleQuestion(event, account, runtime, log, acknowledgeInteraction);
    return;
  }

  await handleApproval(event, account, runtime, log, acknowledgeInteraction);
}

// ── Interaction 子处理 ──

async function handleConfigQuery(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string, code?: number, data?: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const groupOpenid = (event as any).group_openid ?? '';
  try {
    const adapters = getAdapters(runtime);
    const cfg = adapters.getConfig?.() ?? {};
    const groupCfg = groupOpenid ? resolveGroupConfigFromAccount(account, groupOpenid) : null;
    const requireMention = groupCfg?.requireMention ?? true;
    const agentId = groupOpenid
      ? adapters.resolveAgentRoute?.({ cfg, channel: 'qqbot', accountId: account.accountId, peer: { kind: 'group', id: groupOpenid } })?.agentId
      : undefined;
    const mentionPatterns = resolveMentionPatterns(cfg, agentId);
    const clawCfg = buildClawCfg(requireMention, mentionPatterns, resolveGroupPolicy(cfg, account.accountId));
    log.info(`interaction query: group=${groupOpenid} requireMention=${requireMention}`);
    await ack(event.id, 0, { claw_cfg: clawCfg });
  } catch (err) {
    log.warn(`interaction query failed: ${(err as Error)?.message ?? err}, ack without data`);
    try { await ack(event.id); } catch { /* ignore */ }
  }
}

async function handleConfigUpdate(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const resolved = (event.data as any)?.resolved;
  const update = resolved?.claw_cfg;
  const groupOpenid = (event as any).group_openid ?? '';

  if (update?.require_mention !== undefined && groupOpenid) {
    try {
      await setGroupRequireMention(runtime, account.accountId, groupOpenid, update.require_mention === 'mention');
      log.info(`interaction: group=${groupOpenid} requireMention=${update.require_mention}`);
    } catch (err) {
      log.error(`interaction update failed: ${err}`);
    }
  }
}

async function handleApproval(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string) => Promise<void>,
): Promise<void> {
  try { await ack(event.id); } catch { /* ignore */ }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData?.startsWith('approve:')) return;

  const parsed = parseApprovalButtonData(buttonData);
  if (!parsed) return;

  // Live config snapshot so allowFrom changes apply without a restart.
  // getConfig returns `any` — keep it untyped here to avoid crossing the
  // project's hand-written ambient SDK types with the real SDK types.
  const cfg = getAdapters(runtime).getConfig?.() ?? {};

  // 身份授权校验：操作者需在 allowFrom 白名单中
  const operatorId = resolveOperatorId(event);
  const authorization = authorizeQQBotApprovalAction({
    cfg,
    accountId: account.accountId,
    senderId: operatorId,
  });
  if (!authorization.authorized) {
    log.warn(`[approval] unauthorized operator=${operatorId ?? 'unknown'} account=${account.accountId}${authorization.reason ? ` reason=${authorization.reason}` : ''}`);
    return;
  }

  try {
    const { resolveApprovalOverGateway } = await import('openclaw/plugin-sdk/approval-gateway-runtime');
    await resolveApprovalOverGateway({
      cfg,
      approvalId: parsed.approvalId,
      approvalKind: parsed.approvalKind,
      decision: parsed.decision,
      senderId: operatorId,
      clientDisplayName: 'QQBot Approval Handler',
    });
  } catch (err) {
    log.error(`interaction approve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Question 按钮处理（ask_user）──

async function handleQuestion(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
  ack: (id: string) => Promise<void>,
): Promise<void> {
  try { await ack(event.id); } catch { /* ignore */ }

  const buttonData = event.data?.resolved?.button_data;
  if (!buttonData) return;

  const parsed = parseQuestionButtonData(buttonData);
  if (!parsed) {
    const multiParsed = parseMultiQuestionButtonData(buttonData);
    if (multiParsed) {
      await handleMultiQuestionTap(multiParsed, event, account, runtime, log);
    }
    return;
  }

  // 无授权检查：ask_user 问题面向所有参与者（与审批不同，question 不是安全敏感操作）。
  // 框架侧 questionGatewayRuntime.resolveOption 已处理过期/重复提交等边界情况。
  const operatorId = resolveOperatorId(event);
  const cfg = getAdapters(runtime).getConfig?.() ?? {};

  try {
    const questionGatewayRuntime = await getQuestionGatewayRuntime();
    if (!questionGatewayRuntime) {
      throw new Error('OpenClaw host does not export question-gateway-runtime (requires 2026.8.1+)');
    }
    const result = await questionGatewayRuntime.resolveOption({
      cfg,
      questionId: parsed.questionId,
      optionIndex: parsed.optionIndex,
      senderId: operatorId,
      clientDisplayName: 'QQBot question',
    });
    log.debug(`[question] resolved questionId=${parsed.questionId} optionIndex=${parsed.optionIndex} status=${result.status}`);
  } catch (err) {
    log.error(`[question] resolve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 多问题按钮处理（ask_user questions >= 2）──
// 框架对多问题记录没有单题按钮解析通道（resolveOption 仅支持单问题），
// 这里按题缓冲点选，集齐后发一张"确认卡"：指令按钮（action.type=2,
// enter=true）携带完整答案文本 "1: 3\n2: 1"，由 QQ 客户端以真实用户
// 消息发出，走框架原生的 keyed 文本认领通道 resolve 挂起的 ask_user。
// 注意两条红线（都出过生产事故，勿回退）：
// 1. 不要程序化提交：官方 openclaw 无多问题提交 API，改官方代码要背
//    fork 维护成本；
// 2. 不要合成入站消息"假装用户回答"：合成消息会被框架当成 steering
//    注入挂起的 run，claim 不触发，模型等答案直到超时（2026-08-24 事故）。
// 只有真实用户消息（客户端代发或手打）能被框架认领。

async function handleMultiQuestionTap(
  parsed: ParsedMultiQuestionAction,
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  runtime: PluginRuntime,
  log: PluginLogger,
): Promise<void> {
  const operatorId = resolveOperatorId(event);
  const scope: 'group' | 'c2c' = event.group_openid ? 'group' : 'c2c';
  const peerId = (scope === 'group' ? event.group_openid : event.user_openid) ?? '';
  if (!peerId) return; // 缺少会话定位信息，无法回执或发确认卡

  log.info(
    `[question] multi tap id=${parsed.questionId} q=${parsed.questionIndex + 1} opt=${parsed.optionIndex + 1} operator=${operatorId ?? 'unknown'}`,
  );

  const tap = recordMultiQuestionTap(parsed.questionId, parsed.questionIndex, parsed.optionIndex);

  if (tap.status === 'unknown' || tap.status === 'terminal') {
    log.info(`[question] multi tap ignored id=${parsed.questionId} status=${tap.status}`);
    await sendMultiQuestionFeedback(event, account, '该问题已提交或已过期');
    return;
  }
  if (tap.status === 'resolving') {
    log.debug(`[question] multi tap dropped while resolving id=${parsed.questionId}`);
    return;
  }
  if (tap.status === 'buffered') {
    const pendingTitles = tap.pendingQuestions.map((q) => q.header);
    log.info(`[question] multi buffered id=${parsed.questionId} answered=${tap.answeredCount}/${tap.total}`);
    await sendMultiQuestionFeedback(
      event,
      account,
      `✅ 已记录 ${tap.answeredCount}/${tap.total}\n还剩：${pendingTitles.join('、')}`,
    );
    return;
  }
  // 按钮点选路径不会产生 nomatch（选项序号来自键盘本身）
  if (tap.status !== 'complete') return;

  // complete：发确认卡，由用户一键代发真实答案消息
  await sendMultiQuestionConfirmCard(
    parsed.questionId,
    tap.answers,
    scope,
    peerId,
    account,
    log,
  );
}

/**
 * 集齐后发确认卡。正文按题展示已选内容，键盘带两个指令按钮：
 * 「✅ 提交」（enter=true，客户端自动以用户身份发出答案文本）与
 * 「✏️ 改一改」（填入输入框，用户编辑后手动发送）。
 * 发出后复位 resolving 锁——用户可以继续点选修改答案，再拿到新确认卡。
 */
async function sendMultiQuestionConfirmCard(
  questionId: string,
  answers: ReadonlyMap<number, MultiQuestionAnswer>,
  scope: 'c2c' | 'group',
  peerId: string,
  account: ResolvedQQBotAccount,
  log: PluginLogger,
): Promise<void> {
  const answerText = buildMultiQuestionAnswerText(answers);
  const questions = getPendingMultiQuestions(questionId);
  const cardText = questions
    ? formatMultiQuestionConfirmCard(questions, answers)
    : `**✅ 答案确认**\n\n${answerText}`;

  const bot = tryGetBotForAccount(account.accountId);
  if (!bot) {
    markMultiQuestionResolveFailed(questionId);
    log.error(`[question] confirm card send failed: bot unavailable id=${questionId}`);
    await sendMultiQuestionFeedbackText(scope, peerId, account, '⚠️ 提交卡发送失败，请直接文字回复答案');
    return;
  }
  try {
    await bot.sendTextWithKeyboard({ scope, targetId: peerId }, cardText, buildMultiQuestionConfirmKeyboard(answerText) as never);
    markMultiQuestionResolveFailed(questionId); // 复位锁，允许继续改答案
    log.info(`[question] confirm card sent id=${questionId} answers=${JSON.stringify(answerText)}`);
  } catch (err) {
    markMultiQuestionResolveFailed(questionId);
    log.error(`[question] confirm card send error id=${questionId}: ${err instanceof Error ? err.message : String(err)}`);
    await sendMultiQuestionFeedbackText(scope, peerId, account, '⚠️ 提交卡发送失败，请直接文字回复答案');
  }
}

/** 尽力而为的状态回执（主动消息），失败仅记日志不影响主流程 */
async function sendMultiQuestionFeedback(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  text: string,
): Promise<void> {
  const scope = event.group_openid ? 'group' as const : 'c2c' as const;
  const targetId = event.group_openid ?? event.user_openid;
  if (!targetId) return;
  await sendMultiQuestionFeedbackText(scope, targetId, account, text);
}

async function sendMultiQuestionFeedbackText(
  scope: 'c2c' | 'group',
  targetId: string,
  account: ResolvedQQBotAccount,
  text: string,
): Promise<void> {
  const bot = tryGetBotForAccount(account.accountId);
  if (!bot) return;
  try {
    await bot.sendText({ scope, targetId }, text);
  } catch {
    // 主动消息可能触发平台限频；回执是锦上添花，吞掉即可
  }
}

const CHANNEL_VER = getPackageVersion();

// ── 审批授权校验 ──

/**
 * 从交互事件中提取操作者身份标识。
 * QQ Bot 按钮回调事件中，操作者 openid 通常在 `user_openid` 或 `data.resolved.user_id` 字段。
 */
function resolveOperatorId(event: InteractionEvent): string | undefined {
  const evt = event as any;
  return evt.user_openid
    ?? evt.data?.resolved?.user_id
    ?? evt.data?.resolved?.user_openid
    ?? evt.openid;
}

function buildClawCfg(
  requireMention: boolean,
  mentionPatterns: string[],
  groupPolicy: string,
): Record<string, unknown> {
  return {
    channel_type: 'qqbot',
    channel_ver: CHANNEL_VER,
    claw_type: 'openclaw',
    claw_ver: getOpenClawVersion(),
    require_mention: requireMention ? 'mention' : 'always',
    group_policy: groupPolicy,
    mention_patterns: mentionPatterns.join(','),
    online_state: 'online',
  };
}

// ── Config 写入 ──

function setGroupRequireMention(
  runtime: PluginRuntime,
  accountId: string,
  groupOpenid: string,
  requireMention: boolean,
): Promise<void> {
  const adapters = getAdapters(runtime);
  return adapters.persistConfig?.((cfg: any) => {
    const qqbot = (cfg.channels ?? {})?.qqbot ?? {};
    const groups = accountId !== 'default' && qqbot.accounts?.[accountId]
      ? (qqbot.accounts[accountId].groups = { ...qqbot.accounts[accountId].groups })
      : (qqbot.groups = { ...qqbot.groups });
    groups[groupOpenid] = { ...groups[groupOpenid], requireMention };
  }) ?? Promise.resolve();
}
