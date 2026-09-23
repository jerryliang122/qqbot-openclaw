/**
 * tool-session + 工具会话路由回退测试（2026-09-23 修复）
 *
 * 背景：qqbot_secret_input / qqbot_platform_api / qqbot_remind 此前仅靠
 * request-context（AsyncLocalStorage）解析当前会话目标。openclaw 把 turn
 * 延迟到入站消息异步子树之外执行（followup/collect 队列、框架定时器驱动的
 * 队列 drain）时 ALS 为空，工具直接报「无法获取当前会话目标」失败。
 *
 * 覆盖：
 * - resolveToolSessionRoute：ALS 优先 / deliveryContext 回退 / 双缺失 /
 *   非本通道 deliveryContext / 非 qqbot 目标格式拒绝
 * - 工厂注册形式：registerTool 收到工厂函数；工厂 ctx 携带 deliveryContext
 * - qqbot_secret_input：无 ALS 时经 deliveryContext 发卡（真实 bug 场景——
 *   延迟 turn 中 LLM 调用工具不再报错），pending 登记在实际发送账号名下；
 *   群目标仍拒绝；无会话来源仍明确报错
 * - qqbot_remind：无 ALS 时经 deliveryContext 解析投递目标
 */
import { strict as assert } from 'node:assert';
import {
  resolveToolSessionRoute,
  type ToolDeliveryContext,
} from '../src/tools/tool-session.js';
import { runWithRequestContext } from '../src/request-context.js';
import {
  registerSecretInputTool,
} from '../src/tools/secret-input.js';
import {
  registerRemindTool,
} from '../src/tools/remind.js';
import {
  clearPendingSecretInputs,
  findPendingSecretInput,
} from '../src/features/secret-input-store.js';
import {
  registerGateway,
  unregisterGateway,
} from '../src/outbound/outbound-service.js';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        passed += 1;
        console.log(`  ✅ ${name}`);
      },
      (err) => {
        failed += 1;
        console.error(`  ❌ ${name}`);
        console.error(err);
      },
    );
}

// ── 测试用 fake 工厂注册（工厂形式的 registerTool 断言） ──

interface CapturedTool {
  tool: { name: string; execute: (id: string, params: unknown) => Promise<any> };
  factoryCtx: unknown;
}

function captureRegisteredTool(
  register: (api: any) => void,
): CapturedTool {
  let captured: CapturedTool | null = null;
  const api = {
    config: { channels: { qqbot: { appId: 'x', secret: 'y' } } },
    registerTool: (entry: unknown, _opts?: unknown) => {
      assert.strictEqual(typeof entry, 'function', 'registerTool 应收到工厂函数');
      const factory = entry as (ctx: unknown) => any;
      const factoryCtx = { deliveryContext: DELIVERY_C2C as ToolDeliveryContext };
      const tool = factory(factoryCtx);
      assert.ok(tool && typeof tool === 'object', '工厂应返回工具对象');
      captured = { tool, factoryCtx };
    },
  };
  register(api);
  assert.ok(captured, 'registerTool 未被调用');
  return captured!;
}

/** 以指定 deliveryContext 构造工具实例（模拟框架调用工厂） */
function buildToolWithDelivery(
  register: (api: any) => void,
  delivery: ToolDeliveryContext | undefined,
): { name: string; execute: (id: string, params: unknown) => Promise<any> } {
  let tool: { name: string; execute: (id: string, params: unknown) => Promise<any> } | null = null;
  const api = {
    config: { channels: { qqbot: { appId: 'x', secret: 'y' } } },
    registerTool: (entry: unknown) => {
      tool = (entry as (ctx: unknown) => any)({ deliveryContext: delivery });
    },
  };
  register(api);
  assert.ok(tool, '工厂未返回工具');
  return tool!;
}

// ── 共享 fixture ──

const DELIVERY_C2C: ToolDeliveryContext = {
  channel: 'qqbot',
  to: 'qqbot:c2c:0123456789abcdef0123456789abcdef',
  accountId: 'default',
};

const DELIVERY_GROUP: ToolDeliveryContext = {
  channel: 'qqbot',
  to: 'qqbot:group:ffffffffffffffffffffffffffffffff',
  accountId: 'default',
};

/** 频道（Guild/Channel）目标：parseTarget 会把它归一化为 c2c，secret-input 必须在此之前拒绝 */
const DELIVERY_CHANNEL: ToolDeliveryContext = {
  channel: 'qqbot',
  to: 'qqbot:channel:cccccccccccccccccccccccccccccccc',
  accountId: 'default',
};

const OPENID = '0123456789abcdef0123456789abcdef';

/** 注册一个 fake gateway（bot 提供 sendTextWithKeyboard / api 记录调用） */
function installFakeGateway(accountId: string): { sent: Array<Record<string, unknown>>; apiCalls: string[] } {
  const sent: Array<Record<string, unknown>> = [];
  const apiCalls: string[] = [];
  const bot = {
    sendTextWithKeyboard: async (target: unknown, text: string, _kb: unknown) => {
      sent.push({ target, text });
      return { ok: true };
    },
    api: new Proxy({}, {
      get: (_t, prop) => async (path: string) => {
        apiCalls.push(`${String(prop)} ${path}`);
        return { ok: true };
      },
    }),
  };
  registerGateway(accountId, { bot } as never);
  return { sent, apiCalls };
}

async function main(): Promise<void> {
  console.log('tool-session: resolveToolSessionRoute');

  await test('ALS（request-context）优先于 deliveryContext', async () => {
    await runWithRequestContext(
      { accountId: 'acc-a', target: `qqbot:c2c:${OPENID}`, messageId: 'm1', openId: OPENID },
      () => {
        const route = resolveToolSessionRoute(DELIVERY_C2C);
        assert.ok(route);
        assert.strictEqual(route.source, 'request-context');
        assert.strictEqual(route.target, `qqbot:c2c:${OPENID}`);
        assert.strictEqual(route.accountId, 'acc-a');
      },
    );
  });

  await test('ALS 缺失时回退 deliveryContext（延迟/排队 turn 场景）', () => {
    const route = resolveToolSessionRoute(DELIVERY_C2C);
    assert.ok(route, 'deliveryContext 存在时应解析出路由');
    assert.strictEqual(route.source, 'delivery-context');
    assert.strictEqual(route.target, `qqbot:c2c:${OPENID}`);
    assert.strictEqual(route.accountId, 'default');
  });

  await test('ALS 与 deliveryContext 均缺失 → undefined（cron/内部 run）', () => {
    assert.strictEqual(resolveToolSessionRoute(undefined), undefined);
    assert.strictEqual(resolveToolSessionRoute({}), undefined);
    assert.strictEqual(resolveToolSessionRoute({ channel: 'qqbot' }), undefined);
  });

  await test('非 qqbot 通道的 deliveryContext → 不误认', () => {
    assert.strictEqual(
      resolveToolSessionRoute({ channel: 'telegram', to: 'qqbot:c2c:whatever' }),
      undefined,
    );
  });

  await test('qqbot 通道但 to 非规范目标格式 → undefined', () => {
    assert.strictEqual(
      resolveToolSessionRoute({ channel: 'qqbot', to: 'not-a-qqbot-target' }),
      undefined,
    );
  });

  console.log('tool-session: 工厂注册 + secret-input 延迟 turn 修复');

  const fx = installFakeGateway('default');
  try {
    const captured = captureRegisteredTool(registerSecretInputTool);
    await test('registerSecretInputTool 以工厂形式注册且 ctx 携带 deliveryContext', () => {
      assert.strictEqual(captured.tool.name, 'qqbot_secret_input');
      assert.strictEqual(
        (captured.factoryCtx as { deliveryContext?: ToolDeliveryContext }).deliveryContext,
        DELIVERY_C2C,
      );
    });

    await test('【回归】无 ALS 时经 deliveryContext 发卡成功并登记 pending', async () => {
      clearPendingSecretInputs();
      // 不进入 runWithRequestContext —— 模拟框架延迟执行 turn，ALS 为空
      const result = await captured.tool.execute('call-1', {
        name: 'OC_MIMO_BILLING',
        description: '小米 mimo 模型按量付费 API Key',
      });
      const details = result.details as { ok?: boolean; error?: string };
      assert.ok(details.ok, `不应再报「无法获取当前会话目标」: ${JSON.stringify(details)}`);
      assert.strictEqual(fx.sent.length, 1, '应发出一张密钥输入卡片');
      const target = fx.sent[0].target as { scope: string; targetId: string };
      assert.strictEqual(target.scope, 'c2c');
      assert.strictEqual(target.targetId, OPENID);
      const pending = findPendingSecretInput('default', OPENID);
      assert.ok(pending, 'pending 应登记在实际发送账号名下');
      assert.strictEqual(pending!.name, 'OC_MIMO_BILLING');
      clearPendingSecretInputs();
    });

    await test('群目标 deliveryContext 仍拒绝（密钥不进群聊）', async () => {
      const groupTool = buildToolWithDelivery(registerSecretInputTool, DELIVERY_GROUP);
      const result = await groupTool.execute('call-2', { name: 'SOME_KEY' });
      const details = result.details as { error?: string };
      assert.ok(!(details as { ok?: boolean }).ok);
      assert.ok(
        (details.error ?? '').includes('仅支持私聊'),
        `应提示仅支持私聊: ${JSON.stringify(details)}`,
      );
      assert.strictEqual(fx.sent.length, 1, '不应再发卡');
    });

    await test('频道目标 deliveryContext 拒绝（parseTarget 会把 channel 归一化为 c2c，不得骗过私聊检查）', async () => {
      const channelTool = buildToolWithDelivery(registerSecretInputTool, DELIVERY_CHANNEL);
      const result = await channelTool.execute('call-2b', { name: 'SOME_KEY' });
      const details = result.details as { error?: string };
      assert.ok(!(details as { ok?: boolean }).ok, '频道目标必须被拒绝');
      assert.ok(
        (details.error ?? '').includes('仅支持私聊'),
        `应提示仅支持私聊: ${JSON.stringify(details)}`,
      );
      assert.strictEqual(fx.sent.length, 1, '不得向频道 ID 发卡');
    });

    await test('ALS 存在时优先使用 ALS 目标（不回归原路径）', async () => {
      clearPendingSecretInputs();
      const result = await runWithRequestContext(
        { accountId: 'default', target: `qqbot:c2c:${OPENID}`, messageId: 'm2', openId: OPENID },
        () => captured.tool.execute('call-3', { name: 'ANOTHER_KEY' }),
      );
      const details = result.details as { ok?: boolean };
      assert.ok(details.ok, `ALS 路径应照常工作: ${JSON.stringify(details)}`);
      assert.strictEqual(fx.sent.length, 2);
      clearPendingSecretInputs();
    });
  } finally {
    unregisterGateway('default');
    clearPendingSecretInputs();
  }

  console.log('tool-session: remind 延迟 turn 修复');

  await test('qqbot_remind 无 ALS 时经 deliveryContext 解析投递目标', async () => {
    const captured = captureRegisteredTool(registerRemindTool);
    assert.strictEqual(captured.tool.name, 'qqbot_remind');
    // 无 ALS：deliveryContext 兜底
    const result = await captured.tool.execute('call-4', {
      action: 'add',
      content: '喝水',
      time: '5m',
    });
    const details = result.details as { cronParams?: { job?: { delivery?: { to?: string; accountId?: string } } } };
    assert.ok(details.cronParams?.job?.delivery, `应构建 cron 任务: ${JSON.stringify(details)}`);
    assert.strictEqual(details.cronParams!.job!.delivery!.to, `qqbot:c2c:${OPENID}`);
    assert.strictEqual(details.cronParams!.job!.delivery!.accountId, 'default');
  });

  await test('qqbot_remind 双缺失时明确报错并提示传 to', async () => {
    const toolNoDelivery = buildToolWithDelivery(registerRemindTool, undefined);
    const result = await toolNoDelivery.execute('call-5', {
      action: 'add',
      content: '喝水',
      time: '5m',
    });
    const details = result.details as { error?: string };
    assert.ok(
      (details.error ?? '').includes('to'),
      `应提示显式传 to: ${JSON.stringify(details)}`,
    );
  });

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  if (failed > 0) process.exit(1);
}

await main();
