/**
 * 出站锚点策略（显式锚点 or 主动）+ msg_seq 发号 + 锚点失效兜底
 *
 * 2026-11-03 移除池化选取后的行为锁定：
 * - 网关 resolveOutboundAnchor：**无显式 opts.msgId 一律主动发送**——即使
 *   msgid-cache 里有新鲜锚点也不得锚定（挂 msg_id = 对该消息的回复，
 *   池化挑锚=挂错引用；本组用例就是防「池化被修回来」的守卫）
 * - 显式锚点透传：bot.send 被动 + extra.msg_seq 透传
 * - 锚点失效兜底：40034005/40034128 → 剔除死锚点 + 同内容转主动重发一次；
 *   网络错/其他业务码不重发；passiveOnly 不重发
 * - adapter：显式锚点 seq 发号/失败回滚；无锚点不预选取；诚实重建窗口
 * - msgid-cache：仅剩「接收时刻登记表」职责（peek/evict），无选取面
 */
import { strict as assert } from 'assert';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import {
  clearQuotaCache,
  getPassiveReplyQuotaRemaining,
} from '../src/features/quota-manager.js';
import {
  cacheMsgId,
  evictMsgId,
  peekMsgIdReceivedAt,
  clearMsgIdCache,
} from '../src/features/msgid-cache.js';
import { _resetProactiveBudget, getProactiveUsage } from '../src/features/proactive-budget.js';

function test(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => console.log(`✓ ${name}`)).catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

function group(name: string) {
  console.log(`— ${name}`);
}

// ── 网关层（真实 QQBotGateway 原型 + mock bot）──

const { QQBotGateway } = await import('../src/gateway/qqbot-gateway.ts');

interface RecordedSend { kind: 'send' | 'sendText' | 'sendMedia'; target: any; text?: string; extra?: any }

function makeGateway(botOverrides: {
  send?: (opts: any) => Promise<any>;
  sendText?: (target: any, text: string) => Promise<any>;
  sendMedia?: (params: any) => Promise<any>;
}) {
  const recorded: RecordedSend[] = [];
  const account: any = {
    accountId: 'gwtest',
    appId: 'x',
    markdownSupport: true,
    config: {},
  };
  const gw: any = Object.create(QQBotGateway.prototype);
  gw.account = account;
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  gw.textTimeout = 5_000;
  gw.mediaTimeout = 5_000;
  gw.bot = {
    send: botOverrides.send ?? (async (opts: any) => {
      recorded.push({ kind: 'send', target: opts.target, text: opts.content ?? opts.markdown?.content, extra: opts.extra });
      return { id: `out-${recorded.length}`, timestamp: Date.now() };
    }),
    sendText: botOverrides.sendText ?? (async (target: any, text: string) => {
      recorded.push({ kind: 'sendText', target, text });
      return { id: `out-${recorded.length}`, timestamp: Date.now() };
    }),
    sendMedia: botOverrides.sendMedia ?? (async (params: any) => {
      recorded.push({ kind: 'sendMedia', target: params.target });
      return { message: { id: `media-${recorded.length}`, timestamp: Date.now() } };
    }),
  };
  return { gw, recorded, account };
}

group('网关：显式锚点 or 主动（无锚点绝不选池）');

await test('显式 opts.msgId → bot.send 被动 + extra.msg_seq 透传（1,2,3）', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({});
  const target = { scope: 'c2c' as const, targetId: 'gw-u1' };
  for (let i = 0; i < 3; i++) {
    await gw.sendText(target, `msg-${i}`, { msgId: 'EX_M', msgSeq: i + 1 });
  }
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every((r) => r.kind === 'send'), '显式锚点应全部走 bot.send（被动）');
  assert.ok(recorded.every((r) => r.target.msgId === 'EX_M'));
  assert.deepEqual(recorded.map((r) => r.extra?.msg_seq), [1, 2, 3], 'msg_seq 应原样透传');
  // markdownSupport=true → markdown 字段下发（与 bot.sendText 的 msg_type=2 等价）
  assert.ok(recorded[0]!.text !== undefined);
});

await test('markdownSupport=false → content 字段下发（msg_type=0 等价）', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({});
  gw.account.markdownSupport = false;
  await gw.sendText({ scope: 'c2c', targetId: 'gw-u2' }, 'plain', { msgId: 'EX_M2', msgSeq: 1 });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'send');
  assert.equal(recorded[0]!.text, 'plain');
});

await test('核心策略：缓存里有新鲜锚点但无显式 opts.msgId → 主动发送（不选池）', async () => {
  clearQuotaCache();
  _resetProactiveBudget();
  // 池化时代的缓存形态：同 target 两个新鲜锚点——新模型下必须**无视**它们
  const now = Date.now();
  clearMsgIdCache('c2c', 'gw-pool');
  cacheMsgId('c2c', 'gw-pool', 'STALE_M', { accountId: 'gwtest', receivedAt: now - 60_000 });
  cacheMsgId('c2c', 'gw-pool', 'FRESH_M', { accountId: 'gwtest', receivedAt: now - 10_000 });
  const { gw, recorded } = makeGateway({});
  const before = getProactiveUsage('gwtest').count;
  await gw.sendText({ scope: 'c2c', targetId: 'gw-pool' }, 'hi');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText', '无显式锚点应走 bot.sendText（主动）');
  assert.equal(recorded[0]!.target.msgId, undefined, '主动发送不带 msg_id（挂 msg_id=对该消息的回复，禁止选池）');
  assert.equal(getProactiveUsage('gwtest').count, before + 1, '应计入每日主动预算');
});

await test('群 scope 同样不选池：缓存锚点在场 → 无 opts.msgId 仍主动', async () => {
  clearQuotaCache();
  const now = Date.now();
  clearMsgIdCache('group', 'gw-gpool');
  cacheMsgId('group', 'gw-gpool', 'G_M', { accountId: 'gwtest', receivedAt: now - 30_000 });
  const { gw, recorded } = makeGateway({});
  await gw.sendText({ scope: 'group', targetId: 'gw-gpool' }, 'hi');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText');
  assert.equal(recorded[0]!.target.msgId, undefined);
});

await test('target 裸挂 msgId（无 opts.msgId）→ 剥离，主动发送 + 计数（Sourcery #85-1）', async () => {
  clearQuotaCache();
  _resetProactiveBudget();
  const { gw, recorded } = makeGateway({});
  const before = getProactiveUsage('gwtest').count;
  // 调用方把 msgId 挂在 target 上（而非 opts）——旧实现会原样透传成
  // 无记账/无 seq 的被动发送；显式锚点只认 opts.msgId，裸锚点必须剥离
  await gw.sendText({ scope: 'c2c', targetId: 'gw-bare', msgId: 'BARE_M' } as any, 'hi');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText', '应走主动 bot.sendText');
  assert.equal(recorded[0]!.target.msgId, undefined, 'target 裸 msgId 必须被剥离');
  assert.equal(getProactiveUsage('gwtest').count, before + 1, '剥离后按主动发送计数');
});

// ── 锚点失效兜底（显式锚点）──

group('锚点失效兜底（40034005/40034128 → 转主动重发一次）');

function makeApiError(bizCode: number, httpStatus = 400): ApiError {
  return new ApiError(`API Error [/v2/users/x/messages]: code=${bizCode}`, httpStatus, '/v2/users/x/messages', bizCode, 'platform reject');
}

await test('40034005（msg_id 已过期）→ 同内容转主动重发一次 + 死锚点剔除', async () => {
  clearQuotaCache();
  _resetProactiveBudget();
  clearMsgIdCache('c2c', 'gw-dead1');
  cacheMsgId('c2c', 'gw-dead1', 'DEAD_M1', { accountId: 'gwtest', receivedAt: Date.now() - 60_000 });
  let passiveAttempt = 0;
  const { gw, recorded } = makeGateway({
    send: async () => {
      passiveAttempt += 1;
      throw makeApiError(40034005);
    },
  });
  const result = await gw.sendText(
    { scope: 'c2c', targetId: 'gw-dead1' }, 'must-deliver',
    { msgId: 'DEAD_M1', msgSeq: 1 },
  );
  assert.ok(result.id, '重发应成功返回');
  assert.equal(passiveAttempt, 1, '先尝试被动发送一次');
  // 被动失败后必须主动重发一次：无 msgId、同内容
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText');
  assert.equal(recorded[0]!.target.msgId, undefined);
  assert.equal(recorded[0]!.text, 'must-deliver');
  assert.equal(getProactiveUsage('gwtest').count, 1, '主动重发应计入每日预算');
  // 死锚点被剔除（登记表查不到）+ 配额判死
  assert.equal(peekMsgIdReceivedAt('c2c', 'gw-dead1', 'DEAD_M1'), undefined, '死锚点应从登记表剔除');
  assert.equal(getPassiveReplyQuotaRemaining({ accountId: 'gwtest', msgId: 'DEAD_M1', scope: 'c2c' }), 0, '死锚点配额应判死');
});

await test('40034128（回复次数超限）同 class 兜底', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(40034128); },
  });
  await gw.sendText({ scope: 'c2c', targetId: 'gw-dead2' }, 'x', { msgId: 'DEAD_M2', msgSeq: 1 });
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText', '应转主动重发');
});

// ── passiveOnly：死锚点不转主动重发（progress card 契约）──

group('passiveOnly：死锚点不转主动重发');

await test('passiveOnly 死锚点 → 原错误上抛、不重发、不计预算、锚点仍剔除', async () => {
  clearQuotaCache();
  _resetProactiveBudget();
  clearMsgIdCache('c2c', 'gw-po');
  cacheMsgId('c2c', 'gw-po', 'PO_M', { accountId: 'gwtest', receivedAt: Date.now() - 60_000 });
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(40034005); },
  });
  const before = getProactiveUsage('gwtest').count;
  await assert.rejects(
    () => gw.sendText(
      { scope: 'c2c', targetId: 'gw-po' }, 'card snapshot',
      { msgId: 'PO_M', msgSeq: 1, passiveOnly: true },
    ),
    /40034005/,
    '应原错误上抛（上游按 passiveOnly 语义丢弃）',
  );
  assert.equal(recorded.length, 0, 'passiveOnly 不得转主动重发');
  assert.equal(getProactiveUsage('gwtest').count, before, '不得计入每日主动预算');
  assert.equal(peekMsgIdReceivedAt('c2c', 'gw-po', 'PO_M'), undefined, '死锚点仍应剔除（防后续再撞）');
  assert.equal(
    getPassiveReplyQuotaRemaining({ accountId: 'gwtest', msgId: 'PO_M', scope: 'c2c' }),
    0,
    '死锚点配额应判死（dead 标记）',
  );
});

await test('outbound sendText 把 passiveOnly 透传网关 opts（死锚点决策在网关）', async () => {
  clearQuotaCache();
  const { sendText: serviceSendText, registerGateway, unregisterGateway } =
    await import('../src/outbound/outbound-service.ts');
  const capturedOpts: Array<Record<string, unknown> | undefined> = [];
  const gw: any = {
    sendText: async (_t: unknown, _text: string, opts?: any) => {
      capturedOpts.push(opts);
      return { id: 'svc-ok', timestamp: Date.now() };
    },
  };
  registerGateway('po-svc', gw);
  try {
    const result = await serviceSendText({
      to: 'qqbot:c2c:po-u1',
      text: 'card',
      accountId: 'po-svc',
      replyToId: 'SVC_M',
      account: { accountId: 'po-svc' } as any,
      passiveOnly: true,
    });
    assert.equal(result.messageId, 'svc-ok');
    assert.equal(capturedOpts.length, 1);
    assert.equal(capturedOpts[0]!.msgId, 'SVC_M');
    assert.equal(capturedOpts[0]!.passiveOnly, true, 'passiveOnly 必须透传到网关');
    assert.ok((capturedOpts[0]!.msgSeq as number) >= 1, '非 quotaReserved 路径由 service 预留时发号');
  } finally {
    unregisterGateway('po-svc', gw);
  }
});

await test('重发再失败 → 抛出重发错误（不循环）', async () => {
  clearQuotaCache();
  const { gw } = makeGateway({
    send: async () => { throw makeApiError(40034005); },
    sendText: async () => { throw new Error('proactive also failed'); },
  });
  await assert.rejects(
    () => gw.sendText({ scope: 'c2c', targetId: 'gw-dead3' }, 'x', { msgId: 'DEAD_M3', msgSeq: 1 }),
    /proactive also failed/,
    '应抛出重发错误',
  );
});

await test('网络错（httpStatus=0，结果不明）→ 不重发，原错误上抛', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(0, 0); }, // 网络层失败无业务码
  });
  await assert.rejects(
    () => gw.sendText({ scope: 'c2c', targetId: 'gw-net' }, 'x', { msgId: 'NET_M', msgSeq: 1 }),
    /API Error/i,
  );
  assert.equal(recorded.length, 0, '不应有重发（结果不明，重发有重复风险）');
});

await test('其他业务码（如内容超长）→ 不重发，原错误上抛', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(400001); },
  });
  await assert.rejects(() => gw.sendText({ scope: 'c2c', targetId: 'gw-other' }, 'x', { msgId: 'OTHER_M', msgSeq: 1 }));
  assert.equal(recorded.length, 0, '其他业务码不应触发主动重发');
});

await test('媒体 sendMedia 显式锚点撞 40034005 → 同样转主动重发一次', async () => {
  clearQuotaCache();
  const { gw, recorded } = makeGateway({
    sendMedia: async (params: any) => {
      recorded.push({ kind: 'sendMedia', target: params.target });
      if (params.target.msgId) throw makeApiError(40034005);
      return { message: { id: 'media-retry-ok', timestamp: Date.now() } };
    },
  });
  const result = await gw.sendMedia(
    { scope: 'group', targetId: 'gw-media' }, 'https://example.com/a.png',
    { msgId: 'MEDIA_M', msgSeq: 1 },
  );
  assert.equal(result.id, 'media-retry-ok');
  assert.equal(recorded.length, 2);
  assert.equal(recorded[0]!.target.msgId, 'MEDIA_M', '首次应带显式锚点（被动）');
  assert.equal(recorded[1]!.target.msgId, undefined, '重发不带 msg_id');
});

// ── adapter 层 ──

group('adapter：显式锚点 seq 发号 / 失败回滚 / 无锚点不预选取');

await test('sendTextWithQuota：显式锚点 → msgSeq/quotaReserved 随链下传', async () => {
  clearQuotaCache();
  const { createQQBotOutboundAdapter } = await import('../src/outbound-adapter.ts');
  let captured: any = null;
  const adapter = createQQBotOutboundAdapter({
    sendText: async (params) => {
      captured = params;
      return { messageId: 'ok' };
    },
  });
  await adapter.sendTextWithQuota({
    to: 'qqbot:c2c:ad-u1',
    text: 'hi',
    account: { accountId: 'adacc' } as any,
    replyToId: 'EXPLICIT_M',
  });
  assert.equal(captured.replyToId, 'EXPLICIT_M');
  assert.equal(captured.msgSeq, 1, '首次消耗应发号 seq=1');
  assert.equal(captured.quotaReserved, true);
});

await test('sendTextWithQuota：无锚点 → replyToId=undefined（不查缓存，网关也不再选池）', async () => {
  clearQuotaCache();
  // 该 target 有缓存的 msg_id——adapter 层不得预选取，网关层也不得锚定
  clearMsgIdCache('c2c', 'ad-u2');
  cacheMsgId('c2c', 'ad-u2', 'CACHED_M', { accountId: 'adacc', receivedAt: Date.now() });
  const { createQQBotOutboundAdapter } = await import('../src/outbound-adapter.ts');
  let captured: any = null;
  const adapter = createQQBotOutboundAdapter({
    sendText: async (params) => {
      captured = params;
      return { messageId: 'ok' };
    },
  });
  await adapter.sendTextWithQuota({
    to: 'qqbot:c2c:ad-u2',
    text: 'hi',
    account: { accountId: 'adacc' } as any,
  });
  assert.equal(captured.replyToId, undefined, 'adapter 无显式锚点不得预选取');
  assert.equal(captured.msgSeq, undefined);
  assert.equal(captured.quotaReserved, false);
});

await test('sendTextWithQuota：发送失败 → 回滚已消耗的配额', async () => {
  clearQuotaCache();
  const { createQQBotOutboundAdapter } = await import('../src/outbound-adapter.ts');
  const adapter = createQQBotOutboundAdapter({
    sendText: async () => ({ messageId: undefined, error: 'send failed' }),
  });
  const result = await adapter.sendTextWithQuota({
    to: 'qqbot:c2c:ad-u3',
    text: 'hi',
    account: { accountId: 'adacc' } as any,
    replyToId: 'ROLLBACK_M',
  });
  assert.ok(result.error, '失败结果应原样返回');
  assert.equal(
    getPassiveReplyQuotaRemaining({ accountId: 'adacc', msgId: 'ROLLBACK_M', scope: 'c2c' }),
    4,
    '发送失败后配额应回滚至满额',
  );
});

// ── 诚实重建（显式锚点的 adapter 消耗路径）──

group('诚实重建：配额条目被淘汰后按真实接收时间重建窗口');

await test('adapter 消耗路径：条目缺失时窗口按 receivedAt（登记表）重建', async () => {
  clearQuotaCache();
  // 锚点 59min 龄（c2c 窗口 60min 内）——模拟配额条目被容量控制淘汰
  const now = Date.now();
  clearMsgIdCache('c2c', 'rb-u1');
  cacheMsgId('c2c', 'rb-u1', 'RB_M', { accountId: 'adacc', receivedAt: now - 59 * 60_000 });
  const { __test_getQuotaCache } = await import('../src/features/quota-manager.ts');
  __test_getQuotaCache().delete(`adacc:c2c:RB_M`);
  assert.equal(__test_getQuotaCache().has(`adacc:c2c:RB_M`), false, '前提：条目已缺失');

  const { createQQBotOutboundAdapter } = await import('../src/outbound-adapter.ts');
  let captured: any = null;
  const adapter = createQQBotOutboundAdapter({
    sendText: async (params) => {
      captured = params;
      return { messageId: 'ok' };
    },
  });
  await adapter.sendTextWithQuota({
    to: 'qqbot:c2c:rb-u1',
    text: 'rebuild-test',
    account: { accountId: 'adacc' } as any,
    replyToId: 'RB_M',
  });
  assert.equal(captured.replyToId, 'RB_M', '重建窗口内应正常锚定');
  assert.ok((captured.msgSeq as number) >= 1);

  // 若为旧式 now+TTL 重建，expiresAt 会落在「此刻+60min」；诚实重建下
  // 应锚定真实接收时刻（59min 前 + 60min ≈ 此刻+1min）
  const entry = __test_getQuotaCache().get(`adacc:c2c:RB_M`);
  assert.ok(entry, '消耗后条目应存在');
  const after = Date.now();
  assert.ok(
    entry!.expiresAt > after && entry!.expiresAt <= after + 2 * 60_000,
    `重建窗口应锚定真实接收时刻（receivedAt+60min≈此刻+1min），实际 expiresAt 距今 ${((entry!.expiresAt - after) / 60000).toFixed(1)}min`,
  );
});

// ── msgid-cache：登记表职责（无选取面）──

group('msgid-cache：登记表职责（peek/evict，无选取）');

await test('cacheMsgId 登记 + peekMsgIdReceivedAt 返回平台事件时间', () => {
  clearMsgIdCache('c2c', 'reg-u1');
  const ts = Date.now() - 123_000;
  cacheMsgId('c2c', 'reg-u1', 'REG_M', { accountId: 'reg', receivedAt: ts });
  assert.equal(peekMsgIdReceivedAt('c2c', 'reg-u1', 'REG_M'), ts);
  assert.equal(peekMsgIdReceivedAt('c2c', 'reg-u1', 'MISSING'), undefined);
});

await test('evictMsgId：剔除指定条目，其余保留', () => {
  clearMsgIdCache('c2c', 'reg-u2');
  const now = Date.now();
  cacheMsgId('c2c', 'reg-u2', 'R_A', { accountId: 'reg', receivedAt: now - 60_000 });
  cacheMsgId('c2c', 'reg-u2', 'R_B', { accountId: 'reg', receivedAt: now - 30_000 });
  evictMsgId('c2c', 'reg-u2', 'R_A');
  assert.equal(peekMsgIdReceivedAt('c2c', 'reg-u2', 'R_A'), undefined);
  assert.equal(peekMsgIdReceivedAt('c2c', 'reg-u2', 'R_B'), now - 30_000);
});

console.log('All passive anchor policy tests passed');
