import { strict as assert } from 'assert';
import {
  selectEssentialCommands,
  syncAccountCommandPanels,
  syncCommandPanels,
  clearCommandPanelSynced,
  type CommandPanelApi,
  type CommandPanelItem,
} from '../src/features/command-panel.js';
import { registerGateway, unregisterGateway } from '../src/outbound/outbound-service.js';
import type { ResolvedQQBotAccount } from '../src/types.js';

function test(name: string, fn: () => Promise<void> | void) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(() => console.log(`✓ ${name}`)).catch((err) => {
        console.error(`✗ ${name}`);
        throw err;
      });
    }
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

// ── fixtures ──

interface RecordedCall {
  method: 'get' | 'post' | 'put' | 'delete';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
}

function makeFakeApi(existingPanels: unknown, opts?: { failGet?: Error }) {
  const calls: RecordedCall[] = [];
  const api: CommandPanelApi = {
    get: async (path: string, query?: Record<string, string | number | boolean>) => {
      calls.push({ method: 'get', path, query });
      if (opts?.failGet) throw opts.failGet;
      return existingPanels;
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, body });
      return { panel_id: `p_new_${calls.length}` };
    },
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'put', path, body });
      return {};
    },
    delete: async (path: string) => {
      calls.push({ method: 'delete', path });
      return {};
    },
  };
  return { api, calls };
}

const ITEMS: CommandPanelItem[] = [
  { type: 'command', name: '/new', desc: '开始新会话' },
  { type: 'command', name: '/compact', desc: '压缩上下文' },
];

function makeAccount(overrides?: Partial<ResolvedQQBotAccount>): ResolvedQQBotAccount {
  return {
    accountId: 'test-panel-account',
    enabled: true,
    appId: '123456',
    clientSecret: 'test-secret',
    secretSource: 'config',
    markdownSupport: true,
    commandPanelNative: true,
    userAgentSuffix: '',
    config: {},
    ...overrides,
  };
}

function installFakeGateway(api: CommandPanelApi, accountId: string): void {
  registerGateway(accountId, { bot: { api } } as never);
}

// ── selectEssentialCommands 纯函数 ──

await test('selectEssentialCommands: 只保留 essential、丢弃 isAlias 与超长 name、desc 截断', () => {
  const specs = [
    { name: 'new', description: '开始新会话', acceptsArgs: true },
    { name: 'side', description: '别名', acceptsArgs: true, isAlias: true },
    { name: 'verbose', description: 'standard 指令', acceptsArgs: true },
    { name: 'export-trajectory', description: '超长指令名', acceptsArgs: true },
    {
      name: 'status',
      description:
        '这是一个非常长的描述文本需要被截断到三十个字符以内这是一个非常长的描述文本需要被截断到三十个字符以内',
      acceptsArgs: true,
    },
  ];
  const items = selectEssentialCommands(
    specs,
    (name) => (name === 'new' || name === 'export-trajectory' || name === 'status' ? 'essential' : 'standard'),
  );
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], { type: 'command', name: '/new', desc: '开始新会话' });
  assert.equal(items[1].name, '/status');
  assert.equal(items[1].desc.length, 30);
});

await test('selectEssentialCommands: 封顶 20 项', () => {
  const specs = Array.from({ length: 30 }, (_, i) => ({
    name: `cmd${i}`,
    description: `d${i}`,
    acceptsArgs: false,
  }));
  const items = selectEssentialCommands(specs, () => 'essential');
  assert.equal(items.length, 20);
});

// ── syncAccountCommandPanels 同步核心 ──

await test('sync: GET 必带 scope 查询参数（缺參会被服务端 40030011 拒绝）', async () => {
  const { api, calls } = makeFakeApi({ records: [], next_cursor: '', is_end: true });
  await syncAccountCommandPanels(api, ITEMS);
  const gets = calls.filter((c) => c.method === 'get');
  assert.equal(gets.length, 2);
  assert.deepEqual(
    gets.map((g) => g.query?.scope).sort(),
    ['c2c', 'group'],
  );
  for (const g of gets) assert.equal(g.path, '/v2/panels');
});

await test('sync: 官方 records 响应形状 + next_cursor 翻页直到 is_end', async () => {
  const calls: RecordedCall[] = [];
  const firstPage = {
    records: [{ panel_id: 'p1', panel: { remark: 'openclaw-qqbot:auto:c2c' } }],
    next_cursor: 'cursor-2',
    is_end: false,
  };
  const lastPage = { records: [], next_cursor: '', is_end: true };
  const api: CommandPanelApi = {
    get: async (path: string, query?: Record<string, string | number | boolean>) => {
      calls.push({ method: 'get', path, query });
      if (query?.scope === 'group') return lastPage; // group 无面板，首页即末页
      return query?.cursor ? lastPage : firstPage;
    },
    post: async (path: string, body?: unknown) => {
      calls.push({ method: 'post', path, body });
      return { panel_id: 'p_new' };
    },
    put: async (path: string, body?: unknown) => {
      calls.push({ method: 'put', path, body });
      return {};
    },
    delete: async (path: string) => {
      calls.push({ method: 'delete', path });
      return {};
    },
  };
  const results = await syncAccountCommandPanels(api, ITEMS);
  // c2c：首页命中自家面板（翻页后无新增）→ PUT；group：无面板 → POST
  assert.ok(results.some((r) => r.scope === 'c2c' && r.action === 'updated'));
  assert.ok(results.some((r) => r.scope === 'group' && r.action === 'created'));
  // c2c 翻了一页（带 cursor），group 首页即 is_end 不翻页
  const cursored = calls.filter((c) => c.method === 'get' && c.query?.cursor);
  assert.equal(cursored.length, 1);
  assert.equal(cursored[0]?.query?.scope, 'c2c');
});

await test('sync: 无自家面板 → 每个 scope POST 创建', async () => {
  const { api, calls } = makeFakeApi({ panels: [] });
  const results = await syncAccountCommandPanels(api, ITEMS);
  assert.equal(results.length, 2);
  assert.deepEqual(
    results.map((r) => `${r.scope}:${r.action}`),
    ['c2c:created', 'group:created'],
  );
  const posts = calls.filter((c) => c.method === 'post');
  assert.equal(posts.length, 2);
  const c2cPost = posts.find((c) => (c.body as { scope?: string }).scope === 'c2c');
  assert.ok(c2cPost);
  const body = c2cPost.body as { target_type?: string; panel?: { remark?: string; items?: unknown } };
  assert.equal(body.target_type, 'all');
  assert.equal(body.panel?.remark, 'openclaw-qqbot:auto:c2c');
  assert.deepEqual(body.panel?.items, ITEMS);
});

await test('sync: 已有自家面板（扁平/嵌套 remark 两种形态）→ PUT 覆盖，不 POST', async () => {
  const existing = [
    { panel_id: 'p1', remark: 'openclaw-qqbot:auto:c2c' },
    { panel_id: 'p2', panel: { remark: 'openclaw-qqbot:auto:group' } },
  ];
  const { api, calls } = makeFakeApi(existing);
  const results = await syncAccountCommandPanels(api, ITEMS);
  assert.equal(results.filter((r) => r.action === 'updated').length, 2);
  assert.equal(calls.filter((c) => c.method === 'post').length, 0);
  const puts = calls.filter((c) => c.method === 'put').map((c) => c.path).sort();
  assert.deepEqual(puts, ['/v2/panels/p1', '/v2/panels/p2']);
});

await test('sync: 同 scope 重复面板 → PUT 第一个 + DELETE 其余；外场面板不触碰', async () => {
  const existing = [
    { panel_id: 'foreign1', remark: '用户手建面板' },
    { panel_id: 'mine1', remark: 'openclaw-qqbot:auto:c2c' },
    { panel_id: 'mine2', remark: 'openclaw-qqbot:auto:c2c' },
  ];
  const { api, calls } = makeFakeApi(existing);
  const results = await syncAccountCommandPanels(api, ITEMS);
  const c2c = results.find((r) => r.scope === 'c2c');
  assert.equal(c2c?.duplicatesRemoved, 1);
  const paths = calls.filter((c) => c.method !== 'get').map((c) => `${c.method} ${c.path}`);
  assert.ok(paths.includes('put /v2/panels/mine1'));
  assert.ok(paths.includes('delete /v2/panels/mine2'));
  assert.ok(!paths.some((p) => p.includes('foreign1')));
});

// ── syncCommandPanels 编排（真实指令注册表 + fake gateway） ──

const ACCOUNT = makeAccount();
const CFG = {};

try {
  await test('orchestrator: 配置关闭（commands.native=false）→ 不产生任何 API 调用', async () => {
    const { api, calls } = makeFakeApi([]);
    installFakeGateway(api, 'test-panel-account');
    try {
      await syncCommandPanels(makeAccount({ commandPanelNative: false }), CFG);
      assert.equal(calls.length, 0);
    } finally {
      unregisterGateway('test-panel-account');
    }
  });

  await test('orchestrator: 真实注册表 → 同步 8 项 essential 指令并创建两个面板', async () => {
    clearCommandPanelSynced();
    const { api, calls } = makeFakeApi([]);
    installFakeGateway(api, 'test-panel-account');
    try {
      await syncCommandPanels(ACCOUNT, CFG);
      const posts = calls.filter((c) => c.method === 'post');
      assert.equal(posts.length, 2);
      const c2cPost = posts.find((c) => (c.body as { scope?: string }).scope === 'c2c');
      const items = (c2cPost?.body as { panel?: { items?: CommandPanelItem[] } }).panel?.items ?? [];
      // essential 共 10 个；/export-session(15) 与 /export-trajectory(18) 超 14 字符被丢弃 → 8 项
      assert.equal(items.length, 8);
      assert.ok(items.some((i) => i.name === '/new'));
      assert.ok(items.some((i) => i.name === '/model'));
      assert.ok(!items.some((i) => i.name === '/export-session'));
    } finally {
      unregisterGateway('test-panel-account');
    }
  });

  await test('orchestrator: once-guard — 同账号第二次调用不再发请求', async () => {
    const { api, calls } = makeFakeApi([]);
    installFakeGateway(api, 'test-panel-account');
    try {
      await syncCommandPanels(ACCOUNT, CFG);
      const afterFirst = calls.length;
      await syncCommandPanels(ACCOUNT, CFG);
      assert.equal(calls.length, afterFirst);
    } finally {
      unregisterGateway('test-panel-account');
    }
  });

  await test('orchestrator: 同步失败不抛出，且释放 once-guard 允许重试', async () => {
    clearCommandPanelSynced();
    const { api, calls } = makeFakeApi([], { failGet: new Error('boom') });
    installFakeGateway(api, 'test-panel-account');
    try {
      await syncCommandPanels(ACCOUNT, CFG); // 不应抛出
      assert.equal(calls.filter((c) => c.method === 'get').length, 1);
      await syncCommandPanels(ACCOUNT, CFG); // guard 已释放 → 再次尝试
      assert.equal(calls.filter((c) => c.method === 'get').length, 2);
    } finally {
      unregisterGateway('test-panel-account');
    }
  });
} finally {
  clearCommandPanelSynced();
}
