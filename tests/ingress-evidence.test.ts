/**
 * channelIngress admission evidence 单元测试 — issue #116（含两轮评审补强）
 *
 * 锁定的契约：
 * 1. adapter probe：`runtime.channel.inbound.ingress.resolve` → adapters 字段
 *    （哨兵调用验证绑定的是正确函数；缺失时 null，调用方降级）。
 * 2. 策略映射 mapIngressPolicy——**对齐 core senderGateForDirect 的真实判定**：
 *    - dm `open` 不是「放行所有人」：core 仍要求 allowFrom 带通配符或命中 ⇒
 *      「空名单/含 `*`」折叠到 open 时**必须随行 `allowFrom: ['*']`**（二轮
 *      评审：否则默认配置 c2c 被判 dm_policy_not_allowlisted、静默丢 custody）；
 *    - `pairing` **永不折叠**：core 的 mergeDmAllowFromSources 在 open/allowlist
 *      下丢弃 pairing store，折叠会让「空静态名单的配对模式」丢 store 命中；
 *    - 群侧恒 open（core 群 open = 无条件放行）且永不传 groupAllowFrom
 *      （插件群白名单是群 id 语义，core 是群 sender 语义——语义错向）。
 * 3. resolveIngressEvidence：
 *    - 单参与者：resolve 入参逐字段（binding 四元组 / conversation / subject /
 *      event / policy / identity 形状 / **通配名单随行**）；
 *    - 多参与者（跨发言人合批）：到达序去重、载体末位、逐参与者独立新鲜
 *      resolve、共享同一 binding；非载体失败仅丢弃该项、载体失败整体降级；
 *      1 人返回单对象、≥2 人返回数组；
 *    - 降级：resolve 抛错 / 非 dispatch 决策 / 超时（注入 timeoutMs）/
 *      probe 缺失 / participants 为空 / resolver 空返回（与超时分日志），全部
 *      返回 undefined 且不抛；
 *    - 16 上限裁剪；共享截止时间；错误脱敏（不落完整 openid/sessionKey）。
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

/**
 * 按 core 真实语义判定的 resolve 桩（二轮评审：无条件 admitted 的桩测不出
 * 策略映射错误）。对齐 dist/runtime 的 senderGateForDirect / senderGateForGroup：
 * - dm open：hasWildcard（名单含 '*'）或 matched ⇒ allow，否则 not_allowlisted
 * - dm allowlist：matched ⇒ allow，否则 not_allowlisted
 * - dm pairing：静态名单或（桩内不可得的）store 命中 ⇒ allow
 * - 群 open：无条件 allow（group_policy_open）
 * 桩读不到 pairing store——需要 pairing 命中的测试把 sender 放进静态名单。
 */
function makeCoreLikeResolve(captured: any[] = []) {
  return async (p: any) => {
    captured.push(p);
    const allowFrom: string[] = Array.isArray(p.allowFrom) ? p.allowFrom : [];
    let allowed: boolean;
    let reasonCode: string;
    if (p.conversation.kind === 'group') {
      allowed = p.policy.groupPolicy === 'open';
      reasonCode = allowed ? 'group_policy_open' : 'group_policy_not_allowlisted';
    } else if (p.policy.dmPolicy === 'open') {
      allowed = allowFrom.includes('*') || allowFrom.includes(p.subject.stableId);
      reasonCode = allowed ? (allowFrom.includes('*') ? 'dm_policy_open' : 'dm_policy_allowlisted') : 'dm_policy_not_allowlisted';
    } else if (p.policy.dmPolicy === 'pairing') {
      allowed = allowFrom.includes(p.subject.stableId); // store 命中桩内不可得
      reasonCode = allowed ? 'dm_policy_allowlisted' : 'dm_pairing_required';
    } else {
      allowed = allowFrom.includes(p.subject.stableId);
      reasonCode = allowed ? 'dm_policy_allowlisted' : 'dm_policy_not_allowlisted';
    }
    return {
      ingress: { admission: allowed ? 'dispatch' : 'drop', reasonCode },
      senderAccess: { allowed, reasonCode },
      // 参与者标记：断言输出数组的成员与顺序（防换序/替换回归）
      stableId: p.subject.stableId,
      n: captured.length,
    };
  };
}

function makeEvidenceParams(overrides: Record<string, unknown> = {}) {
  return {
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve())),
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
      allowFrom: ['USER_OPENID_1'],
    },
    ...overrides,
  } as any;
}

// ── 1. adapter probe ──

group('adapter probe: channel.inbound.ingress.resolve');

await test('哨兵调用：probe 绑定的确是 runtime 的 ingress.resolve（一轮评审 #5）', async () => {
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

group('mapIngressPolicy: 准入语义 → resolve 策略（对齐 core senderGateForDirect）');

await test('c2c open → dmPolicy open 且必须随行 allowFrom:["*"]（core dm open 仍要求通配/命中）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'open', allowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'open');
  assert.deepEqual(mapped!.allowFrom, ['*'], 'core dm open 无通配 ⇒ dm_policy_not_allowlisted');
});

await test('c2c allowlist + 非空名单 → allowlist + entries', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', allowFrom: ['A', 'B', ' '] });
  assert.equal(mapped!.dmPolicy, 'allowlist');
  assert.deepEqual(mapped!.allowFrom, ['A', 'B']);
});

await test('c2c allowlist + 空名单 → open + ["*"]（默认配置不得静默丢 custody）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', allowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'open');
  assert.deepEqual(mapped!.allowFrom, ['*'], '折叠 open 必须让 core hasWildcard 成立');
});

await test("c2c allowlist + 含 '*' → open + [\"*\"]", () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'allowlist', allowFrom: ['*'] });
  assert.equal(mapped!.dmPolicy, 'open');
  assert.deepEqual(mapped!.allowFrom, ['*']);
});

await test('c2c pairing + 静态名单 → pairing + entries（store 命中由 core 评估）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'pairing', allowFrom: ['A'] });
  assert.equal(mapped!.dmPolicy, 'pairing');
  assert.deepEqual(mapped!.allowFrom, ['A']);
});

await test('c2c pairing + 空名单 → 恒 pairing 不折叠（core 在 open/allowlist 下丢 pairing store）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'pairing', allowFrom: [] });
  assert.equal(mapped!.dmPolicy, 'pairing', '折叠 open 会丢掉 store 命中（mergeDmAllowFromSources）');
  assert.equal(mapped!.allowFrom, undefined);
});

await test('c2c disabled → undefined（降级，不携带 evidence）', () => {
  const mapped = mapIngressPolicy({ isGroup: false, c2cMode: 'disabled', allowFrom: [] });
  assert.equal(mapped, undefined);
});

await test('群侧恒 open：groupPolicy 恒 open（core 群 open=无条件放行），永不传 groupAllowFrom', () => {
  const mapped = mapIngressPolicy({ isGroup: true, c2cMode: 'allowlist', allowFrom: [] });
  assert.equal(mapped!.groupPolicy, 'open');
  assert.equal((mapped as any).groupAllowFrom, undefined, '永不传 groupAllowFrom（语义错向）');
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
  assert.deepEqual(defaults.allowFrom, []);
});

// ── 4. resolveIngressEvidence 契约 ──

group('resolveIngressEvidence: 单参与者入参与降级');

await test('c2c：binding 四元组 / subject / conversation / policy / identity 形状逐字段正确（评审 #6）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
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

await test('默认配置（allowlist+空名单）端到端：折叠 open 且 allowFrom:["*"] 随行 → core 语义下 admitted', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
    policy: { isGroup: false, c2cMode: 'allowlist', allowFrom: [] },
  }));
  assert.ok(result, '空名单不得静默丢 custody（二轮评审高危项）');
  assert.equal(captured[0].policy.dmPolicy, 'open');
  assert.deepEqual(captured[0].allowFrom, ['*'], '通配符必须随行');
});

await test('pairing + 空名单端到端：dmPolicy=pairing 直传（store 由 core 评估，不折叠）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  // pairing 且 sender 不在静态名单 → 桩按 core 语义判 pairing_required → 降级
  const dropped = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
    policy: { isGroup: false, c2cMode: 'pairing', allowFrom: [] },
  }));
  assert.equal(dropped, undefined, '未配对用户到不了 dispatch，evidence 如实降级');
  assert.equal(captured[0].policy.dmPolicy, 'pairing', '不折叠为 open');
  // 配对用户（静态名单兜底命中）→ admitted
  const captured2: any[] = [];
  const admitted = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured2))),
    policy: { isGroup: false, c2cMode: 'pairing', allowFrom: ['USER_OPENID_1'] },
  }));
  assert.ok(admitted, '静态名单命中的配对用户拿到 evidence');
  assert.equal(captured2[0].policy.dmPolicy, 'pairing');
});

await test('route.agentId 缺失 → binding.agentId 归一为 default（对齐 ctx-builder）', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
    route: { sessionKey: 'k' },
  }));
  assert.equal(captured[0].contextBinding.agentId, 'default');
});

await test('群 room_event turn：conversation 取群 id，binding.inboundEventKind=room_event，mayPair=false，groupPolicy 恒 open', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
    route: { agentId: 'main', sessionKey: 'agent:main:qqbot:group:GROUP_1' },
    messageId: 'MSG_G1',
    accountId: 'acc-1',
    isGroup: true,
    peerId: 'GROUP_1',
    inboundEventKind: 'room_event',
    participants: ['SENDER_1'],
    policy: { isGroup: true, c2cMode: 'allowlist', allowFrom: [] },
  }));
  const p = captured[0];
  assert.deepEqual(p.conversation, { kind: 'group', id: 'GROUP_1' });
  assert.deepEqual(p.event, { kind: 'message', authMode: 'inbound', mayPair: false });
  assert.equal(p.contextBinding.inboundEventKind, 'room_event');
  assert.equal(p.policy.groupPolicy, 'open');
  assert.equal((p as any).groupAllowFrom, undefined, '群 id 名单不得传给 core（语义错向）');
});

await test('策略映射错误会被 core 语义桩当场证伪：折叠 open 不带通配 → not admitted', async () => {
  _resetAdaptersCache();
  // 模拟「策略映射漏带 allowFrom:["*"]」的回归：构造直传空 allowFrom 的入参
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async (p: any) => {
      const allowed = p.policy.dmPolicy !== 'open' || (p.allowFrom ?? []).includes('*') || (p.allowFrom ?? []).includes(p.subject.stableId);
      return { ingress: { admission: allowed ? 'dispatch' : 'drop', reasonCode: 'dm_policy_not_allowlisted' }, senderAccess: { allowed } };
    })),
    policy: { isGroup: false, c2cMode: 'allowlist', allowFrom: [] },
  }));
  assert.ok(result, '当前映射带 ["*"]，core 语义下 admitted');
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

await test('resolver 合法返回 undefined → 降级且日志语义是「空返回」而非「超时」（二轮评审）', async () => {
  _resetAdaptersCache();
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m) } as any;
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => undefined)),
    log,
  }));
  assert.equal(result, undefined);
  assert.ok(warnings.some((m) => m.includes('resolver returned empty')), '空返回与超时须分日志语义');
  assert.ok(!warnings.some((m) => m.includes('resolve timeout')), '不得把空返回误记为超时');
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
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
    policy: { isGroup: false, c2cMode: 'disabled', allowFrom: [] },
  }));
  assert.equal(result, undefined);
  assert.equal(captured.length, 0);
});

await test('participants 为空 → undefined，不调 resolver', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
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
    policy: { isGroup: true, c2cMode: 'allowlist', allowFrom: [] },
    ...overrides,
  });
}

await test('按到达序逐参与者 resolve，载体末位；返回数组且各项新鲜、binding 共享', async () => {
  _resetAdaptersCache();
  const captured: any[] = [];
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
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
    adapters: getAdapters(makeIngressRuntime(makeCoreLikeResolve(captured))),
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

await test('resolve 抛错 → WARN 不落完整 openid/sessionKey/群 openid（脱敏红线，二轮评审扩大覆盖）', async () => {
  _resetAdaptersCache();
  const { shortId } = await import('../src/utils/redaction.ts');
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, warn: (m: string) => warnings.push(m) } as any;
  const result = await resolveIngressEvidence(makeGroupEvidenceParams({
    adapters: getAdapters(makeIngressRuntime(async () => {
      throw new Error('resolver blew up for OPENID_LEAK_TEST / peer GROUP_LEAK / session agent:main:qqbot:group:GROUP_LEAK');
    })),
    route: { agentId: 'main', sessionKey: 'agent:main:qqbot:group:GROUP_LEAK' },
    peerId: 'GROUP_LEAK',
    participants: ['OPENID_LEAK_TEST'],
    log,
  }));
  assert.equal(result, undefined);
  // 单参与者=载体：失败 WARN + 载体降级 WARN 各一条，都不得含完整标识符
  assert.equal(warnings.length, 2);
  for (const line of warnings) {
    assert.ok(!line.includes('OPENID_LEAK_TEST'), `不得含完整 openid：${line}`);
    assert.ok(!line.includes('GROUP_LEAK'), `不得含完整群 openid（含 sessionKey 片段内的）：${line}`);
  }
  assert.ok(warnings[0]!.includes(shortId('OPENID_LEAK_TEST')), 'openid 以 shortId 形式呈现');
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed${failedTests.length ? `: ${failedTests.join(', ')}` : ''}`);
if (failed > 0) process.exit(1);
