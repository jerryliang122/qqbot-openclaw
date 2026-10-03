/**
 * 语音转录策略（平台 ASR 默认参与）单元测试
 *
 * 锁定判定协议（2026-10 起语义反转）：
 * - 平台转写（asr_refer_text，QQ 平台自动 STT 随事件 JSON 下发）**默认参与**：
 *   框架 STT（tools.media.audio）未配置时直接作为唯一来源；
 *   STT 已配置时作为自有转录失败/为空的兜底。
 * - channels.qqbot.stt.asrFallback: false 才是严格模式（所有场景丢弃平台转写，
 *   恢复 2026-08-17 旧默认）。
 * - 转录调用统一委托框架 transcribeAudioFile，插件不再自带 HTTP 调用。
 *
 * - shouldUsePlatformAsr / isFrameworkSttConfigured / hasLegacySttCredentials 判定
 * - processAttachments 集成链路：平台转写直接采用 / 严格模式丢弃 / 下载失败兜底
 * - body-assembler 的 - ASR: 行渲染
 *
 * 运行方式:  npx tsx tests/voice-strict-mode.test.ts
 */
import assert from 'node:assert';
import { shouldUsePlatformAsr, isFrameworkSttConfigured, hasLegacySttCredentials } from '../src/utils/stt.js';
import { processAttachments } from '../src/middleware/attachment.js';
import { assembleBody } from '../src/dispatch/body-assembler.js';
import { formatVoiceText, type VoiceTranscript } from '../src/utils/voice-text.js';

// ── 测试基础设施 ──────────────────────────────────────────

let passed = 0;
let failed = 0;
const failedTests: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

// 注意：本文件不得使用顶层 await——attachment.ts 的依赖链
// （adapter/media.ts 的 __filename）依赖同步模块图，顶层 await 会破坏 tsx 的 CJS shim。

const frameworkSttCfg = {
  tools: { media: { audio: { models: [{ baseUrl: 'https://api.example.com', apiKey: 'k', model: 'whisper-1' }] } } },
} as Record<string, unknown>;

async function main(): Promise<void> {

// ── shouldUsePlatformAsr 判定（默认参与） ──────────────────

console.log('\n=== shouldUsePlatformAsr 判定（默认 true） ===');

await test('未配置任何东西 → 平台转写参与（默认）', () => {
  assert.equal(shouldUsePlatformAsr({}), true);
});

await test('asrFallback: false → 平台转写丢弃（严格模式）', () => {
  assert.equal(
    shouldUsePlatformAsr({ channels: { qqbot: { stt: { asrFallback: false } } } }),
    false,
  );
});

await test('asrFallback: true → 显式保留（与默认等价，兼容旧配置）', () => {
  assert.equal(
    shouldUsePlatformAsr({ channels: { qqbot: { stt: { asrFallback: true } } } }),
    true,
  );
});

await test('stt 块存在但无 asrFallback → 默认参与', () => {
  assert.equal(
    shouldUsePlatformAsr({ channels: { qqbot: { stt: { enabled: false } } } }),
    true,
  );
});

// ── isFrameworkSttConfigured 判定 ─────────────────────────

console.log('\n=== isFrameworkSttConfigured 判定 ===');

await test('tools.media.audio.models 缺失 → 未配置（平台转写直接采用）', () => {
  assert.equal(isFrameworkSttConfigured({}), false);
});

await test('models 非空 → 已配置', () => {
  assert.equal(isFrameworkSttConfigured(frameworkSttCfg), true);
});

await test('models 为空数组 → 未配置', () => {
  assert.equal(
    isFrameworkSttConfigured({ tools: { media: { audio: { models: [] } } } }),
    false,
  );
});

await test('channels.qqbot.stt.enabled: false → 插件级关闭外部 STT（只用平台转写）', () => {
  const cfg = { ...frameworkSttCfg, channels: { qqbot: { stt: { enabled: false } } } };
  assert.equal(isFrameworkSttConfigured(cfg), false);
});

await test('tools.media.audio.enabled: false → 框架级关闭', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { audio: { enabled: false, models: [{ baseUrl: 'x', apiKey: 'y' }] } } },
    }),
    false,
  );
});

// ── hasLegacySttCredentials 判定 ──────────────────────────

console.log('\n=== hasLegacySttCredentials 判定 ===');

await test('旧凭证键存在 → 检测到（提示迁移）', () => {
  assert.equal(
    hasLegacySttCredentials({
      channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k' } } },
    }),
    true,
  );
});

await test('只剩行为开关 → 不算旧凭证', () => {
  assert.equal(
    hasLegacySttCredentials({ channels: { qqbot: { stt: { asrFallback: false, enabled: false } } } }),
    false,
  );
});

await test('stt 块不存在 → 不算旧凭证', () => {
  assert.equal(hasLegacySttCredentials({}), false);
});

// ── processAttachments 集成链路 ───────────────────────────

console.log('\n=== processAttachments 集成链路 ===');

const voiceAtt = {
  content_type: 'voice',
  url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
  voice_wav_url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
  asr_refer_text: '平台转写文本',
} as never;

const voiceAttNoAsr = {
  content_type: 'voice',
  url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
  voice_wav_url: '//qqbot.ugcimg.cn/uservoice/demo.wav',
} as never;

await test('框架 STT 未配置 + 平台转写存在 → 直接采用平台转写（无下载）', async () => {
  const result = await processAttachments([voiceAtt], {}, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'asr');
  assert.equal(t.text, '平台转写文本');
  assert.equal(t.asrReferText, '平台转写文本');
  assert.ok(result.voiceText.includes('平台转写文本'));
});

await test('框架 STT 未配置 + asrFallback: false → 严格模式占位文本、asrReferText 丢弃', async () => {
  const result = await processAttachments(
    [voiceAtt],
    { channels: { qqbot: { stt: { asrFallback: false } } } },
    undefined,
  );
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription unavailable]');
  assert.equal(t.asrReferText, undefined);
  assert.ok(result.voiceText.includes('transcription unavailable'));
});

await test('框架 STT 未配置 + 无平台转写 → 占位文本', async () => {
  const result = await processAttachments([voiceAttNoAsr], {}, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription unavailable]');
});

await test('stt.enabled: false（不调外部 STT）+ 平台转写 → 直接采用平台转写', async () => {
  const result = await processAttachments(
    [voiceAtt],
    { channels: { qqbot: { stt: { enabled: false } } } },
    undefined,
  );
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'asr');
  assert.equal(t.text, '平台转写文本');
});

await test('框架 STT 已配置 + 下载失败（非 https 被跳过）→ 平台转写兜底', async () => {
  const httpAtt = {
    content_type: 'voice',
    url: 'http://qqbot.ugcimg.cn/uservoice/demo.silk',
    asr_refer_text: '平台转写文本',
  } as never;
  // http:// URL 被 downloadMediaFile 的 HTTPS-only 策略跳过 → localPath 为空
  // → 不会真正调用框架转录 → 平台转写兜底
  const result = await processAttachments([httpAtt], frameworkSttCfg, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'asr');
  assert.equal(t.text, '平台转写文本');
  assert.equal(t.remoteUrl, 'http://qqbot.ugcimg.cn/uservoice/demo.silk');
});

await test('框架 STT 已配置 + 下载失败 + asrFallback: false → 失败占位文本', async () => {
  const httpAtt = {
    content_type: 'voice',
    url: 'http://qqbot.ugcimg.cn/uservoice/demo.silk',
    asr_refer_text: '平台转写文本',
  } as never;
  const cfg = {
    ...frameworkSttCfg,
    channels: { qqbot: { stt: { asrFallback: false } } },
  } as Record<string, unknown>;
  const result = await processAttachments([httpAtt], cfg, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription failed]');
});

// ── body-assembler：- ASR: 行渲染 ─────────────────────────

console.log('\n=== body-assembler - ASR: 行 ===');

function buildAgentBody(transcripts: VoiceTranscript[]): string {
  const ctx = {
    message: { content: 'hello', kind: 'c2c', senderId: 's1', messageId: 'm1' },
    state: {
      processedAttachments: {
        // 与真实链路一致：voiceText 由 formatVoiceText(transcripts) 生成
        voiceText: formatVoiceText(transcripts),
        imageUrls: [],
        otherInfo: '',
        transcripts,
        localMediaPaths: [],
        localMediaTypes: [],
        remoteMediaUrls: [],
        media: [],
      },
    },
    signal: undefined,
  } as never;
  const msg = {
    kind: 'c2c',
    content: 'hello',
    senderId: 's1',
    replyTarget: { scope: 'c2c', targetId: 's1' },
    attachments: [],
  } as never;
  return assembleBody(ctx, msg, { accountId: 'default', appId: 'a', secret: 's' } as never).agentBody;
}

await test('自有 STT 成功且携带 asrReferText（默认保留）→ - ASR: 行包含平台文本', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav', asrReferText: '平台转写文本' },
  ]);
  assert.ok(body.includes('- ASR: 平台转写文本'));
});

await test('严格模式（stt 成功、asrReferText 被丢弃）→ 无 - ASR: 行', () => {
  const body = buildAgentBody([
    { text: '自有转写结果', source: 'stt', localPath: '/tmp/v.wav' },
  ]);
  assert.ok(!body.includes('- ASR:'), `不应包含 - ASR: 行，实际: ${body}`);
});

await test('平台转写直接采用（source asr）→ - ASR: 行携带平台文本', () => {
  const body = buildAgentBody([
    { text: '平台转写文本', source: 'asr', asrReferText: '平台转写文本', remoteUrl: 'https://x/v.wav' },
  ]);
  assert.ok(body.includes('- ASR: 平台转写文本'));
});

await test('严格模式 STT 失败（fallback、无 asrReferText）→ 占位文本且无 - ASR: 行', () => {
  const body = buildAgentBody([
    { text: '[Voice message - transcription failed]', source: 'fallback', localPath: '/tmp/v.wav' },
  ]);
  assert.ok(body.includes('[Voice message - transcription failed]'));
  assert.ok(!body.includes('- ASR:'));
});

// ── 汇总 ──────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`FAILED: ${failedTests.join(', ')}`);
  process.exit(1);
}

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
