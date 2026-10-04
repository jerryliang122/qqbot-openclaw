/**
 * 语音转录策略（硬编码两分支）单元测试
 *
 * 锁定判定协议（2026-10-04 起，channels.qqbot.stt 开关已移除）：
 * - 框架 STT 未配置（tools.media.models 无 capabilities 含 "audio" 的条目，
 *  或 tools.media.audio.enabled: false）→ QQ 平台转写（asr_refer_text）直
 *   接作为唯一来源（无下载、零外部调用）；无平台转写 → 占位文本。
 * - 框架 STT 已配置 → 下载（voice_wav_url 优先 / SILK→WAV）提交框架
 *   transcribeAudioFile；**严格信框架**——失败/为空/下载失败一律占位文
 *   本，不回退平台转写、transcript 不携带 asrReferText。
 * - channels.qqbot.stt 整块为遗留：任何键（凭证 + enabled/asrFallback）都
 *   被忽略，检测到打一次性迁移提示。
 *
 * - isFrameworkSttConfigured / hasLegacySttConfig 判定
 * - processAttachments 集成链路：平台转写直接采用 / 遗留键不影响 / 下载失败占位
 * - body-assembler 的 - ASR: 行渲染
 *
 * 运行方式:  npx tsx tests/voice-transcript.test.ts
 */
import assert from 'node:assert';
import { isFrameworkSttConfigured, hasLegacySttConfig } from '../src/utils/stt.js';
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

/** 规范路径的框架 STT 配置（CLI 形态 + 显式 audio 能力标签） */
const frameworkSttCfg = {
  tools: {
    media: {
      models: [
        {
          type: 'cli',
          command: 'gemini',
          args: ['-m', 'some-model', '{{AttachmentPath}}'],
          maxBytes: 52428800,
          timeoutSeconds: 120,
          capabilities: ['audio'],
        },
      ],
    },
  },
} as Record<string, unknown>;

async function main(): Promise<void> {

// ── isFrameworkSttConfigured 判定 ─────────────────────────

console.log('\n=== isFrameworkSttConfigured 判定（tools.media.models + capabilities） ===');

await test('tools.media.models 缺失 → 未配置（平台转写直接采用）', () => {
  assert.equal(isFrameworkSttConfigured({}), false);
});

await test('models 含显式 audio 标签条目（CLI 形态）→ 已配置', () => {
  assert.equal(isFrameworkSttConfigured(frameworkSttCfg), true);
});

await test('models 含显式 audio 标签条目（provider 形态）→ 已配置', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { models: [{ provider: 'openai', model: 'whisper-1', capabilities: ['audio'] }] } },
    }),
    true,
  );
});

await test('models 为空数组 → 未配置', () => {
  assert.equal(
    isFrameworkSttConfigured({ tools: { media: { models: [] } } }),
    false,
  );
});

await test('仅 image 标签条目 → 未配置', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { models: [{ type: 'cli', command: 'x', capabilities: ['image'] }] } },
    }),
    false,
  );
});

await test('无标签 CLI 条目 → 未配置（与框架共享列表语义一致）', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { models: [{ type: 'cli', command: 'x' }] } },
    }),
    false,
  );
});

await test('无标签 provider 条目 → 未配置（保守漏判，注册表推断不可廉价复刻）', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { models: [{ provider: 'openai', model: 'whisper-1' }] } },
    }),
    false,
  );
});

await test('tools.media.audio.enabled: false → 框架级 per-capability 关闭', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { audio: { enabled: false }, models: [{ capabilities: ['audio'] }] } },
    }),
    false,
  );
});

await test('插件级 channels.qqbot.stt 块（enabled/asrFallback）不再影响判定 → 仍 true', () => {
  const cfg = {
    ...frameworkSttCfg,
    channels: { qqbot: { stt: { enabled: false, asrFallback: false } } },
  };
  assert.equal(isFrameworkSttConfigured(cfg), true);
});

await test('旧错误路径 tools.media.audio.models（v2.0.0 README 示例）→ 不识别', () => {
  assert.equal(
    isFrameworkSttConfigured({
      tools: { media: { audio: { models: [{ capabilities: ['audio'] }] } } },
    }),
    false,
  );
});

// ── hasLegacySttConfig 判定 ───────────────────────────────

console.log('\n=== hasLegacySttConfig 判定 ===');

await test('旧凭证键存在 → 检测到（提示迁移）', () => {
  assert.equal(
    hasLegacySttConfig({
      channels: { qqbot: { stt: { baseUrl: 'https://api.example.com', apiKey: 'k' } } },
    }),
    true,
  );
});

await test('enabled/asrFallback 残留 → 检测到（历史开关已移除）', () => {
  assert.equal(hasLegacySttConfig({ channels: { qqbot: { stt: { enabled: false } } } }), true);
  assert.equal(hasLegacySttConfig({ channels: { qqbot: { stt: { asrFallback: true } } } }), true);
});

await test('stt 块不存在 / 空对象 → 不算遗留', () => {
  assert.equal(hasLegacySttConfig({}), false);
  assert.equal(hasLegacySttConfig({ channels: { qqbot: { stt: {} } } }), false);
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

await test('框架 STT 未配置 + 遗留键 asrFallback/enabled 残留 → 不再影响，仍采用平台转写', async () => {
  const result = await processAttachments(
    [voiceAtt],
    { channels: { qqbot: { stt: { asrFallback: false, enabled: false } } } },
    undefined,
  );
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'asr');
  assert.equal(t.text, '平台转写文本');
});

await test('框架 STT 未配置 + 无平台转写 → 占位文本', async () => {
  const result = await processAttachments([voiceAttNoAsr], {}, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription unavailable]');
});

await test('框架 STT 已配置 + 下载失败（非 https 被跳过）→ 严格信框架：transcription failed 占位，不回退平台转写', async () => {
  const httpAtt = {
    content_type: 'voice',
    url: 'http://qqbot.ugcimg.cn/uservoice/demo.silk',
    asr_refer_text: '平台转写文本',
  } as never;
  // http:// URL 被 downloadMediaFile 的 HTTPS-only 策略跳过 → localPath 为空
  // → 不会真正调用框架转录 → 严格信框架：失败占位、平台转写不兜底
  const result = await processAttachments([httpAtt], frameworkSttCfg, undefined);
  const t = result.transcripts[0]!;
  assert.equal(t.source, 'fallback');
  assert.equal(t.text, '[Voice message - transcription failed]');
  assert.equal(t.asrReferText, undefined);
  assert.equal(t.remoteUrl, 'http://qqbot.ugcimg.cn/uservoice/demo.silk');
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

await test('自有 STT 成功（不携带 asrReferText）→ 无 - ASR: 行（严格信框架）', () => {
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

await test('STT 失败占位（fallback、无 asrReferText）→ 占位文本且无 - ASR: 行', () => {
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
