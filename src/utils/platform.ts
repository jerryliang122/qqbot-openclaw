/**
 * 跨平台兼容工具
 *
 * 统一 Mac / Linux / Windows 三大系统的：
 * - 用户主目录获取
 * - 插件数据目录 / 媒体目录获取
 *
 * ⚠️ 本文件只保留**实际有调用方**的函数（2026-11-17 清理）：
 * `getPlatform` / `isWindows` / `getTempDir` / `expandTilde` / `normalizePath` /
 * `sanitizeFileName` / `isLocalPath` / `looksLikeLocalPath` / ffmpeg 探测 /
 * silk-wasm 探测 / `runDiagnostics` 全部零引用，已移除。
 *
 * 其中 `normalizePath` 有一份**活体**在 `src/outbound/local-file-router.ts`
 * （媒体发送路径用那份，它额外处理 `file:///C:/…` 的 Windows 盘符）——**不要
 * 在这里另起一份**，否则两处语义必然分叉。
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// ============ 用户主目录 ============

/**
 * 安全获取用户主目录
 *
 * 优先级:
 * 1. os.homedir()（Node 原生，所有平台）
 * 2. $HOME（Mac/Linux）或 %USERPROFILE%（Windows）
 * 3. 降级到 /tmp（Linux/Mac）或 os.tmpdir()（Windows）
 *
 * 与之前 `process.env.HOME || "/home/ubuntu"` 的硬编码相比，
 * 现在能正确处理 Windows 和非 ubuntu 用户。
 */
export function getHomeDir(): string {
  try {
    const home = os.homedir();
    if (home && fs.existsSync(home)) return home;
  } catch {}

  // fallback 环境变量
  const envHome = process.env.HOME || process.env.USERPROFILE;
  if (envHome && fs.existsSync(envHome)) return envHome;

  // 最后降级
  return os.tmpdir();
}

/**
 * 获取 .openclaw/qqbot 下的子目录路径，并自动创建
 * 替代各文件中分散的 path.join(HOME, ".openclaw", "qqbot", ...)
 */
export function getQQBotDataDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "qqbot", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * 获取 .openclaw/media/qqbot 下的子目录路径，并自动创建
 *
 * 与 getQQBotDataDir 不同，此目录位于 OpenClaw 核心的媒体安全白名单
 * (~/.openclaw/media) 之下，下载到这里的文件可以被框架的 image/media
 * 工具直接访问，不会触发 "Local media path is not under an allowed directory" 错误。
 *
 * 用于存放从 QQ 下载的图片、语音等需要被框架处理的媒体文件。
 */
export function getQQBotMediaDir(...subPaths: string[]): string {
  const dir = path.join(getHomeDir(), ".openclaw", "media", "qqbot", ...subPaths);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
