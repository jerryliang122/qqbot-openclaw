/**
 * qqbot_secret_input 工具 — 聊天内密钥输入卡片
 *
 * 用户想交给 AI 一个新密钥/凭据时，host AI 调用本工具（而非让用户把
 * 密钥粘贴进对话）。工具给当前 c2c 用户发一张输入卡片并登记 pending，
 * 用户下一条消息由 secretCapture 中间件拦截，插件就地执行
 * `openclaw secrets store set <NAME> --kind env --value ...` 并直接回执。
 *
 * kind 恒为 env（代理可读环境变量）：聊天卡片收来的值本就落在 QQ 聊天
 * 记录里，且 AI 随后要读取使用；secret kind 是「受保护的机密」
 * （write-only，代理不可读），存进去 AI 反而用不了（2026-08-30 用户反馈）。
 *
 * 非阻塞：工具发卡后立即返回，AI 应结束本轮；执行与回执完全由插件自治。
 */
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { tryGetBotForAccount } from '../bot-instance.js';
import { isValidSecretName } from '../features/secret-store-cli.js';
import {
  DEFAULT_SECRET_INPUT_TTL_MS,
  cancelPendingSecretInput,
  registerPendingSecretInput,
} from '../features/secret-input-store.js';
import { getRequestAccountId, getRequestTarget } from '../request-context.js';
import { parseTarget } from '../outbound/target.js';
import { createPluginLogger } from '../utils/plugin-logger.js';
import type { InlineKeyboard, KeyboardButton } from '../types.js';

// 工具 execute 无 logger 参数可传；request-context 在工具执行期间处于活跃，
// 模块级 logger 的 enrichMeta 会自动带上 accountId/openId/messageId
const toolLog = createPluginLogger({ prefix: '[tool:secret-input]' });

// ========== JSON Schema ==========

const SecretInputSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description:
        '环境变量名。命名规则：以大写字母开头，仅含大写字母/数字/下划线，' +
        '最长 128 字符。推荐语义化命名，如 GITHUB_TOKEN、OPENWEATHER_API_KEY、' +
        'DEEPSEEK_API_KEY。值将以代理可读环境变量（kind=env）保存，AI 之后可直接读取使用。',
    },
    description: {
      type: 'string',
      description: '该密钥的用途说明（可选），会展示在输入卡片上，帮助用户确认。',
    },
  },
  required: ['name'],
} as const;

// ========== 卡片构建 ==========

function buildSecretInputCard(
  name: string,
  description: string | undefined,
  ttlMinutes: number,
): string {
  const lines = [`**🔒 密钥输入 · ${name}**`];
  if (description) lines.push('', `用途：${description}`);
  lines.push(
    '',
    `请在下方输入框直接粘贴并发送 **${name}** 的值：`,
    '',
    '- 将保存为**代理可读环境变量**（AI 之后可直接读取使用），' +
      `写入方式：\`openclaw secrets store set ${name} --kind env\``,
    '- 你发送的消息会被插件直接拦截执行，**不会进入 AI 对话**',
    '- 密钥会留存在你的聊天记录中，请留意所在环境安全',
    `- ${ttlMinutes} 分钟内有效；发送「取消」可退出`,
  );
  return lines.join('\n');
}

/** 「取消」指令按钮：action.type=2 + enter=true，客户端点击后以真实用户消息发出「取消」 */
function buildSecretInputKeyboard(): InlineKeyboard {
  const buttons: KeyboardButton[] = [
    {
      id: 'secret_input_cancel',
      render_data: {
        label: '❌ 取消',
        visited_label: '已取消',
        style: 1 as const,
      },
      action: {
        type: 2 as const,
        data: '取消',
        enter: true,
        permission: { type: 2 as const },
        unsupport_tips: '当前客户端不支持，请手动发送 取消',
      },
    },
  ];
  return { content: { rows: [{ buttons }] } };
}

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// ========== 注册入口 ==========

export function registerSecretInputTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: 'qqbot_secret_input',
      label: 'QQBot Secret Input Card',
      description:
        '当用户要交付一个新密钥/凭据（API Key、Token 等）给系统保存时调用：' +
        '向用户私聊发送一张密钥输入卡片，用户把密钥粘贴在输入框发送后，' +
        '插件会自动拦截该消息并执行 openclaw secrets store set 完成保存，' +
        '结果由插件直接回复用户。密钥内容不会进入对话。' +
        '必须由用户提供 name 参数（环境变量名）。',
      parameters: SecretInputSchema,
      async execute(_toolCallId, params) {
        const p = params as { name?: string; description?: string };
        const name = (p.name ?? '').trim();
        if (!name) return json({ error: 'name 为必填参数（环境变量名）' });
        if (!isValidSecretName(name)) {
          return json({
            error:
              '环境变量名不合法：必须以大写字母开头，仅含大写字母/数字/下划线，最长 128 字符' +
              `（收到 "${name}"）。示例：OPENWEATHER_API_KEY。请修正后重试。`,
          });
        }
        // 恒为 env：见文件头注释（卡片值 = 代理可读环境，secret 是 write-only 代理不可读）
        const kind = 'env' as const;

        const target = getRequestTarget();
        const accountId = getRequestAccountId() ?? 'default';
        if (!target) {
          return json({ error: '无法获取当前会话目标，此工具仅支持在 QQ Bot 消息会话中使用' });
        }
        const parsed = parseTarget(target);
        if (parsed.scope !== 'c2c' || !parsed.targetId) {
          return json({
            error:
              `密钥输入卡片仅支持私聊（c2c）会话，当前目标 ${target} 不适用` +
              '——密钥不应出现在群聊中。请引导用户在私聊中发起。',
          });
        }

        const bot = tryGetBotForAccount(accountId);
        if (!bot) {
          return json({ error: `账户 ${accountId} 的 gateway 尚未启动，无法发送密钥输入卡片` });
        }

        const description = p.description?.trim() || undefined;
        // 先登记后发卡（避免「先发后登」竞态，同 multi-question 约定）
        registerPendingSecretInput({
          accountId,
          senderOpenid: parsed.targetId,
          name,
          kind,
          description,
          createdAt: Date.now(),
        });
        try {
          await bot.sendTextWithKeyboard(
            { scope: 'c2c', targetId: parsed.targetId },
            buildSecretInputCard(name, description, DEFAULT_SECRET_INPUT_TTL_MS / 60_000),
            buildSecretInputKeyboard() as never,
          );
        } catch (err) {
          cancelPendingSecretInput(accountId, parsed.targetId);
          toolLog.error(`card send failed: ${err instanceof Error ? err.message : String(err)}`, { name, accountId });
          return json({
            error: `密钥输入卡片发送失败：${err instanceof Error ? err.message : String(err)}`,
          });
        }

        toolLog.info(`card sent, pending registered name=${name} ttlMinutes=${DEFAULT_SECRET_INPUT_TTL_MS / 60_000}`);

        return json({
          ok: true,
          name,
          kind,
          command: `openclaw secrets store set ${name} --kind env --value <用户输入>`,
          instruction:
            '卡片已发送给用户。用户下一条私聊消息将被插件自动拦截（不会进入对话），' +
            `执行上述命令保存密钥，成功/失败由插件直接回复用户。` +
            '请直接结束本轮（可告知用户按卡片提示发送密钥），不要等待用户输入，' +
            '也不要让用户把密钥内容发到对话里。',
        });
      },
    },
    { name: 'qqbot_secret_input' },
  );
}
