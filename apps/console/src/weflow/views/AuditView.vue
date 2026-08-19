<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api";
import { eventTypeLabel } from "../labels";
import WfInspector from "../components/WfInspector.vue";

const PAGE_SIZE = 50;

const events = ref<any[]>([]);
const policies = ref<any[]>([]);
const filter = ref("");
const selectedActor = ref("");
const fromDate = ref("");
const toDate = ref("");
const error = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const hasMore = ref(false);
const offset = ref(0);
const eventOptions = ref<string[]>([]);
const actorOptions = ref<string[]>([]);
const selectedEvent = ref<any>(null);

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
    const [auditResult, policyResult] = await Promise.all([
      api<any>(`/api/v1/admin/audit?${buildParams().toString()}`),
      api<any>("/api/v1/agent/reply-policies").catch(() => ({ policies: [] })),
    ]);
    events.value = reset
      ? auditResult.events
      : [...events.value, ...auditResult.events];
    hasMore.value = Boolean(auditResult.hasMore);
    policies.value = policyResult.policies;
  } catch (r) {
    error.value = r instanceof Error ? r.message : "加载失败";
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

function applyFilters() {
  void load(true);
}

function clearFilters() {
  filter.value = "";
  selectedActor.value = "";
  fromDate.value = "";
  toDate.value = "";
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
  const groups = new Map<string, any[]>();
  for (const event of events.value) {
    const label = dayLabel(event.createdAt);
    const list = groups.get(label) ?? [];
    list.push(event);
    groups.set(label, list);
  }
  return [...groups.entries()].map(([label, list]) => ({ label, list }));
});
function policyName(id?: string) {
  const item = policies.value.find((policy) => policy.policyVersionId === id);
  return item ? `${item.name} v${item.version}` : id || "策略版本";
}
function eventCopy(item: any) {
  const actor = item.actorUsername || "System";
  if (item.eventType === "reply_policy.published")
    return `${actor} 发布了 ${policyName(item.subjectId)}`;
  if (item.eventType === "reply_policy.draft_created")
    return `${actor} 创建了 ${policyName(item.subjectId)} 草稿`;
  if (item.eventType === "reply_policy.draft_updated")
    return `${actor} 修改了 ${policyName(item.subjectId)}`;
  if (item.eventType?.includes("knowledge"))
    return `${actor} ${eventTypeLabel(item.eventType)}`;
  if (item.eventType?.includes("user") || item.subjectType === "user")
    return `${actor} 修改了用户 ${item.subjectId}`;
  return `${actor} ${eventTypeLabel(item.eventType)}`;
}
function eventLink(item: any) {
  if (item.subjectType === "user") return { path: "/system/users" };
  return null;
}
onMounted(() => {
  void loadOptions();
  void load();
});
</script>
<template>
  <div class="wf-page">
    <header class="wf-page-head">
      <h1>审计日志</h1>
      <div class="wf-filter-bar">
        <select v-model="filter" class="wf-select" @change="applyFilters">
          <option value="">全部事件类型</option>
          <option v-for="type in eventOptions" :key="type" :value="type">
            {{ eventTypeLabel(type) }}
          </option>
        </select>
        <select
          v-model="selectedActor"
          class="wf-select"
          @change="applyFilters"
        >
          <option value="">全部操作者</option>
          <option v-for="actor in actorOptions" :key="actor" :value="actor">
            {{ actor }}
          </option>
        </select>
        <input
          v-model="fromDate"
          type="date"
          class="wf-input"
          @change="applyFilters"
        />
        <span class="wf-muted">至</span>
        <input
          v-model="toDate"
          type="date"
          class="wf-input"
          @change="applyFilters"
        />
        <button class="wf-button compact primary" @click="applyFilters">
          筛选
        </button>
        <button
          v-if="filter || selectedActor || fromDate || toDate"
          class="wf-button compact ghost"
          @click="clearFilters"
        >
          清除
        </button>
      </div>
    </header>
    <div v-if="error" class="wf-error">{{ error }}</div>
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
        <div v-if="!events.length && !loading" class="wf-empty">
          <div>
            <strong>没有符合条件的审计事件</strong>
            <p>调整筛选条件后再试。</p>
          </div>
        </div>
      </template>
    </section>

    <div v-if="hasMore && !loading" class="wf-load-more">
      <button
        class="wf-button compact"
        :disabled="loadingMore"
        @click="loadMore"
      >
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
          <router-link
            v-if="eventLink(selectedEvent)"
            class="wf-link"
            :to="eventLink(selectedEvent)!"
            >打开对象 →</router-link
          >
          <p v-else class="wf-brief-text">{{ selectedEvent.subjectType }}</p>
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
  padding: 10px 12px;
  border: 1px solid var(--wf-border);
  border-radius: var(--wf-radius-control);
  background: var(--wf-surface);
  margin-bottom: 12px;
}
.wf-filter-bar .wf-select,
.wf-filter-bar .wf-input {
  min-width: 150px;
}
.wf-load-more {
  display: flex;
  justify-content: center;
  padding: 16px 0;
}
</style>
