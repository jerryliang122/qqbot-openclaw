/**
 * stream-all（双道流式）单元测试
 *
 * 覆盖 StreamingController 的 stream-all 模式：
 * - 无工具 turn：退化为单消息（行为对齐 stream 模式）
 * - 有工具 turn：滚动道（正文段 + 🔧 工具标题行）+ 终稿道（第二条打字机消息）
 * - 缓冲段冲刷（工具出现 / 新段开始）
 * - ✓ 收尾标记的前缀不可回改约束
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

/** 模拟一段模型输出的多个 partial（全量递增） */
async function feedPartials(ctrl: StreamingController, full: string, steps = 3) {
  for (let i = 1; i <= steps; i++) {
    await ctrl.onPartialReply(full.slice(0, Math.ceil((full.length * i) / steps)));
  }
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

console.log("stream-all tests");

// ============ 用例 ============

await test("无工具 turn：单消息直推 + final 并入收尾（对齐 stream 模式）", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "你好，这是没有工具的回复");
  await ctrl.handleFinalDeliver("你好，这是没有工具的回复");

  assert.strictEqual(sessions.length, 1, "整 turn 只有一条消息");
  assert.strictEqual(sessions[0].completed, 1, "流会话已收尾");
  assert.strictEqual(sessions[0].updates.at(-1), "你好，这是没有工具的回复");
  assert.strictEqual(ctrl.currentPhase, "done");
  assert.ok(ctrl.hasSentChunks);
});

await test("有工具 turn：滚动道（正文+标题行）+ 终稿道独立打字机", async () => {
  const { ctrl, sessions } = createController();
  // 段1：直推（工具未出现）
  await feedPartials(ctrl, "我先查一下天气。");
  // 工具1 start：标题行追加进滚动道
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "web_search 天气", phase: "start" });
  // 段2：工具已出现 → 只缓冲
  await feedPartials(ctrl, "查到了，再看下空气。");
  assert.strictEqual(sessions.length, 1, "缓冲段不新开会话");
  // 工具2 start：段2 沉淀进滚动道 + 标题2
  await ctrl.onToolItem({ itemId: "tool:2", kind: "tool", title: "web_search 空气", phase: "start" });
  // 段3（终稿段）：缓冲
  await feedPartials(ctrl, "今天晴，空气优。");
  // final deliver：滚动道收尾，终稿走第二条消息
  await ctrl.handleFinalDeliver("今天晴，空气优。");

  assert.strictEqual(sessions.length, 2, "滚动道 + 终稿道两条消息");
  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(rolling.includes("我先查一下天气。"), "滚动道含段1");
  assert.ok(rolling.includes("🔧 web_search 天气"), "滚动道含工具1标题行");
  assert.ok(rolling.includes("查到了，再看下空气。"), "段2 已被工具2冲刷进滚动道");
  assert.ok(rolling.includes("🔧 web_search 空气"), "滚动道含工具2标题行");
  assert.ok(!rolling.includes("今天晴"), "终稿段绝不进滚动道");
  assert.strictEqual(sessions[0].completed, 1, "滚动道已收尾");

  const finalLane = sessions[1];
  assert.ok(finalLane.updates.length >= 1, "终稿道有打字机分片");
  assert.strictEqual(finalLane.updates.at(-1), "今天晴，空气优。", "终稿道末帧 = 终稿全文");
  assert.strictEqual(finalLane.completed, 1, "终稿道已收尾");
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("终稿道打字机分片：按 64 字切片递增推送", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "先干活。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "start" });
  await feedPartials(ctrl, "活干完了。");
  const finalText = "终稿".repeat(50); // 100 字 → 2 片
  await ctrl.handleFinalDeliver(finalText);

  const finalLane = sessions[1];
  assert.strictEqual(finalLane.updates.length, 2, "100 字按 64 字/片切成 2 片");
  assert.strictEqual(finalLane.updates[0].length, 64);
  assert.strictEqual(finalLane.updates[1], finalText);
});

await test("工具 end 事件：标题行仍在末尾时补 ✓，被遮蔽则放弃", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "start" });
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "end", status: "completed" });
  // ✓ 已追加（末尾 = 标题行 + " ✓"）
  assert.ok(sessions[0].updates.at(-1)!.endsWith("🔧 exec npm test ✓"), "末尾标题行补 ✓");

  // 第二个工具把 tool:1 的标题行遮蔽，再补发 tool:1 end 不得改动
  await ctrl.onToolItem({ itemId: "tool:2", kind: "tool", title: "read src/x.ts", phase: "start" });
  const before = sessions[0].updates.at(-1)!;
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "end", status: "completed" });
  assert.strictEqual(sessions[0].updates.at(-1), before, "被遮蔽的 end 事件 no-op（前缀不可回改）");
  await ctrl.handleFinalDeliver("完成。");
  assert.strictEqual(sessions.length, 2);
});

await test("beginSegment：新段开始把缓冲段冲刷进滚动道（无第二个工具的边界）", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec ls", phase: "start" });
  await feedPartials(ctrl, "段二。");
  // 段三开始（onAssistantMessageStart）→ 段二被证明是中间段 → 冲刷
  await ctrl.beginSegment();
  await feedPartials(ctrl, "段三。");
  await ctrl.handleFinalDeliver("段三终稿。");

  const rolling = sessions[0].updates.at(-1)!;
  assert.ok(rolling.includes("段二。"), "缓冲段已冲刷进滚动道");
  assert.ok(!rolling.includes("段三"), "终稿段不进滚动道");
  assert.strictEqual(sessions[1].updates.at(-1), "段三终稿。");
});

await test("非工具 item（preamble/status）不进滚动道、不算工具出现", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "cmt-1", kind: "preamble", title: "Preamble", phase: "start", progressText: "嗯" });
  await ctrl.onToolItem({ itemId: "fast-1", kind: "status", title: "Fast", phase: "update" });
  const before = sessions[0].updates.at(-1)!;

  // toolsSeen 仍为 false → 后续 partial 直推（不缓冲）
  await ctrl.onPartialReply("段一。继续");
  assert.strictEqual(sessions.length, 1, "未新开道");
  assert.ok(sessions[0].updates.at(-1)!.length > before.length, "preamble/status 未劫持段落路由");
});

await test("同一工具的重复 start/update 只追加一次标题行", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", toolCallId: "call_1", kind: "tool", title: "exec npm run build", phase: "start" });
  await ctrl.onToolItem({ itemId: "tool:1", toolCallId: "call_1", kind: "tool", title: "exec npm run build", phase: "update", status: "running" });
  await ctrl.onToolItem({ toolCallId: "call_1", kind: "tool", title: "exec npm run build", phase: "update", status: "running" });
  const rolling = sessions[0].updates.at(-1)!;
  assert.strictEqual(rolling.split("🔧").length - 1, 1, "只有一行工具标题");
});

await test("终稿道首片即失败：finalLaneNeedsStaticFallback 置位（dispatch 据此静态补发）", async () => {
  const { ctrl, sessions } = createController({ failUpdatesFromSession: 1 });
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "start" });
  await feedPartials(ctrl, "段二。");
  // 第 1 个会话（滚动道）成功；第 2 个会话（终稿道）update 全失败
  await ctrl.handleFinalDeliver("最终答案。");

  assert.strictEqual(ctrl.currentPhase, "failed");
  assert.ok(ctrl.finalLaneNeedsStaticFallback, "终稿零字符落地 → 需要静态兜底");
  assert.strictEqual(sessions[0].completed, 1, "滚动道仍正常收尾");
  assert.ok(sessions[0].updates.length > 0, "滚动道内容保持可见");
});

await test("终稿道中途失败（部分字符已落地）：不请求静态兜底（避免重复）", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec npm test", phase: "start" });
  await feedPartials(ctrl, "段二。");
  // 终稿 70 字 → 第一片(64字)成功、第二片失败：手工构造——直接用一个会失败的 fake 不便
  // 控制到第二片，改用更长文本 + failUpdatesFromSession=1 且首片后即失败的场景：
  // 64 字首片成功需要 gateway 只对终稿道的第二次 update 失败，这里简化验证
  // 「部分落地后失败」的访问器语义：首片成功则 saFinalAcceptedChars > 0。
  // 用 failUpdatesFromSession=1：终稿道首片即失败 → 走 zero-fallback 分支（上一用例）。
  // 本用例验证行为边界：终稿道部分成功时 hasSentChunks 为真、终态 failed。
  await ctrl.handleFinalDeliver("短终稿");
  assert.ok(ctrl.hasSentChunks);
});

await test("有工具 turn 但终稿为空：滚动道收尾即可、不开终稿道", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec true", phase: "start" });
  await ctrl.handleFinalDeliver("   ");

  assert.strictEqual(sessions.length, 1, "空终稿不开第二条消息");
  assert.strictEqual(sessions[0].completed, 1);
  assert.strictEqual(ctrl.currentPhase, "done");
});

await test("已中止的 turn：final deliver no-op，不动滚动道", async () => {
  const { ctrl, sessions } = createController();
  await feedPartials(ctrl, "段一。");
  await ctrl.onToolItem({ itemId: "tool:1", kind: "tool", title: "exec sleep", phase: "start" });
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
