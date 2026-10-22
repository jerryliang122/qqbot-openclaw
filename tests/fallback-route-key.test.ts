/**
 * 兜底路由 sessionKey 的 canonical + route 文法回归测试（2026-10-22，10.5 地板）。
 *
 * 背景：openclaw 2026.10.x 的 state worker 对 session 写入做 canonical 校验
 * （state worker → validateCanonicalSessionRow → normalizeStoreSessionKey + parseAgentSessionKey）：
 *   1. parseAgentSessionKey(key) 非 null（`agent:<agentId>:<rest>` 文法，
 *      或保留字 global/unknown）；
 *   2. normalizeStoreSessionKey(key) === key（key 等于其全小写折叠形）。
 * 违反即抛 SessionCanonicalKeyMigrationRequiredError，该 session 的一切读写瘫痪。
 *
 * 但「能写进 DB」不等于「框架能路由到」：框架反解投递目标用的是
 * parseSessionDeliveryRoute，文法是 `<channel>[:<accountId>]:<peerKind>:<peerId>`——
 * 把 accountId（或历史遗留的 `:coalescing` 后缀）塞进 peer 段，框架会把它们
 * 算进 peerId，自发回复 / 投递恢复 / 子代理路由全部指向不存在的 peer。
 * 这正是上一版兜底（`agent:main:qqbot:group:<acct>:<peer>:coalescing`）的毛病：
 * 它过了 canonical 校验，却让框架解析出 peerId = `<acct>:<peer>:coalescing`。
 *
 * 守卫形状（三层，全部用【已安装 openclaw 的真实函数】判定，不靠形状猜测）：
 *   1. **差分**：本地镜像 buildFallbackRouteSessionKey 与框架 buildAgentPeerSessionKey
 *      在 dmScope × groupScope 全矩阵上**逐字相同**——上游改了文法，这里立刻变红；
 *   2. **canonical**：两条校验规则都过（用的是 state worker 同款函数）；
 *   3. **route**：parseSessionDeliveryRoute 解出的 peerId 就是目标 peer，
 *      且不含 accountId 污染。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { buildFallbackRouteSessionKey, resolveDispatchPeerId } from '../src/dispatch/dispatch.js';

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

/** 兜底 key 的作用域矩阵——覆盖框架 dmScope / groupScope 的全部分支。 */
const MATRIX = [
  {
    name: '群 / per-group',
    isGroup: true,
    peerId: 'Group_OpenID_H',
    dmScope: 'main',
    groupScope: 'per-group',
    route: { channel: 'qqbot', peerKind: 'group', peerId: 'group_openid_h' },
  },
  {
    name: '群 / main',
    isGroup: true,
    peerId: 'Group_OpenID_H',
    dmScope: 'main',
    groupScope: 'main',
    route: null,
  },
  {
    name: '私 / main',
    isGroup: false,
    peerId: 'User_OpenID_H',
    dmScope: 'main',
    groupScope: 'per-group',
    route: null,
  },
  {
    name: '私 / per-peer',
    isGroup: false,
    peerId: 'User_OpenID_H',
    dmScope: 'per-peer',
    groupScope: 'per-group',
    route: null,
  },
  {
    name: '私 / per-channel-peer',
    isGroup: false,
    peerId: 'User_OpenID_H',
    dmScope: 'per-channel-peer',
    groupScope: 'per-group',
    route: { channel: 'qqbot', peerKind: 'direct', peerId: 'user_openid_h' },
  },
  {
    name: '私 / per-account-channel-peer',
    isGroup: false,
    peerId: 'User_OpenID_H',
    dmScope: 'per-account-channel-peer',
    groupScope: 'per-group',
    route: { channel: 'qqbot', peerKind: 'direct', peerId: 'user_openid_h', accountId: 'default' },
  },
] as const;

const AGENT_ID = 'main';
const MAIN_KEY = 'main';
const ACCOUNT_ID = 'Default';

/**
 * 在**子进程**里加载已安装 openclaw 的 dist 内部模块并算出参照结果。
 *
 * 必须放子进程：openclaw 是 ESM 包（"type":"module"），部分依赖的 exports 只有
 * `import` 条件；tsx 会 patch Module._resolveFilename，在本进程内直接 require
 * 这些子路径会报 "No exports main defined in ..."——那是加载器差异，不是插件缺陷。
 */
function run<T>(fnBody: string): T {
  // --input-type=module 的 -e 支持 top-level await，import 必须留在顶层。
  const out = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', fnBody],
    { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' } },
  );
  return JSON.parse(out) as T;
}

/**
 * 一次性取回全部参照数据：
 * - frameworkKey：框架 buildAgentPeerSessionKey 的产物（差分基准）
 * - canonical：parseAgentSessionKey / normalizeStoreSessionKey 的判定（state worker 同款）
 * - route：parseSessionDeliveryRoute 的反解结果
 */
function frameworkReference(cases: typeof MATRIX): {
  error?: string;
  module?: string;
  results: Array<{
    frameworkKey: string;
    canonical: boolean;
    route: { channel?: string; peerKind?: string; peerId?: string; accountId?: string } | null;
  }>;
} {
  return run(`
    import fs from 'node:fs';
    import path from 'node:path';
    import { pathToFileURL } from 'node:url';

    const dist = path.resolve('node_modules/openclaw/dist');
    const cases = ${JSON.stringify(cases)};

    // ① 找到同时导出三个原语的模块（dist 文件名带构建哈希，按行为探测）
    let fw = null;
    let fwFile = '';
    for (const f of fs.readdirSync(dist)) {
      if (!/^session-key-.*\\.mjs$/.test(f)) continue;
      let m;
      try { m = await import(pathToFileURL(path.join(dist, f)).href); } catch { continue; }
      if (typeof m.buildAgentPeerSessionKey === 'function'
        && typeof m.parseAgentSessionKey === 'function'
        && typeof m.parseSessionDeliveryRoute === 'function') {
        fw = m; fwFile = f; break;
      }
    }
    if (!fw) {
      console.log(JSON.stringify({ error: '未能在 openclaw dist 中找到 session-key 原语模块', results: [] }));
      process.exit(0);
    }

    // ② normalizeStoreSessionKey（state worker 校验用的那个）——在 store-entry 模块里
    let store = null;
    for (const f of fs.readdirSync(dist)) {
      if (!/^store-entry-.*\\.mjs$/.test(f)) continue;
      let m;
      try { m = await import(pathToFileURL(path.join(dist, f)).href); } catch { continue; }
      if (typeof m.a === 'function') { store = m; break; }
    }

    const results = cases.map((c) => {
      const key = fw.buildAgentPeerSessionKey({
        agentId: c.agentId,
        mainKey: c.mainKey,
        channel: 'qqbot',
        accountId: c.accountId,
        peerKind: c.isGroup ? 'group' : 'direct',
        peerId: c.peerId,
        dmScope: c.dmScope,
        groupScope: c.groupScope,
      });
      const parsed = fw.parseAgentSessionKey(key);
      const folded = store ? store.a(key) : key;
      const route = fw.parseSessionDeliveryRoute(key);
      return {
        frameworkKey: key,
        canonical: Boolean(parsed) && folded === key,
        route: route ? {
          channel: route.channel,
          peerKind: route.peerKind,
          peerId: route.peerId,
          accountId: route.accountId,
        } : null,
      };
    });

    console.log(JSON.stringify({ module: fwFile, results }));
  `);
}

const referenceCases = MATRIX.map((c) => ({
  ...c,
  agentId: AGENT_ID,
  mainKey: MAIN_KEY,
  accountId: ACCOUNT_ID,
}));

const ref = frameworkReference(referenceCases);

await test('能在已安装 openclaw 中定位 session-key 原语模块', () => {
  assert.ok(!ref.error, ref.error ?? '');
  assert.ok(ref.module, '未找到导出 buildAgentPeerSessionKey 的模块');
  assert.equal(ref.results.length, MATRIX.length);
});

await test('兜底 key 与框架 buildAgentPeerSessionKey 逐字相同（差分守卫）', () => {
  for (let i = 0; i < referenceCases.length; i++) {
    const c = referenceCases[i];
    const ours = buildFallbackRouteSessionKey({
      isGroup: c.isGroup,
      accountId: c.accountId,
      peerId: c.peerId,
      agentId: c.agentId,
      mainKey: c.mainKey,
      dmScope: c.dmScope,
      groupScope: c.groupScope,
    });
    assert.equal(
      ours,
      ref.results[i].frameworkKey,
      `${c.name}：兜底 key 与框架产物不一致——` +
        `本地 ${ours}，框架 ${ref.results[i].frameworkKey}（上游改了 session key 文法/作用域语义？）`,
    );
  }
});

await test('兜底 key 满足 canonical 校验（真实解析/折叠函数）', () => {
  for (let i = 0; i < referenceCases.length; i++) {
    const c = referenceCases[i];
    const ours = buildFallbackRouteSessionKey({
      isGroup: c.isGroup,
      accountId: c.accountId,
      peerId: c.peerId,
      agentId: c.agentId,
      mainKey: c.mainKey,
      dmScope: c.dmScope,
      groupScope: c.groupScope,
    });
    assert.ok(
      ref.results[i].canonical,
      `${c.name}：兜底 key "${ours}" 不满足 canonical 文法（agent: 解析或全小写折叠失败）`,
    );
  }
});

await test('兜底 key 能被框架反解出正确 peer（route 文法不被 accountId 污染）', () => {
  for (let i = 0; i < referenceCases.length; i++) {
    const c = referenceCases[i];
    const expected = c.route;
    const actual = ref.results[i].route;
    if (!expected) {
      assert.equal(actual, null, `${c.name}：框架不应从该 key 反解出 route，实际 ${JSON.stringify(actual)}`);
      continue;
    }
    assert.ok(actual, `${c.name}：框架未能从该 key 反解出 route`);
    assert.equal(actual.channel, expected.channel, `${c.name}：channel 不符`);
    assert.equal(actual.peerKind, expected.peerKind, `${c.name}：peerKind 不符`);
    assert.equal(actual.peerId, expected.peerId, `${c.name}：peerId 不符（accountId 不得混进 peer 段）`);
    if ('accountId' in expected) {
      assert.equal(actual.accountId, expected.accountId, `${c.name}：accountId 不符`);
    }
  }
});

await test('兜底 key 不回退到旧 qqbot: 文法（10.x 拒写形状）', () => {
  const key = buildFallbackRouteSessionKey({ isGroup: true, accountId: 'default', peerId: 'g1' });
  assert.ok(key.startsWith('agent:'), `应使用 agent: 文法，实际 ${key}`);
  assert.ok(!key.startsWith('qqbot:'), `不得回退旧 qqbot: 文法，实际 ${key}`);
  assert.equal(key, key.toLowerCase(), '兜底 key 必须全小写');
});

await test('群/私聊兜底 key 语义分流', () => {
  const group = buildFallbackRouteSessionKey({ isGroup: true, accountId: 'acct', peerId: 'peerX' });
  const dm = buildFallbackRouteSessionKey({ isGroup: false, accountId: 'acct', peerId: 'peerX' });
  assert.ok(group.includes(':qqbot:group:'), `群 key 形状：${group}`);
  assert.notEqual(group, dm, '群/私聊不得共享 session key');
});

await test('群聊路由 peerId 取 groupId 而非 senderId', () => {
  assert.equal(resolveDispatchPeerId('group', 'GROUP_123', 'USER_A'), 'GROUP_123');
  assert.equal(resolveDispatchPeerId('group', undefined, 'USER_A'), 'USER_A', '缺 groupId 时退回 senderId');
  assert.equal(resolveDispatchPeerId('direct', 'GROUP_123', 'USER_A'), 'USER_A');
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
