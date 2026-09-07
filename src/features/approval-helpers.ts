/**
 * Approval helpers — pure functions shared by the approval capability and the
 * interaction (button-click) handler.
 *
 * Ported from the in-tree openclaw qqbot extension so the external plugin stays
 * byte-compatible with the framework's approval view model:
 *   - buildApprovalKeyboard reads `allowedDecisions` from the SDK view (fixes
 *     the hardcoded-3-button bug where skill_workshop approvals rejected
 *     `allow-always`).
 *   - button_data uses the v2 format `approve:v2:<kind>:<encodedId>:<decision>`
 *     so the kind is recoverable at click time without ID-prefix sniffing.
 */

import type {
  ExecApprovalPendingView,
  PendingApprovalView,
  PluginApprovalPendingView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveExecApprovalCommandDisplay } from "openclaw/plugin-sdk/approval-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { InlineKeyboard, KeyboardButton } from "../types.js";

// ============ Types ============

export type ApprovalKind = "exec" | "plugin" | "system-agent";

// The SDK re-exports only the pending-view union, not the system-agent member.
export type SystemAgentApprovalPendingView = Extract<
  PendingApprovalView,
  { approvalKind: "system-agent" }
>;
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export interface ApprovalTarget {
  type: "c2c" | "group";
  id: string;
}

export interface ParsedApprovalAction {
  approvalId: string;
  approvalKind: ApprovalKind;
  decision: ApprovalDecision;
}

// ============ Text Builders ============

const COMMAND_PREVIEW_MAX_LENGTH = 300;
const COMMAND_PREVIEW_GRAPHEMES_PER_LINE = 24;
const COMMAND_PREVIEW_WRAP_MARKER = "↩";
const commandPreviewSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function splitCommandPreviewGraphemes(commandText: string): string[] {
  return commandPreviewSegmenter
    ? Array.from(commandPreviewSegmenter.segment(commandText), ({ segment }) => segment)
    : Array.from(commandText);
}

function formatCommandPreview(commandText: string): string {
  // QQ Desktop does not wrap fenced blocks. The sanitized view has already escaped real command
  // newlines, so these grapheme-safe line breaks are presentation-only and unambiguous. Limiting
  // each line to 24 graphemes also bounds common double-width text to roughly 48 columns.
  const lines = [""];
  const displayText = commandText.replaceAll(COMMAND_PREVIEW_WRAP_MARKER, "\\u{21A9}");
  let previewLength = 0;
  let lineGraphemes = 0;
  let truncated = false;
  let wrapped = false;
  for (const grapheme of splitCommandPreviewGraphemes(displayText)) {
    if (previewLength + grapheme.length > COMMAND_PREVIEW_MAX_LENGTH) {
      if (previewLength === 0) {
        lines[0] = truncateUtf16Safe(grapheme, COMMAND_PREVIEW_MAX_LENGTH);
      }
      truncated = true;
      break;
    }
    previewLength += grapheme.length;
    if (lineGraphemes === COMMAND_PREVIEW_GRAPHEMES_PER_LINE) {
      lines[lines.length - 1] += COMMAND_PREVIEW_WRAP_MARKER;
      lines.push("");
      lineGraphemes = 0;
      wrapped = true;
    }
    lines[lines.length - 1] += grapheme;
    lineGraphemes += 1;
  }
  const preview = `${lines.join("\n")}${truncated ? "\n…[truncated]" : ""}`;
  const longestBacktickRun = Math.max(0, ...(preview.match(/`+/g)?.map((run) => run.length) ?? []));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  const block = `${fence}\n${preview}\n${fence}`;
  return wrapped
    ? `${COMMAND_PREVIEW_WRAP_MARKER} = display wrap only; not command text\n${block}`
    : block;
}

function formatApprovalMetadata(value: string): string {
  const sanitized = resolveExecApprovalCommandDisplay({ command: value }).commandText;
  return formatCommandPreview(sanitized);
}

export function buildExecApprovalText(view: ExecApprovalPendingView, nowMs = Date.now()): string {
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const lines: string[] = ["🔐 命令执行审批", ""];
  if (view.commandText) {
    lines.push(formatCommandPreview(view.commandText));
  }
  if (view.cwd) {
    lines.push(`📁 目录:\n${formatApprovalMetadata(view.cwd)}`);
  }
  if (view.agentId) {
    lines.push(`🤖 Agent:\n${formatApprovalMetadata(view.agentId)}`);
  }
  lines.push("", `⏱️ 超时: ${expiresIn} 秒`);
  return lines.join("\n");
}

export function buildPluginApprovalText(
  view: PluginApprovalPendingView,
  nowMs = Date.now(),
): string {
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));
  const severityIcon =
    view.severity === "critical" ? "🔴"
    : view.severity === "info" ? "🔵"
    : "🟡";

  const lines: string[] = [`${severityIcon} 审批请求`, ""];
  lines.push(`📋 ${view.title}`);
  if (view.description) lines.push(`📝 ${view.description}`);
  if (view.toolName) lines.push(`🔧 工具: ${view.toolName}`);
  if (view.pluginId) lines.push(`🔌 插件: ${view.pluginId}`);
  if (view.agentId) lines.push(`🤖 Agent: ${view.agentId}`);
  lines.push("", `⏱️ 超时: ${expiresIn} 秒`);
  return lines.join("\n");
}

export function buildSystemAgentApprovalText(
  view: SystemAgentApprovalPendingView,
  nowMs = Date.now(),
): string {
  const expiresIn = Math.max(0, Math.round((view.expiresAtMs - nowMs) / 1000));

  const lines: string[] = ["🛡️ 系统变更审批", ""];
  lines.push(`📋 ${view.title}`);
  if (view.description) lines.push(`📝 ${view.description}`);
  if (view.operationSummary) lines.push(`📊 ${view.operationSummary}`);
  if (view.commandText) {
    lines.push(formatCommandPreview(view.commandText));
  }
  if (view.cwd) {
    lines.push(`📁 目录:\n${formatApprovalMetadata(view.cwd)}`);
  }
  if (view.host) lines.push(`🖥️ 主机: ${view.host}`);
  if (view.agentId) lines.push(`🤖 Agent:\n${formatApprovalMetadata(view.agentId)}`);
  lines.push("", `⏱️ 超时: ${expiresIn} 秒`);
  return lines.join("\n");
}

// ============ Keyboard Builder ============

/**
 * Build the inline keyboard for approval messages.
 *
 * type=1 (Callback): click triggers INTERACTION_CREATE, button_data = data field.
 * group_id "approval": clicking one button grays out the others (mutual exclusion).
 * click_limit=1: each user can only click once.
 * permission.type=2: all users can interact.
 *
 * Only buttons whose decision is in `allowedDecisions` are rendered — the SDK
 * view drives this, so e.g. skill_workshop approvals (which restrict to
 * ["allow-once","deny"]) no longer offer an invalid "allow-always" button.
 */
export function buildApprovalKeyboard(
  approvalId: string,
  approvalKind: ApprovalKind,
  allowedDecisions: readonly ApprovalDecision[] = ["allow-once", "allow-always", "deny"],
): InlineKeyboard {
  const actionPrefix = `approve:v2:${approvalKind}:${encodeURIComponent(approvalId)}`;
  const makeBtn = (
    id: string,
    label: string,
    visitedLabel: string,
    data: string,
    style: 0 | 1,
  ): KeyboardButton => ({
    id,
    render_data: { label, visited_label: visitedLabel, style },
    action: {
      type: 1,
      data,
      permission: { type: 2 },
      click_limit: 1,
    },
    group_id: "approval",
  });

  const buttons: KeyboardButton[] = [];
  if (allowedDecisions.includes("allow-once")) {
    buttons.push(makeBtn("allow", "✅ 允许一次", "已处理", `${actionPrefix}:allow-once`, 1));
  }
  if (allowedDecisions.includes("allow-always")) {
    buttons.push(makeBtn("always", "⭐ 始终允许", "已处理", `${actionPrefix}:allow-always`, 1));
  }
  if (allowedDecisions.includes("deny")) {
    buttons.push(makeBtn("deny", "❌ 拒绝", "已处理", `${actionPrefix}:deny`, 0));
  }

  return {
    content: {
      rows: [{ buttons }],
    },
  };
}

// ============ Target Resolver ============

/**
 * Extract the delivery target from a sessionKey or turnSourceTo string.
 *
 * Expected formats:
 *   agent:main:qqbot:direct:OPENID  -> { type: "c2c", id: "OPENID" }
 *   agent:main:qqbot:c2c:OPENID     -> { type: "c2c", id: "OPENID" }
 *   agent:main:qqbot:group:GROUPID  -> { type: "group", id: "GROUPID" }
 *
 * Returns null if neither field matches the expected pattern.
 */
export function resolveApprovalTarget(
  sessionKey: string | null | undefined,
  turnSourceTo: string | null | undefined,
): ApprovalTarget | null {
  const sk = sessionKey ?? turnSourceTo;
  if (!sk) return null;
  const m = sk.match(/qqbot:(c2c|direct|group):([A-F0-9]+)/i);
  if (!m) return null;
  const scope = m[1];
  const id = m[2];
  if (scope === undefined || id === undefined) return null;
  const type: "c2c" | "group" = scope.toLowerCase() === "group" ? "group" : "c2c";
  return { type, id };
}

// ============ Interaction Parser ============

/**
 * Parse the button_data string from an INTERACTION_CREATE event.
 *
 * Expected format: `approve:v2:<approvalKind>:<encodedApprovalId>:<decision>`.
 * The approvalKind is baked into the payload so the resolve path doesn't need
 * to infer it from the ID prefix, and the ID is URL-encoded so colons in
 * `exec:<uuid>` / `plugin:<uuid>` / `system-agent:<uuid>` IDs survive
 * unambiguously.
 *
 * Returns null if the data does not match the approval button format.
 */
export function parseApprovalButtonData(buttonData: string): ParsedApprovalAction | null {
  const m = buttonData.match(/^approve:v2:(exec|plugin|system-agent):([^:]+):(allow-once|allow-always|deny)$/);
  if (!m || m[0] !== buttonData) return null;
  const kind = m[1] as ApprovalKind;
  const encodedId = m[2];
  const decision = m[3] as ApprovalDecision;
  if (!encodedId) return null;
  let approvalId: string;
  try {
    approvalId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }
  if (!approvalId) return null;
  return { approvalId, approvalKind: kind, decision };
}
