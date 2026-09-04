<script setup lang="ts">
/**
 * 审计日志（admin only）。功能自平台壳迁移重实现，复用既有
 * `/api/v1/admin/audit*` 接口：按事件类型 / 操作者 / 日期筛选 +
 * 分页加载 + 事件详情。
 */
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { eventTypeLabel } from "../labels";
import WfInspector from "../components/WfInspector.vue";

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
  <div class="wf-page">
    <header class="wf-page-head">
      <div>
        <h1>审计日志</h1>
        <p>平台内所有管理操作的完整记录。</p>
      </div>
    </header>

    <div class="wf-filter-bar">
      <span class="wf-filter-label">筛选</span>
      <select v-model="filter" class="wf-select" @change="applyFilters">
        <option value="">全部事件类型</option>
        <option v-for="type in eventOptions" :key="type" :value="type">
          {{ eventTypeLabel(type) }}
        </option>
      </select>
      <select v-model="selectedActor" class="wf-select" @change="applyFilters">
        <option value="">全部操作者</option>
        <option v-for="actor in actorOptions" :key="actor" :value="actor">
          {{ actor }}
        </option>
      </select>
      <input v-model="fromDate" type="date" class="wf-input" @change="applyFilters" />
      <span class="wf-muted">至</span>
      <input v-model="toDate" type="date" class="wf-input" @change="applyFilters" />
      <button class="wf-button compact primary" @click="applyFilters">筛选</button>
      <button
        v-if="filter || selectedActor || fromDate || toDate"
        class="wf-button compact ghost"
        @click="clearFilters"
      >
        清除
      </button>
    </div>

    <div v-if="error" class="wf-error" role="alert">{{ error }}</div>

    <section class="wf-audit-stream">
      <template v-if="loading">
        <div v-for="i in 6" :key="i" class="wf-audit-event">
          <span class="wf-skeleton">正在读取事件</span>
        </div>
      </template>
      <template v-else>
        <div v-for="group in days" :key="group.label" class="wf-audit-day">
          <div class="wf-audit-day-label">{{ group.label }}</div>
          <button
            v-for="item in group.list"
            :key="item.auditId"
            class="wf-audit-event"
            @click="selectedEvent = item"
          >
            <span class="wf-audit-time">{{
              new Date(item.createdAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })
            }}</span>
            <span class="wf-audit-copy">{{ eventCopy(item) }}</span>
            <span class="wf-audit-link">详情 →</span>
          </button>
        </div>
        <div v-if="!events.length" class="wf-empty">
          <div>
            <strong>没有符合条件的审计事件</strong>
            <p>调整筛选条件后再试。</p>
          </div>
        </div>
      </template>
    </section>

    <div v-if="hasMore && !loading" class="wf-load-more">
      <button class="wf-button compact" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? "加载中…" : "加载更多" }}
      </button>
    </div>

    <WfInspector
      variant="overlay"
      :open="Boolean(selectedEvent)"
      title="事件详情"
      @close="selectedEvent = null"
    >
      <template v-if="selectedEvent">
        <p class="wf-drawer-copy">{{ eventCopy(selectedEvent) }}</p>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">操作者</span>
          <p class="wf-brief-text">{{ selectedEvent.actorUsername || "System" }}</p>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">对象</span>
          <p class="wf-brief-text">{{ selectedEvent.subjectType }}</p>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">时间</span>
          <p class="wf-brief-text">
            {{ new Date(selectedEvent.createdAt).toLocaleString() }}
          </p>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">来源</span>
          <p class="wf-brief-text wf-mono">{{ selectedEvent.sourceIp || "—" }}</p>
        </section>
        <section class="wf-inspector-section">
          <span class="wf-brief-label">技术字段</span>
          <pre class="wf-audit-metadata">{{
            JSON.stringify(selectedEvent.metadata, null, 2)
          }}</pre>
        </section>
      </template>
    </WfInspector>
  </div>
</template>

<style scoped>
.wf-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border: 1px solid var(--wf-border);
  border-radius: 12px;
  background: var(--wf-surface);
  margin-bottom: 16px;
}
.wf-filter-label {
  color: var(--wf-text-muted);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.06em;
  margin-right: 4px;
}
.wf-filter-bar .wf-select,
.wf-filter-bar .wf-input {
  min-width: 150px;
  width: auto;
}
.wf-load-more {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
</style>
