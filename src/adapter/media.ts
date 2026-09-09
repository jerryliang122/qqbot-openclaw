/**
 * 远程媒体下载（plugin-sdk/media-runtime）
 *
 * 直接走 openclaw 的 saveRemoteMedia（含 SSRF 防护/重试/大小限制）。
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';

let _req: NodeRequire | undefined;

/**
 * 惰性 require 工厂。
 * CJS（tsup 产物）下用 __filename 锚定，与插件 node_modules 的解析路径一致；
 * ESM（tsx 直跑测试）下 __filename 不存在，锚定 process.cwd()。
 */
function getReq(): NodeRequire {
  _req ??= createRequire(
    typeof __filename !== 'undefined' ? __filename : path.join(process.cwd(), 'noop.js'),
  );
  return _req;
}

type SaveRemoteMedia = (opts: {
  url: string;
  subdir?: string;
  originalFilename?: string;
  maxBytes?: number;
  timeoutMs?: number;
}) => Promise<{ path: string }>;

export function downloadRemoteMedia(opts: {
  url: string;
  subdir?: string;
  originalFilename?: string;
  maxBytes?: number;
  timeoutMs?: number;
}): Promise<{ path: string }> {
  const mod = getReq()('openclaw/plugin-sdk/media-runtime') as { saveRemoteMedia: SaveRemoteMedia };
  return mod.saveRemoteMedia(opts);
}
