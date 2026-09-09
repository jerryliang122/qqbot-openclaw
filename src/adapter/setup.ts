/**
 * Setup 工具 re-export（plugin-sdk/setup + plugin-sdk/setup-tools）
 *
 * 构建基线 openclaw 2026.9.2，两个 subpath 均为正式导出，直接转发。
 */
export type { ChannelSetupWizard } from 'openclaw/plugin-sdk/setup';

export {
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
} from 'openclaw/plugin-sdk/setup';

export { formatDocsLink } from 'openclaw/plugin-sdk/setup-tools';
