---
name: qqbot-upgrade
description: 将 openclaw-qqbot 插件（@jerryliang122/openclaw-qqbot）升级到最新版本。当用户要求更新 QQ 机器人插件、升级 qqbot 扩展或同步最新版时使用。
metadata: {"openclaw":{"emoji":"⬆️","requires":{"config":["channels.qqbot"]}}}
---

# QQBot 插件升级

## 何时使用

用户表达以下意图时，应在**本机终端**执行升级命令（不要只口头说明「去官网升级」）：

- 更新 / 升级 `openclaw-qqbot` / QQBot 插件 / QQ 机器人插件
- 同步本仓库（jerryliang122/qqbot-openclaw）最新版

---

## 标准命令

npm 包（推荐）：

```bash
openclaw plugins install @jerryliang122/openclaw-qqbot
```

指定版本：

```bash
openclaw plugins install @jerryliang122/openclaw-qqbot@<version>
```

或从 GitHub（无法访问 npm 时）：

```bash
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git
```

升级完成后重启网关使其生效：

```bash
openclaw gateway restart
```

---

## 前置条件

- OpenClaw >= 2026.9.2（低版本框架无法加载本插件）
- 需 **Node.js / npm** 环境可访问 npm registry（或 GitHub）
- 从 2.x 旧版本升级：先阅读仓库 CHANGELOG 的 Breaking Changes 与配置迁移表

---

## 执行后

根据命令退出码与终端输出向用户简要汇报：成功则提示新版本号并确认网关已重启；失败则摘录关键错误并提示检查网络、npm 权限与 OpenClaw 版本。
