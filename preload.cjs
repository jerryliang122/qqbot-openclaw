/**
 * 插件预加载入口（CJS 格式）。
 *
 * openclaw 框架通过 require() 加载插件，因此需要 .cjs 后缀
 * 确保在 "type": "module" 的 package 中也能被正确 require()。
 *
 * 在 require 真正的插件代码（依赖 openclaw/plugin-sdk）之前，
 * 先同步确保 node_modules/openclaw symlink 存在。
 */
"use strict";

const path = require("node:path");
const { ensurePluginSdkSymlink } = require("./scripts/link-sdk-core.cjs");

// 1) 同步创建 symlink（确保 openclaw/plugin-sdk 可解析）
ensurePluginSdkSymlink(__dirname, "[preload]");

// 2) 加载编译产物（tsup CJS 输出）
module.exports = require(path.join(__dirname, "dist", "index.cjs"));
