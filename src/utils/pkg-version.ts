/**
 * 版本号获取工具。
 *
 * - getPackageVersion(): 插件自身版本（@tencent-connect/openclaw-qqbot）
 * - getOpenclawVersion():  OpenClaw 框架版本（PluginRuntime.version）
 */

declare const __PLUGIN_VERSION__: string;

/**
 * 获取插件自身版本号。
 * 编译时由 tsup define 注入，零运行时 IO。
 */
export function getPackageVersion(): string {
  return typeof __PLUGIN_VERSION__ !== 'undefined' ? __PLUGIN_VERSION__ : 'unknown';
}

/**
 * OpenClaw 框架版本（PluginRuntime.version，peer >=2026.9.2 恒存在）。
 */
export function getOpenclawVersion(runtimeVersion?: string): string {
  return runtimeVersion && runtimeVersion !== 'unknown' ? runtimeVersion : 'unknown';
}
