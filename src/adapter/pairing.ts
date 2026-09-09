/**
 * Pairing Runtime — openclaw/plugin-sdk/conversation-runtime
 *
 * readAllowFromStore / issueChallenge / buildReply 直接来自稳定 subpath。
 *
 * approveCode 例外：`approveChannelPairingCode` 在 2026.9.2 未从任何
 * plugin-sdk subpath 导出（只存在于内部 pairing-store chunk 与
 * `openclaw pairing approve` CLI），走与网关同源的 CLI 执行
 * （见 secret-store-cli 的 resolveOpenClawCli 同源约束）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { resolveOpenClawCli } from '../features/secret-store-cli.js';

export interface PairingApi {
  readAllowFromStore: (params: { channel: string; accountId: string }) => Promise<string[]>;
  issueChallenge: (params: { channel: string; id: string; accountId: string }) => Promise<{ code: string }>;
  buildReply: (params: { code: string; channel: string }) => string;
  /** 经 `openclaw pairing approve` 执行；返回是否成功 */
  approveCode: (params: { channel: string; code: string; accountId?: string }) => Promise<{ approved: boolean }>;
}

let _req: NodeRequire | undefined;

function getReq(): NodeRequire {
  _req ??= createRequire(
    typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'noop.js'),
  );
  return _req;
}

let _mod: {
  readChannelAllowFromStore: (channel: string, env?: unknown, accountId?: string) => Promise<string[]>;
  upsertChannelPairingRequest: (params: { channel: string; id: string; accountId?: string }) => Promise<{ code: string }>;
  buildPairingReply: (params: { channel: string; idLine?: string; code: string }) => string;
} | undefined;

function loadMod(): NonNullable<typeof _mod> {
  _mod ??= getReq()('openclaw/plugin-sdk/conversation-runtime');
  return _mod!;
}

/** 获取 Pairing API（conversation-runtime 为稳定导出，加载失败即抛错） */
export function getPairingApi(): PairingApi {
  const mod = loadMod();
  return {
    readAllowFromStore: (params) =>
      mod.readChannelAllowFromStore(params.channel, undefined, params.accountId),
    issueChallenge: (params) =>
      mod.upsertChannelPairingRequest({
        channel: params.channel,
        id: params.id,
        accountId: params.accountId,
      }).then((r) => ({ code: r.code })),
    buildReply: (params) =>
      mod.buildPairingReply({
        channel: params.channel,
        idLine: '', // qqbot 无额外 ID 信息，留空即可
        code: params.code,
      }),
    approveCode: (params) => approveViaCli(params),
  };
}

const APPROVE_TIMEOUT_MS = 30_000;

async function approveViaCli(params: {
  channel: string;
  code: string;
  accountId?: string;
}): Promise<{ approved: boolean }> {
  const cli = resolveOpenClawCli();
  const args = [
    ...cli.args,
    'pairing',
    'approve',
    '--channel',
    params.channel,
    ...(params.accountId ? ['--account', params.accountId] : []),
    params.code,
  ];
  return new Promise((resolve) => {
    const child = spawn(cli.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), APPROVE_TIMEOUT_MS);
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ approved: false });
    });
    child.on('close', (codeNum) => {
      clearTimeout(timer);
      resolve({ approved: codeNum === 0 });
    });
  });
}
