#!/usr/bin/env node
/**
 * 本地测试环境：写 `--dev` profile 的 openclaw 配置。
 *
 * 目标：
 *   1. 装一个指向本地假 LLM 的 provider（完全免凭据）
 *   2. 配一个指向本地假 QQ 平台的 qqbot 通道
 *   3. 用 `plugins.loadPaths` 把本仓库直接挂进 dev profile（不复制，改代码即时生效）
 *
 * 不改动真实 profile（~/.openclaw），只动 ~/.openclaw-dev。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEV_DIR = path.join(os.homedir(), '.openclaw-dev');
export const CONFIG_PATH = path.join(DEV_DIR, 'openclaw.json');
export const REPO_ROOT = '/root/qqbot-openclaw';
export const LOCAL_ENV_DIR = path.join(REPO_ROOT, 'tests', 'local-env');
export const LLM_CONTROL = path.join(LOCAL_ENV_DIR, 'mock-llm-control.json');
export const QQ_CONTROL = path.join(LOCAL_ENV_DIR, 'mock-qq-control.json');
export const QQ_RECORD = path.join(LOCAL_ENV_DIR, 'mock-qq-record.jsonl');
export const LLM_PORT = 4010;
export const QQ_PORT = 4020;
export const MOCK_OPENID = 'MOCK_OPENID_0001';
export const MOCK_GROUP_OPENID = 'MOCK_GROUP_0001';

/** 读现有 dev 配置（不存在则空对象） */
export function readDevConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * 写 dev 配置。
 * @param {object} opts
 * @param {'partial'|'stream'|'off'} opts.mode       qqbot 流式模式
 * @param {'stream'|'static'} opts.sendMode          qqbot 下发通道
 * @param {boolean} [opts.blockStreamingDefault]     全局块流式（验证双投）
 * @param {boolean} [opts.includeFooter]             假 LLM 是否在末尾追加 usage 行
 */
export function writeDevConfig(opts) {
  const cfg = readDevConfig();

  cfg.models = {
    ...(cfg.models || {}),
    mode: 'merge',
    providers: {
      ...((cfg.models && cfg.models.providers) || {}),
      mockllm: {
        baseUrl: `http://127.0.0.1:${LLM_PORT}/v1`,
        apiKey: 'mock-key',
        api: 'openai-completions',
        authHeader: true,
        models: [
          {
            id: 'mock-llm',
            name: 'Mock LLM',
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
      model: 'mockllm/mock-llm',
      skipBootstrap: true,
    },
  };

  if (opts.blockStreamingDefault !== undefined) {
    cfg.agents.defaults.blockStreamingDefault = opts.blockStreamingDefault ? 'on' : 'off';
  }

  cfg.channels = {
    ...(cfg.channels || {}),
    qqbot: {
      appId: 'MOCK_APP_ID',
      clientSecret: 'MOCK_CLIENT_SECRET',
      enabled: true,
      // 走 webhook 传输：插件把 HTTP 服务交给框架的 webhook-ingress
      // （端口由 gateway 提供），从而**完全绕开 QQ 的 WebSocket 网关**——
      // 本地假平台只需实现 HTTP API 即可，出站即可跑通。
      transport: 'webhook',
      webhook: { path: '/qqbot/webhook' },
      // 注意：openclaw 2026.10.5 对 channels.qqbot 强制应用「Tencent QQBot 2.0」
      // 的 host schema（按 channel id 匹配，与加载哪个插件无关）：
      //   - allowFrom 禁 "*"（not: {const:"*"}）
      //   - allowFrom 项必须匹配 ^[^a-z]*$（不含小写字母）或等于
      //     "openclaw:approval-disabled"
      //   - 禁 defaultAccount 键、禁 accounts.default 键
      //   - accounts.<id>.allowFrom 是必填
      // 所以这里用 dmPolicy=allowlist + 一个「无小写字母」的假 openid，
      // 同时满足框架 host schema 与插件自身 schema。
      dmPolicy: 'allowlist',
      allowFrom: ['MOCKOPENID0001'],
      groupPolicy: 'open',
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
      // 本地测试环境只需要 qqbot + 少量核心插件；其余内置插件在本机
      // 4 核 / 3.6GiB / 无（或极少）swap 的环境里是纯内存负担
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
  // loadPaths / load.paths 不是本方案要用的加载方式：走配置路径加载会触发框架的
  // 「插件源码捕获」机制，入口文件被判定为「在捕获包之外」而拒绝加载。
  // 插件通过 `openclaw --dev plugins install <repo>` 装进 extensions/ 走标准路径。
  delete cfg.plugins.loadPaths;
  delete cfg.plugins.load;

  fs.mkdirSync(DEV_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`);
  return CONFIG_PATH;
}

/** 写假 LLM 的行为控制文件 */
export function writeLlmControl(ctl) {
  fs.writeFileSync(LLM_CONTROL, `${JSON.stringify(ctl, null, 2)}\n`);
}

/** 写假 QQ 平台的行为控制文件 */
export function writeQqControl(ctl) {
  fs.writeFileSync(QQ_CONTROL, `${JSON.stringify(ctl, null, 2)}\n`);
}

/** 读取假 QQ 平台记录的全部请求 */
export function readQqRecords() {
  try {
    return fs
      .readFileSync(QQ_RECORD, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** 清空假 QQ 平台的记录 */
export function clearQqRecords() {
  try {
    fs.unlinkSync(QQ_RECORD);
  } catch {
    /* ignore */
  }
}
