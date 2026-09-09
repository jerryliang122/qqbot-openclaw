<div align="center">

**简体中文 | [English](README.md)**

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot — OpenClaw 渠道插件


**让你的 AI 助手接入 QQ — 私聊、群聊、富媒体，一个插件全搞定。**

> 本仓库为**独立维护的 fork**，自 v1.0.0 起独立发版（与上游 2.x 版本线完全脱钩）。
> 运行要求：OpenClaw `>= 2026.9.2`；npm 包名 [`@jerryliang122/openclaw-qqbot`](https://www.npmjs.com/package/@jerryliang122/openclaw-qqbot)。
> 与旧版本的差异及升级指南见 [CHANGELOG](CHANGELOG.md)。上游仓库：[tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)。

### 🚀 当前版本： `v1.0.0`

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/OpenClaw-%3E%3D2026.9.2-orange)](https://github.com/jerryliang122/qqbot-openclaw)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

<br/>

扫描二维码加入群聊，一起交流

<img width="400" alt="QQ 群二维码" src="./docs/images/developer-group.png" />

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🔄 **群消息排队** | 群消息即时进入框架，排队/合并交给 OpenClaw 框架队列（collect 模式）——正在处理的任务绝不被打断，突发消息合并成一批 |
| 👁️ **房间事件（可选）** | 全量模式群里，bot 像普通群成员一样读到每条消息；未 @ 的消息作为被动房间事件（只读，AI 想发言走主动 `message` 工具） |
| 🔔 **三种唤醒方式** | @提及、称呼唤醒（`mentionPatterns`，如「沈处」）、引用 bot 消息，均触发正常回复 |
| 📤 **被动优先出站** | 所有发送优先走被动回复（msg_id）以节省每天约 1000 条主动消息预算；配额感知降级，绝不硬失败 |
| 🔒 **多场景支持** | C2C 私聊、群聊（@提及 / 自主发言 / 房间事件模式） |
| 👥 **群聊精细管控** | 按群配置 @触发规则、工具权限、自定义提示词、历史模式、排队策略、房间事件策略 |
| 🌐 **双传输模式** | WebSocket（默认）或 Webhook（HTTP 回调）— 配置切换 |
| 🖼️ **富媒体消息** | 支持图片、语音、视频、文件的收发 |
| 🎙️ **语音能力 (STT/TTS)** | 语音转文字自动转录 & 文字转语音回复 |
| 🔄 **版本检查** | 私聊发送 `/bot-upgrade` 检查 npm 新版本并附升级指引 |
| ⏰ **定时推送** | 支持定时任务触发后主动推送消息 |
| 🔗 **URL 无限制** | 私聊可直接发送 URL |
| ⌨️ **输入状态** | 实时显示"Bot 正在输入中…"状态 |
| 📝 **Markdown** | 完整支持 Markdown 格式消息 |
| 🛠️ **原生命令** | 支持 OpenClaw 原生命令 |
| 💬 **引用上下文** | 解析用户回复的原始消息内容，注入 AI 上下文，让模型准确理解"在回复哪条消息" |
| 📦 **大文件支持** | 大文件自动分片并行上传，最大支持 100 MB |
| 🔐 **命令执行审批** | AI 执行命令前通过按钮消息请求审批，点击即可允许或拒绝 |

---

## 📸 功能展示

> **说明：** 本插件仅作为**消息通道**，负责在 QQ 和 OpenClaw 之间传递消息。图片理解、语音转录、AI 画图等能力取决于你配置的 **AI 模型**以及在 OpenClaw 中安装的 **skill**，而非插件本身提供。

### 💬 引用消息上下文

用户在 QQ 中引用某条消息发送时，插件会自动解析被引用的消息内容并注入 AI 上下文，让模型清楚地知道"用户在回复哪条消息"，从而给出更准确的回复。支持文本及媒体消息（图片/语音/视频/文件），换设备后同样可用。

<img width="360" src="docs/images/ref-msg.png" alt="引用消息上下文演示" />

### 🎙️ 语音消息（STT）

配置 STT 后，插件会自动将语音转录为文字再交给 AI 处理。整个过程对用户完全透明——发语音就像发文字一样自然，AI 听得懂你在说什么。

> **你**：*（发送一段语音）*"明天深圳天气怎么样"
>
> **QQBot**：明天（3月7日 周六）深圳的天气预报 🌤️ ...

<img width="360" src="docs/images/voice-stt.jpg" alt="听语音演示" />

### 📄 文件理解

用户发文件给 AI，AI 同样能接住。不管是一本小说还是一份报告，AI 会自动识别文件内容并给出智能回复。

> **你**：*（发送《战争与和平》TXT 文件）*
>
> **QQBot**：收到！你上传了列夫·托尔斯泰的《战争与和平》中文版文本。从内容来看，这是第一章的开头……你想让我做什么？

<img width="360" src="docs/images/file-understand.jpg" alt="AI理解用户发送的文件" />

### 🖼️ 图片理解

如果主模型支持视觉（如腾讯混元 `hunyuan-vision`），用户发图片 AI 也能看懂。这是多模态模型的通用能力，非插件专属功能。

> **你**：*（发送一张图片）*
>
> **QQBot**：哈哈，好可爱！这是QQ企鹅穿上小龙虾套装吗？🦞🐧 ...

<img width="360" src="docs/images/image-understand.jpg" alt="图片理解演示" />

### 🎨 图片发送

> **你**：画一只猫咪
>
> **QQBot**：画好啦！一只可爱的简笔小猫咪🐱🎨

AI 可直接发送图片，支持本地文件路径和网络 URL。格式：jpg/png/gif/webp/bmp。

<img width="360" src="docs/images/image-send.jpg" alt="发图片演示" />

### 🔊 语音发送

> **你**：给我讲一个笑话
>
> **QQBot**：*（发送一条语音消息）*

AI 可直接发送语音消息。格式：mp3/wav/silk/ogg，无需安装 ffmpeg。

<img width="360" src="docs/images/voice-send.jpg" alt="发语音演示" />

### ⏰ 定时提醒（主动消息）

> **你**：5分钟后提醒我吃饭
>
> **QQBot**：先确认已创建提醒，到点后再主动推送语音 + 文本提醒

该能力依赖 OpenClaw cron 调度与主动消息能力。若未收到提醒，常见原因是 QQ 侧拦截了机器人主动消息。

<img width="360" src="docs/images/reminder.jpg" alt="定时提醒演示" />

### 📎 文件发送

> **你**：战争与和平的第一章截取一下发文件给我
>
> **QQBot**：*（发送 .txt 文件）*

AI 可直接发送文件，任意格式均可。

<img width="360" src="docs/images/file-send.jpg" alt="发文件演示" />

v1.6.6 起支持大文件传输：图片最大 20MB，视频最大 30MB，附件最大 100MB，每日累计传输上限 2GB。

<img width="360" src="docs/images/large-file-transfer.jpg" alt="大文件传输演示" />

### 🔐 命令执行审批

当 AI 需要执行命令时，插件会通过 QQ 消息发送带按钮的审批请求，你可以点击 **✅ 允许一次**、**⭐ 始终允许** 或 **❌ 拒绝** 来控制命令是否执行。

通过 `/bot-approve` 指令可以管理审批模式（白名单 / 关闭 / 严格模式）。

<img width="360" src="docs/images/approve.png" alt="命令执行审批演示" />

### 🎬 视频发送

> **你**：发一个演示视频给我
>
> **QQBot**：*（发送视频）*

AI 可直接发送视频，支持本地文件和公网 URL。

<img width="360" src="docs/images/video-send.jpg" alt="发视频演示" />

> **底层细节：** 上传去重缓存、有序队列发送、音频格式多层降级。

### 🛠️ 斜杠指令

插件内置一组斜杠指令，在消息进入 AI 队列前拦截处理，即时响应，用于诊断和管理。

#### `/bot-ping` — 延迟测试

> **你**：`/bot-ping`
>
> **QQBot**：✅ pong！⏱ 延迟: 602ms（网络传输: 602ms，插件处理: 0ms）

测量从 QQ 服务器推送到插件响应的端到端延迟，细分网络传输和插件处理两段耗时。

<img width="360" src="docs/images/slash-ping.jpg" alt="Ping 演示" />

#### `/bot-version` — 版本信息

> **你**：`/bot-version`
>
> **QQBot**：🦞框架版本：OpenClaw 2026.9.2 / 🤖QQBot 插件版本：v1.0.0 / 🌟GitHub 仓库

一目了然查看框架版本、插件版本，并可直接跳转官方仓库。

<img width="360" src="docs/images/slash-version.jpg" alt="Version 演示" />

#### `/bot-help` — 指令列表

> **你**：`/bot-help`
>
> **QQBot**：列出所有可用的斜杠指令及说明，指令可点击快速输入。

<img width="360" src="docs/images/slash-help.jpg" alt="Help 演示" />

#### `/bot-upgrade` — 版本检查与升级指引

> **你**：`/bot-upgrade`
>
> **QQBot**：📌当前版本 v1.0.0 / 🆕发现新版本 / 📖升级指引链接

对比 npm registry（`@jerryliang122/openclaw-qqbot`）上的最新版本，并返回升级指引链接（默认指向仓库 CHANGELOG，可用 `channels.qqbot.upgradeUrl` 覆盖）。实际升级在主机上通过 `openclaw plugins install` 完成，见[快速开始](#-快速开始)。

<img width="360" src="docs/images/hot-update.jpg" alt="升级检查演示" />

#### `/bot-logs` — 日志导出

> **你**：`/bot-logs`
>
> **QQBot**：📋 日志已打包（约 2000 行），正在发送文件… *（发送 .txt 文件）*

导出最近约 2000 行网关日志为文件，方便快速排查问题。

<img width="360" src="docs/images/slash-logs.jpg" alt="Logs 演示" />

#### 用法查询

所有指令都支持 `?` 后缀查看用法说明：

> **你**：`/bot-upgrade ?`
>
> **QQBot**：📖 /bot-upgrade 用法：…

#### `/bot-approve` — 审批配置管理

> **你**：`/bot-approve`
>
> **QQBot**：🔐 命令执行审批配置 — 开启审批 / 关闭审批 / 严格模式 / 恢复默认 / 查看当前配置

管理 AI 命令执行审批策略，支持以下子命令：

| 子命令 | 说明 |
|--------|------|
| `/bot-approve on` | 开启审批（白名单模式，推荐） |
| `/bot-approve off` | 关闭审批，命令直接执行 |
| `/bot-approve always` | 严格模式，每次执行都需审批 |
| `/bot-approve reset` | 恢复框架默认值 |
| `/bot-approve status` | 查看当前审批配置 |

#### `/bot-clear-storage` — 清理通过 QQBot 对话产生的文件以及下载的资源（保存在 OpenClaw 运行环境的主机上）

`/bot-clear-storage` 列出对话产生的文件以及下载的资源目录里的文件，使用`/bot-clear-storage -- force`确定删除。

#### `/bot-group-always` — 群消息响应模式切换

> **你**：`/bot-group-always`
>
> **QQBot**：🤖 群自主发言状态：❌ 仅被 @ 时回复

运行时动态切换群聊默认 @触发行为，修改即时持久化，无需重启：

| 子命令 | 说明 |
|--------|------|
| `/bot-group-always on` | AI 自主判断何时发言（无需 @） |
| `/bot-group-always off` | 仅在被 @ 时回复 |
| `/bot-group-always`（无参数） | 查看当前设置 |

> ⚠️ 此指令修改账户级 `defaultRequireMention`，优先级低于具体群的 `groups.{groupId}.requireMention` 配置。

#### `/bot-group-info` — 群推送模式与生效配置查询（群内使用）

> **你**：`/bot-group-info`（在群里发送）
>
> **QQBot**：🤖 群信息 — 推送模式推断（AT 系 / 全量）、requireMention、排队策略、历史模式、房间事件策略、今日主动消息用量

回答「这个群为什么没上下文」这类排障问题：推送模式由**群主**拉 bot 进群时选择（仅 @ / @+最近N / 全量），此指令展示插件实际观测到的模式与所有生效配置值。

---

---

## 🚀 快速开始

### 第一步 — 在 QQ 开放平台创建机器人

1. 前往 [QQ 开放平台](https://q.qq.com/)，用**手机 QQ 扫描页面二维码**即可注册/登录。若尚未注册，扫码后系统会自动完成注册并绑定你的 QQ 账号。

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. 手机 QQ 扫码后选择**同意**，即完成注册，进入 QQ 机器人配置页。
3. 点击**创建机器人**，即可直接新建一个 QQ 机器人。

<img width="720" alt="创建机器人" src="docs/images/create-robot.png" />

> ⚠️ 机器人创建后会自动出现在你的 QQ 消息列表中，并发送第一条消息。但在完成下面的配置之前，发消息会提示"该机器人去火星了"，属于正常现象。

<img width="400" alt="机器人打招呼" src="docs/images/bot-say-hello.jpg" />

4. 在机器人页面中找到 **AppID** 和 **AppSecret**，分别点击右侧**复制**按钮，保存到记事本或备忘录中。**AppSecret 不支持明文保存，离开页面后再查看会强制重置，请务必妥善保存。**

<img width="720" alt="找到 AppID 和 AppSecret" src="docs/images/find-appid-secret.png" />

> 详细图文教程请参阅 [官方指南](https://cloud.tencent.com/developer/article/2626045)。

### 第二步 — 安装 / 升级插件

> 无 scope 的 npm 包名 `openclaw-qqbot` 属于上游原项目——本 fork 以 `@jerryliang122/openclaw-qqbot` 发布。要求 OpenClaw >= 2026.9.2。

**方式 A：从 npm 安装（推荐）**

```bash
openclaw plugins install @jerryliang122/openclaw-qqbot

# 或安装指定版本
openclaw plugins install @jerryliang122/openclaw-qqbot@1.0.0
```

**方式 B：从 GitHub 安装**

```bash
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git

# 或安装指定版本
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git#v1.0.0
```

**方式 C：源码安装**

```bash
git clone https://github.com/jerryliang122/qqbot-openclaw.git
cd openclaw-qqbot

# 构建
npm install
npm run build

# 安装到 OpenClaw（方式一：link）
openclaw plugins link .

# 或（方式二：pack）
npm pack
openclaw plugins install ./jerryliang122-openclaw-qqbot-1.0.0.tgz
```

**配置凭证**

```bash
# 扫码登录（推荐，无需手动填写凭证）
openclaw channels login --channel qqbot

# 或手动配置
openclaw channels add --channel qqbot --token "AppID:AppSecret"

# 启动 / 重启
openclaw gateway restart
```

> 环境变量 `QQBOT_APPID` / `QQBOT_SECRET` 同样支持。

**从旧版本（上游 2.x）升级？** 请阅读 [CHANGELOG](CHANGELOG.md)——其中列出了全部破坏性变更（已移除的配置项、环境变量与行为）及迁移对照表。

### 第三步 — 测试

打开 QQ，找到你的机器人，发条消息试试！

<div align="center">
<img width="500" alt="聊天演示" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## ⚙️ 进阶配置

### 多账户配置（Multi-Bot）

支持在同一个 OpenClaw 实例下同时运行多个 QQ 机器人。

#### 配置方式

编辑 `~/.openclaw/openclaw.json`，在 `channels.qqbot` 下增加 `accounts` 字段：

```json
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "appId": "111111111",
      "clientSecret": "secret-of-bot-1",

      "accounts": {
        "bot2": {
          "enabled": true,
          "appId": "222222222",
          "clientSecret": "secret-of-bot-2"
        },
        "bot3": {
          "enabled": true,
          "appId": "333333333",
          "clientSecret": "secret-of-bot-3"
        }
      }
    }
  }
}
```

**说明：**

- 顶层的 `appId` / `clientSecret` 是**默认账户**（accountId = `"default"`）
- `accounts` 下的每个 key（如 `bot2`、`bot3`）就是该账户的 `accountId`
- 每个账户都可以独立配置 `enabled`、`name`、`allowFrom`、`systemPrompt` 等字段
- 也可以不配顶层默认账户，只在 `accounts` 里配置所有机器人

通过 CLI 添加第二个机器人（如果框架支持 `--account` 参数）：

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### 向指定账户的用户发送消息

使用 `openclaw message send` 发消息时，需要通过 `--account` 参数指定使用哪个机器人发送：

```bash
# 使用默认机器人发送（不指定 --account 时自动使用 default）
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# 使用 bot2 发送
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target 格式支持：**

| 格式 | 说明 |
|------|------|
| `qqbot:c2c:OPENID` | 私聊 |
| `qqbot:group:GROUP_OPENID` | 群聊 |
| `qqbot:channel:CHANNEL_ID` | 频道 |

> ⚠️ **注意**：每个机器人的用户 OpenID 是不同的。机器人 A 收到的用户 OpenID 不能用机器人 B 去发消息，否则会返回 500 错误。必须用对应机器人的 accountId 去给该机器人的用户发消息。

#### 工作原理

- 启动 `openclaw gateway` 后，所有 `enabled: true` 的账户会同时启动连接（WebSocket 或 Webhook，取决于 `transport` 配置）
- 每个账户独立维护 Token 缓存（基于 `appId` 隔离），互不干扰
- 接收消息时，日志会带上 `[qqbot:accountId]` 前缀方便排查

---

### Webhook 传输模式

默认情况下，插件通过 **WebSocket** 连接 QQ 平台（出站连接，无需公网 IP）。你也可以切换为 **Webhook** 模式，由 QQ 平台主动 POST 事件到你的 HTTP 端点。

| | WebSocket（默认） | Webhook |
|---|---|---|
| 连接方式 | 插件主动连接 QQ 网关 | QQ 平台 POST 到你的服务器 |
| 公网 IP | 不需要 | 需要 |
| 适用场景 | 开发调试、单实例部署 | 生产环境、水平扩展、Serverless |
| 会话恢复 | 支持 RESUME | 无状态，无需恢复 |
| 签名验证 | 平台内置 | 插件自动 Ed25519 验签 |

#### 配置方式

```json
{
  "channels": {
    "qqbot": {
      "appId": "111111111",
      "clientSecret": "your-secret",
      "transport": "webhook",
      "webhook": {
        "path": "/qqbot/webhook"
      }
    }
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `transport` | `"websocket"` | `"websocket"` 或 `"webhook"` |
| `webhook.path` | `"/qqbot/webhook"` | 接收回调的 HTTP 路径 |

#### 平台配置步骤

1. 登录 [QQ 开放平台](https://q.qq.com/) → 开发设置 → 消息接收方式
2. 选择 **HTTP 回调**
3. 填写回调 URL：`https://your-domain.com/qqbot/webhook`
4. 平台发送 `op:13` 验证请求，插件自动处理签名验证
5. 验证通过后，所有事件将以 POST 方式推送到该地址

---

### 群聊配置

插件提供灵活的群聊管控能力，支持按群定制触发规则、工具权限和 AI 行为策略。

#### @提及触发模式（requireMention）

默认情况下，群聊中**必须 @机器人**才会触发 AI 回复。你可以通过配置让 AI 自主判断是否需要发言：

| 模式 | 配置值 | 行为 |
|------|--------|------|
| **仅 @时回复** | `true`（默认） | 群消息中只有 @了机器人才会触发回复 |
| **自主发言** | `false` | AI 自主判断每条消息是否需要回复，无需 @ |

**优先级链**（从高到低）：

```
具体群 groups.{groupOpenid}.requireMention
  > 通配符 groups."*".requireMention
    > 账户级 defaultRequireMention
      > 默认值 true
```

**配置示例：**

```json
{
  "channels": {
    "qqbot": {
      // 账户级：所有群的默认行为
      "defaultRequireMention": false,

      "accounts": {
        "default": {
          "groups": {
            "*": {
              // 通配符：所有群的兜底规则
              "requireMention": false
            },
            "GROUP_OPENID": {
              // 单群覆盖：这个群仍然需要 @
              "requireMention": true
            }
          }
        }
      }
    }
  }
}
```

> **使用场景举例：**
>
> - 工作群设为 `requireMention: true` — 避免 AI 对每条闲聊都插嘴
> - 专属 AI 陪伴群设为 `requireMention: false` — 像真人一样自然参与对话
> - 通过 `/bot-group-always on|off` 指令可在运行时动态切换账户级默认值

#### 其他群配置项

除 `requireMention` 外，每个群还支持以下配置：

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ignoreOtherMentions` | `boolean` | `false` | 是否忽略 @了其他人但没 @机器人的消息。开启后这类消息直接丢弃，不记录历史、不触发 AI |
| `toolPolicy` | `"full" \| "restricted" \| "none"` | `"restricted"` | 群聊中 AI 可使用的工具范围。`full`=全部可用；`restricted`=限制敏感工具（如命令执行、文件操作）；`none`=禁止所有工具调用 |
| `prompt` | `string` | 内置默认提示词 | 该群专属的系统提示词，会追加到全局 systemPrompt 之后 |
| `historyLimit` | `number` | `20` | 群历史消息缓存条数（0 禁用） |
| `historyMode` | `"clear" \| "rolling"` | `"clear"` | `clear`：每次回复后清空历史（旧行为）。`rolling`：bot 自己的发言也计入历史，回复后裁剪到 bot 最后一条发言之后（AI 能看到自己上次说到哪） |
| `unmentionedInbound` | `"user_request" \| "room_event"` | `"user_request"` | `room_event`：像普通群成员一样读到所有消息，未 @ 的作为被动房间事件（详见下文；需群主开启全量推送模式） |
| `coalesce` | `object` | `{enabled: true}` | 群消息排队配置，完全交给框架队列（`enabled=true`→collect 合并批处理；`false`→followup 排队不合并） |

#### 房间事件模式（全量模式群，可选）

> 前提：群主把该群的推送范围设为「接收所有消息」（全量模式）。AT 模式的群收不到未 @ 消息，此配置无效果。

```json
"groups": {
  "GROUP_OPENID": { "unmentionedInbound": "room_event" }
}
```

开启后的行为：

- **被 @ / 被称呼 / 引用 bot 消息** → 正常回复（完整回复权）
- **其余所有消息** → 被动房间事件：AI 只读上下文，最终文本**不投递**（结构性沉默），想发言必须主动调用 `message` 工具
- 房间事件绝不打断正在处理的任务，只排队
- ⚠️ 成本提示：每条消息跑一次推理（「读」消息），活跃群请按群显式开启

**称呼唤醒**（群友不打 @、直接叫名字）：在 `agents` 段（不在 `channels.qqbot` 下）配置：

```json
"agents": {
  "list": [{ "id": "default", "groupChat": { "mentionPatterns": ["沈处"] } }]
}
```

误唤醒有兜底：LLM 判断「只是在聊我、不是在叫我」时可输出 `NO_REPLY` 保持沉默（框架自动注入该指引，无需改提示词）。

**完整群配置示例：**

```json
{
  "channels": {
    "qqbot": {
      "defaultRequireMention": false,
      "accounts": {
        "default": {
          "groups": {
            "*": {
              "requireMention": true,
              "toolPolicy": "restricted",
              "ignoreOtherMentions": true
            },
            "WORK_GROUP_OPENID": {
              "requireMention": true,
              "toolPolicy": "none",
              "prompt": "你是工作助手，只回答与工作相关的问题"
            },
            "FRIEND_GROUP_OPENID": {
              "requireMention": false,
              "toolPolicy": "full",
              "prompt": "你是群里的朋友，轻松随意地聊天"
            }
          }
        }
      }
    }
  }
}
```

#### 群访问控制（groupPolicy）

通过 `groupPolicy` 控制哪些群允许机器人加入并接收消息：

| 策略 | 说明 |
|------|------|
| `"open"`（默认） | 所有群均可使用 |
| `"allowlist"` | 仅 `groupAllowFrom` 白名单中的群可使用 |
| `"disabled"` | 禁止所有群聊 |

```json
{
  "channels": {
    "qqbot": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["ALLOWED_GROUP_OPENID_1", "ALLOWED_GROUP_OPENID_2"]
    }
  }
}
```

> 也可通过 [**`/bot-group-always`** 指令](#bot-group-always--群消息响应模式切换) 在运行时动态切换账户级默认值，无需重启。

---

#### STT（语音转文字）— 自动转录用户发来的语音消息

STT 支持两级配置，按优先级查找：

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.stt` | 插件专属 |
| 2（fallback） | `tools.media.audio.models[0]` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- 设置 `enabled: false` 可禁用
- 配置后，用户发来的语音消息会自动转换（SILK→WAV）并转录为文字
- `asrFallback` — 平台转写（`asr_refer_text`）参与开关。**未显式设为 `true` 时，平台转写在所有场景下都被丢弃**：自有 STT 失败或返回空时不作兜底，STT 未配置时也不作为唯一来源（此时语音消息渲染为 `[Voice message - transcription unavailable]` 占位文本，音频 URL 仍通过 `- Voice:` 行引用）。该开关从 `channels.qqbot.stt.asrFallback` 读取，与 STT 凭证是否解析成功无关——仅写 `stt: { "asrFallback": true }` 即可恢复平台转写参与旧行为：

```json
{
  "channels": {
    "qqbot": {
      "stt": {
        "provider": "your-provider",
        "model": "your-stt-model",
        "asrFallback": true
      }
    }
  }
}
```

#### TTS（文字转语音）— 机器人发送语音消息

| 优先级 | 配置路径 | 作用域 |
|--------|----------|--------|
| 1（highest） | `channels.qqbot.tts` | 插件专属 |
| 2（fallback） | `messages.tts` | 框架级 |

```json
{
  "channels": {
    "qqbot": {
      "tts": {
        "provider": "your-provider",
        "model": "your-tts-model",
        "voice": "your-voice"
      }
    }
  }
}
```

- `provider` — 引用 `models.providers` 中的 key，自动继承 `baseUrl` 和 `apiKey`
- `voice` — 语音音色
- 设置 `enabled: false` 可禁用（默认：`true`）
- 配置后，AI 可生成并发送语音消息

#### 流式回复 — 仅 C2C 私聊

通过 QQ 流式接口逐段下发回复（打字机效果）。群聊不支持流式（平台限制）。未配置即关闭。

```json
{
  "channels": {
    "qqbot": {
      "streaming": {
        "mode": "partial",
        "sendMode": "stream"
      }
    }
  }
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `mode` | *（未配置 = 关闭）* | `"partial"` 开启流式接收；`"off"` 关闭 |
| `sendMode` | `"stream"` | `"stream"` — QQ 流式打印机（打字机；已下发前缀不可变，尾部重写合并为追加）。`"static"` — 生成期间只累积，结束时一条完整消息发出（无打字机） |

- 流式分片（`session.update`）仍消耗触发消息的被动回复配额
- 流式出错时控制器自动降级为单条静态消息

#### 正在输入指示器（typing）— 仅 C2C 私聊

机器人收到私聊消息后会显示"正在输入中…"，并在 AI 处理期间周期性续期。

```json
{
  "channels": {
    "qqbot": {
      "typing": {
        "enabled": true,
        "intervalMs": 20000
      }
    }
  }
}
```

- `enabled` — 是否启用（默认：`true`），设为 `false` 可完全关闭
- `intervalMs` — 续期间隔毫秒（默认：`20000`）。QQ 客户端退出聊天界面再进入后指示器会消失，只有新的推送才会重新显示，因此需要续期；受 QPS 限制，低于 `20000` 的值会被钳制到 `20000`
- **配额说明**：typing 通知与回复消息共享同一条用户消息的被动回复配额（QQ 开放平台同一条消息被动回复上限约 5 条）。被动配额耗尽后，typing 与回复消息一样自动降级为主动发送（不带 msg_id），续期不会中断
- **中间消息续期**：机器人发出消息（如思维链等中间输出）后 QQ 客户端会终止指示器显示；若框架任务仍在进行，插件会在消息发出 5 秒后自动补发一次续期恢复显示（同样受 20s QPS 间距保护）。最终回复发出后任务完成，不再补发

---

## 📚 文档与链接

- [更新日志](CHANGELOG.md) — 与旧版本的差异、破坏性变更与各版本记录
- [命令参考](docs/commands.md) — OpenClaw CLI 常用命令

## 🤝 贡献者

感谢所有为本项目做出贡献的开发者！上游贡献者见 [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot/graphs/contributors)。

<a href="https://github.com/jerryliang122/qqbot-openclaw/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=jerryliang122/qqbot-openclaw" />
</a>

## 💖 致谢

特别感谢 [@sliverp](https://github.com/sliverp) 对项目的核心贡献！

<a href="https://github.com/sliverp"><img src="https://avatars.githubusercontent.com/u/38134380?v=4" width="48" height="48" alt="sliverp" title="sliverp"/></a>

感谢[腾讯云Lighthouse](https://cloud.tencent.com/product/lighthouse)的深度合作，养小龙虾，首选腾讯云Lighthouse！

<a href="https://cloud.tencent.com/product/lighthouse">
  <img alt="腾讯云 Lighthouse" src="./docs/images/lighthouse-head.png" height="500" style="max-width:80%; height:auto;"/>
</a>

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=jerryliang122/qqbot-openclaw&type=date&legend=top-left)](https://www.star-history.com/#jerryliang122/qqbot-openclaw&type=date&legend=top-left)

</div>
