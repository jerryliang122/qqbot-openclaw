/**
 * 平台互动事件扩展类型（INTERACTION_CREATE type 13-20）路由回归测试
 *
 * 官方 2026-07 文档把 INTERACTION_CREATE 扩容为统一「互动事件」，
 * 此前插件只认按钮（11/12）与配置面板（data.type 2001/2002），其余类型
 * 掉进 approval 分支被无意义 ack 后静默丢弃。本文件验证：
 *
 * - 仅 type=11/12 走按钮回调链（ack + question/approval）
 * - 13（消息反馈）/14/15/16（QQ 官方智能体平台）仅 INFO 留痕，不 ack
 * - 18/19/20（用户/群主动推送授权）留痕 + 记入 push-authorization-store，不 ack
 * - 未来未知类型：留痕不猜测，不 ack
 * - type=11 审批按钮与 data.type=2001 配置查询回归：新路由不破坏原有链路
 * - /bot-group-info 展示「推送授权事件」行
 *
 * 运行方式: npx tsx tests/interaction-extended-types.test.ts
 */
import assert from "node:assert";
import type { PluginLogger } from "../src/utils/plugin-logger.js";
import type { ResolvedQQBotAccount } from "../src/types.js";
import { handleInteraction } from "../src/gateway/event-handlers.js";
import {
  getPushAuthorizeFacts,
  _resetPushAuthorizeStore,
} from "../src/features/push-authorization-store.js";
import { botGroupInfo } from "../src/commands/bot-group-info.js";

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

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

// ── 测试辅助 ──

interface LogEntry { level: string; msg: string }

function makeLogger() {
  const entries: LogEntry[] = [];
  const mk = (): PluginLogger => ({
    info: (m) => entries.push({ level: "info", msg: m }),
    warn: (m) => entries.push({ level: "warn", msg: m }),
    error: (m) => entries.push({ level: "error", msg: m }),
    debug: () => {},
    child: () => mk(),
  });
  return { log: mk(), entries };
}

function makeAck() {
  const calls: Array<{ id: string; code?: number; data?: Record<string, unknown> }> = [];
  return {
    ack: async (id: string, code?: number, data?: Record<string, unknown>) => {
      calls.push({ id, code, data });
    },
    calls,
  };
}

let seq = 0;

/** 构造 SDK InteractionEvent 形态（type 与 data.type 一致，官方约定） */
function makeEvent(
  type: number,
  resolved: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return {
    id: `evt-${type}-${++seq}`,
    type,
    scene: "group",
    version: 1,
    data: { type, resolved },
    ...extra,
  } as any;
}

const ACCOUNT = { accountId: "default" } as unknown as ResolvedQQBotAccount;
const RUNTIME = {} as any;

function hasLog(entries: LogEntry[], level: string, substr: string): boolean {
  return entries.some((e) => e.level === level && e.msg.includes(substr));
}

// ======================================================================
//  Part 1: 授权事件（type 18/19/20）
// ======================================================================
group("1. 主动推送授权事件（18/19/20）");

await test("type=18 用户授权：不 ack，记入 store（按 user_openid），INFO 含 [push-auth]", async () => {
  _resetPushAuthorizeStore();
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const event = makeEvent(18, {
    authorize_data: { opt_scene: "setting", scope: "c2c_push" },
  }, { scene: "c2c", user_openid: "USER1" });

  await handleInteraction(event, ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0, "无需 ack");
  const facts = getPushAuthorizeFacts("default", "USER1");
  assert.ok(facts, "store 有记录");
  assert.strictEqual(facts!.lastEventType, 18);
  assert.strictEqual(facts!.scope, "c2c_push");
  assert.strictEqual(facts!.optScene, "setting");
  assert.strictEqual(facts!.eventCount, 1);
  assert.ok(hasLog(entries, "info", "[push-auth]"), "INFO 留痕 [push-auth]");
  assert.ok(hasLog(entries, "info", "c2c_push"), "日志含 scope");
});

await test("type=19 群授权：按 group_openid 记录，重复事件计数累加", async () => {
  _resetPushAuthorizeStore();
  const { log } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const mk = () => makeEvent(19, {
    authorize_data: { opt_scene: "setting", scope: "group_push" },
  }, { group_openid: "GROUP1", group_member_openid: "MEMBER1" });

  await handleInteraction(mk(), ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(mk(), ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0, "无需 ack");
  const facts = getPushAuthorizeFacts("default", "GROUP1");
  assert.ok(facts);
  assert.strictEqual(facts!.lastEventType, 19);
  assert.strictEqual(facts!.scope, "group_push");
  assert.strictEqual(facts!.eventCount, 2, "计数累加");
  // 账号隔离：另一账号查不到
  assert.strictEqual(getPushAuthorizeFacts("other", "GROUP1"), undefined);
});

await test("type=20 群授权状态变更：更新 lastEventType，不 ack", async () => {
  _resetPushAuthorizeStore();
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const event = makeEvent(20, {}, { group_openid: "GROUP2", group_member_openid: "MEMBER2" });

  await handleInteraction(event, ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0);
  const facts = getPushAuthorizeFacts("default", "GROUP2");
  assert.ok(facts);
  assert.strictEqual(facts!.lastEventType, 20);
  assert.strictEqual(facts!.scope, "", "无 authorize_data 时 scope 为空");
  assert.ok(hasLog(entries, "info", "type=20"));
});

await test("缺 peer 定位（无 group/user openid）的授权事件：仅留痕，store 不记", async () => {
  _resetPushAuthorizeStore();
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const event = makeEvent(19, { authorize_data: { scope: "group_push" } });

  await handleInteraction(event, ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0);
  assert.ok(hasLog(entries, "info", "[push-auth]"), "仍留痕");
});

await test("乱序补发：旧时间戳事件不回退最新事实，仅累计计数（评审意见 2）", async () => {
  _resetPushAuthorizeStore();
  const { log } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const newer = makeEvent(19, {
    authorize_data: { opt_scene: "setting", scope: "group_push" },
  }, { group_openid: "GROUP9", group_member_openid: "MEMBER9", timestamp: "2026-10-10T10:00:00+08:00" });
  const older = makeEvent(20, {}, {
    group_openid: "GROUP9", group_member_openid: "MEMBER9", timestamp: "2026-10-10T09:00:00+08:00",
  });

  await handleInteraction(newer, ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(older, ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0);
  const facts = getPushAuthorizeFacts("default", "GROUP9");
  assert.ok(facts);
  assert.strictEqual(facts!.lastEventType, 19, "旧事件不覆盖最新类型");
  assert.strictEqual(facts!.scope, "group_push", "旧事件不覆盖最新 scope");
  assert.strictEqual(facts!.eventCount, 2, "计数含乱序补发");
  assert.strictEqual(facts!.lastEventAt, Date.parse("2026-10-10T10:00:00+08:00"), "lastEventAt 保持较新事件时间");
});

await test("时序正常：新时间戳事件替换最新事实", async () => {
  _resetPushAuthorizeStore();
  const { log } = makeLogger();
  const { ack: ackFn } = makeAck();
  const t1 = makeEvent(19, { authorize_data: { scope: "group_push" } },
    { group_openid: "GROUP8", timestamp: "2026-10-10T09:00:00+08:00" });
  const t2 = makeEvent(20, { authorize_data: { scope: "group_push", opt_scene: "dialog" } },
    { group_openid: "GROUP8", timestamp: "2026-10-10T11:00:00+08:00" });

  await handleInteraction(t1, ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(t2, ACCOUNT, RUNTIME, log, ackFn);

  const facts = getPushAuthorizeFacts("default", "GROUP8");
  assert.strictEqual(facts!.lastEventType, 20);
  assert.strictEqual(facts!.optScene, "dialog");
  assert.strictEqual(facts!.lastEventAt, Date.parse("2026-10-10T11:00:00+08:00"));
});

await test("缺时间戳：按到达顺序应用（后者覆盖前者，lastEventAt 为 null）", async () => {
  _resetPushAuthorizeStore();
  const { log } = makeLogger();
  const { ack: ackFn } = makeAck();
  const e1 = makeEvent(19, { authorize_data: { scope: "group_push" } }, { group_openid: "GROUP7" });
  const e2 = makeEvent(20, {}, { group_openid: "GROUP7" });

  await handleInteraction(e1, ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(e2, ACCOUNT, RUNTIME, log, ackFn);

  const facts = getPushAuthorizeFacts("default", "GROUP7");
  assert.strictEqual(facts!.lastEventType, 20, "缺时间戳按到达顺序");
  assert.strictEqual(facts!.lastEventAt, null);
});

// ======================================================================
//  Part 2: 观测类事件（13/14/15/16）与未知类型
// ======================================================================
group("2. 反馈 / 智能体平台事件 / 未知类型");

await test("type=13 消息反馈：不 ack，INFO 含 opt/checked/msg，store 不记", async () => {
  _resetPushAuthorizeStore();
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const event = makeEvent(13, {
    feedback_opt: "LIKE",
    checked: 1,
    message_id: "MSG9",
  }, { scene: "c2c", user_openid: "USER1" });

  await handleInteraction(event, ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0);
  assert.ok(hasLog(entries, "info", "feedback"), "留痕 feedback");
  assert.ok(hasLog(entries, "info", "LIKE"));
  assert.strictEqual(getPushAuthorizeFacts("default", "USER1"), undefined, "反馈不进授权 store");
});

await test("type=14/15/16 智能体平台事件：不 ack，仅留痕", async () => {
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();

  await handleInteraction(makeEvent(14, {}, { user_openid: "U" }), ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(makeEvent(15, { action: "ENTER_STORY" }, { user_openid: "U" }), ACCOUNT, RUNTIME, log, ackFn);
  await handleInteraction(makeEvent(16, { action: "switch" }, { user_openid: "U" }), ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0, "三类均不 ack");
  assert.ok(hasLog(entries, "info", "agent-platform event type=14"));
  assert.ok(hasLog(entries, "info", "ENTER_STORY"));
  assert.ok(hasLog(entries, "info", "agent-platform event type=16"));
});

await test("INFO 日志标识符截断：不落完整 openid/消息 ID（评审意见 1）", async () => {
  const { log, entries } = makeLogger();
  const { ack: ackFn } = makeAck();
  const LONG_USER = "USER_OPENID_LONG_1234567890";
  const LONG_MSG = "ROBOT_MSG_ID_LONG_12345";

  const feedback = makeEvent(13, { feedback_opt: "LIKE", message_id: LONG_MSG },
    { scene: "c2c", user_openid: LONG_USER });
  await handleInteraction(feedback, ACCOUNT, RUNTIME, log, ackFn);

  const pushAuth = makeEvent(19, { authorize_data: { scope: "group_push" } },
    { group_openid: "GROUPOPENID_LONG_1", group_member_openid: "MEMBER_OPENID_LONG_1" });
  await handleInteraction(pushAuth, ACCOUNT, RUNTIME, log, ackFn);

  const dump = entries.map((e) => e.msg).join("\n");
  assert.ok(dump.includes("operator=USER_OPE…"), "operator 截断为前 8 字符");
  assert.ok(dump.includes("peer=GROUPOPE…"), "peer 截断");
  assert.ok(!dump.includes(LONG_USER), "不落完整 openid");
  assert.ok(!dump.includes(LONG_MSG), "不落完整消息 ID");
  assert.ok(!dump.includes("MEMBER_OPENID_LONG_1"), "不落完整群成员 openid");
});

await test("未知类型（如 21）：留痕不猜测，不 ack，不进按钮链", async () => {
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();

  await handleInteraction(makeEvent(21, {}, { group_openid: "G" }), ACCOUNT, RUNTIME, log, ackFn);

  assert.strictEqual(calls.length, 0);
  assert.ok(hasLog(entries, "info", "unhandled interaction type=21"));
});

// ======================================================================
//  Part 3: 原有链路回归（新路由不破坏按钮 / 配置面板）
// ======================================================================
group("3. type=11 按钮 / 2001 配置面板回归");

await test("type=11 审批按钮：仍走 approval 链（ack 一次 + 授权校验）", async () => {
  _resetPushAuthorizeStore();
  const { log, entries } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  // allowFrom 白名单不含操作者 → 未授权早退（不触达框架 resolve，纯本地路径）
  const runtime = {
    config: { current: () => ({ channels: { qqbot: { allowFrom: ["admin-user"] } } }) },
  } as any;
  const event = makeEvent(11, {
    button_data: "approve:v2:exec:abc-123:allow-once",
    button_id: "allow",
  }, { group_openid: "GROUP1", group_member_openid: "mallory" });

  await handleInteraction(event, ACCOUNT, runtime, log, ackFn);

  assert.strictEqual(calls.length, 1, "approval 链仍 ack 一次");
  assert.ok(hasLog(entries, "warn", "[approval] unauthorized"), "未授权 warn 留痕");
  assert.strictEqual(getPushAuthorizeFacts("default", "GROUP1"), undefined, "按钮路径不动 store");
});

await test("data.type=2001 配置查询：仍先于类型路由处理（ack 带 claw_cfg）", async () => {
  const { log } = makeLogger();
  const { ack: ackFn, calls } = makeAck();
  const runtime = { config: { current: () => ({}) } } as any;
  const event = makeEvent(11, {}, {
    data: { type: 2001, resolved: {} },
    group_openid: "GROUP1",
  });

  await handleInteraction(event, ACCOUNT, runtime, log, ackFn);

  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0]!.code, 0);
  assert.ok(calls[0]!.data?.claw_cfg, "ack 数据带 claw_cfg");
});

// ======================================================================
//  Part 4: /bot-group-info 展示
// ======================================================================
group("4. /bot-group-info 推送授权行");

await test("有授权事件：展示最近事件与累计次数", async () => {
  _resetPushAuthorizeStore();
  const { log } = makeLogger();
  const { ack: ackFn } = makeAck();
  await handleInteraction(
    makeEvent(19, { authorize_data: { opt_scene: "setting", scope: "group_push" } },
      { group_openid: "GROUP1", group_member_openid: "M1" }),
    ACCOUNT, RUNTIME, log, ackFn,
  );

  const cmd = botGroupInfo(ACCOUNT);
  const out = await (cmd.handler as any)({ message: { groupOpenid: "GROUP1" } });
  assert.ok(String(out).includes("推送授权事件"), "含推送授权行");
  assert.ok(String(out).includes("group_push"), "含 scope");
  assert.ok(String(out).includes("累计 1 次"), "含计数");
});

await test("无授权事件：展示未见提示", async () => {
  _resetPushAuthorizeStore();
  const cmd = botGroupInfo(ACCOUNT);
  const out = await (cmd.handler as any)({ message: { groupOpenid: "GROUP-X" } });
  assert.ok(String(out).includes("推送授权事件：未见"), "未见提示");
});

// ── 汇总 ──

console.log(`\n${"=".repeat(50)}`);
if (failed > 0) {
  console.log(`✗ ${failed} failed, ${passed} passed`);
  for (const name of failedTests) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`✓ all ${passed} tests passed`);
