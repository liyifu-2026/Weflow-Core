<script setup lang="ts">
/**
 * 系统状态（admin only）。功能自平台壳迁移重实现，复用既有
 * `/api/v1/system/status` 与 `/api/v1/admin/agent-turns` 接口：
 * 服务健康总览 + 展开详情 + 最近 Agent Turn 诊断。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronRight, RotateCw } from "lucide-vue-next";
import { api } from "../api";
import { statusTone, type WfStatusTone } from "../components/status-tone";
import { healthLabel } from "../labels";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

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
type AgentTurn = {
  turnId: string;
  conversationId: string;
  status: string;
  model?: string | null;
  errorCode?: string | null;
  createdAt: string;
};

const route = useRoute();
const router = useRouter();
const status = ref<StatusResponse | null>(null);
const turns = ref<AgentTurn[]>([]);
const loading = ref(true);
const error = ref("");
const lastUpdated = ref<Date | null>(null);
const stale = ref(false);
const busy = ref(false);
const selectedService = ref(
  typeof route.query.service === "string" ? route.query.service : "",
);
let refreshTimer: ReturnType<typeof setInterval> | null = null;

const attentionServices = computed(
  () =>
    status.value?.services.filter((item) =>
      ["degraded", "unreachable"].includes(item.health.status),
    ) ?? [],
);
const otherServices = computed(
  () =>
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
const overallText = computed(
  () =>
    ({
      unreachable: "不可达",
      degraded: "降级",
      healthy: "健康",
      not_monitored: "未监测",
    })[overall.value],
);

/** statusTone → Badge 变体（唯一映射，避免散落判断） */
function toneBadge(tone: WfStatusTone): "default" | "secondary" | "destructive" | "outline" {
  if (tone === "good") return "default";
  if (tone === "bad") return "destructive";
  if (tone === "warn") return "outline";
  return "secondary";
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

const lastUpdatedText = computed(() =>
  lastUpdated.value ? lastUpdated.value.toLocaleTimeString() : "",
);

async function load() {
  // 只有首次加载（还没有数据）才整页骨架屏；自动刷新静默进行，失败转为陈旧横幅。
  const initial = status.value === null;
  busy.value = true;
  loading.value = initial;
  error.value = "";
  try {
    const tasks: Promise<unknown>[] = [
      api<StatusResponse>("/api/v1/system/status").then(
        (value) => (status.value = value),
      ),
      api<{ turns: AgentTurn[] }>("/api/v1/admin/agent-turns?limit=30")
        .then((value) => (turns.value = value.turns))
        .catch(() => undefined),
    ];
    await Promise.all(tasks);
    lastUpdated.value = new Date();
    stale.value = false;
    await nextTick();
    if (selectedService.value)
      document
        .getElementById(`service-${selectedService.value}`)
        ?.scrollIntoView({ block: "center" });
  } catch (reason) {
    if (initial)
      error.value = reason instanceof Error ? reason.message : "系统状态加载失败";
    else stale.value = true;
  } finally {
    busy.value = false;
    loading.value = false;
  }
}

async function selectService(key: string) {
  selectedService.value = selectedService.value === key ? "" : key;
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
  <div class="mx-auto w-full max-w-6xl p-6">
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">系统状态</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          平台各服务的配置与健康状态，每 30 秒自动刷新。
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="busy" @click="load">
        <RotateCw class="size-4" :class="busy && 'animate-spin'" />
        刷新
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mt-4" role="alert">
      <AlertDescription class="flex items-center justify-between gap-4">
        <span>{{ error }}</span>
        <Button variant="outline" size="sm" @click="load">重新加载</Button>
      </AlertDescription>
    </Alert>

    <Alert v-if="stale && !error" variant="outline" class="mt-4" role="status">
      <AlertDescription class="flex items-center justify-between gap-4">
        <span>
          自动刷新失败，数据可能已过期（最后成功 {{ lastUpdatedText }}）。
        </span>
        <Button variant="outline" size="sm" @click="load">立即重试</Button>
      </AlertDescription>
    </Alert>

    <div class="mt-4 flex flex-wrap items-center gap-2">
      <Badge :variant="toneBadge(statusTone(overall))">
        {{ loading ? "检测中…" : overallText }}
      </Badge>
      <span v-if="status" class="text-sm text-muted-foreground">
        检查于 {{ new Date(status.checkedAt).toLocaleString() }}
      </span>
      <Badge
        v-for="service in attentionServices"
        :key="service.key"
        variant="outline"
      >
        {{ service.name }}
      </Badge>
    </div>

    <template v-if="loading">
      <div class="mt-6 space-y-2">
        <Skeleton v-for="i in 4" :key="i" class="h-16 w-full" />
      </div>
    </template>

    <template v-else>
      <section
        v-for="group in serviceGroups"
        :key="group.label"
        class="mt-6"
      >
        <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {{ group.label }}
        </h2>
        <Card class="gap-0 overflow-hidden py-0">
          <CardContent class="p-0">
            <article
              v-for="service in group.services"
              :id="`service-${service.key}`"
              :key="service.key"
              class="cursor-pointer border-b border-border px-4 py-3 transition-colors last:border-b-0 hover:bg-muted/50"
              :class="selectedService === service.key && 'bg-muted/50'"
              @click="selectService(service.key)"
            >
              <div class="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,1fr)_120px_120px_28px] md:gap-4">
                <div class="min-w-0">
                  <p class="text-sm font-medium">{{ service.name }}</p>
                  <p class="truncate text-xs text-muted-foreground">
                    {{ service.health.summary }}
                  </p>
                </div>
                <div class="hidden flex-col gap-1 md:flex">
                  <span class="text-xs text-muted-foreground">配置</span>
                  <Badge variant="secondary">
                    {{ service.configuration.status === "configured" ? "已配置" : "未配置" }}
                  </Badge>
                </div>
                <div class="hidden flex-col gap-1 md:flex">
                  <span class="text-xs text-muted-foreground">健康</span>
                  <Badge :variant="toneBadge(statusTone(service.health.status))">
                    {{ serviceHealthText(service) }}
                  </Badge>
                </div>
                <ChevronRight
                  class="hidden size-4 text-muted-foreground transition-transform duration-200 md:block"
                  :class="selectedService === service.key && 'rotate-90'"
                />
              </div>

              <div
                v-if="selectedService === service.key"
                class="mt-3 border-t border-border pt-3 text-sm text-muted-foreground"
              >
                <p v-if="service.health.status === 'not_monitored'" class="mb-2">
                  该服务当前没有实时业务探测。请求加载失败、尚未加载和"未监测"是不同状态。
                </p>
                <p
                  v-if="!(service.details || []).length && service.health.status !== 'not_monitored'"
                  class="py-1"
                >
                  暂无更详细的探测数据。
                </p>
                <div
                  v-for="item in service.details || []"
                  :key="item.key"
                  class="grid grid-cols-1 gap-1 border-b border-border py-2 last:border-b-0 md:grid-cols-[180px_minmax(0,1fr)_110px] md:items-center md:gap-3"
                >
                  <span class="font-medium text-foreground">{{ item.name }}</span>
                  <span>{{ item.summary }}</span>
                  <Badge :variant="toneBadge(statusTone(item.status))" class="w-fit">
                    {{ detailStatusLabel(item.status) }}
                  </Badge>
                </div>
              </div>
            </article>
          </CardContent>
        </Card>
      </section>

      <div
        v-if="serviceGroups.length === 0"
        class="mt-6 flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-12 text-muted-foreground"
      >
        <p class="text-sm">暂无可展示的服务</p>
      </div>
    </template>

    <details class="mt-8">
      <summary class="cursor-pointer text-sm font-medium text-foreground">
        诊断详情 · 最近 Agent Turn
      </summary>
      <Card class="mt-3 gap-0 overflow-hidden py-0">
        <CardContent class="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Turn</TableHead>
                <TableHead>会话</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>模型</TableHead>
                <TableHead>错误</TableHead>
                <TableHead>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="turn in turns" :key="turn.turnId">
                <TableCell class="font-mono text-xs">
                  {{ turn.turnId.slice(0, 22) }}…
                </TableCell>
                <TableCell class="font-mono text-xs">
                  {{ turn.conversationId.slice(0, 18) }}…
                </TableCell>
                <TableCell>
                  <Badge :variant="toneBadge(statusTone(turn.status))">
                    {{ detailStatusLabel(turn.status) }}
                  </Badge>
                </TableCell>
                <TableCell>{{ turn.model || "—" }}</TableCell>
                <TableCell>{{ turn.errorCode || "—" }}</TableCell>
                <TableCell class="text-muted-foreground">
                  {{ new Date(turn.createdAt).toLocaleString() }}
                </TableCell>
              </TableRow>
              <TableRow v-if="!turns.length">
                <TableCell colspan="6" class="text-center text-muted-foreground">
                  暂无记录
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </details>
  </div>
</template>
