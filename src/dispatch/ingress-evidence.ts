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
 * ## 生效前提（⚠️ 二轮评审 2026-11-22 坐实——插件侧无法单独保证）
 *
 * evidence → custody 的转换依赖 core 侧两个前提，**任一不满足时本模块产出
 * 的 evidence 会被 core 静默丢弃**（binding 是 `#binding` 私有字段，插件无
 * 法探测失败）：
 *
 * 1. **owner 绑定面只发给受信安装**（registry `resolveRecordChannelRuntime` 门禁）：
 *    `origin === 'bundled' || trustedOfficialInstall === true` 才注入 owner 绑定
 *    的 ingress 与 evidence 包装的 buildContext。自发布 npm 插件默认两者皆否——
 *    probe 命中的是**无 owner 的基础面**（resolve 存在、admission 照常计算，
 *    但 `recordChannelIngressResolution` owner=undefined ⇒ 裸 result，buildContext
 *    也忽略 channelIngress 入参）。
 * 2. **plugin record id 必须等于 channel id**：core 按**插件 record id**（不是
 *    channel id）建 owner（`channelId: e.id`），而 handoff 校验要求 binding 的
 *    channelId === buildContext 的 `channel`。⇒ 2026-11-22 起插件 id 已与
 *    channel id 对齐为 `qqbot`（manifest + package.json + webhook 路由），此前
 *    `openclaw-qqbot` ≠ `qqbot` 的形态两个要求互斥、无解；bundled Telegram 的
 *    插件 id 恰好就是 `telegram`，所以只有它工作。
 *
 * ⇒ 前提 1（owner 面门禁）仍开放：在 core 向非 bundled/trusted 安装开放
 * owner 面之前，本模块是「上游依赖下的插件侧预备」：机制、契约、策略映射、
 * 降级语义全部就位且被测试锁定；core 侧前提落地后即生效。上游对齐方案见
 * docs/agents/ingress-custody.md「生效前提与上游依赖」。
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
  allowFrom: string[];
}

/** 映射后的 ingress resolve 策略参数（undefined = 不携带 evidence，降级） */
export interface IngressPolicyParams {
  dmPolicy: 'open' | 'allowlist' | 'pairing';
  /** 恒为 open：core 的群 open 是无条件放行（senderGateForGroup）；插件在服务群内没有 sender 级限制 */
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
 * ## c2c（dmPolicy）——对齐 core `senderGateForDirect` 的真实判定
 *
 * 原则：**到达 dispatch 的消息都已被 access-control 放行**，evidence 必须如实
 * 反射同一裁决且得出 allowed（否则拿不到 dispatch custody）。
 *
 * ⚠️ **core 的 dm `open` 不是「放行所有人」**（二轮评审核实，2026-11-22）：
 * `senderGateForDirect` 对 `dmPolicy:'open'` 仍要求 `allowFrom` 带通配符或命中
 * （`hasWildcard → allow` / `matched → allow` / 否则 `dm_policy_not_allowlisted`）；
 * 只有**群** `open` 是无条件放行。因此 access-control 的「空名单/含 `*` ⇒ 放行
 * 所有人」语义折叠到 dm 侧时，**必须同时传 `allowFrom: ['*']`**（让 core 的
 * `hasWildcard` 成立）——只折叠 policy 不带名单，默认配置（allowlist+空名单）
 * 会被判 not-allowlisted、c2c 静默丢 custody。
 *
 * `pairing` **永不折叠**：core 的 `mergeDmAllowFromSources` 在 dmPolicy 为
 * open/allowlist 时直接丢弃 pairing store（`? [] : storeAllowFrom`）——折叠会
 * 让「静态名单为空的配对模式」（最常见配对配置）丢掉 store 命中。保留
 * 'pairing' 让 store 与静态名单共同生效（插件 pairing 走框架 pairing store，
 * 与 resolver 默认 store 读取同库，已配对用户可被命中）。
 *
 * `disabled` 理论上到不了 dispatch（access-control 已拦），防御性整体降级。
 *
 * ## 群（groupPolicy 恒 'open'）
 *
 * ⚠️ **语义错向防护（一轮评审自查）**：插件 `groupAllowFrom` 是「哪些**群**被
 * 服务」的群 id 白名单（access-control 按 `groupOpenid` 匹配）；core resolver
 * 的 `groupAllowFrom` 是「群内哪些 **sender** 被允许」。直传会让每个 sender 判
 * not-allowlisted。插件在服务群内没有 sender 级限制（「哪些群被服务」已由
 * access-control 在 dispatch 前裁决），故群侧恒传 `open`（core 群 open =
 * 无条件放行）、**永不传 groupAllowFrom**。代价：群 evidence 的
 * `participantOutcomeAffecting` 为 false——只影响 attribution 丰富度。
 */
export function mapIngressPolicy(input: IngressAccessPolicyInput): IngressPolicyParams | undefined {
  let dmPolicy: IngressPolicyParams['dmPolicy'] | undefined;
  let allowFrom: string[] | undefined;
  if (input.c2cMode === 'open') {
    // core dm open 仍要求通配符命中——「放行所有人」必须带 ['*']
    dmPolicy = 'open';
    allowFrom = ['*'];
  } else if (input.c2cMode === 'allowlist') {
    const entries = cleanEntries(input.allowFrom);
    // 空/通配名单 = access-control 放行所有人 ⇒ 折叠 open，但必须随行 ['*']
    if (!entries || entries.includes('*')) {
      dmPolicy = 'open';
      allowFrom = ['*'];
    } else {
      dmPolicy = 'allowlist';
      allowFrom = entries;
    }
  } else if (input.c2cMode === 'pairing') {
    // 永不折叠：core 只在 dmPolicy='pairing' 下合并 pairing store
    dmPolicy = 'pairing';
    const entries = cleanEntries(input.allowFrom);
    if (entries) allowFrom = entries;
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
    allowFrom: asList(policy?.allowFrom ?? cfg.allowFrom),
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

/** 有界等待：超时返回 timeoutValue（迟到的结果被丢弃——handoff 未消费，无核心侧副作用） */
async function withTimeout<T, V>(promise: Promise<T>, ms: number, timeoutValue: V): Promise<T | V> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<V>((resolve) => {
    timer = setTimeout(() => resolve(timeoutValue), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 每进程只打一次「evidence 已挂载」的可观测性 INFO（运维信号，见叙事「生效前提」） */
let custodyAttachedNoticeLogged = false;

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
   * 错误信息脱敏（二轮评审补强）：resolver 的 err.message 可能内嵌**任意**
   * 参与者 openid、binding 的 sessionKey、或会话对端的裸 openid（群轮次的
   * sessionKey 里就含群 openid）——INFO 以上日志不得落完整标识符
   * （/bot-logs 原样导出本地日志）。全部纳入替换：openid → shortId()，
   * sessionKey → sha256 前 8 位。
   */
  const sensitiveIds = [
    contextBinding.sessionKey,
    params.peerId,
    ...participants,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const redactErrorDetail = (text: string): string => {
    let out = text;
    for (const id of sensitiveIds) {
      if (out.includes(id)) out = out.split(id).join(shortId(id));
    }
    return out.split(contextBinding.sessionKey).join(sessionKeyDigest(contextBinding.sessionKey));
  };

  const resolveParticipant = async (stableId: string, budgetMs: number): Promise<unknown | undefined> => {
    try {
      // 哨兵区分「超时」与「resolver 合法返回 undefined」——两者都降级，
      // 但日志语义不同（排障时避免把空返回误读为超时）
      const TIMEOUT = Symbol('ingress-resolve-timeout');
      const raced = await withTimeout(
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
        }).then(
          (value) => ({ timeout: false as const, value }),
          (err) => ({ timeout: false as const, err }),
        ),
        budgetMs,
        TIMEOUT,
      );
      if (raced === TIMEOUT || raced === undefined) {
        params.log?.warn(`[ingress-evidence] resolve timeout after ${budgetMs}ms (sender=${shortId(stableId)} dropped)`);
        return undefined;
      }
      if ('err' in raced) throw raced.err;
      const result = raced.value;
      if (result === undefined || result === null) {
        params.log?.warn(`[ingress-evidence] resolver returned empty (sender=${shortId(stableId)} dropped)`);
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
          redactErrorDetail(err instanceof Error ? err.message : String(err))
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

  // 一次性运维信号：evidence「已生成并挂到 buildContext」≠「custody 已生效」——
  // 生效还依赖 core 侧前提（owner 绑定面：bundled/trusted-official 安装 + plugin id
  // 与 channel id 一致），插件侧无法探测（binding 是私有字段）。见叙事「生效前提」。
  if (!custodyAttachedNoticeLogged) {
    custodyAttachedNoticeLogged = true;
    params.log?.info(
      `[ingress-evidence] admission evidence attached (participants=${resolved.length}) — `
      + 'custody 仅在 core 提供 owner 绑定面时生效（bundled/trusted-official 安装且 plugin id === channel id），'
      + '若 sessions_spawn 仍被拒见 docs/agents/ingress-custody.md「生效前提」',
    );
  }

  return resolved.length === 1 ? resolved[0] : resolved;
}
