<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { statusTone } from "../components/status-tone";
import { healthLabel } from "../labels";
import WfIcon from "../components/WfIcon.vue";
import PageHeader from "../components/PageHeader.vue";
import StatusStrip from "../components/StatusStrip.vue";

type Installation = {
  solutionId: string;
  version: string;
  desiredState: string;
  observedState: string;
  healthState: string;
  updatedAt: string;
};

type DashboardCard = {
  id: string;
  title: string;
  position: { x: number; y: number; w: number; h: number };
  refreshInterval?: number;
  data: { value?: number; unit?: string; observedState?: string; healthState?: string } | null;
  status: "ready" | "empty";
  error: string | null;
};

type SystemStatus = {
  checkedAt: string;
  services: Array<{
    key: string;
    name: string;
    configuration: { status: string; summary: string };
    health: { status: string; summary: string };
    details?: Array<{ key: string; name: string; status: string; summary: string }>;
  }>;
};

const router = useRouter();
const loading = ref(true);
const error = ref("");
const installations = ref<Installation[]>([]);
const dashboardCards = ref<DashboardCard[]>([]);
const dashboardLoading = ref(false);
const dashboardError = ref("");
const systemStatus = ref<SystemStatus | null>(null);
let refreshTimer: ReturnType<typeof setInterval> | null = null;
const layoutKey = "wf-dashboard-layout";
const savedLayout = ref<string[]>(
  JSON.parse(localStorage.getItem(layoutKey) || "[]"),
);
const dragOverId = ref<string | null>(null);

const orderedCards = computed(() => {
  const byId = new Map(dashboardCards.value.map((card) => [card.id, card]));
  const ordered = savedLayout.value
    .map((id) => byId.get(id))
    .filter((card): card is DashboardCard => Boolean(card));
  const rest = dashboardCards.value.filter(
    (card) => !savedLayout.value.includes(card.id),
  );
  return [...ordered, ...rest];
});
function persistLayout() {
  localStorage.setItem(layoutKey, JSON.stringify(savedLayout.value));
}
function onCardDragStart(event: DragEvent, id: string) {
  if (event.dataTransfer) event.dataTransfer.setData("text/plain", id);
}
function onCardDragOver(event: DragEvent, id: string) {
  event.preventDefault();
  dragOverId.value = id;
}
function onCardDrop(event: DragEvent, targetId: string) {
  dragOverId.value = null;
  const draggedId = event.dataTransfer?.getData("text/plain");
  if (!draggedId || draggedId === targetId) return;
  const list = orderedCards.value.map((card) => card.id);
  const from = list.indexOf(draggedId);
  const to = list.indexOf(targetId);
  if (from < 0 || to < 0) return;
  list.splice(from, 1);
  list.splice(to, 0, draggedId);
  savedLayout.value = list;
  persistLayout();
}
function moveCard(id: string, direction: -1 | 1) {
  const list = orderedCards.value.map((card) => card.id);
  const from = list.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= list.length) return;
  list.splice(from, 1);
  list.splice(to, 0, id);
  savedLayout.value = list;
  persistLayout();
}

const totalCount = computed(() => installations.value.length);
const activeCount = computed(
  () => installations.value.filter((item) => item.observedState === "active").length,
);
const degradedCount = computed(() =>
  installations.value.filter((item) =>
    ["degraded", "failed"].includes(item.healthState),
  ).length,
);
const lastUpdated = computed(() => {
  const values = installations.value
    .map((item) => new Date(item.updatedAt).getTime())
    .filter((value) => Number.isFinite(value));
  return values.length ? new Date(Math.max(...values)).toLocaleString() : "—";
});

const systemAttentionServices = computed(() =>
  (systemStatus.value?.services ?? []).filter((service) =>
    ["degraded", "unreachable"].includes(service.health.status),
  ),
);

const systemOverallLabel = computed(() => {
  const states = systemStatus.value?.services.map((item) => item.health.status) ?? [];
  if (states.includes("unreachable")) return "不可达";
  if (states.includes("degraded")) return "降级";
  if (states.includes("healthy")) return "健康";
  return "未监测";
});

const systemTone = computed(() => {
  const states = systemStatus.value?.services.map((item) => item.health.status) ?? [];
  if (states.includes("unreachable")) return "bad";
  if (states.includes("degraded")) return "warn";
  if (states.includes("healthy")) return "good";
  return "inactive";
});

function stateLabel(value: string | null | undefined): string {
  if (!value) return "—";
  const map: Record<string, string> = {
    absent: "未安装",
    installing: "安装中",
    installed: "已安装",
    configured: "已配置",
    activating: "激活中",
    active: "已激活",
    degraded: "降级",
    rolling_back: "回滚中",
    uninstalling: "卸载中",
    removed: "已卸载",
    failed: "失败",
    disabled: "停用",
    unknown: "未知",
  };
  return map[value] ?? value;
}

async function load() {
  loading.value = true;
  error.value = "";
  dashboardLoading.value = true;
  try {
    const [home, cards] = await Promise.all([
      api<{ solutions: Installation[]; systemStatus: SystemStatus }>(
        "/api/v1/admin/console/home",
      ),
      api<{ cards: DashboardCard[] }>("/api/v1/admin/dashboard/cards"),
    ]);
    installations.value = home.solutions ?? [];
    systemStatus.value = home.systemStatus;
    dashboardCards.value = cards.cards ?? [];
    dashboardError.value = "";
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
    dashboardLoading.value = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    void load();
  }, 30_000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

onMounted(() => {
  void load();
  startAutoRefresh();
});
onBeforeUnmount(stopAutoRefresh);
</script>

<template>
  <div class="wf-page wf-overview">
    <PageHeader title="平台总览" />

    <div v-if="error" class="wf-error" role="alert">
      <span>{{ error }}</span>
      <button class="wf-button compact" @click="load">重试</button>
    </div>

    <!-- 系统信号条：整机状态一条主线 -->
    <StatusStrip
      :tone="systemTone"
      label="系统状态"
      :value="loading ? '检测中…' : systemOverallLabel"
      :meta="
        systemStatus
          ? `检查于 ${new Date(systemStatus.checkedAt).toLocaleString()}`
          : '正在读取最新状态'
      "
      :chips="systemAttentionServices.map((service) => service.name)"
      to="/system/status"
    />

    <!-- 仪表盘读数：方案生命周期 -->
    <section class="wf-panel wf-instruments-panel">
      <div class="wf-instruments">
        <article class="wf-instrument">
          <span class="wf-instrument-label">已接入方案</span>
          <strong class="wf-instrument-value">{{ totalCount }}</strong>
          <span class="wf-instrument-note">全部已安装方案</span>
        </article>
        <article class="wf-instrument">
          <span class="wf-instrument-label">运行中</span>
          <strong class="wf-instrument-value good">{{ activeCount }}</strong>
          <span class="wf-instrument-note">已激活方案</span>
        </article>
        <article class="wf-instrument" :class="{ alert: degradedCount > 0 }">
          <span class="wf-instrument-label">异常方案</span>
          <strong class="wf-instrument-value" :class="{ bad: degradedCount > 0, good: degradedCount === 0 }">{{ degradedCount }}</strong>
          <span class="wf-instrument-note">降级或失败</span>
        </article>
        <article class="wf-instrument">
          <span class="wf-instrument-label">最近更新</span>
          <strong class="wf-instrument-value small">{{ lastUpdated }}</strong>
        </article>
      </div>
    </section>

    <!-- 业务信息 -->
    <section class="wf-panel">
      <div class="wf-panel-head">
        <div>
          <h2>业务信息</h2>
          <span class="wf-panel-caption">由业务方案提供</span>
        </div>
        <span v-if="dashboardError" class="wf-error wf-error-inline">{{ dashboardError }}</span>
      </div>

      <div v-if="dashboardLoading" class="wf-panel-body">
        <span class="wf-skeleton">正在加载业务数据</span>
      </div>
      <div v-else-if="dashboardCards.length === 0" class="wf-panel-body">
        <div class="wf-empty wf-empty-compact">
          <div>
            <strong>暂无业务信息</strong>
            <p>安装并激活声明了 dashboardContributions 的业务方案后，这里会显示相关信息。</p>
          </div>
        </div>
      </div>
      <div v-else class="wf-info-list">
        <div v-for="card in orderedCards" :key="card.id" class="wf-info-row">
          <div class="wf-info-label">
            <strong>{{ card.title }}</strong>
            <span class="wf-muted">{{ card.id }}</span>
          </div>
          <div class="wf-info-value">
            <template v-if="card.status === 'ready' && card.data">
              <template v-if="card.data.value !== undefined">
                <strong>{{ card.data.value }}</strong>
                <span class="wf-muted">{{ card.data.unit ?? "" }}</span>
              </template>
              <template v-else-if="card.data.observedState">
                <strong>{{ stateLabel(card.data.observedState) }}</strong>
                <span class="wf-muted">{{ card.data.healthState ? healthLabel(card.data.healthState).text : "" }}</span>
              </template>
              <span v-else>—</span>
            </template>
            <span v-else-if="card.error">{{ card.error }}</span>
            <span v-else class="wf-muted">暂无数据</span>
          </div>
        </div>
      </div>
    </section>

    <!-- 已接入业务方案 -->
    <section class="wf-panel wf-solutions-panel">
      <div class="wf-panel-head">
        <div>
          <h2>已接入业务方案</h2>
          <span class="wf-panel-caption">安装、激活与健康状态</span>
        </div>
        <router-link class="wf-link" :to="{ path: '/platform/solutions' }">
          进入方案管理 →
        </router-link>
      </div>
      <div class="wf-table-wrap">
        <table class="wf-table">
          <thead>
            <tr>
              <th>方案</th>
              <th>版本</th>
              <th>期望状态</th>
              <th>实际状态</th>
              <th>健康</th>
              <th>更新时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td colspan="6">
                <span class="wf-skeleton">正在读取方案状态</span>
              </td>
            </tr>
            <tr
              v-for="item in installations"
              :key="item.solutionId"
              class="wf-solution-row"
              @click="router.push('/platform/solutions')"
            >
              <td><strong class="wf-mono">{{ item.solutionId }}</strong></td>
              <td class="wf-mono">{{ item.version }}</td>
              <td>
                <i class="wf-health-mark" :class="statusTone(item.desiredState)"></i>
                {{ stateLabel(item.desiredState) }}
              </td>
              <td>
                <i class="wf-health-mark" :class="statusTone(item.observedState)"></i>
                {{ stateLabel(item.observedState) }}
              </td>
              <td>
                <i class="wf-health-mark" :class="statusTone(item.healthState)"></i>
                {{ healthLabel(item.healthState).text }}
              </td>
              <td class="wf-muted">{{ new Date(item.updatedAt).toLocaleString() }}</td>
            </tr>
            <tr v-if="!loading && installations.length === 0">
              <td colspan="6" class="wf-empty">还没有安装任何业务方案</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-overview {
  max-width: 1240px;
}
.wf-overview .wf-panel {
  margin-bottom: 16px;
}
.wf-overview .wf-panel:last-child {
  margin-bottom: 0;
}

/* ---------- 仪表盘读数：信息条 ---------- */
.wf-instruments-panel {
  margin-bottom: 16px;
}
.wf-instruments {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.wf-instrument {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 16px 18px;
  border-right: 1px solid var(--wf-border);
  background: transparent;
}
.wf-instrument:last-child {
  border-right: 0;
}
.wf-instrument-label {
  color: var(--wf-text-secondary);
  font-size: 12px;
  font-weight: 600;
}
.wf-instrument-value {
  margin: 8px 0 4px;
  font-size: 30px;
  line-height: 1;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}
.wf-instrument-value.good {
  color: var(--wf-success);
}
.wf-instrument-value.bad {
  color: var(--wf-danger);
}
.wf-instrument-value.small {
  font-size: 16px;
  line-height: 1.4;
  letter-spacing: -0.01em;
}
.wf-instrument-note {
  color: var(--wf-text-muted);
  font-size: 11px;
}
.wf-instrument.alert {
  background: var(--wf-surface-soft);
}

/* ---------- 业务卡片 ---------- */
.wf-panel-caption {
  color: var(--wf-text-muted);
  font-size: 12px;
  font-weight: 400;
  margin-left: 8px;
}
.wf-error-inline {
  margin: 0;
}
.wf-dash-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.wf-dash-card {
  min-height: 96px;
  padding: 14px 16px;
  border: 1px solid var(--wf-border);
  border-radius: 10px;
  background: var(--wf-surface-elevated);
  box-shadow: none;
  transition:
    border-color var(--wf-motion-fast) var(--wf-ease-out),
    box-shadow var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-dash-card.drop-target {
  border-color: var(--wf-primary);
  box-shadow: 0 0 0 3px var(--wf-primary-soft);
}
.wf-dash-card header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}
.wf-drag-handle {
  display: grid;
  place-items: center;
  color: var(--wf-text-muted);
  cursor: grab;
  user-select: none;
}
.wf-dash-title {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wf-dash-title strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-dash-title small {
  color: var(--wf-text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-dash-order {
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-dash-card:hover .wf-dash-order,
.wf-dash-card:focus-within .wf-dash-order {
  opacity: 1;
}
.wf-dash-order .wf-icon-button {
  width: 26px;
  height: 26px;
}
.wf-dash-order .flip {
  transform: rotate(180deg);
}
.wf-dash-body {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.wf-dash-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.wf-dash-unit {
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.wf-dash-state {
  font-size: 18px;
  font-weight: 700;
}
.wf-dash-error {
  color: var(--wf-danger);
  font-size: 13px;
}
.wf-dash-empty {
  color: var(--wf-text-muted);
  font-size: 13px;
}
.wf-dash-card.empty {
  background: var(--wf-surface-soft);
  border-style: dashed;
}

@media (max-width: 1200px) {
  .wf-instruments {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* 业务信息列表 */
.wf-info-list {
  display: flex;
  flex-direction: column;
}
.wf-info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--wf-border);
}
.wf-info-row:last-child {
  border-bottom: 0;
}
.wf-info-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wf-info-label strong {
  font-size: 14px;
}
.wf-info-label span {
  font-size: 12px;
}
.wf-info-value {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: none;
}
.wf-info-value strong {
  font-size: 20px;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
</style>
