/**
 * QQ Bot Approval Capability — SDK-native approval handling.
 *
 * Replaces the former hand-rolled QQBotApprovalHandler. The framework
 * auto-bootstraps a native approval handler from this capability (registered
 * on qqbotPlugin.approvalCapability + the "approval.native" runtime context
 * declared in gateway/lifecycle.ts), and feeds exec/plugin approval requests
 * back to the availability / presentation / transport callbacks below.
 *
 * Model: QQBot has no separate `execApprovals` approver config — it uses the
 * account `allowFrom` list. With no allowFrom, any participant in the
 * originating conversation may approve (open mode). This is the "fallback"
 * path from the in-tree extension, intentionally simpler than the profile
 * path.
 */

import { createChannelApprovalCapability } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import {
  createChannelApprovalNativeRuntimeAdapter,
  createLazyChannelApprovalNativeRuntimeAdapter,
  CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ChannelApprovalNativeRuntimeAdapter,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import type {
  ChannelApprovalCapability,
} from "openclaw/plugin-sdk/channel-contract";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID, resolveQQBotAccount } from "../config.js";
import { tryGetBotForAccount } from "../bot-instance.js";
import { getQQBotRuntime } from "../runtime.js";
import { getAdapters } from "../adapter/resolve.js";
import type { InlineKeyboard, ResolvedQQBotAccount } from "../types.js";
import {
  buildApprovalKeyboard,
  buildExecApprovalText,
  buildPluginApprovalText,
  buildSystemAgentApprovalText,
  resolveApprovalTarget,
} from "./approval-helpers.js";

export { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY };

// ─── helpers ────────────────────────────────────────────────

function resolveActiveConfig(): OpenClawConfig {
  // Prefer the live runtime config snapshot (reflects config reloads); fall
  // back to an empty object if the runtime is not yet registered.
  const rt = getQQBotRuntime();
  const cfg = getAdapters(rt).getConfig?.();
  return (cfg ?? {}) as OpenClawConfig;
}

function resolveAccountById(cfg: OpenClawConfig, accountId?: string | null): ResolvedQQBotAccount {
  return resolveQQBotAccount(cfg, accountId && accountId !== DEFAULT_ACCOUNT_ID ? accountId : undefined);
}

/** account is enabled and has usable credentials → can deliver native approvals */
function isNativeDeliveryEnabled(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const account = resolveAccountById(cfg, accountId);
  return account.enabled && account.secretSource !== "none";
}

/** Resolve the QQ delivery target for an approval request. */
function resolveQQTarget(request: {
  request: { sessionKey?: string | null; turnSourceTo?: string | null };
}): { type: "c2c" | "group"; id: string } | null {
  const sessionKey = request.request.sessionKey ?? null;
  const turnSourceTo = request.request.turnSourceTo ?? null;

  const target = resolveApprovalTarget(sessionKey, turnSourceTo);
  if (target) return target;

  const sessionConversation = resolveApprovalRequestSessionConversation({
    request: request as never,
    channel: "qqbot",
    bundledFallback: true,
  });
  if (sessionConversation?.id) {
    const kind = sessionConversation.kind;
    return { type: kind === "group" ? "group" : "c2c", id: sessionConversation.id };
  }
  return null;
}

/**
 * Per-account ownership: only the account that originated the turn should
 * deliver (openids are account-scoped — cross-account delivery fails with
 * HTTP 500 on the QQ Bot API).
 */
function matchesAccount(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  request: { request: { turnSourceAccountId?: string | null } },
): boolean {
  const reqAccountId = normalizeOptionalString(request.request.turnSourceAccountId);
  if (!reqAccountId) return true; // no account hint → accept (ownership left to caller)
  const normalized = (accountId && accountId !== DEFAULT_ACCOUNT_ID) ? accountId : DEFAULT_ACCOUNT_ID;
  return reqAccountId === normalized;
}

// ─── authorization (allowFrom) ──────────────────────────────

/**
 * Decide whether a button-clicker may approve. Mirrors the legacy
 * isApprovalAuthorized rule: empty allowFrom (or ["*"]) → open; otherwise the
 * operator must be in the account's allowFrom list.
 */
export function authorizeQQBotApprovalAction(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
}): { authorized: boolean; reason?: string } {
  const operatorId = normalizeOptionalString(params.senderId);
  if (!operatorId) {
    return { authorized: false, reason: "Could not identify the operator." };
  }
  const account = resolveAccountById(params.cfg, params.accountId);
  const allowFrom = account.config?.allowFrom ?? [];
  if (!allowFrom.length || allowFrom.includes("*")) {
    return { authorized: true };
  }
  if (allowIncludes(allowFrom, operatorId)) {
    return { authorized: true };
  }
  return { authorized: false, reason: "You are not authorized to approve this request." };
}

function allowIncludes(allowFrom: Array<string | number>, operatorId: string): boolean {
  const normalized = operatorId.toUpperCase().replace(/^qqbot:/i, "");
  return allowFrom.some((entry) => {
    const e = String(entry).trim().toUpperCase().replace(/^qqbot:/i, "");
    return e === normalized;
  });
}

// ─── native runtime spec (availability / presentation / transport) ──

type QQBotPendingPayload = { text: string; keyboard: InlineKeyboard };
type QQBotPreparedTarget = { type: "c2c" | "group"; id: string };
type QQBotPendingEntry = { messageId?: string; targetType: "c2c" | "group"; targetId: string };

const qqbotApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  QQBotPendingPayload,
  QQBotPreparedTarget,
  QQBotPendingEntry
>({
  eventKinds: ["exec", "plugin", "system-agent"],

  availability: {
    isConfigured: ({ cfg, accountId }) =>
      isNativeDeliveryEnabled(cfg, accountId),

    shouldHandle: ({ cfg, accountId, request }) => {
      const target = resolveQQTarget(request as never);
      if (!target) return false;
      return matchesAccount(cfg, accountId, request as never);
    },
  },
  presentation: {
    buildPendingPayload: ({ view, nowMs }) => {
      const text =
        view.approvalKind === "exec"
          ? buildExecApprovalText(view, nowMs)
          : view.approvalKind === "system-agent"
            ? buildSystemAgentApprovalText(view, nowMs)
            : buildPluginApprovalText(view, nowMs);
      const keyboard = buildApprovalKeyboard(
        view.approvalId,
        view.approvalKind,
        view.actions.map((action) => action.decision),
      );
      return { text, keyboard };
    },
    buildResolvedResult: () => ({ kind: "leave" }),
    buildExpiredResult: () => ({ kind: "leave" }),
  },

  transport: {
    prepareTarget: ({ request }) => {
      const target = resolveQQTarget(request as never);
      if (!target) return null;
      return { target, dedupeKey: `${target.type}:${target.id}` };
    },

    deliverPending: async ({ accountId, preparedTarget, pendingPayload }) => {
      // Resolve the bot for this account (gateway must be running — it is, because
      // the "approval.native" runtime context only exists while the account is started).
      const resolvedAccountId =
        accountId && accountId !== DEFAULT_ACCOUNT_ID ? accountId : DEFAULT_ACCOUNT_ID;
      const bot = tryGetBotForAccount(resolvedAccountId);
      if (!bot) {
        throw new Error(
          `QQ Bot gateway not running for account "${resolvedAccountId}" — cannot deliver approval`,
        );
      }

      const replyTarget = {
        scope: preparedTarget.type as "c2c" | "group",
        targetId: preparedTarget.id,
      };
      const result = await bot.sendTextWithKeyboard(
        replyTarget,
        pendingPayload.text,
        pendingPayload.keyboard as never,
      );
      const messageId = (result as { id?: string } | undefined)?.id;
      return {
        messageId,
        targetType: preparedTarget.type,
        targetId: preparedTarget.id,
      };
    },
  },
});

// ─── capability assembly ────────────────────────────────────

function createQQBotApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    authorizeActorAction: ({ cfg, accountId, senderId }) =>
      authorizeQQBotApprovalAction({ cfg, accountId, senderId }),

    getActionAvailabilityState: ({ cfg, accountId }) =>
      isNativeDeliveryEnabled(cfg, accountId)
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },

    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      isNativeDeliveryEnabled(cfg, accountId)
        ? { kind: "enabled" as const }
        : { kind: "disabled" as const },

    describeExecApprovalSetup: ({ accountId }: { accountId?: string | null }) => {
      const prefix =
        accountId && accountId !== DEFAULT_ACCOUNT_ID
          ? `channels.qqbot.accounts.${accountId}`
          : "channels.qqbot";
      return `QQBot native approvals are enabled by default. To restrict who can approve, configure \`${prefix}.allowFrom\` with QQ user OpenIDs.`;
    },

    delivery: {
      hasConfiguredDmRoute: () => true,
      shouldSuppressForwardingFallback: (input) => {
        const channel = normalizeOptionalString(input.target?.channel);
        if (channel !== "qqbot") return false;
        const accountId =
          normalizeOptionalString(input.target?.accountId) ??
          normalizeOptionalString(input.request?.request?.turnSourceAccountId);
        return isNativeDeliveryEnabled(resolveActiveConfig(), accountId);
      },
    },

    native: {
      describeDeliveryCapabilities: ({ cfg, accountId }) => ({
        enabled: isNativeDeliveryEnabled(cfg, accountId),
        preferredSurface: "origin" as const,
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: ({ request }) => {
        const sessionKey = request.request.sessionKey ?? null;
        const turnSourceTo = request.request.turnSourceTo ?? null;
        const target = resolveApprovalTarget(sessionKey, turnSourceTo);
        if (target) return { to: `${target.type}:${target.id}` };
        const sessionConversation = resolveApprovalRequestSessionConversation({
          request: request as never,
          channel: "qqbot",
          bundledFallback: true,
        });
        if (sessionConversation?.id) {
          const kind = sessionConversation.kind === "group" ? "group" : "c2c";
          return { to: `${kind}:${sessionConversation.id}` };
        }
        return null;
      },
    },

    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId }) => isNativeDeliveryEnabled(cfg, accountId),
      shouldHandle: ({ cfg, accountId, request }) => {
        const target = resolveQQTarget(request as never);
        if (!target) return false;
        return matchesAccount(cfg, accountId, request as never);
      },
      load: async () =>
        qqbotApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });
}

let cachedCapability: ChannelApprovalCapability | undefined;

export function getQQBotApprovalCapability(): ChannelApprovalCapability {
  cachedCapability ??= createQQBotApprovalCapability();
  return cachedCapability;
}
