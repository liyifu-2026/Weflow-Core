<script setup lang="ts">
/**
 * 设置中心 · ⑤ 通道分区：Channel Host 探活只读展示。
 * 通道协议细节属于 Channel Host；这里只展示平台视角的连接健康。
 */
import { onMounted, ref } from "vue";
import { api } from "../../api";

type OperatorStatus = {
  channelOnline: boolean;
  queuedTurnCount: number;
  runningTurnCount: number;
  pendingHandoffCount: number;
  lastCompletedTurnAt: string | null;
};

const status = ref<OperatorStatus | null>(null);
const loading = ref(true);
const error = ref("");

async function load() {
  loading.value = true;
  error.value = "";
  try {
    status.value = await api<OperatorStatus>("/api/v1/admin/operator-status");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "通道状态加载失败";
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
        <strong>Channel Host（微信通道）</strong>
        <span class="spacer" />
        <button class="wf-button compact" @click="load">刷新</button>
      </div>
      <div v-if="loading" class="wf-settings-body">
        <span class="wf-skeleton">正在探测通道…</span>
      </div>
      <div v-else-if="error" class="wf-settings-body">
        <span class="wf-settings-error">{{ error }}</span>
      </div>
      <div v-else-if="status" class="wf-settings-body">
        <div class="wf-settings-kv">
          <span class="k">连接状态</span>
          <span class="v" :class="status.channelOnline ? 'ok' : 'bad'">
            {{ status.channelOnline ? "在线（15 秒内有事件心跳）" : "离线 / 未运行" }}
          </span>
        </div>
        <div class="wf-settings-kv">
          <span class="k">排队中的 Turn</span>
          <span class="v">{{ status.queuedTurnCount }}</span>
        </div>
        <div class="wf-settings-kv">
          <span class="k">执行中的 Turn</span>
          <span class="v">{{ status.runningTurnCount }}</span>
        </div>
        <div class="wf-settings-kv">
          <span class="k">待处理人工会话</span>
          <span class="v">{{ status.pendingHandoffCount }}</span>
        </div>
        <div class="wf-settings-kv">
          <span class="k">最近完成的 Turn</span>
          <span class="v">{{ status.lastCompletedTurnAt ? new Date(status.lastCompletedTurnAt).toLocaleString() : "—" }}</span>
        </div>
        <p class="wf-settings-hint">
          发送节流与通道自动化参数由 Channel Host 进程管理（本部署内建）；如需调整通道侧参数请编辑 Channel Host 配置并重启该进程。
        </p>
      </div>
    </section>
  </div>
</template>

<style scoped>
@import "./settings-shared.css";
.ok {
  color: #137333;
}
.bad {
  color: #d93025;
}
</style>
