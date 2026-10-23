#!/usr/bin/env node
/**
 * 本地测试环境（真实凭据模式）：写 `--dev` profile 的 openclaw 配置。
 *
 * 与 setup.mjs 的区别：
 *   - provider 指向**真实**的 OpenAI-compatible 端点（凭据走 `${ENV}` 插值，
 *     **明文不落配置文件、更不落仓库**）
 *   - qqbot 通道指向**真实** QQ 开放平台（websocket 传输）
 *
 * 需要的环境变量（启动 gateway 时导出）：
 *   LLM_BASE_URL           OpenAI-compatible 端点（如 https://<host>/v1）
 *   LLM_API_KEY            模型的 apiKey
 *   LLM_MODEL_ID           模型 id（可选，默认 'llm-model'）
 *   LLM_PROVIDER_ID        provider 段名（可选，默认 'llm'）
 *   QQBOT_APP_ID           QQ Bot 的 appId
 *   QQBOT_CLIENT_SECRET    QQ Bot 的 appSecret
 *
 * 注意 `channels.qqbot.allowFrom`：
 *   openclaw 2026.10.5 对 channels.qqbot 强制应用「Tencent QQBot 2.0」的
 *   host schema（按 channel id 匹配，与加载哪个插件无关）——allowFrom 必填、
 *   禁 "*"、元素须匹配 ^[^a-z]*$。而插件运行时的准入优先级是
 *   `disabled → open → allowlist → pairing`，`dmPolicy:"open"` 直接放行、
 *   根本不读 allowFrom。所以这里放一个**合法的占位值**即可（框架 schema
 *   能过、插件运行时也放行），代价是框架 doctor 会报一条
 *   「open 但 allowFrom 不含 *」的**误报警告**（插件实际不读 allowFrom）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEV_DIR = path.join(os.homedir(), '.openclaw-dev');
export const CONFIG_PATH = path.join(DEV_DIR, 'openclaw.json');
export const REPO_ROOT = '/root/qqbot-openclaw';

/**
 * @param {object} opts
 * @param {'partial'|'stream'|'off'} opts.mode
 * @param {'stream'|'static'} opts.sendMode
 * @param {boolean} [opts.blockStreamingDefault]
 */
export function writeRealDevConfig(opts) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    /* ignore */
  }

  // provider 全部由环境变量驱动——**仓库里不硬编码任何主机名/模型名**。
  // 需要的 env：
  //   LLM_BASE_URL    OpenAI-compatible 端点（如 https://<host>/v1）
  //   LLM_API_KEY     模型的 apiKey
  //   LLM_MODEL_ID    模型 id（默认 'llm-model'）
  //   LLM_PROVIDER_ID provider 段名（默认 'llm'）
  const providerId = process.env.LLM_PROVIDER_ID?.trim() || 'llm';
  const modelId = process.env.LLM_MODEL_ID?.trim() || 'llm-model';
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  if (!baseUrl) {
    throw new Error(
      'LLM_BASE_URL 未设置——真实模式必须显式指定 OpenAI-compatible 端点（仓库不硬编码主机名）',
    );
  }
  cfg.models = {
    ...(cfg.models || {}),
    mode: 'merge',
    providers: {
      ...((cfg.models && cfg.models.providers) || {}),
      [providerId]: {
        baseUrl,
        apiKey: '${LLM_API_KEY}',
        api: 'openai-completions',
        authHeader: true,
        models: [
          {
            id: modelId,
            name: modelId,
            api: 'openai-completions',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  };

  cfg.agents = {
    ...(cfg.agents || {}),
    defaults: {
      ...((cfg.agents && cfg.agents.defaults) || {}),
      model: `${providerId}/${modelId}`,
      skipBootstrap: true,
    },
  };
  if (opts.blockStreamingDefault !== undefined) {
    cfg.agents.defaults.blockStreamingDefault = opts.blockStreamingDefault ? 'on' : 'off';
  }

  cfg.channels = {
    ...(cfg.channels || {}),
    qqbot: {
      appId: '${QQBOT_APP_ID}',
      clientSecret: '${QQBOT_CLIENT_SECRET}',
      enabled: true,
      transport: 'websocket',
      // 真实平台走 WS；outbound 的 baseUrl 不覆盖，打到真 api.sgroup.qq.com
      dmPolicy: 'open',
      allowFrom: ['MOCKOPENID0001'],
      groupPolicy: 'allowlist',
      streaming: {
        mode: opts.mode,
        sendMode: opts.sendMode,
      },
    },
  };

  cfg.plugins = {
    ...(cfg.plugins || {}),
    entries: {
      ...((cfg.plugins && cfg.plugins.entries) || {}),
      qqbot: { enabled: true },
      anthropic: { enabled: false },
      browser: { enabled: false },
      canvas: { enabled: false },
      'cua-computer': { enabled: false },
      'device-pair': { enabled: false },
      'file-transfer': { enabled: false },
      geolocation: { enabled: false },
      github: { enabled: false },
      'linux-node': { enabled: false },
      'memory-core': { enabled: false },
      ollama: { enabled: false },
      openai: { enabled: false },
      'talk-voice': { enabled: false },
      xai: { enabled: false },
    },
  };
  delete cfg.plugins.loadPaths;
  delete cfg.plugins.load;

  fs.mkdirSync(DEV_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  return CONFIG_PATH;
}
