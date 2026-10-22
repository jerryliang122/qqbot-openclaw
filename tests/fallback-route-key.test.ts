/**
 * 兜底路由 sessionKey 的 canonical 文法回归测试（2026-10-22，10.5 地板）。
 *
 * 背景：openclaw 2026.10.x 的 canonical session 校验对写入的 session key 有两条硬性要求
 * （dispatch-from-config → state worker → validateCanonicalSessionRow）：
 *   1. parseAgentSessionKey(key) 非 null（即 `agent:<agentId>:<rest>` 文法，
 *      或保留字 global/unknown）；
 *   2. normalizeStoreSessionKey(key) === key（即 key 等于其全小写折叠形）。
 * 违反即抛 SessionCanonicalKeyMigrationRequiredError，该 session 的一切写入被拒——
 * 插件旧兜底 `qqbot:<account>:...` 在 10.x 下等于全量静默瘫痪（已实测复现）。
 *
 * 守卫形状：断言用【已安装 openclaw 的真实解析/折叠函数】校验插件兜底 key
 * （消费方真函数，而非形状猜测——与 manifest-config-schema 守卫同一纪律）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { buildFallbackRouteSessionKey } from '../src/dispatch/dispatch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

function run<T>(fnBody: string): T {
  // --input-type=module 的 -e 支持 top-level await，import 必须留在顶层。
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', fnBody],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' } },
  );
  return JSON.parse(out) as T;
}

await test('兜底 key 满足已安装 openclaw 的 canonical 文法（真实解析函数校验）', () => {
  const cases: Array<Parameters<typeof buildFallbackRouteSessionKey>> = [
    [true, 'default', 'Group_OpenID_H'],
    [false, 'default', 'UserOpenID_H'],
    [true, 'SECOND-Account', 'g_9'],
    [false, 'SECOND-Account', 'u_9'],
  ];
  const keys = cases.map(([g, a, p]) => buildFallbackRouteSessionKey(g, a, p));
  // 每个都满足：agent: 文法可解析 + 折叠后不变
  const verdicts = keys.map((key) =>
    run<boolean>(`
      import path from 'node:path';
      import fs from 'node:fs';
      const dist = path.resolve('node_modules/openclaw/dist');
      const utilsFile = fs.readdirSync(dist).find(f => /^session-key-utils-.*\\.mjs$/.test(f));
      const m = await import('file://' + path.join(dist, utilsFile));
      const parsed = m.h(__KEY__);          // parseAgentSessionKey
      const folded = m.p(__KEY__);          // normalizeSessionKeyPreservingOpaquePeerIds
      console.log(JSON.stringify(Boolean(parsed) && folded === __KEY__));
    `.replaceAll('__KEY__', JSON.stringify(key))),
  );
  verdicts.forEach((ok, i) =>
    assert.ok(ok, `兜底 key "${keys[i]}" 不满足 canonical 文法（agent: 解析或全小写折叠失败）`),
  );
});

await test('兜底 key 不回退到旧 qqbot: 文法（10.x 拒写形状）', () => {
  const key = buildFallbackRouteSessionKey(true, 'default', 'g1');
  assert.ok(key.startsWith('agent:'), `应使用 agent: 文法，实际 ${key}`);
  assert.ok(!key.startsWith('qqbot:'), `不得回退旧 qqbot: 文法，实际 ${key}`);
  assert.equal(key, key.toLowerCase(), '兜底 key 必须全小写');
});

await test('群/私聊兜底 key 语义分流', () => {
  const group = buildFallbackRouteSessionKey(true, 'acct', 'peerX');
  const dm = buildFallbackRouteSessionKey(false, 'acct', 'peerX');
  assert.ok(group.includes(':group:acct:peerx:coalescing'), `群 key 形状：${group}`);
  assert.ok(dm.includes(':dm:acct:peerx'), `私聊 key 形状：${dm}`);
  assert.notEqual(group, dm, '群/私聊不得共享 session key');
});

await test('已安装 openclaw 钉版为 2026.10.5（地板一致性）', () => {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules/openclaw/package.json'), 'utf8'));
  assert.equal(pkg.version, '2026.10.5', `node_modules openclaw 版本漂移：${pkg.version}`);
});

console.log('--------------------------------------------------');
if (failed > 0) {
  console.error(`✗ ${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
