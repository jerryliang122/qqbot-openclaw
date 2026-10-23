/**
 * 回归测试：openclaw 10.5 通道插件契约接入（P0）
 *
 * 覆盖三件事：
 *  1. `messaging.inferTargetChatType` —— 宿主做隐式 owner 心跳投递依赖这个
 *     直接分类；缺失时 Gateway 状态一直报 `waiting for route`。
 *  2. `config.inspectAccount` —— 只读账户巡检（不 materialize 运行期凭据）。
 *  3. `clientSecretFile` —— 此前「声明了但从不读取」，账号被选为默认却起不来。
 */
import { strict as assert } from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferQQBotChatType } from '../src/outbound/target.js';
import { qqbotMessagingAdapter } from '../src/messaging-adapter.js';
import {
  applyQQBotAccountConfig,
  inspectQQBotAccount,
  materializeQQBotAccountSecret,
  resolveQQBotAccount,
} from '../src/config.js';
import { qqbotPlugin } from '../src/channel.js';

/**
 * 缺凭据时 `inspectAccount` 应上报的 secretStatus。
 *
 * 取决于**本机是否留有真实凭据备份**
 * （~/.openclaw/qqbot/data/credential-backup/current.json，路径全局固定）：
 *   没有备份 → missing（未配置任何凭据来源）
 *   有备份   → configured_unavailable（已配置、但只读巡检路径不 materialize）
 * 两者语义一致（都表示「当前路径取不到凭据」），故按环境取值断言，而不是硬编码
 * 'missing' —— 否则在装过真实凭据的机器上必然红。
 */
function expectedSecretStatus(): 'missing' | 'configured_unavailable' {
  const backupFile = path.join(
    os.homedir(), '.openclaw', 'qqbot', 'data', 'credential-backup', 'current.json',
  );
  return fs.existsSync(backupFile) ? 'configured_unavailable' : 'missing';
}

function test(name: string, fn: () => void) {  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

// ── 1. inferTargetChatType ──

test('inferTargetChatType：c2c 前缀 → direct', () => {
  assert.strictEqual(inferQQBotChatType('qqbot:c2c:ABC123'), 'direct');
  assert.strictEqual(inferQQBotChatType('c2c:ABC123'), 'direct');
});

test('inferTargetChatType：group 前缀 → group', () => {
  assert.strictEqual(inferQQBotChatType('qqbot:group:GID456'), 'group');
  assert.strictEqual(inferQQBotChatType('group:GID456'), 'group');
});

test('inferTargetChatType：裸 openid → direct', () => {
  const hex = 'a'.repeat(32);
  assert.strictEqual(inferQQBotChatType(hex), 'direct');
  assert.strictEqual(inferQQBotChatType(`qqbot:${hex}`), 'direct');
});

test('inferTargetChatType：无法判定时返回 undefined（不猜）', () => {
  assert.strictEqual(inferQQBotChatType(''), undefined);
  assert.strictEqual(inferQQBotChatType('qqbot:c2c:'), undefined);
  assert.strictEqual(inferQQBotChatType('qqbot:group:'), undefined);
  assert.strictEqual(inferQQBotChatType('not-a-target'), undefined);
  assert.strictEqual(inferQQBotChatType('qqbot:channel:CH1'), undefined);
});

test('messaging adapter 暴露 inferTargetChatType', () => {
  const fn = (qqbotMessagingAdapter as unknown as {
    inferTargetChatType?: (p: { to: string }) => string | undefined;
  }).inferTargetChatType;
  assert.strictEqual(typeof fn, 'function');
  assert.strictEqual(fn!({ to: 'qqbot:c2c:X' }), 'direct');
  assert.strictEqual(fn!({ to: 'qqbot:group:Y' }), 'group');
});

// ── 2. inspectAccount ──

test('inspectAccount：已配置账号上报 available', () => {
  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecret: 'SECRET' } },
  } as never;
  const inspection = inspectQQBotAccount(cfg, undefined);
  assert.strictEqual(inspection.accountId, 'default');
  assert.strictEqual(inspection.configured, true);
  assert.strictEqual(inspection.appIdStatus, 'available');
  assert.strictEqual(inspection.appIdSource, 'config');
  assert.strictEqual(inspection.secretStatus, 'available');
  assert.strictEqual(inspection.secretSource, 'config');
});

test('inspectAccount：缺凭据上报 missing 且不抛错', () => {
  const cfg = { channels: { qqbot: {} } } as never;
  const inspection = inspectQQBotAccount(cfg, undefined);
  assert.strictEqual(inspection.configured, false);
  assert.strictEqual(inspection.appIdStatus, 'missing');
  assert.strictEqual(inspection.secretStatus, expectedSecretStatus());
  assert.strictEqual(inspection.appIdSource, 'none');
});

test('inspectAccount：命名账号单独巡检', () => {
  const cfg = {
    channels: {
      qqbot: {
        appId: 'DEFAULT_APP',
        clientSecret: 'DEFAULT_SECRET',
        accounts: { alt: { appId: 'ALT_APP', clientSecret: 'ALT_SECRET', name: '备用' } },
      },
    },
  } as never;
  const inspection = inspectQQBotAccount(cfg, 'alt');
  assert.strictEqual(inspection.accountId, 'alt');
  assert.strictEqual(inspection.name, '备用');
  assert.strictEqual(inspection.configured, true);
});

test('inspectAccount：插件已挂载该只读面（且真的返回巡检结果）', () => {
  const cfgAdapter = (qqbotPlugin as unknown as {
    config?: { inspectAccount?: (cfg: unknown, accountId?: string | null) => unknown };
  }).config;
  assert.strictEqual(typeof cfgAdapter?.inspectAccount, 'function');

  // 不能只断言「是个函数」——空壳函数也会通过，宿主却拿不到巡检结果。
  // 这里真的调一次，断言拿回来的就是巡检结果。
  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecret: 'SECRET' } },
  } as never;
  const result = cfgAdapter!.inspectAccount!(cfg, undefined) as {
    accountId?: string;
    configured?: boolean;
    appIdStatus?: string;
    secretStatus?: string;
  };
  assert.strictEqual(result?.accountId, 'default');
  assert.strictEqual(result?.configured, true);
  assert.strictEqual(result?.appIdStatus, 'available');
  assert.strictEqual(result?.secretStatus, 'available');

  // 缺凭据时也不能抛错，且要如实上报
  const missing = cfgAdapter!.inspectAccount!({ channels: { qqbot: {} } } as never, undefined) as {
    configured?: boolean;
    secretStatus?: string;
  };
  assert.strictEqual(missing?.configured, false);
  // 同上：secretStatus 按本机是否留有真实凭据备份取值（missing / configured_unavailable）
  assert.strictEqual(missing?.secretStatus, expectedSecretStatus());
});

// ── 3. clientSecretFile ──

test('clientSecretFile：resolveQQBotAccount 不读盘（热路径无阻塞 I/O）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-secret-'));
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'FILE_SECRET\n');

  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecretFile: file } },
  } as never;

  const account = resolveQQBotAccount(cfg, undefined);
  // 解析阶段只标记来源，不读盘
  assert.strictEqual(account.clientSecret, '');
  assert.strictEqual(account.secretSource, 'file');
  assert.strictEqual(account.clientSecretFile, file);

  // 读盘只发生在账号启动时（materializeQQBotAccountSecret）
  const materialized = materializeQQBotAccountSecret(account);
  assert.strictEqual(materialized.clientSecret, 'FILE_SECRET');
  assert.strictEqual(materialized.secretSource, 'file');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clientSecretFile：巡检不读盘、不materialize凭据', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-secret-'));
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'FILE_SECRET\n');

  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecretFile: file } },
  } as never;

  const inspection = inspectQQBotAccount(cfg, undefined);
  // 来源已配置 → 已配置；但只读路径不materialize → configured_unavailable
  assert.strictEqual(inspection.configured, true);
  assert.strictEqual(inspection.secretSource, 'file');
  assert.strictEqual(inspection.secretStatus, 'configured_unavailable');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clientSecretFile：文件缺失时按不可用处理（不抛错）', () => {
  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecretFile: '/nonexistent/qqbot-secret' } },
  } as never;
  const account = resolveQQBotAccount(cfg, undefined);
  assert.strictEqual(account.clientSecret, '');
  assert.strictEqual(account.secretSource, 'file');

  // 启动时materialize读不到 → 账号保持无凭据，走备份恢复/报错路径
  assert.strictEqual(materializeQQBotAccountSecret(account).clientSecret, '');

  const inspection = inspectQQBotAccount(cfg, undefined);
  assert.strictEqual(inspection.secretStatus, 'configured_unavailable');
  assert.strictEqual(inspection.configured, true);
});

test('凭据互斥：写入文件凭据会清掉内联密钥（反之亦然）', () => {
  const base = {
    channels: { qqbot: { appId: 'APP1', clientSecret: 'OLD_INLINE' } },
  } as never;

  // 写文件 → 内联被清
  const withFile = applyQQBotAccountConfig(base, 'default', {
    appId: 'APP1',
    clientSecretFile: '/etc/qqbot.secret',
  });
  const qqbot = withFile.channels?.qqbot as Record<string, unknown>;
  assert.strictEqual(qqbot.clientSecret, undefined);
  assert.strictEqual(qqbot.clientSecretFile, '/etc/qqbot.secret');

  // 写内联 → 文件被清
  const withInline = applyQQBotAccountConfig(
    { channels: { qqbot: { appId: 'APP1', clientSecretFile: '/etc/qqbot.secret' } } } as never,
    'default',
    { appId: 'APP1', clientSecret: 'NEW_INLINE' },
  );
  const qqbot2 = withInline.channels?.qqbot as Record<string, unknown>;
  assert.strictEqual(qqbot2.clientSecret, 'NEW_INLINE');
  assert.strictEqual(qqbot2.clientSecretFile, undefined);
});

// ── 4. capabilities 完整性 ──

test('capabilities：声明 TTS 语音气泡能力', () => {
  const caps = (qqbotPlugin as unknown as {
    capabilities?: { tts?: { voice?: Record<string, unknown> }; media?: boolean };
  }).capabilities;
  assert.ok(caps?.tts?.voice, '必须声明 capabilities.tts.voice');
  assert.strictEqual(caps!.tts!.voice!.synthesisTarget, 'voice-note');
  assert.strictEqual(caps!.tts!.voice!.transcodesAudio, true);
  assert.strictEqual(caps!.tts!.voice!.captionedFinalText, false);
  assert.strictEqual(caps?.media, true);
});
