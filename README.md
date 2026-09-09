<div align="center">

<img width="120" src="https://img.shields.io/badge/🤖-QQ_Bot-blue?style=for-the-badge" alt="QQ Bot" />

# QQ Bot Channel Plugin for OpenClaw

**Independently maintained fork — framework-delegated group queueing, room-event ingestion for full-mode groups, and passive-first outbound delivery**

**Connect your AI assistant to QQ — private chat, group chat, and rich media, all in one plugin.**

### 🚀 Current Version: `v1.0.0`

[![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![QQ Bot](https://img.shields.io/badge/QQ_Bot-API_v2-red)](https://bot.q.qq.com/wiki/)
[![Platform](https://img.shields.io/badge/OpenClaw-%3E%3D2026.9.2-orange)](https://github.com/jerryliang122/qqbot-openclaw)
[![Node.js](https://img.shields.io/badge/Node.js->=18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Fork](https://img.shields.io/badge/fork-enhanced-9cf)](https://github.com/jerryliang122/qqbot-openclaw)

<br/>

**[简体中文](README.zh.md) | English**

> This is an **independently maintained fork** with its own versioning (v1.x, decoupled from the upstream 2.x line). Upstream: [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot).
>
> **Requirements**: OpenClaw `>= 2026.9.2` · Published to npm as [`@jerryliang122/openclaw-qqbot`](https://www.npmjs.com/package/@jerryliang122/openclaw-qqbot). See [CHANGELOG](CHANGELOG.md) for differences vs the old version and the upgrade guide.

Scan to join the QQ group chat

<img width="400" alt="QQ QR Code" src="./docs/images/developer-group.png" />

</div>

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| 🔄 **Group Queueing** | Group messages dispatch immediately; queueing/merging is delegated to the OpenClaw framework followup queue (collect mode) — active turns are never interrupted, bursts merge into one batch |
| 👁️ **Room Events** (opt-in) | In groups with full-message push mode, the bot can read every message like a normal member; un-@'d traffic arrives as passive room events (read-only — the AI speaks only via the proactive `message` tool) |
| 🔔 **Three Wake Modes** | @mention, name patterns (`mentionPatterns`, e.g. "沈处"), and quote-of-bot-message all trigger normal replies |
| 📤 **Passive-First Outbound** | Every send prefers passive reply (msg_id) to conserve the 1000/day proactive budget; quota-aware fallback never hard-fails |
| 🔒 **Multi-Scene** | C2C private chat, group chat (@mention / autonomous / room-event modes) |
| 👥 **Group Fine-Tuning** | Per-group @trigger rules, tool policies, custom prompts, history modes, queueing config, room-event policy |
| 🌐 **Dual Transport** | WebSocket (default) or Webhook (HTTP callback) — switch via config |
| 🖼️ **Rich Media** | Send & receive images, voice, video, and files |
| 🎙️ **Voice (STT/TTS)** | Speech-to-text transcription & text-to-speech replies |
| 🔄 **Update Check** | `/bot-upgrade` checks the npm registry for new versions and links the upgrade guide |
| ⏰ **Scheduled Push** | Proactive message delivery via scheduled tasks |
| 🔗 **URL Support** | Direct URL sending in private chat (no restrictions) |
| ⌨️ **Typing Indicator** | "Bot is typing..." status shown in real-time |
| 📝 **Markdown** | Full Markdown formatting support |
| 🛠️ **Commands** | Native OpenClaw command integration |
| 💬 **Quoted Context** | Parses the original message a user is replying to and injects it into AI context, so the model always knows exactly which message is being referenced |
| 📦 **Large File Support** | Auto chunked upload for large files (parallel upload with retry), up to 100 MB |
| 🔐 **Command Execution Approval** | AI requests approval via Inline Keyboard buttons before executing commands — tap to allow or deny |

---

## 📸 Feature Showcase

> **Note:** This plugin serves as a **message channel** only — it relays messages between QQ and OpenClaw. Capabilities like image understanding, voice transcription, drawing, etc. depend on the **AI model** you configure and the **skills** installed in OpenClaw, not on this plugin itself.

### 💬 Quoted Message Context

When a user quotes a message in QQ, the plugin automatically parses the quoted message content and injects it into the AI context, so the model clearly knows "which message the user is replying to" and gives more accurate responses. Supports text and media messages (image/voice/video/file), and works across devices.

<img width="360" src="docs/images/ref-msg.png" alt="Quoted Message Context Demo" />

### 🎙️ Voice Messages (STT)

With STT configured, the plugin automatically transcribes voice messages to text before passing them to AI. The whole process is transparent to the user — sending voice feels as natural as sending text.

> **You**: *(send a voice message)* "What's the weather like tomorrow in Shenzhen?"
>
> **QQBot**: Tomorrow (March 7, Saturday) Shenzhen weather forecast 🌤️ ...

<img width="360" src="docs/images/voice-stt.jpg" alt="Voice STT Demo" />

### 📄 File Understanding

Send any file to the bot — novels, reports, spreadsheets — AI automatically recognizes the content and gives an intelligent reply.

> **You**: *(send a TXT file of "War and Peace")*
>
> **QQBot**: Got it! You uploaded the Chinese version of "War and Peace" by Leo Tolstoy. This appears to be the opening of Chapter 1...

<img width="360" src="docs/images/file-understand.jpg" alt="File Understanding Demo" />

### 🖼️ Image Understanding

If your main model supports vision (e.g. Tencent Hunyuan `hunyuan-vision`), AI can understand images too. This is a general multimodal capability, not plugin-specific.

> **You**: *(send an image)*
>
> **QQBot**: Haha, so cute! Is that a QQ penguin in a lobster costume? 🦞🐧 ...

<img width="360" src="docs/images/image-understand.jpg" alt="Image Understanding Demo" />

### 🎨 Image Sending

> **You**: Draw me a cat
>
> **QQBot**: Here you go! 🐱

AI can send images directly. Supports local paths and URLs. Formats: jpg/png/gif/webp/bmp.

<img width="360" src="docs/images/image-send.jpg" alt="Image Generation Demo" />

### 🔊 Voice Sending

> **You**: Tell me a joke in voice
>
> **QQBot**: *(sends a voice message)*

AI can send voice messages directly. Formats: mp3/wav/silk/ogg. No ffmpeg required.

<img width="360" src="docs/images/voice-send.jpg" alt="TTS Voice Demo" />

### ⏰ Scheduled Reminder (Proactive Message)

> **You**: Remind me to eat in 5 minutes
>
> **QQBot**: confirms the reminder first, then proactively sends a voice + text reminder when time is up

This capability depends on OpenClaw cron scheduling and proactive messaging. If no reminder arrives, a common reason is QQ-side interception of bot proactive messages.

<img width="360" src="docs/images/reminder.jpg" alt="Scheduled Reminder Demo" />

### 📎 File Sending

> **You**: Extract chapter 1 of War and Peace and send it as a file
>
> **QQBot**: *(sends a .txt file)*

AI can send files directly, in any format.

<img width="360" src="docs/images/file-send.jpg" alt="File Sending Demo" />

Large file transfer is supported: images up to 20MB, videos up to 30MB, attachments up to 100MB, with a daily transfer limit of 2GB.

<img width="360" src="docs/images/large-file-transfer.jpg" alt="Large File Transfer Demo" />

### 🔐 Command Execution Approval

When the AI needs to execute a command, the plugin sends an approval request via QQ message with interactive buttons — tap **✅ Allow Once**, **⭐ Always Allow**, or **❌ Deny** to control whether the command runs. 

Use the `/bot-approve` command to manage the approval mode (allowlist / off / strict).

<img width="360" src="docs/images/approve.png" alt="Command Execution Approval Demo" />

### 🎬 Video Sending

> **You**: Send me a demo video
>
> **QQBot**: *(sends a video)*

AI can send videos directly. Supports local files and URLs.

<img width="360" src="docs/images/video-send.jpg" alt="Video Sending Demo" />

> **Under the hood:** Upload dedup caching, ordered queue delivery, and multi-layer audio format fallback.

### 🛠️ Slash Commands

The plugin provides built-in slash commands that are intercepted before reaching the AI queue, giving instant responses for diagnostics and management.

#### `/bot-ping` — Latency Test

> **You**: `/bot-ping`
>
> **QQBot**: ✅ pong！⏱ Latency: 602ms (network: 602ms, plugin: 0ms)

Measures end-to-end latency from QQ server push to plugin response, broken down into network transport and plugin processing time.

<img width="360" src="docs/images/slash-ping.jpg" alt="Ping Demo" />

#### `/bot-version` — Version Info

> **You**: `/bot-version`
>
> **QQBot**: 🦞 Framework: OpenClaw 2026.9.2 / 🤖 Plugin: v1.0.0 / 🌟 GitHub repo

Shows framework version, plugin version, and a direct link to the official repository.

<img width="360" src="docs/images/slash-version.jpg" alt="Version Demo" />

#### `/bot-help` — Command List

> **You**: `/bot-help`
>
> **QQBot**: Lists all available slash commands with clickable shortcuts.

<img width="360" src="docs/images/slash-help.jpg" alt="Help Demo" />

#### `/bot-upgrade` — Version Check & Upgrade Guide

> **You**: `/bot-upgrade`
>
> **QQBot**: 📌 Current: v1.0.0 / 🆕 New version available / 📖 Upgrade guide link

Checks the installed version against the npm registry (`@jerryliang122/openclaw-qqbot`) and returns a link to the upgrade guide (repo CHANGELOG by default; override with `channels.qqbot.upgradeUrl`). Actual upgrading is done on the host via `openclaw plugins install` — see [Getting Started](#-getting-started).

<img width="360" src="docs/images/hot-update.jpg" alt="Upgrade Demo" />

#### `/bot-logs` — Log Export

> **You**: `/bot-logs`
>
> **QQBot**: 📋 Logs packaged (~2000 lines), sending file... *(sends a .txt file)*

Exports the last ~2000 lines of gateway logs as a file for quick troubleshooting.

<img width="360" src="docs/images/slash-logs.jpg" alt="Logs Demo" />

#### Usage Help

All commands support a `?` suffix to show usage:

> **You**: `/bot-upgrade ?`
>
> **QQBot**: 📖 /bot-upgrade usage: …

#### `/bot-approve` — Approval Configuration

> **You**: `/bot-approve`
>
> **QQBot**: 🔐 Command Execution Approval — Enable / Disable / Strict mode / Reset / View current config

Manage the AI command execution approval policy. Supported subcommands:

| Subcommand | Description |
|------------|-------------|
| `/bot-approve on` | Enable approval (allowlist mode, recommended) |
| `/bot-approve off` | Disable approval — commands execute directly |
| `/bot-approve always` | Strict mode — every execution requires approval |
| `/bot-approve reset` | Restore framework defaults |
| `/bot-approve status` | View current approval config |

#### `/bot-clear-storage` — Clear files generated through QQBot conversations and downloaded resources (stored on the host running OpenClaw)

`/bot-clear-storage` lists files generated by the conversation and files in the downloaded resources directory. Use `/bot-clear-storage --force` to confirm deletion.

#### `/bot-group-always` — Group Response Mode Toggle

> **You**: `/bot-group-always`
>
> **QQBot**: 🤖 Group autonomous mode: ❌ @mention required

Toggle group @trigger behavior at runtime — changes persist instantly, no restart needed:

| Subcommand | Description |
|------------|-------------|
| `/bot-group-always on` | AI decides when to speak autonomously (no @ needed) |
| `/bot-group-always off` | Only respond when @mentioned |
| `/bot-group-always` (no arg) | View current setting |

> ⚠️ This command modifies the account-level `defaultRequireMention`. It has lower priority than per-group `groups.{groupId}.requireMention` settings.

#### `/bot-group-info` — Group Push Mode & Effective Config (in-group)

> **You**: `/bot-group-info` *(sent in a group)*
>
> **QQBot**: 🤖 群信息 — push mode inference (AT / full), requireMention, queueing strategy, history mode, room-event policy, today's proactive message usage

Answers "why does this group have no context" diagnostics: the push mode is chosen by the **group owner** when adding the bot (AT only / AT + recent N / full), and this command shows what the plugin actually observes plus every effective config value.

---

## 🚀 Getting Started

### Step 1 — Create a QQ Bot on the QQ Open Platform

1. Go to the [QQ Open Platform](https://q.qq.com/) and **scan the QR code with your phone QQ** to register / log in. If you haven't registered before, scanning will automatically complete the registration and bind your QQ account.

<img width="3246" height="1886" alt="Clipboard_Screenshot_1772980354" src="https://github.com/user-attachments/assets/d8491859-57e8-47e4-9d39-b21138be54d0" />

2. After scanning, tap **Agree** on your phone — you'll land on the bot configuration page.
3. Click **Create Bot** to create a new QQ bot.

<img width="720" alt="Create Bot" src="docs/images/create-robot.png" />

> ⚠️ The bot will automatically appear in your QQ message list and send a first message. However, it will reply "The bot has gone to Mars" until you complete the configuration steps below.

<img width="400" alt="Bot Say Hello" src="docs/images/bot-say-hello.jpg" />

4. Find **AppID** and **AppSecret** on the bot's page, click **Copy** for each, and save them somewhere safe (e.g., a notepad). **AppSecret is not stored in plaintext — if you leave the page without saving it, you'll have to regenerate a new one.**

<img width="720" alt="Find AppID and AppSecret" src="docs/images/find-appid-secret.png" />

> For a step-by-step walkthrough with screenshots, see the [official guide](https://cloud.tencent.com/developer/article/2626045).

### Step 2 — Install / Upgrade the Plugin

> **Note**: The unscoped npm name `openclaw-qqbot` belongs to the original upstream project — this fork publishes as the scoped package `@jerryliang122/openclaw-qqbot`. Requires OpenClaw >= 2026.9.2.

**Option A: Install from npm (Recommended)**

```bash
openclaw plugins install @jerryliang122/openclaw-qqbot

# Or a specific version
openclaw plugins install @jerryliang122/openclaw-qqbot@1.0.0
```

**Option B: Install from GitHub**

```bash
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git

# Or a specific release tag
openclaw plugins install git+https://github.com/jerryliang122/qqbot-openclaw.git#v1.0.0
```

**Option C: Install from Local Source**

```bash
# Clone the repo
git clone https://github.com/jerryliang122/qqbot-openclaw.git
cd openclaw-qqbot

# Build
npm install
npm run build

# Install to OpenClaw (method 1: link)
openclaw plugins link .

# Or install to OpenClaw (method 2: pack)
npm pack
openclaw plugins install ./openclaw-qqbot-1.0.0.tgz
```

**Upgrading from the old (upstream 2.x) version?** See the [CHANGELOG](CHANGELOG.md) — it lists every breaking change (removed config keys, env vars, and behaviors) and the migration table.

**Option C: Configure Credentials**

After installation, configure your QQ bot credentials:

```bash
# Via QR code (recommended)
openclaw channels login --channel qqbot

# Or manually
openclaw channels add --channel qqbot --token "AppID:AppSecret"

# Start / restart
openclaw gateway restart
```

> Environment variables `QQBOT_APPID` / `QQBOT_SECRET` are also supported.


### Step 3 — Test

Open QQ, find your bot, and send a message!

<div align="center">
<img width="500" alt="Chat Demo" src="https://github.com/user-attachments/assets/b2776c8b-de72-4e37-b34d-e8287ce45de1" />
</div>

---

## ⚙️ Advanced Configuration

### Multi-Account Setup (Multi-Bot)

Run multiple QQ bots under a single OpenClaw instance.

#### Configuration

Edit `~/.openclaw/openclaw.json` and add an `accounts` field under `channels.qqbot`:

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

**Notes:**

- The top-level `appId` / `clientSecret` is the **default account** (accountId = `"default"`)
- Each key under `accounts` (e.g. `bot2`, `bot3`) is the `accountId` for that bot
- Each account can independently configure `enabled`, `name`, `allowFrom`, `systemPrompt`, etc.
- You may also skip the top-level default account and only configure bots inside `accounts`

Add a second bot via CLI (if the framework supports the `--account` parameter):

```bash
openclaw channels add --channel qqbot --account bot2 --token "222222222:secret-of-bot-2"
```

#### Sending Messages to a Specific Account's Users

When using `openclaw message send`, specify which bot to use with the `--account` parameter:

```bash
# Send with the default bot (no --account = uses "default")
openclaw message send --channel "qqbot" \
  --target "qqbot:c2c:OPENID" \
  --message "hello from default bot"

# Send with bot2
openclaw message send --channel "qqbot" \
  --account bot2 \
  --target "qqbot:c2c:OPENID" \
  --message "hello from bot2"
```

**Target Formats:**

| Format | Description |
|--------|-------------|
| `qqbot:c2c:OPENID` | Private chat (C2C) |
| `qqbot:group:GROUP_OPENID` | Group chat |
| `qqbot:channel:CHANNEL_ID` | Guild channel |

> ⚠️ **Important**: Each bot has its own set of user OpenIDs. An OpenID received by Bot A **cannot** be used to send messages via Bot B — this will result in a 500 error. Always use the matching bot's `accountId` to send messages to its users.

#### How It Works

- When `openclaw gateway` starts, all accounts with `enabled: true` launch their own connections (WebSocket or Webhook depending on `transport` config)
- Each account maintains an independent Token cache (isolated by `appId`), preventing cross-contamination
- Incoming message logs are prefixed with `[qqbot:accountId]` for easy debugging

---

### Webhook Transport Mode

By default, the plugin connects to QQ via **WebSocket** (outbound connection, no public IP required). You can switch to **Webhook** mode where QQ platform POSTs events to your HTTP endpoint.

| | WebSocket (default) | Webhook |
|---|---|---|
| Connection | Plugin connects to QQ gateway | QQ platform POSTs to your server |
| Public IP | Not required | Required |
| Use case | Development, single instance | Production, horizontal scaling, Serverless |
| Session resume | Supported (RESUME) | Stateless, no resume needed |
| Signature | Built-in | Ed25519 auto-verified by plugin |

#### Configuration

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

| Field | Default | Description |
|-------|---------|-------------|
| `transport` | `"websocket"` | `"websocket"` or `"webhook"` |
| `webhook.path` | `"/qqbot/webhook"` | HTTP path for receiving callbacks |

#### Platform Setup

1. Go to [QQ Open Platform](https://q.qq.com/) → Bot Settings → Message Receiving
2. Select **HTTP Callback**
3. Enter your callback URL: `https://your-domain.com/qqbot/webhook`
4. The platform sends an `op:13` validation request — the plugin handles it automatically
5. Once validated, all events will be POSTed to your endpoint

---

### Group Chat Configuration

The plugin provides flexible group chat controls, allowing you to customize trigger rules, tool permissions, and AI behavior per group.

#### @Mention Trigger Mode (`requireMention`)

By default, the bot **only responds when @mentioned** in a group. You can configure it to autonomously decide when to speak:

| Mode | Config Value | Behavior |
|------|-------------|----------|
| **@ only** | `true` (default) | Only messages that @mention the bot trigger AI processing. Non-@ messages are still cached in history but don't trigger AI |
| **Autonomous** | `false` | AI decides on its own whether each message needs a reply — no @ required |

> **Important**: Even when `requireMention: true`, non-@ messages are **still cached** in the group history buffer. They just don't trigger AI processing.

**Priority chain** (highest to lowest):

```
groups.{groupOpenid}.requireMention
  > groups."*".requireMention
    > account-level defaultRequireMention
      > default value true
```

**Example:**

```json
{
  "channels": {
    "qqbot": {
      // Account-level default for all groups
      "defaultRequireMention": false,

      "accounts": {
        "default": {
          "groups": {
            "*": {
              // Wildcard fallback for all groups
              "requireMention": false
            },
            "GROUP_OPENID": {
              // Per-group override — this group still requires @
              "requireMention": true
            }
          }
        }
      }
    }
  }
}
```

> **Use cases:**
>
> - Work groups → `requireMention: true` — avoid AI chiming in on every casual message
> - Dedicated AI companion groups → `requireMention: false` — participate naturally like a real person
> - Use [`/bot-group-always`](#bot-group-always--group-response-mode-toggle) to toggle account-level defaults at runtime

#### Additional Group Config Fields

Besides `requireMention`, each group supports these settings:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `ignoreOtherMentions` | `boolean` | `false` | If enabled, messages that @mention others but not the bot are silently dropped (not recorded, no AI trigger) |
| `toolPolicy` | `"full" \| "restricted" \| "none"` | `"restricted"` | Tool scope available to AI in this group. `full`=all tools; `restricted`=sensitive tools restricted (e.g., command execution, file ops); `none`=no tool calls allowed |
| `prompt` | `string` | built-in default | Group-specific system prompt, appended after global systemPrompt |
| `historyLimit` | `number` | `20` | Cached group history message count (0 disables) |
| `historyMode` | `"clear" \| "rolling"` | `"clear"` | `clear`: wipe history after each reply (legacy). `rolling`: bot outbounds are recorded too, and history is trimmed to after the bot's last message (AI sees what it last said) |
| `unmentionedInbound` | `"user_request" \| "room_event"` | `"user_request"` | `room_event`: read all messages like a group member; un-@'d traffic becomes passive room events (see [Room Events](#room-events-for-full-mode-groups-unmentionedinbound--opt-in); requires full-push-mode group) |
| `coalesce` | `object` | `{enabled: true}` | Group queueing config (see [Group Message Queueing](#group-message-queueing-configuration-coalesce--groupcoalesce)) |

**Full example with multiple groups:**

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
              "prompt": "You are a work assistant. Only answer work-related questions."
            },
            "FRIEND_GROUP_OPENID": {
              "requireMention": false,
              "toolPolicy": "full",
              "prompt": "You are a friend in the group. Chat casually and naturally."
            }
          }
        }
      }
    }
  }
}
```

#### Group Access Control (`groupPolicy`)

Control which groups are allowed via `groupPolicy`:

| Policy | Description |
|--------|-------------|
| `"open"` (default) | All groups are allowed |
| `"allowlist"` | Only groups in `groupAllowFrom` are allowed |
| `"disabled"` | Group chats are disabled entirely |

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

> You can also use [**`/bot-group-always`**](#bot-group-always--group-response-mode-toggle) to toggle account-level defaults at runtime without restarting.

---

### Group vs C2C Differential Handling

The plugin implements different message handling strategies for group and private chats:

#### Group Chat (Framework Queue Strategy)

- **All messages are processed** — nothing is dropped
- **Immediate dispatch** — messages go straight to the framework; no plugin-side waiting room
- **Queueing by the framework** — while a turn is active, subsequent messages queue behind it (`collect` mode: merged into one batch after the active turn finishes; 500ms debounce absorbs bursts, queue cap with overflow summarizing)
- **Never interrupts** — an active turn always completes; new messages wait their turn
- **SessionKey format**: `qqbot:{accountId}:group:{groupId}:coalescing` (legacy naming, kept for session continuity)
- **Admission strategy**: `exclusive` (framework durable-ingress convention) with **no abort signal** — interruption is structurally impossible

**Example behavior**:

```
User A: "Question 1"  → Start processing
User B: "Question 2"  → Queued in framework followup queue
User C: "Question 3"  → Queued in framework followup queue

Question 1 completes → [Q2, Q3] drain as one merged batch → AI sees combined context, single reply
```

#### C2C Private Chat (Exclusive Strategy)

- **User can interrupt** — sending a new message cancels the previous one
- **Last message wins** — only the most recent message is processed
- **SessionKey format**: `qqbot:{accountId}:{userId}`
- **Admission strategy**: `exclusive` with abort signal — new message cancels old

**Example behavior**:

```
User A: "Question 1"  → Start processing
User A: "Question 2"  → Cancel Q1, start processing Q2
```

#### Why This Design?

- **In groups**: All user messages should be preserved and addressed; a group is multi-user, so interruption would steal one member's answer from another
- **In C2C**: Users can change their mind mid-conversation
- **Aligns with user expectations** in different chat contexts

---

### Group Message Queueing Configuration (`coalesce` / `groupCoalesce`)

Control how group messages are queued and merged when they arrive in quick succession:

```json
{
  "channels": {
    "qqbot": {
      "groupCoalesce": {
        "enabled": true
      },
      "accounts": {
        "default": {
          "groups": {
            "GROUP_123": {
              "coalesce": {
                "enabled": false
              }
            }
          }
        }
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | `true` → framework `collect` mode (queue + merge batches); `false` → `followup` mode (queue without merging — preserves the "disable merging" intent while never interrupting active turns). Queueing/merging is fully delegated to the OpenClaw followup queue |

**Priority chain**: `groups.{groupId}.coalesce` > `groupCoalesce` (account-level) > defaults

**When enabled** (framework `collect`):

- Messages during an active turn queue up and drain as one merged batch
- 500ms debounce absorbs rapid-fire bursts even on an idle group
- Queue overflow is summarized (never hard-dropped like the old buffer-full behavior)
- The AI sees combined context with per-sender attribution, single reply per batch

---

### Room Events for Full-Mode Groups (`unmentionedInbound`) — opt-in

> Requires the group owner to have set the group's push mode to **full message reception** (receive all messages). In AT-mode groups this setting has no observable effect (un-@'d messages never arrive).

By default, un-@'d group messages only land in the history buffer. With `unmentionedInbound: "room_event"`, the bot **reads every message like a normal group member**:

```json
{
  "channels": {
    "qqbot": {
      "accounts": {
        "default": {
          "groups": {
            "GROUP_OPENID": {
              "unmentionedInbound": "room_event"
            }
          }
        }
      }
    }
  }
}
```

Behavior once enabled:

- **@mention / name pattern / quote-of-bot** → normal turn with full reply rights (wake modes, see below)
- **Everything else** → passive room event: the AI reads it as context, its natural text output is **not delivered** (structural silence — the framework doesn't even inject the NO_REPLY instruction), and it can only speak by proactively calling the `message` tool
- Room events never steer or interrupt an active turn — they queue behind it
- Room-event speech goes out through the passive-first outbound path (see below)

> ⚠️ **Cost note**: each room event runs one inference pass ("reading" the message). In an active group this adds real token spend — enable per group deliberately.

#### Wake Modes (what counts as "being addressed")

| Wake mode | Mechanism | Config |
|-----------|-----------|--------|
| @mention | `GROUP_AT_MESSAGE_CREATE` event / `mentions[].is_you` / content markers | built-in |
| **Name patterns** | Content matches a configured pattern (e.g. group members call the bot "沈处") | `agents.list.<id>.groupChat.mentionPatterns: ["沈处"]` — note this lives in the `agents` section, not `channels.qqbot`; effective in full-mode groups only |
| **Quote of bot message** | User quotes/replies to a bot outbound (resolved via ref-index) | built-in (`isImplicitMention`) |

Name-pattern false positives ("people talking *about* the bot") are handled gracefully: the turn runs with normal reply rights, and the LLM can output `NO_REPLY` to stay silent (the framework injects this guidance automatically — no prompt changes needed).

---

### Passive-First Outbound (protects the 1000/day proactive budget)

QQ Bot proactive messages (sent without msg_id) have a daily budget (~1000/day). The plugin prefers passive replies (msg_id) everywhere:

- Framework-provided `replyToId` is used when available; otherwise the freshest cached msg_id is attached (msgid-cache TTL matches the platform's passive window: 5min group / 30min c2c)
- Attaching a msg_id is **quota-aware**: the passive quota (5 replies per msg_id per 5min in groups) is atomically checked and consumed before the send — when exhausted, the send gracefully degrades to proactive instead of failing with platform error 40034128
- Residual proactive sends are counted per account per day (`/bot-group-info` shows usage; a warning is logged at 80% of the budget)
- Quiet groups (no message within the passive window) can only be reached proactively — that's a platform constraint, not a bug

---

### Group Rate Limiting (`rateLimit`) — enabled by default

Three-tier sliding-window throttling with conservative defaults (normal usage never hits them):

| Tier | Default | Keyed by |
|------|---------|----------|
| `perSender` | 20 msgs / min | sender openid |
| `perGroup` | 60 msgs / min | group openid (c2c falls back to sender) |
| `global` | 300 msgs / min | all messages |

```json
{
  "channels": {
    "qqbot": {
      "rateLimit": {
        "enabled": true,
        "perSender": { "max": 20, "windowMs": 60000 },
        "perGroup": { "max": 60, "windowMs": 60000 },
        "global": { "max": 300, "windowMs": 60000 }
      }
    }
  }
}
```

Rate-limited messages are dropped with an INFO log (no auto-reply, to avoid burning quota). Keep this enabled for room-event groups.

---

### Middleware Execution Order

The plugin processes messages through a carefully ordered middleware chain:

1. **Error Handler** — Catches exceptions at the outermost layer
2. **Message Filter** — Bot echo + message deduplication
3. **Inbound Guard** — Drops outbound echoes (c2c), duplicate pushes (30min window), contentless events
4. **Policy Injector** — Injects `ctx.state.policy` with dynamic config
5. **History Buffer** — Caches all group messages (including non-@; skipped for room-event groups)
6. **Access Control** — Dynamic pairing/allowlist checks
7. **Mention Gate** — Filters based on @mention rules (+ quote-of-bot implicit mention)
8. **Content Sanitizer** — Strips @markers, parses face tags
9. **Rate Limiter** — Three-layer throttling (enabled by default, see `rateLimit`)
10. **Slash Commands** — Intercepts `/bot-*` commands
11. **Secret Capture** (c2c only) — One-shot env-var secret input interception
12. **Typing Indicator** (C2C only) — Shows "typing..." status
13. **Quote Reference** — Parses quoted message context
14. **Attachment Processor** — Downloads/converts media
15. **Envelope Formatter** — Builds final message body

**Key points**:

- Inbound guard and history buffer run **before** mention gate → junk is dropped early, all real messages are cached
- Group messages dispatch immediately; the OpenClaw followup queue handles queueing/merging (`coalesce.enabled` selects `collect` vs `followup`)
- Typing indicator only runs for **C2C** messages

---

#### STT (Speech-to-Text) — Transcribe Incoming Voice Messages

STT supports two-level configuration with priority fallback:

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.stt` | Plugin-specific |
| 2 (fallback) | `tools.media.audio.models[0]` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- Set `enabled: false` to disable
- When configured, incoming voice messages are automatically converted (SILK→WAV) and transcribed
- `asrFallback` — platform ASR (`asr_refer_text`) participation switch. Unless explicitly set to `true`, QQ's built-in platform transcript is **discarded in all cases**: not used as a fallback when your STT fails or returns empty, and not used as the sole source when STT is not configured at all (voice messages then render as `[Voice message - transcription unavailable]`; the audio URL is still referenced via the `- Voice:` line). The flag is read from `channels.qqbot.stt.asrFallback` regardless of whether STT credentials resolve — `stt: { "asrFallback": true }` alone restores the legacy platform-transcript behavior:

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

#### TTS (Text-to-Speech) — Send Voice Messages

| Priority | Config Path | Scope |
|----------|------------|-------|
| 1 (highest) | `channels.qqbot.tts` | Plugin-specific |
| 2 (fallback) | `messages.tts` | Framework-level |

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

- `provider` — references a key in `models.providers` to inherit `baseUrl` and `apiKey`
- `voice` — voice variant
- Set `enabled: false` to disable (default: `true`)
- When configured, AI can generate and send voice messages

#### Streaming Replies — C2C private chat only

The bot can stream its reply progressively (typewriter effect) via QQ's streaming API. Group chats do not support streaming (platform constraint). Disabled unless configured.

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

| Field | Default | Description |
|-------|---------|-------------|
| `mode` | *(unset = off)* | `"partial"` enables streaming reception; `"off"` disables |
| `sendMode` | `"stream"` | `"stream"` — QQ streaming printer (typewriter; the delivered prefix is immutable, tail rewrites are merged into appends). `"static"` — accumulate while the model generates, then send one complete message at the end (no typewriter) |

- Streaming replies (`session.update` frames) still consume the passive-reply quota of the triggering message
- On stream errors the controller falls back to a single static message automatically

#### Typing Indicator — C2C private chat only

After receiving a private message, the bot shows "typing…" and renews it periodically while the AI is processing.

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

- `enabled` — enable/disable the indicator (default: `true`)
- `intervalMs` — renewal interval in milliseconds (default: `20000`). The QQ client clears the indicator when the user leaves and re-enters the chat; only a fresh push re-shows it, hence the periodic renewal. Values below `20000` are clamped to `20000` (QPS constraint)
- **Quota note**: typing notifications share the passive-reply quota of the user message they reply to (QQ Open Platform allows ~5 passive replies per message). Once the passive quota is exhausted, typing — just like reply messages — automatically falls back to proactive sending (no msg_id); renewal is never interrupted
- **Intermediate-message refresh**: when the bot sends a message (e.g. chain-of-thought intermediate output), the QQ client terminates the indicator; if the framework task is still running, the plugin renews the indicator 5 seconds after the message (still guarded by the 20s QPS spacing). After the final reply completes the task, no further refresh is sent

---

## 📚 Documentation & Links

- [Command Reference](docs/commands.md) — OpenClaw CLI commands
- [Changelog](CHANGELOG.md) — release notes

## 🤝 Contributors

This is a forked version. For contributors to the official version, see [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot/graphs/contributors).

<a href="https://github.com/jerryliang122/qqbot-openclaw/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=jerryliang122/qqbot-openclaw" />
</a>

## 💖 Acknowledgements

- Original project: [tencent-connect/openclaw-qqbot](https://github.com/tencent-connect/openclaw-qqbot)
- Special thanks to [@sliverp](https://github.com/sliverp) for outstanding contributions to the original project!
- Thanks to [Tencent Cloud Lighthouse](https://cloud.tencent.com/product/lighthouse) for the deep collaboration.

<a href="https://cloud.tencent.com/product/lighthouse">
  <img alt="Tencent Cloud Lighthouse" src="./docs/images/lighthouse-head.png" height="500" style="max-width:80%; height:auto;"/>
</a>

## ⭐ Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=jerryliang122/qqbot-openclaw&type=date&legend=top-left)](https://www.star-history.com/#jerryliang122/qqbot-openclaw&type=date&legend=top-left)

</div>
