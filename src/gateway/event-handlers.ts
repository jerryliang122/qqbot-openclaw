/**
 * QQBotGateway 事件处理
 *
 * 处理 SDK 的 message / interaction 事件：
 * - message: 中间件处理完毕后，将消息转发到 OpenClaw AI
 * - interaction: 配置更新 / 审批按钮 / ask_user 按钮 /
 *   平台扩展互动类型观测（消息反馈、清空会话、主动推送授权等，2026-07 扩容）
 */

import type { MiddlewareContext, QQBotInboundMessage, InteractionEvent } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';
import type { ResolvedQQBotAccount, InteractionAuthorizeData } from '../types.js';
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
  recordSequentialAnswer,
  getPendingMultiQuestionState,
  findPendingMultiQuestionByConversation,
  buildSequentialFullAnswerDraft,
  markMultiQuestionResolveFailed,
  markSingleQuestionResolved,
  getPendingMultiQuestions,
  getPendingMultiQuestionAnchor,
  buildMultiQuestionAnswerText,
  formatMultiQuestionConfirmCard,
  buildMultiQuestionConfirmKeyboard,
  type MultiQuestionAnswer,
} from '../features/question-helpers.js';
import { sendSequentialQuestionCard, submitSequentialAnswers } from '../features/question-flow.js';
import { recordKnownUser } from '../features/proactive.js';
import { cacheMsgId } from '../features/msgid-cache.js';
import { enqueueC2CInboundMessage } from '../features/inbound-debounce.js';
import { enqueueGroupInboundMessage } from '../features/group-merge.js';
import { recordGroupEvent, getGroupModeFacts } from '../features/group-mode-store.js';
import { recordPushAuthorizeEvent } from '../features/push-authorization-store.js';
import { getAdapters } from '../adapter/resolve.js';
import { resolveGroupConfigFromAccount, resolveGroupConfigKey, resolveGroupPolicy, resolveMentionPatterns } from '../config.js';
import { getPackageVersion } from '../utils/pkg-version.js';
import { getOpenClawVersion } from '../bot-instance.js';
import { sendQuestionMessage } from '../outbound/question-send.js';
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

  hlog.debug(`enter msgId=${msg.messageId} scope=${scope} contentLen=${(msg.content ?? '').length}`);

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

    // 被动锚点登记：时钟用平台事件 timestamp（窗口起点锚定平台时间；
    // 比对仍用本地时钟，本地与平台偏差会等量放宽/收紧判定），
    // 缺失/不可解析时回退本地时钟；同时预注册配额窗口（receivedAt 起算）
    const platformTsMs = Date.parse(msg.timestamp);
    cacheMsgId(scope, msg.replyTarget.targetId, msg.messageId, {
      accountId: account.accountId,
      receivedAt: Number.isNaN(platformTsMs) ? Date.now() : platformTsMs,
    });

    recordKnownUser({
      type: scope === 'group' ? 'group' : 'c2c',
      openid: scope === 'group' ? msg.replyTarget.targetId : msg.senderId,
      accountId: account.accountId,
      nickname: msg.senderName,
      lastInteractionAt: Date.now(),
    });

    // ── 多问题 ask_user 的最终答案不在此拦截 ──
    // c2c 顺序发题：答案由入队口的拦截层消费并直提（见 inbound-debounce.ts
    // 的 planSequentialTextCapture），本层不碰。
    // 群聊 legacy：确认卡的指令按钮代发（或用户手打）的 "1: 3\n2: 1" 是
    // 真实用户消息，必须原样放行走框架原生 keyed 文本认领；任何拦截都会
    // 破坏认领链路。

    // ── 入站防抖/合批 ──
    // 私聊：同一发送者在防抖窗口内的连续消息合并为一次 dispatch（文件 +
    // 伴随文字 → 单个 turn，修复"后到文字把文件 turn 打断"的结构缺陷）。
    // 群聊：插件侧合批——该群 agent 正在工作时到达的消息（含**不同发言人**）
    // 攒成一批，turn 结束后一次性发给框架。框架的 collect 队列做不到跨
    // 发言人合并（分组键含 senderId 且遇首个不同键即断），故插件侧自建。
    // 两种情况未接管（关闭 / 非目标 scope / 旁路已直发）时走原直发路径。
    // 上方的 per-message 记账（被动锚点登记 / recordKnownUser）不受影响。
    const dispatchNow = () =>
      runWithRequestContext(
        {
          accountId: account.accountId,
          messageId: msg.messageId,
          openId: msg.senderId,
          target: targetId,
        },
        () => dispatchToOpenClaw(ctx, msg, account, runtime, log),
      );

    if (scope === 'c2c') {
      const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime, hlog);
      if (!handled) await dispatchNow();
    } else {
      const handled = await enqueueGroupInboundMessage(ctx, msg, account, runtime, hlog);
      if (!handled) await dispatchNow();
    }
  } catch (err) {
    hlog.error(`dispatch error: ${err}`);
  }
  hlog.debug(`done msgId=${msg.messageId}`);
}

const INTERACTION_QUERY  = 2001;
const INTERACTION_UPDATE = 2002;

/**
 * 官方 INTERACTION_CREATE 互动类型（外层 type 与 data.type 一致，2026-07 文档扩容）。
 * 仅 11/12 是按钮/菜单回调（需要 ack + 走按钮处理链），13-20 为观测信号（无需 ack）。
 */
const INTERACTION_TYPE = {
  INLINE_KEYBOARD: 11,        // 消息按钮回调（需 ack）
  CALLBACK_COMMAND: 12,       // 单聊快捷菜单回调（需 ack）
  MESSAGE_FEEDBACK: 13,       // 消息反馈（点赞/点踩）
  CLEAR_SESSION: 14,          // 清空会话（QQ 官方智能体平台）
  IN_OUT_STORY: 15,           // 进出故事集（QQ 官方智能体平台）
  SWITCH_MODEL: 16,           // 切换模型（QQ 官方智能体平台）
  USER_AUTHORIZE: 18,         // 用户主动推送授权
  GROUP_AUTHORIZE: 19,        // 群主动推送授权
  GROUP_AUTHORIZE_STATUS: 20, // 群授权状态变更
} as const;

/**
 * SDK 类型尚未覆盖的 resolved 扩展字段（官方文档 InteractionResolved）。
 * 经 `as` 投影访问，SDK 升级补齐类型后可移除。
 * authorize_data 引用公开类型 InteractionAuthorizeData，防两处定义漂移。
 */
interface ExtendedInteractionResolved {
  /** 反馈选项（type=13）：LIKE=点赞, UNLIKE=点踩 */
  feedback_opt?: string;
  /** 反馈选项是否选中（type=13） */
  checked?: number;
  /** 操作类型（type=15/16 智能体平台事件） */
  action?: string;
  /** 消息场景信息（type=13） */
  message_scene?: { ext?: string[] };
  /** 授权数据（type=18/19/20） */
  authorize_data?: InteractionAuthorizeData;
  /** 操作用户 ID（频道场景；SDK 类型已有，投影保持访问面一致） */
  user_id?: string;
  /** 操作的消息 ID（消息反馈场景为机器人消息 ID） */
  message_id?: string;
}

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
    } catch (err) {
      log.warn(`interaction update ack failed: ${err instanceof Error ? err.message : String(err)}`);
      try {
        await acknowledgeInteraction(event.id);
      } catch (retryErr) {
        log.debug(`interaction update ack retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
      }
    }
    return;
  }

  // 平台扩展互动类型（反馈/会话/智能体平台/推送授权）：无需 ack，不进按钮回调链。
  // 此前它们掉进 approval 分支被无意义 ack 后静默丢弃——授权事件与主动消息
  // 预算直接相关（群推送平台侧默认关闭），排障需要留痕。
  if (event.type !== INTERACTION_TYPE.INLINE_KEYBOARD && event.type !== INTERACTION_TYPE.CALLBACK_COMMAND) {
    handlePlatformInteraction(event, account, log);
    return;
  }

  // question 按钮（ask_user）优先于审批按钮：
  // - `qqbot:q:` 单问题选项
  // - `qqbot:qm:` 多问题选项
  const buttonData = event.data?.resolved?.button_data;
  if (
    buttonData?.startsWith('qqbot:q:') ||
    buttonData?.startsWith('qqbot:qm:')
  ) {
    await handleQuestion(event, account, runtime, log, acknowledgeInteraction);
    return;
  }

  await handleApproval(event, account, runtime, log, acknowledgeInteraction);
}

/**
 * 平台扩展互动类型的观测处理（type 13-20 及未来新增）。
 * 纯观测：留痕 + 授权事件入 store，不 ack（官方文档：仅 11/12 需要 ack），
 * 不产生任何出站动作。
 *
 * 日志中的标识符统一截断为前 8 字符（openid 32 位 hex，前缀已足够定位排障；
 * 对齐 /bot-group-info 的展示惯例）——INFO 日志可被 /bot-logs 导出给 c2c
 * 用户（默认 allowFrom 为空即开放），不落完整他人标识符。
 */
function shortId(id: string | undefined): string {
  if (!id) return '?';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function handlePlatformInteraction(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  log: PluginLogger,
): void {
  const resolved = (event.data?.resolved ?? {}) as ExtendedInteractionResolved;
  const operator = event.group_member_openid
    ?? event.user_openid
    ?? resolved.user_id
    ?? 'unknown';
  const peerId = event.group_openid ?? event.user_openid ?? '';

  switch (event.type) {
    case INTERACTION_TYPE.MESSAGE_FEEDBACK:
      log.info(`[interaction] feedback opt=${resolved.feedback_opt ?? '?'} checked=${resolved.checked ?? '?'} msg=${shortId(resolved.message_id)} operator=${shortId(operator)}`);
      return;
    case INTERACTION_TYPE.CLEAR_SESSION:
    case INTERACTION_TYPE.IN_OUT_STORY:
    case INTERACTION_TYPE.SWITCH_MODEL:
      // QQ 官方「智能体」平台事件，自建 bot 正常收不到；留痕即可
      log.info(`[interaction] agent-platform event type=${event.type} action=${resolved.action ?? '?'} operator=${shortId(operator)}`);
      return;
    case INTERACTION_TYPE.USER_AUTHORIZE:
    case INTERACTION_TYPE.GROUP_AUTHORIZE:
    case INTERACTION_TYPE.GROUP_AUTHORIZE_STATUS: {
      const authorize = resolved.authorize_data ?? {};
      if (peerId) {
        const tsMs = event.timestamp ? Date.parse(event.timestamp) : NaN;
        recordPushAuthorizeEvent(account.accountId, peerId, {
          eventType: event.type,
          scope: authorize.scope ?? '',
          optScene: authorize.opt_scene ?? '',
          eventTimestampMs: tsMs,
        });
      }
      log.info(
        `[push-auth] type=${event.type} scene=${event.scene ?? '?'} peer=${shortId(peerId)} scope=${authorize.scope ?? '?'} opt_scene=${authorize.opt_scene ?? '?'} operator=${shortId(operator)}`,
      );
      return;
    }
    default:
      // 未来新增类型：留痕不猜测语义，也不 ack
      log.info(`[interaction] unhandled interaction type=${event.type} scene=${event.scene ?? '?'}`);
  }
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
    try {
      await ack(event.id);
    } catch (retryErr) {
      log.debug(`interaction query ack retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
    }
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
  try { await ack(event.id); } catch (err) {
    log.debug(`[approval] initial ack failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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
    // ⚠️ 日志脱敏：operatorId 就是点击者的完整 openid，而 `/bot-logs` 会把
    // 本地日志文件原样导出给 c2c 用户 ⇒ 一律走 shortId()（本文件顶部约定：
    // 不落完整他人标识符）。
    log.warn(`[approval] unauthorized operator=${shortId(operatorId)} account=${account.accountId}${authorization.reason ? ` reason=${authorization.reason}` : ''}`);
    return;
  }

  log.info(
    `[approval] tap operator=${shortId(operatorId)} approvalId=${parsed.approvalId} kind=${parsed.approvalKind} decision=${parsed.decision} account=${account.accountId}`,
  );

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
    log.info(
      `[approval] resolved approvalId=${parsed.approvalId} decision=${parsed.decision} operator=${shortId(operatorId)}`,
    );
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
  try { await ack(event.id); } catch (err) {
    log.debug(`[question] initial ack failed: ${err instanceof Error ? err.message : String(err)}`);
  }

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
    const result = await questionGatewayRuntime.resolveOption({
      cfg,
      questionId: parsed.questionId,
      optionIndex: parsed.optionIndex,
      senderId: operatorId,
      clientDisplayName: 'QQBot question',
    });
    // 单问题已作答 ⇒ 撤掉 c2c 旁路登记（该会话恢复防抖合并）
    if (result.status === 'answered' || result.status === 'already-terminal') {
      markSingleQuestionResolved(parsed.questionId);
    }
    log.info(
      `[question] resolved questionId=${parsed.questionId} optionIndex=${parsed.optionIndex} status=${result.status} operator=${shortId(operatorId)}`,
    );
  } catch (err) {
    log.error(`[question] resolve error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 多问题按钮处理（ask_user questions >= 2）──
// 框架对多问题记录没有单题按钮解析通道（resolveOption 仅支持单问题），
// 这里按题缓冲点选。两条路径：
// - **c2c 顺序发题**（`mode === 'sequential'`）：逐题发卡、逐题收集，
//   全部答齐后由插件**组合整单文本**并调框架官方认领通道
//   （`claimPendingAgentQuestionAnswer`）整单 resolve——用户聊天里不再
//   出现 `1: 3\n2: 1` 的机器气泡；
// - **群聊 legacy**：所有题卡一次发出 + 集齐后确认卡（指令按钮代发真实
//   用户消息，走框架原生的 keyed 文本认领通道）。
//
// 注意两条红线（都出过生产事故，勿回退）：
// 1. 不要程序化提交**答案内容**（插件没有 `operator.questions` scope，
//    且**禁止代替用户作答**）——插件只搬运用户真实作答的组合文本；
// 2. 不要合成入站消息"假装用户回答"：合成消息会被框架当成 steering
//    注入挂起的 run，claim 不触发，模型等答案直到超时（2026-08-24 事故）。

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
    `[question] multi tap id=${parsed.questionId} q=${parsed.questionIndex + 1} opt=${parsed.optionIndex + 1} operator=${shortId(operatorId)}`,
  );

  // ── 归属校验（红线）────────────────────────────────────────────────
  // 卡片被复制/转发到别的会话时，**点击者是别人**（event.user_openid 是
  // 点击者，不是卡片的主人）。若只按 questionId 找 pending，别人的点选会
  // 记进**原用户**的答案表，甚至把原用户的问题 resolve 掉。
  // ⇒ 记录/提交答案前必须核对：账号、会话类型、对端三者与 pending 一致。
  const owner = getPendingMultiQuestionState(parsed.questionId);
  if (
    !owner
    || owner.accountId !== account.accountId
    || owner.scope !== scope
    || owner.targetId !== peerId
  ) {
    // ⚠️ 日志脱敏：targetId / peerId 在 c2c 下就是**完整对端 openid**，
    // 而 INFO 日志可被 `/bot-logs` 导出给 c2c 用户 ⇒ 一律走 shortId()
    // （本文件顶部的约定：不落完整他人标识符）。
    log.info(
      `[question] multi tap rejected (owner mismatch) id=${parsed.questionId}`
      + ` owner=${owner ? `${owner.accountId}/${owner.scope}/${shortId(owner.targetId)}` : 'unknown'}`
      + ` tapper=${account.accountId}/${scope}/${shortId(peerId)}`,
    );
    // 不回执「已提交或已过期」——那会向点击者暴露该问题存在。静默忽略。
    return;
  }

  // ── c2c 顺序发题（PR2）──
  // 点选只**收集**答案（框架要求整单齐备，见 issue #93 根因 2），下一张
  // 题卡由这里续发；**全部答齐时直接提交**——插件组合整单文本并调框架
  // 官方认领通道（`claimPendingAgentQuestionAnswer`），不再依赖客户端
  // 代发机器文本。
  const state = getPendingMultiQuestionState(parsed.questionId);
  if (state?.mode === 'sequential') {
    const result = recordSequentialAnswer(
      parsed.questionId,
      parsed.questionIndex,
      parsed.optionIndex,
    );
    if (result.status === 'terminal') {
      // pending 已终态（已提交 / 已被框架结束）⇒ **静默忽略**。
      // 平台会重推 interaction 事件，回执会造成对用户刷屏。
      log.info(`[question] sequential tap ignored (terminal) id=${parsed.questionId}`);
      return;
    }
    if (result.status === 'resolving') {
      // 正在提交（框架认领 await 未返回）⇒ 这一单**不再收答案**
      // （否则会覆盖正在提交的那份答案）。回执告知用户在途，
      // 别让他对着「没反应的卡片」反复点。
      log.info(`[question] sequential tap ignored (resolving) id=${parsed.questionId}`);
      await sendMultiQuestionFeedback(event, account, '正在提交答案，请稍候', log, parsed.questionId);
      return;
    }
    if (result.status !== 'ok') {
      log.info(`[question] sequential tap ignored id=${parsed.questionId} status=${result.status}`);
      await sendMultiQuestionFeedback(event, account, '该问题已提交或已过期', log, parsed.questionId);
      return;
    }
    const nextState = getPendingMultiQuestionState(parsed.questionId);
    if (!nextState) return;

    // 全部答齐 ⇒ 组合 + 提交（不再发卡）
    if (nextState.answers.size === nextState.questions.length) {
      await submitSequentialAnswers({
        state: nextState,
        account,
        to: formatQuestionTarget(scope, peerId),
        log,
      });
      return;
    }

    // 发卡前二次复查：期间可能已被另一条入站（或并发点选）提交掉了 ⇒
    // 续卡会成为「已作废的卡片」（按钮点不动、看着莫名其妙）⇒ 不发。
    // `findPendingMultiQuestionByConversation` 对终态 / 提交中 / 已过期都返回
    // undefined ⇒ 一并覆盖「已被提交」与「正在提交」两种情况。
    const armed = findPendingMultiQuestionByConversation(account.accountId, scope, peerId);
    if (!armed || armed.questionId !== parsed.questionId) {
      log.info(`[question] sequential card skipped (no longer armed) id=${parsed.questionId}`);
      return;
    }

    const cardResult = await sendSequentialQuestionCard({
      state: nextState,
      index: result.nextIndex,
      account,
      to: formatQuestionTarget(scope, peerId),
      log,
    });
    if (cardResult.error) {
      // 续卡发送失败必须回执（镜像旧确认卡口径，评审 F1）：否则用户点选后
      // 石沉大海——中间题卡正文不含 keyed 手打格式，没有自救入口。回执带
      // 全量手打草稿（已答填值、未答留空）；回执本身尽力而为（发送可能
      // 仍在失败，sendMultiQuestionFeedbackText 内部吞错仅 DEBUG 留痕）。
      await sendMultiQuestionFeedbackText(
        scope,
        peerId,
        account,
        `⚠️ 下一题发送失败，请稍后重新点选重试；或直接回复完整答案`
          + `（每行「题号: 答案」，选项填序号）：\n`
          + buildSequentialFullAnswerDraft(nextState.answers, nextState.questions.length),
        log,
        parsed.questionId,
      );
    }
    return;
  }

  // ── 群聊旧形态：全部题卡 + 集齐后的确认卡 ──
  const tap = recordMultiQuestionTap(parsed.questionId, parsed.questionIndex, parsed.optionIndex);

  if (tap.status === 'unknown' || tap.status === 'terminal') {
    log.info(`[question] multi tap ignored id=${parsed.questionId} status=${tap.status}`);
    await sendMultiQuestionFeedback(event, account, '该问题已提交或已过期', log, parsed.questionId);
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
      log,
      parsed.questionId,
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
 *
 * 出站走**被动回复**：锚点 = 登记 pending 时记下的本轮 inbound msg_id
 * （与问题卡同一个锚点）——不耗每日主动预算，用户关闭「允许主动发送」
 * 时也能收到；锚点不可用（TTL 过期 / 平台判死）时自动降级为主动。
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

  const result = await sendQuestionMessage({
    account,
    accountId: account.accountId,
    to: formatQuestionTarget(scope, peerId),
    text: cardText,
    keyboard: buildMultiQuestionConfirmKeyboard(answerText) as never,
    anchorMsgId: getPendingMultiQuestionAnchor(questionId),
    log,
  }).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  // 复位锁，允许继续改答案（无论发送成功与否——锁的作用是防并发提交）
  markMultiQuestionResolveFailed(questionId);
  if (result.error) {
    log.error(`[question] confirm card send error id=${questionId}: ${result.error}`);
    await sendMultiQuestionFeedbackText(scope, peerId, account, '⚠️ 提交卡发送失败，请直接文字回复答案', log, questionId);
    return;
  }
  log.info(`[question] confirm card sent id=${questionId} answers=${JSON.stringify(answerText)}`);
}

/** 尽力而为的状态回执，失败仅记日志不影响主流程 */
async function sendMultiQuestionFeedback(
  event: InteractionEvent,
  account: ResolvedQQBotAccount,
  text: string,
  log?: PluginLogger,
  questionId?: string,
): Promise<void> {
  const scope = event.group_openid ? 'group' as const : 'c2c' as const;
  const targetId = event.group_openid ?? event.user_openid;
  if (!targetId) return;
  await sendMultiQuestionFeedbackText(scope, targetId, account, text, log, questionId);
}

async function sendMultiQuestionFeedbackText(
  scope: 'c2c' | 'group',
  targetId: string,
  account: ResolvedQQBotAccount,
  text: string,
  log?: PluginLogger,
  questionId?: string,
): Promise<void> {
  // 锚点 = pending 登记的本轮 inbound msg_id（无锚点 ⇒ 主动发送）
  const anchorMsgId = questionId ? getPendingMultiQuestionAnchor(questionId) : undefined;
  try {
    const result = await sendQuestionMessage({
      account,
      accountId: account.accountId,
      to: formatQuestionTarget(scope, targetId),
      text,
      ...(anchorMsgId ? { anchorMsgId } : {}),
      log,
    });
    if (result.error) {
      // 回执是锦上添花，吞掉即可（仅 DEBUG 留痕）
      log?.debug(`[question] feedback send failed scope=${scope}: ${result.error}`);
    }
  } catch (err) {
    log?.debug(`[question] feedback send threw scope=${scope}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** ask_user 出站目标串（与 dispatch 的 qualifiedTarget 同构） */
function formatQuestionTarget(scope: 'c2c' | 'group', targetId: string): string {
  return scope === 'group' ? `qqbot:group:${targetId}` : `qqbot:c2c:${targetId}`;
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
    // 写入前先解析现有键（精确 > lowercase 等值）：命中变体键则原地更新，
    // 避免 @消息事件的大小写形态与配置键不一致时制造第二个变体键
    // （双键会与读取侧 lookupGroupEntry 的精确优先语义互相踩踏，
    // 且展开 groups[原始id] 会丢失原条目其余字段）
    const targetKey = resolveGroupConfigKey(groups, groupOpenid) ?? groupOpenid;
    groups[targetKey] = { ...groups[targetKey], requireMention };
  }) ?? Promise.resolve();
}
