/**
 * 入站附件处理中间件
 *
 * 处理入站消息中的语音/图片/视频附件：
 * - 语音：下载 → SILK转WAV → STT转文字 → 写入 ctx.state.processedAttachments
 * - 图片：提取 URL 列表
 * - 其他：标记为附件描述
 *
 * 插入位置：envelopeFormatter 之前
 */
import * as path from 'node:path';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';
import {
  convertSilkToWav,
  isVoiceAttachment,
} from '@tencent-connect/qqbot-nodejs/protocol';
import type { MessageAttachment } from '../types.js';
import { transcribeAudio, resolveSTTConfig, shouldUsePlatformAsr } from '../utils/stt.js';
import { formatVoiceText, formatDuration, type VoiceTranscript, type TranscriptSource } from '../utils/voice-text.js';
import { downloadRemoteMedia } from '../adapter/media.js';
import { getAdapters } from '../adapter/resolve.js';

export { formatVoiceText, formatDuration };
export type { VoiceTranscript, TranscriptSource };

/** 处理后的附件结果（写入 ctx.state.processedAttachments） */
export interface ProcessedAttachments {
  voiceText: string;
  imageUrls: string[];
  otherInfo: string;
  transcripts: VoiceTranscript[];
  /** 下载到本地的媒体路径（图片 + 语音，供 AI 引用） */
  localMediaPaths: string[];
  /** 对应 localMediaPaths 的 MIME type */
  localMediaTypes: string[];
  /** 远端 URL 列表（下载失败时的回退） */
  remoteMediaUrls: string[];
  /**
   * 结构化媒体清单（全部附件，保持原始顺序）。
   * 供 ctx-builder 组装 core 正规媒体通道的 media facts（MediaKind: image|audio|video|document）。
   */
  media: InboundMediaEntry[];
}

/**
 * 单个入站媒体条目（对齐 core MediaKind/ChannelInboundMediaInput 语义）。
 * localPath 与 remoteUrl 二选一可能都没有（下载失败且无 URL 时）。
 */
export interface InboundMediaEntry {
  kind: 'image' | 'audio' | 'video' | 'document';
  localPath?: string;
  remoteUrl?: string;
  contentType?: string;
  filename?: string;
  /** 仅语音：STT/平台 ASR 产出真实转写文本时为 true */
  transcribed?: boolean;
}

interface AttachmentMiddlewareOptions {
  /** 获取 runtime */
  getRuntime: () => any;
}

/**
 * 附件处理中间件
 *
 * SDK ctx 已提供 log 和 accountId，只需传入配置获取函数。
 */
export function attachmentProcessor(opts: AttachmentMiddlewareOptions) {
  return async (ctx: MiddlewareContext, next: () => Promise<void>) => {
    const msg = ctx.message;
    const attachments = msg.attachments as MessageAttachment[] | undefined;

    if (attachments?.length) {
      const runtime = opts.getRuntime();
      const adapters = getAdapters(runtime);
      const cfg = (adapters.getConfig?.() ?? {}) as Record<string, unknown>;
      const log = ctx.log;
      const result = await processAttachments(attachments, cfg, log);

      if (result.voiceText || result.imageUrls.length > 0 || result.otherInfo || result.localMediaPaths.length > 0) {
        ctx.state.processedAttachments = result;
      }
    }

    await next();
  };
}

// ── 核心处理逻辑 ──

type Log = { info: (m: string) => void; error: (m: string) => void; debug?: (m: string) => void };

export async function processAttachments(
  attachments: MessageAttachment[],
  cfg: Record<string, unknown>,
  log?: Log,
): Promise<ProcessedAttachments> {
  const sttCfg = resolveSTTConfig(cfg);
  const usePlatformAsr = shouldUsePlatformAsr(cfg);
  const audioPolicy = resolveAudioPolicy(cfg);

  const imageUrls: string[] = [];
  const otherParts: string[] = [];
  const transcripts: VoiceTranscript[] = [];
  const localMediaPaths: string[] = [];
  const localMediaTypes: string[] = [];
  const remoteMediaUrls: string[] = [];
  const media: InboundMediaEntry[] = [];

  // 并行下载所有附件
  const tasks = attachments.map(async (att) => {
    const isVoice = isVoiceAttachment(att);
    const isImage = att.content_type?.startsWith('image/');
    const url = normalizeUrl(att.url);

    if (isImage && url) {
      const localPath = await downloadMediaFile(url, att.filename, log);
      return { type: 'image' as const, localPath, url, contentType: att.content_type ?? 'image/png', filename: att.filename };
    }

    if (isVoice) {
      const transcript = await processVoiceAttachment(att, sttCfg, usePlatformAsr, audioPolicy, log);
      return { type: 'voice' as const, transcript };
    }

    // other 类型也尝试下载
    if (url) {
      const localPath = await downloadMediaFile(url, att.filename, log);
      return { type: 'other' as const, localPath, url, filename: att.filename ?? att.content_type, contentType: att.content_type };
    }
    return { type: 'other' as const, localPath: null, url: '', filename: att.filename ?? att.content_type, contentType: att.content_type };
  });

  const results = await Promise.all(tasks);

  // 按原始顺序收集结果
  for (const result of results) {
    if (result.type === 'image') {
      if (result.localPath) {
        imageUrls.push(result.localPath);
        localMediaPaths.push(result.localPath);
        localMediaTypes.push(result.contentType);
      } else {
        imageUrls.push(result.url);
        remoteMediaUrls.push(result.url);
      }
      media.push({
        kind: 'image',
        ...(result.localPath ? { localPath: result.localPath } : { remoteUrl: result.url }),
        contentType: result.contentType,
        filename: result.filename,
      });
    } else if (result.type === 'voice') {
      transcripts.push(result.transcript);
      if (result.transcript.localPath) {
        localMediaPaths.push(result.transcript.localPath);
        localMediaTypes.push('audio/wav');
      } else if (result.transcript.remoteUrl) {
        remoteMediaUrls.push(result.transcript.remoteUrl);
      }
      media.push({
        kind: 'audio',
        ...(result.transcript.localPath
          ? { localPath: result.transcript.localPath }
          : result.transcript.remoteUrl
            ? { remoteUrl: result.transcript.remoteUrl }
            : {}),
        contentType: 'audio/wav',
        transcribed: result.transcript.source !== 'fallback',
      });
    } else if (result.type === 'other') {
      if (result.localPath) {
        otherParts.push(`[Attachment: ${result.localPath}]`);
        localMediaPaths.push(result.localPath);
        localMediaTypes.push('application/octet-stream');
      } else {
        otherParts.push(`[Attachment: ${result.filename}]`);
      }
      media.push({
        kind: kindFromContentType(result.contentType),
        ...(result.localPath ? { localPath: result.localPath } : result.url ? { remoteUrl: result.url } : {}),
        ...(result.contentType ? { contentType: result.contentType } : {}),
        ...(result.filename ? { filename: result.filename } : {}),
      });
    }
  }

  return {
    voiceText: formatVoiceText(transcripts),
    imageUrls,
    otherInfo: otherParts.join('\n'),
    transcripts,
    localMediaPaths,
    localMediaTypes,
    remoteMediaUrls,
    media,
  };
}

/** content_type → core MediaKind（无法识别时归为 document） */
function kindFromContentType(contentType: string | undefined): InboundMediaEntry['kind'] {
  if (contentType?.startsWith('video/')) return 'video';
  if (contentType?.startsWith('image/')) return 'image';
  if (contentType?.startsWith('audio/')) return 'audio';
  return 'document';
}

// ── 语音处理 ──

async function processVoiceAttachment(
  att: MessageAttachment,
  sttCfg: ReturnType<typeof resolveSTTConfig>,
  usePlatformAsr: boolean,
  audioPolicy: AudioPolicyResolved,
  log?: Log,
): Promise<VoiceTranscript> {
  // 平台转写（asr_refer_text）仅在显式 asrFallback: true 时参与；
  // 缺省/false 时在所有场景下丢弃——包括 STT 未配置（语音落占位文本）
  // 与 STT 失败（不当兜底），三条泄漏路径（转写成功携带 / 转写失败回退 /
  // 下载失败回退）一并堵死。
  const rawAsrText = att.asr_refer_text?.trim() || undefined;
  const asrReferText = usePlatformAsr ? rawAsrText : undefined;
  // 远端 URL 兜底：优先 wav_url，其次原始 url
  const remoteUrl = normalizeUrl(att.voice_wav_url) || normalizeUrl(att.url) || undefined;

  // STT 未配置：占位文本；显式 asrFallback: true 时退回平台转写
  if (!sttCfg) {
    if (!usePlatformAsr && rawAsrText) {
      log?.info(`Voice: STT not configured; platform asr_refer_text discarded (asrFallback not enabled)`);
    }
    if (asrReferText) {
      log?.debug?.(`Voice: using asr_refer_text (STT not configured, asrFallback enabled)`);
      return { text: asrReferText, source: 'asr', asrReferText, remoteUrl };
    }
    return {
      text: '[Voice message - transcription unavailable]',
      source: 'fallback',
      asrReferText,
      remoteUrl,
    };
  }

  let localPath: string | undefined;
  let duration: number | undefined;

  try {
    const wavUrl = normalizeUrl(att.voice_wav_url);
    if (wavUrl) {
      const downloaded = await downloadMediaFile(wavUrl, undefined, log);
      if (downloaded) {
        localPath = downloaded;
        log?.debug?.(`Voice: downloaded WAV from voice_wav_url`);
      }
    }

    if (!localPath) {
      const silkUrl = normalizeUrl(att.url);
      if (silkUrl) {
        const silkPath = await downloadMediaFile(silkUrl, att.filename, log);
        if (silkPath) {
          const ext = path.extname(silkPath).toLowerCase();
          if (audioPolicy.sttDirectFormats.includes(ext)) {
            localPath = silkPath;
          } else {
            const wavResult = await convertSilkToWav(silkPath);
            if (wavResult) {
              localPath = wavResult.wavPath;
              duration = wavResult.duration / 1000;
              log?.debug?.(`Voice: SILK→WAV (${formatDuration(duration)})`);
            } else {
              localPath = silkPath;
            }
          }
        }
      }
    }
  } catch (err) {
    log?.error(`Voice download/convert failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (localPath) {
    try {
      const transcript = await transcribeAudio(localPath, cfg2stt(sttCfg));
      if (transcript) {
        log?.debug?.(`Voice STT: ${transcript.slice(0, 80)}...`);
        return { text: transcript, source: 'stt', duration, localPath, remoteUrl, asrReferText };
      }
    } catch (err) {
      log?.error(`Voice STT failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (asrReferText) {
    return { text: asrReferText, source: 'asr', duration, localPath, remoteUrl, asrReferText };
  }

  return {
    text: '[Voice message - transcription failed]',
    source: 'fallback',
    duration,
    localPath,
    remoteUrl,
    asrReferText,
  };
}

// ── 配置 ──

interface AudioPolicyResolved {
  sttDirectFormats: string[];
  uploadDirectFormats: string[];
  transcodeEnabled: boolean;
}

function resolveAudioPolicy(cfg: Record<string, unknown>): AudioPolicyResolved {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const qqbot = channels?.qqbot as Record<string, unknown> | undefined;
  const policy = qqbot?.audioFormatPolicy as Record<string, unknown> | undefined;

  return {
    sttDirectFormats: normalizeFormats((policy?.sttDirectFormats as string[]) ?? []),
    uploadDirectFormats: normalizeFormats(
      (policy?.uploadDirectFormats as string[]) ?? ['.wav', '.mp3', '.silk'],
    ),
    transcodeEnabled: (policy?.transcodeEnabled as boolean) !== false,
  };
}

function normalizeFormats(formats: string[]): string[] {
  return formats.map((f) => {
    const lower = f.toLowerCase().trim();
    return lower.startsWith('.') ? lower : `.${lower}`;
  });
}

function cfg2stt(sttCfg: NonNullable<ReturnType<typeof resolveSTTConfig>>): Record<string, unknown> {
  return { channels: { qqbot: { stt: sttCfg } } };
}

// ── 文件工具 ──

function normalizeUrl(url: string | undefined): string {
  if (!url) return '';
  return url.startsWith('//') ? `https:${url}` : url;
}

async function downloadMediaFile(
  url: string,
  filename?: string,
  log?: Log,
): Promise<string | null> {
  // 仅允许 HTTPS（安全策略）
  if (!url.startsWith('https://')) {
    log?.debug?.(`Skipping non-HTTPS URL: ${url.slice(0, 80)}`);
    return null;
  }

  try {
    const result = await downloadRemoteMedia({
      url,
      subdir: 'qqbot/downloads',
      originalFilename: filename,
      maxBytes: 500 * 1024 * 1024,
      timeoutMs: 120_000,
    });
    log?.debug?.(`Downloaded: ${result.path}`);
    return result.path;
  } catch (err) {
    log?.error(`Download failed: ${url.slice(0, 80)} — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
