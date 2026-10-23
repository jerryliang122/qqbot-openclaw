#!/usr/bin/env node
/**
 * 本地假 QQ Open Platform —— 用于 openclaw 本地测试环境。
 *
 * 完全免凭据：插件用 `QQBOT_BASE_URL` / `QQBOT_TOKEN_BASE_URL` 指向本服务
 * （见 src/gateway/qqbot-gateway.ts:119-120）。
 *
 * 覆盖的端点：
 *   POST /app/getAppAccessToken           → 假 access_token
 *   GET  /v2/users/{openid}/messages      → 假 msg_id（取被动回复锚点）
 *   POST /v2/users/{openid}/messages      → 发私聊消息（记录）
 *   POST /v2/users/{openid}/stream_messages → 原生流式帧（记录）
 *   POST /v2/groups/{gid}/messages        → 发群消息（记录）
 *
 * 行为由控制文件驱动（默认同目录 `mock-qq-control.json`）：
 *   - quotaAfter: number   前 N 次发送成功，第 N+1 次起返回 40034128（被动超限）
 *   - expireAfter: number  前 N 次发送成功，第 N+1 次起返回 40034005（msg_id 过期）
 *   - failAlways: boolean  全部返回 500
 *
 * 所有请求记录到 `mock-qq-record.jsonl`，供断言读取。
 *
 * 用法：node mock-qq.mjs [--port 4020] [--control <path>] [--record <path>]
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', process.env.MOCK_QQ_PORT || 4020));
const CONTROL_PATH = arg('control', path.join(__dirname, 'mock-qq-control.json'));
const RECORD_PATH = arg('record', path.join(__dirname, 'mock-qq-record.jsonl'));

function loadControl() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'));
  } catch {
    return {};
  }
}

let sendCount = 0;
function record(entry) {
  try {
    fs.appendFileSync(RECORD_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore */
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({ _raw: raw });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const ctl = loadControl();
  const body = req.method === 'POST' ? await readBody(req) : {};

  const json = (status, obj) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  // ── token ──
  if (url.pathname === '/app/getAppAccessToken') {
    record({ kind: 'token', at: Date.now() });
    json(200, { access_token: 'MOCK_ACCESS_TOKEN', expires_in: 7200 });
    return;
  }

  // ── 取被动回复锚点 ──
  if (req.method === 'GET' && /^\/v2\/users\/[^/]+\/messages$/.test(url.pathname)) {
    record({ kind: 'get-msg-id', path: url.pathname, at: Date.now() });
    json(200, { id: `MOCK_MSG_${Date.now()}`, msg_id: `MOCK_MSG_${Date.now()}` });
    return;
  }

  // ── 发消息 ──
  const isUserMsg = /^\/v2\/users\/[^/]+\/messages$/.test(url.pathname);
  const isGroupMsg = /^\/v2\/groups\/[^/]+\/messages$/.test(url.pathname);
  const isStreamMsg = /^\/v2\/users\/[^/]+\/stream_messages$/.test(url.pathname);

  if (req.method === 'POST' && (isUserMsg || isGroupMsg || isStreamMsg)) {
    const seq = ++sendCount;
    record({
      kind: isStreamMsg ? 'stream' : 'send',
      path: url.pathname,
      target: url.pathname.split('/')[3],
      seq,
      at: Date.now(),
      body,
    });

    if (ctl.failAlways) {
      json(500, { code: 500, message: 'mock failure' });
      return;
    }
    const quotaAfter = Number(ctl.quotaAfter);
    if (Number.isFinite(quotaAfter) && seq > quotaAfter) {
      json(400, {
        code: 40034128,
        message: '被动回复次数已达上限',
        bizCode: 40034128,
      });
      return;
    }
    const expireAfter = Number(ctl.expireAfter);
    if (Number.isFinite(expireAfter) && seq > expireAfter) {
      json(400, {
        code: 40034005,
        message: 'msg_id 已过期',
        bizCode: 40034005,
      });
      return;
    }

    json(200, { id: `MOCK_OUT_${seq}`, timestamp: String(Date.now()) });
    return;
  }

  // ── 文件上传（媒体路径，测试里用不到，先给个合理响应）──
  if (req.method === 'POST' && url.pathname.includes('/upload_prepare')) {
    json(200, { file_info: { file_id: 'MOCK_FILE', upload_url: `http://127.0.0.1:${PORT}/mock-upload` } });
    return;
  }

  record({ kind: 'unhandled', method: req.method, path: url.pathname, at: Date.now() });
  json(404, { code: 404, message: `mock: no route for ${req.method} ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-qq] listening on http://127.0.0.1:${PORT} (control: ${CONTROL_PATH})`);
  console.log(`[mock-qq] records -> ${RECORD_PATH}`);
});
