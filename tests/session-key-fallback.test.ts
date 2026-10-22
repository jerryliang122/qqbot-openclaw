/**
 * Session Key Fallback 真实测试
 *
 * 验证 dispatch.ts 中**真实**的路由 peer 选择与兜底 key 生成逻辑。
 * 本文件直接 import 生产代码（不再自带一份"影子实现"——影子实现会与真实代码
 * 悄悄分叉，让测试变成永远绿的同义反复）。
 *
 * 职责划分（2026-10-22 10.5 地板后）：
 * - peer 选择（群聊用 groupId / 私聊用 senderId）→ `resolveDispatchPeerId`
 * - key 形状（与框架 buildAgentPeerSessionKey 同形）→ `buildFallbackRouteSessionKey`
 *   （key 的 canonical / route 文法守卫在 tests/fallback-route-key.test.ts）
 *
 * 运行方式: npx tsx tests/session-key-fallback.test.ts
 */
import assert from 'node:assert';
import {
  buildFallbackRouteSessionKey,
  resolveDispatchPeerId,
} from '../src/dispatch/dispatch.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failedTests.push(name);
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : err}`);
  }
}

/** 群聊的兜底 key（groupScope 默认 per-group，peer 段承载 groupId）。 */
function groupKey(accountId: string, groupId: string | undefined, senderId: string): string {
  const peerId = resolveDispatchPeerId('group', groupId, senderId);
  return buildFallbackRouteSessionKey({ isGroup: true, accountId, peerId });
}

/** 私聊的兜底 key（dmScope 决定 peer 是否进 key，默认 main = 全体 c2c 共享主会话）。 */
function directKey(
  accountId: string,
  senderId: string,
  dmScope?: string,
): string {
  const peerId = resolveDispatchPeerId('direct', undefined, senderId);
  return buildFallbackRouteSessionKey({ isGroup: false, accountId, peerId, dmScope });
}

// ── 提取真实的 session key 生成逻辑 ──────────────────────────────────────────

group('群聊 session key fallback 修复验证');

test('群聊应该使用 groupId 而不是 senderId（关键修复）', () => {
  const senderId = 'USER_A';
  const groupId = 'GROUP_123';

  const peerId = resolveDispatchPeerId('group', groupId, senderId);
  assert.strictEqual(peerId, groupId, '群聊路由 peerId 应该是 groupId');

  const sessionKey = groupKey('default', groupId, senderId);
  assert.ok(
    sessionKey.includes('group_123'),
    `群聊 session key 应该包含 groupId，实际 ${sessionKey}`,
  );
  assert.ok(
    !sessionKey.includes(senderId.toLowerCase()),
    `群聊 session key 不应该包含 senderId，实际 ${sessionKey}`,
  );
});

test('同一个群的不同用户应该生成相同的 session key', () => {
  const groupId = 'GROUP_456';

  const key1 = groupKey('default', groupId, 'USER_A');
  const key2 = groupKey('default', groupId, 'USER_B');

  assert.strictEqual(
    key1,
    key2,
    '同一个群的不同用户应该生成相同的 session key，确保框架级串行处理',
  );
});

test('不同群应该生成不同的 session key', () => {
  const senderId = 'USER_A';

  const key1 = groupKey('default', 'GROUP_1', senderId);
  const key2 = groupKey('default', 'GROUP_2', senderId);

  assert.notStrictEqual(
    key1,
    key2,
    '不同群应该生成不同的 session key，允许群间并发',
  );
});

group('私聊 session key 验证');

test('私聊路由 peer 应该是 senderId', () => {
  const peerId = resolveDispatchPeerId('direct', undefined, 'USER_123');
  assert.strictEqual(peerId, 'USER_123', '私聊路由 peer 应该是 senderId');
});

test('私聊忽略 groupId 参数', () => {
  const withGroup = resolveDispatchPeerId('direct', 'GROUP_456', 'USER_123');
  const withoutGroup = resolveDispatchPeerId('direct', undefined, 'USER_123');
  assert.strictEqual(withGroup, withoutGroup, '私聊路由 peer 应该忽略 groupId 参数');
});

test('私聊 session key 按 dmScope 分流（默认 main = 全体 c2c 共享主会话）', () => {
  // 框架默认 dmScope="main"：所有 c2c 用户共享 agent:main:main
  const shared = directKey('default', 'USER_123');
  assert.strictEqual(shared, 'agent:main:main', `默认 dmScope 应共享主会话，实际 ${shared}`);

  // per-peer：peer 进 key，用户间隔离
  const perPeer = directKey('default', 'USER_123', 'per-peer');
  assert.strictEqual(perPeer, 'agent:main:direct:user_123', `per-peer 形状：${perPeer}`);

  // per-account-channel-peer：accountId 进 key 的 account 段（不是 peer 段）
  const perAccount = directKey('default', 'USER_123', 'per-account-channel-peer');
  assert.strictEqual(
    perAccount,
    'agent:main:qqbot:default:direct:user_123',
    `per-account-channel-peer 形状：${perAccount}`,
  );
});

group('边界情况');

test('群聊缺少 groupId 时降级使用 senderId', () => {
  const peerId = resolveDispatchPeerId('group', undefined, 'USER_123');
  assert.strictEqual(peerId, 'USER_123', '群聊缺少 groupId 时应该降级使用 senderId');

  const sessionKey = groupKey('default', undefined, 'USER_123');
  assert.ok(
    sessionKey.includes('user_123'),
    `降级后的群 session key 应该包含 senderId，实际 ${sessionKey}`,
  );
});

group('回归测试：修复前的 bug 验证');

test('修复前：错误地使用 senderId（应该失败）', () => {
  // 修复前的错误逻辑：群聊用 senderId 当 peer
  const buggyPeerId = 'USER_A';
  // 修复后的正确逻辑：群聊用 groupId
  const correctPeerId = resolveDispatchPeerId('group', 'GROUP_123', 'USER_A');

  assert.notStrictEqual(
    buggyPeerId,
    correctPeerId,
    '修复前后的路由 peer 应该不同，证明修复生效',
  );
  assert.strictEqual(correctPeerId, 'GROUP_123', '正确的 peer 应该是 groupId');
});

test('修复验证：不同用户同群不再产生不同 key', () => {
  // 修复前会产生的 bug：不同用户产生不同 key（同群并发 → QQ 平台 500）
  const buggyKey1 = 'agent:main:qqbot:group:user_a';
  const buggyKey2 = 'agent:main:qqbot:group:user_b';

  assert.notStrictEqual(
    buggyKey1,
    buggyKey2,
    '修复前：不同用户产生不同 session key（bug）',
  );

  const correctKey1 = groupKey('default', 'GROUP_123', 'USER_A');
  const correctKey2 = groupKey('default', 'GROUP_123', 'USER_B');

  assert.strictEqual(
    correctKey1,
    correctKey2,
    '修复后：同群用户产生相同 session key（正确）',
  );
});

// ── 输出测试结果 ──────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log(`测试结果: ${passed} passed, ${failed} failed`);

if (failedTests.length > 0) {
  console.log('\n失败的测试:');
  failedTests.forEach((name) => console.log(`  - ${name}`));
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  console.log('Session key fallback 已修复，群聊消息将正确使用 groupId。');
  process.exit(0);
}
