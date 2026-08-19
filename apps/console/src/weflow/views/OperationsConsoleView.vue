<script setup lang="ts">
import { confirmDialog } from "../components/confirm-dialog";
/**
 * Weflow 运行控制台（Operator Control Plane）
 *
 * 分层：
 * L1 运行状态 + 高影响控制 + 当前异常（默认第一屏）
 * L2 能力详情 / 影响说明 / 模型 / 最近配置修改
 * L3 管理员诊断：技术数字与原始信息
 *
 * 只展示与发出操作请求，绝不推断系统状态：
 * 每次加载/操作后一律以 Server2 响应真值重绘。
 * 所有修改写审计，支持一键回滚到上一份配置。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import WfSwitch from "../components/WfSwitch.vue";

type Settings = {
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  knowledgeEnabled: boolean;
  memoryEnabled: boolean;
  visionEnabled: boolean;
  textModel: string;
  visionModel: string;
};
type OperatorStatus = {
  channelOnline: boolean;
  agentEnabled: boolean;
  autoSendEnabled: boolean;
  queuedTurnCount: number;
  runningTurnCount: number;
  pendingHandoffCount: number;
  lastCompletedTurnAt: string | null;
};
type Change = { key: string; previous: string; next: string };
type AuditEvent = {
  auditId: string;
  actorUsername: string | null;
  eventType: string;
  subjectId: string | null;
  metadata: Record<string, string>;
  createdAt: string;
};
type RuntimeConsoleResponse = {
  settings: Settings;
  allowlists: { text: string[]; vision: string[] };
  status: OperatorStatus;
  audit: AuditEvent[];
};

const loading = ref(true);
const error = ref("");
const busy = ref(false);
const notice = ref("");
const noticeKind = ref<"ok" | "err">("ok");
const settings = ref<Settings | null>(null);
const allowlists = ref<{ text: string[]; vision: string[] }>({
  text: [],
  vision: [],
});
const status = ref<OperatorStatus | null>(null);
const audit = ref<AuditEvent[]>([]);
const detailOpen = ref(false);
const diagnosticsOpen = ref(false);

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const agentRunning = computed(() => settings.value?.agentEnabled === true);
const channelOnline = computed(() => status.value?.channelOnline === true);

const coreCapabilities = computed(() => {
  if (!settings.value) return [];
  return [
    {
      key: "autoSend",
      label: "自动回复",
      enabled: settings.value.autoSendEnabled,
      impact: "关闭后 AI 生成内容绝不自动发给客户（Kill Switch）",
    },
    {
      key: "knowledge",
      label: "知识",
      enabled: settings.value.knowledgeEnabled,
      impact: "关闭后 Agent 不检索知识库，普通回复不受影响",
    },
    {
      key: "memory",
      label: "记忆",
      enabled: settings.value.memoryEnabled,
      impact: "关闭后既不写入也不召回客户记忆",
    },
    {
      key: "vision",
      label: "图片理解",
      enabled: settings.value.visionEnabled,
      impact: "关闭后图片消息保存但直接转人工处理",
    },
  ];
});

// L1 异常：只列真实可证明的问题
const activeIssues = computed(() => {
  const issues: Array<{ label: string; detail: string }> = [];
  if (!settings.value || !status.value) return issues;
  if (!channelOnline.value)
    issues.push({ label: "Channel Host", detail: "当前离线，消息可能无法收发" });
  if (!settings.value.knowledgeEnabled)
    issues.push({ label: "知识", detail: "当前关闭，Agent 将无法引用知识回答" });
  if (!settings.value.visionEnabled)
    issues.push({ label: "图片理解", detail: "当前关闭，图片消息将直接转人工" });
  if (status.value.queuedTurnCount > 20)
    issues.push({
      label: "积压 Turn",
      detail: `${status.value.queuedTurnCount} 个任务排队，处理可能延迟`,
    });
  return issues;
});

function flash(message: string, kind: "ok" | "err" = "ok") {
  notice.value = message;
  noticeKind.value = kind;
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const data = await api<RuntimeConsoleResponse>("/api/v1/admin/runtime-console");
    settings.value = data.settings;
    allowlists.value = data.allowlists;
    status.value = data.status;
    audit.value = data.audit;
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "加载失败，请稍后重试";
  } finally {
    loading.value = false;
  }
}

async function save(patch: Partial<Settings>) {
  const previous = settings.value ? { ...settings.value } : null;
  if (settings.value) Object.assign(settings.value, patch);
  busy.value = true;
  try {
    const result = await api<{ settings: Settings; changed: Change[] }>(
      "/api/v1/admin/runtime-settings",
      { method: "PATCH", body: JSON.stringify(patch) },
    );
    settings.value = result.settings;
    flash(
      result.changed.length > 0
        ? `已更新：${result.changed
            .map((item) => `${item.key} ${item.previous} → ${item.next}`)
            .join("，")}`
        : "没有变化",
    );
    await refresh();
  } catch (cause) {
    if (previous) settings.value = previous;
    flash(cause instanceof Error ? cause.message : "保存失败", "err");
  } finally {
    busy.value = false;
  }
}

async function rollback() {
  busy.value = true;
  try {
    const result = await api<{ settings: Settings; rolledBack: Change[] }>(
      "/api/v1/admin/runtime-settings/rollback",
      { method: "POST" },
    );
    settings.value = result.settings;
    flash(
      result.rolledBack.length > 0
        ? `已回滚：${result.rolledBack
            .map((item) => `${item.key} → ${item.next}`)
            .join("，")}`
        : "没有可回滚的修改",
    );
    await refresh();
  } catch (cause) {
    flash(cause instanceof Error ? cause.message : "回滚失败", "err");
  } finally {
    busy.value = false;
  }
}

// 高影响操作：执行前必须说明影响
async function confirmImpact(message: string): Promise<boolean> {
  return confirmDialog(`${message}\n\n该操作会写入审计。`);
}

async function toggleAgent(next: boolean) {
  if (!settings.value || next === settings.value.agentEnabled) return;
  const impact = next
    ? "开启 Agent 总开关？开启后 AI 将重新参与客户会话处理。"
    : "关闭 Agent 总开关？关闭后 AI 不再参与处理，新消息自动进入人工路径。";
  if (!(await confirmImpact(impact))) return;
  void save({ agentEnabled: next });
}

async function toggleAutoSend(next: boolean) {
  if (!settings.value || next === settings.value.autoSendEnabled) return;
  const impact = next
    ? "恢复 AI 自动回复？恢复后 AI 生成内容将按当前策略自动发送。"
    : "暂停 AI 自动回复？暂停后 AI 绝不自动向客户发送任何内容（Kill Switch）。";
  if (!(await confirmImpact(impact))) return;
  void save({ autoSendEnabled: next });
}

async function toggle(
  field: "knowledgeEnabled" | "memoryEnabled" | "visionEnabled",
  next: boolean,
) {
  if (!settings.value || next === settings.value[field]) return;
  // 能力开关影响 Agent 行为，与高影响操作一致：先确认再执行。
  const label =
    field === "knowledgeEnabled"
      ? "知识检索"
      : field === "memoryEnabled"
        ? "记忆"
        : "图片理解";
  if (
    !await confirmDialog(
      `${next ? "开启" : "关闭"}「${label}」能力？

改动会立即生效并写入审计。`,
    )
  )
    return;
  void save({ [field]: next });
}

function connectStream() {
  if (eventSource) return;
  const source = new EventSource("/api/v1/admin/stream");
  eventSource = source;
  source.addEventListener("runtime", (event) => {
    try {
      const data = JSON.parse((event as MessageEvent).data) as RuntimeConsoleResponse;
      if (data.settings) settings.value = data.settings;
      if (data.allowlists) allowlists.value = data.allowlists;
      if (data.status) status.value = data.status;
      if (data.audit) audit.value = data.audit;
    } catch {
      // 忽略单次解析失败，等待下一条快照
    }
  });
  source.onerror = () => {
    source.close();
    eventSource = null;
    reconnectTimer = setTimeout(connectStream, 5000);
  };
}

function disconnectStream() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  eventSource?.close();
  eventSource = null;
}

onMounted(() => {
  void refresh();
  connectStream();
});
onBeforeUnmount(disconnectStream);
</script>

<template>
  <div class="wf-page wf-page-narrow">
    <header class="wf-page-head">
      <h1>运行</h1>
      <button class="wf-button compact" :disabled="loading" @click="refresh">
        刷新
      </button>
    </header>

    <p v-if="error" class="wf-error">{{ error }}</p>
    <p
      v-if="notice"
      class="wf-notice"
      :class="noticeKind === 'err' ? 'wf-error' : ''"
    >
      {{ notice }}
    </p>

    <div v-if="loading" class="wf-skeleton">
      <div class="wf-skeleton-title"></div>
      <div class="wf-skeleton-line"></div>
    </div>

    <template v-else-if="settings && status">
      <!-- L1: 运行状态 -->
      <section class="wf-section-block">
        <div class="wf-run-head">
          <div>
            <span class="wf-run-label">Agent</span>
            <strong :class="agentRunning ? 'wf-run-good' : 'wf-run-bad'">{{
              agentRunning ? "运行中" : "已停止"
            }}</strong>
          </div>
          <span class="wf-run-meta">{{
            channelOnline ? "Channel Host 在线" : "Channel Host 离线"
          }}</span>
        </div>

        <div class="wf-run-capabilities">
          <span
            v-for="cap in coreCapabilities"
            :key="cap.key"
            class="wf-run-cap"
            :class="{ off: !cap.enabled }"
          >
            {{ cap.label }} {{ cap.enabled ? "开启" : "关闭" }}
          </span>
        </div>
      </section>

      <!-- L1: 当前异常 -->
      <section class="wf-section-block">
        <template v-if="activeIssues.length">
          <div class="wf-run-issue">
            <span class="wf-run-issue-label">需要注意</span>
            <div
              v-for="issue in activeIssues"
              :key="issue.label"
              class="wf-run-issue-row"
            >
              <strong>{{ issue.label }}</strong>
              <span>{{ issue.detail }}</span>
            </div>
          </div>
        </template>
        <p v-else class="wf-run-quiet">
          当前没有需要处理的运行异常。
        </p>
        <button
          class="wf-link wf-link-button"
          @click="detailOpen = !detailOpen"
        >
          {{ detailOpen ? "收起运行详情" : "查看运行详情 →" }}
        </button>
      </section>

      <!-- Kill Switch：高影响控制，与普通设置视觉区分 -->
      <section class="wf-kill-switch">
        <div class="wf-kill-head">
          <strong>Agent 总开关</strong>
          <span class="wf-muted">高影响控制</span>
        </div>
        <p class="wf-kill-impact">
          关闭后 AI 不再参与处理，新消息自动进入人工路径；恢复需要手动开启。
        </p>
        <div class="wf-actions">
          <div class="wf-switch-row">
            <WfSwitch
              :model-value="agentRunning"
              :disabled="busy"
              label="Agent 总开关"
              @change="toggleAgent"
            />
            <span>{{ agentRunning ? "运行中" : "已停止" }}</span>
          </div>
          <div class="wf-switch-row">
            <WfSwitch
              :model-value="settings.autoSendEnabled"
              :disabled="busy"
              label="AI 自动回复"
              @change="toggleAutoSend"
            />
            <span>{{
              settings.autoSendEnabled ? "自动回复已开启" : "自动回复已暂停"
            }}</span>
          </div>
          <button class="wf-button" :disabled="busy" @click="rollback">
            恢复上一份配置
          </button>
        </div>
      </section>

      <!-- L2: 能力详情 -->
      <section v-if="detailOpen" class="wf-section-block">
        <div class="wf-section-heading">
          <h2>能力详情</h2>
        </div>
        <div class="wf-config-list">
          <div
            v-for="cap in coreCapabilities"
            :key="cap.key"
            class="wf-config-row"
          >
            <div>
              <strong>{{ cap.label }}</strong>
              <span class="wf-muted">{{ cap.impact }}</span>
            </div>
            <WfSwitch
              :model-value="cap.enabled"
              :disabled="busy"
              :label="cap.label"
              @change="
                toggle(
                  cap.key as
                    | 'knowledgeEnabled'
                    | 'memoryEnabled'
                    | 'visionEnabled',
                  $event,
                )
              "
            />
          </div>
          <div class="wf-config-row">
            <div>
              <strong>主模型</strong>
              <span class="wf-muted">文本对话模型</span>
            </div>
            <select
              class="wf-select wf-model-select"
              :value="settings.textModel"
              :disabled="busy"
              @change="save({ textModel: ($event.target as HTMLSelectElement).value })"
            >
              <option
                v-for="model in allowlists.text"
                :key="model"
                :value="model"
              >
                {{ model }}
              </option>
            </select>
          </div>
          <div class="wf-config-row">
            <div>
              <strong>视觉模型</strong>
              <span class="wf-muted">图片理解模型</span>
            </div>
            <select
              class="wf-select wf-model-select"
              :value="settings.visionModel"
              :disabled="busy"
              @change="save({ visionModel: ($event.target as HTMLSelectElement).value })"
            >
              <option
                v-for="model in allowlists.vision"
                :key="model"
                :value="model"
              >
                {{ model }}
              </option>
            </select>
          </div>
        </div>

        <div class="wf-section-heading">
          <h2>最近配置修改</h2>
        </div>
        <div v-if="audit.length === 0" class="wf-empty wf-empty-compact">
          暂无配置修改记录
        </div>
        <div v-else class="wf-audit-stream">
          <div
            v-for="event in audit.slice(0, 10)"
            :key="event.auditId"
            class="wf-audit-event"
          >
            <span class="wf-audit-time">{{
              new Date(event.createdAt).toLocaleString()
            }}</span>
            <span class="wf-muted">{{ event.actorUsername ?? "系统" }}</span>
            <span class="wf-muted">
              {{ event.metadata?.previousValue ?? "—" }} →
              {{ event.metadata?.nextValue ?? "—" }}
            </span>
          </div>
        </div>
      </section>

      <!-- L3: 管理员诊断 -->
      <section class="wf-section-block">
        <button
          class="wf-link wf-link-button"
          @click="diagnosticsOpen = !diagnosticsOpen"
        >
          {{ diagnosticsOpen ? "收起诊断" : "诊断详情 →" }}
        </button>
        <div v-if="diagnosticsOpen" class="wf-config-list">
          <div class="wf-config-row">
            <div>
              <strong>积压 Turn</strong>
              <span class="wf-muted">排队中的 Agent 任务</span>
            </div>
            <span class="wf-mono">{{ status.queuedTurnCount }}</span>
          </div>
          <div class="wf-config-row">
            <div>
              <strong>运行中 Turn</strong>
              <span class="wf-muted">正在执行的任务</span>
            </div>
            <span class="wf-mono">{{ status.runningTurnCount }}</span>
          </div>
          <div class="wf-config-row">
            <div>
              <strong>待人工处理</strong>
              <span class="wf-muted">当前待人工会话</span>
            </div>
            <span class="wf-mono">{{ status.pendingHandoffCount }}</span>
          </div>
          <div class="wf-config-row">
            <div>
              <strong>最近成功处理</strong>
              <span class="wf-muted">最近一次完成时间</span>
            </div>
            <span class="wf-mono">
              {{
                status.lastCompletedTurnAt
                  ? new Date(status.lastCompletedTurnAt).toLocaleString()
                  : "—"
              }}
            </span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wf-switch-row {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface);
  color: var(--wf-text-secondary);
  font-size: 13px;
  white-space: nowrap;
}
.wf-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
</style>
