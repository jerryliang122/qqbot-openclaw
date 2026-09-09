/**
 * resolveAccountKey 测试
 *
 * 运行方式: npx tsx tests/account-key.test.ts
 */
import assert from 'node:assert';
import { resolveAccountKey } from '../src/setup/account-key.js';

// ── fixture 构造 ──

function makeCfg(accounts?: Array<{ id: string; appId: string }>): any {
  if (!accounts || accounts.length === 0) {
    return { channels: { qqbot: { enabled: true } } };
  }
  const accountsMap: Record<string, any> = {};
  for (const a of accounts) {
    accountsMap[a.id] = { appId: a.appId, clientSecret: 'secret', enabled: true };
  }
  return { channels: { qqbot: { enabled: true, accounts: accountsMap } } };
}

function makeTopLevelCfg(appId: string): any {
  return { channels: { qqbot: { enabled: true, appId, clientSecret: 'secret' } } };
}

// ── 测试框架 ──

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : String(e)}`);
    failed++;
    failedTests.push(name);
  }
}

// ── 测试 ──

console.log('\n=== resolveAccountKey ===\n');

// ── resolvedId 指定 ──

await test('resolvedId takes priority over everything', () => {
  const cfg = makeCfg([{ id: 'existing', appId: '100001' }]);
  assert.equal(resolveAccountKey(cfg, '100002', 'my-account'), 'my-account');
});

await test('resolvedId works even with zero accounts', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '100001', 'custom'), 'custom');
});

// ── 同 appId 刷新 ──

await test('same appId in named account → refresh that account', () => {
  const cfg = makeCfg([{ id: 'bot1', appId: '100001' }]);
  assert.equal(resolveAccountKey(cfg, '100001'), 'bot1');
});

await test('same appId in default (top-level) account → refresh default', () => {
  const cfg = makeTopLevelCfg('100001');
  assert.equal(resolveAccountKey(cfg, '100001'), 'default');
});

await test('same appId among multiple accounts → refreshes matching one', () => {
  const cfg = makeCfg([
    { id: 'bot1', appId: '100001' },
    { id: 'bot2', appId: '100002' },
    { id: 'bot3', appId: '100003' },
  ]);
  assert.equal(resolveAccountKey(cfg, '100002'), 'bot2');
});

// ── 零账户 → default ──

await test('zero accounts → default', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '100001'), 'default');
});

await test('zero accounts, different appId → still default', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '999999'), 'default');
});

// ── 已有其他账户，新 appId → 新增 ──

await test('existing accounts, new appId → uses appId as key', () => {
  const cfg = makeCfg([{ id: 'bot1', appId: '100001' }]);
  assert.equal(resolveAccountKey(cfg, '200002'), '200002');
});

await test('multiple accounts, new appId → uses appId as key', () => {
  const cfg = makeCfg([
    { id: 'bot1', appId: '100001' },
    { id: 'bot2', appId: '100002' },
  ]);
  assert.equal(resolveAccountKey(cfg, '200003'), '200003');
});

// ── 边界情况 ──

await test('resolvedId=null/undefined → falls through', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '100001', null), 'default');
  assert.equal(resolveAccountKey(cfg, '100001', undefined), 'default');
});

await test('resolvedId=empty string → falls through', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '100001', ''), 'default');
});

await test('appId is a numeric string', () => {
  const cfg = makeCfg([]);
  assert.equal(resolveAccountKey(cfg, '1904094249'), 'default');
});

await test('account IDs are numeric strings → match works', () => {
  const cfg = makeCfg([{ id: '102901613', appId: '1904094249' }]);
  assert.equal(resolveAccountKey(cfg, '1904094249'), '102901613');
});

await test('account IDs are numeric, new appId creates numeric key', () => {
  const cfg = makeCfg([{ id: '102901613', appId: '1904094249' }]);
  assert.equal(resolveAccountKey(cfg, '102942412'), '102942412');
});

await test('disabled account still matches by appId', () => {
  const cfg = {
    channels: {
      qqbot: {
        enabled: true,
        accounts: {
          bot1: { appId: '100001', clientSecret: 's', enabled: false },
        },
      },
    },
  };
  assert.equal(resolveAccountKey(cfg, '100001'), 'bot1');
});

await test('multiple accounts with same appId → returns first match', () => {
  const cfg = makeCfg([
    { id: 'bot1', appId: '100001' },
    { id: 'bot2', appId: '100001' },
  ]);
  assert.equal(resolveAccountKey(cfg, '100001'), 'bot1');
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failedTests.join(', ')}`);
  process.exit(1);
}
