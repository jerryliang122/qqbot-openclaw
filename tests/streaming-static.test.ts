/**
 * StreamingController 静态下发通道 (sendMode: 'static') 测试
 *
 * 验证：partial 接收逻辑保持不变，仅把文本下发通道从 QQ 流式打印机
 * (openStream/session.update/session.complete) 替换为流结束时一条普通 sendText。
 *
 * 同时对 stream 模式做最小回归，确保默认行为不变。
 *
 * 运行方式:  npx tsx tests/streaming-static.test.ts
 */

import assert from "node:assert";

// ============ Mock 记录 ============

/** 记录流式 API 调用：openStream 次数、update 内容、complete 次数 */
let openStreamCalls = 0;
let streamUpdates: string[] = [];
let streamCompletes = 0;

/** 记录 sendStatic 调用 */
let staticSendCalls: string[] = [];

function resetMocks(): void {
  openStreamCalls = 0;
  streamUpdates = [];
  streamCompletes = 0;
  staticSendCalls = [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 等待 controller 串行队列消费完 */
async function flush(): Promise<void> {
  await sleep(20);
}

// ============ Mock gateway / session ============

function createMockGateway() {
  return {
    openStream() {
      openStreamCalls++;
      return {
        update: async (text: string) => {
          streamUpdates.push(text);
        },
        complete: async () => {
          streamCompletes++;
          return { id: "stream-done", timestamp: Date.now() };
        },
      };
    },
  };
}

// ============ Controller 工厂 ============

const { StreamingController } = await import("../src/outbound/streaming-controller.ts");
type Ctrl = InstanceType<typeof StreamingController>;

const logs: string[] = [];

interface MakeOpts {
  sendMode?: "stream" | "static";
  sendStatic?: (text: string) => Promise<void>;
}

function makeController(opts: MakeOpts = {}): Ctrl {
  logs.length = 0;
  const gateway = createMockGateway() as any;
  return new StreamingController({
    gateway,
    target: { scope: "c2c", targetId: "user-1", msgId: "msg-1" },
    accountId: "test",
    replyToId: "msg-1",
    log: {
      info: (m: string) => logs.push(`[INFO] ${m}`),
      error: (m: string) => logs.push(`[ERROR] ${m}`),
      warn: (m: string) => logs.push(`[WARN] ${m}`),
      debug: () => {},
    },
    sendMode: opts.sendMode,
    sendStatic: opts.sendStatic ?? (async (text: string) => { staticSendCalls.push(text); }),
  });
}

// ============ 测试框架 ============

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  resetMocks();
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
    const relevant = logs.filter((l) => !l.includes("[DEBUG]")).slice(-8);
    if (relevant.length) {
      console.log(`     --- 日志 ---`);
      for (const l of relevant) console.log(`       ${l}`);
    }
    failed++;
    failedTests.push(name);
  }
}

// ============ 静态模式测试 ============

console.log("\n=== 1. 静态模式 (sendMode: 'static') ===");

await test("静态: 多次 partial 仅累积，不调用 openStream", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.onPartialReply("你好世界，这是测试");

  assert.strictEqual(openStreamCalls, 0, "静态模式不应打开流式会话");
  assert.strictEqual(streamUpdates.length, 0, "静态模式不应调用 session.update");
  assert.strictEqual(staticSendCalls.length, 0, "累积阶段不应调用 sendStatic");
  assert.strictEqual(ctrl.hasStarted, true, "hasStarted 应为 true");
  assert.strictEqual(ctrl.hasSentChunks, true, "hasSentChunks 应为 true");
});

await test("静态: finalize 时一次性发送累积的完整文本", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(staticSendCalls.length, 1, "应仅发送 1 条普通消息");
  assert.strictEqual(staticSendCalls[0], "你好世界", "内容应为最后一次累积的全量文本");
  assert.strictEqual(openStreamCalls, 0, "不应调用任何流式 API");
  assert.strictEqual(ctrl.currentPhase, "done", "终态应为 done");
  assert.strictEqual(ctrl.shouldFallbackToStatic, false, "不应触发降级");
});

await test("静态: 空文本不发送内容，0 分片触发降级", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("");
  await ctrl.onPartialReply("");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(staticSendCalls.length, 0, "空文本不应发送");
  assert.strictEqual(ctrl.hasSentChunks, false, "空文本不应产生分片");
  assert.strictEqual(ctrl.shouldFallbackToStatic, true, "0 分片应触发降级兜底");
});

await test("静态: markDeliveredExternally 阻止降级（ask_user 场景）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 模型直接调 ask_user，无流式文本
  ctrl.markDeliveredExternally();
  assert.strictEqual(ctrl.shouldFallbackToStatic, false, "外部投递后不应降级");

  await ctrl.finalize();
  await flush();
  assert.strictEqual(ctrl.currentPhase, "done", "应为 done 终态");
  assert.strictEqual(staticSendCalls.length, 0, "ask_user 场景不触发 sendStatic");
});

await test("静态: onAssistantMessageStart 第一段开始时无内容可 flush（空跳过）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 第一段开始时框架回调 onAssistantMessageStart，但尚未累积任何文本
  await ctrl.flushSegment();
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "第一段开始无累积内容，不应发送");
  assert.strictEqual(ctrl.currentPhase, "idle", "应为 idle 态，等待首个 partial");
});

await test("静态: onAssistantMessageStart 触发分段 — 旧文本立即发，不进终态", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 段A 累积（模拟 onPartialReply 持续增长）
  await ctrl.onPartialReply("正在查询您的邮件");
  await flush();
  await ctrl.onPartialReply("正在查询您的邮件，请稍候");
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "累积阶段不应发送");
  assert.strictEqual(ctrl.isTerminal, false, "累积阶段应为非终态");

  // 工具调用后，框架回调 onAssistantMessageStart → flushSegment 发出段A
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["正在查询您的邮件，请稍候"], "段A 应在 flushSegment 时立即发送");
  assert.strictEqual(ctrl.isTerminal, false, "flushSegment 后应保持非终态，可继续累积新段");

  // 段B 累积（新一段，从短重新开始）
  await ctrl.onPartialReply("查到3封邮件");
  await flush();
  assert.strictEqual(staticSendCalls.length, 1, "段B 累积阶段不应额外发送");

  // 兜底 finalize 发最后一段
  await ctrl.finalize();
  assert.deepStrictEqual(staticSendCalls, ["正在查询您的邮件，请稍候", "查到3封邮件"], "最后一段应在 finalize 发送");
  assert.strictEqual(ctrl.currentPhase, "done", "finalize 后应为 done");
});

await test("静态: 多工具调用多段推理 — 工具开始时即时 flush（无延迟）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 精确模拟用户报告的真实场景（修复后时序）：
  //   用户问题 → 中途文本A(推理) → deliver(tool)→flushSegment立即发A → [工具执行]
  //   → 中途文本B(推理) → deliver(tool)→flushSegment立即发B → [工具执行]
  //   → 最终回复C(推理) → 兜底finalize发C
  //
  // 关键：flushSegment 在工具【开始时】(deliver kind=tool) 触发，而非工具结束后
  // (onAssistantMessageStart)。对齐 telegram prepareAnswerLaneForToolProgress。
  // 这样工具执行期间用户已收到前置文本，不再等到下一段推理。

  // 段A：累积（第一段开始 flushSegment 空跳过）
  await ctrl.flushSegment();
  await ctrl.onPartialReply("中途文本A");
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "段A 累积期间不应发送");

  // 工具1开始 → flushSegment 立即发段A（不等工具执行完）
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["中途文本A"], "段A 应在工具开始时立即发送");

  // [工具1执行期间] —— 用户已收到段A，无延迟

  // 段B：新一段推理累积
  await ctrl.onPartialReply("中途文本B");
  await flush();

  // 工具2开始 → flushSegment 立即发段B
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["中途文本A", "中途文本B"], "段B 应在工具开始时立即发送");

  // 最终回复C 累积
  await ctrl.onPartialReply("最终回复C");
  await flush();

  // turn 结束兜底 finalize 发段C
  await ctrl.finalize();

  // 关键断言：逐段即时，顺序严格，无粘连
  assert.deepStrictEqual(
    staticSendCalls,
    ["中途文本A", "中途文本B", "最终回复C"],
    "应按段顺序逐条发送：A/B在各自工具开始时立即发，C在兜底finalize发",
  );
  assert.strictEqual(ctrl.currentPhase, "done", "最终应为 done");
  assert.strictEqual(openStreamCalls, 0, "静态模式全程不应调用 openStream");
});

await test("静态: onToolStart(工具开始前)触发 flush - 消除文本延迟", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 修复后真实场景（对齐 telegram 模式一：disableBlockStreaming:true 绕开 coalescer）：
  //   用户问题 -> 中途文本A(推理累积) -> onToolStart(工具开始前)->flushSegment 立即发A
  //   -> [工具执行] -> 中途文本B(推理累积) -> onToolStart(工具开始前)->flushSegment 立即发B
  //   -> [工具执行] -> 最终回复C(推理累积) -> 兜底finalize发C
  //
  // 关键区别：flush 由 onToolStart（工具开始执行前）触发，绕开 SDK block streaming 的
  // coalescer（minChars=800/idleMs=1000 buffer 会造成延迟）。controller 不关心触发源，
  // 这里直接调 flushSegment() 模拟 dispatch 层 onToolStart 回调。

  // 段A：累积（模拟 onPartialReply 持续增长）
  await ctrl.onPartialReply("正在查询");
  await flush();
  await ctrl.onPartialReply("正在查询您的邮件");
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "段A 累积期间不应发送");

  // onToolStart(工具开始前) -> flushSegment 立即发段A（不等工具执行完，不等下一段）
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["正在查询您的邮件"], "段A 应在 onToolStart 立即发送");

  // [工具执行期间] -- 用户已收到段A

  // 段B：新一段推理累积（onPartialReply 重置，从短重新开始）
  await ctrl.onPartialReply("查到3封邮件");
  await flush();

  // onToolStart(工具开始前) -> flushSegment 立即发段B
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(
    staticSendCalls,
    ["正在查询您的邮件", "查到3封邮件"],
    "段B 应在 onToolStart 立即发送，无需等待工具执行完或下一段",
  );

  // 最终回复C 累积
  await ctrl.onPartialReply("最终回复C");
  await flush();

  // turn 结束兜底 finalize 发段C
  await ctrl.finalize();

  assert.deepStrictEqual(
    staticSendCalls,
    ["正在查询您的邮件", "查到3封邮件", "最终回复C"],
    "每段在 onToolStart/finalize 立即发送，无堆积无延迟",
  );
  assert.strictEqual(ctrl.currentPhase, "done", "最终应为 done");
});

await test("静态: 纯长文本段(无工具调用)靠 finalize 整段发", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // static 模式设计取舍：纯长文本回复（无工具调用打断）没有 onToolStart 边界，
  // 文本会一直累积到 turn 结束，由 finalize 一次性发送（整段一条消息）。
  // 这是符合预期的行为——static 模式本就是"整段文本一次发"。

  // 模型持续生成一段长文本，期间无 onToolStart
  await ctrl.onPartialReply("这是一段");
  await flush();
  await ctrl.onPartialReply("这是一段较长的");
  await flush();
  await ctrl.onPartialReply("这是一段较长的完整回复文本");
  await flush();
  assert.strictEqual(staticSendCalls.length, 0, "纯文本累积期间不应发送（无工具边界）");

  // turn 结束 finalize 把整段一次发出
  await ctrl.finalize();
  assert.deepStrictEqual(
    staticSendCalls,
    ["这是一段较长的完整回复文本"],
    "纯长文本段应在 finalize 时整段发送",
  );
  assert.strictEqual(ctrl.currentPhase, "done", "最终应为 done");
});

await test("静态: 未 flush 时多段累积不丢失（修复日志中 flush183/send304 差异）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 模拟日志中观察到的 bug：部分段落未及时 flush，被后续 onPartialReply 覆盖后
  // 混入最终 static send。修复后每个工具边界都 flush，不应出现此情况。
  // 此用例验证：即使某段没 flush 就来了下一段，controller 的 static 分支
  // （前缀不匹配->覆盖）行为正确，且最终 finalize 只发最后一段（已被覆盖的丢失是
  // flush 缺失的预期后果，提示上层必须保证每段都 flush）。

  // 段A 累积
  await ctrl.onPartialReply("段A文本");
  await flush();

  // 段A 没有 flush 就来了段B（模拟 block 信号缺失的降级场景）
  await ctrl.onPartialReply("段B文本");
  await flush();
  // 段A 被覆盖为段B（static 模式前缀不匹配->覆盖，不发送）

  // 段B flush
  await ctrl.flushSegment();
  await flush();
  assert.deepStrictEqual(staticSendCalls, ["段B文本"], "段A 未 flush 被覆盖，仅发段B");

  // 段C 累积 + finalize
  await ctrl.onPartialReply("段C文本");
  await flush();
  await ctrl.finalize();
  assert.deepStrictEqual(
    staticSendCalls,
    ["段B文本", "段C文本"],
    "段B 在 flush 时发，段C 在 finalize 发",
  );
});

await test("静态: 两段长度相等不粘连（启发式缺陷已修复）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 此前靠"文本长度回退"启发式时，两段长度相等（如"中途文本2"→"中途文本3"）
  // 会被误判为"模型重写尾部"而追加成"中途文本23"。改用 onAssistantMessageStart
  // 后，分段由框架明确信号驱动，不再依赖长度启发式。
  await ctrl.onPartialReply("中途文本2");
  await flush();
  // 工具调用后框架回调 onAssistantMessageStart → 正确分段
  await ctrl.flushSegment();
  await flush();
  await ctrl.onPartialReply("中途文本3");
  await flush();
  await ctrl.finalize();

  assert.deepStrictEqual(
    staticSendCalls,
    ["中途文本2", "中途文本3"],
    "两段长度相等也能正确分段，不粘连",
  );
});

await test("静态: abort 时不发送文本", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("正在生成…");
  await flush();
  await ctrl.abort("user_cancel");

  assert.strictEqual(staticSendCalls.length, 0, "abort 不应发送文本");
  assert.strictEqual(ctrl.currentPhase, "failed", "abort 后应为 failed");
});

await test("静态: sendStatic 抛错 → 标记 failed", async () => {
  const ctrl = makeController({
    sendMode: "static",
    sendStatic: async () => { throw new Error("send error"); },
  });

  await ctrl.onPartialReply("内容");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(ctrl.currentPhase, "failed", "sendStatic 失败应标记 failed");
});

// ============ issue #44：static 模式 final 正文补发 ============

console.log("\n=== 3. issue #44：final 正文未被承接时的整段补发 ===");

await test("static: 末段无 partial → final 文本整段补发（issue #44 核心回归）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  // 5 段工具前置文本，每段在工具边界 flush（issue 日志中的 5 条碎片）
  for (const seg of ["segA", "segB", "segC", "segD", "segE"]) {
    await ctrl.onPartialReply(seg);
    await flush();
    await ctrl.flushSegment();
    await flush();
  }
  assert.strictEqual(staticSendCalls.length, 5, "5 段应已全部发出");

  // 最终 600+ 字正文：框架没有送来任何 partial，只有 final payload 文本
  const FINAL = "最终总结正文".repeat(60) + "。";
  await ctrl.absorbFinalText(FINAL);
  await flush();

  assert.strictEqual(staticSendCalls.length, 6, "final 正文应被补发为第 6 条");
  assert.strictEqual(
    staticSendCalls[5],
    FINAL,
    `补发的应是 final 全文，实际: ${JSON.stringify(staticSendCalls[5]?.slice(0, 20))}`,
  );
  assert.strictEqual(
    ctrl.computeUnsentRemainder(FINAL),
    "",
    "账本应随补发推进，上层差量兜底不得重复补发",
  );
});

await test("static: 补发后 finalize 不重复发、终态原因可辨识", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("segA");
  await flush();
  await ctrl.flushSegment();
  await flush();

  const FINAL = "最终正文".repeat(80);
  await ctrl.absorbFinalText(FINAL);
  await flush();
  await ctrl.finalize();
  await flush();

  assert.strictEqual(staticSendCalls.length, 2, "补发后 finalize 不应再发一次");
  assert.strictEqual(ctrl.currentPhase, "done", "应为 done");
  assert.ok(
    logs.some((l) => l.includes("rescued undelivered final text")),
    "应留下补发 INFO 日志",
  );
  assert.ok(
    logs.some((l) => l.includes("finalize:rescued")),
    "终态原因应是 finalize:rescued 而非静默的 finalize:fallback",
  );
});

await test("static: 补发 sendStatic 抛错 → failed（不吞错）", async () => {
  let call = 0;
  const ctrl = makeController({
    sendMode: "static",
    sendStatic: async () => {
      call++;
      // 第 1 次（flush 段A）成功，第 2 次（补发 final）失败
      if (call >= 2) throw new Error("rescue send error");
    },
  });

  await ctrl.onPartialReply("segA");
  await flush();
  await ctrl.flushSegment();
  await flush();

  await ctrl.absorbFinalText("最终正文".repeat(50));
  await flush();

  assert.strictEqual(ctrl.currentPhase, "failed", "补发失败应标记 failed");
  assert.strictEqual(
    ctrl.shouldSuppressFinalTailFallback,
    true,
    "static 失败=正文未送达，应抑制 footer 补发（不得只见尾巴不见正文）",
  );
});

await test("static: final 是缓冲的扩展（footer）→ 仍走合并，不整段重发", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("这是回答全文");
  await flush();
  await ctrl.absorbFinalText("这是回答全文\nUsage: 66k in / 9.8k out");
  await flush();
  await ctrl.finalize();
  await flush();

  assert.strictEqual(staticSendCalls.length, 1, "footer 应并入正文一条发出");
  assert.strictEqual(
    staticSendCalls[0],
    "这是回答全文\nUsage: 66k in / 9.8k out",
    "应合并为一条",
  );
});

await test("static: final 是多段拼接形态 → 只切出未流出的末段增量", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("段A文本");
  await flush();
  await ctrl.flushSegment();
  await flush();
  // 末段无 partial，但 final 文本里含最后一段的内容（多段拼接形态）
  await ctrl.absorbFinalText("段A文本\n段B文本");
  await flush();
  await ctrl.finalize();
  await flush();

  assert.strictEqual(staticSendCalls.length, 2, "A 已发，B 应作为增量发出");
  assert.strictEqual(staticSendCalls[1], "段B文本", "只应补出末段增量，不整段重发");
});

await test("static: 缓冲非空且 final 无关（模型重写）→ 维持丢弃", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("正在生成的内容");
  await flush();
  // 缓冲非空说明本段已流出内容，final 与之无关属模型重写 → 维持现状不补发
  await ctrl.absorbFinalText("完全不同的最终回答");
  await flush();
  await ctrl.finalize();
  await flush();

  assert.strictEqual(staticSendCalls.length, 1, "只应发出缓冲内容一次");
  assert.strictEqual(staticSendCalls[0], "正在生成的内容", "不应补发被重写的 final");
  assert.ok(
    logs.some((l) => l.includes("rewritten mid-turn")),
    "模型重写应留 INFO 日志便于排障",
  );
});

await test("static: 已取消的 turn 不补发 final（signal 中止）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("segA");
  await flush();
  await ctrl.flushSegment();
  await flush();

  const ac = new AbortController();
  const pending = ctrl.absorbFinalText("最终正文".repeat(50), { signal: ac.signal });
  ac.abort();
  await pending;
  await flush();

  assert.strictEqual(staticSendCalls.length, 1, "已取消的 turn 不得补发");
});

await test("static: final payload 幂等（框架重投同一文本不重复发）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("segA");
  await flush();
  await ctrl.flushSegment();
  await flush();

  const FINAL = "最终正文".repeat(50);
  await ctrl.absorbFinalText(FINAL);
  await flush();
  await ctrl.absorbFinalText(FINAL);
  await flush();

  assert.strictEqual(staticSendCalls.length, 2, "同一 final 重投不应重复发送");
});

await test("static: final 只有空白 → 不补发（不白烧被动配额）", async () => {
  const ctrl = makeController({ sendMode: "static" });

  await ctrl.onPartialReply("segA");
  await flush();
  await ctrl.flushSegment();
  await flush();

  await ctrl.absorbFinalText("   \n  ");
  await flush();
  await ctrl.finalize();
  await flush();

  assert.strictEqual(staticSendCalls.length, 1, "空白 final 不应作为一条消息发出");
});

// ============ Stream 模式回归（默认行为不变） ============

console.log("\n=== 2. Stream 模式回归（默认行为） ===");

await test("stream: 多次 partial → openStream + update，finalize complete", async () => {
  const ctrl = makeController({ sendMode: "stream" });

  await ctrl.onPartialReply("你好");
  await flush();
  await ctrl.onPartialReply("你好世界");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(openStreamCalls, 1, "stream 模式应打开 1 个流式会话");
  assert.ok(streamUpdates.length >= 2, `应至少 2 次 update，实际 ${streamUpdates.length}`);
  assert.strictEqual(streamCompletes, 1, "finalize 应 complete 一次");
  assert.strictEqual(staticSendCalls.length, 0, "stream 模式不应调用 sendStatic");
  assert.strictEqual(ctrl.currentPhase, "done", "终态应为 done");
});

await test("默认（无 sendMode）= stream 行为，向后兼容", async () => {
  const ctrl = makeController(); // 不传 sendMode

  await ctrl.onPartialReply("hi");
  await flush();
  await ctrl.finalize();

  assert.strictEqual(openStreamCalls, 1, "默认应为 stream 模式");
  assert.strictEqual(staticSendCalls.length, 0, "默认不应走静态");
});

await test("stream: final 与流内内容无关（模型重写）→ 维持丢弃 + INFO 留痕", async () => {
  const ctrl = makeController({ sendMode: "stream" });

  await ctrl.onPartialReply("原始回答");
  await flush();
  // dispatch 的真实顺序：absorb 先于 finalize（stream 模式在 deliver(final)
  // 里先并入尾巴再收尾），此时控制器尚未终态
  await ctrl.absorbFinalText("完全不同的最终回答");
  await flush();
  const updatesBefore = streamUpdates.length;
  await ctrl.finalize();
  await flush();

  assert.strictEqual(
    streamUpdates.length,
    updatesBefore,
    "stream 下补发会与流内已显示内容重复，维持丢弃",
  );
  assert.strictEqual(staticSendCalls.length, 0, "stream 模式不应调用 sendStatic");
  assert.ok(
    logs.some((l) => l.includes("final text unrelated to streamed content")),
    "丢弃应留 INFO 日志便于排障",
  );
});

await test("matchFinalText: 三态分类（identical / extension / unrelated）", async () => {
  const ctrl = makeController({ sendMode: "stream" });
  await ctrl.onPartialReply("已承接段落");
  await flush();
  await ctrl.finalize();
  await flush();

  assert.deepStrictEqual(
    ctrl.matchFinalText("已承接段落"),
    { kind: "identical" },
    "与已承接一致 → identical",
  );
  assert.deepStrictEqual(
    ctrl.matchFinalText("已承接段落\nUsage: 1 in / 2 out"),
    { kind: "extension", remainder: "\nUsage: 1 in / 2 out" },
    "已承接段的扩展 → extension",
  );
  assert.deepStrictEqual(
    ctrl.matchFinalText("毫不相干的最终回答"),
    { kind: "unrelated" },
    "毫无关系 → unrelated（issue #44 的指纹）",
  );
  // 对外语义不变：非 extension 一律空串
  assert.strictEqual(ctrl.computeUnsentRemainder("已承接段落"), "");
  assert.strictEqual(ctrl.computeUnsentRemainder("毫不相干的最终回答"), "");
});

// ============ 汇总 ============

console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
if (failed > 0) {
  console.log("失败用例:");
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
