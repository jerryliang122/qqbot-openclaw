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
import { inspectQQBotAccount, resolveQQBotAccount } from '../src/config.js';
import { qqbotPlugin } from '../src/channel.js';

function test(name: string, fn: () => void) {
  try {
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
  assert.strictEqual(inspection.secretStatus, 'missing');
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

test('inspectAccount：插件已挂载该只读面', () => {
  const cfgAdapter = (qqbotPlugin as unknown as {
    config?: { inspectAccount?: (cfg: unknown, accountId?: string | null) => unknown };
  }).config;
  assert.strictEqual(typeof cfgAdapter?.inspectAccount, 'function');
});

// ── 3. clientSecretFile ──

test('clientSecretFile：真的被读取（此前只标记来源、从不读盘）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-secret-'));
  const file = path.join(dir, 'secret.txt');
  fs.writeFileSync(file, 'FILE_SECRET\n');

  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecretFile: file } },
  } as never;

  const account = resolveQQBotAccount(cfg, undefined);
  assert.strictEqual(account.clientSecret, 'FILE_SECRET', '必须真正读出文件内容');
  assert.strictEqual(account.secretSource, 'file');

  const inspection = inspectQQBotAccount(cfg, undefined);
  assert.strictEqual(inspection.secretStatus, 'available');
  assert.strictEqual(inspection.configured, true);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('clientSecretFile：文件不存在时按不可用处理（不抛错）', () => {
  const cfg = {
    channels: { qqbot: { appId: 'APP1', clientSecretFile: '/nonexistent/qqbot-secret' } },
  } as never;
  const account = resolveQQBotAccount(cfg, undefined);
  assert.strictEqual(account.clientSecret, '');
  assert.strictEqual(account.secretSource, 'file');

  const inspection = inspectQQBotAccount(cfg, undefined);
  // 文件路径已配置但当前路径拿不到 → configured_unavailable
  assert.strictEqual(inspection.secretStatus, 'configured_unavailable');
  assert.strictEqual(inspection.configured, true);
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
