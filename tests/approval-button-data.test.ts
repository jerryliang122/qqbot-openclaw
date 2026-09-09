/**
 * 审批按钮 button_data 解析 + 键盘构建 + 目标解析 回归测试
 *
 * 验证 v2 格式：
 *   button_data = approve:v2:<kind>:<encodeURIComponent(approvalId)>:<decision>
 * approvalId 可能含冒号（exec:<uuid> / plugin:<uuid>），通过 URL 编码无损还原；
 * approvalKind 直接从 button_data 解析，无需 ID 前缀嗅探。
 *
 * 另验证 buildApprovalKeyboard 根据 allowedDecisions 动态渲染按钮
 * （修复 skill_workshop 审批因 allowedDecisions 不含 allow-always 而失败的问题）。
 *
 * 运行方式: npx tsx tests/approval-button-data.test.ts
 */
import assert from "node:assert";
import {
  parseApprovalButtonData,
  buildApprovalKeyboard,
  resolveApprovalTarget,
} from "../src/features/approval-helpers.js";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failedTests.push(name);
  }
}

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

const UUID = "1a2b3c4d-5e6f-7890-abcd-ef1234567890";

// ======================================================================
//  Part 1: parseApprovalButtonData — v2 格式（approvalId 含冒号）
// ======================================================================
group("1. exec:<uuid> approvalId（含冒号）");

test("exec:uuid + allow-once -> kind=exec, id 还原含冒号", () => {
  const r = parseApprovalButtonData(`approve:v2:exec:${encodeURIComponent(`exec:${UUID}`)}:allow-once`);
  assert.strictEqual(r?.approvalId, `exec:${UUID}`);
  assert.strictEqual(r?.approvalKind, "exec");
  assert.strictEqual(r?.decision, "allow-once");
});

test("plugin:uuid + allow-always -> kind=plugin", () => {
  const r = parseApprovalButtonData(`approve:v2:plugin:${encodeURIComponent(`plugin:${UUID}`)}:allow-always`);
  assert.strictEqual(r?.approvalId, `plugin:${UUID}`);
  assert.strictEqual(r?.approvalKind, "plugin");
  assert.strictEqual(r?.decision, "allow-always");
});

test("plugin:uuid + deny -> kind=plugin, deny", () => {
  const r = parseApprovalButtonData(`approve:v2:plugin:${encodeURIComponent(`plugin:${UUID}`)}:deny`);
  assert.strictEqual(r?.approvalId, `plugin:${UUID}`);
  assert.strictEqual(r?.approvalKind, "plugin");
  assert.strictEqual(r?.decision, "deny");
});

group("2. 纯 UUID approvalId（无前缀）");

test("纯 UUID + allow-once -> kind 来自 button_data 而非 id 前缀", () => {
  const r = parseApprovalButtonData(`approve:v2:exec:${UUID}:allow-once`);
  assert.strictEqual(r?.approvalId, UUID);
  assert.strictEqual(r?.approvalKind, "exec");
});

// ======================================================================
//  Part 2: parseApprovalButtonData — 异常输入
// ======================================================================
group("3. 异常输入 -> null");

test("v1 格式（旧）-> null", () => {
  assert.strictEqual(parseApprovalButtonData(`approve:exec:${UUID}:allow-once`), null);
});

test("非 approve: 前缀 -> null", () => {
  assert.strictEqual(parseApprovalButtonData("config:foo:bar"), null);
});

test("空字符串 -> null", () => {
  assert.strictEqual(parseApprovalButtonData(""), null);
});

test("未知 decision -> null", () => {
  assert.strictEqual(parseApprovalButtonData(`approve:v2:exec:${UUID}:maybe`), null);
});

test("未知 kind -> null", () => {
  assert.strictEqual(parseApprovalButtonData(`approve:v2:system:${UUID}:allow-once`), null);
});

// ======================================================================
//  Part 3: buildApprovalKeyboard — allowedDecisions 动态渲染
// ======================================================================
group("4. buildApprovalKeyboard — 默认三按钮");

test("默认 allowedDecisions -> 三个按钮", () => {
  const kb = buildApprovalKeyboard("exec:1", "exec");
  const buttons = kb.content!.rows![0].buttons!;
  assert.strictEqual(buttons.length, 3);
  assert.strictEqual(buttons[0].id, "allow");
  assert.strictEqual(buttons[1].id, "always");
  assert.strictEqual(buttons[2].id, "deny");
});

test("button_data 使用 v2 格式 + URL 编码 id", () => {
  const kb = buildApprovalKeyboard("plugin:abc", "plugin");
  const buttons = kb.content!.rows![0].buttons!;
  // plugin:abc -> encodeURIComponent -> plugin%3Aabc
  assert.strictEqual(
    buttons[0].action!.data,
    "approve:v2:plugin:plugin%3Aabc:allow-once",
  );
});

group("5. buildApprovalKeyboard — allowedDecisions 限制（skill_workshop 场景）");

test("allowedDecisions=['allow-once','deny'] -> 不渲染 allow-always", () => {
  // skill_workshop 的 apply 审批硬编码 allowedDecisions: ["allow-once","deny"]
  const kb = buildApprovalKeyboard("exec:sid1", "exec", ["allow-once", "deny"]);
  const buttons = kb.content!.rows![0].buttons!;
  assert.strictEqual(buttons.length, 2);
  assert.strictEqual(buttons[0].id, "allow");
  assert.strictEqual(buttons[1].id, "deny");
  const ids = buttons.map((b) => b.id);
  assert.ok(!ids.includes("always"), "allow-always 不应出现");
});

test("allowedDecisions=['deny'] -> 仅渲染拒绝", () => {
  const kb = buildApprovalKeyboard("exec:sid2", "exec", ["deny"]);
  const buttons = kb.content!.rows![0].buttons!;
  assert.strictEqual(buttons.length, 1);
  assert.strictEqual(buttons[0].id, "deny");
});

test("kind=plugin 时 button_data 前缀为 approve:v2:plugin:", () => {
  const kb = buildApprovalKeyboard("xyz", "plugin", ["allow-once"]);
  const data = kb.content!.rows![0].buttons![0].action!.data;
  assert.ok(data.startsWith("approve:v2:plugin:"), `got ${data}`);
});

// ======================================================================
//  Part 4: resolveApprovalTarget — sessionKey/turnSourceTo 解析
// ======================================================================
group("6. resolveApprovalTarget");

test("legacy direct scope no longer matches", () => {
  const r = resolveApprovalTarget("agent:main:qqbot:direct:ABCDEF12", null);
  assert.strictEqual(r, null);
});

test("sessionKey group -> group", () => {
  const r = resolveApprovalTarget("qqbot:group:ABCDEF12", null);
  assert.deepStrictEqual(r, { type: "group", id: "ABCDEF12" });
});

test("turnSourceTo c2c -> c2c", () => {
  const r = resolveApprovalTarget(null, "qqbot:c2c:ABCDEF12");
  assert.deepStrictEqual(r, { type: "c2c", id: "ABCDEF12" });
});

test("sessionKey 优先于 turnSourceTo", () => {
  const r = resolveApprovalTarget("qqbot:group:AAA", "qqbot:c2c:BBB");
  assert.deepStrictEqual(r, { type: "group", id: "AAA" });
});

test("两者都空 -> null", () => {
  assert.strictEqual(resolveApprovalTarget(null, null), null);
});

test("不匹配格式 -> null", () => {
  assert.strictEqual(resolveApprovalTarget("telegram:group:xyz", null), null);
});

// ======================================================================
//  结果汇总
// ======================================================================
console.log("\n" + "=".repeat(50));
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 个`);
if (failedTests.length > 0) {
  console.log(`\n失败的测试用例:`);
  for (const name of failedTests) console.log(`  - ${name}`);
}
console.log("=".repeat(50));

process.exit(failed > 0 ? 1 : 0);
