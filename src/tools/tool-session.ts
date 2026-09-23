/**
 * 工具执行时的会话路由解析（双层回退）
 *
 * 背景（2026-09-23 事故）：qqbot_secret_input 等工具此前仅靠
 * request-context（AsyncLocalStorage）获取当前会话目标。ALS 只在
 * handleMessage → dispatchToOpenClaw 的异步子树内有效；openclaw 框架
 * 经常把 agent turn 延迟到该子树之外执行——活动 turn 之后排队的
 * followup/collect 批处理、框架自有定时器驱动的队列 drain 等。此时
 * 工具执行处 ALS 为空，工具报「无法获取当前会话目标」直接失败。
 *
 * 修复：优先 ALS（逐消息精确，含 messageId/openId 供日志富化）；
 * ALS 缺失时回退到框架在工具工厂上下文里提供的 deliveryContext
 * （openclaw 按当前 run 的 sessionCtx 派生的可信投递路由：
 * { channel, to, accountId }，qqbot 通道的 to 即规范目标地址
 * qqbot:c2c:{openid} / qqbot:group:{group_openid}）。
 *
 * 工厂注册形式：api.registerTool((ctx) => ({ ...tool }), { name })。
 * 框架在装配工具面（或缓存描述符路径下的每次执行）时调用工厂，
 * ctx 携带当次 run 的 deliveryContext——描述符缓存键包含
 * deliveryContext，不会跨会话复用旧路由。
 */

import { getRequestAccountId, getRequestTarget } from '../request-context.js';

/** 框架 deliveryContext 中本项目用到的字段（见 openclaw OpenClawPluginToolContext） */
export interface ToolDeliveryContext {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string;
}

/** 解析出的会话路由 */
export interface ToolSessionRoute {
  /** 规范目标地址：qqbot:c2c:{openid} / qqbot:group:{group_openid} */
  target: string;
  /** 账户 ID（多账户场景；可能为空，由调用方决定回退策略） */
  accountId?: string;
  /** 路由来源：request-context（ALS）优先，delivery-context（框架 run 级）回退 */
  source: 'request-context' | 'delivery-context';
}

/**
 * 解析当前工具调用所属的会话路由。
 *
 * 返回 undefined 表示当前 run 没有可识别的 QQ 会话来源
 * （如 cron/定时任务、内部 UI 发起的 run）——调用方应返回明确错误。
 */
export function resolveToolSessionRoute(
  delivery?: ToolDeliveryContext | null,
): ToolSessionRoute | undefined {
  // 第一层：请求级 ALS（入站消息处理链路内，逐消息精确）
  const alsTarget = getRequestTarget();
  if (alsTarget) {
    return {
      target: alsTarget,
      accountId: getRequestAccountId(),
      source: 'request-context',
    };
  }

  // 第二层：框架 run 级 deliveryContext（延迟/排队 turn 的回退）
  const to = typeof delivery?.to === 'string' ? delivery.to.trim() : '';
  if (!to) return undefined;
  const channel = typeof delivery?.channel === 'string' ? delivery.channel.trim() : '';
  // 防御：deliveryContext 属于其他通道（理论上不会发生）时不误认
  if (channel && channel !== 'qqbot') return undefined;
  if (!/^qqbot:(c2c|group|channel):/i.test(to)) return undefined;
  return {
    target: to,
    accountId: delivery?.accountId,
    source: 'delivery-context',
  };
}
