/**
 * 被动锚点选取（旧配额优先）+ msg_seq 显式发号 + 锚点失效兜底
 *
 * 覆盖：
 * - selectMsgIdForPassiveReply：旧→新遍历、窗口过期/额度耗尽跳过、全空降级、
 *   c2c 60min 窗口对齐（45min 龄候选可选）
 * - 网关 attachMsgIdWithQuota：选取+发号收敛；bot.send 携带 extra.msg_seq 单调
 * - 锚点失效兜底：40034005/40034128 → 剔除死锚点 + 同内容转主动重发一次；
 *   网络错/其他业务码不重发
 * - adapter：显式锚点 seq 透传；无锚点不再查 msgid-cache（收敛到网关）
 */
import { strict as assert } from 'assert';
import { ApiError } from '@tencent-connect/qqbot-nodejs';
import {
  clearQuotaCache,
  getPassiveReplyQuotaRemaining,
  checkAndConsumePassiveReplyQuota,
} from '../src/features/quota-manager.js';
import {
  cacheMsgId,
  selectMsgIdForPassiveReply,
  evictMsgId,
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

// ── 选取（纯探测）──

group('selectMsgIdForPassiveReply（旧配额优先）');

await test('两个可用候选 → 选最旧', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u1');
  const now = Date.now();
  cacheMsgId('c2c', 'sel-u1', 'M_OLD', { accountId: 'sel', receivedAt: now - 60_000 });
  cacheMsgId('c2c', 'sel-u1', 'M_NEW', { accountId: 'sel', receivedAt: now - 10_000 });
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u1' }),
    'M_OLD',
  );
});

await test('最旧群候选超 5 分钟平台窗口 → 跳选取次旧', () => {
  clearQuotaCache();
  clearMsgIdCache('group', 'sel-g1');
  const now = Date.now();
  cacheMsgId('group', 'sel-g1', 'G_EXPIRED', { accountId: 'sel', receivedAt: now - 6 * 60_000 });
  cacheMsgId('group', 'sel-g1', 'G_FRESH', { accountId: 'sel', receivedAt: now - 60_000 });
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'group', targetId: 'sel-g1' }),
    'G_FRESH',
  );
});

await test('最旧额度耗尽 → 跳选取次旧', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u2');
  const now = Date.now();
  cacheMsgId('c2c', 'sel-u2', 'M_EXH', { accountId: 'sel', receivedAt: now - 60_000 });
  cacheMsgId('c2c', 'sel-u2', 'M_AVAIL', { accountId: 'sel', receivedAt: now - 30_000 });
  // 烧干 M_EXH 的 4 次额度
  for (let i = 0; i < 4; i++) {
    const { canReply } = checkAndConsumePassiveReplyQuota({ accountId: 'sel', msgId: 'M_EXH', scope: 'c2c' });
    assert.equal(canReply, true);
  }
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u2' }),
    'M_AVAIL',
  );
});

await test('全部耗尽/过期 → undefined（降级主动）', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u3');
  const now = Date.now();
  cacheMsgId('c2c', 'sel-u3', 'M_ONLY', { accountId: 'sel', receivedAt: now - 61 * 60_000 });
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u3' }),
    undefined,
  );
});

await test('c2c 45min 龄候选可选（TTL 对齐平台 60min）', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u4');
  // 旧实现 msgid-cache c2c TTL=30min 会漏掉 30~60min 区间的合法锚点
  cacheMsgId('c2c', 'sel-u4', 'M_45MIN', { accountId: 'sel', receivedAt: Date.now() - 45 * 60_000 });
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u4' }),
    'M_45MIN',
  );
});

await test('平台 timestamp 缺失（NaN）→ 本地时钟兜底登记可选', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u5');
  cacheMsgId('c2c', 'sel-u5', 'M_NOTS'); // 无 receivedAt → Date.now()
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u5' }),
    'M_NOTS',
  );
});

await test('evictMsgId：剔除后不再被选取', () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'sel-u6');
  const now = Date.now();
  cacheMsgId('c2c', 'sel-u6', 'M_A', { accountId: 'sel', receivedAt: now - 60_000 });
  cacheMsgId('c2c', 'sel-u6', 'M_B', { accountId: 'sel', receivedAt: now - 30_000 });
  evictMsgId('c2c', 'sel-u6', 'M_A');
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'sel', scope: 'c2c', targetId: 'sel-u6' }),
    'M_B',
  );
});

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

function seedAnchor(targetId: string, msgId: string, ageMs = 60_000, scope: 'c2c' | 'group' = 'c2c') {
  clearMsgIdCache(scope, targetId);
  cacheMsgId(scope, targetId, msgId, { accountId: 'gwtest', receivedAt: Date.now() - ageMs });
}

group('网关：选取收敛 + msg_seq 发号');

await test('被动 sendText 走 bot.send 且 extra.msg_seq 单调（1,2,3）', async () => {
  clearQuotaCache();
  seedAnchor('gw-u1', 'GW_M1');
  const { gw, recorded } = makeGateway({});
  const target = { scope: 'c2c' as const, targetId: 'gw-u1' };
  for (let i = 0; i < 3; i++) {
    await gw.sendText(target, `msg-${i}`);
  }
  assert.equal(recorded.length, 3);
  assert.ok(recorded.every((r) => r.kind === 'send'), '带锚点应全部走 bot.send');
  assert.ok(recorded.every((r) => r.target.msgId === 'GW_M1'));
  assert.deepEqual(recorded.map((r) => r.extra?.msg_seq), [1, 2, 3], 'msg_seq 应从 1 单调递增');
  // markdownSupport=true → markdown 字段下发（与 bot.sendText 的 msg_type=2 等价）
  assert.ok(recorded[0]!.text !== undefined);
});

await test('markdownSupport=false → content 字段下发（msg_type=0 等价）', async () => {
  clearQuotaCache();
  seedAnchor('gw-u2', 'GW_M2');
  const { gw, recorded } = makeGateway({});
  gw.account.markdownSupport = false;
  await gw.sendText({ scope: 'c2c', targetId: 'gw-u2' }, 'plain');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'send');
  assert.equal(recorded[0]!.text, 'plain');
});

await test('无候选 → bot.sendText 主动（无 msgId）+ 预算计数', async () => {
  clearQuotaCache();
  clearMsgIdCache('c2c', 'gw-quiet');
  _resetProactiveBudget();
  const { gw, recorded } = makeGateway({});
  const before = getProactiveUsage('gwtest').count;
  await gw.sendText({ scope: 'c2c', targetId: 'gw-quiet' }, 'hi');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText');
  assert.equal(recorded[0]!.target.msgId, undefined, '主动发送不带 msg_id');
  assert.equal(getProactiveUsage('gwtest').count, before + 1);
});

await test('连发 3 条消息场景：无锚点发送依次烧旧配额（旧→新）', async () => {
  clearQuotaCache();
  const now = Date.now();
  clearMsgIdCache('c2c', 'gw-multi');
  cacheMsgId('c2c', 'gw-multi', 'MM1', { accountId: 'gwtest', receivedAt: now - 3 * 60_000 });
  cacheMsgId('c2c', 'gw-multi', 'MM2', { accountId: 'gwtest', receivedAt: now - 2 * 60_000 });
  cacheMsgId('c2c', 'gw-multi', 'MM3', { accountId: 'gwtest', receivedAt: now - 60_000 });
  const { gw, recorded } = makeGateway({});
  const target = { scope: 'c2c' as const, targetId: 'gw-multi' };
  // MM1 4 槽烧干 → 切 MM2
  for (let i = 0; i < 5; i++) {
    await gw.sendText(target, `t${i}`);
  }
  const anchors = recorded.map((r) => r.target.msgId);
  assert.deepEqual(
    anchors,
    ['MM1', 'MM1', 'MM1', 'MM1', 'MM2'],
    '前 4 次烧最旧 MM1，耗尽自动切 MM2',
  );
  assert.deepEqual(recorded.map((r) => r.extra?.msg_seq), [1, 2, 3, 4, 1], 'seq 按 msg_id 各自从 1 计数');
});

// ── 锚点失效兜底 ──

group('锚点失效兜底（40034005/40034128 → 转主动重发一次）');

function makeApiError(bizCode: number, httpStatus = 400): ApiError {
  return new ApiError(`API Error [/v2/users/x/messages]: code=${bizCode}`, httpStatus, '/v2/users/x/messages', bizCode, 'platform reject');
}

await test('40034005（msg_id 已过期）→ 同内容转主动重发一次', async () => {
  clearQuotaCache();
  seedAnchor('gw-dead1', 'DEAD_M1');
  _resetProactiveBudget();
  let passiveAttempt = 0;
  const { gw, recorded } = makeGateway({
    send: async () => {
      passiveAttempt += 1;
      throw makeApiError(40034005);
    },
  });
  const result = await gw.sendText({ scope: 'c2c', targetId: 'gw-dead1' }, 'must-deliver');
  assert.ok(result.id, '重发应成功返回');
  assert.equal(passiveAttempt, 1, '先尝试被动发送一次');
  // 被动失败后必须主动重发一次：无 msgId、同内容
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText');
  assert.equal(recorded[0]!.target.msgId, undefined);
  assert.equal(recorded[0]!.text, 'must-deliver');
  assert.equal(getProactiveUsage('gwtest').count, 1, '主动重发应计入每日预算');
  // 死锚点被剔除：后续选取不再命中
  assert.equal(
    selectMsgIdForPassiveReply({ accountId: 'gwtest', scope: 'c2c', targetId: 'gw-dead1' }),
    undefined,
  );
});

await test('40034128（回复次数超限）同 class 兜底', async () => {
  clearQuotaCache();
  seedAnchor('gw-dead2', 'DEAD_M2');
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(40034128); },
  });
  await gw.sendText({ scope: 'c2c', targetId: 'gw-dead2' }, 'x');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.kind, 'sendText', '应转主动重发');
});

await test('重发再失败 → 抛出重发错误（不循环）', async () => {
  clearQuotaCache();
  seedAnchor('gw-dead3', 'DEAD_M3');
  const { gw } = makeGateway({
    send: async () => { throw makeApiError(40034005); },
    sendText: async () => { throw new Error('proactive also failed'); },
  });
  await assert.rejects(
    () => gw.sendText({ scope: 'c2c', targetId: 'gw-dead3' }, 'x'),
    /proactive also failed/,
    '应抛出重发错误',
  );
});

await test('网络错（httpStatus=0，结果不明）→ 不重发，原错误上抛，配额回滚', async () => {
  clearQuotaCache();
  seedAnchor('gw-net', 'NET_M');
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(0, 0); }, // 网络层失败无业务码
  });
  await assert.rejects(
    () => gw.sendText({ scope: 'c2c', targetId: 'gw-net' }, 'x'),
    /API Error/i,
  );
  assert.equal(recorded.length, 0, '不应有重发（结果不明，重发有重复风险）');
  // 配额已回滚：剩余额度恢复满额
  assert.equal(
    getPassiveReplyQuotaRemaining({ accountId: 'gwtest', msgId: 'NET_M', scope: 'c2c' }),
    4,
  );
});

await test('其他业务码（如内容超长）→ 不重发，原错误上抛', async () => {
  clearQuotaCache();
  seedAnchor('gw-other', 'OTHER_M');
  const { gw, recorded } = makeGateway({
    send: async () => { throw makeApiError(400001); },
  });
  await assert.rejects(() => gw.sendText({ scope: 'c2c', targetId: 'gw-other' }, 'x'));
  assert.equal(recorded.length, 0, '其他业务码不应触发主动重发');
});

await test('媒体 sendMedia 撞 40034005 → 同样转主动重发一次', async () => {
  clearQuotaCache();
  seedAnchor('gw-media', 'MEDIA_M', 60_000, 'group');
  const { gw, recorded } = makeGateway({
    sendMedia: async (params: any) => {
      recorded.push({ kind: 'sendMedia', target: params.target });
      if (params.target.msgId) throw makeApiError(40034005);
      return { message: { id: 'media-retry-ok', timestamp: Date.now() } };
    },
  });
  const result = await gw.sendMedia({ scope: 'group', targetId: 'gw-media' }, 'https://example.com/a.png');
  assert.equal(result.id, 'media-retry-ok');
  assert.equal(recorded.length, 2);
  assert.ok(recorded[0]!.target.msgId, '首次应带锚点（被动）');
  assert.equal(recorded[1]!.target.msgId, undefined, '重发不带 msg_id');
});

// ── adapter 层 ──

group('adapter：显式锚点 seq 透传 / 无锚点收敛到网关');

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

await test('sendTextWithQuota：无锚点 → 不再查 msgid-cache（replyToId=undefined）', async () => {
  clearQuotaCache();
  // 该 target 有缓存的 msg_id——adapter 层也不应锚定（选取收敛到网关）
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

console.log('All passive anchor selection tests passed');
