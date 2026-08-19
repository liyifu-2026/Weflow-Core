<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
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

const auth = useWeflowAuthStore();
const route = useRoute();
const router = useRouter();
const status = ref<StatusResponse | null>(null);
const turns = ref<any[]>([]);
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
const overall = computed(() => {
  const states = status.value?.services.map((item) => item.health.status) || [];
  if (states.includes("unreachable")) return "unreachable";
  if (states.includes("degraded")) return "degraded";
  if (states.includes("healthy")) return "healthy";
  return "not_monitored";
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
async function load() {
  loading.value = true;
  error.value = "";
  try {
    const tasks: Promise<unknown>[] = [
      api<StatusResponse>("/api/v1/system/status").then(
        (value) => (status.value = value),
      ),
    ];
    if (auth.isAdmin)
      tasks.push(
        api<{ turns: any[] }>("/api/v1/admin/agent-turns?limit=30")
          .then((value) => (turns.value = value.turns))
          .catch(() => undefined),
      );
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
    <header class="wf-page-head">
      <h1>系统状态</h1>
      <button class="wf-button compact" :disabled="loading" @click="load">
        <WfIcon name="refresh" :size="15" />重新检查
      </button>
    </header>
    <div v-if="error" class="wf-error">
      <span>{{ error }}</span
      ><button class="wf-button compact" @click="load">重新加载</button>
    </div>

    <section class="wf-system-overall">
      <span class="wf-eyebrow">整体</span>
      <strong
        ><i class="wf-health-mark" :class="statusTone(overall)"></i
        >{{ healthText(overall) }}</strong
      >
      <small v-if="status"
        >检查于 {{ new Date(status.checkedAt).toLocaleString() }}</small
      >
    </section>

    <template v-if="loading">
      <div v-for="i in 4" :key="i" class="wf-service-list">
        <span class="wf-skeleton">正在读取服务状态</span>
      </div>
    </template>
    <template v-else>
      <template v-if="attentionServices.length">
        <div class="wf-service-group-label">需要注意</div>
        <div class="wf-service-list">
          <article
            v-for="service in attentionServices"
            :key="service.key"
            :id="`service-${service.key}`"
            class="wf-service-row"
            :class="{
              selected: selectedService === service.key,
              'wf-target-highlight': selectedService === service.key,
            }"
            @click="selectService(service.key)"
          >
            <div>
              <strong>{{ service.name }}</strong
              ><small>{{ service.health.summary }}</small>
            </div>
            <div>
              <label>Configuration</label
              ><span class="wf-status neutral">{{
                service.configuration.status === "configured"
                  ? "已配置"
                  : "未配置"
              }}</span>
            </div>
            <div>
              <label>Health</label
              ><span class="wf-status" :class="statusTone(service.health.status)">{{
                serviceHealthText(service)
              }}</span>
            </div>
            <button
              class="wf-icon-button"
              :aria-label="`查看 ${service.name} 详情`"
            >
              <WfIcon
                name="chevron"
                :size="16"
                :class="{ rotated: selectedService === service.key }"
              />
            </button>
            <div v-if="selectedService === service.key" class="wf-service-details">
              <p v-if="service.health.status === 'not_monitored'">
                该服务当前没有实时业务探测。请求加载失败、尚未加载和“未监测”是不同状态。
              </p>
              <div
                v-for="item in service.details || []"
                :key="item.key"
                class="wf-detail-line"
              >
                <strong>{{ item.name }}</strong
                ><span>{{ item.summary }}</span
                ><span class="wf-status" :class="statusTone(item.status)">{{
                  detailStatusLabel(item.status)
                }}</span>
              </div>
            </div>
          </article>
        </div>
        <div class="wf-service-group-label">其他服务</div>
        <div class="wf-service-list">
          <article
            v-for="service in otherServices"
            :key="service.key"
            :id="`service-${service.key}`"
            class="wf-service-row"
            :class="{
              selected: selectedService === service.key,
              'wf-target-highlight': selectedService === service.key,
            }"
            @click="selectService(service.key)"
          >
            <div>
              <strong>{{ service.name }}</strong
              ><small>{{ service.health.summary }}</small>
            </div>
            <div>
              <label>Configuration</label
              ><span class="wf-status neutral">{{
                service.configuration.status === "configured"
                  ? "已配置"
                  : "未配置"
              }}</span>
            </div>
            <div>
              <label>Health</label
              ><span class="wf-status" :class="statusTone(service.health.status)">{{
                serviceHealthText(service)
              }}</span>
            </div>
            <button
              class="wf-icon-button"
              :aria-label="`查看 ${service.name} 详情`"
            >
              <WfIcon
                name="chevron"
                :size="16"
                :class="{ rotated: selectedService === service.key }"
              />
            </button>
            <div v-if="selectedService === service.key" class="wf-service-details">
              <p v-if="service.health.status === 'not_monitored'">
                该服务当前没有实时业务探测。请求加载失败、尚未加载和“未监测”是不同状态。
              </p>
              <div
                v-for="item in service.details || []"
                :key="item.key"
                class="wf-detail-line"
              >
                <strong>{{ item.name }}</strong
                ><span>{{ item.summary }}</span
                ><span class="wf-status" :class="statusTone(item.status)">{{
                  detailStatusLabel(item.status)
                }}</span>
              </div>
            </div>
          </article>
        </div>
      </template>
      <div v-else class="wf-service-list">
        <article
          v-for="service in status?.services || []"
          :key="service.key"
          :id="`service-${service.key}`"
          class="wf-service-row"
          :class="{
            selected: selectedService === service.key,
            'wf-target-highlight': selectedService === service.key,
          }"
          @click="selectService(service.key)"
        >
          <div>
            <strong>{{ service.name }}</strong
            ><small>{{ service.health.summary }}</small>
          </div>
          <div>
            <label>Configuration</label
            ><span class="wf-status neutral">{{
              service.configuration.status === "configured" ? "已配置" : "未配置"
            }}</span>
          </div>
          <div>
            <label>Health</label
            ><span class="wf-status" :class="statusTone(service.health.status)">{{
              serviceHealthText(service)
            }}</span>
          </div>
          <button
            class="wf-icon-button"
            :aria-label="`查看 ${service.name} 详情`"
          >
            <WfIcon
              name="chevron"
              :size="16"
              :class="{ rotated: selectedService === service.key }"
            />
          </button>
          <div v-if="selectedService === service.key" class="wf-service-details">
            <p v-if="service.health.status === 'not_monitored'">
              该服务当前没有实时业务探测。请求加载失败、尚未加载和“未监测”是不同状态。
            </p>
            <div
              v-for="item in service.details || []"
              :key="item.key"
              class="wf-detail-line"
            >
              <strong>{{ item.name }}</strong
              ><span>{{ item.summary }}</span
              ><span class="wf-status" :class="statusTone(item.status)">{{
                item.status
              }}</span>
            </div>
          </div>
        </article>
      </div>
    </template>

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
              <td>
                <span class="wf-mono">{{ turn.conversationId.slice(0, 18) }}…</span>
              </td>
              <td>
                <span class="wf-status" :class="statusTone(turn.status)">{{
                  turn.status
                }}</span>
              </td>
              <td>{{ turn.model || "—" }}</td>
              <td>{{ turn.errorCode || "—" }}</td>
              <td>{{ new Date(turn.createdAt).toLocaleString() }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>

    <section class="wf-section-block" style="margin-top: 12px">
      <div class="wf-section-heading">
        <h2>代理安全边界</h2>
      </div>
      <ul
        style="
          margin: 0;
          padding-left: 18px;
          line-height: 2;
          color: var(--wf-text-secondary);
          font-size: 13px;
        "
      >
        <li>
          仅开放知识库、资料、切片、FAQ、Wiki、数据源及引擎设置的显式白名单。
        </li>
        <li>客服角色只读，但可执行知识检索；管理员写入并记录实际操作者。</li>
        <li>上传采用流式代理并限制为 25 MB。</li>
        <li>Weflow 新页面不允许引用旧知识兼容层。</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.rotated {
  transform: rotate(90deg);
  transition: transform var(--wf-motion-fast) var(--wf-ease-out);
}
</style>
