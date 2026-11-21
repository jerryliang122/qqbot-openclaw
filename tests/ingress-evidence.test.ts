/**
 * channelIngress admission evidence 单元测试 — issue #116
 *
 * 锁定三块契约：
 * 1. adapter probe：`runtime.channel.inbound.ingress.resolve` → adapters 字段
 *    （缺失时 null，调用方降级）。
 * 2. 策略映射 mapIngressPolicy：插件准入语义（access-control 同源）→ ingress
 *    resolve 入参；空/通配名单折叠为 open；disabled 降级。
 * 3. resolveIngressEvidence：resolve 入参逐字段（binding 四元组 / conversation /
 *    subject / event / policy），失败与未 allow 时降级返回 undefined 且不抛。
 *
 * 运行方式: npx tsx tests/ingress-evidence.test.ts
 */
import assert from 'node:assert/strict';

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

// ── 真实模块 ──

const { getAdapters, _resetAdaptersCache } = await import('../src/adapter/resolve.ts');
const {
  mapIngressPolicy,
  resolveAccessPolicyInput,
  resolveIngressEvidence,
} = await import('../src/dispatch/ingress-evidence.ts');

// ── 基础桩 ──

function makeIngressRuntime(resolve?: (params: any) => Promise<any>) {
  return {
    version: 'test',
    channel: {
      inbound: {
        buildContext: (params: any) => ({ ...params }),
        ...(resolve ? { ingress: { resolve } } : {}),
      },
    },
  } as any;
}

/** dispatch-allowed 的 resolve 桩，捕获入参 */
function makeAdmittedResolve(captured: any[] = []) {
  return async (params: any) => {
    captured.push(params);
    return {
      ingress: { admission: 'dispatch', reasonCode: 'dm_policy_allowlisted' },
      senderAccess: { allowed: true, reasonCode: 'dm_policy_allowlisted' },
    };
  };
}

function makeEvidenceParams(overrides: Record<string, unknown> = {}) {
  return {
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve())),
    envelope: { chatScope: 'direct', senderId: 'USER_OPENID_1', messageId: 'MSG_1' },
    route: { sessionKey: 'agent:main:qqbot:direct:USER_OPENID_1', accountId: 'acc-1' },
    fallbackAccountId: 'acc-fallback',
    isGroup: false,
    peerId: 'USER_OPENID_1',
    inboundEventKind: 'user_request',
    policy: {
      isGroup: false,
      c2cMode: 'allowlist',
      groupMode: 'allowlist',
      allowFrom: ['USER_OPENID_1'],
      groupAllowFrom: [],
    },
    ...overrides,
  } as any;
}

// ── 1. adapter probe ──

group('adapter probe: channel.inbound.ingress.resolve');

await test('runtime 带 ingress.resolve → probe 命中并绑定', () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const adapters = getAdapters(makeIngressRuntime(makeAdmittedResolve(captured)));
  assert.equal(typeof adapters.resolveChannelMessageIngress, 'function');
});

await test('runtime 无 ingress 路径 → probe 为 null（调用方降级）', () => {
  _resetAdaptersCache();
  const adapters = getAdapters(makeIngressRuntime());
  assert.equal(adapters.resolveChannelMessageIngress, null);
});

// ── 2. 策略映射 ──

group('mapIngressPolicy: 准入语义 → resolve 策略');

await test('c2c open → dmPolicy open', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'open', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] });
  assert.deepEqual(mapped, { dmPolicy: 'open', groupPolicy: 'open' });
});

await test('c2c allowlist + 非空名单 → allowlist + entries', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: ['A', 'B', ' '], groupAllowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'allowlist');
  assert.deepEqual(mapped!.allowFrom, ['A', 'B']);
});

await test('c2c allowlist + 空名单 → open（access-control 放行所有人）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'open');
  assert.equal(mapped!.allowFrom, undefined);
});

await test("c2c allowlist + 含 '*' → open", () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: ['*'], groupAllowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'open');
});

await test('c2c pairing + 名单 → pairing + entries（store 命中由 resolver 评估）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'pairing', groupMode: 'allowlist', allowFrom: ['A'], groupAllowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'pairing');
  assert.deepEqual(mapped!.allowFrom, ['A']);
});

await test('c2c disabled → undefined（降级，不携带 evidence）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'disabled', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] });
  assert.equal(mapped, undefined);
});

await test('群 allowlist + 空名单 → groupPolicy open（默认群语义=放行所有群）', () => {
  const mapped = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] });
  assert.equal(mapped!.groupPolicy, 'open');
  assert.equal(mapped!.groupAllowFrom, undefined);
});

await test('群 allowlist + 名单 → allowlist + entries', () => {
  const mapped = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: ['GROUP_1', 'GROUP_2'] });
  assert.equal(mapped!.groupPolicy, 'allowlist');
  assert.deepEqual(mapped!.groupAllowFrom, ['GROUP_1', 'GROUP_2']);
});

await test('群 disabled → undefined（降级）', () => {
  const mapped = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'disabled', allowFrom: [], groupAllowFrom: [] });
  assert.equal(mapped, undefined);
});

// ── 3. resolveAccessPolicyInput ──

group('resolveAccessPolicyInput: 与 policy-injector 同源');

await test('优先读 ctx.state.policy；缺失时按同一默认链从 account.config 复算', () => {
  const fromState = resolveAccessPolicyInput(
    { state: { policy: { c2cMode: 'pairing', allowFrom: ['X'] } } } as any,
    { config: { dmPolicy: 'open' } } as any,
    false,
  );
  assert.equal(fromState.c2cMode, 'pairing');
  assert.deepEqual(fromState.allowFrom, ['X']);

  const fromConfig = resolveAccessPolicyInput({ state: {} } as any, { config: { dmPolicy: 'open', allowFrom: ['Y'] } } as any, false);
  assert.equal(fromConfig.c2cMode, 'open');
  assert.deepEqual(fromConfig.allowFrom, ['Y']);

  const defaults = resolveAccessPolicyInput({ state: {} } as any, { config: {} } as any, true);
  assert.equal(defaults.c2cMode, 'allowlist');
  assert.equal(defaults.groupMode, 'allowlist');
  assert.deepEqual(defaults.allowFrom, []);
});

// ── 4. resolveIngressEvidence 契约 ──

group('resolveIngressEvidence: resolve 入参与降级');

await test('c2c：binding 四元组 / subject / conversation / policy 逐字段正确', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
  }));
  assert.ok(result, 'admitted resolve 应返回结果');
  assert.equal(captured.length, 1);
  const p = captured[0];
  assert.equal(p.channelId, 'qqbot');
  assert.equal(p.accountId, 'acc-1');
  assert.equal(p.subject.stableId, 'USER_OPENID_1');
  assert.deepEqual(p.conversation, { kind: 'direct', id: 'USER_OPENID_1' });
  assert.deepEqual(p.event, { kind: 'message', authMode: 'inbound', mayPair: true });
  assert.deepEqual(
    p.contextBinding,
    { agentId: 'default', sessionKey: 'agent:main:qqbot:direct:USER_OPENID_1', messageId: 'MSG_1', inboundEventKind: 'user_request' },
  );
  assert.equal(p.policy.dmPolicy, 'allowlist');
  assert.deepEqual(p.allowFrom, ['USER_OPENID_1']);
  assert.equal('identity' in p, true);
});

await test('route.agentId 缺失 → binding.agentId 归一为 default（对齐 ctx-builder）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    route: { sessionKey: 'k', accountId: 'acc-1' },
  }));
  assert.equal(captured[0].contextBinding.agentId, 'default');
});

await test('route.accountId 缺失 → resolver 用 fallbackAccountId', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    route: { sessionKey: 'k' },
  }));
  assert.equal(captured[0].accountId, 'acc-fallback');
});

await test('群 room_event turn：conversation 取群 id，binding.inboundEventKind=room_event，mayPair=false', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    envelope: { chatScope: 'group', senderId: 'SENDER_1', messageId: 'MSG_G1' },
    route: { agentId: 'main', sessionKey: 'agent:main:qqbot:group:GROUP_1', accountId: 'acc-1' },
    isGroup: true,
    peerId: 'GROUP_1',
    inboundEventKind: 'room_event',
    policy: { isGroup: true, c2cMode: 'allowlist', groupMode: 'open', allowFrom: [], groupAllowFrom: [] },
  }));
  const p = captured[0];
  assert.deepEqual(p.conversation, { kind: 'group', id: 'GROUP_1' });
  assert.deepEqual(p.event, { kind: 'message', authMode: 'inbound', mayPair: false });
  assert.equal(p.contextBinding.inboundEventKind, 'room_event');
  assert.equal(p.policy.groupPolicy, 'open');
});

await test('每次调用都产生新 resolve（单次移交，无复用）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const adapters = getAdapters(makeIngressRuntime(makeAdmittedResolve(captured)));
  const a = await resolveIngressEvidence(makeEvidenceParams({ adapters }));
  const b = await resolveIngressEvidence(makeEvidenceParams({ adapters }));
  assert.equal(captured.length, 2);
  assert.notStrictEqual(a, b, '两次 resolve 必须是不同对象');
});

await test('resolve 抛错 → 返回 undefined 且不抛', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => { throw new Error('boom'); })),
  }));
  assert.equal(result, undefined);
});

await test("resolve 返回非 dispatch 决策 → 返回 undefined（evidence 无效即降级）", async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => ({
      ingress: { admission: 'drop', reasonCode: 'dm_policy_not_allowlisted' },
      senderAccess: { allowed: false },
    }))),
  }));
  assert.equal(result, undefined);
});

await test('probe 缺失（adapters.resolveChannelMessageIngress=null）→ undefined，不触碰 resolver', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime()),
  }));
  assert.equal(result, undefined);
});

await test('策略映射降级（disabled）→ 不调 resolver', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    policy: { isGroup: false, c2cMode: 'disabled', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] },
  }));
  assert.equal(result, undefined);
  assert.equal(captured.length, 0);
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed${failedTests.length ? `: ${failedTests.join(', ')}` : ''}`);
if (failed > 0) process.exit(1);
