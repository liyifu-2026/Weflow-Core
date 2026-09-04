<script setup lang="ts">
/**
 * 设置中心 · ⑦ 部署分区：运行环境只读展示。
 * 数据源 /api/v1/system/status（Core/Channel Host/模型/知识服务的配置与探活）。
 * DATABASE_URL / REDIS_URL / 端口等基础设施来自 .env，标注「改 .env 重启生效」。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";

type ServiceStatus = {
  key: string;
  name: string;
  configuration: { status: string; summary: string };
  health: { status: string; summary: string };
};

type SystemStatus = {
  services: ServiceStatus[];
};

const status = ref<SystemStatus | null>(null);
const loading = ref(true);
const error = ref("");

const ENV_KEYS = [
  { key: "DATABASE_URL", label: "PostgreSQL（DATABASE_URL）" },
  { key: "REDIS_URL", label: "Redis（REDIS_URL）" },
  { key: "CORE_PORT", label: "Core API 端口（CORE_PORT）" },
  { key: "CHANNEL_HOST_BASE_URL", label: "Channel Host（CHANNEL_HOST_BASE_URL）" },
];

async function load() {
  loading.value = true;
  error.value = "";
  try {
    status.value = await api<SystemStatus>("/api/v1/system/status");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "部署状态加载失败";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="wf-section">
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>服务探活（只读）</strong>
        <span class="spacer" />
        <button class="wf-button compact" @click="load">刷新</button>
        <span v-if="error" class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在读取部署状态…</span>
      </div>
      <div v-else-if="status" class="wf-settings-body">
        <div v-for="service in status.services" :key="service.key" class="wf-settings-kv">
          <span class="k">{{ service.name }}</span>
          <span class="v">
            {{ service.configuration.summary }} · {{ service.health.summary }}
          </span>
        </div>
      </div>
    </section>
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>基础设施（.env，只读）</strong>
      </div>
      <div class="wf-settings-body">
        <div v-for="env in ENV_KEYS" :key="env.key" class="wf-settings-kv">
          <span class="k">{{ env.label }}</span>
          <span class="v mono">{{ env.key }}</span>
        </div>
        <p class="wf-settings-hint">
          基础设施连接与端口来自部署环境的 <code>.env</code> 文件。<strong>修改 .env
          后需要重启服务（weflowctl dev down && dev up）才生效</strong>；运行时可调项
          （模型 / 开关 / 行为参数 / 群策略）请使用对应分区，保存即时生效，无需重启。
        </p>
      </div>
    </section>
    <section class="wf-settings-card">
      <div class="wf-settings-card-head">
        <strong>部署形态</strong>
      </div>
      <div class="wf-settings-body">
        <p class="wf-settings-hint">
          Weflow 是单进程部署、配置集中、可高效热更新的 AI 客服产品：Core API、
          Agent Worker、Ingestion Worker 与 Channel Host 同机部署，配置以设置中心为准，
          .env 仅承担首次部署种子与基础设施连接。Windows 桌面端封装在后续阶段交付。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
.mono {
  font-family: ui-monospace, monospace;
  font-size: 12px;
}
</style>
