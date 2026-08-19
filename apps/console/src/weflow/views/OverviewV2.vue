<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api";
import { statusTone } from "../components/status-tone";
import { healthLabel } from "../labels";
import WfIcon from "../components/WfIcon.vue";

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
function onCardDrop(event: DragEvent, targetId: string) {
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
  <div class="wf-page wf-action-center">
    <header class="wf-page-head">
      <div>
        <h1>平台总览</h1>
        <p class="wf-page-subtitle">查看已接入业务套装的生命状态与安装情况</p>
      </div>
      <button class="wf-button" title="刷新" @click="load">
        <WfIcon name="refresh" :size="15" />
        刷新
      </button>
    </header>

    <section class="wf-stat-grid" aria-label="方案概览">
      <div class="wf-stat-card">
        <WfIcon name="engine" :size="20" />
        <span class="wf-stat-value">{{ totalCount }}</span>
        <span class="wf-stat-label">已接入方案</span>
      </div>
      <div class="wf-stat-card">
        <WfIcon name="check" :size="20" />
        <span class="wf-stat-value">{{ activeCount }}</span>
        <span class="wf-stat-label">运行中</span>
      </div>
      <div
        class="wf-stat-card"
        :class="{ danger: degradedCount > 0 }"
      >
        <WfIcon name="alert" :size="20" />
        <span class="wf-stat-value">{{ degradedCount }}</span>
        <span class="wf-stat-label">异常方案</span>
      </div>
      <div class="wf-stat-card">
        <WfIcon name="runtime" :size="20" />
        <span class="wf-stat-value wf-stat-value-small">{{ lastUpdated }}</span>
        <span class="wf-stat-label">最近更新</span>
      </div>
    </section>

    <section class="wf-panel wf-system-summary">
      <div class="wf-action-heading">
        <h2>系统状态</h2>
        <router-link class="wf-link" :to="{ path: '/system/status' }">
          查看详情 →
        </router-link>
      </div>
      <div v-if="systemAttentionServices.length" class="wf-system-issues">
        <div
          v-for="service in systemAttentionServices"
          :key="service.key"
          class="wf-system-issue"
        >
          <strong>{{ service.name }}</strong>
          <span>{{ service.health.summary }}</span>
          <span class="wf-status" :class="statusTone(service.health.status)">
            {{ healthLabel(service.health.status).text }}
          </span>
        </div>
      </div>
      <p v-else class="wf-run-quiet">系统服务正常 · {{ systemOverallLabel }}</p>
    </section>

    <section class="wf-dashboard-section">
      <div class="wf-action-heading">
        <h2>业务状态卡片</h2>
        <span v-if="dashboardError" class="wf-error">{{ dashboardError }}</span>
      </div>
      <div v-if="dashboardLoading" class="wf-dashboard-grid">
        <div v-for="i in 3" :key="i" class="wf-dashboard-card">
          <span class="wf-skeleton">正在加载业务数据</span>
        </div>
      </div>
      <div v-else-if="dashboardCards.length === 0" class="wf-empty">
        <div>
          <strong>暂无业务卡片</strong>
          <p>安装并激活声明了 dashboardContributions 的业务方案后，这里会显示状态卡片。</p>
        </div>
      </div>
      <div v-else class="wf-dashboard-grid">
        <article
          v-for="card in orderedCards"
          :key="card.id"
          class="wf-dashboard-card"
          :class="{ empty: card.status === 'empty' }"
          draggable="true"
          @dragstart="onCardDragStart($event, card.id)"
          @dragover.prevent
          @drop="onCardDrop($event, card.id)"
        >
          <header>
            <span class="wf-drag-handle" title="拖拽排序">⠿</span>
            <strong>{{ card.title }}</strong>
            <span class="wf-muted">{{ card.id }}</span>
          </header>
          <div v-if="card.status === 'ready' && card.data" class="wf-dashboard-body">
            <template v-if="card.data.value !== undefined">
              <span class="wf-dashboard-value">{{ card.data.value }}</span>
              <span class="wf-dashboard-unit">{{ card.data.unit ?? "" }}</span>
            </template>
            <template v-else-if="card.data.observedState">
              <span class="wf-dashboard-state">{{ stateLabel(card.data.observedState) }}</span>
              <span class="wf-dashboard-unit">{{
                card.data.healthState
                  ? healthLabel(card.data.healthState).text
                  : ""
              }}</span>
            </template>
            <span v-else>—</span>
          </div>
          <div v-else-if="card.error" class="wf-dashboard-error">
            {{ card.error }}
          </div>
          <div v-else class="wf-dashboard-empty">服务暂不可用或暂无数据</div>
        </article>
      </div>
    </section>

    <section class="wf-action-section">
      <div class="wf-action-heading">
        <h2>已接入业务方案</h2>
        <router-link class="wf-link" :to="{ path: '/platform/solutions' }">
          进入方案管理 →
        </router-link>
      </div>

      <div v-if="error" class="wf-error">
        <span>{{ error }}</span>
        <button class="wf-button compact" @click="load">重试</button>
      </div>

      <div class="wf-panel" style="margin-top: 12px">
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
                <td>{{ item.solutionId }}</td>
                <td>{{ item.version }}</td>
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
                <td>{{ new Date(item.updatedAt).toLocaleString() }}</td>
              </tr>
              <tr v-if="!loading && installations.length === 0">
                <td colspan="6" class="wf-empty">还没有安装任何业务方案</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-page-subtitle {
  margin: 2px 0 0;
  color: var(--wf-text-muted);
  font-size: var(--wf-type-secondary);
}
.wf-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--wf-space-3);
  margin: var(--wf-space-4) 0 var(--wf-space-3);
}
.wf-stat-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: var(--wf-surface);
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  color: var(--wf-text);
  text-decoration: none;
  transition:
    border-color var(--wf-motion-fast) var(--wf-ease-out),
    box-shadow var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-stat-card svg {
  color: var(--wf-primary);
}
.wf-stat-card.danger svg {
  color: var(--wf-danger);
}
.wf-stat-value {
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}
.wf-stat-value-small {
  font-size: 14px;
  font-weight: 650;
  line-height: 1.2;
}
.wf-stat-label {
  color: var(--wf-text-secondary);
  font-size: var(--wf-type-secondary);
}
.wf-action-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wf-action-heading h2 {
  margin: 0;
}
.wf-solution-row {
  cursor: pointer;
}
.wf-solution-row:hover td {
  background: var(--wf-surface-hover);
}
.wf-dashboard-section {
  margin-top: 16px;
}
.wf-dashboard-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.wf-dashboard-card {
  padding: 14px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface);
  cursor: grab;
}
.wf-dashboard-card:active {
  cursor: grabbing;
}
.wf-dashboard-card header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}
.wf-dashboard-card header strong {
  font-size: 14px;
}
.wf-drag-handle {
  color: var(--wf-text-muted);
  cursor: grab;
  font-size: 14px;
  line-height: 1;
  user-select: none;
}
.wf-dashboard-card header span {
  font-size: 11px;
  color: var(--wf-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-dashboard-body {
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.wf-dashboard-value {
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
}
.wf-dashboard-unit {
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.wf-dashboard-state {
  font-size: 18px;
  font-weight: 700;
}
.wf-dashboard-error {
  color: var(--wf-danger);
  font-size: 13px;
}
.wf-dashboard-empty {
  color: var(--wf-text-muted);
  font-size: 13px;
}
.wf-dashboard-card.empty {
  background: var(--wf-surface-soft);
}
.wf-system-summary {
  margin-top: 16px;
  padding: 14px 16px;
}
.wf-system-issues {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.wf-system-issue {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface-soft);
}
.wf-system-issue strong {
  min-width: 120px;
}
.wf-system-issue span:not(.wf-status) {
  flex: 1;
  color: var(--wf-text-secondary);
}
.wf-run-quiet {
  margin: 12px 0 0;
  color: var(--wf-text-secondary);
}
@media (max-width: 1200px) {
  .wf-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
