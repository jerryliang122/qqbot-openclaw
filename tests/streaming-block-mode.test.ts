/**
 * partial 态（框架块流式）回归测试
 *
 * 覆盖 2026-10-23 三态重构引入的新行为：
 * 1. 插件声明的 `streaming.blockStreamingCoalesceDefaults`（消除 coalescer 延迟）
 * 2. partial 态中间块的被动回复配额守卫（为 final 预留槽位）
 * 3. `deliverReply` 的 `passiveOnly`：中间块不降级主动、不走 debounce
 *
 * 运行方式: npx tsx tests/streaming-block-mode.test.ts
 */

import assert from "node:assert";
import { qqbotPlugin } from "../src/channel.js";
import {
  hasPassiveBlockSlot,
  BLOCK_QUOTA_RESERVE,
} from "../src/outbound/block-quota.js";
import {
  deliverReply,
  type DeliverContext,
} from "../src/outbound/deliver-pipeline.js";

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void> | void) {
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

// ============ 1. 插件声明的 coalesce 默认值 ============

console.log("\n=== 1. 插件级 coalesce 默认值 ===");

await test("qqbotPlugin 声明 streaming.blockStreamingCoalesceDefaults", () => {
  const streaming = (qqbotPlugin as any).streaming;
  assert.ok(streaming, "qqbotPlugin 应带 streaming 字段");
  assert.ok(streaming.blockStreamingCoalesceDefaults, "应声明 blockStreamingCoalesceDefaults");
  assert.strictEqual(streaming.blockStreamingCoalesceDefaults.minChars, 1, "minChars=1 → 块即时 flush");
  assert.strictEqual(streaming.blockStreamingCoalesceDefaults.idleMs, 0, "idleMs=0 → 不等空闲窗口");
});

await test("coalesce 默认值不等于框架默认（800/1000），否则延迟复现", () => {
  const d = (qqbotPlugin as any).streaming.blockStreamingCoalesceDefaults;
  // 框架默认：DEFAULT_BLOCK_STREAM_MIN=800 / DEFAULT_BLOCK_STREAM_COALESCE_IDLE_MS=1000
  assert.notStrictEqual(d.minChars, 800, "不能沿用框架默认 minChars");
  assert.notStrictEqual(d.idleMs, 1000, "不能沿用框架默认 idleMs");
});

// ============ 2. 配额守卫 ============

console.log("\n=== 2. 中间块被动回复配额守卫 ===");

await test("BLOCK_QUOTA_RESERVE = 0（partial 态的 final 由框架自动丢，不额外占配额）", () => {
  assert.strictEqual(BLOCK_QUOTA_RESERVE, 0);
});

await test("额度充足时有被动槽", () => {
  assert.strictEqual(hasPassiveBlockSlot(4), true);
  assert.strictEqual(hasPassiveBlockSlot(3), true);
  assert.strictEqual(hasPassiveBlockSlot(1), true);
});

await test("额度耗尽时无被动槽（降级主动发送，内容仍必达）", () => {
  assert.strictEqual(hasPassiveBlockSlot(0), false);
  assert.strictEqual(hasPassiveBlockSlot(-1), false);
});

// ============ 3. deliverReply 的 passiveOnly ============

console.log("\n=== 3. deliverReply passiveOnly ===");

function makeCtx(opts: { withDebouncer?: boolean } = {}) {
  const sent: Array<{ to: string; text: string; passiveOnly?: boolean }> = [];
  const debounced: string[] = [];
  const ctx: DeliverContext = {
    qualifiedTarget: "qqbot:c2c:USER_1",
    accountId: "test",
    replyToId: "MSG_1",
    sendText: async (to, text, sendOpts) => {
      sent.push({ to, text, passiveOnly: sendOpts?.passiveOnly });
      return { messageId: "MSG_OUT" } as any;
    },
    sendMedia: async () => ({ messageId: "MSG_MEDIA" }) as any,
    ...(opts.withDebouncer
      ? {
          debouncer: {
            enabled: true,
            enqueue: async (_to: string, text: string) => {
              debounced.push(text);
            },
          } as any,
        }
      : {}),
  };
  return { ctx, sent, debounced };
}

await test("passiveOnly 的文本发送带上 passiveOnly 标记", async () => {
  const { ctx, sent } = makeCtx();
  await deliverReply({ text: "块正文" }, undefined, ctx, { passiveOnly: true });
  assert.strictEqual(sent.length, 1, "应发送一条");
  assert.strictEqual(sent[0]!.text, "块正文");
  assert.strictEqual(sent[0]!.passiveOnly, true, "必须带 passiveOnly（配额不可用时不得降级主动）");
});

await test("未标 passiveOnly 的文本不带该标记（final 仍可降级主动）", async () => {
  const { ctx, sent } = makeCtx();
  await deliverReply({ text: "最终正文" }, undefined, ctx);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0]!.passiveOnly, undefined);
});

await test("passiveOnly 不走 debounce（合并会引入延迟且无法保证落在配额内）", async () => {
  const { ctx, sent, debounced } = makeCtx({ withDebouncer: true });
  await deliverReply({ text: "块正文" }, undefined, ctx, { passiveOnly: true });
  assert.strictEqual(debounced.length, 0, "passiveOnly 不应进 debouncer");
  assert.strictEqual(sent.length, 1, "应直接发送");
});

await test("非 passiveOnly 的文本仍走 debounce", async () => {
  const { ctx, sent, debounced } = makeCtx({ withDebouncer: true });
  await deliverReply({ text: "最终正文" }, undefined, ctx);
  assert.strictEqual(debounced.length, 1, "final 仍走 debounce");
  assert.strictEqual(sent.length, 0, "debouncer 路径不直接 sendText");
});

await test("空文本不发送", async () => {
  const { ctx, sent } = makeCtx();
  await deliverReply({ text: "   " }, undefined, ctx, { passiveOnly: true });
  assert.strictEqual(sent.length, 0, "空块不发空消息");
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
