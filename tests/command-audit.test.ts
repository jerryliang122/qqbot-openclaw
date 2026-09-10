/**
 * 命令审计包装（buildCommandList 的 withAudit）单元测试
 *
 * 覆盖：
 * - 包装后命令数量与名称不变（11 个内置命令全部注册）
 * - handler 正常执行且返回值透传，同时打 [cmd] INFO（命令/sender/scope/raw）
 * - raw 截断到 80 字符
 * - authorized 通过时不打 WARN、返回值透传（true）
 * - authorized 拒绝时打 [cmd] unauthorized WARN 且拒绝原因（字符串）原样返回
 * - ctx.log 缺失 warn/debug 方法（SDK Logger 可选方法）时不抛错
 */
import { strict as assert } from 'node:assert';
import { buildCommandList, withAudit } from '../src/commands/index.js';
import type { ResolvedQQBotAccount } from '../src/types.js';
import type { SlashCommand, SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

function test(name: string, fn: () => void | Promise<void>) {
  Promise.resolve(fn()).then(
    () => console.log(`  ✅ ${name}`),
    (err) => {
      console.error(`  ❌ ${name}`);
      console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}

const fakeAccount = {
  accountId: 'default',
  enabled: true,
  appId: '10' + '0'.repeat(8),
  clientSecret: 'test-secret',
  secretSource: 'config',
  markdownSupport: true,
  commandPanelNative: false,
  userAgentSuffix: '',
  config: {},
} as unknown as ResolvedQQBotAccount;

interface Captured {
  info: string[];
  warn: string[];
}

function makeCtx(overrides?: {
  commandRaw?: string;
  policy?: Record<string, unknown>;
  logShape?: 'full' | 'debug-only';
}): { ctx: SlashCommandHandlerContext; captured: Captured } {
  const captured: Captured = { info: [], warn: [] };
  const log: Record<string, unknown> =
    overrides?.logShape === 'debug-only'
      ? { debug: () => {} } // SDK Logger 的 warn/debug 是可选方法
      : {
          info: (m: string) => captured.info.push(m),
          warn: (m: string) => captured.warn.push(m),
          error: () => {},
          debug: () => {},
        };
  const ctx = {
    message: { senderId: 'USER_OPENID_1', kind: 'c2c', groupOpenid: undefined },
    command: { name: 'bot-me', args: [], raw: overrides?.commandRaw ?? '/bot-me' },
    state: { policy: overrides?.policy ?? { c2cMode: 'open', allowFrom: [] } },
    receivedAt: Date.now(),
    log,
  } as unknown as SlashCommandHandlerContext;
  return { ctx, captured };
}

const commands: SlashCommand[] = buildCommandList(fakeAccount, { getRuntime: () => ({}) as never });
const byName = (name: string): SlashCommand | undefined =>
  commands.find((c) => (Array.isArray(c.name) ? c.name.includes(name) : c.name === name));

console.log('\n=== command-audit（withAudit 包装）===');

test('全部 11 个内置命令注册且名称不变', () => {
  const expected = [
    'bot-help', 'bot-ping', 'bot-version', 'bot-me', 'bot-logs', 'bot-streaming',
    'bot-clear-storage', 'bot-approve', 'bot-group-always', 'bot-group-info', 'bot-pairing',
  ];
  for (const name of expected) {
    assert.ok(byName(name), `命令 ${name} 应已注册`);
  }
  assert.equal(commands.length, expected.length);
});

test('handler 返回值透传 + [cmd] INFO 含命令/sender/scope/raw', async () => {
  const botMe = byName('bot-me')!;
  const { ctx, captured } = makeCtx();
  const result = await botMe.handler(ctx);
  assert.match(String(result), /USER_OPENID_1/);
  assert.equal(captured.info.length, 1);
  assert.match(captured.info[0], /\[cmd\] bot-me sender=USER_OPENID_1 scope=c2c raw="\/bot-me"/);
});

test('raw 截断到 80 字符', async () => {
  const botMe = byName('bot-me')!;
  const longRaw = '/bot-me ' + 'x'.repeat(200);
  const { ctx, captured } = makeCtx({ commandRaw: longRaw });
  await botMe.handler(ctx);
  const line = captured.info[0];
  const rawPart = line.match(/raw="([^"]*)"/)?.[1] ?? '';
  assert.equal(rawPart.length, 80);
});

test('authorized 通过：无 WARN、verdict 透传', () => {
  const botStreaming = byName('bot-streaming')!;
  assert.ok(botStreaming.authorized, 'bot-streaming 应带 authorized');
  const { ctx, captured } = makeCtx({ policy: { c2cMode: 'open', allowFrom: [] } });
  const verdict = botStreaming.authorized!(ctx);
  assert.equal(verdict, true);
  assert.equal(captured.warn.length, 0);
});

test('authorized 拒绝：[cmd] unauthorized WARN、拒绝原因透传', () => {
  const botStreaming = byName('bot-streaming')!;
  const { ctx, captured } = makeCtx({ policy: { c2cMode: 'allowlist', allowFrom: ['OTHER_USER'] } });
  const verdict = botStreaming.authorized!(ctx);
  assert.equal(verdict, '⚠️ 无权限执行此命令');
  assert.equal(captured.warn.length, 1);
  assert.match(captured.warn[0], /\[cmd\] unauthorized bot-streaming sender=USER_OPENID_1/);
});

test('ctx.log 仅有 debug 方法（SDK 可选方法形态）时不抛错', async () => {
  const botMe = byName('bot-me')!;
  const { ctx } = makeCtx({ logShape: 'debug-only' });
  const result = await botMe.handler(ctx);
  assert.match(String(result), /USER_OPENID_1/);
});

test('别名形态（name 为数组）打 join 后的名称', async () => {
  const wrapped = withAudit({
    name: ['cmd-a', 'cmd-b'],
    handler: async () => 'ok',
  });
  const { ctx, captured } = makeCtx({ commandRaw: '/cmd-a hi' });
  const result = await wrapped.handler(ctx);
  assert.equal(result, 'ok');
  assert.match(captured.info[0], /\[cmd\] cmd-a\|cmd-b sender=/);
});
