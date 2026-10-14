/**
 * 访问控制拒绝提示回归测试（allowFrom 未命中 → 不再静默丢弃）
 *
 * 场景：`dmPolicy: "allowlist"`（默认）下，发送者 OpenID 不在 `allowFrom`，
 * 此前被 `dynamicAccessControl` 直接 `ctx.stop('access:not_allowlisted')`，
 * 用户侧零反馈——bot 挂了 / 装睡 / 配置写错三种情况无法区分。OpenID 是
 * per-account 的，配错本身就是高频操作。
 *
 * 本文件钉住三条边界（改任一条都要同步改 features/access-notice.ts 头注释）：
 * 1. c2c 恒回告、群仅在被 @/引用 bot 时回告（群提示是公开广播）
 * 2. `disabled` 总闸与 `pairing`（已有配对挑战文案）保持静默原样
 * 3. 同一被拒实体 10 分钟冷却 + 每账号每日上限；发送失败必须回滚预留，
 *    否则一次发送失败会让该用户彻底静默——等于把本次要修的 bug 换入口复现
 *
 * pairing 分支不在此覆盖：`getPairingApi()` 走 openclaw 真实 pairing store，
 * 单测里不应触碰；该分支代码本次未改动。
 *
 * 运行方式: npx tsx tests/access-notice.test.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ref-index 单例在首次 get 时按 ~/.openclaw 落盘，测试期先把 HOME 挪进 tmpdir
const fakeHome = mkdtempSync(path.join(tmpdir(), 'qqbot-access-notice-'));
const realHome = process.env.HOME;
process.env.HOME = fakeHome;

const {
  ACCESS_NOTICE_COOLDOWN_MS,
  ACCESS_NOTICE_DAILY_CAP,
  ACCESS_NOTICE_SEND_TIMEOUT_MS,
  NoticeSendTimeoutError,
  _resetAccessNotice,
  buildAccessNoticeText,
  isMessageAddressedToBot,
  reserveAccessNotice,
} = await import('../src/features/access-notice.js');
const { flushAllRefIndexStores, getPersistedRefIndexStore } = await import('../src/features/ref-index-store.js');
const { dynamicAccessControl } = await import('../src/middleware/access-control.js');

const ACCT = 'acct-notice';
const ALLOWED = 'ALLOWED_OPENID_0001';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  ❌ ${name}`);
    console.error(`     ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ============ 1. 文案构建 ============

console.log('\n=== 1. buildAccessNoticeText ===');

await test('c2c 文案带出用户自己的 OpenID 与配置位置', () => {
  const text = buildAccessNoticeText({ scope: 'c2c', id: 'MY_OPENID_ABC', accountId: 'default' });
  assert.ok(text.includes('MY_OPENID_ABC'), '必须带出用户自己的 ID，用户才能直接粘贴');
  assert.ok(text.includes('channels.qqbot.allowFrom'), '必须指出配置位置');
  assert.ok(text.includes('dmPolicy'), '应给出免手工改配置的替代路径');
});

await test('非 default 账号：准确路径是 accounts.<id>，不是顶层键', () => {
  const text = buildAccessNoticeText({ scope: 'c2c', id: 'X', accountId: 'bot2' });
  assert.ok(text.includes('channels.qqbot.accounts.bot2.allowFrom'), '主路径必须是账号自己的键');
  assert.ok(!text.includes('`channels.qqbot.allowFrom`'), '顶层键属于 default 账号，指错地方会让人白改');
});

await test('群提示不得出现真实 accountId（公开广播给全体成员）', () => {
  const text = buildAccessNoticeText({ scope: 'group', id: 'G', accountId: 'secret-bot-name' });
  assert.ok(!text.includes('secret-bot-name'), '群成员不应看到内部账号名');
  assert.ok(text.includes('accounts.<accountId>'), '改给泛化指引，账号所有者知道是哪一层');
  assert.ok(text.includes('channels.qqbot.groupAllowFrom'));
});

await test('default 账号不出现 accounts 提示', () => {
  const c2c = buildAccessNoticeText({ scope: 'c2c', id: 'X', accountId: 'default' });
  assert.ok(!c2c.includes('accounts.'));
  const grp = buildAccessNoticeText({ scope: 'group', id: 'G', accountId: 'default' });
  assert.ok(!grp.includes('accounts.'));
});

await test('文案绝不回显白名单内容（不向陌生人泄露配置）', () => {
  const text = buildAccessNoticeText({ scope: 'c2c', id: 'REJECTED_ID', accountId: 'default' });
  assert.ok(!text.includes(ALLOWED), '被拒者只应看到自己的 ID');
});

// ============ 2. 群「是否在叫 bot」判定 ============

console.log('\n=== 2. isMessageAddressedToBot ===');

await test('GROUP_AT_MESSAGE_CREATE = QQ 权威的 @ 信号', () => {
  assert.equal(isMessageAddressedToBot({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' }, '1', ACCT), true);
});

await test('结构化 mentions 里 is_you = 被 @', () => {
  assert.equal(isMessageAddressedToBot({ mentions: [{ is_you: false }, { is_you: true }] }, '1', ACCT), true);
});

await test('内容里的 @appId 标记兜底（全量事件下 SDK 同样扫这一路）', () => {
  assert.equal(isMessageAddressedToBot({ content: '<@!998877> 在吗' }, '998877', ACCT), true);
});

await test('@ 了别人 / 普通闲聊 = 未点名 bot（群里不回告，避免公开广播）', () => {
  assert.equal(isMessageAddressedToBot({ mentions: [{ is_you: false }], content: '<@!123> 早上好' }, '998877', ACCT), false);
  assert.equal(isMessageAddressedToBot({ content: '随便聊聊' }, '998877', ACCT), false);
});

await test('引用 bot 出站消息 = 隐式被点名（与 mentionGate 同源判定）', () => {
  const store = getPersistedRefIndexStore(ACCT);
  store.set('REFIDX_BOT', { isBot: true } as never);
  store.set('REFIDX_HUMAN', { isBot: false } as never);
  assert.equal(isMessageAddressedToBot({ refMsgIdx: 'REFIDX_BOT' }, '998877', ACCT), true);
  assert.equal(isMessageAddressedToBot({ refMsgIdx: 'REFIDX_HUMAN' }, '998877', ACCT), false);
});

await test('appId 未就绪时不误判（宁可漏回告也不在陌生群广播）', () => {
  assert.equal(isMessageAddressedToBot({ content: '<@!998877>' }, undefined, ACCT), false);
  assert.equal(isMessageAddressedToBot(undefined, '998877', ACCT), false);
});

// ============ 3. 节流 ============

console.log('\n=== 3. reserveAccessNotice ===');

await test('首次放行，冷却窗口内拒绝', () => {
  _resetAccessNotice();
  const t0 = 1_000_000;
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U1', now: t0 }).allowed, true);
  const second = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U1', now: t0 + 1000 });
  assert.equal(second.allowed, false);
  assert.equal(second.allowed ? '' : second.reason, 'cooldown');
});

await test('冷却窗口过后恢复', () => {
  _resetAccessNotice();
  const t0 = 2_000_000;
  reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U2', now: t0 });
  const later = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U2', now: t0 + ACCESS_NOTICE_COOLDOWN_MS });
  assert.equal(later.allowed, true);
});

await test('不同被拒实体互不干扰（同一人连发 + 群与人分开计数）', () => {
  _resetAccessNotice();
  const t0 = 3_000_000;
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'UA', now: t0 }).allowed, true);
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'UB', now: t0 }).allowed, true);
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'group', id: 'UA', now: t0 }).allowed, true);
});

await test('release() 回滚预留（发送失败不能让用户彻底静默）', () => {
  _resetAccessNotice();
  const t0 = 4_000_000;
  const r = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U3', now: t0 });
  assert.equal(r.allowed, true);
  r.release();
  const retry = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'U3', now: t0 + 1000 });
  assert.equal(retry.allowed, true, '回滚后应能立刻再发');
});

await test('每账号每日上限生效', () => {
  _resetAccessNotice();
  const t0 = 5_000_000;
  for (let i = 0; i < ACCESS_NOTICE_DAILY_CAP; i++) {
    const r = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: `spam-${i}`, now: t0 });
    assert.equal(r.allowed, true, `第 ${i} 条应放行`);
  }
  const over = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'spam-over', now: t0 });
  assert.equal(over.allowed, false);
  assert.equal(over.allowed ? '' : over.reason, 'daily_cap');
});

await test('每日上限按账号隔离（B 账号不受 A 账号刷屏影响）', () => {
  _resetAccessNotice();
  const t0 = 6_000_000;
  for (let i = 0; i < ACCESS_NOTICE_DAILY_CAP; i++) {
    reserveAccessNotice({ accountId: 'acct-A', scope: 'c2c', id: `x-${i}`, now: t0 });
  }
  assert.equal(reserveAccessNotice({ accountId: 'acct-A', scope: 'c2c', id: 'x-more', now: t0 }).allowed, false);
  assert.equal(reserveAccessNotice({ accountId: 'acct-B', scope: 'c2c', id: 'x-0', now: t0 }).allowed, true);
});

await test('跨天自动重置每日上限', () => {
  _resetAccessNotice();
  const t0 = Date.parse('2026-10-14T10:00:00Z');
  for (let i = 0; i < ACCESS_NOTICE_DAILY_CAP; i++) {
    reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: `d-${i}`, now: t0 });
  }
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'd-over', now: t0 }).allowed, false);
  const nextDay = t0 + 25 * 60 * 60 * 1000;
  assert.equal(reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'd-over', now: nextDay }).allowed, true);
});

// ============ 4. 中间件端到端 ============

console.log('\n=== 4. dynamicAccessControl 拒绝回告 ===');

interface MsgOverrides {
  kind?: string;
  senderId?: string;
  groupOpenid?: string;
  content?: string;
  mentions?: Array<{ is_you?: boolean }>;
  rawEventType?: string;
  refMsgIdx?: string;
  msgId?: string;
}

function makeCtx(policy: Record<string, unknown>, msg: MsgOverrides = {}, opts: { failSend?: boolean; hangSend?: boolean } = {}) {
  const sent: Array<{ target: unknown; text: string }> = [];
  let stopReason: string | undefined;
  let nextCalled = false;
  const senderId = msg.senderId ?? 'REJECTED_OPENID';
  const isGroup = (msg.kind ?? 'c2c') === 'group';
  const targetId = isGroup ? (msg.groupOpenid ?? 'REJECTED_GROUP') : senderId;
  const logs: string[] = [];

  const ctx = {
    message: { kind: msg.kind ?? 'c2c', senderId, ...msg },
    replyTarget: { scope: isGroup ? 'group' : 'c2c', targetId, msgId: msg.msgId ?? 'm-1' },
    bot: {
      appId: '998877',
      sendText: async (target: unknown, text: string) => {
        if (opts.hangSend) await new Promise(() => {}); // 永不 settle：复现挂住的请求
        if (opts.failSend) throw new Error('boom: send failed');
        sent.push({ target, text });
      },
    },
    state: { policy },
    log: {
      info: (m: string) => logs.push(`INFO ${m}`),
      warn: (m: string) => logs.push(`WARN ${m}`),
      error: (m: string) => logs.push(`ERROR ${m}`),
      debug: (m: string) => logs.push(`DEBUG ${m}`),
    },
    stop: (reason: string) => {
      stopReason = reason;
    },
  };
  return { ctx, sent, logs, getStop: () => stopReason, getNext: () => nextCalled, setNext: (v: boolean) => { nextCalled = v; } };
}

const mw = dynamicAccessControl({ accountId: ACCT, getRuntime: () => ({}) });

await test('c2c 未命中 allowFrom → 回告含自身 ID 的提示并拦截', async () => {
  _resetAccessNotice();
  const h = makeCtx({ c2cMode: 'allowlist', allowFrom: [ALLOWED] }, { senderId: 'MY_ID_777' });
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 1, '应恰好回一条提示');
  assert.ok(h.sent[0].text.includes('MY_ID_777'));
  assert.equal(h.getStop(), 'access:not_allowlisted');
  assert.equal(h.getNext(), false, '拦截后不得继续下游');
});

await test('c2c 命中 allowFrom → 放行且不发提示', async () => {
  _resetAccessNotice();
  const h = makeCtx({ c2cMode: 'allowlist', allowFrom: [ALLOWED] }, { senderId: ALLOWED });
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 0);
  assert.equal(h.getStop(), undefined);
  assert.equal(h.getNext(), true);
});

await test('allowFrom 为空或 * → 放行（既有语义不变）', async () => {
  _resetAccessNotice();
  const h1 = makeCtx({ c2cMode: 'allowlist', allowFrom: [] }, { senderId: 'ANY' });
  await mw(h1.ctx as never, (async () => h1.setNext(true)) as never);
  const h2 = makeCtx({ c2cMode: 'allowlist', allowFrom: ['*'] }, { senderId: 'ANY' });
  await mw(h2.ctx as never, (async () => h2.setNext(true)) as never);
  assert.equal(h1.sent.length + h2.sent.length, 0);
  assert.equal(h1.getNext() && h2.getNext(), true);
});

await test('policy disabled = 管理员总闸，保持静默（回话等于架空该开关）', async () => {
  _resetAccessNotice();
  const h = makeCtx({ c2cMode: 'disabled', allowFrom: [ALLOWED] }, { senderId: 'MY_ID_777' });
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 0);
  assert.equal(h.getStop(), 'access:policy_disabled');
});

await test('群未命中 groupAllowFrom + 普通闲聊 → 静默（不公开广播白名单配置）', async () => {
  _resetAccessNotice();
  const h = makeCtx(
    { groupMode: 'allowlist', groupAllowFrom: ['GRP_OK'] },
    { kind: 'group', groupOpenid: 'GRP_OTHER', content: '大家好啊' },
  );
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 0, '未点名 bot 的群消息不得回告');
  assert.equal(h.getStop(), 'access:not_allowlisted');
});

await test('群未命中 + @ 了 bot → 回告群 ID', async () => {
  _resetAccessNotice();
  const h = makeCtx(
    { groupMode: 'allowlist', groupAllowFrom: ['GRP_OK'] },
    { kind: 'group', groupOpenid: 'GRP_OTHER', rawEventType: 'GROUP_AT_MESSAGE_CREATE' },
  );
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0].text.includes('GRP_OTHER'));
  assert.ok(h.sent[0].text.includes('groupAllowFrom'));
});

await test('群未命中 + mentions.is_you / 引用 bot 消息 → 回告', async () => {
  _resetAccessNotice();
  const h1 = makeCtx(
    { groupMode: 'allowlist', groupAllowFrom: ['GRP_OK'] },
    { kind: 'group', groupOpenid: 'GRP_M1', mentions: [{ is_you: true }] },
  );
  await mw(h1.ctx as never, (async () => h1.setNext(true)) as never);
  assert.equal(h1.sent.length, 1);

  _resetAccessNotice();
  const h2 = makeCtx(
    { groupMode: 'allowlist', groupAllowFrom: ['GRP_OK'] },
    { kind: 'group', groupOpenid: 'GRP_M2', refMsgIdx: 'REFIDX_BOT' },
  );
  await mw(h2.ctx as never, (async () => h2.setNext(true)) as never);
  assert.equal(h2.sent.length, 1, '引用 bot 出站消息同样算点名');
});

await test('冷却生效：同一发送者连发多条 → 只回一条', async () => {
  _resetAccessNotice();
  const policy = { c2cMode: 'allowlist', allowFrom: [ALLOWED] };
  let total = 0;
  for (let i = 0; i < 4; i++) {
    const h = makeCtx(policy, { senderId: 'SPAMMER', msgId: `m-${i}` });
    await mw(h.ctx as never, (async () => h.setNext(true)) as never);
    total += h.sent.length;
  }
  assert.equal(total, 1, '冷却窗口内不应重复回告');
});

await test('发送失败 → 回滚预留，下一条仍能收到提示', async () => {
  _resetAccessNotice();
  const policy = { c2cMode: 'allowlist', allowFrom: [ALLOWED] };
  const fail = makeCtx(policy, { senderId: 'UNLUCKY' }, { failSend: true });
  await mw(fail.ctx as never, (async () => fail.setNext(true)) as never);
  assert.equal(fail.getStop(), 'access:not_allowlisted', '发送失败也必须照常拦截');
  assert.ok(fail.logs.some((l) => l.startsWith('WARN')), '发送失败要留 WARN 痕迹');

  const ok = makeCtx(policy, { senderId: 'UNLUCKY' });
  await mw(ok.ctx as never, (async () => ok.setNext(true)) as never);
  assert.equal(ok.sent.length, 1, '上一次失败不得让该用户在冷却窗口内彻底静默');
});

await test('发送挂住 → 超时后仍走到 ctx.stop（不悬住被拒消息）', async () => {
  _resetAccessNotice();
  const mwFast = dynamicAccessControl({
    accountId: ACCT,
    getRuntime: () => ({}),
    noticeTimeoutMs: 50,
  });
  const h = makeCtx(
    { c2cMode: 'allowlist', allowFrom: [ALLOWED] },
    { senderId: 'STALL_USER' },
    { hangSend: true },
  );
  await mwFast(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.getStop(), 'access:not_allowlisted', '发送挂死也必须完成拦截');
  assert.ok(
    h.logs.some((l) => l.includes('timeout, cooldown kept')),
    '超时应留痕并说明冷却未回滚',
  );
});

await test('发送超时（结果不明）→ 保留冷却，下一条不再重复发', async () => {
  _resetAccessNotice();
  const mwFast = dynamicAccessControl({
    accountId: ACCT,
    getRuntime: () => ({}),
    noticeTimeoutMs: 50,
  });
  const policy = { c2cMode: 'allowlist', allowFrom: [ALLOWED] };
  const hang = makeCtx(policy, { senderId: 'DUP_USER' }, { hangSend: true });
  await mwFast(hang.ctx as never, (async () => hang.setNext(true)) as never);

  const next = makeCtx(policy, { senderId: 'DUP_USER' });
  await mwFast(next.ctx as never, (async () => next.setNext(true)) as never);
  assert.equal(next.sent.length, 0, '超时后平台可能已投递，不应立刻再发一条');
  assert.equal(next.getStop(), 'access:not_allowlisted');
});

await test('发送确定性失败 → 回滚预留（与超时相反）', async () => {
  _resetAccessNotice();
  const policy = { c2cMode: 'allowlist', allowFrom: [ALLOWED] };
  const fail = makeCtx(policy, { senderId: 'RETRY_USER' }, { failSend: true });
  await mw(fail.ctx as never, (async () => fail.setNext(true)) as never);
  const next = makeCtx(policy, { senderId: 'RETRY_USER' });
  await mw(next.ctx as never, (async () => next.setNext(true)) as never);
  assert.equal(next.sent.length, 1, '确定性失败必须让用户还能收到下一条提示');
});

await test('迟到失败不得抹掉更新的预留（release 校验 token）', () => {
  _resetAccessNotice();
  const t0 = 7_000_000;
  // 第一次发送挂起，10 分钟后同一实体的第二封消息重新预留并成功发出
  const hanging = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'STALE', now: t0 });
  assert.equal(hanging.allowed, true);
  const newer = reserveAccessNotice({
    accountId: ACCT,
    scope: 'c2c',
    id: 'STALE',
    now: t0 + ACCESS_NOTICE_COOLDOWN_MS,
  });
  assert.equal(newer.allowed, true);

  // 挂起的那条此刻才失败：无条件 delete key 会把新冷却一并抹掉
  hanging.release();

  const afterStaleFailure = reserveAccessNotice({
    accountId: ACCT,
    scope: 'c2c',
    id: 'STALE',
    now: t0 + ACCESS_NOTICE_COOLDOWN_MS + 1,
  });
  assert.equal(
    afterStaleFailure.allowed,
    false,
    '新预留的冷却必须仍在——否则用户会紧接着再收一条重复诊断',
  );
});

await test('容量压力下不淘汰未过期的冷却（条目宁可临时超出上限）', () => {
  _resetAccessNotice();
  const t0 = 8_000_000;
  for (let i = 0; i < 2100; i++) {
    reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: `cap-${i}`, now: t0 });
  }
  const first = reserveAccessNotice({ accountId: ACCT, scope: 'c2c', id: 'cap-0', now: t0 + 1000 });
  assert.equal(first.allowed, false, '最早的条目冷却未过，不该被容量控制淘汰');
  assert.equal(first.allowed ? '' : first.reason, 'cooldown');
});

await test('提示走被动锚点（SDK 从 ctx.replyTarget.msgId 取当前入站消息）', async () => {
  _resetAccessNotice();
  const h = makeCtx({ c2cMode: 'allowlist', allowFrom: [ALLOWED] }, { senderId: 'ANCHOR_USER', msgId: 'mm-1' });
  await mw(h.ctx as never, (async () => h.setNext(true)) as never);
  assert.equal(h.sent.length, 1);
  const target = h.sent[0].target as { targetId?: string; msgId?: string };
  assert.equal(target.targetId, 'ANCHOR_USER');
  assert.equal(target.msgId, 'mm-1', 'msgId 必须透传给 SDK 走被动回复，不吃每日主动预算');
});

// ============ 收尾 ============

// ref-index 的 set() 会把磁盘追加挂到异步写链上；直接删临时 HOME 会让那次
// append 落在删除之后、打出 ENOENT 噪音（断言早已走内存读通过，但日志会误导
// 排障）。先 flush 再等写链排空，最后清理。
flushAllRefIndexStores();
await new Promise((r) => setTimeout(r, 100));

if (realHome === undefined) delete process.env.HOME;
else process.env.HOME = realHome;
rmSync(fakeHome, { recursive: true, force: true });

console.log(`\n通过 ${passed} / 失败 ${failed}`);
if (failed > 0) process.exit(1);
