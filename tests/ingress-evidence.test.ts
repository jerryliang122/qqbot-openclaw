/**
 * channelIngress admission evidence 单元测试 — issue #116（含评审补强）
 *
 * 锁定的契约：
 * 1. adapter probe：`runtime.channel.inbound.ingress.resolve` → adapters 字段
 *    （哨兵调用验证绑定的是正确函数；缺失时 null，调用方降级）。
 * 2. 策略映射 mapIngressPolicy：插件准入语义（access-control 同源）→ ingress
 *    resolve 入参；空/通配名单折叠为 open；**群侧恒 open 且永不传
 *    groupAllowFrom**（插件群白名单是群 id 语义，core 是群 sender 语义——
 *    语义错向直传会让每个 sender 判 not-allowlisted）；c2c disabled 降级。
 * 3. resolveIngressEvidence：
 *    - 单参与者：resolve 入参逐字段（binding 四元组 / conversation / subject /
 *      event / policy / identity 形状）；
 *    - 多参与者（跨发言人合批）：到达序去重、载体末位、逐参与者独立新鲜
 *      resolve、共享同一 binding；非载体失败仅丢弃该项、载体失败整体降级；
 *      1 人返回单对象、≥2 人返回数组；
 *    - 降级：resolve 抛错 / 非 dispatch 决策 / 超时（注入 timeoutMs）/
 *      probe 缺失 / participants 为空，全部返回 undefined 且不抛。
 * 4. buildIngressParticipants（group-merge）：去重 / 载体末位 / 载体重复折叠。
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
const { buildIngressParticipants } = await import('../src/features/group-merge.ts');

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

/** dispatch-allowed 的 resolve 桩，捕获入参（每参与者返回带标记的新鲜对象） */
function makeAdmittedResolve(captured: any[] = []) {
  return async (params: any) => {
    captured.push(params);
    return {
      ingress: { admission: 'dispatch', reasonCode: 'dm_policy_allowlisted' },
      senderAccess: { allowed: true, reasonCode: 'dm_policy_allowlisted' },
      // 参与者标记：断言输出数组的成员与顺序（防换序/替换回归）
      stableId: params.subject.stableId,
      n: captured.length,
    };
  };
}

function makeEvidenceParams(overrides: Record<string, unknown> = {}) {
  return {
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve())),
    route: { sessionKey: 'agent:main:qqbot:direct:USER_OPENID_1' },
    accountId: 'acc-1',
    messageId: 'MSG_1',
    isGroup: false,
    peerId: 'USER_OPENID_1',
    inboundEventKind: 'user_request',
    participants: ['USER_OPENID_1'],
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

await test('哨兵调用：probe 绑定的确是 runtime 的 ingress.resolve（评审 #5）', async () => {
  _resetAdaptersCache();
  const received: any[] = [];
  const sentinelResult = { ingress: { admission: 'dispatch' } };
  const adapters = getAdapters(makeIngressRuntime(async (p) => {
    received.push(p);
    return sentinelResult;
  }));
  assert.equal(typeof adapters.resolveChannelMessageIngress, 'function');
  const sentinel = { __sentinel: true };
  const out = await adapters.resolveChannelMessageIngress(sentinel);
  assert.equal(received.length, 1, 'runtime 侧 resolve 应被调用一次');
  assert.strictEqual(received[0], sentinel, 'probe 必须把入参原样送到 runtime ingress.resolve');
  assert.strictEqual(out, sentinelResult, '结果必须原样透传');
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

await test('群侧恒 open：任意 groupMode/groupAllowFrom 都不映射成 allowlist/entries（语义错向防护）', () => {
  // groupMode=allowlist + 群 id 名单：插件语义是「哪些群被服务」（群 id 白名单），
  // core 的 groupAllowFrom 却是「群内哪些 sender 被允许」——直传必错向
  const mapped = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: ['GROUP_1', 'GROUP_2'] });
  assert.equal(mapped!.groupPolicy, 'open');
  assert.equal((mapped as any).groupAllowFrom, undefined, '永不传 groupAllowFrom 给 core');

  const openMode = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'open', allowFrom: [], groupAllowFrom: [] });
  assert.equal(openMode!.groupPolicy, 'open');

  // 群 disabled 也不再整体降级：disabled 群到不了 dispatch（access-control 已拦），
  // evidence 只需 sender 级如实（无 sender 级限制 ⇒ open）
  const disabledMode = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', groupMode: 'disabled', allowFrom: [], groupAllowFrom: [] });
  assert.equal(disabledMode!.groupPolicy, 'open');
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

group('resolveIngressEvidence: 单参与者入参与降级');

await test('c2c：binding 四元组 / subject / conversation / policy / identity 形状逐字段正确（评审 #6）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
  }));
  assert.ok(result, 'admitted resolve 应返回结果');
  assert.ok(!Array.isArray(result), '单参与者返回单对象（非数组）');
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
  // identity 形状（防 null/畸形值骗过断言）：stable identity 描述符把字段
  // 包在 primary 下（defineStableChannelIngressIdentity 的返回形态）
  assert.equal(p.identity?.primary?.key, 'qqbot-openid');
  assert.equal(p.identity?.primary?.authentication, 'verified');
  assert.equal(p.identity?.primary?.sensitivity, 'pii');
  assert.equal(p.identity?.primary?.normalize?.(' x '), 'x');
  assert.equal(p.identity?.primary?.normalize?.(''), null);
});

await test('route.agentId 缺失 → binding.agentId 归一为 default（对齐 ctx-builder）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    route: { sessionKey: 'k' },
  }));
  assert.equal(captured[0].contextBinding.agentId, 'default');
});

await test('群 room_event turn：conversation 取群 id，binding.inboundEventKind=room_event，mayPair=false，groupPolicy 恒 open', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    route: { agentId: 'main', sessionKey: 'agent:main:qqbot:group:GROUP_1' },
    messageId: 'MSG_G1',
    accountId: 'acc-1',
    isGroup: true,
    peerId: 'GROUP_1',
    inboundEventKind: 'room_event',
    participants: ['SENDER_1'],
    policy: { isGroup: true, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: ['GROUP_1'] },
  }));
  const p = captured[0];
  assert.deepEqual(p.conversation, { kind: 'group', id: 'GROUP_1' });
  assert.deepEqual(p.event, { kind: 'message', authMode: 'inbound', mayPair: false });
  assert.equal(p.contextBinding.inboundEventKind, 'room_event');
  assert.equal(p.policy.groupPolicy, 'open');
  assert.equal((p as any).groupAllowFrom, undefined, '群 id 名单不得传给 core（语义错向）');
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

await test('超时（注入 timeoutMs + 永不 settle 的 resolve）→ undefined 且不抛（评审 #2）', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(() => new Promise(() => {}))),
    timeoutMs: 20,
  }));
  assert.equal(result, undefined);
});

await test('probe 缺失（adapters.resolveChannelMessageIngress=null）→ undefined', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime()),
  }));
  assert.equal(result, undefined);
});

await test('策略映射降级（c2c disabled）→ 不调 resolver', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    policy: { isGroup: false, c2cMode: 'disabled', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] },
  }));
  assert.equal(result, undefined);
  assert.equal(captured.length, 0);
});

await test('participants 为空 → undefined，不调 resolver', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    participants: [],
  }));
  assert.equal(result, undefined);
  assert.equal(captured.length, 0);
});

// ── 5. 多参与者（跨发言人合批，评审 #3）──

group('resolveIngressEvidence: 多参与者证据');

function makeGroupEvidenceParams(overrides: Record<string, unknown> = {}) {
  return makeEvidenceParams({
    route: { agentId: 'main', sessionKey: 'agent:main:qqbot:group:GROUP_1' },
    messageId: 'MSG_CARRIER',
    accountId: 'acc-1',
    isGroup: true,
    peerId: 'GROUP_1',
    inboundEventKind: 'user_request',
    policy: { isGroup: true, c2cMode: 'allowlist', groupMode: 'allowlist', allowFrom: [], groupAllowFrom: [] },
    ...overrides,
  });
}

await test('按到达序逐参与者 resolve，载体末位；返回数组且各项新鲜、binding 共享', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    participants: ['SENDER_A', 'SENDER_B', 'SENDER_CARRIER'],
  }));
  assert.ok(Array.isArray(result), '多参与者返回数组');
  assert.equal(result.length, 3);
  assert.equal(captured.length, 3, '每个参与者独立 resolve');
  assert.deepEqual(captured.map((p) => p.subject.stableId), ['SENDER_A', 'SENDER_B', 'SENDER_CARRIER'], '载体在末位');
  // 输出数组与参与者一一对应、顺序一致（防换序/替换回归）
  assert.deepEqual(
    (result as any[]).map((r) => r.stableId),
    ['SENDER_A', 'SENDER_B', 'SENDER_CARRIER'],
  );
  // 各项是不同对象（新鲜 resolve，无复用）
  assert.notStrictEqual(result[0], result[1]);
  assert.notStrictEqual(result[1], result[2]);
  // 所有参与者共享同一 contextBinding（同 turn）
  const binding = captured[0].contextBinding;
  for (const p of captured) assert.deepEqual(p.contextBinding, binding);
  assert.equal(binding.messageId, 'MSG_CARRIER');
  assert.equal(binding.agentId, 'main');
});

await test('非载体参与者失败 → 仅丢弃该项，输出成员与顺序如实（不含失败者）', async () => {
  _resetAdaptersCache();
  let call = 0;
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async (p: any) => {
      call++;
      if (call === 1) return { ingress: { admission: 'drop', reasonCode: 'x' } }; // SENDER_A 失败
      return { ingress: { admission: 'dispatch' }, senderAccess: { allowed: true }, stableId: p.subject.stableId };
    })),
    participants: ['SENDER_A', 'SENDER_B', 'SENDER_CARRIER'],
  }));
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2, '失败的非载体被丢弃');
  assert.equal(call, 3, '全部参与者都被尝试');
  assert.deepEqual(
    (result as any[]).map((r) => r.stableId),
    ['SENDER_B', 'SENDER_CARRIER'],
    '输出恰好是获准参与者、顺序不变、载体末位',
  );
});

await test('载体（末位）失败 → 整体降级返回 undefined', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => ({
      ingress: { admission: 'drop', reasonCode: 'x' },
    }))),
    participants: ['SENDER_A', 'SENDER_CARRIER'],
  }));
  assert.equal(result, undefined, '末项必须匹配 buildContext sender.id，缺它不如不带');
});

await test('全部失败（单参与者=载体）→ undefined', async () => {
  _resetAdaptersCache();
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => { throw new Error('down'); })),
    participants: ['SENDER_CARRIER'],
  }));
  assert.equal(result, undefined);
});

// ── 6. buildIngressParticipants（合批写入侧）──

group('buildIngressParticipants: 去重与载体末位');

await test('到达序去重，载体 sender 强制排最后', () => {
  assert.deepEqual(
    buildIngressParticipants(['A', 'B', 'A', 'C'], 'C'),
    ['A', 'B', 'C'],
  );
});

await test('载体 sender 已在批内出现 → 只保留末位一项（不重复）', () => {
  assert.deepEqual(
    buildIngressParticipants(['A', 'B', 'A'], 'A'),
    ['B', 'A'],
  );
});

await test('单成员批 → 仅载体自身', () => {
  assert.deepEqual(buildIngressParticipants(['A'], 'A'), ['A']);
});

await test('脏数据防御：空串/非字符串被过滤；carrierSenderId 缺失时保留去重全量', () => {
  assert.deepEqual(
    buildIngressParticipants(['A', '', 'B'], 'B'),
    ['A', 'B'],
  );
  assert.deepEqual(
    buildIngressParticipants(['A', 'B', 'A'], undefined),
    ['A', 'B'],
  );
});

// ── 7. 上限 / 并发截止时间 / 日志脱敏 ──

group('评审补强：core 上限 / 共享截止时间 / 错误脱敏');

await test('参与者超过 core 上限 16 → 只 resolve/保留最新 16 个，载体仍在末位', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const many = Array.from({ length: 18 }, (_, i) => `SENDER_${String(i).padStart(2, '0')}`);
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeAdmittedResolve(captured))),
    participants: many,
  }));
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 16, '输出恰好 16 项（core CHANNEL_ADMISSION_EVIDENCE_MAX_CONTRIBUTIONS）');
  assert.equal(captured.length, 16, '被舍弃的最早参与者不再触发 resolve');
  const kept = many.slice(-16);
  assert.deepEqual((result as any[]).map((r) => r.stableId), kept);
  assert.equal(kept[kept.length - 1], 'SENDER_17', '载体（原末位）保持末位');
});

await test('共享截止时间：N 个停滞参与者的总耗时 ≈ 一个 timeout（非 N×timeout）', async () => {
  _resetAdaptersCache();
  const participants = Array.from({ length: 6 }, (_, i) => `SENDER_${i}`);
  const timeoutMs = 150;
  const startedAt = Date.now();
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(() => new Promise(() => {}))),
    participants,
    timeoutMs,
  }));
  const elapsed = Date.now() - startedAt;
  assert.equal(result, undefined, '全部超时（含载体）→ 整体降级');
  // 串行实现最坏 6×150=900ms；共享截止时间实现 ≈150ms。阈值取 500ms，
  // 两侧都不重叠、CI 抖动安全
  assert.ok(elapsed < 500, `共享截止时间内完成（elapsed=${elapsed}ms < 500ms，串行最坏 900ms）`);
});

await test('resolve 抛错 → WARN 不落完整 openid/sessionKey（脱敏红线）', async () => {
  _resetAdaptersCache();
  const { shortId } = await import('../src/utils/redaction.ts');
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m) } as any;
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => {
      throw new Error('resolver blew up for OPENID_LEAK_TEST in session agent:main:qqbot:direct:OPENID_LEAK_TEST');
    })),
    route: { sessionKey: 'agent:main:qqbot:direct:OPENID_LEAK_TEST' },
    participants: ['OPENID_LEAK_TEST'],
    log,
  }));
  assert.equal(result, undefined);
  // 单参与者=载体：失败 WARN + 载体降级 WARN 各一条，都不得含完整标识符
  assert.equal(warnings.length, 2);
  for (const line of warnings) {
    assert.ok(!line.includes('OPENID_LEAK_TEST'), `日志不得含完整 openid / sessionKey 原文：${line}`);
  }
  assert.ok(warnings[0]!.includes(shortId('OPENID_LEAK_TEST')), 'openid 以 shortId 形式呈现');
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed${failedTests.length ? `: ${failedTests.join(', ')}` : ''}`);
if (failed > 0) process.exit(1);
