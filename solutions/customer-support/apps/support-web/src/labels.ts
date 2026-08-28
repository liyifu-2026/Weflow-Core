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

// ---------- knowledge infrastructure (P4 read-only views) ----------

const INFRA_STATE_LABELS: Record<string, string> = {
  active: "启用",
  inactive: "停用",
  ready: "就绪",
  syncing: "同步中",
  synced: "已同步",
  pending: "等待中",
  failed: "失败",
  idle: "空闲",
  error: "异常",
};

const INFRA_SOURCE_LABELS: Record<string, string> = {
  env: "环境内置",
  remote: "远程",
  local: "本地",
  manual: "手动",
  builtin: "内置",
};

const INFRA_ENGINE_LABELS: Record<string, string> = {
  postgres: "PostgreSQL",
  pgvector: "PGVector",
  milvus: "Milvus",
  chroma: "Chroma",
  qdrant: "Qdrant",
  elasticsearch: "Elasticsearch",
  opensearch: "OpenSearch",
};

const INFRA_PROVIDER_LABELS: Record<string, string> = {
  local: "本地文件系统",
  s3: "S3 兼容",
  minio: "MinIO",
  oss: "阿里云 OSS",
  cos: "腾讯云 COS",
  azure: "Azure Blob",
  gcs: "Google Cloud Storage",
};

export function infraStateLabel(value: string | undefined | null): string {
  if (!value) return "—";
  return INFRA_STATE_LABELS[value.toLowerCase()] ?? value;
}

export function infraSourceLabel(value: string | undefined | null): string {
  if (!value) return "—";
  return INFRA_SOURCE_LABELS[value.toLowerCase()] ?? value;
}

export function infraEngineLabel(value: string | undefined | null): string {
  if (!value) return "—";
  return INFRA_ENGINE_LABELS[value.toLowerCase()] ?? value;
}

export function infraProviderLabel(value: string | undefined | null): string {
  if (!value) return "—";
  return INFRA_PROVIDER_LABELS[value.toLowerCase()] ?? value;
}

const MODEL_TYPE_LABELS: Record<string, string> = {
  knowledgeqa: "问答",
  embedding: "向量",
  rerank: "重排",
  chat: "对话",
  asr: "语音识别",
  tts: "语音合成",
  image: "图像",
  multimodal: "多模态",
  llm: "大语言模型",
};

export function modelTypeLabel(value: string | undefined | null): string {
  if (!value) return "—";
  return MODEL_TYPE_LABELS[value.toLowerCase()] ?? value;
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

const EVENT_LABELS: Record<string, string> = {
  "handoff.resolved": "结束人工处理",
  "handoff.accepted": "接手处理",
  "handoff.created": "发起人工处理",
  "handoff.transferred": "转交会话",
  "identity.login_failed": "登录失败",
  "identity.login_success": "登录成功",
  "identity.password_changed": "修改密码",
  "knowledge.workspace_search": "检索知识",
  "knowledge.evidence_viewed": "查看回答依据",
  "user.created": "创建账号",
  "user.updated": "修改账号",
  "user.disabled": "禁用账号",
  "user.enabled": "启用账号",
  "user.password_reset": "重置密码",
  "user.sessions_revoked": "撤销会话",
};

export function eventTypeLabel(eventType: string | undefined | null): string {
  if (!eventType) return "执行了操作";
  return EVENT_LABELS[eventType.toLowerCase()] ?? `执行了 ${eventType}`;
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

// ---------- time ----------

export function humanDuration(
  minutes: number,
): string {
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  }
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
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

