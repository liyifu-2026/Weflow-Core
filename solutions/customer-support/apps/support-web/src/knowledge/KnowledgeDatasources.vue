<script setup lang="ts">
import { ref } from "vue";
import { ChevronDown, Database } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  listDataSourceBindings,
  listKnowledgeBases,
  type DataSourceBinding,
} from "./api";
import { infraStateLabel } from "../labels";
import {
  productStateCopy,
  productStateOf,
  updateKnowledgeCapability,
  useKnowledgeCapability,
} from "./capability-registry";

const state = useKnowledgeCapability("datasources");
const copy = productStateCopy(productStateOf(state));
const expanded = ref(false);

// P4 先读：按知识库维度展示真实绑定关系。数据源写入（新增连接、
// 同步控制、日志）确认需要后再开放 —— 不渲染任何假入口。
type KbBinding = {
  kbId: string;
  name: string;
  items: DataSourceBinding[];
};
const bindings = ref<KbBinding[]>([]);
const loading = ref(false);
const error = ref("");

async function loadBindings() {
  loading.value = true;
  error.value = "";
  try {
    const bases = await listKnowledgeBases();
    const rows = await Promise.all(
      bases.map(async (base) => ({
        kbId: base.id,
        name: base.name,
        items: await listDataSourceBindings(base.id),
      })),
    );
    bindings.value = rows;
    updateKnowledgeCapability("datasources", {
      ui: "partial",
      reason: "read-only bindings wired (P4)",
    });
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "数据源加载失败";
  } finally {
    loading.value = false;
  }
}

function toggleExpanded() {
  expanded.value = !expanded.value;
  if (expanded.value && !loading.value && !bindings.value.length)
    void loadBindings();
}

function boundCountLabel(binding: KbBinding): string {
  return binding.items.length
    ? `绑定 ${binding.items.length} 个数据源`
    : "未显式绑定";
}
</script>

<template>
  <div class="space-y-6">
    <section class="space-y-3">
      <h2 class="text-lg font-semibold tracking-tight">数据源</h2>
      <p class="text-sm text-muted-foreground">
        从 Feishu、Notion、Yuque、RSS
        等来源同步内容，自动进入知识库参与 Agent 检索。
      </p>
      <div class="flex items-center justify-between gap-3 rounded-md border border-border px-4 py-3">
        <div>
          <strong class="text-sm">数据源</strong>
          <span class="ml-2 text-xs text-muted-foreground">绑定关系与连接状态</span>
        </div>
        <Badge :variant="productStateOf(state) !== 'available' ? 'outline' : 'secondary'">
          {{ copy.title }}
        </Badge>
      </div>
    </section>

    <Button variant="link" size="sm" class="h-auto p-0" @click="toggleExpanded">
      {{ expanded ? "收起" : "查看绑定关系" }}
      <ChevronDown
        class="size-3.5 transition-transform"
        :class="expanded ? 'rotate-180' : ''"
      />
    </Button>

    <section v-if="expanded" class="space-y-3">
      <h2 class="text-lg font-semibold tracking-tight">知识库绑定</h2>
      <template v-if="loading">
        <div v-for="i in 3" :key="i" class="flex items-center gap-3 px-2 py-2">
          <Skeleton class="h-4 w-48" />
          <Skeleton class="h-4 w-16" />
        </div>
      </template>
      <div v-else-if="error" class="flex items-center gap-3">
        <span class="text-sm text-destructive">{{ error }}</span>
        <Button variant="outline" size="sm" @click="loadBindings">重试</Button>
      </div>
      <div v-else class="space-y-4">
        <div
          v-for="binding in bindings"
          :key="binding.kbId"
          class="space-y-2 border-t border-border pt-3"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <strong class="text-sm">{{ binding.name }}</strong>
              <span class="ml-2 text-xs text-muted-foreground">{{ boundCountLabel(binding) }}</span>
            </div>
            <Badge :variant="binding.items.length > 0 ? 'secondary' : 'outline'">
              {{ binding.items.length ? "已绑定" : "默认" }}
            </Badge>
          </div>
          <div
            v-for="item in binding.items"
            :key="item.id"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-muted/50 px-3 py-2 text-sm"
          >
            <span>{{ item.name || item.id }}</span>
            <span class="text-xs text-muted-foreground">{{ item.type || "—" }}</span>
            <Badge variant="outline">{{ infraStateLabel(item.status) }}</Badge>
            <span v-if="item.sync_status" class="text-xs text-muted-foreground">
              同步：{{ infraStateLabel(item.sync_status) }}
            </span>
            <span v-if="item.last_sync_at" class="text-xs text-muted-foreground">
              上次同步：{{ new Date(item.last_sync_at).toLocaleString() }}
            </span>
          </div>
        </div>
        <p class="flex items-start gap-2 text-sm text-muted-foreground">
          <Database class="mt-0.5 size-4 shrink-0" />
          <span>
            {{
              bindings.length
                ? "当前知识库均未显式绑定数据源，统一使用部署默认数据源。数据源写入（新增连接、同步控制与日志）将在确认需要后开放，当前为只读展示。"
                : copy.detail || "数据源管理只对管理员开放。"
            }}
          </span>
        </p>
      </div>
    </section>
  </div>
</template>
