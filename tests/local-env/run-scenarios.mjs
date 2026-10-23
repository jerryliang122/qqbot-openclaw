#!/usr/bin/env node
/**
 * 本地测试环境场景驱动器（openclaw-qqbot）。
 *
 * 职责：
 *   - 启/停两个 mock（假 LLM / 假 QQ 平台）与 openclaw gateway
 *   - 按场景切换控制文件（mock-llm-control.json / mock-qq-control.json）
 *     与 `--dev` profile 配置（复用 setup.mjs / setup-real.mjs）
 *   - 跑 turn 并从 mock-qq-record.jsonl 读回发送记录
 *   - 做断言并打印 PASS/FAIL 汇总（有失败 → 退出码 1）
 *
 * 两种 turn 驱动：
 *   - inbound：向 gateway 的 webhook 路由 POST 一条**签名合法的** QQ 入站事件
 *     （Ed25519，secret 派生算法与官方 SDK 一致）。这是唯一能真正跑通
 *     「流式三态」管线的路径——`openclaw agent -m` 这种 one-shot CLI
 *     **不跑流式管线**（partial/stream 都只发 1 条普通消息）。
 *   - cli：`openclaw --dev agent --reply-channel qqbot --reply-to ... --deliver`
 *     （真实凭据模式用；也作为 inbound 不可用时的降级路径，但**它无法验证流式**）
 *
 * 用法：
 *   node tests/local-env/run-scenarios.mjs [--scenario <name>] [--real] [--list] [--help]
 *
 * 幂等：每次跑先清 mock-qq-record.jsonl、先杀掉自己上次起的进程（pid 文件）。
 *
 * 凭据安全：`--real` 模式下凭据只从 process.env 读，**不写入任何文件**；
 * 缺失即明确报错退出。
 */

import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const setup = await import(path.join(__dirname, 'setup.mjs'));
const setupReal = await import(path.join(__dirname, 'setup-real.mjs'));

const DEV_DIR = setup.DEV_DIR;
const CONFIG_PATH = setup.CONFIG_PATH;
const LLM_CONTROL = setup.LLM_CONTROL;
const QQ_CONTROL = setup.QQ_CONTROL;
const QQ_RECORD = setup.QQ_RECORD;
const LLM_PORT = setup.LLM_PORT;
const QQ_PORT = setup.QQ_PORT;

const GW_LOG_DIR = path.join(DEV_DIR, 'local-env-logs');
const PID_FILE = path.join(DEV_DIR, 'local-env-runner.pid');

/** openclaw CLI（优先用仓库内钉版，其次 PATH） */
const OPENCLAW_BIN = fs.existsSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'openclaw'))
  ? path.join(REPO_ROOT, 'node_modules', '.bin', 'openclaw')
  : 'openclaw';

/** 离线版假凭据（与 setup.mjs 写入配置的一致，用于 webhook 签名） */
const MOCK_CLIENT_SECRET = 'MOCK_CLIENT_SECRET';

/** 框架在 dispatch 失败时兜底发出的固定文案（用于识别「网关还没热好」） */
const FRAMEWORK_ERROR_FALLBACK = 'Something went wrong while processing your request. Please try again.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// 输出helpers
// ─────────────────────────────────────────────────────────────

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6, ' ')}s`;
const log = (...a) => console.log(`[${stamp()}]`, ...a);
const step = (msg) => console.log(`\n[${stamp()}] === ${msg} ===`);
const warn = (msg) => console.log(`[${stamp()}] !! ${msg}`);

// ─────────────────────────────────────────────────────────────
// CLI 参数
// ─────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { scenario: 'all', real: false, help: false, list: false, keep: false, timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--list') out.list = true;
    else if (a === '--real') out.real = true;
    else if (a === '--keep') out.keep = true;
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a.startsWith('--scenario=')) out.scenario = a.slice('--scenario='.length);
    else if (a === '--timeout') out.timeout = Number(argv[++i]);
    else if (a.startsWith('--timeout=')) out.timeout = Number(a.slice('--timeout='.length));
    else if (a === '--no-color') { /* ignore */ }
    else {
      console.error(`未知参数：${a}`);
      out.unknown = a;
    }
  }
  return out;
}

const USAGE = `本地测试环境场景驱动器（openclaw-qqbot）

用法：
  node tests/local-env/run-scenarios.mjs [选项]

选项：
  --scenario <name>   只跑指定场景（默认 all = 全部）
  --real              真实凭据模式（凭据只从环境变量读；默认离线版）
  --list              列出全部场景后退出
  --timeout <sec>     单个 turn 的等待上限秒数（默认 180）
  --keep              跑完保留 gateway 进程（便于人工排障；默认关掉）
  --help, -h          打印本用法并退出（退出码 0）

场景：
  off          只发最终回复（无中间块）
  partial      中间块 + final（断言块数 ≥ 2 且正文不重复）
  stream       走 QQ 原生流式端点 /v2/users/{openid}/stream_messages
  quota        平台被动配额耗尽（mock quotaAfter=0）→ 断言没有「一条都没发」
  double-send  blockStreamingDefault=on，三态各跑一次 → 断言正文不出现两次

环境变量（仅 --real 需要，缺失即报错退出，不会写进任何文件）：
  LLM_BASE_URL           OpenAI-compatible 端点（如 https://<host>/v1）
  LLM_API_KEY            模型的 apiKey
  LLM_MODEL_ID           模型 id（可选，默认 'llm-model'）
  QQBOT_APP_ID           QQ Bot 的 appId
  QQBOT_CLIENT_SECRET    QQ Bot 的 appSecret
  QQBOT_TARGET_OPENID    对端 openid（真实模式下 --reply-to 的目标）
`;

function usage(exitCode = 0) {
  console.log(USAGE);
  process.exit(exitCode);
}

// ─────────────────────────────────────────────────────────────
// 进程管理（进程组：openclaw gateway 会再 fork 子进程，必须整组杀）
// ─────────────────────────────────────────────────────────────

const liveProcs = new Set();

function spawnGroup(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...(opts.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 独立进程组 → 可整组 kill
  });
  const rec = { name, child, pid: child.pid };
  liveProcs.add(rec);
  const onData = opts.onData;
  if (onData) {
    child.stdout.on('data', (d) => onData(d.toString()));
    child.stderr.on('data', (d) => onData(d.toString()));
  } else {
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
  }
  child.on('exit', (code, sig) => {
    liveProcs.delete(rec);
    if (!opts.quiet) log(`进程 ${name} 退出（code=${code} signal=${sig}）`);
  });
  return rec;
}

function killGroup(rec) {
  if (!rec || rec.child.exitCode !== null) return;
  try {
    process.kill(-rec.pid, 'SIGKILL'); // 负 pid = 整个进程组
  } catch {
    try { rec.child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  liveProcs.delete(rec);
}

function killAll() {
  for (const rec of [...liveProcs]) killGroup(rec);
}

/** 杀掉本 runner 上次留下的进程（pid 文件） */
function killPreviousRun() {
  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); } catch { return; }
  const pids = Array.isArray(prev?.pids) ? prev.pids : [];
  let killed = 0;
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGKILL');
      killed++;
    } catch {
      try { process.kill(pid, 'SIGKILL'); killed++; } catch { /* already gone */ }
    }
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ignore */ }
  if (killed) log(`清理上次残留进程：${killed} 个进程组`);
}

/** 进程是否还活着 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 读某个 pid 的 cmdline */
function pidCmdline(pid) {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch { return ''; }
}

/**
 * 停掉「占用 dev profile 的外来 gateway」。
 *
 * `~/.openclaw-dev` 是本环境独占的 profile，但 `openclaw plugins install`
 * 等命令会顺手起一个 gateway（它会一直驻留），导致本 runner 起的 gateway
 * 撞端口并以退出码 78 退出（"Another gateway already owns this state
 * directory"）。这里按 state 目录里的 owner 锁文件停掉它。
 */
async function stopForeignGateway() {
  const lockPath = path.join(DEV_DIR, 'tmp', 'openclaw-0', 'gateway.state.lock');
  let lock = null;
  try { lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { return null; }
  const pid = Number(lock?.pid);
  if (!Number.isFinite(pid) || pid === process.pid) return null;
  if (!pidAlive(pid)) return null;
  const cmd = pidCmdline(pid);
  if (!cmd.includes('openclaw')) return null;
  log(`检测到占用 dev profile 的 gateway（pid ${pid}），先停掉它`);
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  for (let i = 0; i < 20; i++) {
    if (!pidAlive(pid)) break;
    await sleep(500);
  }
  if (pidAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(1000);
  }
  return pid;
}

/** 杀掉占着指定端口的进程（用于 mock 端口残留） */
async function killPortOwner(port) {
  let out = '';
  try {
    out = execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const line = out.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l));
  if (!line) return null;
  const m = line.match(/pid=(\d+)/);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!pidAlive(pid)) return null;
  log(`端口 ${port} 被 pid ${pid} 占用，先停掉它`);
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
  await sleep(800);
  return pid;
}

function savePids() {
  try {
    fs.mkdirSync(DEV_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, `${JSON.stringify({ pids: [...liveProcs].map((r) => r.pid), at: Date.now() })}\n`);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────
// 断言
// ─────────────────────────────────────────────────────────────

class AssertionError extends Error {}

function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new AssertionError(`${label}\n  期望：${expected}\n  实际：${actual}`);
  }
}

function assertTrue(cond, label, detail = '') {
  if (!cond) throw new AssertionError(`${label}${detail ? `\n  ${detail}` : ''}`);
}

/** 归一化空白后比较两段文本 */
function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, '').trim();
}

// ─────────────────────────────────────────────────────────────
// 记录解析
// ─────────────────────────────────────────────────────────────

/**
 * 把 mock 记录拆成「内容消息」「typing 指示器」「流式帧」。
 * - 内容消息：body 里带 markdown.content / content / text
 * - typing：msg_type === 6（input_notify）
 * - 流式帧：path 以 /stream_messages 结尾
 */
function parseRecords(records) {
  const out = { contents: [], typings: [], streams: [], others: [] };
  for (const rec of records) {
    const body = rec.body || {};
    const msgType = body.msg_type;
    const content = body.markdown?.content ?? body.content ?? body.text ?? null;
    const item = { rec, body, content: content == null ? '' : String(content), msgType, path: rec.path };
    if (rec.kind === 'stream' || /\/stream_messages$/.test(rec.path || '')) out.streams.push(item);
    else if (msgType === 6) out.typings.push(item);
    else if (content != null) out.contents.push(item);
    else out.others.push(item);
  }
  return out;
}

const isProactive = (item) => !item.body.msg_id;

// ─────────────────────────────────────────────────────────────
// gateway 管理
// ─────────────────────────────────────────────────────────────

/** 读 dev 配置（不存在则空对象） */
function readDevConfigSafe() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

/**
 * 在 setup 写好的配置上打补丁（不重写配置逻辑）。
 *
 * 当前只有一处补丁：`channels.qqbot.inboundDebounce.debounceMs = 0`。
 *
 * 原因（本地环境实测）：插件的 c2c 入站防抖默认 3000ms，而 webhook 传输
 * 下框架在 HTTP 响应（ACK）返回后就结束了本次请求的「root work 准入」。
 * 防抖把 dispatch 推到 3s 之后 → 框架的 session 准入判定
 * `isGatewaySubordinateWorkAdmissionClosed()` 为真 → dispatch 直接抛
 * `GatewayDrainingError: Gateway is temporarily unavailable.`
 * （gateway 日志里表现为 `outcome=error` + 插件发兜底错误文案）。
 * 关掉防抖后 dispatch 落在请求作用域内，turn 正常跑起来。
 * 单条消息的测试场景不需要防抖，故本环境一律关掉。
 */
function patchDevConfig(patch) {
  const cfg = readDevConfigSafe();
  const merged = { ...cfg, ...patch };
  if (patch.channels?.qqbot || cfg.channels?.qqbot) {
    merged.channels = {
      ...(cfg.channels || {}),
      ...(patch.channels || {}),
      qqbot: {
        ...((cfg.channels && cfg.channels.qqbot) || {}),
        ...((patch.channels && patch.channels.qqbot) || {}),
      },
    };
  }
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
}

function gatewayPort() {
  const cfg = readDevConfigSafe();
  return Number(cfg?.gateway?.port) || 19001;
}

function webhookPath() {
  const cfg = readDevConfigSafe();
  return cfg?.channels?.qqbot?.webhook?.path || '/qqbot/webhook';
}

/**
 * 对端 openid（离线版）。
 *
 * 必须**全小写**：openclaw 2026.10.x 的 session key 有 canonical 硬约束
 * （key 必须等于其全小写折叠形），含大写的 peer 会让 dev profile 的
 * agent DB canonical 校验一直不 ready → 所有 dispatch 直接
 * `GatewayDrainingError: Gateway is temporarily unavailable.`（框架提示
 * "run openclaw doctor --fix"，但根因是数据不合法，doctor 修不掉）。
 *
 * 同时，框架的 host schema 又要求 `channels.qqbot.allowFrom` 必填、禁 `*`、
 * 元素不含小写字母（`^[^a-z]*$`）——两者只能靠**准入策略**解耦：
 * `dmPolicy: "open"` 让插件运行时直接放行、根本不读 allowFrom，
 * 于是 allowFrom 放一个合法占位值（全大写），真正的 sender 用全小写。
 */
const MOCK_OPENID_LOWER = 'mockopenid0001';

function targetOpenid() {
  if (opts.real) return process.env.QQBOT_TARGET_OPENID;
  return MOCK_OPENID_LOWER;
}

/** Ed25519 签名（算法与官方 SDK 的 webhook-verify.js 逐行一致） */
function ed25519Sign(secret, message) {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(seed.slice(0, 32), 'utf8'),
  ]);
  const key = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, message, key).toString('hex');
}

async function startGateway({ quiet = false } = {}) {
  fs.mkdirSync(GW_LOG_DIR, { recursive: true });
  const logPath = path.join(GW_LOG_DIR, `gateway-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });
  let buffer = '';
  let exited = null;
  const rec = spawnGroup('gateway', OPENCLAW_BIN, ['--dev', 'gateway'], {
    env: {
      QQBOT_BASE_URL: `http://127.0.0.1:${QQ_PORT}`,
      QQBOT_TOKEN_BASE_URL: `http://127.0.0.1:${QQ_PORT}`,
      NODE_OPTIONS: '--max-old-space-size=700',
    },
    onData: (chunk) => {
      logStream.write(chunk);
      buffer += chunk;
      if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
    },
  });
  rec.child.on('exit', (code) => { exited = code; });

  const state = {
    rec,
    logPath,
    logTail: (n = 60) => buffer.split('\n').slice(-n).join('\n'),
    logAll: () => buffer,
  };

  // 端口先腾干净（外来 gateway 可能还占着）
  await killPortOwner(gatewayPort());

  // ① 等 gateway 进程活下来（撞端口会以退出码 78 退出）
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (exited !== null) {
      throw new AssertionError(
        `gateway 启动失败（退出码 ${exited}）\n`
        + `  日志尾部：\n${buffer.split('\n').slice(-12).map((l) => `    ${l}`).join('\n')}`,
      );
    }
    if (/Gateway ready/.test(buffer)) break;
  }

  // ② 探活：用**故意错误的签名**打 webhook 路由——期望 401（路由已注册），
  //    404 说明连到的不是本 runner 起的 gateway（或插件没起来）。
  const port = gatewayPort();
  const wPath = webhookPath();
  let routeStatus = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    if (exited !== null) {
      throw new AssertionError(`gateway 启动中途退出（退出码 ${exited}）`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}${wPath}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-signature-timestamp': '0',
          'x-signature-ed25519': '00',
        },
        body: '{}',
      });
      routeStatus = res.status;
      await res.text();
      if (routeStatus !== 503 && routeStatus !== 404) break;
    } catch { /* not up yet */ }
  }
  if (routeStatus === 404) {
    throw new AssertionError(
      `webhook 路由 ${wPath} 在 :${port} 上不存在（404）\n`
      + `  可能原因：① 连到了别的 gateway；② 插件没装进 dev profile；③ 插件加载失败\n`
      + `  日志尾部：\n${buffer.split('\n').slice(-15).map((l) => `    ${l}`).join('\n')}`,
    );
  }
  if (routeStatus === 503) {
    throw new AssertionError('插件 runtime 迟迟未就绪（webhook 路由一直 503）');
  }
  log(`webhook 路由就绪（:${port}${wPath}，探针返回 ${routeStatus}）`);
  if (!quiet) log(`gateway 日志：${logPath}`);
  // 会话/agent-db 准入在 ready 之后才完成 → 给一点余热时间
  await sleep(8000);
  savePids();
  return state;
}

async function stopGateway(state) {
  if (!state) return;
  killGroup(state.rec);
  try { state.rec?.child?.stdout?.end(); } catch { /* ignore */ }
  await sleep(1500);
}

// ─────────────────────────────────────────────────────────────
// turn 驱动
// ─────────────────────────────────────────────────────────────

/** 向 webhook 路由 POST 一条签名合法的 QQ 入站事件（真正跑通流式管线） */
async function sendInbound({ text, openid, secret }) {
  const port = gatewayPort();
  const wPath = webhookPath();
  const body = JSON.stringify({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: `MOCK_INBOUND_${Date.now()}`,
      content: text,
      timestamp: new Date().toISOString(),
      author: { id: openid, user_openid: openid },
      attachments: [],
      message_type: 1,
      message_scene: { ext: [] },
      msg_elements: [],
    },
  });
  const ts = String(Date.now());
  const sig = ed25519Sign(secret, Buffer.concat([Buffer.from(ts, 'utf8'), Buffer.from(body, 'utf8')]));
  const res = await fetch(`http://127.0.0.1:${port}${wPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-signature-timestamp': ts,
      'x-signature-ed25519': sig,
    },
    body,
  });
  return { status: res.status, text: await res.text() };
}

/** one-shot CLI turn（真实凭据模式用；不跑流式管线） */
async function runCliTurn({ openid, text }) {
  const args = [
    '--dev', 'agent',
    '--reply-channel', 'qqbot',
    '--reply-to', `qqbot:c2c:${openid}`,
    '--reply-account', 'default',
    '--deliver',
    '-m', text,
    '--timeout', '180',
  ];
  return new Promise((resolve) => {
    const child = spawn(OPENCLAW_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 240_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * 跑一轮 turn 并等出站记录。
 * - inbound 驱动：最多重试 N 次（网关未热好时会兜底发错误文案）
 */
async function runTurn({ driver, openid, secret, timeoutSec }) {
  const deadline = Date.now() + timeoutSec * 1000;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt++;
    if (driver === 'inbound') {
      const r = await sendInbound({ text: '本地环境流式验证', openid, secret });
      if (r.status === 503) {
        log(`  第 ${attempt} 次入站：503（插件 runtime 启动中），2s 后重试`);
        await sleep(2000);
        continue;
      }
      if (r.status !== 200) {
        throw new AssertionError(`入站 webhook 返回 ${r.status}：${r.text}`);
      }
      log(`  第 ${attempt} 次入站已投递（${r.text}）`);
    } else {
      const r = await runCliTurn({ openid, text: '本地环境流式验证' });
      log(`  CLI turn 退出码 ${r.code}`);
    }

    // 等内容消息出现
    let parsed = parseRecords(setup.readQqRecords());
    while (Date.now() < deadline) {
      parsed = parseRecords(setup.readQqRecords());
      if (parsed.contents.length > 0 || parsed.streams.length > 0) break;
      await sleep(1000);
    }
    const isFallback = parsed.contents.some((c) => c.content.includes(FRAMEWORK_ERROR_FALLBACK));
    if (isFallback && driver === 'inbound' && attempt < 4) {
      warn(`  第 ${attempt} 次入站拿到框架兜底错误文案（网关未热好），清记录后重试`);
      setup.clearQqRecords();
      await sleep(6000);
      continue;
    }
    return parsed;
  }
  throw new AssertionError(`等待出站记录超时（${timeoutSec}s）`);
}

// ─────────────────────────────────────────────────────────────
// 场景定义
// ─────────────────────────────────────────────────────────────

const BODY = '第一段正文：本地环境验证。\n第二段正文：流式三态。\n第三段正文：收尾。';
const FOOTER = 'Usage: 66k in / 9.8k out · cache 894k cached / 0 new';

/** 三态 → 配置面映射（见 resolveQQBotStreamMode） */
const MODE_CONFIG = {
  off: { mode: 'off' },
  partial: { mode: 'partial', sendMode: 'static' },
  stream: { mode: 'partial', sendMode: 'stream' },
};

const SCENARIOS = [
  {
    name: 'off',
    title: 'off：只发最终回复（无中间块）',
    driver: 'inbound',
    config: { ...MODE_CONFIG.off, blockStreamingDefault: 'off' },
    llm: { mode: 'text', text: BODY, chunkSize: 12, delayMs: 120, includeFooter: true },
    qq: {},
    expect(parsed, ctx) {
      const contents = parsed.contents;
      assertEq(contents.length, 1, 'off 态应只发出 1 条内容消息（无中间块）');
      const only = contents[0];
      assertTrue(
        only.content.includes(FOOTER),
        'off 态的唯一消息应是 final（含 usage footer）',
        `实际内容尾部：…${only.content.slice(-80)}`,
      );
      assertTrue(
        !only.content.includes(BODY.split('\n')[1]),
        'off 态不应出现中间块（不应只发一半正文）',
        `实际内容：${only.content.slice(0, 120)}`,
      );
    },
  },
  {
    name: 'partial',
    title: 'partial：中间块 + final（正文不重复）',
    driver: 'inbound',
    config: { ...MODE_CONFIG.partial, blockStreamingDefault: 'on' },
    llm: { mode: 'text', text: BODY, chunkSize: 12, delayMs: 250, includeFooter: true },
    qq: {},
    expect(parsed, ctx) {
      const contents = parsed.contents;
      assertTrue(contents.length >= 2, 'partial 态应发出 ≥2 条内容消息（中间块 + final）', `实际条数：${contents.length}`);
      const blocks = contents.slice(0, -1);
      const final = contents[contents.length - 1];
      assertTrue(
        blocks.every((b) => !b.content.includes('Usage:')),
        '中间块不应含 usage footer（footer 只属于 final）',
        blocks.map((b) => b.content.slice(-60)).join(' | '),
      );
      assertTrue(
        final.content.includes('Usage:'),
        'final 应含 usage footer（用于区分块与 final）',
        `final 尾部：${final.content.slice(-80)}`,
      );
      const joined = blocks.map((b) => b.content).join('');
      assertTrue(
        normalizeText(joined) === normalizeText(BODY),
        '中间块拼接应等于正文（说明块承载正文且不重复）',
        `块拼接：${joined}\n期望正文：${BODY}`,
      );
      const dup = blocks.filter((b) => normalizeText(b.content).includes(normalizeText(BODY)));
      assertEq(dup.length, 0, '中间块不应包含完整正文（否则就是重复投递）');
    },
  },
  {
    name: 'stream',
    title: 'stream：走 QQ 原生流式端点',
    driver: 'inbound',
    config: { ...MODE_CONFIG.stream, blockStreamingDefault: 'on' },
    llm: { mode: 'text', text: BODY, chunkSize: 12, delayMs: 250, includeFooter: true },
    qq: {},
    expect(parsed, ctx) {
      assertTrue(
        parsed.streams.length > 0,
        'stream 态应调用原生流式端点 /v2/users/{openid}/stream_messages',
        `实际记录：${JSON.stringify(parsed.contents.map((c) => c.path))}`,
      );
    },
  },
  {
    name: 'quota',
    title: 'quota：平台被动配额耗尽 → 不出现「一条都没发」',
    driver: 'inbound',
    config: { ...MODE_CONFIG.partial, blockStreamingDefault: 'on' },
    llm: { mode: 'text', text: BODY, chunkSize: 12, delayMs: 200, includeFooter: true },
    qq: { quotaAfter: 0 },
    expect(parsed, ctx) {
      const attempts = [...parsed.contents, ...parsed.typings, ...parsed.streams];
      assertTrue(attempts.length > 0, '配额耗尽时也不能「一条都没发」（应留下投递尝试记录）');
      const proactive = attempts.filter(isProactive);
      log(`    投递尝试 ${attempts.length} 次，其中主动发送 ${proactive.length} 次`);
      assertTrue(
        proactive.length > 0,
        '配额耗尽后应降级为主动发送（请求体不带 msg_id），而不是被动死磕',
        attempts.map((a) => `msg_id=${a.body.msg_id ?? '(无)'}`).join(', '),
      );
    },
  },
  {
    name: 'double-send',
    title: 'double-send：三态各跑一次，正文不出现两次',
    driver: 'inbound',
    phases: [
      { label: 'off', config: { ...MODE_CONFIG.off, blockStreamingDefault: 'on' } },
      { label: 'partial', config: { ...MODE_CONFIG.partial, blockStreamingDefault: 'on' } },
      { label: 'stream', config: { ...MODE_CONFIG.stream, blockStreamingDefault: 'on' } },
    ],
    llm: { mode: 'text', text: BODY, chunkSize: 12, delayMs: 200, includeFooter: true },
    qq: {},
    expect(parsed, ctx) {
      const items = [...parsed.contents, ...parsed.streams];
      const body = normalizeText(BODY);
      const dup = items.filter((i) => {
        const c = normalizeText(i.content);
        const first = c.indexOf(body);
        return first !== -1 && c.indexOf(body, first + 1) !== -1;
      });
      assertEq(dup.length, 0, '同一轮正文不应出现两次');
      const full = items.filter((i) => normalizeText(i.content).includes(body));
      assertTrue(full.length >= 1, '应至少有一条消息承载完整正文');
    },
  },
];

// ─────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────

function checkPluginInstalled() {
  const ext = path.join(DEV_DIR, 'extensions', 'openclaw-qqbot');
  if (!fs.existsSync(ext)) {
    console.error(`\n插件未安装到 ${ext}\n请先执行：\n  ${OPENCLAW_BIN} --dev plugins install ${REPO_ROOT}\n（不要用 --link：软链会被框架的「插件源码捕获」机制拒绝）\n`);
    return false;
  }
  return true;
}

function checkRealCredentials() {
  const need = ['LLM_BASE_URL', 'LLM_API_KEY', 'QQBOT_APP_ID', 'QQBOT_CLIENT_SECRET', 'QQBOT_TARGET_OPENID'];
  const missing = need.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`\n--real 模式缺少环境变量：${missing.join(', ')}\n（凭据只从环境变量读，不会写入任何文件）\n`);
    return false;
  }
  return true;
}

/** 写配置 + 控制文件（复用 setup.mjs / setup-real.mjs） */
function applyScenarioConfig(scenario, phase) {
  const cfg = phase?.config ?? scenario.config;
  const llm = phase?.llm ?? scenario.llm;
  const qq = phase?.qq ?? scenario.qq;
  if (opts.real) {
    setupReal.writeRealDevConfig({
      mode: cfg.mode,
      sendMode: cfg.sendMode,
      blockStreamingDefault: cfg.blockStreamingDefault === 'on',
    });
  } else {
    setup.writeDevConfig({
      mode: cfg.mode,
      sendMode: cfg.sendMode,
      blockStreamingDefault: cfg.blockStreamingDefault === 'on',
    });
  }
  setup.writeLlmControl(llm);
  setup.writeQqControl(qq);
  // 关掉 c2c 入站防抖（见 patchDevConfig 注释：否则 dispatch 落在请求作用域外 → GatewayDrainingError）
  // dmPolicy=open：让插件运行时直接放行（全小写 sender 不在 allowFrom 里也能过）
  patchDevConfig({
    channels: {
      qqbot: {
        dmPolicy: 'open',
        inboundDebounce: { debounceMs: 0 },
      },
    },
  });
}

const opts = parseArgs(process.argv.slice(2));

async function main() {
  if (opts.unknown) process.exit(2);
  if (opts.help) usage(0);
  if (opts.list) {
    for (const s of SCENARIOS) console.log(`${s.name.padEnd(12)} ${s.title}`);
    process.exit(0);
  }

  const selected = opts.scenario === 'all'
    ? SCENARIOS
    : SCENARIOS.filter((s) => s.name === opts.scenario);
  if (selected.length === 0) {
    console.error(`未知场景：${opts.scenario}`);
    console.error(`可用场景：${SCENARIOS.map((s) => s.name).join(', ')}`);
    process.exit(2);
  }

  step('环境检查');
  console.log(`  openclaw CLI   : ${OPENCLAW_BIN}`);
  console.log(`  dev profile    : ${DEV_DIR}`);
  console.log(`  配置文件       : ${CONFIG_PATH}`);
  console.log(`  模式           : ${opts.real ? '真实凭据（--real）' : '离线版（假 LLM + 假 QQ）'}`);
  console.log(`  场景           : ${selected.map((s) => s.name).join(', ')}`);

  if (!checkPluginInstalled()) process.exit(2);
  if (opts.real && !checkRealCredentials()) process.exit(2);

  killPreviousRun();
  await stopForeignGateway();

  // 幂等：先清记录
  setup.clearQqRecords();

  // mock 进程（离线版才需要；真实版打真平台）
  let mockLlm = null;
  let mockQq = null;
  if (!opts.real) {
    step('启动 mock（假 LLM + 假 QQ 平台）');
    await killPortOwner(LLM_PORT);
    await killPortOwner(QQ_PORT);
    mockLlm = spawnGroup('mock-llm', process.execPath, [path.join(__dirname, 'mock-llm.mjs'), '--port', String(LLM_PORT)], { quiet: true });
    mockQq = spawnGroup('mock-qq', process.execPath, [path.join(__dirname, 'mock-qq.mjs'), '--port', String(QQ_PORT)], { quiet: true });
    await sleep(1500);
    if (mockLlm.child.exitCode !== null || mockQq.child.exitCode !== null) {
      console.error(`\nmock 启动失败（端口可能被占用）：mock-llm=${mockLlm.child.exitCode} mock-qq=${mockQq.child.exitCode}\n`);
      process.exit(2);
    }
    log(`mock-llm  :${LLM_PORT} / mock-qq :${QQ_PORT}`);
  } else {
    step('真实模式：不启动 mock（直接打真实 QQ 平台）');
  }

  const results = [];
  const openid = opts.real ? process.env.QQBOT_TARGET_OPENID : targetOpenid();
  const secret = opts.real ? process.env.QQBOT_CLIENT_SECRET : MOCK_CLIENT_SECRET;

  for (const scenario of selected) {
    step(`场景 ${scenario.name}：${scenario.title}`);
    const phases = scenario.phases ?? [{ label: scenario.name }];
    for (const phase of phases) {
      if (phases.length > 1) log(`  子阶段：${phase.label}`);
      applyScenarioConfig(scenario, phase);
      log(`  配置：${JSON.stringify(phase.config ?? scenario.config)}`);
      log(`  假 LLM：${JSON.stringify(phase.llm ?? scenario.llm)}`);
      log(`  假 QQ ：${JSON.stringify(phase.qq ?? scenario.qq)}`);

      setup.clearQqRecords();

      let gw = null;
      try {
        gw = await startGateway();
        const driver = opts.real ? 'cli' : scenario.driver;
        const parsed = await runTurn({
          driver,
          openid,
          secret,
          timeoutSec: opts.timeout,
        });
        const counts = `内容 ${parsed.contents.length} / typing ${parsed.typings.length} / 流式帧 ${parsed.streams.length}`;
        log(`  出站记录：${counts}`);
        scenario.expect(parsed, { scenario, phase, openid });
        results.push({ scenario: scenario.name, phase: phase.label, ok: true });
        log(`  ✅ PASS ${scenario.name}${phases.length > 1 ? `/${phase.label}` : ''}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ scenario: scenario.name, phase: phase.label, ok: false, error: msg });
        warn(`❌ FAIL ${scenario.name}${phases.length > 1 ? `/${phase.label}` : ''}：${msg}`);
        if (gw) {
          log('  ── gateway 日志尾部（定位用） ──');
          console.log(gw.logTail(40).split('\n').map((l) => `    ${l}`).join('\n'));
        }
      } finally {
        if (!opts.keep) await stopGateway(gw);
        else log('  （--keep：保留 gateway 进程）');
      }
    }
  }

  step('汇总');
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.scenario}${r.phase && r.phase !== r.scenario ? `/${r.phase}` : ''}`);
  }
  console.log(`\n  合计：${passed} PASS / ${failed.length} FAIL（共 ${results.length} 项）`);
  if (failed.length) {
    console.log('\n  失败详情：');
    for (const f of failed) console.log(`  - ${f.scenario}: ${f.error.split('\n').join('\n    ')}`);
  }
  return failed.length ? 1 : 0;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error(`\n运行失败：${err instanceof Error ? err.stack || err.message : String(err)}`);
  exitCode = 1;
} finally {
  if (!opts.keep) killAll();
  else {
    log('--keep：保留进程，pid 记录在 ' + PID_FILE);
    savePids();
  }
}
process.exit(exitCode);
