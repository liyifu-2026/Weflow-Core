<script setup lang="ts">
/**
 * 审计日志（admin only）。功能自平台壳迁移重实现，复用既有
 * `/api/v1/admin/audit*` 接口：按事件类型 / 操作者 / 日期筛选 +
 * 分页加载 + 事件详情（Dialog）。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { eventTypeLabel, subjectTypeLabel } from "../labels";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";

const PAGE_SIZE = 50;

type AuditEvent = {
  auditId: string;
  createdAt: string;
  eventType: string;
  actorUsername?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  sourceIp?: string | null;
  metadata?: unknown;
};

const route = useRoute();
const router = useRouter();

const events = ref<AuditEvent[]>([]);
const filter = ref(
  typeof route.query.eventType === "string" ? route.query.eventType : "",
);
const selectedActor = ref(
  typeof route.query.actor === "string" ? route.query.actor : "",
);
const fromDate = ref(typeof route.query.from === "string" ? route.query.from : "");
const toDate = ref(typeof route.query.to === "string" ? route.query.to : "");
const error = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(false);
const offset = ref(0);
const eventOptions = ref<string[]>([]);
const actorOptions = ref<string[]>([]);
const selectedEvent = ref<AuditEvent | null>(null);

function buildParams() {
  const params = new URLSearchParams();
  params.set("limit", String(PAGE_SIZE));
  params.set("offset", String(offset.value));
  if (filter.value) params.set("eventType", filter.value);
  if (selectedActor.value) params.set("actor", selectedActor.value);
  if (fromDate.value) params.set("from", new Date(fromDate.value).toISOString());
  if (toDate.value)
    params.set("to", new Date(`${toDate.value}T23:59:59`).toISOString());
  return params;
}

async function load(reset = true) {
  if (reset) {
    offset.value = 0;
    events.value = [];
  }
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ events: AuditEvent[]; hasMore?: boolean }>(
      `/api/v1/admin/audit?${buildParams().toString()}`,
    );
    events.value = reset
      ? result.events
      : [...events.value, ...result.events];
    hasMore.value = Boolean(result.hasMore);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function loadOptions() {
  try {
    const data = await api<{ eventTypes: string[]; actors: string[] }>(
      "/api/v1/admin/audit/options",
    );
    eventOptions.value = data.eventTypes ?? [];
    actorOptions.value = data.actors ?? [];
  } catch {
    // 选项加载失败不阻塞审计列表
  }
}

async function loadMore() {
  if (loading.value || loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  offset.value += PAGE_SIZE;
  await load(false);
}

function syncQuery() {
  const query: Record<string, string> = {};
  if (filter.value) query.eventType = filter.value;
  if (selectedActor.value) query.actor = selectedActor.value;
  if (fromDate.value) query.from = fromDate.value;
  if (toDate.value) query.to = toDate.value;
  void router.replace({ query });
}

function applyFilters() {
  syncQuery();
  void load(true);
}

function clearFilters() {
  filter.value = "";
  selectedActor.value = "";
  fromDate.value = "";
  toDate.value = "";
  void router.replace({});
  void load(true);
}

function dayLabel(value: string) {
  const date = new Date(value);
  const now = new Date();
  const dayStart = (input: Date) =>
    new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime();
  const diff = Math.round((dayStart(now) - dayStart(date)) / 86_400_000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

const days = computed(() => {
  const groups = new Map<string, AuditEvent[]>();
  for (const event of events.value) {
    const label = dayLabel(event.createdAt);
    const list = groups.get(label) ?? [];
    list.push(event);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, list }));
});

function eventCopy(item: AuditEvent) {
  const actor = item.actorUsername || "System";
  return `${actor} ${eventTypeLabel(item.eventType)}`;
}

onMounted(() => {
  void loadOptions();
  void load();
});
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-6">
    <h1 class="text-2xl font-semibold tracking-tight">审计日志</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      平台内所有管理操作的完整记录。
    </p>

    <div
      class="mt-6 flex flex-wrap items-end gap-2 rounded-md border border-border bg-card p-3"
    >
      <div class="space-y-1.5">
        <Label for="audit-event" class="text-xs text-muted-foreground">事件类型</Label>
        <select
          id="audit-event"
          v-model="filter"
          class="h-9 rounded-md border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          @change="applyFilters"
        >
          <option value="">全部事件类型</option>
          <option v-for="type in eventOptions" :key="type" :value="type">
            {{ eventTypeLabel(type) }}
          </option>
        </select>
      </div>
      <div class="space-y-1.5">
        <Label for="audit-actor" class="text-xs text-muted-foreground">操作者</Label>
        <select
          id="audit-actor"
          v-model="selectedActor"
          class="h-9 rounded-md border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          @change="applyFilters"
        >
          <option value="">全部操作者</option>
          <option v-for="actor in actorOptions" :key="actor" :value="actor">
            {{ actor }}
          </option>
        </select>
      </div>
      <div class="space-y-1.5">
        <Label for="audit-from" class="text-xs text-muted-foreground">从</Label>
        <Input
          id="audit-from"
          v-model="fromDate"
          type="date"
          class="w-40"
          @change="applyFilters"
        />
      </div>
      <div class="space-y-1.5">
        <Label for="audit-to" class="text-xs text-muted-foreground">至</Label>
        <Input
          id="audit-to"
          v-model="toDate"
          type="date"
          class="w-40"
          @change="applyFilters"
        />
      </div>
      <Button size="sm" @click="applyFilters">筛选</Button>
      <Button
        v-if="filter || selectedActor || fromDate || toDate"
        variant="ghost"
        size="sm"
        @click="clearFilters"
      >
        清除
      </Button>
    </div>

    <Alert v-if="error" variant="destructive" class="mt-4" role="alert">
      <AlertDescription>{{ error }}</AlertDescription>
    </Alert>

    <section class="mt-6">
      <template v-if="loading">
        <div class="space-y-2">
          <Skeleton v-for="i in 6" :key="i" class="h-10 w-full" />
        </div>
      </template>
      <template v-else>
        <div v-for="group in days" :key="group.label" class="mb-6">
          <h2 class="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {{ group.label }}
          </h2>
          <div class="overflow-hidden rounded-md border border-border">
            <button
              v-for="item in group.list"
              :key="item.auditId"
              class="flex w-full items-center gap-4 border-b border-border px-4 py-2.5 text-left text-sm transition-colors last:border-b-0 hover:bg-muted/50"
              @click="selectedEvent = item"
            >
              <span class="w-12 shrink-0 text-muted-foreground">
                {{
                  new Date(item.createdAt).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }}
              </span>
              <span class="min-w-0 flex-1 truncate">{{ eventCopy(item) }}</span>
              <span class="shrink-0 text-xs text-muted-foreground">详情</span>
            </button>
          </div>
        </div>
        <div
          v-if="!events.length"
          class="flex flex-col items-center gap-1 rounded-md border border-dashed border-border py-12 text-muted-foreground"
        >
          <p class="text-sm font-medium text-foreground">没有符合条件的审计事件</p>
          <p class="text-sm">调整筛选条件后再试。</p>
        </div>
      </template>
    </section>

    <div v-if="hasMore && !loading" class="flex justify-center py-4">
      <Button variant="outline" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? "加载中…" : "加载更多" }}
      </Button>
    </div>

    <Dialog
      :open="Boolean(selectedEvent)"
      @update:open="(open: boolean) => !open && (selectedEvent = null)"
    >
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>事件详情</DialogTitle>
          <DialogDescription v-if="selectedEvent">
            {{ eventCopy(selectedEvent) }}
          </DialogDescription>
        </DialogHeader>
        <div v-if="selectedEvent" class="space-y-4 text-sm">
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">操作者</p>
            <p>{{ selectedEvent.actorUsername || "System" }}</p>
          </div>
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">对象</p>
            <p>{{ subjectTypeLabel(selectedEvent.subjectType) }}</p>
          </div>
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">时间</p>
            <p>{{ new Date(selectedEvent.createdAt).toLocaleString() }}</p>
          </div>
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">来源</p>
            <p class="font-mono text-xs">{{ selectedEvent.sourceIp || "—" }}</p>
          </div>
          <div class="space-y-1">
            <p class="text-xs text-muted-foreground">技术字段</p>
            <pre class="max-h-56 overflow-auto rounded-md bg-muted p-3 font-mono text-xs">{{ JSON.stringify(selectedEvent.metadata, null, 2) }}</pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
