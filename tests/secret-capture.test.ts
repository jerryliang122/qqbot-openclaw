/**
 * secret-input 全链路单元测试
 *
 * 覆盖：
 * - secret-store-cli：name 校验 / 掩码 / argv 拼装 / CLI 入口解析优先级 / spawn 注入执行
 * - secret-input-store：登记 / 一次性消费 / 覆盖 / 取消 / TTL
 * - secret-capture 中间件：命中消费、取消、空输入保留、多问题红线放行、
 *   群聊放行、失败回执、quota 降级
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetCachedCliForTest,
  buildSecretsStoreSetArgs,
  isValidSecretName,
  maskSecret,
  resolveOpenClawCli,
  runSecretsStoreSet,
  scrubSecret,
  type SpawnFn,
  type SpawnLikeChild,
} from '../src/features/secret-store-cli.js';
import {
  cancelPendingSecretInput,
  clearPendingSecretInputs,
  findPendingSecretInput,
  pendingSecretInputCount,
  registerPendingSecretInput,
  takePendingSecretInput,
} from '../src/features/secret-input-store.js';
import { isSecretInputCancelKeyword, secretCapture } from '../src/middleware/secret-capture.js';
import {
  markMultiQuestionResolved,
  registerPendingMultiQuestion,
} from '../src/features/question-helpers.js';
import type { SecretsStoreSetResult } from '../src/features/secret-store-cli.js';

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
        console.error(`     ${err instanceof Error ? err.message : String(err)}`);
      },
    );
}

// ============ 1. secret-store-cli 纯函数 ============

console.log('\n=== 1. isValidSecretName ===');

await test('合法变量名', () => {
  assert.equal(isValidSecretName('LOG_LEVEL'), true);
  assert.equal(isValidSecretName('A'), true);
  assert.equal(isValidSecretName('OPENWEATHER_API_KEY'), true);
  assert.equal(isValidSecretName('X'.repeat(128)), true);
});

await test('非法变量名被拒', () => {
  assert.equal(isValidSecretName('lowercase'), false);
  assert.equal(isValidSecretName('1ABC'), false);
  assert.equal(isValidSecretName('MY-VAR'), false);
  assert.equal(isValidSecretName('MY VAR'), false);
  assert.equal(isValidSecretName('X'.repeat(129)), false);
  assert.equal(isValidSecretName(''), false);
  assert.equal(isValidSecretName('FOO; rm -rf /'), false);
});

console.log('\n=== 2. maskSecret / scrubSecret ===');

await test('掩码边界', () => {
  assert.equal(maskSecret('short'), '***');
  assert.equal(maskSecret('123456789012'), '***'); // 恰好 12 → 全遮
  assert.equal(maskSecret('1234567890123'), '1234…0123'); // 13 → 前后 4
  assert.equal(maskSecret('sk-abcdefghijklmn'), 'sk-a…klmn');
});

await test('scrub 清洗输出中的密钥值', () => {
  assert.equal(scrubSecret('error near sk-abc123xyz', 'sk-abc123xyz'), 'error near ***');
  assert.equal(scrubSecret('a secret a secret', 'secret'), 'a *** a ***');
  assert.equal(scrubSecret('unchanged', ''), 'unchanged');
});

console.log('\n=== 3. buildSecretsStoreSetArgs ===');

await test('env kind 走 --value', () => {
  assert.deepEqual(buildSecretsStoreSetArgs('LOG_LEVEL', 'env', 'debug'), [
    'secrets',
    'store',
    'set',
    'LOG_LEVEL',
    '--kind',
    'env',
    '--value',
    'debug',
  ]);
});

await test('secret kind 走 --value-file -（stdin）', () => {
  assert.deepEqual(buildSecretsStoreSetArgs('GITHUB_TOKEN', 'secret', 'ghs_x'), [
    'secrets',
    'store',
    'set',
    'GITHUB_TOKEN',
    '--kind',
    'secret',
    '--value-file',
    '-',
  ]);
});

// ============ 3b. CLI 入口解析优先级 ============

console.log('\n=== 3b. resolveOpenClawCli 优先级 ===');

/** 造一个假包（含 package.json，可选 bin），返回包根 */
function writeFakePackage(dir: string, name: string, bin?: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, ...(bin ? { bin: { openclaw: bin } } : {}) }),
  );
  return dir;
}

/** 临时替换 process.argv[1] 并清掉 CLI 解析缓存，结束后还原 */
function withArgv1(fake: string | undefined, fn: () => void): void {
  const orig = process.argv[1];
  if (fake === undefined) process.argv.splice(1, 1);
  else process.argv[1] = fake;
  __resetCachedCliForTest();
  try {
    fn();
  } finally {
    if (orig === undefined) process.argv.splice(1, 0, undefined as unknown as string);
    else process.argv[1] = orig;
    __resetCachedCliForTest();
  }
}

await test('优先用网关自身安装（process.argv[1] 所在的 openclaw 包）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cli-'));
  const gwRoot = writeFakePackage(path.join(tmp, 'gateway-openclaw'), 'openclaw', 'openclaw.mjs');
  const entry = path.join(gwRoot, 'dist', 'index.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  withArgv1(entry, () => {
    const cli = resolveOpenClawCli();
    assert.equal(cli.cmd, process.execPath);
    assert.equal(cli.args[0], path.join(gwRoot, 'openclaw.mjs'));
  });
});

await test('argv[1] 在 openclaw 的嵌套依赖里 → 跳过内层包，定位外层 openclaw', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cli-'));
  const ocRoot = writeFakePackage(path.join(tmp, 'openclaw'), 'openclaw', 'openclaw.mjs');
  const nested = writeFakePackage(path.join(ocRoot, 'node_modules', 'worker'), 'worker');
  const entry = path.join(nested, 'run.js');
  withArgv1(entry, () => {
    const cli = resolveOpenClawCli();
    assert.equal(cli.args[0], path.join(ocRoot, 'openclaw.mjs'));
  });
});

await test('argv[1] 在无关包内 → 不误用该包，回退其他解析', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-cli-'));
  const appRoot = writeFakePackage(path.join(tmp, 'myapp'), 'myapp', 'server.js');
  withArgv1(path.join(appRoot, 'server.js'), () => {
    const cli = resolveOpenClawCli();
    const joined = `${cli.cmd} ${cli.args.join(' ')}`;
    assert.ok(!joined.includes('myapp'), `不应解析到无关包: ${joined}`);
  });
});

await test('argv[1] 缺失 → 回退 require.resolve / PATH，不抛错', () => {
  withArgv1(undefined, () => {
    const cli = resolveOpenClawCli();
    assert.ok(cli.cmd === 'openclaw' || cli.cmd === process.execPath);
  });
});

// ============ 4. spawn 注入执行 ============

console.log('\n=== 4. runSecretsStoreSet（fake spawn）===');

interface FakeSpawnRecord {
  cmd: string;
  args: string[];
  /** stdin 写入 chunks（execCli 在 spawn 返回后才写入，断言时 join） */
  stdinChunks: string[];
}

/** 构造记录调用并立即以指定结果结束的 fake spawn */
function makeFakeSpawn(
  exitCode: number,
  output: string,
  records: FakeSpawnRecord[],
  opts: { stderr?: boolean } = {},
): SpawnFn {
  return (cmd, args) => {
    const stdinChunks: string[] = [];
    const record: FakeSpawnRecord = { cmd, args: [...args], stdinChunks };
    const child = {
      stdin: {
        write: (chunk: string) => {
          stdinChunks.push(String(chunk));
        },
        end: () => {},
        on: () => {},
      },
      stdout: {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'data') setImmediate(() => cb(output));
          return child.stdout;
        },
      },
      stderr: {
        on: (event: string, cb: (...a: unknown[]) => void) => {
          if (event === 'data' && opts.stderr) setImmediate(() => cb(output));
          return child.stderr;
        },
      },
      on: (event: string, listener: (...a: unknown[]) => void) => {
        if (event === 'close') setImmediate(() => listener(exitCode));
        return child;
      },
      kill: () => {},
    };
    records.push(record);
    return child as unknown as SpawnLikeChild;
  };
}

const CLI_FIXTURE = { cmd: 'node', args: ['/fake/openclaw-cli.js'] };

await test('env kind：argv 带 --value，stdin 为空，成功', async () => {
  const records: FakeSpawnRecord[] = [];
  const result = await runSecretsStoreSet(
    { name: 'LOG_LEVEL', kind: 'env', value: 'debug' },
    { spawnFn: makeFakeSpawn(0, 'stored LOG_LEVEL', records), cli: CLI_FIXTURE },
  );
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(records[0]!.args, [
    '/fake/openclaw-cli.js',
    'secrets',
    'store',
    'set',
    'LOG_LEVEL',
    '--kind',
    'env',
    '--value',
    'debug',
  ]);
  assert.equal(records[0]!.stdinChunks.join(''), '');
  assert.equal(result.output.includes('stored LOG_LEVEL'), true);
});

await test('secret kind：值经 stdin 写入，不出现在 argv', async () => {
  const records: FakeSpawnRecord[] = [];
  const result = await runSecretsStoreSet(
    { name: 'GITHUB_TOKEN', kind: 'secret', value: 'ghs_super_secret' },
    { spawnFn: makeFakeSpawn(0, 'stored GITHUB_TOKEN', records), cli: CLI_FIXTURE },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(records[0]!.args, [
    '/fake/openclaw-cli.js',
    'secrets',
    'store',
    'set',
    'GITHUB_TOKEN',
    '--kind',
    'secret',
    '--value-file',
    '-',
  ]);
  assert.equal(records[0]!.stdinChunks.join(''), 'ghs_super_secret');
  assert.ok(!records[0]!.args.includes('ghs_super_secret'));
});

await test('失败：退出码透传，输出中的密钥值被 scrub', async () => {
  const records: FakeSpawnRecord[] = [];
  const result = await runSecretsStoreSet(
    { name: 'GITHUB_TOKEN', kind: 'secret', value: 'ghs_super_secret' },
    { spawnFn: makeFakeSpawn(2, 'invalid args near ghs_super_secret', records), cli: CLI_FIXTURE },
  );
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 2);
  assert.ok(!result.output.includes('ghs_super_secret'));
  assert.ok(result.output.includes('***'));
});

// ============ 5. pending store ============

console.log('\n=== 5. secret-input-store ===');

const ACCT = 'default';
const USER = 'user_openid_1';

function makePending(name = 'TEST_KEY', kind: 'env' | 'secret' = 'secret') {
  return {
    accountId: ACCT,
    senderOpenid: USER,
    name,
    kind,
    description: '测试密钥',
    createdAt: Date.now(),
  };
}

await test('register → find → take 一次性消费', () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  assert.equal(pendingSecretInputCount(), 1);
  const found = findPendingSecretInput(ACCT, USER);
  assert.ok(found);
  assert.equal(found.name, 'TEST_KEY');
  assert.equal(found.kind, 'secret');
  // find 不消费
  assert.ok(findPendingSecretInput(ACCT, USER));
  const taken = takePendingSecretInput(ACCT, USER);
  assert.ok(taken);
  assert.equal(taken.name, 'TEST_KEY');
  assert.equal(takePendingSecretInput(ACCT, USER), undefined);
  assert.equal(pendingSecretInputCount(), 0);
});

await test('同 key 重复注册覆盖（不泄漏条目）', () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending('FIRST_KEY'));
  registerPendingSecretInput(makePending('SECOND_KEY'));
  assert.equal(pendingSecretInputCount(), 1);
  assert.equal(findPendingSecretInput(ACCT, USER)!.name, 'SECOND_KEY');
});

await test('不同用户 / 账户互不影响', () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  assert.equal(findPendingSecretInput(ACCT, 'other_user'), undefined);
  assert.equal(findPendingSecretInput('other_account', USER), undefined);
});

await test('cancel 删除 pending', () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  assert.equal(cancelPendingSecretInput(ACCT, USER), true);
  assert.equal(findPendingSecretInput(ACCT, USER), undefined);
  assert.equal(cancelPendingSecretInput(ACCT, USER), false);
});

await test('TTL 过期后不可见（短 TTL）', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending(), 5);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(findPendingSecretInput(ACCT, USER), undefined);
  assert.equal(pendingSecretInputCount(), 0);
});

// ============ 6. 中间件 ============

console.log('\n=== 6. secretCapture 中间件 ===');

interface SentMessage {
  target: { scope: string; targetId: string; msgId?: string };
  text: string;
}

function makeCtx(overrides: {
  kind?: string;
  senderId?: string;
  content?: string;
  msgId?: string;
} = {}) {
  const sent: SentMessage[] = [];
  let stopReason: string | undefined;
  let nextCalled = false;
  const senderId = overrides.senderId ?? USER;
  const ctx = {
    message: {
      kind: overrides.kind ?? 'c2c',
      senderId,
      content: overrides.content ?? '',
    },
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: overrides.msgId ?? 'm-default' },
    bot: {
      sendText: async (target: SentMessage['target'], text: string) => {
        sent.push({ target, text });
      },
    },
    state: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stop: (reason?: string) => {
      stopReason = reason ?? 'stopped';
    },
  };
  return {
    ctx,
    sent,
    stopReason: () => stopReason,
    nextCalled: () => nextCalled,
    next: async () => {
      nextCalled = true;
    },
  };
}

function okResult(): SecretsStoreSetResult {
  return { ok: true, exitCode: 0, timedOut: false, output: '' };
}

await test('无 pending → 直接放行', async () => {
  clearPendingSecretInputs();
  const h = makeCtx({ content: 'hello' });
  let setCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => {
      setCalls += 1;
      return okResult();
    },
    runReload: async () => true,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.nextCalled(), true);
  assert.equal(h.stopReason(), undefined);
  assert.equal(setCalls, 0);
  assert.equal(h.sent.length, 0);
});

await test('命中 pending：消费 + 执行 + 回执 + stop（消息不进框架）', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending('GITHUB_TOKEN', 'secret'));
  const h = makeCtx({ content: '  ghs_abc123  ', msgId: 'm-hit' });
  const calls: Array<{ name: string; kind: string; value: string }> = [];
  let reloadCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async (p) => {
      calls.push(p as { name: string; kind: string; value: string });
      return okResult();
    },
    runReload: async () => {
      reloadCalls += 1;
      return true;
    },
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.nextCalled(), false, '消息不得进入框架');
  assert.equal(h.stopReason(), 'secret-capture:consumed');
  assert.deepEqual(calls, [{ name: 'GITHUB_TOKEN', kind: 'secret', value: 'ghs_abc123' }]);
  assert.equal(reloadCalls, 1);
  assert.equal(h.sent.length, 1);
  assert.ok(h.sent[0]!.text.includes('已保存'));
  assert.ok(h.sent[0]!.text.includes('GITHUB_TOKEN'));
  assert.ok(!h.sent[0]!.text.includes('ghs_abc123'), '回执不得泄露明文密钥');
  assert.ok(h.sent[0]!.text.includes('***') || h.sent[0]!.text.includes('…'), '应包含掩码');
  assert.equal(findPendingSecretInput(ACCT, USER), undefined, 'pending 已一次性消费');
});

await test('取消关键词 → 取消 + 回执 + stop', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  const h = makeCtx({ content: '取消', msgId: 'm-cancel' });
  let setCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => {
      setCalls += 1;
      return okResult();
    },
    runReload: async () => true,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(setCalls, 0);
  assert.equal(h.stopReason(), 'secret-capture:cancelled');
  assert.ok(h.sent[0]!.text.includes('已取消'));
  assert.equal(findPendingSecretInput(ACCT, USER), undefined);
});

await test('isSecretInputCancelKeyword 各种形态', () => {
  assert.equal(isSecretInputCancelKeyword('取消'), true);
  assert.equal(isSecretInputCancelKeyword(' 取消 '), true);
  assert.equal(isSecretInputCancelKeyword('CANCEL'), true);
  assert.equal(isSecretInputCancelKeyword('#cancel'), true);
  assert.equal(isSecretInputCancelKeyword('/cancel'), true);
  assert.equal(isSecretInputCancelKeyword('ghs_token'), false);
  assert.equal(isSecretInputCancelKeyword(''), false);
});

await test('空文本 → 提示重发 + stop，pending 保留', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending('EMPTY_TEST'));
  const h = makeCtx({ content: '   ', msgId: 'm-empty' });
  let setCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => {
      setCalls += 1;
      return okResult();
    },
    runReload: async () => true,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(setCalls, 0);
  assert.equal(h.stopReason(), 'secret-capture:empty_input');
  assert.ok(h.sent[0]!.text.includes('EMPTY_TEST'));
  assert.ok(findPendingSecretInput(ACCT, USER), 'pending 应保留继续等待');
});

await test('群聊消息 → 放行（即使误登记 pending）', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  const h = makeCtx({ kind: 'group', content: 'some secret' });
  let setCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => {
      setCalls += 1;
      return okResult();
    },
    runReload: async () => true,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.nextCalled(), true);
  assert.equal(setCalls, 0);
  assert.ok(findPendingSecretInput(ACCT, USER), 'pending 不被群消息消费');
});

await test('红线：多问题 ask_user pending 中的会话 → 消息放行', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending());
  // 同会话登记一个进行中的多问题 ask_user
  registerPendingMultiQuestion(
    'default',
    'ask_0123456789abcdef0123456789abcdef',
    'c2c',
    USER,
    [{ header: 'Q1', question: 'pick', options: ['A', 'B'] }],
    5 * 60 * 1000,
  );
  const h = makeCtx({ content: 'ghs_abc', msgId: 'm-mq' });
  let setCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => {
      setCalls += 1;
      return okResult();
    },
    runReload: async () => true,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.nextCalled(), true, 'ask_user 答案消息必须放行');
  assert.equal(setCalls, 0);
  assert.ok(findPendingSecretInput(ACCT, USER), 'pending 保留（未被消费）');
  markMultiQuestionResolved('ask_0123456789abcdef0123456789abcdef'); // 清理，勿泄漏给后续用例
  clearPendingSecretInputs();
});

await test('执行失败 → 失败回执含原因 + 退出码，不触发 reload', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending('FAIL_KEY', 'env'));
  const h = makeCtx({ content: 'some value', msgId: 'm-fail' });
  let reloadCalls = 0;
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => ({
      ok: false,
      exitCode: 1,
      timedOut: false,
      output: 'unknown command: secrets',
    }),
    runReload: async () => {
      reloadCalls += 1;
      return false;
    },
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.stopReason(), 'secret-capture:consumed');
  assert.equal(reloadCalls, 0);
  assert.ok(h.sent[0]!.text.includes('失败'));
  assert.ok(h.sent[0]!.text.includes('FAIL_KEY'));
  assert.ok(h.sent[0]!.text.includes('openclaw'));
  assert.equal(findPendingSecretInput(ACCT, USER), undefined);
});

await test('quota 耗尽 → 降级主动发送（无 msgId）', async () => {
  clearPendingSecretInputs();
  registerPendingSecretInput(makePending('QUOTA_KEY', 'env'));
  const msgId = 'm-quota';
  // 预先耗尽该 msgId 的 4 次被动配额
  const { checkAndConsumePassiveReplyQuota } = await import(
    '../src/features/quota-manager.js'
  );
  for (let i = 0; i < 4; i += 1) {
    checkAndConsumePassiveReplyQuota({ accountId: ACCT, msgId, scope: 'c2c' });
  }
  const h = makeCtx({ content: 'val', msgId });
  const mw = secretCapture({
    accountId: ACCT,
    runSet: async () => okResult(),
    runReload: async () => false,
  });
  await mw(h.ctx as never, h.next);
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0]!.target.msgId, undefined, '降级主动发送不带 msgId');
  assert.equal(h.sent[0]!.target.targetId, USER);
  assert.ok(h.sent[0]!.text.includes('已保存'));
});

// ============ 汇总 ============

console.log(`\n=== 结果: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exitCode = 1;
