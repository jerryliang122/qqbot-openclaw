/**
 * StreamingController 单元测试
 *
 * 针对当前控制器 API（onPartialReply / finalize / flushSegment / abort +
 * 状态机访问器），用 fake gateway 记录流式会话调用。
 *
 * 运行方式: npx tsx tests/streaming-controller.test.ts
 */

import assert from "node:assert";
import { StreamingController, shouldUseStreaming } from "../src/outbound/streaming-controller.js";

// ============ fake gateway / session ============

interface UpdateCall { text: string }
interface FakeSession {
  updates: UpdateCall[];
  completed: number;
  update: (text: string) => Promise<void>;
  complete: () => Promise<void>;
}

function makeFakeGateway(opts: { failUpdates?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const gateway: any = {
    openStream: () => {
      const s: FakeSession = {
        updates: [],
        completed: 0,
        update: async (text: string) => {
          if (opts.failUpdates) throw new Error("update API error");
          s.updates.push({ text });
        },
        complete: async () => { s.completed++; },
      };
      sessions.push(s);
      return s;
    },
  };
  return { gateway, sessions };
}

// ============ 辅助 ============

const logs: string[] = [];

function createController(
  deps: Partial<ConstructorParameters<typeof StreamingController>[0]> & {
    failUpdates?: boolean;
  } = {},
) {
  logs.length = 0;
  const { gateway, sessions } = makeFakeGateway({ failUpdates: deps.failUpdates });
  const staticTexts: string[] = [];
  const ctrl = new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "USER_1" },
    accountId: "test",
    replyToId: "MSG_1",
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: (m: string) => logs.push(`[DEBUG] ${m}`),
    } as any,
    ...(deps.sendMode ? { sendMode: deps.sendMode } : {}),
    ...(deps.sendStatic ? { sendStatic: deps.sendStatic } : {}),
    ...(deps.sendMode === "static" && !deps.sendStatic
      ? { sendStatic: async (t: string) => { staticTexts.push(t); } }
      : {}),
  });
  return { ctrl, sessions, staticTexts };
}

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    failed++;
    failedTests.push(name);
  }
}

// ============ 用例 ============

console.log("\n=== 1. stream 模式基本流 ===");

await test("基本流式：增长前缀 → 单会话连续 update，finalize 收尾", async () => {
  const { ctrl, sessions } = createController();

  await ctrl.onPartialReply("你好");
  await ctrl.onPartialReply("你好世界");
  await ctrl.finalize();

  assert.strictEqual(ctrl.currentPhase, "done", "finalize 后应 done");
  assert.strictEqual(sessions.length, 1, "只应开一个流式会话");
  const texts = sessions[0]!.updates.map((u) => u.text);
  assert.deepStrictEqual(texts, ["你好", "你好世界"], "两次 update 均下发");
  assert.ok(ctrl.hasSentChunks, "应有已发送分片");
  assert.ok(!ctrl.shouldFallbackToStatic, "不应降级");
  assert.strictEqual(sessions[0]!.completed, 1, "finalize 应 complete 会话");
});

await test("空文本被忽略，不启动会话", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onPartialReply("");
  await ctrl.finalize();
  assert.strictEqual(sessions.length, 0, "不应有流式会话");
  assert.strictEqual(ctrl.currentPhase, "done");
  assert.ok(ctrl.shouldFallbackToStatic, "从未发片 → 降级标记");
});

await test("hasStarted 同步置位（不等异步发送）", async () => {
  const { ctrl } = createController();
  const p = ctrl.onPartialReply("第一段");
  assert.ok(ctrl.hasStarted, "onPartialReply 调用后应立即为 true");
  await p;
});

await test("文本缩短 → 新回复：complete 旧会话后开新会话", async () => {
  const { ctrl, sessions } = createController();

  await ctrl.onPartialReply("第一段回复");
  await ctrl.onPartialReply("新"); // 前缀不匹配且更短 → new_reply

  assert.strictEqual(sessions.length, 2, "应开了第二个会话");
  assert.ok(sessions[0]!.completed >= 1, "旧会话应已 complete");
  assert.strictEqual(sessions[1]!.updates[0]!.text, "新", "新会话首片为新文本");
});

await test("前缀不匹配但增长（模型重写尾部）→ 同会话合并追加", async () => {
  const { ctrl, sessions } = createController();

  await ctrl.onPartialReply("abcdefg");
  await ctrl.onPartialReply("abcXYZ!"); // 公共前缀 abc，尾部重写

  assert.strictEqual(sessions.length, 1, "不应开新会话");
  assert.strictEqual(sessions[1 - 1]!.updates.length, 2);
  // 合并语义：保留已接受前缀 + 追加重写的尾部（前缀不可变更约束）
  assert.strictEqual(sessions[0]!.updates[1]!.text, "abcdefgXYZ!", "下发合并后的完整文本");
});

await test("update 失败 → failed 终态 + 降级标记", async () => {
  const { ctrl } = createController({ failUpdates: true });
  await ctrl.onPartialReply("会失败");
  assert.strictEqual(ctrl.currentPhase, "failed", "update 抛错应进入 failed");
  assert.ok(ctrl.shouldFallbackToStatic, "无已发分片 → 降级");
});

await test("abort → failed 终态，complete 会话", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onPartialReply("some text");
  await ctrl.abort("test");
  assert.strictEqual(ctrl.currentPhase, "failed");
  assert.ok(ctrl.isTerminal);
  assert.strictEqual(sessions[0]!.completed, 1, "abort 应 complete 会话");
});

await test("终态后 onPartialReply 被忽略", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onPartialReply("a");
  await ctrl.finalize();
  await ctrl.onPartialReply("b");
  assert.strictEqual(sessions[0]!.updates.length, 1, "终态后不再发送");
});

console.log("\n=== 2. static 模式 ===");

await test("static：仅累积不开流式会话，finalize 一次性 sendStatic", async () => {
  const { ctrl, sessions, staticTexts } = createController({ sendMode: "static" });

  await ctrl.onPartialReply("第一段");
  await ctrl.onPartialReply("第一段继续");
  assert.strictEqual(sessions.length, 0, "static 模式不开流式会话");
  assert.strictEqual(staticTexts.length, 0, "finalize 前不发送");

  await ctrl.finalize();
  assert.deepStrictEqual(staticTexts, ["第一段继续"], "finalize 发送完整累积文本");
  assert.strictEqual(ctrl.currentPhase, "done");
  assert.ok(ctrl.hasSentChunks, "static 模式计分片");
});

await test("static：flushSegment 立即固化当前段并重置缓冲（不进终态）", async () => {
  const { ctrl, staticTexts } = createController({ sendMode: "static" });

  await ctrl.onPartialReply("段一");
  await ctrl.flushSegment();
  assert.deepStrictEqual(staticTexts, ["段一"], "flushSegment 应立即发送当前段");

  // 新一段（前缀不匹配）→ 覆盖累积，不发送
  await ctrl.onPartialReply("段二内容");
  assert.strictEqual(ctrl.currentPhase, "streaming", "flush 后仍在 streaming 态");

  await ctrl.flushSegment();
  await ctrl.finalize();
  assert.deepStrictEqual(staticTexts, ["段一", "段二内容"], "两段分别发送");
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("static：空缓冲 flushSegment 无副作用", async () => {
  const { ctrl, staticTexts } = createController({ sendMode: "static" });
  await ctrl.flushSegment();
  assert.strictEqual(staticTexts.length, 0);
});

await test("static：未提供 sendStatic → finalize 降级标记", async () => {
  const logs2: string[] = [];
  const { gateway } = makeFakeGateway();
  const ctrl = new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "U" } as any,
    accountId: "a",
    replyToId: "m",
    sendMode: "static",
    // 故意不传 sendStatic
  });
  await ctrl.onPartialReply("内容");
  await ctrl.finalize();
  // dispatch 在 static 模式恒传 sendStatic，此分支为纯防御：
  // 终态 failed 且未实际发送任何内容
  assert.strictEqual(ctrl.currentPhase, "failed", "无 sendStatic 应 failed");
});

await test("static：sendStatic 抛错 → failed", async () => {
  const { gateway } = makeFakeGateway();
  const ctrl = new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "U" } as any,
    accountId: "a",
    replyToId: "m",
    sendMode: "static",
    sendStatic: async () => { throw new Error("send failed"); },
  });
  await ctrl.onPartialReply("内容");
  await ctrl.finalize();
  assert.strictEqual(ctrl.currentPhase, "failed");
});

console.log("\n=== 3. shouldUseStreaming ===");

await test("shouldUseStreaming 配置矩阵", async () => {
  const acct = (streaming: unknown) => ({ config: { streaming } }) as any;
  assert.strictEqual(shouldUseStreaming(acct({ mode: "partial" }), "c2c"), true);
  assert.strictEqual(shouldUseStreaming(acct({ mode: "partial", sendMode: "static" }), "c2c"), true);
  assert.strictEqual(shouldUseStreaming(acct({ mode: "off" }), "c2c"), false);
  assert.strictEqual(shouldUseStreaming(acct(undefined), "c2c"), false);
  assert.strictEqual(shouldUseStreaming(acct({ mode: "partial" }), "group"), false, "群聊不支持流式");
});

// ============ 结果 ============

console.log(`\n========================================`);
console.log(`  总计: ${passed + failed} | ✅ 通过: ${passed} | ❌ 失败: ${failed}`);
if (failedTests.length > 0) {
  console.log(`  失败用例:`);
  for (const t of failedTests) console.log(`    - ${t}`);
}
console.log(`========================================\n`);

process.exit(failed > 0 ? 1 : 0);
