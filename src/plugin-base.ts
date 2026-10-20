/**
 * QQBot 插件基础配置
 *
 * 参考 Telegram 插件的 createTelegramPluginBase
 */

import { qqbotSetupWizard } from './setup/surface.js';

export interface QQBotPluginBaseParams {
  setupWizard?: typeof qqbotSetupWizard;
}

export function createQQBotPluginBase(params: QQBotPluginBaseParams = {}) {
  const { setupWizard = qqbotSetupWizard } = params;

  return {
    id: 'qqbot' as const,
    meta: {
      id: 'qqbot',
      label: 'QQ Bot',
      selectionLabel: 'QQ Bot',
      docsPath: '/docs/channels/qqbot',
      blurb: 'Connect to QQ via official QQ Bot API',
      order: 50,
    },
    capabilities: {
      chatTypes: ['direct', 'group'] as Array<'direct' | 'group'>,
      media: true,
      // QQ Bot 官方 API 无消息回应（reaction）接口
      reactions: false,
      // QQ Bot 无 thread/topic 概念
      threads: false,
      // 平台无投票
      polls: false,
      // 平台不支持撤回/编辑 bot 自身消息（message adapter 亦声明 finalEdit: false）
      unsend: false,
      edit: false,
      // 支持引用回复（被动回复 msg_id 锚点 + quote 渲染）
      reply: true,
      // 平台无消息特效
      effects: false,
      // 平台未开放群管理接口
      groupManagement: false,
      // 声明 TTS 语音投递能力：QQ 走 SILK 语音气泡（voice-note），
      // 不声明时框架会把 TTS 当普通音频文件（audio-file）投递。
      // captionedFinalText: false —— QQ 语音消息不带文字说明，
      // 故框架不应把终稿正文 defer 成语音附注文本。
      tts: {
        voice: {
          synthesisTarget: 'voice-note' as const,
          transcodesAudio: true,
          captionedFinalText: false,
        },
      },
      // 注意：刻意不声明 nativeCommands —— QQ「指令面板」是「点面板把指令文本填进
      // 输入框」的引导型 UI，不是框架意义上的 provider-native slash command；
      // 声明它会与 `commands.text=false` 的文本斜杠指令路由语义冲突
      // （见 src/features/command-panel.ts 顶部说明）。
    },
    setupWizard: setupWizard as any,
    reload: {
      configPrefixes: ['channels.qqbot'],
    },
    defaults: {
      queue: {
        debounceMs: 1000,
      },
    },
  };
}
