#!/usr/bin/env node
/**
 * 本地假 LLM（OpenAI-compatible，SSE 流式）——用于 openclaw 本地测试环境。
 *
 * 完全免凭据：openclaw 通过 `models.providers.<name>.baseUrl` 指向本服务。
 * 行为由控制文件驱动（默认同目录 `mock-llm-control.json`），测试脚本可在
 * 每个场景前改写它来切换模型的输出形态。
 *
 * 控制文件字段：
 *   - mode: "text" | "tool"     纯文本 / 先发一个工具调用再发文本
 *   - text: string              mode=text 时的回复正文
 *   - toolName / toolArgs: str  mode=tool 时的工具名与参数 JSON
 *   - chunkSize: number         每个 SSE delta 的字符数
 *   - delayMs: number           每个 delta 之间的间隔（模拟模型吐字速度）
 *   - includeFooter: boolean    是否在末尾追加 usage 行（验证 final 重复问题）
 *
 * 用法：node mock-llm.mjs [--port 4010] [--control <path>]
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

const PORT = Number(arg('port', process.env.MOCK_LLM_PORT || 4010));
const CONTROL_PATH = arg('control', path.join(__dirname, 'mock-llm-control.json'));

function loadControl() {
  try {
    return JSON.parse(fs.readFileSync(CONTROL_PATH, 'utf8'));
  } catch {
    return { mode: 'text', text: 'hello', chunkSize: 40, delayMs: 10 };
  }
}

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function streamText(res, text, chunkSize, delayMs, id) {
  for (let i = 0; i < text.length; i += chunkSize) {
    sse(res, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: 'mock-llm',
      choices: [{ index: 0, delta: { content: text.slice(i, i + chunkSize) }, finish_reason: null }],
    });
    if (delayMs > 0) await sleep(delayMs);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: 'mock-llm', object: 'model', owned_by: 'local' }],
    }));
    return;
  }

  if (req.method !== 'POST' || !url.pathname.endsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route for ${req.method} ${url.pathname}` } }));
    return;
  }

  // 读取请求体
  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    /* ignore */
  }

  const ctl = loadControl();
  const chunkSize = Math.max(1, Number(ctl.chunkSize) || 40);
  const delayMs = Math.max(0, Number(ctl.delayMs) || 0);
  const id = `chatcmpl-mock-${Date.now()}`;
  const model = body.model || 'mock-llm';

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  if (ctl.mode === 'tool') {
    // 工具调用：先发 tool_calls delta，再发一段收尾文本。
    const args = ctl.toolArgs || '{}';
    sse(res, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_mock_1',
                type: 'function',
                function: { name: ctl.toolName || 'message', arguments: args },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    if (delayMs > 0) await sleep(delayMs);
    sse(res, {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
  } else {
    let text = ctl.text || 'hello';
    if (ctl.includeFooter) text += '\nUsage: 66k in / 9.8k out · cache 894k cached / 0 new';
    await streamText(res, text, chunkSize, delayMs, id);
  }

  sse(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1 (control: ${CONTROL_PATH})`);
});
