/**
 * Platform-neutral group chat response policy (ADR-0006).
 *
 * Solutions configure these rules; the platform decides whether a group
 * message should produce an Agent Turn.
 *
 * Group chat reply differentiation:
 * - Responses should be concise (2-3 sentences max)
 * - No private information or personalized content for specific contacts
 * - Only respond when @-mentioned or keyword-matched (configurable)
 * - The system prompt for group chats includes additional constraints
 *   (see agent-context.ts chatType hint and strategy prompt.ts)
 */

export type GroupChatPolicy = {
  readonly acceptAll: boolean;
  readonly replyWhenMentioned: boolean;
  /** 机器人群昵称列表：消息文本含 "@<昵称>" 才算被点名（不再信任 Host 的 fail-open mentioned）；空 = 回落 Host 判定（ADR-0011 引擎缺省中立，业务昵称由部署种子下发）。 */
  readonly botNames: readonly string[];
  readonly keywords: readonly string[];
  readonly responseProbability: number; // 0..1, only used when acceptAll is true
};

export type GroupMessageContext = {
  readonly text: string;
  readonly mentioned: boolean;
};

export const DEFAULT_GROUP_CHAT_POLICY: GroupChatPolicy = {
  acceptAll: false,
  replyWhenMentioned: true,
  /**
   * 引擎缺省为空（ADR-0011 业务缺省出引擎）：botNames 为空时回落
   * Host 的 mentioned fail-open 判定（与历史"未配置"行为一致）。
   * 业务昵称（如 客服）由产品仓部署种子经扩展设置 groupChat.botNames 下发。
   */
  botNames: [],
  keywords: [],
  responseProbability: 0,
};

export function shouldRespondToGroupMessage(
  policy: GroupChatPolicy,
  message: GroupMessageContext,
  random = Math.random,
): boolean {
  const text = message.text.trim().toLowerCase();
  // @ 判定：优先按配置昵称做文本匹配（Host 的 mentioned 是 fail-open，
  // 群里 @ 任何人都会标 true——不能作为唯一依据）；未配置昵称时才
  // 回落 Host 判定（与历史行为一致）。
  const mentionHit =
    policy.botNames.length === 0
      ? message.mentioned
      : policy.botNames.some(
          (name) =>
            name.trim().toLowerCase() !== "" &&
            text.includes(`@${name.trim().toLowerCase()}`),
        );
  if (policy.replyWhenMentioned && mentionHit) return true;
  if (
    policy.keywords.some(
      (keyword) =>
        keyword.trim().toLowerCase() &&
        text.includes(keyword.trim().toLowerCase()),
    )
  ) {
    return true;
  }
  if (!policy.acceptAll) return false;
  const probability = Math.min(1, Math.max(0, policy.responseProbability));
  return probability >= 1 || random() < probability;
}

// ---------------------------------------------------------------------------
// 可配置群聊策略（Solution 扩展设置下发；平台保持机制中立）
// ---------------------------------------------------------------------------

/** 群聊响应模式（配置枚举） */
export type GroupChatMode =
  | "mention_only"
  | "mention_or_keyword"
  | "accept_all"
  | "off";

/** 冷却护栏：窗口内每个群最多 N 条 AI 回复 */
export type GroupCooldownPolicy = {
  /** 冷却窗口分钟数；0 = 关闭冷却 */
  readonly minutes: number;
  /** 窗口内最大回复条数（>=1） */
  readonly maxReplies: number;
};

/** 运行时生效的群聊策略（机制参数，平台可执行） */
export type ResolvedGroupChatPolicy = {
  readonly policy: GroupChatPolicy;
  readonly cooldown: GroupCooldownPolicy;
  /** off 模式：该群完全静默（不建 Turn） */
  readonly off: boolean;
  /**
   * 对话线程 TTL（分钟）：@ 开线后，线程存活期内任何群成员的消息都算
   * 跟进（免 @ 建轮）；0 = 关闭线程（每条消息都要 @）。缺省 15。
   */
  readonly threadTtlMinutes: number;
};

/** 群聊对话线程缺省 TTL（分钟）：@ 开线后的免费跟进期。 */
export const DEFAULT_THREAD_TTL_MINUTES = 15;

/**
 * 从 Solution 扩展设置的原始 JSON 容错提取群聊策略。
 * 期望形状：{ groupChat: { mode, botNames, keywords, cooldownMinutes, maxRepliesPerCooldown, probability, threadTtlMinutes, groupOverrides } }
 * 缺失/畸形逐项回落默认（与今天行为一致）；本模块不含任何业务关键词。
 */
export function extractGroupChatSettings(raw: unknown): {
  global: ResolvedGroupChatPolicy;
  overrides: ReadonlyMap<string, ResolvedGroupChatPolicy>;
} {
  const global = extractOne(raw);
  const overrides = new Map<string, ResolvedGroupChatPolicy>();
  if (typeof raw === "object" && raw !== null) {
    const groupChat = (raw as Record<string, unknown>).groupChat;
    if (typeof groupChat === "object" && groupChat !== null) {
      const list = (groupChat as Record<string, unknown>).groupOverrides;
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item !== "object" || item === null) continue;
          const ref = (item as Record<string, unknown>).conversationRef;
          if (typeof ref !== "string" || !ref.trim()) continue;
          overrides.set(ref.trim(), extractOne(item));
        }
      }
    }
  }
  return { global, overrides };
}

function extractOne(raw: unknown): ResolvedGroupChatPolicy {
  const source =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const groupChat =
    typeof source.groupChat === "object" && source.groupChat !== null
      ? (source.groupChat as Record<string, unknown>)
      : typeof raw === "object" && raw !== null &&
          !("groupChat" in (raw as Record<string, unknown>)) &&
          "mode" in (raw as Record<string, unknown>)
        ? (raw as Record<string, unknown>)
        : {};
  const mode = groupChat.mode;
  const modeValue: GroupChatMode | null =
    mode === "mention_only" ||
    mode === "mention_or_keyword" ||
    mode === "accept_all" ||
    mode === "off"
      ? mode
      : null;
  const keywords = Array.isArray(groupChat.keywords)
    ? groupChat.keywords.filter(
        (word): word is string => typeof word === "string" && word.trim() !== "",
      )
    : [];
  const botNames = Array.isArray(groupChat.botNames)
    ? groupChat.botNames.filter(
        (word): word is string => typeof word === "string" && word.trim() !== "",
      )
    : [];
  const threadTtlMinutes =
    typeof groupChat.threadTtlMinutes === "number" &&
    Number.isFinite(groupChat.threadTtlMinutes) &&
    groupChat.threadTtlMinutes >= 0 &&
    groupChat.threadTtlMinutes <= 240
      ? Math.round(groupChat.threadTtlMinutes)
      : DEFAULT_THREAD_TTL_MINUTES;
  const cooldownMinutes =
    typeof groupChat.cooldownMinutes === "number" &&
    Number.isFinite(groupChat.cooldownMinutes) &&
    groupChat.cooldownMinutes >= 0 &&
    groupChat.cooldownMinutes <= 240
      ? Math.round(groupChat.cooldownMinutes)
      : 0;
  const maxReplies =
    typeof groupChat.maxRepliesPerCooldown === "number" &&
    Number.isFinite(groupChat.maxRepliesPerCooldown) &&
    groupChat.maxRepliesPerCooldown >= 1 &&
    groupChat.maxRepliesPerCooldown <= 100
      ? Math.round(groupChat.maxRepliesPerCooldown)
      : 2;
  const probability =
    typeof groupChat.probability === "number" &&
    Number.isFinite(groupChat.probability) &&
    groupChat.probability >= 0 &&
    groupChat.probability <= 1
      ? groupChat.probability
      : 0;
  // 未配置 mode → 完全回落默认策略（仅@，无线程），与既有行为逐字节一致
  if (modeValue === null) {
    return {
      policy: DEFAULT_GROUP_CHAT_POLICY,
      cooldown: { minutes: 0, maxReplies: 2 },
      off: false,
      threadTtlMinutes: 0,
    };
  }
  const off = modeValue === "off";
  const acceptAll = modeValue === "accept_all";
  return {
    policy: {
      acceptAll,
      replyWhenMentioned: modeValue === "mention_only" || modeValue === "mention_or_keyword",
      botNames,
      keywords,
      responseProbability: acceptAll ? probability : 0,
    },
    cooldown: { minutes: cooldownMinutes, maxReplies },
    off,
    threadTtlMinutes,
  };
}

/**
 * 解析某群生效的策略：群 override 优先于全局；都没有 → 默认（仅@）。
 * @param settings extractGroupChatSettings 的返回
 * @param conversationRef 通道会话 ref（如 12345@chatroom）
 */
export function resolveGroupChatPolicy(
  settings: ReturnType<typeof extractGroupChatSettings>,
  conversationRef: string,
): ResolvedGroupChatPolicy {
  return (
    settings.overrides.get(conversationRef.trim()) ?? settings.global
  );
}
