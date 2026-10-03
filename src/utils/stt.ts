/**
 * STT (Speech-to-Text) 语音转文字 — 框架音频理解管线
 *
 * 转录统一委托给 openclaw/plugin-sdk/media-understanding-runtime 的
 * `transcribeAudioFile`（provider 注册表、附件缓存、SSRF 策略与错误语义
 * 均由框架维护），插件不再自带 OpenAI 兼容 HTTP 调用；STT 凭证只认
 * 框架级 `tools.media.audio.models` 配置（与内置 telegram 通道一致）。
 *
 * 平台转写（asr_refer_text）：QQ 平台对语音消息自动 STT 并随事件 JSON 下发。
 * 默认策略——框架 STT 未配置时**直接采用平台转写**；已配置时平台转写作为
 * 自有转录失败/为空的兜底。`channels.qqbot.stt.asrFallback: false` 可整体
 * 禁用平台转写（严格模式，恢复 2026-08-17 的丢弃行为）。
 */
import * as path from 'node:path';
import { transcribeAudioFile } from 'openclaw/plugin-sdk/media-understanding-runtime';

type TranscribeParams = Parameters<typeof transcribeAudioFile>[0];

/**
 * 平台转写（asr_refer_text）是否参与（独立于框架 STT 配置读取）。
 * 默认 true；显式 `channels.qqbot.stt.asrFallback: false` 时关闭（严格模式）。
 */
export function shouldUsePlatformAsr(cfg: Record<string, unknown>): boolean {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  return asRecord(qqbot?.stt)?.asrFallback !== false;
}

/**
 * 框架 STT（tools.media.audio）是否可用：
 * - `channels.qqbot.stt.enabled === false` → 插件级显式关闭（只用平台转写）
 * - `tools.media.audio.enabled === false` → 框架级关闭
 * - `models` 为空 → 未配置
 *
 * 仅做存在性探测控制流程；provider 解析与实际调用由 transcribeAudioFile 完成。
 */
export function isFrameworkSttConfigured(cfg: Record<string, unknown>): boolean {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  if (asRecord(qqbot?.stt)?.enabled === false) {
    return false;
  }
  const tools = asRecord(cfg.tools);
  const media = asRecord(tools?.media);
  const audio = asRecord(media?.audio);
  if (!audio || audio.enabled === false) {
    return false;
  }
  return Array.isArray(audio.models) && audio.models.length > 0;
}

/**
 * 检测已废弃的插件级 STT 凭证（channels.qqbot.stt.provider/baseUrl/apiKey/model）。
 * 2026-10 起凭证统一走框架 `tools.media.audio.models`，旧键被忽略；
 * 返回 true 时调用方打一次性迁移提示。
 */
export function hasLegacySttCredentials(cfg: Record<string, unknown>): boolean {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const stt = asRecord(qqbot?.stt);
  if (!stt) return false;
  return ['provider', 'baseUrl', 'apiKey', 'model'].some(
    (key) => typeof stt[key] === 'string' && (stt[key] as string).trim().length > 0,
  );
}

/**
 * 经框架音频理解管线转录本地音频文件。
 * 返回修剪后的转录文本；无文本返回 null。
 * provider 缺失/调用失败会抛错，由调用方捕获后走平台转写兜底。
 */
export async function transcribeAudioViaFramework(
  audioPath: string,
  cfg: Record<string, unknown>,
): Promise<string | null> {
  const result = await transcribeAudioFile({
    filePath: audioPath,
    cfg: cfg as unknown as TranscribeParams['cfg'],
    mime: guessMimeType(audioPath),
  });
  return result.text?.trim() || null;
}

// ── 内部工具函数 ──

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeMap: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.silk': 'audio/silk',
    '.amr': 'audio/amr',
    '.pcm': 'audio/pcm',
  };
  return mimeMap[ext] ?? 'application/octet-stream';
}
