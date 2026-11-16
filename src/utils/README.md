# `src/utils/` — 通用工具

> **模块速查**：本文件只写「做什么 / 关键文件 / 相关红线在哪 / 本目录特有的坑」。跨模块概念的完整叙事在 [`docs/agents/`](../../docs/agents/) 对应文件里，**改这个目录前先读那篇**——本文件不复制正文，只做指针。

## 职责边界

- **做**：无业务归属的通用能力——日志、@ 提及解析、跨平台路径、SSRF 校验、语音转录、语音文案、版本查询。
- **不做**：任何与 QQ 业务语义绑定的判定（那些在 [`src/features/`](../features/) 与 [`src/middleware/`](../middleware/)）。

## 关键文件

| 文件 | 作用 |
|---|---|
| `plugin-logger.ts` | `createPluginLogger`——**全仓日志的唯一正规入口** |
| `mention.ts` | `stripMentionText` / `detectWasMentioned` / `detectEventMention` / `matchesNamePattern`——@ 提及解析与判定 |
| `platform.ts` | `getPlatform` / `getHomeDir` / `getTempDir` / `getQQBotDataDir` / `getQQBotMediaDir` / `isWindows`——跨平台路径 |
| `ssrf-guard.ts` | `validateRemoteUrl` / `isReservedAddr`——远程 URL 校验 |
| `stt.ts` | `transcribeAudioViaFramework` / `isFrameworkSttConfigured` / `hasLegacySttConfig`——走框架转录管线 |
| `voice-text.ts` | `formatVoiceText` / `formatDuration`——语音消息文案渲染 |
| `pkg-version.ts` | `getPackageVersion` / `getOpenclawVersion`——版本号读取 |

## 相关红线

- **入站语音走框架转录管线**——配置只认框架 `tools.media.models`（**不是 `tools.media.audio.models`**）；失败一律占位不回退平台转写 → [`docs/agents/inbound.md`](../../docs/agents/inbound.md) §「入站语音走框架转录管线」
- **平台转写来源的语音元数据整体静默**（正文已含全文，渲染会逐字重复）→ 同上
- **媒体 source 的 SSRF 防护目前是「假防护」**（只按小写 `http://`/`https://` 字面量前缀判定）→ [`docs/agents/platform-capabilities.md`](../../docs/agents/platform-capabilities.md) §「媒体 source 的 SSRF 防护」
- **日志脱敏**——openid 走 `shortId()`，sessionKey 记 sha256 前 8 位 → 根 [`AGENTS.md`](../../AGENTS.md) § Security

## 本目录特有的坑

- **不要直接 `console.*`**——用 `createPluginLogger()`（`src/utils/plugin-logger.ts`）。唯一例外是早期 `register()` 路径（runtime logger 尚未接好）。
- **`@ 提及判定必须与 mentionGate 同源**——`mention.ts` 的判定和 `middleware` 里的 mention gate 要用同一套逻辑，否则会出现「门控认为被 @ 了但正文没剥掉 @」之类的不一致。
- **`ssrf-guard.ts` 的判定口径与平台解析器可能不一致**——`HTTP://` / `http:/` / 前导空格三种拼写能绕过字面量前缀判定；当前决定暂不加固，触发条件见 [`docs/agents/platform-capabilities.md`](../../docs/agents/platform-capabilities.md)。
- **`stt.ts` 的 `hasLegacySttConfig` 只用于识别废弃配置**——`channels.qqbot.stt` 整块已被忽略，不要复活它。
- **`platform.ts` 的路径函数要考虑 Windows**——别在别处直接拼 `~` 或 `/tmp`。
