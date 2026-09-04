<script setup lang="ts">
/**
 * 知识库概览仪表板（只读）：知识库数、文档总数、最近更新、验证检索次数。
 * 数据来自现有只读端点（知识库列表）与本地检索计数，不新增后端依赖。
 */
import { computed, onMounted, ref } from "vue";
import { Database } from "lucide-vue-next";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  <section aria-label="知识库概览" class="grid grid-cols-2 gap-3 md:grid-cols-4">
    <div v-if="failed" class="col-span-full flex items-center gap-2 text-sm text-muted-foreground">
      <Database class="size-4" />
      概览数据暂不可用
    </div>
    <template v-else>
      <Card v-for="card in cards" :key="card.label" class="gap-1 px-4 py-3">
        <template v-if="loading">
          <Skeleton class="h-5 w-10" />
          <Skeleton class="h-3 w-14" />
        </template>
        <template v-else>
          <span class="text-xl font-semibold leading-tight tracking-tight">{{ card.value }}</span>
          <span class="text-xs text-muted-foreground">{{ card.label }}</span>
        </template>
      </Card>
    </template>
  </section>
</template>
