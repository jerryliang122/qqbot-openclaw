/**
 * 审批按钮路径的日志脱敏守卫
 *
 * 背景：`/bot-logs` 会把**本地日志文件原样**导出给 c2c 用户（不限 INFO）⇒
 * 日志里的完整 openid 等于把「他人的标识符」公开给其他用户。
 * `src/gateway/event-handlers.ts` 顶部早已写明这条约定：「日志中的标识符
 * 统一截断为前 8 字符……不落完整他人标识符」——但审批路径的三处日志
 * （unauthorized / tap / resolved）此前仍把 `operatorId`（= 点击者 openid）
 * 原样打进日志。
 *
 * 本文件锁定：**审批路径的日志行不得出现完整 openid**，且要保留可定位的
 * 前 8 位（shortId 口径，与 /bot-group-info 的展示惯例一致）。
 *
 * 运行方式: npx tsx tests/approval-log-redaction.test.ts
 */
import assert from 'node:assert/strict';

import { handleInteraction } from '../src/gateway/event-handlers.ts';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

function group(title: string): void {
  console.log(`\n=== ${title} ===`);
}

// ── 测试基础设施 ──

const ACCOUNT_ID = 'test-acct';
const OPERATOR = 'OPERATOR_OPENID_0123456789abcdef0123456789abcdef';
const APPROVAL_ID = 'exec:1a2b3c4d-5e6f-7890-abcd-ef1234567890';

function makeAccount(): any {
  return {
    accountId: ACCOUNT_ID,
    appId: 'x',
    config: { allowFrom: ['*'] },
  };
}

/** 假 runtime：`getAdapters(runtime).getConfig()` 取 `config.current()` */
function makeRuntime(cfg: unknown): any {
  return {
    version: 'test',
    channel: {
      inbound: { buildContext: (params: any) => ({ ...params }) },
      reply: {},
      routing: {},
      session: {},
    },
    config: { current: () => cfg },
  } as any;
}

/** 账号配置：allowFrom 决定审批授权（空 / ['*'] ⇒ 开放模式） */
function makeCfg(allowFrom: string[]): unknown {
  return {
    channels: {
      qqbot: {
        accounts: {
          [ACCOUNT_ID]: {
            appId: 'x',
            clientSecret: 'y',
            enabled: true,
            allowFrom,
          },
        },
      },
    },
  };
}

/** 捕获全部日志行（info / warn / error / debug 一视同仁——/bot-logs 导的是原始文件） */
function makeCapturingLog(): { log: any; lines: string[] } {
  const lines: string[] = [];
  const log: any = {
    info: (m: unknown) => { lines.push(String(m)); },
    warn: (m: unknown) => { lines.push(String(m)); },
    error: (m: unknown) => { lines.push(String(m)); },
    debug: (m: unknown) => { lines.push(String(m)); },
    child: () => log,
  };
  return { log, lines };
}

function makeApprovalEvent(operator: string): any {
  return {
    id: 'int-approval-1',
    type: 11,
    data: {
      type: 11,
      resolved: {
        button_data: `approve:v2:exec:${encodeURIComponent(APPROVAL_ID)}:allow-once`,
      },
    },
    user_openid: operator,
    timestamp: new Date().toISOString(),
  };
}

/** 插件自己写的审批日志行（`[approval]` 前缀） */
function approvalLines(lines: string[]): string[] {
  return lines.filter((l) => l.includes('[approval]'));
}

// ── 用例 ──

group('1. 未授权点选：WARN 日志不得含完整 openid');

await test('unauthorized 日志：operator 走 shortId（保留前 8 位）', async () => {
  const { log, lines } = makeCapturingLog();
  await handleInteraction(
    makeApprovalEvent(OPERATOR),
    makeAccount(),
    makeRuntime(makeCfg(['ADMIN_ONLY'])),
    log,
    async () => {},
  );
  const approval = approvalLines(lines);
  assert.ok(
    approval.some((l) => l.includes('unauthorized')),
    `前置：应走未授权分支，实际日志：${JSON.stringify(approval)}`,
  );
  const joined = approval.join('\n');
  assert.ok(!joined.includes(OPERATOR), '日志不得含点击者的完整 openid');
  assert.ok(joined.includes('OPERATOR'), '应保留可定位的前 8 位（shortId）');
});

group('2. 已授权点选：INFO 日志不得含完整 openid');

await test('tap / resolved 日志：operator 走 shortId（保留前 8 位）', async () => {
  const { log, lines } = makeCapturingLog();
  await handleInteraction(
    makeApprovalEvent(OPERATOR),
    makeAccount(),
    makeRuntime(makeCfg(['*'])),
    log,
    async () => {},
  );
  const approval = approvalLines(lines);
  assert.ok(
    approval.some((l) => l.includes('[approval] tap')),
    `前置：应走已授权分支，实际日志：${JSON.stringify(approval)}`,
  );
  const joined = approval.join('\n');
  assert.ok(!joined.includes(OPERATOR), '日志不得含点击者的完整 openid');
  assert.ok(joined.includes('OPERATOR'), '应保留可定位的前 8 位（shortId）');
});

// ── 结果 ──

console.log('\n' + '='.repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log('失败用例：');
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log('全部通过');
