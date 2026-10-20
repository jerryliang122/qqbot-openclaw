/**
 * 回归测试：QQ 语音/富媒体投递口径与平台对齐
 *
 * 背景（2026-10-20 核实 QQ 官方文档《富媒体消息概述》）：富媒体限制是
 * **体积制**、不是时长制：
 *
 *   | file_type | 类型 | 格式    | 软限制 | 硬限制 |
 *   | 1         | 图片 | png/jpg | 20 MB  | 200 MB |
 *   | 2         | 视频 | mp4     | 30 MB  | 200 MB |
 *   | 3         | 语音 | silk    | 20 MB  | 200 MB |
 *   | 4         | 文件 | -       | 200 MB | 200 MB |
 *   「超过软限制会降级为文件类型上传，超过硬限制会报错。」
 *
 * 平台文档里**没有任何语音时长（秒）限制**——「60 秒以内是语音条」是体积与时长的
 * 相关性错觉（TTS 语音通常只有几百 KB～1 MB，远低于 20 MB）。
 *
 * 本测试锁定三条口径：
 * 1. 语音只认平台明确的 4 种格式（silk/mp3/wav/ogg）
 * 2. 语音超 20MB 软限制 → 显式降级为文件投递（与平台隐式降级结果一致）
 * 3. 语音判定**与时长无关**（不引入任何秒数阈值）
 */
import { strict as assert } from 'assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inferMediaKind, inferMediaKindFromMime } from '../src/outbound/local-file-router.js';
import { resolveOutboundMediaKind } from '../src/outbound/media-send.js';
import { QQBOT_VOICE_SOFT_LIMIT_BYTES, QQBOT_VOICE_FORMATS } from '../src/constants.js';

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    throw err;
  }
}

// ── 1. 格式口径 ──

test('平台支持的语音格式 → voice', () => {
  for (const fmt of QQBOT_VOICE_FORMATS) {
    assert.strictEqual(inferMediaKind(`a.${fmt}`), 'voice', `${fmt} 应判为 voice`);
  }
});

test('平台不认的音频格式 → file（不再按语音投递）', () => {
  // 平台语音只支持 silk/mp3/wav/ogg；此前 amr/flac/aac/m4a 被当成语音上传，
  // 平台会隐式降级成文件卡片（还丢掉我们设的文件名）
  for (const fmt of ['amr', 'flac', 'aac', 'm4a']) {
    assert.strictEqual(inferMediaKind(`a.${fmt}`), 'file', `${fmt} 应判为 file`);
  }
});

test('图片/视频/其它文件判定未受影响', () => {
  assert.strictEqual(inferMediaKind('a.png'), 'image');
  assert.strictEqual(inferMediaKind('a.JPG'), 'image');
  assert.strictEqual(inferMediaKind('a.mp4'), 'video');
  assert.strictEqual(inferMediaKind('a.pdf'), 'file');
  assert.strictEqual(inferMediaKind('a.tar.gz'), 'file');
});

// ── 2. mime 判定口径 ──

test('mime 判定：audio/* → voice（但仍走体积检查）', () => {
  assert.strictEqual(inferMediaKindFromMime('audio/mpeg'), 'voice');
  assert.strictEqual(inferMediaKindFromMime('audio/silk'), 'voice');
  assert.strictEqual(inferMediaKindFromMime('video/mp4'), 'video');
  assert.strictEqual(inferMediaKindFromMime('application/pdf'), 'file');
});

// ── 3. 体积软限制常量 ──

test('语音软限制 = 20MB（平台 file_type=3 软限制）', () => {
  assert.strictEqual(QQBOT_VOICE_SOFT_LIMIT_BYTES, 20 * 1024 * 1024);
});

// ── 4. 投递类型判定 ──

test('语音未超软限制 → 保持 voice', () => {
  const kind = resolveOutboundMediaKind({
    path: '/tmp/a.mp3',
    isLocal: true,
    sizeBytes: 1024,
  });
  assert.strictEqual(kind, 'voice');
});

test('语音超 20MB 软限制 → 显式降级为 file', () => {
  const kind = resolveOutboundMediaKind({
    path: '/tmp/big.mp3',
    isLocal: true,
    sizeBytes: QQBOT_VOICE_SOFT_LIMIT_BYTES + 1,
  });
  assert.strictEqual(kind, 'file', '超软限制应降级为 file（与平台隐式降级一致）');
});

test('恰好等于软限制 → 仍是 voice（边界是「超过」才降级）', () => {
  const kind = resolveOutboundMediaKind({
    path: '/tmp/exact.mp3',
    isLocal: true,
    sizeBytes: QQBOT_VOICE_SOFT_LIMIT_BYTES,
  });
  assert.strictEqual(kind, 'voice');
});

test('非本地来源（URL / data URL）不做体积判定 → 交平台处理', () => {
  const kind = resolveOutboundMediaKind({
    path: 'https://example.com/a.mp3',
    isLocal: false,
    sizeBytes: undefined,
  });
  assert.strictEqual(kind, 'voice');
});

test('显式 mediaKind 优先级最高，但仍受体积软限制约束', () => {
  assert.strictEqual(
    resolveOutboundMediaKind({ mediaKind: 'image', path: '/tmp/a.mp3', isLocal: true, sizeBytes: 10 }),
    'image',
  );
  // 显式指定 voice 但超软限制 → 仍然降级（平台不接受超限语音）
  assert.strictEqual(
    resolveOutboundMediaKind({
      mediaKind: 'voice',
      path: '/tmp/big.mp3',
      isLocal: true,
      sizeBytes: QQBOT_VOICE_SOFT_LIMIT_BYTES + 1,
    }),
    'file',
  );
});

test('真实文件体积判定与实际字节数一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-media-'));
  const small = path.join(dir, 'small.mp3');
  fs.writeFileSync(small, 'x'.repeat(2048));
  const big = path.join(dir, 'big.mp3');
  const fd = fs.openSync(big, 'w');
  fs.ftruncateSync(fd, QQBOT_VOICE_SOFT_LIMIT_BYTES + 1024);
  fs.closeSync(fd);

  const kindOf = (file: string) =>
    resolveOutboundMediaKind({
      path: file,
      isLocal: true,
      sizeBytes: fs.statSync(file).size,
    });

  assert.strictEqual(kindOf(small), 'voice');
  assert.strictEqual(kindOf(big), 'file');

  fs.rmSync(dir, { recursive: true, force: true });
});
