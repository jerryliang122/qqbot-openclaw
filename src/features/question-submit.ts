/**
 * 多题 ask_user 的**整单提交器**（插件直提通道）。
 *
 * ── 为什么存在 ───────────────────────────────────────────────────────
 * 顺序发题（c2c）收集齐全部答案后，需要把「题号: 值」的整单文本交给框架，
 * 让挂起的 ask_user 醒来。框架为此提供了官方认领通道：
 * `claimPendingAgentQuestionAnswer({ sessionKey, text })`
 * （`openclaw/plugin-sdk/agent-harness-runtime`）。
 *
 * 它与框架自己的入站认领走**同一套解析**（`buildAgentHarnessUserInputAnswers`）
 * 与**同一套校验**（`validateAnswers`：每题非空）⇒ 插件组合的文本与用户
 * 手打的文本在框架侧等价，不会出现「两侧口径不一致」。
 *
 * ── 红线 ─────────────────────────────────────────────────────────────
 * - **禁止代替用户作答**：传给本模块的答案值必须来自用户的真实输入
 *   （按钮点选 / 手打文本），插件只负责**搬运**与**组合**；
 * - **禁止合成入站消息**：本模块不构造任何入站事件，只调框架的认领通道
 *   （合成消息会被框架 steer 进 ask_user-suspended run，2026-08-24 事故）。
 *
 * ── 已知后果 ─────────────────────────────────────────────────────────
 * 直提不经入站路径 ⇒ 用户那条消息不会作为 user turn 落进会话历史
 * （模型仍通过 ask_user 的 tool result 拿到答案）。
 */

import type { PluginLogger } from '../utils/plugin-logger.js';

// ============ 结果类型 ============

export type MultiQuestionSubmitResult =
  /** 框架已受理答案（claim 返回 true）——挂起的 ask_user 被 resolve */
  | { status: 'submitted' }
  /** claim 返回 false：没有挂起记录 / 已终态 / 已取消 / 正在解析 */
  | { status: 'already-resolved' }
  /** 答案非法（框架 INVALID_REQUEST / QUESTION_INVALID_ANSWER） */
  | { status: 'invalid'; reason: string }
  /** 其它异常（传输失败 / SDK 运行时异常） */
  | { status: 'error'; error: unknown }
  /** SDK 子路径不可用（ERR_PACKAGE_PATH_NOT_EXPORTED） */
  | { status: 'unsupported' };

// ============ 框架契约 ============

/**
 * `claimPendingAgentQuestionAnswer` 的最小契约。
 *
 * 官方签名（config-contracts-CskY84Xs.d.ts）：
 * ```ts
 * declare function claimPendingAgentQuestionAnswer(params: {
 *   sessionKey?: string;
 *   text: string;
 *   persist?: () => Promise<void>;
 *   sourceRecorder?: UserTurnTranscriptRecorder;
 *   authority?: QuestionInputAuthority;
 * }): Promise<boolean>;
 * ```
 * `authority` 可选 ⇒ **无调用方权限校验**；框架自己的守卫仍然生效
 * （ask_user 的 run 必须还活着、记录必须仍是当前记录）。
 */
export type ClaimPendingQuestionAnswerFn = (params: {
  sessionKey?: string;
  text: string;
}) => Promise<boolean>;

// ============ 注入点（测试用）============

let injectedSubmitter: ClaimPendingQuestionAnswerFn | null = null;

/**
 * 注入假提交器（测试用）。传 `null` 恢复默认实现。
 *
 * 与仓库既有约定一致（`resetC2CInboundDebouncersForTest` / `_resetAdaptersCache`）：
 * 导出模块级 setter，测试在用例前后成对调用。
 */
export function setMultiQuestionSubmitterForTest(fn: ClaimPendingQuestionAnswerFn | null): void {
  injectedSubmitter = fn;
}

// ============ SDK 懒加载 ============

let harnessRuntimePromise: Promise<ClaimPendingQuestionAnswerFn> | undefined;

/**
 * 懒加载 `openclaw/plugin-sdk/agent-harness-runtime`。
 *
 * ⚠️ 子路径被删 = 插件整体加载失败（AGENTS.md 红线）——守卫在
 * `tests/sdk-surface.test.ts`（`mustCover` 含该子路径）。
 *
 * 这里用**动态 import + 运行时捕获**：子路径缺失时只在提交那一刻降级成
 * `unsupported`（回执「提交失败」），而不是让整个插件加载不起来。
 */
async function loadClaimFn(): Promise<ClaimPendingQuestionAnswerFn> {
  harnessRuntimePromise ??= import('openclaw/plugin-sdk/agent-harness-runtime')
    .then((mod) => mod.claimPendingAgentQuestionAnswer as ClaimPendingQuestionAnswerFn)
    .catch((err) => {
      // 清掉缓存的 rejected promise，允许后续重试（子路径在运行期被补上时可用）
      harnessRuntimePromise = undefined;
      throw err;
    });
  return harnessRuntimePromise;
}

// ============ 错误归类 ============

/**
 * 判断异常是不是「答案非法」（框架 INVALID_REQUEST / QUESTION_INVALID_ANSWER）。
 *
 * 框架的 gateway 客户端错误形状（dist `gateway-question-*.mjs`）：
 * `GatewayClientRequestError` → `{ name, gatewayCode, details: { reason } }`。
 * 直接匹配 `code` / `gatewayCode` 与 `reason` 两个字段即可，不依赖内部类。
 */
function isInvalidAnswerError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = record.code ?? record.gatewayCode;
  if (code !== 'INVALID_REQUEST') return false;
  const details = record.details;
  const reason =
    details && typeof details === 'object'
      ? (details as Record<string, unknown>).reason
      : record.reason;
  // reason 缺省时也按 invalid 处理（INVALID_REQUEST 只在答案校验路径出现）
  return reason === undefined || reason === 'QUESTION_INVALID_ANSWER';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// ============ 主入口 ============

/**
 * 把组合好的整单答案文本交给框架的官方认领通道。
 *
 * @param params.sessionKey 框架挂起 ask_user 记录的 sessionKey
 *   （= 插件 dispatch 时用的 `route.sessionKey`，与框架 turn 同 session）
 * @param params.text 整单答案文本（每行「题号: 值」，**每题必有值**）
 */
export async function submitMultiQuestionAnswer(params: {
  sessionKey: string | undefined;
  text: string;
  log?: PluginLogger;
}): Promise<MultiQuestionSubmitResult> {
  const { sessionKey, text, log } = params;

  // 没有 sessionKey ⇒ 无法定位框架的挂起记录（框架查表键缺失）。
  // 不当成「已结束」——它意味着路由解析没给出 key，属于可诊断的失败。
  if (!sessionKey || !sessionKey.trim()) {
    log?.warn?.('[question] submit skipped: no sessionKey');
    return { status: 'error', error: new Error('missing sessionKey') };
  }

  const claim = injectedSubmitter ?? (await loadClaimFnSafe(log));
  if (!claim) return { status: 'unsupported' };

  try {
    const consumed = await claim({ sessionKey, text });
    if (consumed) {
      log?.info?.(`[question] answer submitted sessionKey=${sessionKey} chars=${text.length}`);
      return { status: 'submitted' };
    }
    log?.info?.(`[question] answer not consumed (already resolved) sessionKey=${sessionKey}`);
    return { status: 'already-resolved' };
  } catch (err) {
    if (isInvalidAnswerError(err)) {
      log?.warn?.(`[question] answer rejected as invalid sessionKey=${sessionKey}: ${describeError(err)}`);
      return { status: 'invalid', reason: describeError(err) };
    }
    log?.error?.(`[question] submit failed sessionKey=${sessionKey}: ${describeError(err)}`);
    return { status: 'error', error: err };
  }
}

/**
 * 取框架的 claim 函数；子路径不可用时返回 null（⇒ `unsupported`）。
 */
async function loadClaimFnSafe(log?: PluginLogger): Promise<ClaimPendingQuestionAnswerFn | null> {
  try {
    return await loadClaimFn();
  } catch (err) {
    log?.error?.(`[question] agent-harness-runtime unavailable: ${describeError(err)}`);
    return null;
  }
}
