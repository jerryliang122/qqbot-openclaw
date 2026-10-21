/**
 * stream-all（双道块驱动 v2）单元测试
 *
 * 覆盖 StreamingController 的 stream-all 模式：
 * - 文本段经 onTextBlock（deliver kind:'block'）按完成段进入滚动道，
 *   条目间以 markdown 分隔线隔开；token 级 partial 被防御性忽略
 * - 工具 item 事件追加 🔧 标题行（held 块随之提交进滚动道）
 * - final deliver：滚动道收尾 + 终稿道独立打字机（held 块被终稿取代）
 * - ✓ 收尾标记的前缀不可回改约束 / item 别名去重
 * - 终稿道失败 → finalLaneNeedsStaticFallback 静态兜底信号
 *
 * 运行方式: npx tsx tests/stream-all.test.ts
 */

import assert from "node:assert";
import { StreamingController } from "../src/outbound/streaming-controller.js";

// ============ fake gateway / session ============

interface FakeSession {
  updates: string[];
  completed: number;
  update: (text: string) => Promise<void>;
  complete: () => Promise<void>;
}

/**
 * @param failUpdatesFromSession 从第 N 个会话（0-based）起 update 全部失败；
 *                               undefined = 永不失败
 */
function makeFakeGateway(opts: { failUpdatesFromSession?: number } = {}) {
  const sessions: FakeSession[] = [];
  const gateway: any = {
    openStream: () => {
      const index = sessions.length;
      const s: FakeSession = {
        updates: [],
        completed: 0,
        update: async (text: string) => {
          if (opts.failUpdatesFromSession !== undefined && index >= opts.failUpdatesFromSession) {
            throw Object.assign(new Error("update API error"), { httpStatus: 400 });
          }
          s.updates.push(text);
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

function createController(opts: { failUpdatesFromSession?: number } = {}) {
  logs.length = 0;
  const { gateway, sessions } = makeFakeGateway({ failUpdatesFromSession: opts.failUpdatesFromSession });
  const ctrl = new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "USER_1" } as any,
    accountId: "test",
    replyToId: "MSG_1",
    sendMode: "stream-all",
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: (m: string) => logs.push(`[DEBUG] ${m}`),
    } as any,
  });
  return { ctrl, sessions };
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

console.log("stream-all (v2 block-driven) tests");

// ============ 用例 ============

await test("无工具单段：block 被终稿取代，仅终稿道一条打字机消息", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("你好，这是没有工具的回复");
  await ctrl.handleFinalDeliver("你好，这是没有工具的回复");

  assert.strictEqual(sessions.length, 1, "held 块被 final 取代，不产生滚动道");
  assert.strictEqual(sessions[0].completed, 1, "终稿道已收尾");
  assert.strictEqual(sessions[0].updates.at(-1), "你好，这是没有工具的回复");
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("有工具：滚动道（正文段+标题行，分隔线隔开）+ 终稿道独立打字机", async () => {
  const { ctrl, sessions } = createController();
  // 块1 → held
  await ctrl.onTextBlock("我先查一下天气。");
  // 工具1 start：held 提交进滚动道 + 标题行
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "web_search 天气", phase: "start" });
  // 块2 → held（工具1 end 先到，标题行补 ✓）
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", phase: "end", status: "completed" });
  await ctrl.onTextBlock("查到了，再看下空气。");
  // 工具2 start：块2 提交 + 标题行2
  await ctrl.onToolItem({ itemId: "tool:2", kind: "tool", title: "web_search 空气", phase: "start" });
  // 块3（终稿段）→ held
  await ctrl.onTextBlock("今天晴，空气优。");
  // final deliver：held 被终稿取代，滚动道收尾，终稿走第二条消息
  await ctrl.handleFinalDeliver("今天晴，空气优。");

  assert.strictEqual(sessions.length, 2, "滚动道 + 终稿道两条消息");
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(rolling.startsWith("我先查一下天气。"), "首条目无前导分隔线");
  assert.ok(rolling.includes("我先查一下天气。\n\n---\n\n🔧 web_search 天气 ✓"), "块1+标题1（含✓）以分隔线隔开");
  assert.ok(rolling.includes("---\n\n查到了，再看下空气。"), "块2 提交进滚动道");
  assert.ok(rolling.includes("---\n\n🔧 web_search 空气"), "标题行2");
  assert.ok(!rolling.includes("今天晴"), "终稿段绝不进滚动道");
  assert.strictEqual(sessions[0].completed, 1, "滚动道已收尾");

  const finalLane = sessions[1];
  assert.strictEqual(finalLane.updates.at(-1), "今天晴，空气优。", "终稿道末帧 = 终稿全文");
  assert.strictEqual(finalLane.completed, 1, "终稿道已收尾");
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("分隔线只在条目之间：首条目无前导 ---", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("第一段。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec ls", phase: "start" });
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(!rolling.startsWith("---"), "首条目无前导分隔线");
  assert.strictEqual(rolling, "第一段。\n\n---\n\n🔧 exec ls");
  await ctrl.handleFinalDeliver("完成");
});

await test("多段无工具：后继块证明前块是中间段，最后 held 被终稿取代", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("第一段。");
  await ctrl.onTextBlock("第二段。"); // 第一段被证明中间段 → 提交；第二段 held
  await ctrl.handleFinalDeliver("第二段的终稿文本。"); // held（第二段）被取代

  assert.strictEqual(sessions.length, 2);
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(rolling.includes("第一段。"), "滚动道含第一段");
  assert.ok(!rolling.includes("第二段"), "最后一段不进滚动道");
  assert.strictEqual(sessions[1].updates.at(-1), "第二段的终稿文本。");
});

await test("beginSegment：新段开始提前提交 held 块", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec ls", phase: "start" });
  await ctrl.onTextBlock("段二。");
  await ctrl.beginSegment(); // 新段开始 → 段二被证明中间段 → 提交
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(rolling.includes("段二。"), "held 块已提交进滚动道");
  await ctrl.handleFinalDeliver("段三终稿。");
  assert.ok(!sessions[0].updates.at(-1)!.includes("段三"), "终稿不进滚动道");
});

await test("✓ 收尾标记：标题行仍在末尾时可补，被遮蔽则 no-op", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec npm test", phase: "start" });
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", phase: "end", status: "completed" });
  assert.ok(sessions[0].updates.at(-1)!.endsWith("🔧 exec npm test ✓"), "末尾标题行补 ✓");

  await ctrl.onToolItem({ itemId: "t2", kind: "tool", title: "read src/x.ts", phase: "start" });
  const before = sessions[0].updates.at(-1)!;
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", phase: "end", status: "completed" });
  assert.strictEqual(sessions[0].updates.at(-1), before, "被遮蔽的 end 事件 no-op（前缀不可回改）");
  await ctrl.handleFinalDeliver("完成。");
});

await test("token 级 partial 被防御性忽略（v2 不接 partial）", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onPartialReply("不应出现的内容");
  await ctrl.onPartialReply("不应出现的内容继续");
  assert.strictEqual(sessions.length, 0, "partial 不产生任何滚动道动作");
  await ctrl.handleFinalDeliver("终稿。");
  assert.strictEqual(sessions.length, 1);
  assert.ok(!sessions[0].updates.at(-1)!.includes("不应出现"), "partial 内容不泄漏");
});

await test("非工具 item（preamble/status）不进滚动道", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "cmt-1", kind: "preamble", title: "Preamble", phase: "start" });
  await ctrl.onToolItem({ itemId: "fast-1", kind: "status", title: "Fast", phase: "update" });
  await ctrl.handleFinalDeliver("终稿。");
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(!rolling.includes("Preamble") && !rolling.includes("Fast"), "非工具 item 不产生条目");
  // held（段一）仍被 final 正确取代
  assert.strictEqual(sessions.length, 1, "无中间条目 → 只有终稿道");
});

await test("同一工具的重复 start/update 只追加一次标题行（别名去重）", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "tool:1", toolCallId: "call_1", kind: "tool", title: "exec build", phase: "start" });
  await ctrl.onToolItem({ itemId: "tool:1", toolCallId: "call_1", kind: "tool", title: "exec build", phase: "update" });
  await ctrl.onToolItem({ toolCallId: "call_1", kind: "tool", title: "exec build", phase: "update" });
  const rolling = sessions[0].updates.at(-1)!;
  assert.strictEqual(rolling.split("🔧").length - 1, 1, "只有一行工具标题");
  await ctrl.handleFinalDeliver("完成");
});

await test("终稿道首片即失败：finalLaneNeedsStaticFallback 置位，滚动道保持可见", async () => {
  const { ctrl, sessions } = createController({ failUpdatesFromSession: 1 });
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec npm test", phase: "start" });
  await ctrl.onTextBlock("段二。");
  await ctrl.handleFinalDeliver("最终答案。");

  assert.strictEqual(ctrl.currentPhase, "failed");
  assert.ok(ctrl.finalLaneNeedsStaticFallback, "终稿零字符落地 → 需要静态兜底");
  assert.strictEqual(sessions[0].completed, 1, "滚动道仍正常收尾");
  assert.ok(sessions[0].updates.length > 0, "滚动道内容保持可见");
});

await test("终稿道打字机分片：按 64 字切片递增推送", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("先干活。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec npm test", phase: "start" });
  await ctrl.onTextBlock("活干完了。");
  const finalText = "终稿".repeat(50); // 100 字 → 2 片
  await ctrl.handleFinalDeliver(finalText);

  const finalLane = sessions[1];
  assert.strictEqual(finalLane.updates.length, 2, "100 字按 64 字/片切成 2 片");
  assert.strictEqual(finalLane.updates[0].length, 64);
  assert.strictEqual(finalLane.updates[1], finalText);
});

await test("空终稿：滚动道收尾即可、不开终稿道", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec true", phase: "start" });
  await ctrl.handleFinalDeliver("   ");

  assert.strictEqual(sessions.length, 1, "空终稿不开第二条消息");
  assert.strictEqual(sessions[0].completed, 1);
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("已中止的 turn：final deliver no-op，不动滚动道", async () => {
  const { ctrl, sessions } = createController();
  await ctrl.onTextBlock("段一。");
  await ctrl.onToolItem({ itemId: "t1", kind: "tool", title: "exec sleep", phase: "start" });
  const before = sessions[0].updates.length;
  const ac = new AbortController();
  ac.abort();
  await ctrl.handleFinalDeliver("不该出现", { signal: ac.signal });
  assert.strictEqual(sessions[0].updates.length, before, "中止后不追加任何内容");
  assert.notStrictEqual(ctrl.currentPhase, "done");
});

await test("静态兜底访问器：非 stream-all 模式恒为 false", async () => {
  const { gateway } = makeFakeGateway();
  const ctrl = new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "U" } as any,
    accountId: "t",
    replyToId: "M",
  });
  assert.strictEqual(ctrl.finalLaneNeedsStaticFallback, false);
  assert.strictEqual(ctrl.isStreamAllMode, false);
});

// ============ 结果 ============

console.log(`\n${passed} passed, ${failed} failed`);
if (failedTests.length > 0) {
  console.log("failed:");
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
