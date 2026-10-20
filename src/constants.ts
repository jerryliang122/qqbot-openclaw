/**
 * QQBot 常量定义
 */

/** QQ Bot 单条消息文本长度上限 */
export const TEXT_CHUNK_LIMIT = 5000;

/**
 * QQ Bot 语音消息（file_type=3）软限制：20 MB
 *
 * 官方文档《富媒体消息概述》：
 *   | file_type | 类型 | 格式  | 软限制 | 硬限制 |
 *   | 1         | 图片 | png/jpg | 20 MB | 200 MB |
 *   | 2         | 视频 | mp4      | 30 MB | 200 MB |
 *   | 3         | 语音 | silk     | 20 MB | 200 MB |
 *   | 4         | 文件 | -        | 200 MB | 200 MB |
 *   「超过软限制会降级为文件类型上传，超过硬限制会报错。」
 *
 * 注意：语音**没有时长限制**（只有体积限制）——「60 秒以内是语音条」是体积与时长的
 * 相关性错觉：TTS 语音通常只有几百 KB～1 MB，远低于 20 MB。
 */
export const QQBOT_VOICE_SOFT_LIMIT_BYTES = 20 * 1024 * 1024;

/** QQ Bot 语音消息支持的音频格式（平台只会把这几种渲染成语音条） */
export const QQBOT_VOICE_FORMATS = ['silk', 'mp3', 'wav', 'ogg'] as const;
