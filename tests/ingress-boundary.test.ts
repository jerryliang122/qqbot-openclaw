/**
 * 持久化入站 · 边界守卫 回归测试
 *
 * 覆盖（PR 的硬边界，锁死"改了什么、没改什么"）：
 * 1. **C2C 私聊零改动**（源码级）：`src/features/inbound-debounce.ts` 与
 *    `src/gateway/event-handlers.ts` 的 c2c 分支**不得**引用任何 ingress 模块。
 * 2. **无直发快路径**（源码级）：群路径不存在"绕过持久化队列直接 dispatch"
 *    的分支——入队结果只有 handled / not_applicable / unavailable 三态。
 * 3. **配置面零变更**：`openclaw.plugin.json` 的 coalesce 段（顶层 +
 *    accounts.<id> 两处）逐字未变。
 * 4. **legacy strategy:'framework' 路径不变**：显式交回框架队列 ⇒
 *    不进 durable 路径（not_applicable）。
 * 5. **R-A**：空闲群单条 @ 消息 ⇒ 一条 turn、一次回复、锚点 = 该条 msgId。
 * 6. **R-B**：群聊 user_request 的回复走**被动回复**（带 msg_id）。
 * 7. **R-C**：room_event 群里被 @ 的那条**仍然**是 user_request（不被压成静默）。
 *
 * 运行方式: npx tsx tests/ingress-boundary.test.ts
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MiddlewareContext, QQBotInboundMessage } from '@tencent-connect/qqbot-nodejs';
import type { PluginRuntime } from 'openclaw/plugin-sdk';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

function readSrc(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/**
 * 取 `event-handlers.ts` 的 c2c 分支源码片段。
 *
 * ⚠️ 切片必须**以 `} else {` 收尾**——c2c 分支只有 3 行，按固定长度切会把
 * 群分支的 durable 代码圈进来（那是合法的群路径改动，不是 C2C 越界）。
 */
function sliceC2CBranch(src: string): string {
  const start = src.indexOf("if (scope === 'c2c') {");
  assert.ok(start > 0, '未找到 c2c 分支');
  const end = src.indexOf('} else {', start);
  assert.ok(end > start, '未找到 c2c 分支的 else 边界');
  return src.slice(start, end);
}

/** 取 `event-handlers.ts` 的群分支源码片段（c2c 的 else 之后） */
function sliceGroupBranch(src: string): string {
  const c2cStart = src.indexOf("if (scope === 'c2c') {");
  assert.ok(c2cStart > 0, '未找到 c2c 分支');
  const start = src.indexOf('} else {', c2cStart);
  assert.ok(start > 0, '未找到群分支起点');
  const end = src.indexOf('} catch (err) {', start);
  assert.ok(end > start, '未找到群分支终点');
  return src.slice(start, end);
}

group('C2C 零改动（源码级）');

await test('inbound-debounce.ts 不引用任何 ingress 模块', () => {
  const src = readSrc('src/features/inbound-debounce.ts');
  assert.ok(
    !/from\s+['"].*ingress-(queue|batcher|payload)['"]/.test(src),
    'C2C 防抖模块不得引用 ingress 模块',
  );
});

await test('event-handlers 的 c2c 分支不引用 ingress', () => {
  const c2cBranch = sliceC2CBranch(readSrc('src/gateway/event-handlers.ts'));
  assert.ok(
    !/ingress/i.test(c2cBranch),
    'c2c 分支不得引用 ingress：\n' + c2cBranch,
  );
});

await test('C2C 分支的代码逐字未变（仍是 enqueueC2CInboundMessage → 未接管则 dispatchNow）', () => {
  const src = readSrc('src/gateway/event-handlers.ts');
  const expected = [
    "if (scope === 'c2c') {",
    'const handled = await enqueueC2CInboundMessage(ctx, msg, account, runtime, hlog);',
    'if (!handled) await dispatchNow();',
  ];
  for (const line of expected) {
    assert.ok(src.includes(line), `C2C 分支缺少：${line}`);
  }
});

group('无直发快路径（源码级）');

await test('群路径没有"绕过队列直接 dispatch"的分支', () => {
  const groupBranch = sliceGroupBranch(readSrc('src/gateway/event-handlers.ts'));
  // 群分支里出现的 dispatchNow 只允许出现在两个受控位置：
  // ① not_applicable（交回框架队列）② unavailable 且内存合批也没接住
  const dispatchNowCalls = groupBranch.match(/await dispatchNow\(\)/g) ?? [];
  assert.equal(dispatchNowCalls.length, 2, '群路径的直发点必须恰好两处且都受控');
  assert.ok(groupBranch.includes("outcome === 'unavailable'"));
  assert.ok(groupBranch.includes('not_applicable'));
});

await test('"已持久化"分支绝不直发（handled ⇒ 只由 drain 派发）', () => {
  const groupBranch = sliceGroupBranch(readSrc('src/gateway/event-handlers.ts'));
  const handledIdx = groupBranch.indexOf("outcome === 'handled'");
  const unavailableIdx = groupBranch.indexOf("outcome === 'unavailable'");
  assert.ok(handledIdx > 0 && unavailableIdx > handledIdx, '未找到 handled / unavailable 分支');
  const handledSegment = groupBranch.slice(handledIdx, unavailableIdx);
  assert.ok(
    !/dispatchNow/.test(handledSegment),
    'handled 分支不得直发：\n' + handledSegment,
  );
});

await test('enqueueDurableGroupInbound 的结果只有三态', async () => {
  const mod = await import('../src/features/ingress-queue.js');
  const src = readSrc('src/features/ingress-queue.ts');
  assert.ok(src.includes("'handled'"));
  assert.ok(src.includes("'not_applicable'"));
  assert.ok(src.includes("'unavailable'"));
  assert.equal(typeof mod.enqueueDurableGroupInbound, 'function');
});

group('配置面零变更');

await test('openclaw.plugin.json 的 coalesce 段逐字未变', () => {
  const manifest = JSON.parse(readSrc('openclaw.plugin.json'));
  const top = manifest.channelConfigs.qqbot.schema.properties.groups.additionalProperties.properties.coalesce;
  const acc = manifest.channelConfigs.qqbot.schema.properties.accounts.additionalProperties.properties.groups.additionalProperties.properties.coalesce;
  for (const seg of [top, acc]) {
    assert.deepEqual(seg.properties.strategy.enum, ['framework', 'plugin']);
    assert.deepEqual(seg.properties.enabled.type, 'boolean');
    assert.ok(seg.properties.maxBatchSize);
    assert.ok(seg.properties.maxHoldMs);
  }
  // 两处必须逐字一致
  assert.deepEqual(top, acc);
});

group('legacy strategy=framework 路径');

await test("strategy:'framework' ⇒ not_applicable（不进 durable 路径）", async () => {
  const { enqueueDurableGroupInbound } = await import('../src/features/ingress-queue.js');
  const { resolveGroupConfigFromAccount } = await import('../src/config.js');
  const account = {
    accountId: 'acc1',
    config: { groups: { g1: { coalesce: { enabled: true, strategy: 'framework' } } } },
  } as never;
  const cfg = resolveGroupConfigFromAccount(account, 'g1');
  assert.equal(cfg.coalesce.strategy, 'framework');

  const ctx = { message: { content: 'hi' }, state: {} } as unknown as MiddlewareContext;
  const msg = {
    kind: 'group',
    messageId: 'm1',
    content: 'hi',
    senderId: 'u1',
    replyTarget: { scope: 'group', targetId: 'g1' },
  } as unknown as QQBotInboundMessage;

  const outcome = await enqueueDurableGroupInbound({
    ctx,
    msg,
    account,
    runtime: { version: 'test' } as unknown as PluginRuntime,
  });
  assert.equal(outcome, 'not_applicable');
});

group('R-A / R-B / R-C（durable 路径端到端）');

// ── 端到端：假队列 + 假 drain + 真 dispatchToOpenClaw ──────────

interface Captured {
  ctxPayload: any;
  replyOptions: any;
  params: any;
}

function makeFakeRuntime(captured: Captured[], cfg: Record<string, unknown> = {}) {
  let pendingCtxPayload: any;
  return {
    version: '2026.10.5',
    channel: {
      inbound: {
        run: async (params: any) => {
          captured.push({ params, ctxPayload: pendingCtxPayload, replyOptions: undefined });
          pendingCtxPayload = undefined;
          const resolved = params.adapter.resolveTurn?.(params.raw, {}, {});
          try {
            await resolved?.runDispatch?.();
          } catch {
            /* dispatchReply 抛错由 dispatchToOpenClaw 自行处理 */
          }
          return { dispatched: true };
        },
        buildContext: (params: any) => {
          // ⚠️ 必须捕获**返回对象**：dispatch 在 buildInboundContext 的返回值上
          // 追加 InboundEventKind（入站分类结果），捕获入参看不到。
          const built = { ...params, __built: true };
          pendingCtxPayload = built;
          return built;
        },
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: (params: any) => {
          params?.replyOptions?.turnAdoptionLifecycle?.onAdopted?.();
          const last = captured[captured.length - 1];
          if (last) last.replyOptions = params?.replyOptions;
          return { queuedFinal: true, counts: { final: 1 } };
        },
      },
      routing: {
        resolveAgentRoute: (params: any) => ({
          sessionKey: `qqbot:test:group:${params.peer.id}`,
          accountId: params.accountId,
          agentId: 'default',
        }),
      },
      session: {
        resolveStorePath: () => '',
        recordInboundSession: async () => {},
      },
    },
    config: { current: cfg },
  } as unknown as PluginRuntime;
}

/** 内存态假队列（按到达序领行） */
function makeFakeQueue() {
  const rows = new Map<string, { payload: any; receivedAt: number; laneKey: string }>();
  return {
    rows,
    async enqueue(id: string, payload: any, options?: { receivedAt?: number; laneKey?: string }) {
      rows.set(id, { payload, receivedAt: options?.receivedAt ?? Date.now(), laneKey: options?.laneKey ?? '' });
      return { id, state: 'pending' as const };
    },
    async listPending() {
      return [...rows.entries()].map(([id, r]) => ({ id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey }));
    },
    async claimNext(options?: { blockedLaneKeys?: Iterable<string> }) {
      const blocked = new Set(options?.blockedLaneKeys ?? []);
      const sorted = [...rows.entries()].sort((a, b) => a[1].receivedAt - b[1].receivedAt);
      for (const [id, r] of sorted) {
        if (blocked.has(r.laneKey)) continue;
        return { id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey };
      }
      return null;
    },
    async claim(id: string) {
      const r = rows.get(id);
      return r ? { id, payload: r.payload, receivedAt: r.receivedAt, laneKey: r.laneKey } : null;
    },
    async complete(id: string | { id: string }) {
      const key = typeof id === 'string' ? id : id.id;
      return rows.delete(key);
    },
    async release() { return true; },
    async fail() { return true; },
    async recoverStaleClaims() { return 0; },
    async prune() { return 0; },
  };
}

/**
 * 每次运行的唯一后缀。
 *
 * ⚠️ 幂等守卫（`createIngressEffectOnce` → `createClaimableDedupe`）是**跨进程
 * 持久化**的：批次指纹（laneKey + 最小/最大 messageId + 条数）一旦用过就再也
 * 不会重放。测试必须用**每次运行唯一**的群 id（⇒ laneKey 唯一 ⇒ 指纹唯一），
 * 否则第二次跑本文件会被判 replayed ⇒ 派发被跳过 ⇒ 断言全灭。
 */
const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const GROUP_ID = `GROUP_${RUN_ID}`;

let seq = 0;
function makeGroupMsg(overrides: Record<string, unknown> = {}) {
  seq += 1;
  const groupId = (overrides.groupId as string) ?? GROUP_ID;
  const senderId = (overrides.senderId as string) ?? 'USER_A';
  const messageId = (overrides.messageId as string) ?? `g-msg-${seq}`;
  const content = (overrides.content as string) ?? '你好';
  const msg = {
    kind: 'group',
    messageId,
    content,
    senderId,
    senderName: (overrides.senderName as string) ?? '用户A',
    timestamp: (overrides.timestamp as string) ?? String(1700000000 + seq),
    rawEventType: (overrides.rawEventType as string) ?? 'GROUP_MESSAGE_CREATE',
    replyTarget: { scope: 'group', targetId: groupId },
    mentions: overrides.mentions,
  } as unknown as QQBotInboundMessage;

  const ctx = {
    message: { ...msg },
    state: {
      mention: { wasMentioned: overrides.mentioned === true, implicit: false },
      nameMentioned: false,
      mentionPatterns: [],
      processedAttachments: {
        voiceText: '',
        imageUrls: [],
        otherInfo: '',
        transcripts: [],
        localMediaPaths: [],
        localMediaTypes: [],
        remoteMediaUrls: [],
        media: [],
      },
      history: [],
    },
    signal: new AbortController().signal,
  } as unknown as MiddlewareContext;
  return { msg, ctx, messageId, groupId, senderId };
}

/** 造一个把 durable 队列接上假 runtime 的环境 */
function makeDurableEnv(captured: Captured[], cfg: Record<string, unknown> = {}) {
  const runtime = makeFakeRuntime(captured, cfg) as unknown as PluginRuntime & {
    state: Record<string, unknown>;
  };
  const queue = makeFakeQueue();
  let drainOptions: any;
  runtime.state = {
    openChannelIngressQueue: () => queue as never,
    openChannelIngressDrain: (options: any) => {
      drainOptions = options;
      return {
        recoverStaleClaims: async () => 0,
        drainOnce: async () => ({ started: 0 }),
        activeLaneKeys: () => new Set<string>(),
        waitForIdle: async () => {},
        dispose: () => {},
      } as never;
    },
  };
  return { runtime, queue, getDrainOptions: () => drainOptions };
}

/** 假 lifecycle（drain 侧钩子） */
function fakeLifecycle() {
  return {
    abortSignal: new AbortController().signal,
    onAdopted: () => {},
    onDeferred: () => {},
    onAdoptionFinalizing: () => {},
    onAbandoned: () => {},
  };
}

/** 走一遍「入队 → 领行 → 派发」 */
async function runDurableTurn(params: {
  env: ReturnType<typeof makeDurableEnv>;
  captured: Captured[];
  mentioned?: boolean;
  content?: string;
}) {
  const { env, captured, mentioned = true, content } = params;
  const { resetIngressStateForTest } = await import('../src/features/ingress-queue.js');
  const { resetIngressEffectGuardsForTest } = await import('../src/features/ingress-batcher.js');
  resetIngressStateForTest();
  resetIngressEffectGuardsForTest();

  const { enqueueDurableGroupInbound } = await import('../src/features/ingress-queue.js');
  const account = { accountId: 'acc1', config: {} } as never;
  const { ctx, messageId } = makeGroupMsg({ mentioned, content });

  const outcome = await enqueueDurableGroupInbound({
    ctx,
    msg: (ctx.message as unknown) as QQBotInboundMessage,
    account,
    runtime: env.runtime,
  });

  const options = env.getDrainOptions();
  const claim = await env.queue.claimNext();
  const result = await options.dispatchClaimedEvent(claim, fakeLifecycle());
  return { outcome, result, messageId, claim };
}

await test('R-A：空闲群单条 @ 消息 ⇒ 一条 turn、一次回复、锚点 = 该条 msgId', async () => {
  const captured: Captured[] = [];
  const env = makeDurableEnv(captured);
  const { outcome, result, messageId } = await runDurableTurn({ env, captured, content: '@bot 在吗' });

  assert.equal(outcome, 'handled', '群消息应进 durable 队列');
  assert.equal(result.kind, 'deferred', '队首行的所有权交给回复车道');

  assert.equal(captured.length, 1, '应只有一条 turn');
  assert.ok(captured[0]!.ctxPayload, 'ctxPayload 应已产出');
  // 锚点 = 该条 msgId（envelope.messageId 是被动回复锚点的唯一来源）
  assert.equal(captured[0]!.ctxPayload.messageId, messageId, 'envelope.messageId 应保持为该条 msgId');
  assert.equal(captured[0]!.replyOptions?.runId, messageId, 'replyOptions.runId 应为该条 msgId');
});

await test('R-B：群聊回复走被动回复（带 msg_id 锚点，不退化为主动）', async () => {
  const captured: Captured[] = [];
  const env = makeDurableEnv(captured);
  const { messageId } = await runDurableTurn({ env, captured });

  const reply = captured[0]!.replyOptions;
  assert.ok(reply, '应有回复选项');
  // 被动回复必须带锚点（msg_id）；没有锚点就退化成主动发送（白烧预算）。
  //
  // 锚点在 dispatch 层由 `envelope.messageId` 决定（deliverCtx.replyToId /
  // sendText({replyToId})），所以这里断言两件事：
  // ① 源码层：群聊投递路径用 envelope.messageId 当锚点；
  // ② 运行层：durable 往返后 envelope.messageId 仍是原 msg_id。
  const dispatchSrc = readSrc('src/dispatch/dispatch.ts');
  assert.ok(
    dispatchSrc.includes('replyToId: envelope.messageId'),
    '群聊投递必须用 envelope.messageId 作为被动回复锚点',
  );
  assert.equal(captured[0]!.ctxPayload.messageId, messageId, 'durable 往返后锚点不得丢失');
  assert.equal(reply.runId, messageId);
});

await test('R-C：room_event 群里被 @ 的那条仍然是 user_request（不被压成静默）', async () => {
  const captured: Captured[] = [];
  // 该群配成 room_event：未被 @ 的消息才是静默房间事件；被 @ 的必须保留回复权
  const env = makeDurableEnv(captured, {
    channels: {
      qqbot: {
        accounts: {
          acc1: {
            groups: {
              [GROUP_ID]: { unmentionedInbound: 'room_event' },
            },
          },
        },
      },
    },
  });
  const { messageId } = await runDurableTurn({ env, captured, content: '@bot 在吗' });

  const ctxPayload = captured[0]!.ctxPayload;
  assert.ok(ctxPayload, 'ctxPayload 应已产出');
  assert.equal(
    ctxPayload.InboundEventKind,
    'user_request',
    'room_event 群里被 @ 的那条必须分类为 user_request',
  );
  assert.equal(ctxPayload.messageId, messageId);

  // 分类口径（legacy，未被本次改造触碰）：被 @ ⇒ user_request
  const { classifyInboundEventKind } = await import('../src/features/room-event.js');
  const kind = classifyInboundEventKind({
    isGroup: true,
    rawBody: '@bot 在吗',
    wake: { wasMentioned: true, source: 'mention' },
    unmentionedInbound: 'room_event',
  });
  assert.equal(kind, 'user_request', '被 @ 的消息必须分类为 user_request');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
