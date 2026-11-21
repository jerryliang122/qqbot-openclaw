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
 * bot-message-context.session.ts）：每 turn 用 `channel.inbound.ingress.resolve`
 * resolve 出**新鲜**结果（单次移交约束：resolved 对象 `handoff.consumed` 只能
 * 消费一次，绝不跨消息复用），作为 `channelIngress` 传入 buildContext。
 *
 * 所需 API（`channel.inbound.ingress.*` 注入、`plugin-sdk/channel-ingress-runtime`
 * 子路径）自 2026.10.5 起就存在——11.5 的新增物是 core 侧守卫，不是插件 API，
 * 故本修复跨 10.5–11.6 工作，无需抬 peer 地板。
 *
 * 契约对齐要点（dist/admission-evidence + host-context-builder 的
 * contextHandoffMatches / bindParticipants 逐字段校验，错一个字段 evidence 就
 * 静默降级、守卫依旧触发）：
 * - `contextBinding.{agentId,sessionKey,messageId,inboundEventKind}` 必须与
 *   buildContext 入参的 `route.agentId ?? 'default'` / `route.routeSessionKey` /
 *   `messageId` / `message.inboundEventKind ?? 'user_request'` 逐字相等；
 * - `conversation {kind, id}` 与 buildContext 的 conversation 同形（无 thread 字段）；
 * - `subject.stableId` === buildContext 的 `sender.id`（rawPrincipalRef 校验）；
 * - resolver `accountId` === buildContext 的 `route.accountId ?? 顶层 accountId`；
 * - resolution 必须得出 allow（`ingress.admission === 'dispatch'`）才携带 custody。
 */
import { defineStableChannelIngressIdentity } from 'openclaw/plugin-sdk/channel-ingress-runtime';
import type { RuntimeAdapters } from '../adapter/resolve.js';
import type { PluginLogger } from '../utils/plugin-logger.js';

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
  /** 群模式：open | allowlist | disabled（默认 allowlist） */
  groupMode: string;
  allowFrom: string[];
  groupAllowFrom: string[];
}

/** 映射后的 ingress resolve 策略参数（undefined = 不携带 evidence，降级） */
export interface IngressPolicyParams {
  dmPolicy: 'open' | 'allowlist' | 'pairing';
  groupPolicy: 'open' | 'allowlist';
  allowFrom?: string[];
  groupAllowFrom?: string[];
}

/** 过滤空白项；返回 undefined 表示无有效条目 */
function cleanEntries(entries: string[] | undefined): string[] | undefined {
  const cleaned = (entries ?? []).map((e) => e.trim()).filter((e) => e.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 插件准入语义 → ingress resolve 策略映射。
 *
 * 原则：**到达 dispatch 的消息都已被 access-control 放行**，evidence 必须如实
 * 反射同一裁决且得出 allowed（否则拿不到 dispatch custody）。access-control 的
 * 语义是「allowlist 且名单为空/含 `*` ⇒ 放行所有人」——直传空表给 resolver 会被
 * 判 not-allowlisted，故空/通配名单折叠为 `open`（语义等价，非放宽——那条消息
 * 本来就放行了）。`pairing` 直传：插件 pairing 走框架 pairing store
 * （adapter/pairing.ts 的 readChannelAllowFromStore），与 resolver 的默认
 * store 读取同库，已配对用户可被命中。
 *
 * `disabled` 理论上到不了 dispatch（access-control 已拦），防御性返回 undefined
 * 走降级（不带 evidence，不阻断派发）。
 */
export function mapIngressPolicy(input: IngressAccessPolicyInput): IngressPolicyParams | undefined {
  // ── c2c（dmPolicy）──
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
  // c2cMode 'disabled' 或未知值 → dmPolicy 保持 undefined

  // ── 群（groupPolicy）──
  let groupPolicy: IngressPolicyParams['groupPolicy'] | undefined;
  let groupAllowFrom: string[] | undefined;
  if (input.groupMode === 'open') {
    groupPolicy = 'open';
  } else if (input.groupMode === 'allowlist') {
    const entries = cleanEntries(input.groupAllowFrom);
    if (!entries || entries.includes('*')) {
      groupPolicy = 'open';
    } else {
      groupPolicy = 'allowlist';
      groupAllowFrom = entries;
    }
  }
  // groupMode 'disabled' 或未知值 → groupPolicy 保持 undefined

  // 会话所在一侧的策略不可用（disabled/未知）→ 整体降级
  if (input.isGroup ? groupPolicy === undefined : dmPolicy === undefined) {
    return undefined;
  }

  return {
    // 上面的分支保证：isGroup 时 groupPolicy 已定义；非群时 dmPolicy 已定义，
    // 另一侧用 open 兜底（resolver 只按会话 kind 评估对应一侧）
    dmPolicy: dmPolicy ?? 'open',
    groupPolicy: groupPolicy ?? 'open',
    ...(allowFrom ? { allowFrom } : {}),
    ...(groupAllowFrom ? { groupAllowFrom } : {}),
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
  envelope: {
    chatScope: string;
    senderId: string;
    messageId: string;
  };
  route: {
    agentId?: string;
    sessionKey: string;
    accountId?: string;
  };
  /** route.accountId 缺失时的账号兜底（与 resolveAgentRoute 的入参同源） */
  fallbackAccountId: string;
  isGroup: boolean;
  /** 与 ctx-builder 的 conversation.id 同源（dispatch 侧 resolveDispatchPeerId） */
  peerId: string;
  inboundEventKind: string;
  policy: IngressAccessPolicyInput;
  log?: PluginLogger;
}

/**
 * 为本轮 turn resolve 出 channelIngress admission evidence。
 *
 * 返回 undefined = 不携带 evidence（probe 缺失 / 策略映射降级 / resolve 失败 /
 * 决策未 allow），调用方照旧不传 `channelIngress`——绝不阻断入站派发。
 * 每次调用都产生**新鲜** resolution（单次移交约束）。
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
      `[ingress-evidence] degraded (policy disabled/unknown): c2cMode=${params.policy.c2cMode} groupMode=${params.policy.groupMode}`,
    );
    return undefined;
  }

  // 契约：binding 四元组与 ctx-builder 传给 buildContext 的最终值逐字相等
  const contextBinding = {
    agentId: params.route.agentId ?? 'default',
    sessionKey: params.route.sessionKey,
    messageId: params.envelope.messageId,
    inboundEventKind: params.inboundEventKind,
  };

  let result: unknown;
  try {
    result = await resolve({
      channelId: 'qqbot',
      accountId: params.route.accountId ?? params.fallbackAccountId,
      identity: qqbotIngressIdentity,
      subject: { stableId: params.envelope.senderId },
      conversation: {
        kind: params.isGroup ? 'group' : 'direct',
        id: params.peerId,
      },
      event: { kind: 'message', authMode: 'inbound', mayPair: !params.isGroup },
      contextBinding,
      policy: { dmPolicy: mapped.dmPolicy, groupPolicy: mapped.groupPolicy },
      ...(mapped.allowFrom ? { allowFrom: mapped.allowFrom } : {}),
      ...(mapped.groupAllowFrom ? { groupAllowFrom: mapped.groupAllowFrom } : {}),
    });
  } catch (err) {
    params.log?.warn(
      `[ingress-evidence] resolve failed, dispatching without custody: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return undefined;
  }

  // 只有 allow 决策（admission === 'dispatch'）才携带 custody；
  // 未 allow 时带上去也是 invalid evidence，降级并留痕 reasonCode 便于排障
  const decision = (result as { ingress?: { admission?: string; reasonCode?: string } } | null)?.ingress;
  if (decision?.admission !== 'dispatch') {
    params.log?.warn(
      `[ingress-evidence] ingress not admitted (reason=${decision?.reasonCode ?? 'unknown'}), `
      + 'dispatching without custody — sessions_spawn may be rejected on openclaw >= 2026.11.5',
    );
    return undefined;
  }

  return result;
}
