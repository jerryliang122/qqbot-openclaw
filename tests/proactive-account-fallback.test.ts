/**
 * Issue #15 回归测试：message 工具主动发送报 `Bot "default" not running`
 *
 * 真实根因（结合上报人的实际配置——顶层 default 账号完整可运行）：
 * 框架 message 工具在部分执行上下文（后台任务 / bootstrap 兜底注册表）会经
 * jiti 二次加载产生插件的另一个模块实例。旧实现的 gateway 注册表是模块级
 * Map，第二实例的注册表为空 → getGateway("default") 恒 miss → 主动发送
 * 全部失败；而会话回复路径（dispatch → 同实例 gw）不受影响，故 journal 里
 * kind=text 持续流出、kind=image 从未出现、[tx] 网关日志一条没有。
 *
 * 三层修复：
 *   C. gateway 注册表桥接到 globalThis（Symbol.for）——所有模块实例共享一份，
 *      这是主修复；
 *   B. 发送路径 gateway 查找 miss 时：恰有一个运行中账号 → 回退并打一次 INFO
 *      （配置残影场景）；0/多个 → 错误附运行中账号列表（多账号不盲路由，
 *      OpenID 跨账号不通用）；
 *   A. resolveDefaultQQBotAccountId 只在 default 账号「可运行」时返回
 *      "default"，否则回落到第一个可运行的命名账号（顶层 appId 残留 +
 *      命名账号运行的配置形态硬化；对完整顶层配置无行为变化）。
 *
 * 运行方式: npx tsx tests/proactive-account-fallback.test.ts
 */

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.error(`✗ ${name}`);
    console.error(err instanceof Error ? err.message : err);
  }
}

const {
  resolveDefaultQQBotAccountId,
  resolveQQBotAccount,
} = await import('../src/config.ts');
const {
  registerGateway,
  unregisterGateway,
  getRegisteredAccountIds,
  sendText,
} = await import('../src/outbound/outbound-service.ts');
const { sendMedia } = await import('../src/outbound/media-send.ts');

function cleanupRegistry() {
  for (const id of getRegisteredAccountIds()) unregisterGateway(id);
}

function makeFakeGateway(calls: { sendText?: unknown[]; sendMedia?: unknown[] }) {
  return {
    sendText: async (target: unknown, text: string, opts: unknown) => {
      const id = `txt-${(calls.sendText?.length ?? 0) + 1}`;
      calls.sendText?.push({ target, text, opts });
      return { id };
    },
    sendMedia: async (target: unknown, source: string, opts: unknown) => {
      calls.sendMedia?.push({ target, source, opts });
      return { id: 'media-1' };
    },
  } as never;
}

// ── Fix C: 注册表进程级共享（主修复）──

await test('C1: 注册表挂载在 globalThis（Symbol.for），所有模块实例可见', () => {
  cleanupRegistry();
  const calls: { sendText?: unknown[] } = { sendText: [] };
  registerGateway('shared-check', makeFakeGateway(calls));
  const shared = (globalThis as Record<symbol, unknown>)[Symbol.for('openclaw-qqbot.gateways')];
  assert.ok(shared instanceof Map, 'globalThis 上应存在共享注册表 Map');
  assert.ok((shared as Map<string, unknown>).has('shared-check'));
  cleanupRegistry();
});

await test('C2: 构建产物 dist 内注册表读写同一份 globalThis Map（双实例契约）', () => {
  const distPath = path.resolve(import.meta.dirname ?? '.', '../dist/index.cjs');
  if (!fs.existsSync(distPath)) {
    console.log('  (dist/index.cjs 不存在，跳过——CI 先 build 后 test 不会走到这里)');
    return;
  }
  // tsx 的 require 钩子会干扰 dist 的嵌套依赖解析（unicorn-magic exports map），
  // 用独立 node 子进程验证产物：外部（模拟另一模块实例）往 globalThis 桥写入，
  // dist 实例的 tryGetBotForAccount 必须读到同一份注册表。
  const script = [
    `const m = require(${JSON.stringify(distPath)});`,
    `const KEY = Symbol.for('openclaw-qqbot.gateways');`,
    `const shared = globalThis[KEY];`,
    `if (!(shared instanceof Map)) throw new Error('dist artifact missing globalThis gateway bridge');`,
    `shared.set('from-other-instance', { bot: { marker: true } });`,
    `const bot = m.tryGetBotForAccount('from-other-instance');`,
    `if (!bot || bot.marker !== true) throw new Error('dist lookup did not read shared registry');`,
    `console.log('ok');`,
  ].join('\n');
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.match(out, /ok/);
});

// ── Fix B: 发送路径 gateway 单账号回退 + 可诊断错误 ──

await test('B1: 精确命中不回退（原路径不受影响）', async () => {
  cleanupRegistry();
  const calls: { sendText?: unknown[] } = { sendText: [] };
  registerGateway('live', makeFakeGateway(calls));
  const result = await sendText({
    to: 'qqbot:c2c:user1',
    text: 'hi',
    account: { accountId: 'live' } as never,
  });
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.messageId, 'txt-1');
  cleanupRegistry();
});

await test('B2: 请求 "default" 未运行 + 仅一个运行中账号 → 回退发送成功（配置残影场景）', async () => {
  cleanupRegistry();
  const calls: { sendText?: unknown[] } = { sendText: [] };
  registerGateway('102030405', makeFakeGateway(calls));
  const result = await sendText({
    to: 'qqbot:c2c:user1',
    text: 'shipment status',
    account: { accountId: 'default' } as never,
  });
  assert.strictEqual(result.error, undefined, `不应报错: ${result.error}`);
  assert.strictEqual(result.messageId, 'txt-1');
  assert.strictEqual(calls.sendText?.length, 1);
  cleanupRegistry();
});

await test('B3: media-send.sendMedia 同样单账号回退（message 工具媒体路径）', async () => {
  cleanupRegistry();
  const calls: { sendMedia?: unknown[] } = { sendMedia: [] };
  registerGateway('102030405', makeFakeGateway(calls));
  const result = await sendMedia({
    to: 'qqbot:c2c:user1',
    source: 'data:image/png;base64,iVBORw0KGgo=',
    text: 'caption',
    mediaKind: 'image',
    accountId: 'default',
  });
  assert.strictEqual(result.error, undefined, `不应报错: ${result.error}`);
  assert.strictEqual(result.messageId, 'media-1');
  assert.strictEqual(calls.sendMedia?.length, 1);
  cleanupRegistry();
});

await test('B4: 多账号运行时请求失效账号 → 不盲路由，错误附运行中账号列表', async () => {
  cleanupRegistry();
  const callsA: { sendText?: unknown[] } = { sendText: [] };
  const callsB: { sendText?: unknown[] } = { sendText: [] };
  registerGateway('bot-a', makeFakeGateway(callsA));
  registerGateway('bot-b', makeFakeGateway(callsB));
  const result = await sendText({
    to: 'qqbot:c2c:user1',
    text: 'hi',
    account: { accountId: 'default' } as never,
  });
  assert.match(result.error ?? '', /Bot "default" not running/);
  assert.match(result.error ?? '', /bot-a, bot-b/);
  assert.strictEqual(callsA.sendText?.length ?? 0, 0, '不得路由到 bot-a');
  assert.strictEqual(callsB.sendText?.length ?? 0, 0, '不得路由到 bot-b');
  cleanupRegistry();
});

await test('B5: 零账号运行 → 错误保持原语义（无运行中列表后缀）', async () => {
  cleanupRegistry();
  const result = await sendText({
    to: 'qqbot:c2c:user1',
    text: 'hi',
    account: { accountId: 'default' } as never,
  });
  assert.strictEqual(result.error, 'Bot "default" not running');
});

// ── Fix A: resolveDefaultQQBotAccountId 可运行性感知（配置残影硬化）──

await test('A1: 顶层 default 完整（appId+secret）→ default（上报人配置形态，行为不变）', () => {
  const cfg = {
    channels: {
      qqbot: {
        enabled: true,
        appId: '102914660',
        clientSecret: '***',
        allowFrom: ['U1'],
        groupAllowFrom: ['U1'],
      },
    },
  } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), 'default');
});

await test('A2: 顶层 appId 残留无凭证 + 命名账号可运行 → 命名账号', () => {
  const cfg = {
    channels: {
      qqbot: {
        appId: 'STALE',
        accounts: { '102030405': { appId: 'LIVE', clientSecret: 's' } },
      },
    },
  } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), '102030405');
});

await test('A3: 顶层 default 被禁用 + 命名账号可运行 → 命名账号', () => {
  const cfg = {
    channels: {
      qqbot: {
        appId: 'A1',
        clientSecret: 's',
        enabled: false,
        accounts: { bot2: { appId: 'A2', clientSecret: 's' } },
      },
    },
  } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), 'bot2');
});

await test('A4: 命名账号逐个跳过不可运行的（无凭证/禁用）→ 取第一个可运行', () => {
  const cfg = {
    channels: {
      qqbot: {
        appId: 'STALE',
        accounts: {
          noCred: { appId: 'B1' },
          disabled: { appId: 'B2', clientSecret: 's', enabled: false },
          live: { appId: 'B3', clientSecret: 's' },
        },
      },
    },
  } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), 'live');
});

await test('A5: 仅命名账号（无顶层 appId）→ 第一个（旧行为保持）', () => {
  const cfg = {
    channels: { qqbot: { accounts: { '102030405': { appId: 'A2', clientSecret: 's' } } } },
  } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), '102030405');
});

await test('A6: 全部不可运行 → 旧回退 default（错误指向配置根因）', () => {
  const cfg = { channels: { qqbot: { appId: 'STALE' } } } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), 'default');
});

await test('A7: 顶层 secretFile（无内联 secret）视为可运行 → default', () => {
  const cfg = { channels: { qqbot: { appId: 'A1', clientSecretFile: '/etc/qqbot/secret' } } } as never;
  assert.strictEqual(resolveDefaultQQBotAccountId(cfg), 'default');
});

await test('A8: 残影场景下 resolveQQBotAccount(cfg, undefined) 与 defaultAccountId 一致', () => {
  const cfg = {
    channels: {
      qqbot: {
        appId: 'STALE',
        accounts: { '102030405': { appId: 'LIVE', clientSecret: 's' } },
      },
    },
  } as never;
  const account = resolveQQBotAccount(cfg, undefined);
  assert.strictEqual(account.accountId, '102030405');
  assert.strictEqual(account.appId, 'LIVE');
  assert.strictEqual(
    account.accountId,
    resolveDefaultQQBotAccountId(cfg),
    'resolveQQBotAccount(undefined) 与 defaultAccountId 必须解析到同一账号',
  );
});

// ── 汇总 ──

console.log(`\n${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.error('Failed tests:');
  for (const t of failedTests) console.error(`  - ${t}`);
  process.exit(1);
}
