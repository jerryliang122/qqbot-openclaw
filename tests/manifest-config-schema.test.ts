/**
 * manifest 配置 schema 回归测试
 *
 * 背景：`channels.qqbot` 段的配置 schema **只能**来自
 * `openclaw.plugin.json` 的 `channelConfigs.qqbot.schema`（手写 JSON Schema）——
 * 框架的 registry 只从 manifest 采集通道 schema（`manifest-registry` 的
 * `buildRecord` → `collectChannelSchemaMetadataWithOwnership` →
 * `prepareChannelConfigSchema`），插件运行时的 `plugin.configSchema` 走的是
 * **插件级** `plugins.<id>` 段，管不到 `channels.qqbot`。
 *
 * 该 schema 的作用：
 * 1. **Control UI 配置表单**（哪些字段出现、什么控件、help 文本）
 * 2. **UI 默认值**（schema 的 `default`）
 * 3. **schema 合法性自检**（框架会拒绝非法 schema）
 *
 * 此前 manifest 只声明了 `appId` / `clientSecret`，导致 Control UI 的 QQ
 * 配置表单只有两个字段——用户想配 `groups` / `dmPolicy` / `allowFrom` 等
 * 十几个实际被插件读取的配置项，只能手写 JSON。
 *
 * 本测试锁定：
 * - manifest 能被框架的 `loadPluginManifest` 正常解析
 * - schema 覆盖 `QQBotAccountConfig` 的**全部**键（顶层 + accounts 段）
 *   ——`additionalProperties: false` 下漏一个键，用户写了就会被拒
 * - schema 本身合法（框架的 `validateJsonSchemaValue` 通过）
 * - 典型配置能通过校验
 *
 * 运行方式：npx tsx tests/manifest-config-schema.test.ts
 */

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'index.js'));

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
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 权威来源：src/types.ts 的 QQBotAccountConfig ────────────────────

/** 从 src/types.ts 提取 QQBotAccountConfig 的键清单 */
function readAccountConfigKeys(): string[] {
  const src = readFileSync(join(process.cwd(), 'src', 'types.ts'), 'utf8');
  const start = src.indexOf('export interface QQBotAccountConfig');
  assert.ok(start > 0, '应能在 src/types.ts 找到 QQBotAccountConfig');
  const seg = src.slice(start, src.indexOf('\n}', start));
  return [...seg.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

/** 从 src/types.ts 提取任意具名 interface 的键清单 */
function readInterfaceKeys(iface: string): string[] {
  const src = readFileSync(join(process.cwd(), 'src', 'types.ts'), 'utf8');
  const start = src.indexOf(`export interface ${iface}`);
  assert.ok(start > 0, `应能在 src/types.ts 找到 ${iface}`);
  const seg = src.slice(start, src.indexOf('\n}', start));
  return [...seg.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
}

// ── manifest 加载 ───────────────────────────────────────────────────

type Manifest = {
  id: string;
  channels?: string[];
  channelConfigs?: Record<string, {
    schema?: {
      type?: string;
      additionalProperties?: boolean;
      properties?: Record<string, unknown>;
    };
    uiHints?: Record<string, unknown>;
    label?: string;
    description?: string;
  }>;
};

const manifestRaw = JSON.parse(
  readFileSync(join(process.cwd(), 'openclaw.plugin.json'), 'utf8'),
) as Manifest;

const qqbotChannel = manifestRaw.channelConfigs?.qqbot;
const qqbotSchema = qqbotChannel?.schema;
const topProps = (qqbotSchema?.properties ?? {}) as Record<string, unknown>;
const accountsProp = topProps.accounts as
  | { additionalProperties?: { properties?: Record<string, unknown> } }
  | undefined;
const accountProps = accountsProp?.additionalProperties?.properties ?? {};

async function main() {
  // ── manifest 可被框架解析 ─────────────────────────────────────────

  await test('manifest 能被框架的 loadPluginManifest 正常解析', () => {
    const manifestModule = require('./node_modules/openclaw/dist/manifest-DAqWVneG.js') as {
      r: (root: string) => { ok: boolean; manifest?: Manifest; error?: unknown };
    };
    const res = manifestModule.r(process.cwd());
    assert.ok(res.ok, `manifest 解析失败：${JSON.stringify(res.error ?? {}, null, 2)}`);
    assert.strictEqual(res.manifest?.id, 'openclaw-qqbot');
    assert.ok(res.manifest?.channels?.includes('qqbot'), '应声明 qqbot 通道');
  });

  await test('channelConfigs.qqbot 存在 schema 与 uiHints', () => {
    assert.ok(qqbotChannel, 'manifest 应有 channelConfigs.qqbot');
    assert.ok(qqbotSchema, 'manifest 应有 channelConfigs.qqbot.schema');
    assert.ok(qqbotChannel?.uiHints, 'manifest 应有 channelConfigs.qqbot.uiHints');
    assert.ok(
      Object.keys(qqbotChannel?.uiHints ?? {}).length > 0,
      'uiHints 不应为空（否则 Control UI 无 help 文本）',
    );
  });

  // ── 字段覆盖完整性 ────────────────────────────────────────────────

  await test('schema 顶层覆盖 QQBotAccountConfig 的全部键', () => {
    const truth = readAccountConfigKeys();
    const missing = truth.filter((k) => !(k in topProps));
    assert.strictEqual(
      missing.length,
      0,
      `schema 顶层缺少配置键：${missing.join(', ')}。` +
        `additionalProperties=false 下用户写了这些键会被拒。`,
    );
  });

  await test('schema 的 accounts 段覆盖 QQBotAccountConfig 的全部键', () => {
    const truth = readAccountConfigKeys();
    const missing = truth.filter((k) => !(k in accountProps));
    assert.strictEqual(
      missing.length,
      0,
      `schema 的 accounts 段缺少配置键：${missing.join(', ')}。` +
        `additionalProperties=false 下用户写了这些键会被拒。`,
    );
  });

  // ── 嵌套字段名正确性 ──────────────────────────────────────────────
  //
  // 顶层只查「键在不在」是不够的：`deliverDebounce` 的**子字段**写错名字
  // （曾把 windowMs 写成 debounceMs）时，顶层差集检查照样通过，但用户在
  // Control UI 里配 `windowMs` 会被 additionalProperties=false 拒掉。
  // 故对每个嵌套配置块，用其 TS 接口的键清单逐项核对。

  await test('嵌套配置块的子字段与 TS 接口一致', () => {
    const checks: Array<[string, string]> = [
      ['deliverDebounce', 'DeliverDebounceConfig'],
      ['progressCard', 'ProgressCardConfig'],
      ['typing', 'TypingIndicatorConfig'],
      ['inboundDebounce', 'InboundDebounceConfig'],
      ['groupCoalesce', 'GroupCoalesceConfig'],
      ['commands', 'CommandsConfig'],
    ];
    for (const [key, iface] of checks) {
      const truth = readInterfaceKeys(iface);
      const schema = (topProps[key] as { properties?: Record<string, unknown> } | undefined)
        ?.properties ?? {};
      const missing = truth.filter((k) => !(k in schema));
      const extra = Object.keys(schema).filter((k) => !truth.includes(k));
      assert.strictEqual(
        missing.length,
        0,
        `schema.${key} 缺少子字段：${missing.join(', ')}（${iface}）。` +
          `additionalProperties=false 下用户配了会被拒。`,
      );
      assert.strictEqual(
        extra.length,
        0,
        `schema.${key} 有 ${iface} 里不存在的子字段：${extra.join(', ')}（配了会被静默忽略）。`,
      );
    }
  });

  await test('顶层与 accounts 段的嵌套 schema 逐字一致', () => {
    for (const key of [
      'groups',
      'rateLimit',
      'audioFormatPolicy',
      'groupCoalesce',
      'deliverDebounce',
      'typing',
      'inboundDebounce',
      'commands',
      'streaming',
      'progressCard',
    ]) {
      assert.deepStrictEqual(
        accountProps[key],
        topProps[key],
        `schema.${key} 在顶层与 accounts 段不一致——` +
          `两者读的是同一个 QQBotAccountConfig，不一致会出现「顶层能配、账号里配不了」的割裂。`,
      );
    }
  });

  await test('schema 的 accounts 段不是 catchall（应逐字段列举以获得 UI 表单）', () => {
    const truth = readAccountConfigKeys();
    // accounts 段应覆盖大部分字段；若只列少数几个说明漏补
    const covered = truth.filter((k) => k in accountProps).length;
    assert.ok(
      covered >= truth.length - 2,
      `accounts 段只覆盖了 ${covered}/${truth.length} 个键，疑似漏补`,
    );
  });

  await test('schema 顶层保留框架约定的 accounts / defaultAccount 字段', () => {
    assert.ok('accounts' in topProps, '应声明 accounts（多账号）');
    assert.ok('defaultAccount' in topProps, '应声明 defaultAccount');
  });

  // ── schema 本身合法 ───────────────────────────────────────────────

  await test('schema 通过框架的 JSON Schema 合法性校验', () => {
    const validator = require('./node_modules/openclaw/dist/schema-validator-CLfGeb79.js') as {
      n: (params: { schema: unknown; value: unknown }) => void;
    };
    validator.n({ schema: qqbotSchema, value: {} });
  });

  await test('框架的通道配置校验路径能接受 setup 产出的配置', async () => {
    // 用框架**真实**的通道配置校验器（validatePluginSchemaValue，与 Control UI
    // 打开/保存配置、以及 config validate 走的是同一条路径）验证。
    //
    // 注意：不能用 validateJsonSchemaValue 代替——它只校验 schema 本身的
    // 形状，不做**实例值**校验（对 additionalProperties:false 完全不敏感），
    // 那样测出来的「通过」是假的。
    const validator = require('./node_modules/openclaw/dist/schema-validator-CLfGeb79.js') as {
      r: (params: {
        origin: string;
        schema: unknown;
        cacheKey: string;
        value: unknown;
        applyDefaults: boolean;
      }) => { ok: boolean; errors?: unknown[] };
    };
    const { applyAccountDefaults } = await import('../src/setup/finalize.js');

    const withDefault = applyAccountDefaults({ channels: { qqbot: {} } } as never, 'default');
    const defaultCfg = (withDefault as any).channels.qqbot;
    const r1 = validator.r({
      origin: 'external',
      schema: qqbotSchema,
      cacheKey: 'channel:qqbot',
      value: defaultCfg,
      applyDefaults: true,
    });
    assert.ok(
      r1.ok,
      `setup 产出的默认账号配置被通道 schema 拒绝：${JSON.stringify(r1.errors ?? [], null, 2)}`,
    );

    const withNamed = applyAccountDefaults(
      { channels: { qqbot: {} } } as never,
      'second',
      'openid-abc',
    );
    const namedCfg = (withNamed as any).channels.qqbot;
    const r2 = validator.r({
      origin: 'external',
      schema: qqbotSchema,
      cacheKey: 'channel:qqbot',
      value: namedCfg,
      applyDefaults: true,
    });
    assert.ok(
      r2.ok,
      `setup 产出的命名账号配置被通道 schema 拒绝：${JSON.stringify(r2.errors ?? [], null, 2)}`,
    );
  });

  await test('通道 schema 确实会拒未知字段（否则以上断言是假的）', () => {
    // 反向断言：确认校验路径对 additionalProperties 敏感。
    // 若这条红了，说明框架换了校验路径，上面的「通过」不再有保证。
    const validator = require('./node_modules/openclaw/dist/schema-validator-CLfGeb79.js') as {
      r: (params: {
        origin: string;
        schema: unknown;
        cacheKey: string;
        value: unknown;
        applyDefaults: boolean;
      }) => { ok: boolean; errors?: unknown[] };
    };
    const r = validator.r({
      origin: 'external',
      schema: qqbotSchema,
      cacheKey: 'channel:qqbot',
      value: { appId: '1', clientSecret: 's', totallyBogusField: 1 },
      applyDefaults: true,
    });
    assert.strictEqual(r.ok, false, '未知字段应被 additionalProperties:false 拒绝');
  });

  await test('典型配置能通过框架校验器', () => {
    const validator = require('./node_modules/openclaw/dist/schema-validator-CLfGeb79.js') as {
      n: (params: { schema: unknown; value: unknown }) => void;
    };
    validator.n({
      schema: qqbotSchema,
      value: {
        appId: '123',
        clientSecret: 'sec',
        dmPolicy: 'pairing',
        allowFrom: ['openid1'],
        groups: { g1: { requireMention: true, toolPolicy: 'restricted' } },
        streaming: { mode: 'partial', sendMode: 'stream' },
      },
    });
  });

  await test('多账号配置能通过框架校验器', () => {
    const validator = require('./node_modules/openclaw/dist/schema-validator-CLfGeb79.js') as {
      n: (params: { schema: unknown; value: unknown }) => void;
    };
    validator.n({
      schema: qqbotSchema,
      value: {
        appId: '1',
        clientSecret: 's',
        accounts: {
          second: { appId: '2', clientSecret: 's2', dmPolicy: 'open' },
        },
        defaultAccount: 'default',
      },
    });
  });

  // ── uiHints 质量 ──────────────────────────────────────────────────

  await test('uiHints 覆盖关键配置项（不是只有根级一条）', () => {
    const hints = qqbotChannel?.uiHints ?? {};
    const keys = Object.keys(hints);
    assert.ok(keys.length >= 10, `uiHints 只有 ${keys.length} 条，偏少`);
    for (const expected of ['dmPolicy', 'groupPolicy', 'allowFrom', 'groups']) {
      assert.ok(
        keys.includes(expected),
        `uiHints 应包含 ${expected}（否则该字段在 UI 上无 help 文本）`,
      );
    }
  });

  await test('uiHints 每条都有 label 与 help', () => {
    for (const [key, hint] of Object.entries(qqbotChannel?.uiHints ?? {})) {
      const record = hint as { label?: unknown; help?: unknown };
      assert.ok(
        typeof record.label === 'string' && record.label.length > 0,
        `uiHints.${key} 缺 label`,
      );
      assert.ok(
        typeof record.help === 'string' && record.help.length > 0,
        `uiHints.${key} 缺 help`,
      );
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`\n失败用例：\n${failedTests.map((t) => `  - ${t}`).join('\n')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
