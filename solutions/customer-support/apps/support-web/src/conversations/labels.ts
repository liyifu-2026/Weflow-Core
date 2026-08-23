const HANDOFF_STATUS_LABELS: Record<string, string> = {
  pending: "待认领",
  transfer_pending: "待接手",
  in_progress: "人工处理中",
  resolved: "已结束",
  HANDOFF_PENDING: "待认领",
  TRANSFER_PENDING: "待接手",
  HUMAN_ACTIVE: "人工处理中",
  HUMAN_FINISHED: "已结束",
};

export function handoffStatusLabel(status: string | null | undefined): string {
  if (!status) return "Agent 自动处理";
  return HANDOFF_STATUS_LABELS[status] ?? status;
}

const MEMORY_STATUS_LABELS: Record<string, string> = {
  candidate: "候选",
  active: "已激活",
  superseded: "已取代",
  invalidated: "已失效",
};

export function memoryStatusLabel(status: string | null | undefined): string {
  if (!status) return "—";
  return MEMORY_STATUS_LABELS[status] ?? status;
}

const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "事实",
  preference: "偏好",
  relationship: "关系",
};

export function memoryKindLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  return MEMORY_KIND_LABELS[kind] ?? kind;
}

const MEMORY_TONES: Record<string, string> = {
  candidate: "warn",
  active: "good",
  superseded: "neutral",
  invalidated: "inactive",
};

export function memoryTone(status: string | null | undefined): string {
  if (!status) return "neutral";
  return MEMORY_TONES[status] ?? status;
}

const HANDOFF_RESULT_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "resolved_by_human", label: "已由人工解决" },
  { value: "answered_question", label: "已回答问题" },
  { value: "information_collected", label: "已收集信息" },
  { value: "customer_no_response", label: "客户无响应" },
  { value: "other", label: "其他" },
];

export function handoffResultOptions() {
  return HANDOFF_RESULT_OPTIONS;
}
