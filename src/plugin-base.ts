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
      // 撤回：**平台支持但本插件未实现**。
      //
      // QQ 开放平台有 `DELETE /v2/users/{openid}/messages/{msg_id}`
      // （限 2 分钟内、仅限机器人自己发的消息），SDK 也已封装
      // `bot.recallMessage()`。但本插件**没有实现** message 工具的
      // `unsend` 动作处理器（全仓无该 action 的执行路径），因此此处
      // 如实声明为 false——框架据此不会把 `unsend` 动作开放给模型。
      //
      // 语义澄清：该字段表达的是「本插件已实现该动作」，而非「平台是否
      // 支持」。若将来接上 `recallMessage` + message action 处理器，
      // 应连同实现一起改为 true。
      //
      // `edit` 则是**平台真的不支持**（QQ 无编辑消息接口，只有撤回），
      // 两者原因不同，勿混为一谈。
      unsend: false,
      edit: false,
      // 引用回复：支持。
      //
      // 实际表现分两条路径：被动回复用 `msg_id` 锚定（客户端显示为
      // 「回复」）；SDK 在**非 markdown 模式**（`msg_type=0` 纯文本）下
      // 额外下发 `message_reference` 字段，客户端渲染为带引用原文的
      // 引用块。markdown 模式（`msg_type=2`，插件默认）下不下发该字段，
      // 只有锚定回复。框架的 `reply` 语义是「能回复」，故为 true。
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
    /**
     * 框架块流式（partial 态）的 coalesce 默认值。
     *
     * 框架默认 `minChars=800 / idleMs=1000`（openclaw dist
     * `block-streaming-*.mjs` 的 DEFAULT_BLOCK_STREAM_MIN / COALESCE_IDLE_MS）
     * 会把中间消息 buffer 住，造成肉眼可见的延迟——这正是 PR#1 当年
     * 「显式关掉 SDK block streaming、自研分段」的原因。
     *
     * 10.5 开放了插件级覆盖点（`ChannelPlugin.streaming.blockStreamingCoalesceDefaults`，
     * 被 `resolveBlockStreamingCoalescing` 读取），声明 `{ minChars: 1, idleMs: 0 }`
     * 即可让块即时 flush，**用户零配置**。用户仍可用
     * `channels.qqbot.streaming.block.coalesce` 覆盖（优先级高于本默认值）。
     */
    streaming: {
      blockStreamingCoalesceDefaults: { minChars: 1, idleMs: 0 },
    },
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
