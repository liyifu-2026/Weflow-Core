<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import PageHeader from "../components/PageHeader.vue";
import StatusStrip from "../components/StatusStrip.vue";
import { statusTone } from "../components/status-tone";
import { healthLabel } from "../labels";

type Service = {
  key: string;
  name: string;
  configuration: { status: "configured" | "not_configured"; summary: string };
  health: {
    status: "healthy" | "degraded" | "unreachable" | "not_monitored";
    summary: string;
  };
  details?: Array<{
    key: string;
    name: string;
    status: string;
    summary: string;
  }>;
};
type StatusResponse = { checkedAt: string; services: Service[] };
type SolutionHealthCheck = {
  id: string;
  name: string;
  type: string;
  target: string;
  port?: number;
  status: "healthy" | "unreachable" | "not_configured";
  summary: string;
  checkedAt: string;
};
type SolutionHealth = {
  solutionId: string;
  version: string;
  observedState: string;
  checks: SolutionHealthCheck[];
};

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();
const status = ref<StatusResponse | null>(null);
const turns = ref<any[]>([]);
const solutionHealth = ref<SolutionHealth[]>([]);
const solutionHealthLoading = ref(false);
const solutionHealthError = ref("");
const loading = ref(true);
const error = ref("");
const selectedService = ref(
  typeof route.query.service === "string" ? route.query.service : "",
);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const attentionServices = computed(() =>
  status.value?.services.filter((item) =>
    ["degraded", "unreachable"].includes(item.health.status),
  ) ?? [],
);
const otherServices = computed(() =>
  status.value?.services.filter(
    (item) => !["degraded", "unreachable"].includes(item.health.status),
  ) ?? [],
);
const serviceGroups = computed(() => {
  const groups: Array<{ label: string; services: Service[] }> = [];
  if (attentionServices.value.length)
    groups.push({ label: "需要注意", services: attentionServices.value });
  if (otherServices.value.length)
    groups.push({ label: "其他服务", services: otherServices.value });
  return groups;
});

const overall = computed(() => {
  const states = status.value?.services.map((item) => item.health.status) || [];
  if (states.includes("unreachable")) return "unreachable";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("healthy")) return "healthy";
  return "not_monitored";
});
const overallText = computed(() => {
  const map: Record<string, string> = {
    unreachable: "不可达",
    degraded: "降级",
    healthy: "健康",
    not_monitored: "未监测",
  };
  return map[overall.value];
});

function healthText(value: Service["health"]["status"]) {
  return healthLabel(value).text;
}
function serviceHealthText(service: Service) {
  if (service.configuration.status !== "configured") return "未配置";
  return healthLabel(service.health.status).text;
}
function detailStatusLabel(value: string) {
  const map: Record<string, string> = {
    ready: "就绪",
    healthy: "健康",
    degraded: "降级",
    unreachable: "不可达",
    not_configured: "未配置",
    not_monitored: "未监测",
    failed: "失败",
    pending: "等待中",
    processing: "处理中",
    queued: "排队中",
    running: "运行中",
    succeeded: "成功",
    unknown: "未知",
  };
  return map[value] ?? value;
}
function solutionHealthLabel(value: string) {
  const map: Record<string, string> = {
    healthy: "正常",
    unreachable: "不可达",
    not_configured: "未配置",
  };
  return map[value] ?? value;
}
async function loadSolutionHealth() {
  if (!auth.isAdmin) return;
  solutionHealthLoading.value = true;
  solutionHealthError.value = "";
  try {
    const data = await api<{ solutions: SolutionHealth[] }>(
      "/api/v1/admin/solutions/health",
    );
    solutionHealth.value = data.solutions ?? [];
  } catch (reason) {
    solutionHealthError.value =
      reason instanceof Error ? reason.message : "业务健康加载失败";
  } finally {
    solutionHealthLoading.value = false;
  }
}
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const tasks: Promise<unknown>[] = [
      api<StatusResponse>("/api/v1/system/status").then(
        (value) => (status.value = value),
      ),
    ];
    if (auth.isAdmin) {
      tasks.push(
        api<{ turns: any[] }>("/api/v1/admin/agent-turns?limit=30")
          .then((value) => (turns.value = value.turns))
          .catch(() => undefined),
      );
      tasks.push(loadSolutionHealth());
    }
    await Promise.all(tasks);
    await nextTick();
    if (selectedService.value)
      document
        .getElementById(`service-${selectedService.value}`)
        ?.scrollIntoView({ block: "center" });
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "系统状态加载失败";
  } finally {
    loading.value = false;
  }
}
async function selectService(key: string) {
  selectedService.value = key;
  await router.replace({ query: { ...route.query, service: key } });
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
  <div class="wf-page">
    <PageHeader title="系统状态" />

    <div v-if="error" class="wf-error" role="alert">
      <span>{{ error }}</span>
      <button class="wf-button compact" @click="load">重新加载</button>
    </div>

    <StatusStrip
      :tone="statusTone(overall)"
      label="整体"
      :value="overallText"
      :meta="status ? `检查于 ${new Date(status.checkedAt).toLocaleString()}` : '读取中…'"
      :chips="attentionServices.map((service) => service.name)"
      quiet="所有服务正常"
    />

    <template v-if="loading">
      <div class="wf-service-list">
        <div v-for="i in 4" :key="i" class="wf-service-row">
          <span class="wf-skeleton">正在读取服务状态</span>
        </div>
      </div>
    </template>

    <template v-else>
      <section
        v-for="group in serviceGroups"
        :key="group.label"
        class="wf-service-group"
      >
        <div class="wf-service-group-label">{{ group.label }}</div>
        <div class="wf-service-list">
          <article
            v-for="service in group.services"
            :id="`service-${service.key}`"
            :key="service.key"
            class="wf-service-row"
            :class="{
              selected: selectedService === service.key,
              'wf-target-highlight': selectedService === service.key,
            }"
            @click="selectService(service.key)"
          >
            <div class="wf-service-name">
              <strong>{{ service.name }}</strong>
              <small>{{ service.health.summary }}</small>
            </div>
            <div class="wf-service-field">
              <label>Configuration</label>
              <span class="wf-status neutral">
                {{ service.configuration.status === "configured" ? "已配置" : "未配置" }}
              </span>
            </div>
            <div class="wf-service-field">
              <label>Health</label>
              <span class="wf-status" :class="statusTone(service.health.status)">
                {{ serviceHealthText(service) }}
              </span>
            </div>
            <WfIcon
              name="chevron"
              :size="16"
              class="wf-service-chevron"
              :class="{ rotated: selectedService === service.key }"
            />
            <div v-if="selectedService === service.key" class="wf-service-details">
              <p v-if="service.health.status === 'not_monitored'">
                该服务当前没有实时业务探测。请求加载失败、尚未加载和“未监测”是不同状态。
              </p>
              <div
                v-for="item in service.details || []"
                :key="item.key"
                class="wf-detail-line"
              >
                <strong>{{ item.name }}</strong>
                <span>{{ item.summary }}</span>
                <span class="wf-status" :class="statusTone(item.status)">
                  {{ detailStatusLabel(item.status) }}
                </span>
              </div>
            </div>
          </article>
        </div>
      </section>

      <div v-if="serviceGroups.length === 0" class="wf-empty">
        暂无可展示的服务
      </div>
    </template>

    <section v-if="auth.isAdmin" class="wf-section-block wf-solutions-health">
      <div class="wf-section-heading">
        <h2>业务方案健康</h2>
      </div>
      <div v-if="solutionHealthError" class="wf-error" role="alert">
        {{ solutionHealthError }}
      </div>
      <div v-if="solutionHealthLoading" class="wf-muted">
        正在检查业务服务…
      </div>
      <div v-else-if="solutionHealth.length === 0" class="wf-empty wf-empty-compact">
        暂无可检测的业务方案
      </div>
      <div v-else class="wf-solution-health-list">
        <article
          v-for="solution in solutionHealth"
          :key="solution.solutionId"
          class="wf-panel wf-solution-health"
        >
          <div class="wf-solution-health-head">
            <strong class="wf-mono">{{ solution.solutionId }}</strong>
            <span class="wf-muted">v{{ solution.version }} · {{ solution.observedState }}</span>
          </div>
          <div class="wf-solution-health-checks">
            <div
              v-for="check in solution.checks"
              :key="check.id"
              class="wf-solution-health-check"
            >
              <div>
                <strong>{{ check.name }}</strong>
                <span class="wf-muted">
                  {{ check.type }}<template v-if="check.port"> :{{ check.port }}</template>
                </span>
              </div>
              <span class="wf-status" :class="statusTone(check.status)">
                {{ solutionHealthLabel(check.status) }}
              </span>
              <span class="wf-muted">{{ check.summary }}</span>
            </div>
            <div v-if="solution.checks.length === 0" class="wf-muted">
              该方案未声明业务健康检查
            </div>
          </div>
        </article>
      </div>
    </section>

    <details v-if="auth.isAdmin" class="wf-admin-diagnostics">
      <summary>诊断详情 · 最近 Agent Turn</summary>
      <div class="wf-table-wrap">
        <table class="wf-table">
          <thead>
            <tr>
              <th>Turn</th>
              <th>会话</th>
              <th>状态</th>
              <th>模型</th>
              <th>错误</th>
              <th>创建时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="turn in turns" :key="turn.turnId">
              <td class="wf-mono">{{ turn.turnId.slice(0, 22) }}…</td>
              <td class="wf-mono">{{ turn.conversationId.slice(0, 18) }}…</td>
              <td>
                <span class="wf-status" :class="statusTone(turn.status)">
                  {{ detailStatusLabel(turn.status) }}
                </span>
              </td>
              <td>{{ turn.model || "—" }}</td>
              <td>{{ turn.errorCode || "—" }}</td>
              <td class="wf-muted">{{ new Date(turn.createdAt).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </div>
</template>

<style scoped>
.wf-service-group {
  margin-bottom: 16px;
}
.wf-service-group-label {
  margin: 0 0 8px;
  color: var(--wf-text-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.04em;
}
.wf-service-list {
  background: var(--wf-surface);
  border: 1px solid var(--wf-border);
  border-radius: 12px;
  box-shadow: none;
  overflow: hidden;
}
.wf-service-row {
  position: relative;
  display: grid;
  grid-template-columns: minmax(240px, 1fr) 150px 160px 28px;
  align-items: center;
  gap: 16px;
  min-height: 68px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--wf-border);
  cursor: pointer;
  transition: background var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-service-row:last-child {
  border-bottom: 0;
}
.wf-service-row:hover,
.wf-service-row.selected {
  background: var(--wf-surface-hover);
}
.wf-service-name,
.wf-service-field {
  display: grid;
  gap: 3px;
  min-width: 0;
}
.wf-service-name strong {
  font-size: 14px;
}
.wf-service-row label,
.wf-service-row small {
  color: var(--wf-text-muted);
  font-size: 12px;
}
.wf-service-chevron {
  color: var(--wf-text-muted);
  transition: transform var(--wf-motion-fast) var(--wf-ease-out);
}
.wf-service-chevron.rotated {
  transform: rotate(90deg);
  color: var(--wf-primary);
}
.wf-service-details {
  grid-column: 1 / -1;
  padding: 12px 0 4px;
  border-top: 1px solid var(--wf-border);
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.wf-detail-line {
  display: grid;
  grid-template-columns: 180px minmax(0, 1fr) 110px;
  gap: 12px;
  align-items: center;
  min-height: 42px;
  border-top: 1px solid var(--wf-border);
}
.wf-solutions-health {
  margin-top: 24px;
}
.wf-solution-health-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 12px;
}
.wf-solution-health {
  padding: 16px 18px;
}
.wf-solution-health-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.wf-solution-health-checks {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.wf-solution-health-check {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--wf-border);
  border-radius: 9px;
  background: var(--wf-surface-soft);
}
.wf-solution-health-check > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wf-admin-diagnostics {
  margin-top: 24px;
}
.wf-admin-diagnostics > summary {
  padding: 8px 0;
  color: var(--wf-primary);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}
@media (max-width: 960px) {
  .wf-service-row {
    grid-template-columns: minmax(200px, 1fr) 28px;
  }
  .wf-service-field {
    display: none;
  }
  .wf-detail-line {
    grid-template-columns: 1fr;
    gap: 4px;
    padding: 8px 0;
  }
}
</style>
