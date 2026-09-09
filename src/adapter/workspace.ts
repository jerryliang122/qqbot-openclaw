/**
 * Agent workspace 目录解析（plugin-sdk/health）
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// CJS 兼容：__filename 在 CJS 中可用，ESM 中使用 import.meta.url
const __file = typeof __filename !== 'undefined'
  ? __filename
  : fileURLToPath(import.meta.url);
const req = createRequire(__file);

let health: {
  resolveAgentWorkspaceDir: (cfg: any, agentId: string) => string;
  resolveDefaultAgentId: (cfg: any) => string;
} | undefined;

export function resolveAgentWorkspace(cfg: any, agentId?: string): string {
  const h = (health ??= req('openclaw/plugin-sdk/health') as NonNullable<typeof health>);
  return h.resolveAgentWorkspaceDir(cfg, agentId ?? h.resolveDefaultAgentId(cfg));
}
