<script setup lang="ts">
/**
 * 知识库概览仪表板（只读）：知识库数、文档总数、最近更新、验证检索次数。
 * 数据来自现有只读端点（知识库列表）与本地检索计数，不新增后端依赖。
 */
import { computed, onMounted, ref } from "vue";
import { listKnowledgeBases } from "./api";
import { getValidateSearchCount } from "./search-stats";

const bases = ref<Array<{ knowledge_count?: number; updated_at?: string }>>([]);
const loading = ref(true);
const failed = ref(false);
const searchCount = ref(getValidateSearchCount());

const totalDocuments = computed(() =>
  bases.value.reduce(
    (sum, item) => sum + (Number(item.knowledge_count) || 0),
    0,
  ),
);

const lastUpdated = computed(() => {
  let latest = 0;
  for (const item of bases.value) {
    if (!item.updated_at) continue;
    const time = new Date(item.updated_at).getTime();
    if (Number.isFinite(time) && time > latest) latest = time;
  }
  return latest ? latest : null;
});

function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString();
}

const cards = computed(() => [
  { label: "文档总数", value: String(totalDocuments.value) },
  { label: "知识库数", value: String(bases.value.length) },
  {
    label: "最近更新",
    value: lastUpdated.value ? relativeTime(lastUpdated.value) : "—",
  },
  { label: "验证检索", value: searchCount.value.toLocaleString() },
]);

onMounted(async () => {
  try {
    bases.value = await listKnowledgeBases();
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="wf-knowledge-stats" aria-label="知识库概览">
    <div v-if="failed" class="wf-knowledge-stats-error">
      概览数据暂不可用
    </div>
    <template v-else>
      <div v-for="card in cards" :key="card.label" class="wf-stat-card">
        <template v-if="loading">
          <div class="wf-skeleton wf-skeleton-title"></div>
          <div class="wf-skeleton wf-skeleton-line"></div>
        </template>
        <template v-else>
          <strong>{{ card.value }}</strong>
          <span>{{ card.label }}</span>
        </template>
      </div>
    </template>
  </section>
</template>

<style scoped>
.wf-knowledge-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 12px;
}
.wf-stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  background: var(--wf-surface, #fff);
}
.wf-stat-card strong {
  font-size: 20px;
  line-height: 1.2;
  color: var(--wf-text, #17181a);
}
.wf-stat-card span {
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
}
.wf-knowledge-stats-error {
  grid-column: 1 / -1;
  font-size: 12px;
  color: var(--wf-text-secondary, #5f6368);
  padding: 8px 2px;
}
</style>
