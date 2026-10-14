/**
 * QQBot 插件运行时管理。
 *
 * 日志统一由 `utils/plugin-logger.ts` 提供，此处只管理 runtime 实例。
 */

import type { PluginRuntime } from "openclaw/plugin-sdk";
import { setOpenClawVersion } from "./bot-instance.js";
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
    // c2c 入站防抖缓冲 best-effort 冲刷：动态 import 断开静态环
    // plugin-logger → runtime → inbound-debounce → dispatch → plugin-logger
    // （静态边会让 dispatch 图内的模块顶层求值撞上未初始化的 plugin-logger，
    // tsx/esbuild 下表现为 `__name is not a function`，见 CI 事故）。
    // SIGINT/SIGTERM 下 process.exit 不等待（丢失 ≤ 一个窗口的消息）；
    // beforeExit 下 flush 的异步 dispatch 会重新拉起事件循环自然完成。
    try {
      void import("./features/inbound-debounce.js")
        .then((m) => m.flushAllC2CInboundDebouncers())
        .catch(() => {});
    } catch {}
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
