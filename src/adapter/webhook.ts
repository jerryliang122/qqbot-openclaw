/**
 * PluginWebhookAdapter — 将 OpenClaw Gateway HTTP 路由适配为 SDK WebhookServerAdapter。
 *
 * 复用 openclaw/plugin-sdk/webhook-ingress 的 target registry、rate limiting 和
 * resolveWebhookTargetWithAuthOrRejectSync 签名匹配，对齐旧版本插件行为。
 *
 * 多账号同路径：通过 resolveWebhookTargetWithAuthOrRejectSync 遍历 targets 做
 * Ed25519 签名匹配，找到正确的 target 后调用其 SDK handler 处理事件。
 */
import type { ResolvedQQBotAccount } from '../types.js';
import type { PluginLogger } from '../utils/plugin-logger.js';
import type { WebhookServerAdapter, WebhookRequestHandler } from '@tencent-connect/qqbot-nodejs';
import { verifyWebhookSignature, GatewayEvent } from '@tencent-connect/qqbot-nodejs/protocol';
import {
  loadDetachedWebhookGuards,
  type RunDetachedWebhookWork,
} from '../features/detached-webhook-work.js';
import {
  beginWebhookDispatchScope,
  settleWebhookDispatchScope,
} from '../features/webhook-dispatch-tracker.js';

// ── 模块级共享状态 ──
interface WebhookTarget {
  path: string;
  accountId: string;
  appId: string;
  clientSecret: string;
  handler: WebhookRequestHandler;
}
const sharedTargets = new Map<string, WebhookTarget[]>();
const _routeUnregisters = new Map<string, () => void>();

export function createPluginWebhookAdapter(params: {
  account: ResolvedQQBotAccount;
  log: PluginLogger;
}): WebhookServerAdapter {
  let unregistered = false;
  let storedPath = '';
  const accountId = params.account.accountId;

  return {
    async listen(_port: number, path: string, handler: WebhookRequestHandler): Promise<void> {
      const ingress = await import('openclaw/plugin-sdk/webhook-ingress').catch(() => null);
      if (!ingress?.registerWebhookTargetWithPluginRoute) {
        params.log.error('Webhook ingress not available');
        return;
      }

      const webhookPath = storedPath = path && path !== '/' ? path : (params.account.config.webhook?.path ?? '/qqbot/webhook');

      // 去重：reload 时避免同一 accountId 重复注册
      const existing = sharedTargets.get(webhookPath);
      if (existing) {
        const dupIdx = existing.findIndex((t) => t.accountId === accountId);
        if (dupIdx >= 0) {
          existing[dupIdx] = { path: webhookPath, accountId, appId: params.account.appId, clientSecret: params.account.clientSecret, handler };
          params.log.info(`Webhook target refreshed for ${accountId} on ${webhookPath}`);
          return;
        }
      }

      // 注册 target（框架管理 targetsByPath + 首次触发路由注册）
      const target: WebhookTarget = {
        path: webhookPath,
        accountId,
        appId: params.account.appId,
        clientSecret: params.account.clientSecret,
        handler,
      };

      const result = ingress.registerWebhookTargetWithPluginRoute({
        targetsByPath: sharedTargets as any,
        target,
        route: {
          auth: 'plugin',
          match: 'exact',
          pluginId: 'openclaw-qqbot',
          source: 'qqbot-webhook',
          accountId,
          replaceExisting: true,
          log: (msg: string) => params.log.info(msg),
          handler: createSharedHandler(webhookPath, params.log),
        },
        onLastPathTargetRemoved: () => {
          params.log.info(`Last webhook target removed from ${webhookPath}`);
        },
      });
      _routeUnregisters.set(webhookPath, result.unregister);

      params.log.info(`Webhook target added on ${webhookPath} (${sharedTargets.get(webhookPath)!.length} account(s))`);
    },

    close(): void {
      if (unregistered) return;
      unregistered = true;
      if (storedPath) {
        _routeUnregisters.get(storedPath)?.();
        _routeUnregisters.delete(storedPath);
      }
    },
  };
}

function createSharedHandler(path: string, log: PluginLogger) {
  return async (req: any, res: any) => {
    try {
      const ingress = await import('openclaw/plugin-sdk/webhook-ingress').catch((err) => {
        // 管线缺失会让所有请求降级到 handleSimple（无签名匹配多账号路由），
        // 此前完全无痕迹——至少留一条 WARN 说明降级发生及原因
        log.warn?.(`[webhook] ingress pipeline unavailable, downgrading to simple handler: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });

      if (!ingress?.withResolvedWebhookRequestPipeline) {
        await handleSimple(req, res, path, log);
        return;
      }

      await ingress.withResolvedWebhookRequestPipeline({
        req,
        res,
        targetsByPath: sharedTargets,
        rateLimiter: ingress.createFixedWindowRateLimiter?.({
          windowMs: 60_000, maxRequests: 600, maxTrackedKeys: 4096,
        }),
        inFlightLimiter: ingress.createWebhookInFlightLimiter?.({
          maxInFlightPerKey: 8, maxTrackedKeys: 4096,
        }),
        requireJsonContentType: true,
        handle: async ({ targets }) => {
          const bodyResult = await ingress.readWebhookBodyOrReject({
            req, res, maxBytes: 1_048_576, timeoutMs: 30_000,
          });
          if (!bodyResult.ok) {
            log.warn?.(`[webhook] body rejected`);
            return;
          }

          const rawBody = Buffer.from(bodyResult.value, 'utf-8');

          let payload: any;
          try { payload = JSON.parse(bodyResult.value); } catch (err) {
            log.warn?.(`[webhook] invalid json: ${(err as Error).message}`);
            res.statusCode = 400; res.end(JSON.stringify({ error: 'invalid json' })); return;
          }

          // op:13 → 用第一个 target 的 SDK handler（无需签名）
          if (payload.op === 13) {
            const t = targets[0];
            if (!t) {
              log.warn?.(`[webhook] op:13 no target on ${path}`);
              res.statusCode = 500; res.end(JSON.stringify({ error: 'no target' })); return;
            }
            const h = resolveTargetHandler(path, t.accountId);
            if (!h) {
              log.warn?.(`[webhook] op:13 no handler for ${t.accountId}`);
              res.statusCode = 500; res.end(JSON.stringify({ error: 'no handler' })); return;
            }
            await delegateToHandler(h, req, res, rawBody);
            return;
          }

          // op:0 → 签名匹配 target → SDK handler 处理事件
          const timestamp = getHeader(req, 'x-signature-timestamp') ?? '';
          const signature = getHeader(req, 'x-signature-ed25519') ?? '';
          if (!timestamp || !signature) {
            log.warn?.(`[webhook] missing signature headers on ${req.url}`);
            res.statusCode = 401; res.end(JSON.stringify({ error: 'missing signature' })); return;
          }

          const matched = ingress.resolveWebhookTargetWithAuthOrRejectSync({
            targets, res,
            isMatch: (t: any) => verifyWebhookSignature({
              body: rawBody, timestamp, signature, botSecret: t.clientSecret as string,
            }),
            unauthorizedStatusCode: 401,
            unauthorizedMessage: JSON.stringify({ error: 'invalid signature' }),
          });
          if (!matched) {
            log.warn?.(`[webhook] signature mismatch on ${path} (${targets.length} target(s))`);
            return;
          }

          const h = resolveTargetHandler(path, matched.accountId);
          if (!h) {
            log.error?.(`[webhook] no handler for matched target ${matched.accountId}`);
            res.statusCode = 500; res.end(JSON.stringify({ error: 'no handler' })); return;
          }
          // op:0 走 detached 派发（issue #74）：ACK 先行 + detached 准入根
          // 覆盖到框架 enqueue。handle 随 fire-and-forget 立即返回——
          // ingress 管线对 handle 返回后不写默认响应，in-flight 槽按
          // request close 释放，均不受 ACK 晚几个 microtask 影响。
          await dispatchOp0WithDetachedWork({
            eventType: typeof payload?.t === 'string' ? payload.t : '',
            log,
            delegate: () => delegateToHandler(h, req, res, rawBody),
            onDelegateError: () => writeErrorResponse(res),
          });
        },
      });
    } catch (err) {
      log.error(`Webhook handler error: ${(err as Error).message}`);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    }
  };
}

function resolveTargetHandler(path: string, accountId: string): WebhookRequestHandler | undefined {
  return sharedTargets.get(path)?.find((t) => t.accountId === accountId)?.handler;
}

// ── op:0 的 detached 派发（issue #74：transport=webhook 入站 100% 被拒） ──

/**
 * webhook 派发的 detached 准入根持有上限（ms）。
 *
 * detached 根需要覆盖到框架 enqueue；入站链 settle 的最长正常路径是群合批
 * （maxHoldMs 默认 300s 兜底 + 批次 dispatch），360s 留出余量。超限即放弃
 * 持有——未入队的工作将以无根身份继续（群合批冲刷另有 detached 包裹兜底）。
 */
const WEBHOOK_DISPATCH_HOLD_MS_DEFAULT = 360_000;

function resolveWebhookDispatchHoldMs(): number {
  const env = Number(process.env.QQBOT_WEBHOOK_DISPATCH_HOLD_MS);
  return Number.isFinite(env) && env > 0 ? env : WEBHOOK_DISPATCH_HOLD_MS_DEFAULT;
}

/** 会派生入站派发（消息 / 互动）的事件类型——tripwire 判定用 */
const DISPATCH_PRODUCING_EVENT_TYPES = new Set<string>([
  GatewayEvent.C2C_MESSAGE_CREATE,
  GatewayEvent.AT_MESSAGE_CREATE,
  GatewayEvent.DIRECT_MESSAGE_CREATE,
  GatewayEvent.GROUP_AT_MESSAGE_CREATE,
  GatewayEvent.GROUP_MESSAGE_CREATE,
  GatewayEvent.INTERACTION_CREATE,
]);

/**
 * op:0 委托入口：SDK handler 会立刻 ACK 并把派发 fire-and-forget 到后台，
 * 那条派发链继承的请求根在响应结束后即释放 → 框架 enqueue 被当成 drain 拒掉。
 *
 * 这里把委托放进 `runDetachedWebhookWork` 的回调（detached 根在回调挂起期间
 * 保持引用），回调内再等「本次委托派生的在途派发」全部落地
 * （QQBotGateway 对 handleInboundMessage / interaction listener 的在途登记，
 * 见 src/features/webhook-dispatch-tracker.ts）——ACK 仍由 SDK handler 即时
 * 返回，平台侧重投超时不受影响。
 *
 * 相关性用 **scope** 圈定：`beginWebhookDispatchScope()` 后同步调用委托，
 * 委托同步级联里的登记恰好属于本请求（JS 单线程）；同步段结束立刻 `end()`，
 * 并发请求的登记不混入、本根不为无关工作多等一毫秒。
 *
 * 注意：**不能**只把 delegateToHandler 包进 runDetachedWebhookWork 就完事——
 * SDK 的后台派发 promise 不在回调的 AsyncWorkScope 里，回调随 ACK settle 后
 * detached 根照样释放（work scope 的 pending 集合只收显式注册的 promise）。
 */
export async function dispatchOp0WithDetachedWork(params: {
  eventType: string;
  log: PluginLogger;
  /** 执行 SDK handler 委托（写 ACK/错误响应到 res） */
  delegate: () => Promise<void>;
  /** 委托失败且响应未写出时兜底写 500（防请求悬挂到平台超时） */
  onDelegateError: () => void;
  /** 测试注入；缺省用 loadDetachedWebhookGuards（真实 openclaw 子路径） */
  guards?: { runDetachedWebhookWork: RunDetachedWebhookWork } | null;
}): Promise<void> {
  const guards = params.guards !== undefined
    ? params.guards
    : await loadDetachedWebhookGuards(params.log);
  if (!guards) {
    try {
      await params.delegate();
    } catch (err) {
      params.onDelegateError();
      params.log.error(
        `[webhook] dispatch delegation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  void guards
    .runDetachedWebhookWork(async () => {
      const scope = beginWebhookDispatchScope();
      let delegatePromise: Promise<void>;
      let delegateError: unknown = null;
      try {
        // 同步调用：SDK 的派发（及登记）发生在这个调用的同步级联里
        delegatePromise = params.delegate();
      } catch (err) {
        params.onDelegateError();
        throw err;
      } finally {
        // 同步段一结束立刻收口 scope——await 期间他人的登记不得混入
        scope.end();
      }
      try {
        await delegatePromise;
      } catch (err) {
        // 响应兜底要即时写（不等 settle）——委托失败时平台还在等回包
        params.onDelegateError();
        delegateError = err;
      }

      const settled = await settleWebhookDispatchScope(scope, resolveWebhookDispatchHoldMs());
      if (
        settled.awaited === 0
        && DISPATCH_PRODUCING_EVENT_TYPES.has(params.eventType)
      ) {
        // tripwire：本应派生派发的事件没有观测到任何在途登记——
        // 多半是 SDK 停止经 bot 实例派发（surface 漂移），detached 根已不再
        // 覆盖派发，issue #74 的症状会复现。这条 WARN 是唯一的信号。
        params.log.warn?.(
          `[webhook] op:0 ${params.eventType} delegated but no tracked dispatch observed `
          + '— SDK dispatch surface drift? (issue #74)',
        );
      }
      if (delegateError) throw delegateError;
    })
    .catch((err) => {
      params.log.error(
        `[webhook] detached dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}

async function delegateToHandler(handler: WebhookRequestHandler, req: any, res: any, rawBody: Buffer) {
  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    headers[k.toLowerCase()] = v as string | string[];
  }
  const resp = await handler({ body: rawBody, headers });
  res.statusCode = resp.status;
  if (resp.headers) {
    for (const [k, v] of Object.entries(resp.headers)) res.setHeader(k, v as string);
  }
  res.end(resp.body);
}

/** 委托失败且响应未写出时的兜底 500——否则请求悬挂到平台超时（响应写出权在 detached 回调手里） */
export function writeErrorResponse(res: any): void {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = 500;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: 'internal error' }));
}

async function handleSimple(req: any, res: any, path: string, log: PluginLogger) {
  try {
    const ct = String(req.headers['content-type'] ?? '');
    if (!ct.includes('application/json')) {
      log.debug?.(`[webhook] simple ${req.method ?? '?'} ${path} -> 400 (unsupported content type)`);
      res.statusCode = 400; res.end(JSON.stringify({ error: 'unsupported content type' })); return;
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > 1_048_576) {
        log.debug?.(`[webhook] simple ${req.method ?? '?'} ${path} -> 413 (too large)`);
        res.statusCode = 413; res.end(JSON.stringify({ error: 'too large' })); return;
      }
      chunks.push(buf);
    }
    const rawBody = Buffer.concat(chunks);

    // op:13 无签名校验语义，直通第一个 target
    let payload: any;
    try { payload = JSON.parse(rawBody.toString('utf-8')); } catch { payload = undefined; }
    if (payload?.op === 13) {
      const t = (sharedTargets.get(path) ?? [])[0];
      if (t) await delegateToHandler(t.handler, req, res, rawBody);
      else { res.statusCode = 500; res.end(JSON.stringify({ error: 'no target' })); }
      return;
    }

    // op:0（及其他 op）逐 target 试签名；成功者同样走 detached 派发
    const entries = sharedTargets.get(path) ?? [];
    await dispatchOp0WithDetachedWork({
      eventType: typeof payload?.t === 'string' ? payload.t : '',
      log,
      delegate: async () => {
        for (const entry of entries) {
          const resp = await entry.handler({ body: rawBody, headers: mapHeaders(req) });
          if (resp.status < 400) {
            log.debug?.(`[webhook] simple ${req.method ?? '?'} ${path} -> ${resp.status} (account=${entry.accountId})`);
            res.statusCode = resp.status;
            if (resp.headers) for (const [k, v] of Object.entries(resp.headers)) res.setHeader(k, v as string);
            res.end(resp.body);
            return;
          }
        }
        log.warn?.(`[webhook] simple ${req.method ?? '?'} ${path} -> 401 (no target matched signature)`);
        res.statusCode = 401; res.end(JSON.stringify({ error: 'invalid signature' }));
      },
      onDelegateError: () => writeErrorResponse(res),
    });
  } catch (err) {
    log.error(`Webhook simple handler error: ${(err as Error).message}`);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: 'internal error' })); }
  }
}

function mapHeaders(req: any): Record<string, string | string[]> {
  const h: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = v as string | string[];
  return h;
}

function getHeader(req: any, key: string): string | undefined {
  const val = req.headers[key];
  return Array.isArray(val) ? val[0] : val;
}
