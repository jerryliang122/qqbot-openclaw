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

  const flushStores = () => {
    try { flushAllRefIndexStores(); } catch {}
  };

  // c2c 入站防抖缓冲冲刷：动态 import 断开静态环
  // plugin-logger → runtime → inbound-debounce → dispatch → plugin-logger
  // （静态边会让 dispatch 图内的模块顶层求值撞上未初始化的 plugin-logger，
  // tsx/esbuild 下表现为 `__name is not a function`，见 CI 事故）。
  const flushDebounceBuffers = async (): Promise<void> => {
    try {
      const m = await import("./features/inbound-debounce.js");
      await m.flushAllC2CInboundDebouncers();
    } catch {}
  };

  process.on('beforeExit', () => {
    flushStores();
    // flush 的异步 dispatch 会重新拉起事件循环，turn 自然跑完后再进 beforeExit
    void flushDebounceBuffers();
  });

  // SIGINT/SIGTERM：有界等待（≤1.5s）缓冲冲刷完成再退出。flushAll 是
  // 两段式：先 flushKey 等「turn 已入 lane 队列」（admission），再等在途
  // dispatch 的 completion（整个 turn run）——退出宽限内能跑完的 turn
  // 把回复发完；不为更长的 agent turn 无界等待（turn 被框架队列 defer 时
  // 后台继续，无界等待会让 Ctrl+C 卡死）。二次信号不受影响（handler
  // 幂等，超时定时器兜底强退）。
  const shutdown = () => {
    flushStores();
    const forceExit = () => process.exit(0);
    const timer = setTimeout(forceExit, 1500);
    void flushDebounceBuffers().finally(() => {
      clearTimeout(timer);
      forceExit();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export function getQQBotRuntime(): PluginRuntime {
  if (!runtime) throw new Error("QQBot runtime not initialized");
  return runtime;
}

export function tryGetQQBotRuntime(): PluginRuntime | null {
  return runtime;
}
