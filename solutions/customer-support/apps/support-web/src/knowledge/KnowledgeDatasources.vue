<script setup lang="ts">
import { ref } from "vue";
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
  <div class="wf-page-body wf-config-summary">
    <section class="wf-section-block">
      <div class="wf-section-heading">
        <h2>数据源</h2>
      </div>
      <p class="wf-muted wf-config-note">
        从 Feishu、Notion、Yuque、RSS
        等来源同步内容，自动进入知识库参与 Agent 检索。
      </p>
      <div class="wf-config-list">
        <div class="wf-config-row">
          <div>
            <strong>数据源</strong>
            <span class="wf-muted">绑定关系与连接状态</span>
          </div>
          <span class="wf-status" :class="{ warn: productStateOf(state) !== 'available' }">{{
            copy.title
          }}</span>
        </div>
      </div>
    </section>

    <button
      class="wf-link wf-link-button wf-config-more"
      @click="toggleExpanded"
    >
      {{ expanded ? "收起" : "查看绑定关系 →" }}
    </button>

    <section v-if="expanded" class="wf-section-block">
      <div class="wf-section-heading">
        <h2>知识库绑定</h2>
      </div>
      <template v-if="loading">
        <div
          v-for="i in 3"
          :key="i"
          class="wf-policy-state"
          style="grid-template-columns: 1fr 120px"
        >
          <span class="wf-skeleton">正在读取知识库</span
          ><span class="wf-skeleton">检查中</span>
        </div>
      </template>
      <div v-else-if="error" class="wf-error">
        <span>{{ error }}</span
        ><button class="wf-button compact" @click="loadBindings">重试</button>
      </div>
      <div v-else class="wf-config-list">
        <div
          v-for="binding in bindings"
          :key="binding.kbId"
          class="wf-infra-row"
        >
          <div class="wf-infra-main">
            <strong>{{ binding.name }}</strong>
            <span class="wf-muted">{{ boundCountLabel(binding) }}</span>
          </div>
          <div class="wf-infra-side">
            <span
              class="wf-status"
              :class="{ good: binding.items.length > 0 }"
              >{{ binding.items.length ? "已绑定" : "默认" }}</span
            >
          </div>
          <div
            v-for="item in binding.items"
            :key="item.id"
            class="wf-infra-detail"
          >
            <span>{{ item.name || item.id }}</span>
            <span class="wf-muted">{{ item.type || "—" }}</span>
            <span class="wf-status warn">{{ infraStateLabel(item.status) }}</span>
            <span v-if="item.sync_status" class="wf-muted"
              >同步：{{ infraStateLabel(item.sync_status) }}</span
            >
            <span v-if="item.last_sync_at" class="wf-muted"
              >上次同步：{{
                new Date(item.last_sync_at).toLocaleString()
              }}</span
            >
          </div>
        </div>
        <p class="wf-muted wf-config-note">
          {{
            bindings.length
              ? "当前知识库均未显式绑定数据源，统一使用部署默认数据源。数据源写入（新增连接、同步控制与日志）将在确认需要后开放，当前为只读展示。"
              : copy.detail || "数据源管理只对管理员开放。"
          }}
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.wf-infra-row {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: baseline;
  gap: 4px 12px;
  padding: 10px 0;
  border-top: 1px solid var(--wf-border);
  font-size: 13px;
}
.wf-infra-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.wf-infra-side {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.wf-infra-detail {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  background: var(--wf-surface);
  border-radius: 6px;
  color: var(--wf-text-secondary);
}
</style>

