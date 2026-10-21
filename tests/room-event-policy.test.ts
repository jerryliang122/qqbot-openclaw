/**
 * room_event 完整支持 —— 策略层回归测试
 *
 * 覆盖：
 * 1. 入站策略回落链：群级显式 > per-agent（entries / list 两形态）> 全局 > 默认
 * 2. 可见回复模式：room_event → message_tool；user_request → 配置驱动
 * 3. message 工具守卫：确定不可用时降级回 user_request（防"群里永久沉默"）
 * 4. 唤醒判定与入站分类（唯一口径）
 * 5. 端到端：全局配置开启 room_event / 工具不可用降级
 *
 * 运行方式: npx tsx tests/room-event-policy.test.ts
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

const {
  resolveUnmentionedInboundMode,
  resolveVisibleRepliesMode,
  resolveMessageToolAvailability,
  resolveRoomEventPolicy,
  resolveWakeDecision,
  classifyInboundEventKind,
} = await import('../src/features/room-event.ts');
const { resolveGroupConfigFromAccount, resolveGroupToolPolicyConfig } = await import('../src/config.ts');

function makeAccount(groups?: Record<string, any>, extra?: Record<string, any>): any {
  return {
    accountId: 'default',
    appId: 'x',
    config: { ...(groups ? { groups } : {}), ...(extra ?? {}) },
  };
}

// ── 1. 入站策略回落链 ──────────────────────────────────────────

group('入站策略回落链（群级 > per-agent > 全局 > 默认）');

await test('群级显式配置优先于 per-agent 与全局', () => {
  const cfg: any = {
    messages: { groupChat: { unmentionedInbound: 'room_event' } },
    agents: { entries: { main: { groupChat: { unmentionedInbound: 'user_request' } } } },
  };
  const r = resolveUnmentionedInboundMode({ cfg, agentId: 'main', groupMode: 'room_event' });
  assert.equal(r.mode, 'room_event');
  assert.equal(r.source, 'group');
});

await test('群级未显式配置 → 回落 per-agent（agents.entries 现行形态）', () => {
  const cfg: any = {
    messages: { groupChat: { unmentionedInbound: 'room_event' } },
    agents: { entries: { main: { groupChat: { unmentionedInbound: 'user_request' } } } },
  };
  const r = resolveUnmentionedInboundMode({ cfg, agentId: 'main' });
  assert.equal(r.mode, 'user_request');
  assert.equal(r.source, 'agent');
});

await test('per-agent 旧形态（agents.list 数组）同样生效', () => {
  const cfg: any = { agents: { list: [{ id: 'main', groupChat: { unmentionedInbound: 'room_event' } }] } };
  const r = resolveUnmentionedInboundMode({ cfg, agentId: 'main' });
  assert.equal(r.mode, 'room_event');
  assert.equal(r.source, 'agent');
});

await test('无 agent 覆盖 → 回落全局 messages.groupChat', () => {
  const cfg: any = { messages: { groupChat: { unmentionedInbound: 'room_event' } } };
  const r = resolveUnmentionedInboundMode({ cfg, agentId: 'main' });
  assert.equal(r.mode, 'room_event');
  assert.equal(r.source, 'global');
});

await test('全无配置 → 默认 user_request', () => {
  const r = resolveUnmentionedInboundMode({ cfg: {} as any, agentId: 'main' });
  assert.equal(r.mode, 'user_request');
  assert.equal(r.source, 'default');
});

await test('群级"未显式配置"与"显式配 user_request"可区分（回落链的前提）', () => {
  const account = makeAccount({ G1: { unmentionedInbound: 'user_request' }, G2: {} });
  const g1 = resolveGroupConfigFromAccount(account, 'G1');
  const g2 = resolveGroupConfigFromAccount(account, 'G2');
  assert.equal(g1.unmentionedInboundExplicit, 'user_request', '显式配 user_request 必须能被识别');
  assert.equal(g2.unmentionedInboundExplicit, undefined, '未配置时不能冒充显式值');
  assert.equal(g2.unmentionedInbound, 'user_request', '解析结果仍带默认值（兼容既有调用方）');
});

// ── 2. 可见回复模式 ────────────────────────────────────────────

group('可见回复模式');

await test('room_event → message_tool（严格投递）', () => {
  assert.equal(resolveVisibleRepliesMode({ cfg: {} as any, mode: 'room_event' }), 'message_tool');
});

await test('user_request + 未配置 → automatic（现状：最终文本自动投递）', () => {
  assert.equal(resolveVisibleRepliesMode({ cfg: {} as any, mode: 'user_request' }), 'automatic');
});

await test('user_request + 全局 messages.groupChat.visibleReplies=message_tool → message_tool', () => {
  const cfg: any = { messages: { groupChat: { visibleReplies: 'message_tool' } } };
  assert.equal(resolveVisibleRepliesMode({ cfg, mode: 'user_request' }), 'message_tool');
});

await test('user_request + 全局 messages.visibleReplies 兜底', () => {
  const cfg: any = { messages: { visibleReplies: 'message_tool' } };
  assert.equal(resolveVisibleRepliesMode({ cfg, mode: 'user_request' }), 'message_tool');
});

await test('groupChat.visibleReplies 不影响非群（c2c/dm）turn', () => {
  // 框架 c2c 分支只读 messages.visibleReplies；混读 groupChat 会把
  // 「群里配 visibleReplies=message_tool」扩散到私聊，把 DM 终稿压成静默。
  const cfg: any = { messages: { groupChat: { visibleReplies: 'message_tool' } } };
  assert.equal(
    resolveVisibleRepliesMode({ cfg, mode: 'user_request', chatType: 'direct' }),
    'automatic',
    'c2c 不得读 groupChat.visibleReplies',
  );
  assert.equal(
    resolveVisibleRepliesMode({ cfg, mode: 'user_request', chatType: 'group' }),
    'message_tool',
    '群仍读 groupChat.visibleReplies',
  );
});

await test('非群 turn 在 messages.visibleReplies=message_tool 时也生效', () => {
  const cfg: any = { messages: { visibleReplies: 'message_tool' } };
  assert.equal(resolveVisibleRepliesMode({ cfg, mode: 'user_request', chatType: 'direct' }), 'message_tool');
});

// ── 3. message 工具守卫 ────────────────────────────────────────

group('message 工具守卫（防结构性沉默）');

await test('群工具白名单不含 message → 不可用', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: ['web_search'] },
  });
  assert.equal(r.available, false);
  assert.ok(r.reason);
});

await test('群工具白名单含 message → 可用', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: ['message', 'web_search'] },
  });
  assert.equal(r.available, true);
});

await test('群策略 deny ["*"] → 不可用', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: [], deny: ['*'] },
  });
  assert.equal(r.available, false);
});

await test('群白名单不含 message 但 alsoAllow 含 → 可用', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: ['web_search'], alsoAllow: ['message'] },
  });
  assert.equal(r.available, true);
});

await test('只有 alsoAllow（无 allow）→ 视为不限制（core unionAllow 产出 ["*", ...alsoAllow]）', () => {
  // 框架 unionAllow：allow 缺失或为空数组时，alsoAllow 会带上 "*" → 隐式全放行。
  // 按排他白名单判会把 tools:{alsoAllow:[...]} 的群误降级，与框架结论相反。
  const onlyAlso = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { alsoAllow: ['web_search'] },
  });
  assert.equal(onlyAlso.available, true, '只有 alsoAllow 不是排他白名单');

  const emptyAllow = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: [], alsoAllow: ['web_search'] },
  });
  assert.equal(emptyAllow.available, true, 'allow: [] + alsoAllow 同样是隐式全放行');
});

await test('agent / 全局层只有 alsoAllow → 同样视为不限制', () => {
  const agentOnly = resolveMessageToolAvailability({
    cfg: { agents: { entries: { main: { tools: { alsoAllow: ['web_search'] } } } } } as any,
    agentId: 'main',
  });
  assert.equal(agentOnly.available, true);

  const globalOnly = resolveMessageToolAvailability({
    cfg: { tools: { alsoAllow: ['web_search'] } } as any,
  });
  assert.equal(globalOnly.available, true);
});

await test('allow 含通配 "*" → 不限制', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: ['*'] },
  });
  assert.equal(r.available, true);
});

await test('deny 支持通配（框架同款 glob）：deny:["mess*"] 拦下 message', () => {
  // core compileGlobPattern：含 "*" → 正则 ^...$；字面量比较会漏判这条
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { deny: ['mess*'] },
  });
  assert.equal(r.available, false, '通配 deny 同样要判为不可用');
});

await test('allow 通配 "mess*" → 视为包含 message（不判为不可用）', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { allow: ['mess*'] },
  });
  assert.equal(r.available, true);
});

await test('deny 大小写归一（MESSAGE 同样拦下）', () => {
  const r = resolveMessageToolAvailability({
    cfg: {} as any,
    groupToolPolicy: { deny: ['MESSAGE'] },
  });
  assert.equal(r.available, false);
});

await test('agent profile=messaging → 可用', () => {
  const cfg: any = { agents: { entries: { main: { tools: { profile: 'messaging' } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, true);
});

await test('agent profile=coding 仍算可用（框架在 room_event 下强制授予 message）', () => {
  // 框架 runtimeProfileAlsoAllow 会在 message_tool_only / room_event turn
  // 把 message 并入 profile 允许集（core 9.1 与 10.5 一致），
  // 所以 profile 不含 message 并不等于 agent 不会说话。
  const cfg: any = { agents: { entries: { main: { tools: { profile: 'coding' } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, true);
});

await test('agent 显式 allow 白名单不含 message → 不可用（该层不经强制授权）', () => {
  const cfg: any = { agents: { entries: { main: { tools: { allow: ['web_search'] } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, false);
  assert.ok(r.reason?.includes('agent'));
});

await test('agent 显式 deny 含 message → 不可用', () => {
  const cfg: any = { agents: { entries: { main: { tools: { deny: ['message'] } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, false);
});

await test('agent 显式 allow 不含 message 但 alsoAllow 含 → 可用', () => {
  const cfg: any = { agents: { entries: { main: { tools: { allow: ['web_search'], alsoAllow: ['message'] } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, true);
});

await test('全局 tools 白名单不含 message → 不可用', () => {
  // 无 agent 条目时，全局 tools 即回落到 agent 层（框架同款取值顺序）
  const cfg: any = { tools: { allow: ['web_search'] } };
  const r = resolveMessageToolAvailability({ cfg });
  assert.equal(r.available, false);
});

await test('有 agent 条目时，全局 tools 白名单仍独立生效', () => {
  const cfg: any = {
    tools: { allow: ['web_search'] },
    agents: { entries: { main: { tools: { profile: 'messaging' } } } },
  };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, false);
  assert.ok(r.reason?.includes('全局'));
});

await test('未知 profile → 按可用处理（乐观，宁多跑一次 turn 不误伤）', () => {
  const cfg: any = { agents: { entries: { main: { tools: { profile: 'brand-new-profile' } } } } };
  const r = resolveMessageToolAvailability({ cfg, agentId: 'main' });
  assert.equal(r.available, true);
});

// ── 4. 降级行为 ────────────────────────────────────────────────

group('room_event → user_request 降级');

await test('工具面缺 message → 降级为 user_request 并带原因', () => {
  const account = makeAccount({ G1: { unmentionedInbound: 'room_event' } });
  const cfg: any = {
    channels: { qqbot: { groups: { G1: { tools: { allow: ['web_search'] } } } } },
  };
  const policy = resolveRoomEventPolicy({ cfg, account, groupOpenid: 'G1', agentId: 'main' });
  assert.equal(policy.mode, 'room_event', '配置层裁决仍是 room_event');
  assert.equal(policy.effectiveMode, 'user_request', '实际生效模式降级为 user_request');
  assert.equal(policy.degraded, true);
  assert.ok(policy.degradedReason);
  assert.equal(policy.visibleReplies, 'automatic', '降级后恢复正常投递');
});

await test('roomEventRequireMessageTool=false → 不降级（用户显式选择严格静默）', () => {
  const account = makeAccount({
    G1: { unmentionedInbound: 'room_event', roomEventRequireMessageTool: false },
  });
  const cfg: any = {
    channels: { qqbot: { groups: { G1: { tools: { allow: ['web_search'] } } } } },
  };
  const policy = resolveRoomEventPolicy({ cfg, account, groupOpenid: 'G1', agentId: 'main' });
  assert.equal(policy.effectiveMode, 'room_event');
  assert.equal(policy.degraded, false);
});

await test('默认 restricted 工具集含 message → 不降级', () => {
  const account = makeAccount({ G1: { unmentionedInbound: 'room_event' } });
  const cfg: any = { channels: { qqbot: {} } };
  const policy = resolveRoomEventPolicy({ cfg, account, groupOpenid: 'G1', agentId: 'main' });
  assert.equal(policy.effectiveMode, 'room_event');
  assert.equal(policy.degraded, false);
  assert.equal(policy.messageToolAvailable, true);
});

await test('群工具策略解析与 room-event 守卫同源（白名单不含 message 时一致）', () => {
  const cfg: any = {
    channels: { qqbot: { groups: { G1: { tools: { allow: ['web_search'] } } } } },
  };
  const policy = resolveGroupToolPolicyConfig(cfg, 'default', 'G1');
  assert.deepEqual(policy?.allow, ['web_search']);
  const availability = resolveMessageToolAvailability({ cfg: cfg as any, groupToolPolicy: policy });
  assert.equal(availability.available, false);
});

// ── 5. 唤醒判定与入站分类 ──────────────────────────────────────

group('唤醒判定与入站分类（唯一口径）');

await test('三种唤醒来源判定正确', () => {
  assert.equal(resolveWakeDecision({ mentionState: { wasMentioned: true }, nameMentioned: false }).source, 'mention');
  assert.equal(resolveWakeDecision({ mentionState: { implicit: true }, nameMentioned: false }).source, 'quote-bot');
  assert.equal(resolveWakeDecision({ mentionState: {}, nameMentioned: true }).source, 'name-pattern');
  const none = resolveWakeDecision({ mentionState: {}, nameMentioned: false });
  assert.equal(none.wasMentioned, false);
  assert.equal(none.source, 'none');
});

await test('入站分类：被叫醒 / 斜杠命令 / 非群 → user_request', () => {
  const wake = resolveWakeDecision({ mentionState: { wasMentioned: true }, nameMentioned: false });
  assert.equal(classifyInboundEventKind({ isGroup: true, rawBody: 'hi', wake, unmentionedInbound: 'room_event' }), 'user_request');
  assert.equal(
    classifyInboundEventKind({ isGroup: true, rawBody: '/bot-ping', wake: resolveWakeDecision({ mentionState: {}, nameMentioned: false }), unmentionedInbound: 'room_event' }),
    'user_request',
  );
  assert.equal(
    classifyInboundEventKind({ isGroup: false, rawBody: 'hi', wake: resolveWakeDecision({ mentionState: {}, nameMentioned: false }), unmentionedInbound: 'room_event' }),
    'user_request',
  );
});

await test('入站分类：未被叫醒且群为 room_event → room_event', () => {
  const wake = resolveWakeDecision({ mentionState: {}, nameMentioned: false });
  assert.equal(classifyInboundEventKind({ isGroup: true, rawBody: '闲聊', wake, unmentionedInbound: 'room_event' }), 'room_event');
});

await test('入站分类：群为 user_request → 恒 user_request', () => {
  const wake = resolveWakeDecision({ mentionState: {}, nameMentioned: false });
  assert.equal(classifyInboundEventKind({ isGroup: true, rawBody: '闲聊', wake, unmentionedInbound: 'user_request' }), 'user_request');
});

// ── 6. /bot-group-info 排障面 ──────────────────────────────────

group('/bot-group-info 展示裁决后的入站策略');

await test('群级配 room_event → 展示 room_event 与来源', async () => {
  const { botGroupInfo } = await import('../src/commands/bot-group-info.ts');
  const account = makeAccount({ G1: { unmentionedInbound: 'room_event' } });
  const cmd = botGroupInfo(account);
  const out = String(await (cmd.handler as any)({ message: { groupOpenid: 'G1' } }));
  assert.ok(out.includes('room_event'), '应展示 room_event');
  assert.ok(out.includes('入站策略来源：群级配置'), '应展示策略来源');
});

await test('工具不可用导致降级 → 展示降级原因', async () => {
  const { botGroupInfo } = await import('../src/commands/bot-group-info.ts');
  const account = makeAccount({ G1: { unmentionedInbound: 'room_event' } });
  const cfg: any = {
    channels: { qqbot: { groups: { G1: { tools: { allow: ['web_search'] } } } } },
  };
  const runtime = () => ({
    config: { current: () => cfg },
    channel: { routing: { resolveAgentRoute: () => ({ agentId: 'default' }) } },
  });
  const cmd = botGroupInfo(account, runtime as any);
  const out = String(await (cmd.handler as any)({ message: { groupOpenid: 'G1' } }));
  assert.ok(out.includes('已降级'), '应展示降级');
  assert.ok(out.includes('message 工具'), '应指出 message 工具问题');
});

await test('输出保留分组空行（filter 不得吃掉刻意留的分隔行）', async () => {
  const { botGroupInfo } = await import('../src/commands/bot-group-info.ts');
  const account = makeAccount({ G1: { unmentionedInbound: 'room_event' } });
  const cmd = botGroupInfo(account);
  const out = String(await (cmd.handler as any)({ message: { groupOpenid: 'G1' } }));
  assert.ok(out.includes('\n\n'), '应保留空行分隔');
  assert.ok(out.startsWith('🤖 群信息'), '首行应是标题');
  const lines = out.split('\n');
  assert.ok(lines.some((l) => l === ''), '不得出现被过滤掉的空行结构');
});

// ── 结果 ───────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
}
console.log('\n✅ 所有测试通过！');
process.exit(0);
