/**
 * STT (Speech-to-Text) 语音转文字 — 框架音频理解管线
 *
 * 转录统一委托给 openclaw/plugin-sdk/media-understanding-runtime 的
 * `transcribeAudioFile`（provider 注册表、附件缓存、SSRF 策略与错误语义
 * 均由框架维护），插件不自带 OpenAI 兼容 HTTP 调用；STT 配置只认框架级
 * `tools.media.models` 的 audio 能力条目（与内置 telegram 通道一致）。
 *
 * 硬编码两分支策略（2026-10-04 起，无插件级开关）：
 * - 框架 STT 未配置 → QQ 平台转写（asr_refer_text，随事件 JSON 下发）直
 *   接作为唯一来源（零下载、零外部调用）；无平台转写 → 占位文本。
 * - 框架 STT 已配置 → 下载语音提交框架转录；**严格信框架**——失败/为空/
 *   下载失败一律占位文本，不回退平台转写。
 */
import * as path from 'node:path';
import { transcribeAudioFile } from 'openclaw/plugin-sdk/media-understanding-runtime';

type TranscribeParams = Parameters<typeof transcribeAudioFile>[0];

/**
 * 框架 STT（语音转录）是否可用：
 * - `tools.media.audio.enabled === false` → 框架级 per-capability 关闭
 * - `tools.media.models` 无显式 `capabilities` 含 `"audio"` 的条目 → 未配置
 *
 * 规范路径是 `tools.media.models`——openclaw 2026.9.1 schema 中模型列表只
 * 存在于此（`tools.media.audio` 块的类型为 `Omit<…, "models">`，不含
 * models 键）。**只认显式 `capabilities` 标签**（有意保守）：无标签 CLI
 * 条目按框架语义本就不参与共享列表的 audio 匹配；无标签 provider 条目框
 * 架会从 provider 注册表推断能力，但插件侧无法廉价复刻注册表——宁可漏判
 * （降级走平台转写，功能仍可用）也不误判（严格模式下误判会变成彻底无转
 * 写）。
 *
 * 仅做存在性探测控制流程；provider 解析与实际调用由 transcribeAudioFile
 * 完成（错误在调用点捕获处理）。
 */
export function isFrameworkSttConfigured(cfg: Record<string, unknown>): boolean {
  const tools = asRecord(cfg.tools);
  const media = asRecord(tools?.media);
  if (asRecord(media?.audio)?.enabled === false) {
    return false;
  }
  const models = media?.models;
  if (!Array.isArray(models)) {
    return false;
  }
  return models.some((entry) => {
    const capabilities = asRecord(entry)?.capabilities;
    return Array.isArray(capabilities) && capabilities.includes('audio');
  });
}

/**
 * 检测已废弃的 `channels.qqbot.stt` 配置块：旧凭证键
 * （provider/baseUrl/apiKey/model）与历史行为开关（enabled/asrFallback）。
 * 2026-10-04 起整块被忽略——STT 启停只由框架 `tools.media.models`（audio
 * 能力条目）+ `tools.media.audio.enabled` 控制；返回 true 时调用方打一次
 * 性迁移提示。
 */
export function hasLegacySttConfig(cfg: Record<string, unknown>): boolean {
  const channels = asRecord(cfg.channels);
  const qqbot = asRecord(channels?.qqbot);
  const stt = asRecord(qqbot?.stt);
  if (!stt) return false;
  const legacyKeys = ['provider', 'baseUrl', 'apiKey', 'model', 'enabled', 'asrFallback'] as const;
  return legacyKeys.some((key) => {
    const value = stt[key];
    if (typeof value === 'string') return value.trim().length > 0;
    return value != null;
  });
}

/**
 * 经框架音频理解管线转录本地音频文件。
 * 返回修剪后的转录文本；无文本返回 null。
 * provider 缺失/调用失败会抛错，由调用方捕获后输出失败占位文本。
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
