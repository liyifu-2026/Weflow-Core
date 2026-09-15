/**
 * Shared user-facing label mappings.
 *
 * Turns backend/system values into natural Chinese copy. Every mapping is
 * defensive: unknown values fall back to the raw value or a generic copy,
 * never an exception. Keep this as the single source for labels shared
 * across pages; page-local labels stay in their own components.
 */

// ---------- document / content states ----------

const STATE_LABELS: Record<string, string> = {
  completed: "已解析",
  ready: "就绪",
  pending: "等待解析",
  processing: "解析中",
  finalizing: "收尾中",
  failed: "解析失败",
  cancelled: "已停止",
  draft: "草稿",
  disabled: "已停用",
  enabled: "启用",
};

export function stateLabel(state: string | undefined | null): string {
  if (!state) return "—";
  return STATE_LABELS[state.toLowerCase()] ?? state;
}

// ---------- knowledge source types ----------

const SOURCE_LABELS: Record<string, string> = {
  web: "网页",
  file: "文件",
  manual: "在线文本",
  url: "URL",
  api: "API",
  browser_extension: "浏览器插件",
  feishu: "飞书",
  notion: "Notion",
  yuque: "语雀",
  wechat: "微信",
  wecom: "企业微信",
  dingtalk: "钉钉",
  slack: "Slack",
  im: "IM",
};

export function sourceTypeLabel(
  source: string | undefined | null,
): string {
  if (!source) return "文档";
  const lower = source.toLowerCase();
  return SOURCE_LABELS[lower] ?? lower;
}

// ---------- handoff / conversation facts ----------
// Core handoff briefing facts arrive as { label, value } where label is a
// machine key. Map known keys; unknown keys render the value only.

const FACT_KEY_LABELS: Record<string, string> = {
  product_version: "软件版本",
  error_code: "错误码",
  errorcode: "错误码",
  error_occurrence: "出现场景",
  device_model: "设备型号",
  order_id: "订单号",
  contact_phone: "联系电话",
  contact_email: "联系邮箱",
};

export function factLabel(fact: { label?: string; value?: string }): string {
  const key = String(fact.label ?? "").toLowerCase();
  const label = FACT_KEY_LABELS[key];
  if (label) return `${label} ${fact.value ?? ""}`.trim();
  return String(fact.value ?? "");
}

// ---------- handoff reason ----------
// Channel Host/Core may attach machine reasons like
// "agent_recommended: device_troubleshooting/handoff".

const REASON_PREFIX_LABELS: Record<string, string> = {
  agent_recommended: "Agent 建议人工处理",
  customer_requested: "客户要求人工处理",
  risk_escalated: "风险升级，需要人工处理",
  policy_triggered: "策略触发人工处理",
  repeated_failure: "多次尝试失败，转人工",
  knowledge_gap: "知识不足，需要人工处理",
  // Core 自动转人工的机器原因代码（历史数据已按代码持久化，展示时友好化）
  model_unavailable: "智能回复服务暂时不可用，已转交人工处理",
  policy_gate: "安全校验未通过，已转交人工处理",
  policy_gate_after_tool: "安全校验未通过，已转交人工处理",
  auto_send_disabled: "运营人员已关闭自动发送，已转交人工处理",
  tool_chain_limit: "自动处理步骤达到上限，已转交人工处理",
  agent_recommended_after_retrieval: "知识库信息不足，已转交人工处理",
};

export function reasonLabel(reason: string | undefined | null): string {
  if (!reason || !reason.trim()) return "";
  const trimmed = reason.trim();
  const prefix = trimmed.split(":")[0].trim().toLowerCase();
  const mapped = REASON_PREFIX_LABELS[prefix];
  if (mapped) return mapped;
  // Free-form reasons pass through; cap length.
  return trimmed.length > 42 ? `${trimmed.slice(0, 42)}…` : trimmed;
}

// ---------- audit event types ----------
// ⚠ 同步备忘：此映射需与 Core 各模块 audit 落库枚举保持一致。
// Core 新增 eventType 时必须在这里补一条，否则界面会漏出「执行了 <枚举名>」。
// 最近一次对齐：2026-09-05，对照 core/modules 全量 grep（subjectType 已全覆盖）。

const EVENT_LABELS: Record<string, string> = {
  // --- handoff（人工处理）---
  "handoff.resolved": "结束人工处理",
  "handoff.accepted": "接手处理",
  "handoff.created": "发起人工处理",
  "handoff.transferred": "转交会话",
  "handoff.routing_escalated": "路由升级转人工",
  escalated: "升级转人工",
  transferred: "转交会话",
  transfer_requested: "请求转接",
  claimed: "接手处理",
  finished: "结束处理",
  ownership_changed: "变更归属",
  routing_escalated: "路由升级转人工",
  // --- identity（账号/认证）---
  "identity.login_failed": "登录失败",
  // Core identity-service 实际落库枚举是 login_succeeded；login_success 兼容旧数据
  "identity.login_succeeded": "登录成功",
  "identity.login_success": "登录成功",
  "identity.logout": "退出登录",
  "identity.password_changed": "修改密码",
  "identity.password_reset": "重置密码",
  "identity.profile_updated": "更新资料",
  "identity.avatar_updated": "更新头像",
  "identity.sessions_revoked": "撤销会话",
  "identity.user_created": "创建账号",
  "identity.user_updated": "修改账号",
  // 旧版 user.* 枚举，兼容历史数据
  "user.created": "创建账号",
  "user.updated": "修改账号",
  "user.disabled": "禁用账号",
  "user.enabled": "启用账号",
  "user.password_reset": "重置密码",
  "user.sessions_revoked": "撤销会话",
  // --- agent（自动处理执行链）---
  execution_resumed: "恢复自动处理",
  ownership_checked: "认领权校验",
  triaged: "完成分诊",
  context_built: "构建会话上下文",
  policy_decided: "策略决策",
  model_reasoning: "模型推理",
  tool_completed: "工具执行完成",
  tool_checkpoint_persisted: "保存工具检查点",
  reply_persisted: "保存自动回复",
  validation_failed: "回复校验未通过",
  // --- conversations ---
  "conversation.manual_reply_created": "创建人工回复",
  // --- memory ---
  captured: "捕获记忆",
  created: "创建记忆",
  activated: "激活记忆",
  invalidated: "作废记忆",
  // --- collaboration ---
  queue_claimed: "认领协作任务",
  // --- knowledge / knora ---
  "knowledge.workspace_search": "检索知识",
  "knowledge.evidence_viewed": "查看回答依据",
  "knowledge.evidence_tray_updated": "更新回答依据",
  "knowledge.workspace_chat": "知识对话",
  "knowledge.thread_created": "创建知识线程",
  "knowledge.feedback_recorded": "记录知识反馈",
  "knowledge.provider_mutated": "变更知识提供方",
  "knowledge.client_draft_generated": "生成客户草稿",
  "knowledge.client_retrieval": "客户侧知识检索",
  "knora.account_bootstrap": "知识库账号初始化",
  "knora.session_exchanged": "知识库会话交换",
  // --- assets ---
  "asset.deleted": "删除素材",
  "asset.renamed": "重命名素材",
  // --- contacts ---
  "contact_profile.updated": "更新客户资料",
  // --- operator（系统管理）---
  "operator.model_registry_updated": "更新模型注册",
  "operator.model_registry_deleted": "删除模型注册",
  "operator.model_settings_updated": "更新模型设置",
  "operator.model_slot_bound": "绑定模型槽位",
  "operator.runtime_settings_updated": "更新运行时设置",
  "operator.runtime_settings_rolled_back": "回滚运行时设置",
};

export function eventTypeLabel(eventType: string | undefined | null): string {
  if (!eventType) return "执行了操作";
  return EVENT_LABELS[eventType.toLowerCase()] ?? `执行了 ${eventType}`;
}

// ---------- audit subject types ----------
// 与 Core 各模块 audit 落库枚举对齐（session/user/message/...）

const SUBJECT_LABELS: Record<string, string> = {
  asset: "素材",
  collaboration_request: "协作请求",
  contact_profile: "客户资料",
  conversation: "会话",
  handoff_event: "人工处理事件",
  knowledge_chat: "知识对话",
  knowledge_draft: "知识草稿",
  knowledge_feedback: "知识反馈",
  knowledge_provider: "知识提供方",
  knowledge_retrieval: "知识检索",
  knowledge_search: "知识搜索",
  knowledge_thread: "知识线程",
  memory: "记忆",
  message: "消息",
  model_registry: "模型注册",
  model_settings: "模型设置",
  model_slot: "模型槽位",
  runtime_settings: "运行时设置",
  session: "登录会话",
  user: "用户账号",
  user_login: "用户登录",
};

export function subjectTypeLabel(subjectType: string | undefined | null): string {
  if (!subjectType) return "—";
  return SUBJECT_LABELS[subjectType.toLowerCase()] ?? subjectType;
}

// ---------- health ----------

export type HealthLabel = {
  text: string;
  tone: "good" | "warn" | "bad" | "inactive";
};

export function healthLabel(value: string | undefined | null): HealthLabel {
  switch (value?.toLowerCase()) {
    case "healthy":
      return { text: "正常", tone: "good" };
    case "degraded":
      return { text: "降级", tone: "warn" };
    case "unreachable":
      return { text: "无法连接", tone: "bad" };
    case "not_monitored":
      return { text: "未监测", tone: "inactive" };
    default:
      return { text: value || "未监测", tone: "inactive" };
  }
}

// ---------- conversation contact display name ----------
// 三处页面曾各自实现且签名分化（any/可选参数），统一为单一实现。

/**
 * 会话联系人显示名（与 Mobile 同一优先链，跨端渲染一致）：
 * 共享别名 > 渠道显示名 > 渠道备注 > 渠道昵称 > 渠道 ID。
 * 渠道显示名是 Channel Host 计算的展示名（备注 > 昵称 > ID），优先于原始备注/昵称。
 */
export function contactDisplayName(item?: {
  contact?: Record<string, any>;
}): string {
  const contact = item?.contact;
  return (
    contact?.sharedAlias ||
    contact?.channelDisplayName ||
    contact?.channelRemark ||
    contact?.channelNickname ||
    contact?.channelContactId ||
    "未知联系人"
  );
}

// ---------- agent (operator) display name ----------

/**
 * 客服（操作员）显示名：名片显示名 > 登录账号。
 * 与 Mobile 的会话展示、Core 的 handoff-assignees 投影一致。
 */
export function agentDisplayName(
  user?: {
    displayName?: string | null;
    username?: string;
  } | null,
): string {
  return user?.displayName || user?.username || "值班客服";
}

