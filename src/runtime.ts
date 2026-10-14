/**
 * QQBot 插件运行时管理。
 *
 * 日志统一由 `utils/plugin-logger.ts` 提供，此处只管理 runtime 实例。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";
import { setOpenClawVersion } from "./bot-instance.js";
import { flushAllC2CInboundDebouncers } from "./features/inbound-debounce.js";
import { flushAllRefIndexStores } from "./features/ref-index-store.js";
import { getOpenclawVersion } from "./utils/pkg-version.js";

let runtime: PluginRuntime | null = null;
let exitHooksInstalled = false;

export function setQQBotRuntime(next: PluginRuntime) {
  runtime = next;
  const version = getOpenclawVersion(next.version);
  setOpenClawVersion(version);
  installExitHooksOnce();
}

function installExitHooksOnce(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;

  const flush = () => {
    try { flushAllRefIndexStores(); } catch {}
    // c2c 入站防抖缓冲 best-effort 冲刷：SIGINT/SIGTERM 下 process.exit
    // 不等待（丢失 ≤ 一个窗口的消息，与在途处理同级别损失）；beforeExit
    // 下 drain 的异步 dispatch 会重新拉起事件循环自然完成。
    try { void flushAllC2CInboundDebouncers(); } catch {}
  };

  process.on('beforeExit', flush);
  process.on('SIGINT', () => { flush(); process.exit(0); });
  process.on('SIGTERM', () => { flush(); process.exit(0); });
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("QQBot runtime not initialized");
  return runtime;
}

export function tryGetQQBotRuntime(): PluginRuntime | null {
  return runtime;
}
