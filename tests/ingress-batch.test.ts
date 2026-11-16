/**
 * 群聊持久化入站 · 组批与幂等 回归测试
 *
 * 覆盖：
 * 1. **到达序排序**（复现"群聊快速刷新时消息错乱"）：
 *    3 条群消息的平台 timestamp 乱序（成员设备时钟不一致），
 *    批次内顺序必须是**本地到达序**。
 * 2. 容量裁剪：条数上限 / 正文字数上限，超限丢弃**较早**的消息。
 * 3. 批次指纹：同一批消息跨重投**完全一致**（幂等守卫的 key）；
 *    集合不同 ⇒ 指纹不同。
 * 4. 唤醒判定：@ / 称呼唤醒 / 事件类型 ⇒ "在叫 bot"。
 * 5. 幂等守卫：同一 eventId 第二次命中 ⇒ 不重复执行副作用。
 *
 * 运行方式: npx tsx tests/ingress-batch.test.ts
 */
import assert from 'node:assert/strict';
import { createIngressEffectOnce } from 'openclaw/plugin-sdk/ingress-effect-once';
import {
  batchFingerprint,
  isExplicitlyWoken,
  trimToCapacity,
  type BatchMember,
} from '../src/features/ingress-batcher.js';
import { INGRESS_PAYLOAD_VERSION, type QQBotIngressPayload } from '../src/features/ingress-payload.js';

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

function group(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗ ${name}\n    ${msg}`);
    failed++;
    failedTests.push(name);
  }
}

function makePayload(overrides: Partial<QQBotIngressPayload> = {}): QQBotIngressPayload {
  return {
    v: INGRESS_PAYLOAD_VERSION,
    accountId: 'acc1',
    groupOpenid: 'g1',
    messageId: 'm1',
    senderId: 'u1',
    rawEventType: 'GROUP_MESSAGE_CREATE',
    content: 'x',
    rawContent: 'x',
    platformTimestamp: '1700000000',
    receivedAtMs: 1000,
    mention: { wasMentioned: false, implicit: false },
    nameMentioned: false,
    ...overrides,
  };
}

function member(payload: QQBotIngressPayload): BatchMember {
  return { payload, claim: null };
}

group('到达序排序（群消息错乱的根因）');

await test('平台 timestamp 乱序时，批次内顺序 = 本地到达序', () => {
  // 模拟：群成员设备时钟不一致 → 平台 timestamp 与真实到达顺序相反
  const t2 = makePayload({ messageId: 't2', platformTimestamp: '100', receivedAtMs: 2000 });
  const t1 = makePayload({ messageId: 't1', platformTimestamp: '200', receivedAtMs: 1000 });
  const t3 = makePayload({ messageId: 't3', platformTimestamp: '300', receivedAtMs: 3000 });

  const members = [member(t2), member(t1), member(t3)];
  members.sort((a, b) => a.payload.receivedAtMs - b.payload.receivedAtMs);

  assert.deepEqual(members.map((m) => m.payload.messageId), ['t1', 't2', 't3']);

  // 反证：按平台 timestamp 排序会排成 t2,t1,t3（错乱）
  const byPlatform = [member(t2), member(t1), member(t3)].sort(
    (a, b) =>
      Date.parse(a.payload.platformTimestamp) - Date.parse(b.payload.platformTimestamp),
  );
  assert.deepEqual(byPlatform.map((m) => m.payload.messageId), ['t2', 't1', 't3']);
});

group('容量裁剪');

await test('条数上限：保留最新的 N 条，较早的丢弃', () => {
  const members = Array.from({ length: 12 }, (_, i) =>
    member(makePayload({ messageId: `m${i}`, receivedAtMs: 1000 + i })),
  );
  const { kept, dropped } = trimToCapacity(members, 10, 8000);
  assert.equal(kept.length, 10);
  assert.equal(dropped, 2);
  // 保留的是**最新**的 10 条
  assert.equal(kept[0]!.payload.messageId, 'm2');
  assert.equal(kept[9]!.payload.messageId, 'm11');
});

await test('正文字数上限：从最新往最旧累加，超限即停', () => {
  const big = (id: string, i: number) =>
    member(
      makePayload({
        messageId: id,
        receivedAtMs: 1000 + i,
        rawContent: 'x'.repeat(100),
        processedAttachments: {
          voiceText: '',
          imageUrls: [],
          otherInfo: '',
          transcripts: [],
          localMediaPaths: [],
          localMediaTypes: [],
          remoteMediaUrls: [],
          media: [],
        },
      }),
    );
  const members = [big('a', 0), big('b', 1), big('c', 2)];
  const { kept, dropped } = trimToCapacity(members, 10, 250);
  assert.equal(kept.length, 2);
  assert.equal(dropped, 1);
  assert.deepEqual(kept.map((m) => m.payload.messageId), ['b', 'c']);
});

await test('单条超限仍保留（不因超上限整批丢弃）', () => {
  const huge = member(makePayload({ messageId: 'huge', rawContent: 'x'.repeat(9999) }));
  const { kept, dropped } = trimToCapacity([huge], 10, 100);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});

group('批次指纹（幂等 key）');

await test('同一批消息跨重投指纹完全一致', () => {
  const mk = () => [
    member(makePayload({ messageId: 'b', receivedAtMs: 2 })),
    member(makePayload({ messageId: 'a', receivedAtMs: 1 })),
    member(makePayload({ messageId: 'c', receivedAtMs: 3 })),
  ];
  const first = batchFingerprint('qqbot:acc1:group:g1', mk());
  const second = batchFingerprint('qqbot:acc1:group:g1', mk());
  assert.equal(first, second);
});

await test('集合不同 ⇒ 指纹不同（不同批次不会互相吞掉）', () => {
  const a = batchFingerprint('qqbot:acc1:group:g1', [
    member(makePayload({ messageId: 'a' })),
  ]);
  const b = batchFingerprint('qqbot:acc1:group:g1', [
    member(makePayload({ messageId: 'a' })),
    member(makePayload({ messageId: 'b' })),
  ]);
  assert.notEqual(a, b);
});

await test('不同 lane ⇒ 指纹不同', () => {
  const members = [member(makePayload({ messageId: 'a' }))];
  assert.notEqual(
    batchFingerprint('qqbot:acc1:group:g1', members),
    batchFingerprint('qqbot:acc1:group:g2', members),
  );
});

group('唤醒判定');

await test('事件类型 GROUP_AT_MESSAGE_CREATE ⇒ 在叫 bot', () => {
  const p = makePayload({ rawEventType: 'GROUP_AT_MESSAGE_CREATE' });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('mentions.is_you ⇒ 在叫 bot', () => {
  const p = makePayload({ mentions: [{ is_you: true }] });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('称呼唤醒 ⇒ 在叫 bot', () => {
  const p = makePayload({ nameMentioned: true });
  assert.equal(isExplicitlyWoken(p), true);
});

await test('普通群消息 ⇒ 不在叫 bot', () => {
  const p = makePayload({ rawEventType: 'GROUP_MESSAGE_CREATE' });
  assert.equal(isExplicitlyWoken(p), false);
});

group('幂等守卫');

await test('同一 eventId 第二次命中 ⇒ 不重复执行副作用', async () => {
  const guard = createIngressEffectOnce({
    pluginId: 'openclaw-qqbot',
    namespacePrefix: 'test-ingress-effect',
    ttlMs: 60_000,
    stateMaxEntries: 100,
  });
  let sideEffects = 0;
  const run = async () => {
    const first = await guard.runOnce({
      eventId: 'fp-1',
      effect: 'dispatch',
      run: async () => {
        sideEffects += 1;
        return 'done';
      },
    });
    assert.equal(first.kind, 'executed');

    const second = await guard.runOnce({
      eventId: 'fp-1',
      effect: 'dispatch',
      run: async () => {
        sideEffects += 1;
        return 'done';
      },
    });
    assert.equal(second.kind, 'replayed');
  };
  await run();
  assert.equal(sideEffects, 1, '副作用只应执行一次');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('失败用例:');
  for (const t of failedTests) console.log(`  - ${t}`);
  process.exit(1);
}
