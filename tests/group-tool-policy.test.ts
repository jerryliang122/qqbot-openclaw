/**
 * 群工具策略 + mentionPatterns 解析回归测试（2026-10-06 线上事故）
 *
 * 事故背景（openclaw 2026.9.5 → 2026.9.7 升级后 room_event 群彻底沉默）：
 * 1. openclaw 2026.9.6+ 把 groups.resolveToolPolicy 的返回值真正应用到 run 的
 *    工具集：`{ allow: [] }`（空允许清单）= 什么都不允许（含 message 工具）。
 *    room_event 群发言必须走 message 工具 → 工具被过滤 = 彻底沉默。
 * 2. 框架回调 adapter 传入的 groupId 派生自 session key（小写），QQ 群 openid
 *    配置键原生大写——精确匹配永远 miss，全部落默认 restricted。
 * 3. mentionPatterns 只读 agents.list（数组），现行配置是 agents.entries
 *    （对象）→ 称呼唤醒（如「沈处」）解析为空，room_event 群该回的也不回。
 *
 * 运行方式: npx tsx tests/group-tool-policy.test.ts
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

const { resolveGroupConfig, resolveMentionPatterns } = await import('../src/config.ts');
const { qqbotGroupsAdapter } = await import('../src/channel.ts');

function baseCfg(groups: Record<string, unknown> = {}) {
  return { channels: { qqbot: { groups } } } as never;
}

group('resolveGroupConfig 大小写不敏感查找');

await test('小写 session-key id 命中大写配置键（事故核心场景）', () => {
  const cfg = baseCfg({
    FAAB4EEF5082D84AF7FD258071719FB9: { toolPolicy: 'full', name: '测试群' },
  });
  const resolved = resolveGroupConfig(cfg, 'faab4eef5082d84af7fd258071719fb9');
  assert.equal(resolved.toolPolicy, 'full', '小写 id 应命中大写配置键的 toolPolicy');
  assert.equal(resolved.name, '测试群');
});

await test('大写原始 openid 仍精确命中（dispatch 路径不受影响）', () => {
  const cfg = baseCfg({
    FAAB4EEF5082D84AF7FD258071719FB9: { unmentionedInbound: 'room_event' },
  });
  const resolved = resolveGroupConfig(cfg, 'FAAB4EEF5082D84AF7FD258071719FB9');
  assert.equal(resolved.unmentionedInbound, 'room_event');
});

await test('大小写不敏感命中后 wildcard 仍作 fallback', () => {
  const cfg = baseCfg({
    '*': { requireMention: false },
    FAAB4EEF5082D84AF7FD258071719FB9: { historyLimit: 5 },
  });
  const resolved = resolveGroupConfig(cfg, 'faab4eef5082d84af7fd258071719fb9');
  assert.equal(resolved.historyLimit, 5, '具体群字段优先');
  assert.equal(resolved.requireMention, false, '未配置字段落 wildcard');
});

await test('未知群仍落默认值（restricted / user_request）', () => {
  const resolved = resolveGroupConfig(baseCfg(), 'UNKNOWNGROUPID');
  assert.equal(resolved.toolPolicy, 'restricted');
  assert.equal(resolved.unmentionedInbound, 'user_request');
});

group('groups adapter 工具策略映射（9.6+ 契约）');

await test('toolPolicy=full → undefined（交给 agent tools.profile）', () => {
  const out = qqbotGroupsAdapter.resolveToolPolicy({
    cfg: baseCfg({ FAAB4EEF5082D84AF7FD258071719FB9: { toolPolicy: 'full' } }) as never,
    groupId: 'faab4eef5082d84af7fd258071719fb9',
    accountId: 'default',
  });
  assert.equal(out, undefined);
});

await test('restricted（默认）→ 白名单必须包含 message（红线）', () => {
  const out = qqbotGroupsAdapter.resolveToolPolicy({
    cfg: baseCfg() as never,
    groupId: 'FAAB4EEF5082D84AF7FD258071719FB9',
    accountId: 'default',
  }) as { allow: string[] } | undefined;
  assert.ok(out, 'restricted 应返回白名单对象');
  assert.ok(out.allow.length > 0, '白名单不得为空（空 = 全禁止，事故根因）');
  assert.ok(out.allow.includes('message'), 'message 工具永远不得被群策略过滤');
  assert.ok(out.allow.includes('qqbot_remind'), '通道自有工具应在白名单');
  assert.ok(!out.allow.includes('exec'), '执行类工具不得进 restricted 白名单');
});

await test('toolPolicy=none → 显式全禁（保持管理员语义）', () => {
  const out = qqbotGroupsAdapter.resolveToolPolicy({
    cfg: baseCfg({ FAAB4EEF5082D84AF7FD258071719FB9: { toolPolicy: 'none' } }) as never,
    groupId: 'faab4eef5082d84af7fd258071719fb9',
    accountId: 'default',
  }) as { allow: string[]; deny: string[] } | undefined;
  assert.deepEqual(out, { allow: [], deny: ['*'] });
});

await test('无 groupId → undefined（非群会话不受限）', () => {
  const out = qqbotGroupsAdapter.resolveToolPolicy({
    cfg: baseCfg() as never,
    groupId: undefined,
    accountId: 'default',
  });
  assert.equal(out, undefined);
});

group('resolveMentionPatterns 兼容 agents.entries / agents.list');

await test('agents.entries（现行形态）正确解析', () => {
  const cfg = {
    agents: { entries: { main: { groupChat: { mentionPatterns: ['@?沈处', '沈处'] } } } },
  } as never;
  assert.deepEqual(resolveMentionPatterns(cfg, 'main'), ['@?沈处', '沈处']);
});

await test('agents.entries 键大小写不敏感', () => {
  const cfg = { agents: { entries: { Main: { groupChat: { mentionPatterns: ['沈处'] } } } } } as never;
  assert.deepEqual(resolveMentionPatterns(cfg, 'main'), ['沈处']);
});

await test('agents.list（旧形态）仍兼容', () => {
  const cfg = { agents: { list: [{ id: 'Main', groupChat: { mentionPatterns: ['沈处'] } }] } } as never;
  assert.deepEqual(resolveMentionPatterns(cfg, 'main'), ['沈处']);
});

await test('entries 优先于 list', () => {
  const cfg = {
    agents: {
      entries: { main: { groupChat: { mentionPatterns: ['entries值'] } } },
      list: [{ id: 'main', groupChat: { mentionPatterns: ['list值'] } }],
    },
  } as never;
  assert.deepEqual(resolveMentionPatterns(cfg, 'main'), ['entries值']);
});

await test('agent 未配置 → 落 messages.groupChat 全局', () => {
  const cfg = { agents: { entries: { main: {} } }, messages: { groupChat: { mentionPatterns: ['全局'] } } } as never;
  assert.deepEqual(resolveMentionPatterns(cfg, 'main'), ['全局']);
});

await test('无任何配置 → 空数组（不炸）', () => {
  assert.deepEqual(resolveMentionPatterns({} as never, 'main'), []);
  assert.deepEqual(resolveMentionPatterns({} as never), []);
});

// ── 汇总 ──
console.log(`\n${'='.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
