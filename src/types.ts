// ── QQ 消息类型常量（message_type 枚举值） ──
/** 普通文本消息 */
export const MSG_TYPE_TEXT = 0;
/** 引用（回复）消息 */
export const MSG_TYPE_QUOTE = 103;

/**
 * QQ Bot 配置类型
 */
export interface QQBotConfig {
  appId: string;
  clientSecret?: string;
  clientSecretFile?: string;
}

/**
 * 解析后的 QQ Bot 账户
 */
export interface ResolvedQQBotAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  appId: string;
  clientSecret: string;
  secretSource: "config" | "file" | "env" | "none";
  /** 系统提示词 */
  systemPrompt?: string;
  /** 是否支持 markdown 消息（默认 true） */
  markdownSupport: boolean;
  /** 是否自动同步 openclaw essential 原生指令到 QQ Bot 指令面板（默认 true） */
  commandPanelNative: boolean;
  /** User-Agent 尾部追加内容 */
  userAgentSuffix: string;
  /**
   * 单条消息最大处理时间（ms）。0 表示不限制。默认 0（不限制）。
   * 
   * 注意：此配置目前已不再使用，因为已移除插件级的 concurrencyGuard 中间件，
   * 并发控制由 OpenClaw 框架的 session lane 机制处理。
   */
  processingTimeoutMs: number;
  config: QQBotAccountConfig;
}

/** 群消息策略：open=全响应 | allowlist=白名单 | disabled=不响应 */
export type GroupPolicy = "open" | "allowlist" | "disabled";

/** 工具策略：full=全部 | restricted=限制敏感工具 | none=禁止 */
export type ToolPolicy = "full" | "restricted" | "none";

/** 群消息排队策略 */
export type GroupCoalesceStrategy = "framework" | "plugin";

/** 群消息合并配置 */
export interface GroupCoalesceConfig {
  /**
   * 排队策略（默认 framework）：
   * - framework：消息逐条立即 dispatch，排队/合并交给 OpenClaw 框架的 followup 队列
   *   （此模式下 enabled=true → 框架 collect 合并批处理；enabled=false → followup 排队不合并）
   * - plugin：使用插件内建 coalescer busy-buffering（旧版行为，回退用）
   */
  strategy?: GroupCoalesceStrategy;
  /** 是否启用消息合并（默认 true；strategy=plugin 时门控插件 coalescer） */
  enabled?: boolean;
  /** 最大缓冲消息数（默认 50，仅 strategy=plugin 生效） */
  maxBuffer?: number;
}

/** 指令面板配置 */
export interface CommandsConfig {
  /**
   * 是否把 openclaw essential 原生指令自动注册到 QQ Bot 指令面板（默认 true）。
   * 面板项点击后指令文本填入输入框，以普通文本进入框架，走文本斜杠指令路由执行。
   */
  native?: boolean;
}

/** 单个群的配置 */
export interface GroupConfig {
  /** 是否需要 @机器人才响应（默认 true） */
  requireMention?: boolean;
  /**
   * 是否忽略 @了其他用户但没有 @机器人的消息（默认 false）。
   * 开启后，消息中 @了其他人但未 @bot 时直接丢弃（不记录历史、不触发 AI）。
   */
  ignoreOtherMentions?: boolean;
  /** 群聊中 AI 可使用的工具范围（默认 restricted） */
  toolPolicy?: ToolPolicy;
  /** 群名称 */
  name?: string;
  /** 群消息行为 PE（未配置时使用内置默认值） */
  prompt?: string;
  /** 群历史消息缓存条数（0 禁用，默认 20） */
  historyLimit?: number;
  /**
   * 群历史清理时机（默认 clear）：
   * - clear：每次回复后整清（旧语义，"自上次回复以来的窗口"）
   * - rolling：回复后裁剪到最后一条 bot 出站之后（bot 发言也计入历史，
   *   对齐 telegram selectAfterLastSelf 的滚动窗口语义）
   */
  historyMode?: 'clear' | 'rolling';
  /**
   * 未被 @ 的群消息入站策略（默认 user_request，仅全量模式群有实际意义）：
   * - user_request：维持现状——mentionGate 拦截未 @ 消息（只进历史，不上报）
   * - room_event：门控放行全部消息，未被 @/称呼/引用的作为 room_event 被动
   *   房间事件进框架（AI 只读上下文，不自动回复，想发言走主动 message 工具；
   *   框架自动压制 typing/流式/steer）。成本提示：每条消息一次推理 pass。
   */
  unmentionedInbound?: 'user_request' | 'room_event';
  /** 群消息合并配置（覆盖账号级配置） */
  coalesce?: GroupCoalesceConfig;
}

/** 限流单层配置（滑动窗口） */
export interface RateLimitTierConfig {
  /** 窗口内最大消息数 */
  max: number;
  /** 窗口时长（毫秒） */
  windowMs: number;
}

/** 三层限流配置（sender / group / global） */
export interface RateLimitConfig {
  /** 是否启用（默认 true；保守默认阈值，正常使用不会触发） */
  enabled?: boolean;
  /** 单发送者限流（默认 20 条/分钟） */
  perSender?: RateLimitTierConfig;
  /** 单群限流（默认 60 条/分钟，c2c 按 sender 归组） */
  perGroup?: RateLimitTierConfig;
  /** 全局限流（默认 300 条/分钟） */
  global?: RateLimitTierConfig;
}

/** 消息接收传输方式 */
export type TransportMode = "websocket" | "webhook";

/** Webhook 传输配置 */
export interface WebhookTransportConfig {
  /** 监听路径（默认 /qqbot/webhook） */
  path?: string;
}

/**
 * QQ Bot 账户配置
 */
export interface QQBotAccountConfig {
  enabled?: boolean;
  name?: string;
  appId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom?: string[];
  /** 消息接收传输方式：websocket（默认）| webhook */
  transport?: TransportMode;
  /** webhook 传输配置（transport="webhook" 时生效） */
  webhook?: WebhookTransportConfig;
  /** 群消息策略（默认 allowlist） */
  groupPolicy?: GroupPolicy;
  /** 群白名单（groupPolicy 为 allowlist 时生效） */
  groupAllowFrom?: string[];
  /** 群配置映射（按 groupOpenid 索引，"*" 为默认） */
  groups?: Record<string, GroupConfig>;
  /** 三层限流（sender/group/global，默认启用保守阈值） */
  rateLimit?: RateLimitConfig;
  /** 系统提示词，会添加在用户消息前面 */
  systemPrompt?: string;
  /** 是否支持 markdown 消息（默认 true，设为 false 可禁用） */
  markdownSupport?: boolean;
  /**
   * @deprecated 请使用 audioFormatPolicy.uploadDirectFormats
   * 可直接上传的音频格式（不转换为 SILK），向后兼容
   */
  voiceDirectUploadFormats?: string[];
  /**
   * 音频格式策略配置
   * 统一管理入站（STT）和出站（上传）的音频格式转换行为
   */
  audioFormatPolicy?: AudioFormatPolicy;
  /**
   * 是否启用公网 URL 直传 QQ 平台（默认 true）
   * 启用时：公网 URL 先直传给 QQ 开放平台的富媒体 API，平台自行拉取；失败后自动 fallback 到插件下载再 Base64 上传
   * 禁用时：公网 URL 始终由插件先下载到本地，再以 Base64 上传（适用于 QQ 平台无法访问目标 URL 的场景）
   */
  urlDirectUpload?: boolean;
  /**
   * /bot-upgrade 指令返回的升级指引网址
   * 默认: https://doc.weixin.qq.com/doc/w3_AKEAGQaeACgCNHrh1CbHzTAKtT2gB?scode=AJEAIQdfAAozxFEnLZAKEAGQaeACg
   */
  upgradeUrl?: string;
  /**
   * /bot-upgrade 指令的行为模式
   * - "doc"：展示升级文档链接（安全模式）
   * - "hot-reload"：检测到新版本时直接执行 npm 升级脚本进行热更新（默认）
   */
  upgradeMode?: "doc" | "hot-reload";
  /**
   * /bot-upgrade 热更新时使用的 npm 包名
   * 支持 "scope/name"（自动补 @）或 "@scope/name" 格式
   * 默认: "@tencent-connect/openclaw-qqbot"
   * 示例: "ryantest/openclaw-qqbot"
   */
  upgradePkg?: string;
  /**
   * 群消息是否默认需要 @机器人才响应（默认 true）
   * 优先级低于 groups.{groupId}.requireMention 和 groups."*".requireMention
   * 设为 false 时，所有群默认无需 @ 即触发回复（仍可被群级配置覆盖）
   */
  defaultRequireMention?: boolean;
  /**
   * 群消息合并配置（账号级）
   * 启用后，群聊中快速发送的多条消息会被合并处理，而不是取消之前的任务
   * 与私聊的"插嘴"行为相反，群聊中所有消息都应该被处理
   */
  groupCoalesce?: GroupCoalesceConfig;
  /**
   * 出站消息合并回复（debounce）配置
   * 当短时间内收到多次 deliver 时，将文本合并为一条消息发送，避免消息轰炸
   */
  deliverDebounce?: DeliverDebounceConfig;
  /**
   * "正在输入"指示器配置（仅 C2C 私聊生效）
   */
  typing?: TypingIndicatorConfig;
  /**
   * 指令面板配置（openclaw 原生指令 → QQ Bot 指令面板自动注册）
   */
  commands?: CommandsConfig;
  /**
   * 是否启用流式消息（默认 false）
   * 启用后，AI 的回复会以流式形式逐步显示在 QQ 聊天中，
   * 用户可以看到文字逐字出现的打字机效果。
   *
   * 兼容布尔值和对象格式，对齐框架 schema：
   *   - true / false         旧版布尔格式（自动转换为对象）
   *   - { mode: "partial" }  开启（对齐 StreamingMode.partial）
   *   - { mode: "off" }      关闭
   *
   * 注意：仅 C2C（私聊）支持流式消息 API。
   *
   * sendMode 控制文本下发通道（仅 mode="partial" 时生效）：
   *   - "stream"  QQ 流式打印机（默认）：同一条消息内容不断变长，打字机效果
   *   - "static"  流结束时用一条普通 sendText 发送完整文本：无打字机，
   *               partial 接收逻辑（状态机/串行/去重）保持不变，仅替换下发通道。
   *               适合不想要打字机效果、只想收到一条完整回复的场景。
   */
  streaming?:
    | boolean
    | {
        mode: 'partial' | 'off';
        sendMode?: 'stream' | 'static';
      };
  /**
   * STT (语音转文字) 配置
   * 配置后，收到语音消息时会自动调用 STT 服务转录为文字
   */
  stt?: STTChannelConfig;
  /**
   * ⚠️ 已废弃 - 此配置已不再使用
   * 
   * 原用途：单条消息最大处理时间（毫秒），由已移除的 concurrencyGuard 中间件实现超时保护。
   * 
   * 移除 concurrencyGuard 后的影响：
   * - 此配置字段被读取但不会产生任何超时行为
   * - 环境变量 OPENCLAW_PROCESSING_TIMEOUT_MS 也被忽略
   * - 框架级的 session lane 没有提供消息级超时机制
   * 
   * 如果需要超时保护，请考虑：
   * - 在 OpenClaw 框架配置中设置全局超时
   * - 或等待插件重新实现消息级超时机制
   * 
   * @deprecated Since v2.0.1 - concurrencyGuard 已移除
   */
  processingTimeoutMs?: number;
  /**
   * User-Agent 尾部追加内容（用于私有化部署标识等场景）
   * 追加在 `QQBotPlugin/{version} (Node/{nodeVersion}; {os}; OpenClaw/{version})` 之后
   */
  userAgentSuffix?: string;
}

/**
 * 出站消息合并回复配置
 */
export interface DeliverDebounceConfig {
  /**
   * 是否启用合并回复（默认 true）
   */
  enabled?: boolean;
  /**
   * 合并窗口时长（毫秒），在此时间内的连续 deliver 会被合并
   * 默认 1500ms
   */
  windowMs?: number;
  /**
   * 最大等待时长（毫秒），从第一条 deliver 开始计算，超过此时间强制发送
   * 防止持续有新 deliver 导致一直不发送
   * 默认 8000ms
   */
  maxWaitMs?: number;
  /**
   * 合并文本之间的分隔符
   * 默认 "\n\n---\n\n"
   */
  separator?: string;
}

/**
 * "正在输入"指示器配置
 *
 * QQ 客户端行为：退出聊天界面再进入后，指示器会消失，只有收到新的
 * input_notify 推送才会重新显示，因此处理期间需要周期性续期。
 *
 * 配额说明：typing 通知与回复消息共享同一 msg_id 的被动回复配额
 * （QQ 开放平台同一条消息被动回复上限约 5 条）。被动配额耗尽后，
 * typing 与回复消息一样自动降级为主动发送（不带 msg_id），续期不中断。
 *
 * 中间消息：机器人发出消息（如思维链中间输出）后，QQ 客户端会终止
 * 指示器显示。若框架任务仍在进行，插件会在消息发出 5 秒后补发一次
 * 续期；若是最终回复（任务完成），则不再补发。
 */
export interface TypingIndicatorConfig {
  /**
   * 是否启用指示器（默认 true）
   */
  enabled?: boolean;
  /**
   * 续期间隔（毫秒），默认 20000
   * 受 QPS 限制，低于 20000 会被钳制到 20000
   */
  intervalMs?: number;
}

/**
 * 音频格式策略：控制哪些格式可跳过转换
 */
export interface AudioFormatPolicy {
  /**
   * STT 模型直接支持的音频格式（入站：跳过 SILK→WAV 转换）
   * 如果 STT 服务支持直接处理某些格式（如 silk/amr），可将其加入此列表
   * 例如: [".silk", ".amr", ".wav", ".mp3", ".ogg"]
   * 默认为空（所有语音都先转换为 WAV 再送 STT）
   */
  sttDirectFormats?: string[];
  /**
   * QQ 平台支持直传的音频格式（出站：跳过→SILK 转换）
   * 默认为 [".wav", ".mp3", ".silk"]（QQ Bot API 原生支持的三种格式）
   * 仅当需要覆盖默认值时才配置此项
   */
  uploadDirectFormats?: string[];
  /**
   * 是否启用语音转码（默认 true）
   * 设为 false 可在环境无 ffmpeg 时跳过转码，直接以文件形式发送
   * 当禁用时，非原生格式的音频会 fallback 到 sendDocument（文件发送）
   */
  transcodeEnabled?: boolean;
}

/**
 * STT (语音转文字) 配置
 */
export interface STTChannelConfig {
  /** 是否启用 STT（默认 true，配置了 baseUrl+apiKey 即自动启用） */
  enabled?: boolean;
  /** STT 服务提供商 ID（对应 models.providers 中的 key，默认 "openai"） */
  provider?: string;
  /** STT API 地址（如 https://api.openai.com/v1） */
  baseUrl?: string;
  /** STT API 密钥 */
  apiKey?: string;
  /** STT 模型名称（默认 "whisper-1"） */
  model?: string;
}

/**
 * 富媒体附件
 */
export interface MessageAttachment {
  content_type: string;  // 如 "image/png"
  filename?: string;
  height?: number;
  width?: number;
  size?: number;
  url: string;
  voice_wav_url?: string;  // QQ 提供的 WAV 格式语音直链，有值时优先使用以避免 SILK→WAV 转换
  asr_refer_text?: string; // QQ 事件内置 ASR 语音识别文本
}

/**
 * C2C 消息事件
 */
export interface C2CMessageEvent {
  author: {
    id: string;
    union_openid: string;
    user_openid: string;
  };
  content: string;
  id: string;
  timestamp: string;
  message_scene?: {
    source: string;
    /** ext 数组，可能包含 ref_msg_idx=REFIDX_xxx（引用的消息）和 msg_idx=REFIDX_xxx（自身索引） */
    ext?: string[];
  };
  attachments?: MessageAttachment[];
  /** 消息类型，参见 MSG_TYPE_* */
  message_type?: number;
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msg_elements?: MsgElement[];
}

/**
 * 频道 AT 消息事件
 */
export interface GuildMessageEvent {
  id: string;
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    username?: string;
    bot?: boolean;
  };
  member?: {
    nick?: string;
    joined_at?: string;
  };
  attachments?: MessageAttachment[];
}

/** 消息元素结点，引用消息时 msg_elements[0] 为被引用的原始消息 */
export interface MsgElement {
  /** 消息索引标识 */
  msg_idx?: string;
  /** 消息类型，参见 MSG_TYPE_* 常量 */
  message_type?: number;
  /** 文本内容 */
  content?: string;
  /** 附件列表 */
  attachments?: MessageAttachment[];
  /** 嵌套消息元素（引用消息场景下可能存在） */
  msg_elements?: MsgElement[];
}

/**
 * 群聊 AT 消息事件
 */
export interface GroupMessageEvent {
  author: {
    id: string;
    member_openid: string;
    username?: string;
    bot?: boolean;
  };
  content: string;
  id: string;
  timestamp: string;
  group_id: string;
  group_openid: string;
  message_scene?: {
    source: string;
    ext?: string[];
  };
  attachments?: MessageAttachment[];
  /** @提及列表 */
  mentions?: Array<{
    scope?: "all" | "single";
    id?: string;
    user_openid?: string;
    member_openid?: string;
    nickname?: string;
    bot?: boolean;
    /** 是否 @机器人自身 */
    is_you?: boolean;
  }>;
  /** 消息类型，参见 MSG_TYPE_* */
  message_type?: number;
  /** 消息元素列表，引用消息时 [0] 为被引用的原始消息 */
  msg_elements?: MsgElement[];
}

/**
 * 按钮交互事件（INTERACTION_CREATE）
 */
export interface InteractionEvent {
  /** 事件 ID，用于回应交互（PUT /interactions/{id}） */
  id: string;
  /** 事件类型：11=消息按钮 12=单聊快捷菜单 */
  type: number;
  /** 场景：c2c / group / guild */
  scene?: string;
  /** 场景类型：0=频道 1=群聊 2=单聊 */
  chat_type?: number;
  /** 触发时间 RFC3339 */
  timestamp?: string;
  /** 频道 openid（仅频道场景） */
  guild_id?: string;
  /** 子频道 openid（仅频道场景） */
  channel_id?: string;
  /** 单聊用户 openid（仅 c2c 场景） */
  user_openid?: string;
  /** 群 openid（仅群聊场景） */
  group_openid?: string;
  /** 群内触发用户 openid（仅群聊场景） */
  group_member_openid?: string;
  version: number;
  data: {
    type: number;
    resolved: {
      /** 按钮 action.data 值 */
      button_data?: string;
      /** 按钮 id */
      button_id?: string;
      /** 操作用户 userid（仅频道场景） */
      user_id?: string;
      /** 自定义菜单 id（仅菜单场景） */
      feature_id?: string;
      /** 操作的消息 id（仅频道场景） */
      message_id?: string;
      /** 配置更新：群消息模式 "mention"=@机器人时激活 "always"=总是激活 */
      require_mention?: string;
      /** 配置更新：群消息策略 */
      group_policy?: GroupPolicy;
      /** 配置更新：@文本的名称提及BOT名，多个使用,分隔 */
      mention_patterns?: string;
    };
  };
}

// ---- Keyboard 类型 ----

/**
 * 按钮 Action 类型
 * 0=跳转链接  1=回调型(INTERACTION_CREATE)  2=指令型(直接发文本)  3=mqqapi
 */
export type KeyboardActionType = 0 | 1 | 2 | 3;

/** 按钮权限 */
export interface KeyboardPermission {
  /** 0=全体  1=管理员  2=按钮指定  3=身份组 */
  type: 0 | 1 | 2 | 3;
  specify_role_ids?: string[];
  specify_user_ids?: string[];
}

/** 二次确认弹窗 */
export interface KeyboardModal {
  content: string;
  confirm_text?: string;
  cancel_text?: string;
}

/** 按钮 Action */
export interface KeyboardAction {
  type: KeyboardActionType;
  data?: string;
  /** true = 点击后直接发出（Enter）*/
  enter?: boolean;
  /** 仅指令型（type=2）：是否把指令发到输入框（reply=true）还是静默发出 */
  reply?: boolean;
  permission?: KeyboardPermission;
  click_limit?: number;
  unsupport_tips?: string;
  modal?: KeyboardModal;
}

/** 按钮渲染数据 */
export interface KeyboardRenderData {
  label: string;
  visited_label?: string;
  /** 0=灰色线框  1=蓝色线框  2=推荐回复专用  3=红色字体  4=蓝色背景 */
  style?: 0 | 1 | 2 | 3 | 4;
}

/** 单个按钮 */
export interface KeyboardButton {
  id: string;
  render_data?: KeyboardRenderData;
  action?: KeyboardAction;
  group_id?: string;
}

/** 一行按钮 */
export interface KeyboardRow {
  buttons: KeyboardButton[];
}

/** CustomKeyboard（自定义按钮内容） */
export interface CustomKeyboard {
  rows: KeyboardRow[];
}

/** MessageKeyboard（keyboard / prompt_keyboard.keyboard 共用） */
export interface MessageKeyboard {
  /** 模板 ID（与 content 二选一） */
  id?: string;
  /** 自定义内容 */
  content?: CustomKeyboard;
}

/**
 * Inline Keyboard（消息内嵌按钮，需平台审核）
 * 发送字段：keyboard
 * JSON: { "keyboard": { "id": "...", "content": { "rows": [...] } } }
 */
export type InlineKeyboard = MessageKeyboard;

/**
 * WebSocket 事件负载
 */
export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}



// ---- 流式消息常量 ----

/** 流式消息输入模式 */
export const StreamInputMode = {
  /** 每次发送的 content_raw 替换整条消息内容 */
  REPLACE: "replace",
} as const;
export type StreamInputMode = (typeof StreamInputMode)[keyof typeof StreamInputMode];

/** 流式消息输入状态 */
export const StreamInputState = {
  /** 正文生成中 */
  GENERATING: 1,
  /** 正文生成结束（终结状态） */
  DONE: 10,
} as const;
export type StreamInputState = (typeof StreamInputState)[keyof typeof StreamInputState];

/** 流式消息内容类型 */
export const StreamContentType = {
  MARKDOWN: "markdown",
} as const;
export type StreamContentType = (typeof StreamContentType)[keyof typeof StreamContentType];

/**
 * 流式消息请求体
 * 对应 StreamReq proto
 */
export interface StreamMessageRequest {
  /** 输入模式 */
  input_mode: StreamInputMode;
  /** 输入状态 */
  input_state: StreamInputState;
  /** 内容类型 */
  content_type: StreamContentType;
  /** markdown 内容 */
  content_raw: string;
  /** 事件 ID */
  event_id: string;
  /** 原始消息 ID */
  msg_id: string;
  /** 流式消息 ID，首次发送后返回，后续分片需携带 */
  stream_msg_id?: string;
  /** 递增序号 */
  msg_seq: number;
  /** 同一条流式会话内的发送索引，从 0 开始，每次发送前递增；新流式会话重新从 0 开始 */
  index: number;
}


