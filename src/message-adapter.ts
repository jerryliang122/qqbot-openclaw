/**
 * QQBot Message 适配器
 *
 * 定义消息生命周期能力
 */

import { qqbotChannelOutbound } from './outbound-adapter.js';

/**
 * QQBot Message Adapter
 *
 * 能力声明（口径说明见各项注释）：
 * - draftPreview: false        —— QQ 无「草稿占位 + 原地改写」两阶段结构
 * - previewFinalization: false —— QQ 无预览稿转正文的 finalize 语义
 * - progressUpdates: true      —— 进度卡片逐条下发
 * - nativeStreaming: true      —— QQ 私聊原生 stream_messages（**仅 C2C**）
 * - quietFinalization: false   —— 无「静默收尾」诉求
 *
 * ⚠️ `nativeStreaming` 是**通道级**声明，而 QQ 流式**只对 C2C 开放**
 * （SDK `openStream` 对非 c2c 目标直接 throw）。群聊实际走进度卡片
 * （`src/outbound/progress-card-publisher.ts`）。声明本身不区分 scope，
 * 真正的 scope 判断由插件内 `StreamingController` 把关——框架消费该标记时
 * 若不按 scope 区分，本声明仅作提示性元数据，不改变实际行为。
 */
export const qqbotMessageAdapter = {
  id: 'qqbot',
  live: {
    capabilities: {
      /**
       * 保持 false（**不是漏声明**）：该能力在框架语义下是「先发一条可编辑的
       * 草稿消息占位」（Telegram 的 edit-preview 模型）。QQ 私聊原生流式是
       * `openStream → update(前缀增长) → complete` 的**单消息流式**，且平台
       * 约束「已下发文本的前缀不可变更」，没有「草稿占位 + 原地改写为终稿」的
       * 两阶段结构，故不适用。
       */
      draftPreview: false,
      /** QQ 无「预览稿转正文」的 finalize 语义。 */
      previewFinalization: false,
      /** 进度卡片：逐条下发，不原地刷新。 */
      progressUpdates: true,
      /** QQ 私聊原生流式（`stream_messages`），仅 C2C 有效。 */
      nativeStreaming: true,
      /** 无静默收尾诉求。 */
      quietFinalization: false,
    },
    finalizer: {
      capabilities: {
        finalEdit: false,
        normalFallback: true,
        previewReceipt: false,
        retainOnAmbiguousFailure: true,
      },
    },
  },
  receive: {
    defaultAckPolicy: 'after_agent_dispatch' as const,
    supportedAckPolicies: ['after_receive_record', 'after_agent_dispatch'] as const,
  },
  outbound: qqbotChannelOutbound,
};
