<script setup lang="ts">
/**
 * Weflow 运行控制台（Operator Control Plane）
 *
 * 分层：
 * L1 运行状态 + 高影响控制 + 当前异常（默认第一屏）
 * L2 能力详情 / 影响说明 / 模型 / 最近配置修改
 * L3 管理员诊断：技术数字与原始信息
 *
 * 只展示与发出操作请求，绝不推断系统状态：
 * 每次加载/操作后一律以 Server 响应真值重绘。
 * 所有修改写审计，支持一键回滚到上一份配置。
 *
 * 本视图从 Core Console 迁移至 Solution 层，
 * 通过 ExtensionHost bridge.fetch 调用平台 API。
 * 类型定义来自 @weflow/contracts 的 runtime-console.ts。
 */
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../api";
import WfSwitch from "../components/WfSwitch.vue";
import PageHeader from "../components/PageHeader.vue";
import { confirmDialog } from "../confirm-dialog";
import type {
  RuntimeConsoleResponse,
  RuntimeSettings,
  OperatorStatus,
  SettingsChange,
  AuditEvent,
} from "../types";

const loading = ref(true);
const error = ref("");
const busy = ref(false);
const notice = ref("");
const noticeKind = ref<"ok" | "err">("ok");
const settings = ref<RuntimeSettings | null>(null);
const allowlists = ref<{ text: string[]; vision: string[] }>({
  text: [],
  vision: [],
});
const status = ref<OperatorStatus | null>(null);
const audit = ref<AuditEvent[]>([]);
const activeView = ref<"overview" | "capabilities" | "diagnostics">("overview");

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

function showView(view: "overview" | "capabilities" | "diagnostics") {
  activeView.value = view;
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

async function save(patch: Partial<RuntimeSettings>) {
  const previous = settings.value ? { ...settings.value } : null;
  if (settings.value) Object.assign(settings.value, patch);
  busy.value = true;
  try {
    const result = await api<{ settings: RuntimeSettings; changed: SettingsChange[] }>(
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
    const result = await api<{ settings: RuntimeSettings; rolledBack: SettingsChange[] }>(
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
  <div class="wf-page">
    <PageHeader title="运行" />

    <p v-if="error" class="wf-error" role="alert">{{ error }}</p>
    <p
      v-if="notice"
      class="wf-notice" role="status"
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
      <section class="wf-panel wf-run-overview-panel">
        <div class="wf-panel-head">
          <div>
            <h2>运行状态</h2>
            <span class="wf-panel-caption">实时快照</span>
          </div>
          <span class="wf-status" :class="channelOnline ? 'good' : 'bad'">
            {{ channelOnline ? "Channel Host 在线" : "Channel Host 离线" }}
          </span>
        </div>
        <div class="wf-panel-body">
          <div class="wf-run-head">
            <div>
              <span class="wf-run-label">Agent</span>
              <strong :class="agentRunning ? 'wf-run-good' : 'wf-run-bad'">
                {{ agentRunning ? "运行中" : "已停止" }}
              </strong>
            </div>
          </div>
          <div class="wf-run-capabilities">
            <span
              v-for="cap in coreCapabilities"
              :key="cap.key"
              class="wf-run-cap"
              :class="{ off: !cap.enabled }"
            >
              {{ cap.label }} · {{ cap.enabled ? "开启" : "关闭" }}
            </span>
          </div>
        </div>
      </section>

      <!-- L1: 当前异常 -->
      <section class="wf-panel wf-run-issues-panel">
        <div class="wf-panel-head">
          <h2>需要注意</h2>
          <span class="wf-panel-caption">{{ activeIssues.length }} 项</span>
        </div>
        <div class="wf-panel-body">
          <template v-if="activeIssues.length">
            <div
              v-for="issue in activeIssues"
              :key="issue.label"
              class="wf-run-issue-row"
            >
              <strong>{{ issue.label }}</strong>
              <span>{{ issue.detail }}</span>
            </div>
          </template>
          <p v-else class="wf-run-quiet">当前没有需要处理的运行异常。</p>
        </div>
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
            <span>
              {{ settings.autoSendEnabled ? "自动回复已开启" : "自动回复已暂停" }}
            </span>
          </div>
          <button class="wf-button" :disabled="busy" @click="rollback">
            恢复上一份配置
          </button>
        </div>
      </section>

      <nav class="wf-run-tabs" aria-label="运行详情视图">
        <button
          class="wf-run-tab"
          :class="{ active: activeView === 'capabilities' }"
          @click="showView('capabilities')"
        >
          能力详情
        </button>
        <button
          class="wf-run-tab"
          :class="{ active: activeView === 'diagnostics' }"
          @click="showView('diagnostics')"
        >
          诊断详情
        </button>
      </nav>

      <!-- L2: 能力详情 -->
      <section v-if="activeView === 'capabilities'" class="wf-panel wf-run-detail-panel">
        <div class="wf-panel-head">
          <h2>能力详情</h2>
        </div>
        <div class="wf-panel-body">
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

          <div class="wf-section-subhead">
            <h3>最近配置修改</h3>
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
              <span class="wf-audit-time">
                {{ new Date(event.createdAt).toLocaleString() }}
              </span>
              <span class="wf-muted">{{ event.actorUsername ?? "系统" }}</span>
              <span class="wf-muted">
                {{ event.metadata?.previousValue ?? "—" }} →
                {{ event.metadata?.nextValue ?? "—" }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- L3: 管理员诊断 -->
      <section v-if="activeView === 'diagnostics'" class="wf-panel wf-run-detail-panel">
        <div class="wf-panel-head">
          <h2>诊断详情</h2>
        </div>
        <div class="wf-panel-body">
          <div class="wf-config-list">
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
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.wf-run-overview-panel,
.wf-run-issues-panel {
  margin-bottom: 16px;
}
.wf-run-overview-panel .wf-run-head {
  padding: 2px 0 14px;
}
.wf-run-capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.wf-run-cap {
  background: transparent;
  color: var(--wf-text-secondary);
  font-size: 13px;
  font-weight: 500;
}
.wf-run-cap.off {
  color: var(--wf-text-muted);
}
.wf-run-issues-panel .wf-run-issue-row {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--wf-border);
  font-size: 13px;
}
.wf-run-issues-panel .wf-run-issue-row:last-child {
  border-bottom: 0;
}
.wf-run-issues-panel .wf-run-issue-row strong {
  min-width: 96px;
}
.wf-run-issues-panel .wf-run-issue-row span {
  color: var(--wf-text-secondary);
}
.wf-run-issues-panel .wf-run-quiet {
  margin: 0;
}
.wf-run-detail-panel {
  margin-bottom: 16px;
}
.wf-section-subhead {
  margin: 22px 0 10px;
  padding-top: 16px;
  border-top: 1px solid var(--wf-border);
}
.wf-section-subhead h3 {
  margin: 0;
  font-size: 14px;
}
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
.wf-run-tabs {
  display: flex;
  gap: 6px;
  margin: 4px 0 14px;
  flex-wrap: wrap;
}
.wf-run-tab {
  padding: 7px 14px;
  border: 1px solid var(--wf-border);
  border-radius: 999px;
  background: var(--wf-surface);
  color: var(--wf-text-secondary);
  font-weight: 600;
  cursor: pointer;
}
.wf-run-tab:hover {
  border-color: var(--wf-border-strong);
  color: var(--wf-text);
}
.wf-run-tab.active {
  background: var(--wf-surface-soft);
  border-color: var(--wf-border-strong);
  color: var(--wf-text);
}
</style>
