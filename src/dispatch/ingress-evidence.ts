/**
 * 入站 admission evidence（channelIngress）解析 — issue #116
 *
 * openclaw 2026.11.5 起，core 给 `sessions_spawn` 加了 requester-provenance
 * 派发守卫（`Requester provenance requires trusted in-process Gateway dispatch.`）：
 * 带 requester 归属的派发要求本轮 context 持有「可信进程内 Gateway custody」。
 * custody 的来源是 buildContext 内绑定的 admission evidence——而 evidence 只有
 * 在入参携带 `channelIngress`（owner 绑定的 ingress resolution）时才 valid：
 *
 *   没传 channelIngress → evidence valid=false → resolver 不进 context
 *   → custody 缺失 → sessions_spawn 100% 失败
 *
 * 修法对齐 Telegram 参照实现（extensions/telegram 的 ingress.ts +
 * bot-message-context.session.ts）：每 turn resolve 出**新鲜**结果（单次移交
 * 约束：resolved 对象 `handoff.consumed` 只能消费一次，绝不跨消息复用），
 * 作为 `channelIngress` 传入 buildContext。所需 API（`channel.inbound.ingress.*`
 * 注入、`plugin-sdk/channel-ingress-runtime` 子路径）自 2026.10.5 起就存在——
 * 11.5 的新增物是 core 侧守卫，不是插件 API，故本修复跨 10.5–11.6 工作，
 * 无需抬 peer 地板。
 *
 * ## 多参与者（跨发言人合批）
 *
 * 群合批会把多条不同成员的消息并成一个 turn；evidence 若只记载体（最后一
 * 条）的 sender，requester provenance 就误归载体。core 原生支持参与者数组
 * （`prepareHostChannelContextAdmissionEvidence` 逐项校验，上限 16；合批去重
 * sender ≤ maxBatchSize=10）：**数组末项的 rawPrincipalRef 必须等于
 * buildContext 的 `sender.id`（= 载体 sender），其余项用各自的 stableId**。
 * 因此 participants 按「到达序去重、载体 sender 强制排最后」构造（由合批
 * 路径写入 `ctx.state.ingressParticipants`，dispatch 侧缺省回退单载体）。
 *
 * 契约对齐要点（dist/admission-evidence + host-context-builder 的
 * contextHandoffMatches / bindParticipants 逐字段校验，错一个字段 evidence 就
 * 静默降级、守卫依旧触发）：
 * - `contextBinding.{agentId,sessionKey,messageId,inboundEventKind}` 必须与
 *   buildContext 入参的 `route.agentId ?? 'default'` / `route.routeSessionKey` /
 *   `messageId` / `message.inboundEventKind ?? "user_request"` 逐字相等；
 * - `conversation {kind, id}` 与 buildContext 的 conversation 同形（无 thread 字段）；
 * - `subject.stableId`（末项）=== buildContext 的 `sender.id`（rawPrincipalRef 校验）；
 * - resolve `accountId` === buildContext 的 `route.accountId`（dispatch 侧已归一，
 *   两侧同源传入）；
 * - resolution 必须得出 allow（`ingress.admission === 'dispatch'`）才携带 custody。
 *
 * 完整叙事见 docs/agents/ingress-custody.md。
 */
import { defineStableChannelIngressIdentity } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import type { RuntimeAdapters } from '../adapter/resolve.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import { shortId, sessionKeyDigest } from '../utils/redaction.js';

/** 单次 ingress resolve 的等待上限（超时按「该参与者不可用」降级，不阻断派发） */
const INGRESS_RESOLVE_TIMEOUT_MS = 5000;

/**
 * 参与者证据数组的 core 上限（`CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS`，
 * 10.5/11.6 同值）。合批去重 sender 正常 ≤ maxBatchSize(10)，此为配置放宽/
 * 未来演进时的硬保险：超出时**保留最新 16 个**（载体恒在末位不受影响）。
 */
const MAX_EVIDENCE_PARTICIPANTS = 16;

/**
 * QQ openid 身份描述（对齐 telegram ingress identity 形态）。
 *
 * QQ 渠道的 stableId 是平台签发的 openid：同一 app 下每用户唯一、由平台认证
 * （非客户端自报），故 `authentication: 'verified'`；openid 属 PII，
 * `sensitivity: 'pii'` 供诊断脱敏。
 */
const qqbotIngressIdentity = defineStableChannelIngressIdentity({
  key: 'qqbot-openid',
  authentication: 'verified',
  normalize: (value: string) => {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  },
  sensitivity: 'pii',
});

/** 插件侧准入策略输入（与 access-control 中间件同源，policy-injector 注入） */
export interface IngressAccessPolicyInput {
  isGroup: boolean;
  /** c2c 模式：open | allowlist | pairing | disabled（默认 allowlist） */
  c2cMode: string;
  /** 群模式：open | allowlist | disabled（默认 allowlist；见 mapIngressPolicy 的语义错向说明） */
  groupMode: string;
  allowFrom: string[];
  groupAllowFrom: string[];
}

/** 映射后的 ingress resolve 策略参数（undefined = 不携带 evidence，降级） */
export interface IngressPolicyParams {
  dmPolicy: 'open' | 'allowlist' | 'pairing';
  /** 恒为 open：插件在服务群内没有 sender 级限制（见 mapIngressPolicy） */
  groupPolicy: 'open';
  allowFrom?: string[];
}

/** 过滤空白项；返回 undefined 表示无有效条目 */
function cleanEntries(entries: string[] | undefined): string[] | undefined {
  const cleaned = (entries ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 插件准入语义 → ingress resolve 策略映射。
 *
 * ## c2c（dmPolicy）
 *
 * 原则：**到达 dispatch 的消息都已被 access-control 放行**，evidence 必须如实
 * 反射同一裁决且得出 allowed（否则拿不到 dispatch custody）。access-control 的
 * 语义是「allowlist 且名单为空/含 `*` ⇒ 放行所有人」——直传空表给 resolver 会被
 * 判 not-allowlisted，故空/通配名单折叠为 `open`（语义等价，非放宽——那条消息
 * 本来就放行了）。`pairing` 直传：插件 pairing 走框架 pairing store
 * （adapter/pairing.ts 的 readChannelAllowFromStore），与 resolver 的默认
 * store 读取同库，已配对用户可被命中。`disabled` 理论上到不了 dispatch
 * （access-control 已拦），防御性整体降级。
 *
 * ## 群（groupPolicy 恒 'open'）
 *
 * ⚠️ **语义错向防护（评审自查）**：插件 `groupAllowFrom` 是「哪些**群**被服务」
 * 的群 id 白名单（access-control 按 `groupOpenid` 匹配，types.ts「群白名单」）；
 * 而 core resolver 的 `groupAllowFrom` 是「群内哪些 **sender** 被允许」。把插件的
 * 群 id 名单直传给 core 会让每个 sender 判 not-allowlisted —— 恰好让配置了群
 * 白名单的群全部拿不到 custody。插件在服务群内没有 sender 级限制（「哪些群被
 * 服务」已由 access-control 在 dispatch 前裁决），故群侧恒传 `open`、**永不传
 * groupAllowFrom**。代价：`groupPolicy:'open'` 下 evidence 的
 * `participantOutcomeAffecting` 为 false（wildcard 放行）——只影响 attribution
 * 丰富度，不影响 custody。
 */
export function mapIngressPolicy(input: IngressAccessPolicyInput): IngressPolicyParams | undefined {
  let dmPolicy: IngressPolicyParams['dmPolicy'] | undefined;
  let allowFrom: string[] | undefined;
  if (input.c2cMode === 'open') {
    dmPolicy = 'open';
  } else if (input.c2cMode === 'allowlist' || input.c2cMode === 'pairing') {
    const entries = cleanEntries(input.allowFrom);
    // 空/通配名单 = access-control 放行所有人 ⇒ 语义折叠为 open
    if (!entries || entries.includes('*')) {
      dmPolicy = 'open';
    } else {
      dmPolicy = input.c2cMode;
      allowFrom = entries;
    }
  }
  // c2cMode 'disabled' 或未知值（群消息时 c2c 分支不参与决策，走 open 兜底）
  if (!input.isGroup && dmPolicy === undefined) {
    return undefined;
  }

  return {
    dmPolicy: dmPolicy ?? 'open',
    groupPolicy: 'open',
    ...(allowFrom ? { allowFrom } : {}),
  };
}

/**
 * 读取本轮准入策略输入。
 *
 * 优先复用中间件链 policyInjector 注入的 `ctx.state.policy`（与 access-control
 * 的裁决同源），中间件链不存在时（单测直达 dispatch / 异常路径）就地按
 * policy-injector 的同一默认链从 account.config 复算。
 */
export function resolveAccessPolicyInput(
  ctx: { state?: unknown },
  account: { config?: unknown },
  isGroup: boolean,
): IngressAccessPolicyInput {
  const state = (ctx as { state?: Record<string, unknown> | undefined })?.state;
  const policy = state?.policy as Record<string, unknown> | undefined;
  const cfg = (account?.config ?? {}) as Record<string, unknown>;
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
  return {
    isGroup,
    c2cMode: String(policy?.c2cMode ?? cfg.dmPolicy ?? 'allowlist'),
    groupMode: String(policy?.groupMode ?? cfg.groupPolicy ?? 'allowlist'),
    allowFrom: asList(policy?.allowFrom ?? cfg.allowFrom),
    groupAllowFrom: asList(policy?.groupAllowFrom ?? cfg.groupAllowFrom),
  };
}

export interface ResolveIngressEvidenceParams {
  adapters: RuntimeAdapters;
  /** 路由绑定：binding.agentId 取 `route.agentId ?? 'default'`（对齐 ctx-builder） */
  route: {
    agentId?: string;
    sessionKey: string;
  };
  /** 已归一的 accountId（与 buildContext 的 route.accountId / 顶层 accountId 同源） */
  accountId: string;
  /** 载体消息 id（= buildContext 的 messageId） */
  messageId: string;
  isGroup: boolean;
  /** 与 ctx-builder 的 conversation.id 同源（dispatch 侧 resolveDispatchPeerId） */
  peerId: string;
  inboundEventKind: string;
  /**
   * 本 turn 的参与 sender 清单：到达序去重、**载体 sender 强制排最后**
   * （core 契约：数组末项的 rawPrincipalRef 必须等于 buildContext 的
   * sender.id）。合批路径写入 `ctx.state.ingressParticipants`；单条消息
   * 为 `[envelope.senderId]`。
   */
  participants: string[];
  policy: IngressAccessPolicyInput;
  /** 单次 resolve 等待上限（默认 5s；测试注入用） */
  timeoutMs?: number;
  log?: PluginLogger;
}

/** 有界等待：超时返回 undefined（迟到的结果被丢弃——handoff 未消费，无核心侧副作用） */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 为本轮 turn resolve 出 channelIngress admission evidence。
 *
 * 返回 undefined = 不携带 evidence（probe 缺失 / 策略映射降级 / 载体参与者失败
 * / 全部参与者失败），调用方照旧不传 `channelIngress`——绝不阻断入站派发。
 * 每个参与者都产生**新鲜** resolution（单次移交约束）；单参与者返回单对象，
 * 多参与者返回数组（core 两者都接受）。
 */
export async function resolveIngressEvidence(
  params: ResolveIngressEvidenceParams,
): Promise<unknown | undefined> {
  const resolve = params.adapters.resolveChannelMessageIngress;
  if (!resolve) {
    return undefined;
  }

  const mapped = mapIngressPolicy(params.policy);
  if (!mapped) {
    params.log?.debug(
      `[ingress-evidence] degraded (policy disabled/unknown): c2cMode=${params.policy.c2cMode}`,
    );
    return undefined;
  }

  const participants = params.participants.filter((s) => typeof s === 'string' && s.length > 0);
  if (participants.length === 0) {
    return undefined;
  }
  if (participants.length > MAX_EVIDENCE_PARTICIPANTS) {
    // core 拒绝超过上限的证据数组 ⇒ 超出部分静默丢 custody；保留最新 16 个
    // （载体恒在末位），最早的参与者被舍弃——批次正文仍完整，只是 provenance 少记
    const droppedCount = participants.length - MAX_EVIDENCE_PARTICIPANTS;
    participants.splice(0, droppedCount);
    params.log?.warn(
      `[ingress-evidence] participants capped to ${MAX_EVIDENCE_PARTICIPANTS} (dropped ${droppedCount} earliest, core array limit)`,
    );
  }

  // 契约：binding 四元组与 ctx-builder 传给 buildContext 的最终值逐字相等
  const contextBinding = {
    agentId: params.route.agentId ?? 'default',
    sessionKey: params.route.sessionKey,
    messageId: params.messageId,
    inboundEventKind: params.inboundEventKind,
  };

  const timeoutMs = params.timeoutMs ?? INGRESS_RESOLVE_TIMEOUT_MS;

  /**
   * 错误信息脱敏：resolver 的 err.message 可能内嵌参与者 openid / binding 的
   * sessionKey——INFO 以上日志不得落完整标识符（/bot-logs 原样导出本地日志）。
   * openid → shortId()，sessionKey → sha256 前 8 位。
   */
  const redactErrorDetail = (text: string, stableId: string): string =>
    text
      .split(stableId).join(shortId(stableId))
      .split(contextBinding.sessionKey).join(sessionKeyDigest(contextBinding.sessionKey));

  const resolveParticipant = async (stableId: string, budgetMs: number): Promise<unknown | undefined> => {
    try {
      const result = await withTimeout(
        resolve({
          channelId: 'qqbot',
          accountId: params.accountId,
          identity: qqbotIngressIdentity,
          subject: { stableId },
          conversation: {
            kind: params.isGroup ? 'group' : 'direct',
            id: params.peerId,
          },
          event: { kind: 'message', authMode: 'inbound', mayPair: !params.isGroup },
          contextBinding,
          policy: { dmPolicy: mapped.dmPolicy, groupPolicy: mapped.groupPolicy },
          ...(mapped.allowFrom ? { allowFrom: mapped.allowFrom } : {}),
        }),
        budgetMs,
      );
      if (result === undefined) {
        params.log?.warn(`[ingress-evidence] resolve timeout after ${budgetMs}ms (sender=${shortId(stableId)} dropped)`);
        return undefined;
      }
      // 只有 allow 决策（admission === 'dispatch'）才携带 custody；
      // 未 allow 时带上去也是 invalid evidence，降级并留痕 reasonCode 便于排障
      const decision = (result as { ingress?: { admission?: string; reasonCode?: string } } | null)?.ingress;
      if (decision?.admission !== 'dispatch') {
        params.log?.warn(
          `[ingress-evidence] ingress not admitted (reason=${decision?.reasonCode ?? 'unknown'}, sender=${shortId(stableId)}), `
          + 'participant dropped — sessions_spawn may be rejected on openclaw >= 2026.11.5',
        );
        return undefined;
      }
      return result;
    } catch (err) {
      params.log?.warn(
        `[ingress-evidence] resolve failed (sender=${shortId(stableId)}), participant dropped: ${
          redactErrorDetail(err instanceof Error ? err.message : String(err), stableId)
        }`,
      );
      return undefined;
    }
  };

  // 并发 resolve + **共享截止时间**：逐个串行 await 会让 N 个停滞参与者拖成
  // N×timeout 的总延迟（10 人批最坏 ~50s，群全程 busy）。所有参与者并发起跑，
  // 每人只分得「剩余预算」；Promise.all 保序，失败者为 undefined。
  const deadline = Date.now() + timeoutMs;
  const settled = await Promise.all(
    participants.map((stableId) => {
      const remaining = Math.max(0, deadline - Date.now());
      return resolveParticipant(stableId!, remaining);
    }),
  );

  const resolved: unknown[] = [];
  for (let i = 0; i < settled.length; i++) {
    const one = settled[i];
    if (one === undefined) {
      const isCarrier = i === settled.length - 1;
      // 末项（载体）必须匹配 buildContext 的 sender.id——缺了它数组必 invalid，
      // 整体降级（不如不带）；非载体失败只丢弃该项，剩余顺序不变、载体仍在末位
      if (isCarrier) {
        params.log?.warn('[ingress-evidence] carrier participant failed, dispatching without custody');
        return undefined;
      }
      continue;
    }
    resolved.push(one);
  }

  if (resolved.length === 0) {
    return undefined;
  }
  return resolved.length === 1 ? resolved[0] : resolved;
}
