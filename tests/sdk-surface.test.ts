/**
 * Plugin SDK 依赖面守卫（盯版回归测试）
 *
 * 背景：openclaw 2026.10.2 **整体移除**了 `openclaw/plugin-sdk/channel-message`
 * 子路径（连带 channel-lifecycle / channel-reply-pipeline / command-auth /
 * config-runtime / discord / infra-runtime / telegram-account）。插件对它的
 * 唯一用法（progress card 渲染器 formatPlanChecklistLines）已迁至
 * `openclaw/plugin-sdk/channel-outbound`——该子路径 2026.9.1 与 2026.10.2 都在，
 * 故本修复对基线与新版本同时成立。
 *
 * 这类"子路径被删"故障的形态是**运行时炸裂**（ERR_PACKAGE_PATH_NOT_EXPORTED，
 * 插件加载即失败），typecheck 之前完全无声——被删的子路径连 .d.ts 一起消失，
 * tsc 只会报"找不到模块"，而我们直到线上才发现。
 *
 * 因此本文件把"插件用到的 SDK 子路径"固化为可执行断言，让**下一次**盯版
 * 在 CI 就红，而不是等发版后炸：
 * 1. 每个被引用的子路径必须存在于已安装 openclaw 的 package.json exports；
 * 2. 每个「值导入」的名字必须真的能从该子路径 require 出来（类型导入擦除，
 *    不参与运行时解析）；
 * 3. ambient stub（src/openclaw-plugin-sdk.d.ts）声明的模块必须**确实仍无官方
 *    类型**——包一旦补上 .d.ts，ambient declare 会遮蔽真实类型，typecheck 等于
 *    没验证（AGENTS.md 记录的既有教训）；
 * 4. devDependency 钉版必须与 peer 范围一致钉在基线上（钉版=最旧受支持 API 面）。
 *
 * 运行方式: npx tsx tests/sdk-surface.test.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(ROOT, 'index.js'));

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

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

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

/** 收集源码文件（排除 .d.ts 与测试自身） */
function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(p, acc);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

// ── 依赖面扫描 ──

type ImportRecord = { sub: string; names: Set<string>; typeOnly: Set<string>; files: Set<string> };

const subpaths = new Map<string, ImportRecord>();

function record(sub: string, name: string, typeOnly: boolean, file: string) {
  let rec = subpaths.get(sub);
  if (!rec) {
    rec = { sub, names: new Set(), typeOnly: new Set(), files: new Set() };
    subpaths.set(sub, rec);
  }
  rec.files.add(file.replace(`${ROOT}/`, ''));
  (typeOnly ? rec.typeOnly : rec.names).add(name);
}

/**
 * 以「分号锚定」的单条 import 语句为单位解析，避免跨语句贪婪匹配。
 * 覆盖 `import { a, b as c } from '...'` 与 `import type { ... } from '...'`，
 * 以及 specifier 级别的 `type X`。
 */
const IMPORT_STMT = /import\s+(type\s+)?\{([\s\S]*?)\}\s*from\s*['"](openclaw\/plugin-sdk\/[a-z0-9-]+)['"]\s*;/g;

const scannedFiles = [...collectSourceFiles(join(ROOT, 'src')), join(ROOT, 'index.ts')];
for (const file of scannedFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(IMPORT_STMT)) {
    const stmtTypeOnly = !!m[1];
    for (let part of m[2].split(',')) {
      part = part.trim();
      if (!part) continue;
      const isType = stmtTypeOnly || /^type\s+/.test(part);
      const clean = part.replace(/^type\s+/, '').trim();
      const original = clean.split(/\s+as\s+/)[0].trim();
      if (original) record(m[3], original, isType, file);
    }
  }
}

// openclaw 未导出 "./package.json" 子路径，require 会抛
// ERR_PACKAGE_PATH_NOT_EXPORTED——从任一子路径解析后向上找包根。
function resolveOpenclawPackageJson(): string {
  let dir = dirname(require.resolve('openclaw/plugin-sdk/core'));
  for (let i = 0; i < 12; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        if (JSON.parse(readFileSync(candidate, 'utf8')).name === 'openclaw') return candidate;
      } catch {
        /* 继续向上 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('无法定位 node_modules/openclaw/package.json');
}

const openclawPkg = JSON.parse(readFileSync(resolveOpenclawPackageJson(), 'utf8')) as {
  name: string;
  version: string;
  exports?: Record<string, unknown>;
};
const repoPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

console.log(`openclaw 安装版本: ${openclawPkg.version}`);
console.log(`扫描源码文件: ${scannedFiles.length}，引用子路径: ${subpaths.size}`);

/**
 * 运行时导出探测放到**子进程**里做。
 *
 * 原因：openclaw 是 ESM 包（"type":"module"），其部分依赖（如 unicorn-magic）
 * 的 exports 只有 `import` 条件、没有 `require` 条件。本测试经 tsx 运行时执行，
 * tsx 会 patch Module._resolveFilename，导致在本文件内直接 require 这些子路径
 * 报 "No exports main defined in unicorn-magic"——那是加载器差异，不是插件缺陷。
 *
 * 插件的真实产物是 dist/index.cjs（CJS），由 Node 原生 CJS 加载器 require。
 * 因此这里用裸 node 子进程复刻生产解析路径，结论才可信。
 */
function probeRuntime(sub: string, names: string[]): { error?: string; missing: string[] } {
  const script = `
    const sub = ${JSON.stringify(sub)};
    const names = ${JSON.stringify(names)};
    try {
      const m = require(sub);
      const missing = names.filter((n) => !(n in m));
      process.stdout.write(JSON.stringify({ missing }));
    } catch (e) {
      process.stdout.write(JSON.stringify({ error: String(e && e.message || e).split('\\n')[0] }));
    }
  `;
  const out = execFileSync(process.execPath, ['-e', script], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out) as { error?: string; missing: string[] };
}

// ── 1 & 2. 子路径存在性 + 值导出存在性 ──

group('子路径与运行时导出');

for (const rec of [...subpaths.values()].sort((a, b) => a.sub.localeCompare(b.sub))) {
  await test(`${rec.sub}（${rec.names.size} 值 / ${rec.typeOnly.size} 类型）`, () => {
    // exports map 的键是 "./plugin-sdk/x"，源码里的 specifier 是 "openclaw/plugin-sdk/x"
    const exportKey = `./${rec.sub.replace(/^openclaw\//, '')}`;
    assert.ok(
      openclawPkg.exports && exportKey in openclawPkg.exports,
      `openclaw@${openclawPkg.version} 的 exports 已移除 "${exportKey}"。` +
        `\n    用法文件: ${[...rec.files].join(', ')}\n` +
        `    修复方向: 在新版本中找到该导出迁移到哪个子路径（逐版本 diff ` +
        `node_modules/openclaw/package.json 的 exports），改 import 并确认新旧两版都可用。`,
    );

    // 值导入必须真能在运行时取到（类型导入会被擦除，不参与 require）
    if (rec.names.size === 0) return;
    const probe = probeRuntime(rec.sub, [...rec.names]);
    assert.equal(
      probe.error,
      undefined,
      `openclaw@${openclawPkg.version} 无法 require "${exportKey}": ${probe.error}` +
        `\n    用法文件: ${[...rec.files].join(', ')}`,
    );
    assert.equal(
      probe.missing.length,
      0,
      `openclaw@${openclawPkg.version} 的 "${exportKey}" 缺少运行时值: ${probe.missing.join(', ')}。` +
        `\n    可能是改名/移除；类型导入擦除后插件会在运行到该分支时才炸。`,
    );
  });
}

// ── 本次盯版的具体回归锁 ──

group('channel-message 移除专项回归');

await test('不再引用已被 10.2 移除的 openclaw/plugin-sdk/channel-message', () => {
  const offenders: string[] = [];
  for (const file of scannedFiles) {
    const src = readFileSync(file, 'utf8');
    if (/from\s*['"]openclaw\/plugin-sdk\/channel-message['"]/.test(src)) {
      offenders.push(file.replace(`${ROOT}/`, ''));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件仍引用 channel-message（openclaw 2026.10.2 已移除该子路径，插件加载即抛 ` +
      `ERR_PACKAGE_PATH_NOT_EXPORTED）:\n    ${offenders.join('\n    ')}`,
  );
});

await test('progress card 渲染器改从 channel-outbound 取（两版都在）', () => {
  const file = join(ROOT, 'src/outbound/progress-card-publisher.ts');
  const src = readFileSync(file, 'utf8');
  assert.match(
    src,
    /import\s*\{\s*formatPlanChecklistLines\s*\}\s*from\s*['"]openclaw\/plugin-sdk\/channel-outbound['"]/,
    'formatPlanChecklistLines 应从 openclaw/plugin-sdk/channel-outbound 导入' +
      '（2026.9.1 与 2026.10.2 均导出；channel-message 已在 10.2 移除）',
  );
  const probe = probeRuntime('openclaw/plugin-sdk/channel-outbound', ['formatPlanChecklistLines']);
  assert.equal(probe.error, undefined, `channel-outbound require 失败: ${probe.error}`);
  assert.deepEqual(probe.missing, [], 'channel-outbound 应导出 formatPlanChecklistLines');
});

// ── 5. 构建产物可加载（真实生产路径） ──

group('构建产物可加载性');

await test('dist/index.cjs 能被 Node 原生 CJS 加载器 require（SDK 解析全链路）', () => {
  const distFile = join(ROOT, 'dist/index.cjs');
  if (!existsSync(distFile)) {
    console.log('    (跳过：未构建，先跑 npm run build)');
    return;
  }
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify('./dist/index.cjs')})`], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    const err = e as { stderr?: Buffer; message?: string };
    const stderr = err.stderr?.toString() ?? err.message ?? '';
    assert.fail(
      `dist/index.cjs 在 openclaw@${openclawPkg.version} 下加载失败——` +
        `插件会在框架加载阶段直接炸（子路径被删时典型报错 ERR_PACKAGE_PATH_NOT_EXPORTED）:\n` +
        `    ${stderr.split('\n').slice(0, 6).join('\n    ')}`,
    );
  }
});

// ── 3. ambient stub 不得遮蔽包内真实类型 ──

group('ambient stub 新鲜度');

await test('ambient stub 声明的模块在已安装 openclaw 中仍无官方 .d.ts', () => {
  const stubFile = join(ROOT, 'src/openclaw-plugin-sdk.d.ts');
  const stubSrc = readFileSync(stubFile, 'utf8');
  const declared = [...stubSrc.matchAll(/declare\s+module\s+"([^"]+)"/g)].map((m) => m[1]);

  // 裸入口 openclaw/plugin-sdk：本包既无 exports 也无类型，代码大量 import type 它。
  // 其余每个子路径都必须确实仍缺 .d.ts，否则 ambient 声明会遮蔽包内真实类型。
  const shouldHaveTypes = declared.filter((m) => m !== 'openclaw/plugin-sdk');
  assert.ok(shouldHaveTypes.length > 0, '前置：至少应有一个子路径 stub');

  const nowShipped: string[] = [];
  for (const modName of shouldHaveTypes) {
    const sub = modName.replace('openclaw/', '');
    const dts = join(ROOT, 'node_modules/openclaw/dist/plugin-sdk', `${sub}.d.ts`);
    try {
      readFileSync(dts);
      nowShipped.push(modName);
    } catch {
      /* 仍无 .d.ts —— 符合预期 */
    }
  }
  assert.deepEqual(
    nowShipped,
    [],
    `openclaw@${openclawPkg.version} 已开始为这些子路径发布 .d.ts：` +
      `${nowShipped.join(', ')}。\n    ambient declare module 会遮蔽包内真实类型，` +
      `typecheck 等于没验证真实 API 面——请删除对应 stub 段（AGENTS.md 约定）。`,
  );
});

// ── 4. 钉版与 peer 范围 ──

group('钉版一致性');

await test('devDependency 精确钉在 peer 范围允许的最低版本', () => {
  const pinned = repoPkg.devDependencies.openclaw;
  const peerRange = repoPkg.peerDependencies.openclaw;
  assert.ok(pinned, 'devDependencies.openclaw 应存在（typecheck 依赖它）');
  assert.equal(
    pinned,
    '2026.9.1',
    `devDependency 钉版应为基线 2026.9.1（实际 ${pinned}）。` +
      `\n    钉版语义=验证最旧受支持 API 面：改钉版前必须重新评估兼容性，` +
      `\n    并在 CHANGELOG/AGENTS.md 记录结论。`,
  );
  assert.equal(peerRange, '>=2026.9.1', `peer 范围应保持 >=2026.9.1（实际 ${peerRange}）`);
});

await test('已安装版本满足 peer 范围', () => {
  const [minVersion] = (repoPkg.peerDependencies.openclaw ?? '').replace('>=', '').split(' ');
  assert.ok(minVersion, 'peer 范围应能解析出最低版本');
  const cmp = openclawPkg.version.split('.').map(Number);
  const min = minVersion.split('.').map(Number);
  const ok = cmp[0] > min[0] || (cmp[0] === min[0] && (cmp[1] > min[1] || (cmp[1] === min[1] && cmp[2] >= min[2])));
  assert.ok(ok, `已安装 openclaw@${openclawPkg.version} 低于 peer 最低版本 ${minVersion}`);
});

// ── 汇总 ──

console.log(`\n${'='.repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);