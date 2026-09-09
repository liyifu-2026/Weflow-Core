<script setup lang="ts">
/**
 * 设置中心 · ⑦ 部署分区：运行环境只读展示。
 * 数据源 /api/v1/system/status（Core/Channel Host/模型/知识服务的配置与探活）。
 * DATABASE_URL / REDIS_URL / 端口等基础设施来自 .env，标注「改 .env 重启生效」。
 */
import { onMounted, ref } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
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
  <div class="space-y-6">
    <!-- 服务探活 -->
    <Card>
      <CardHeader>
        <CardTitle>服务探活（只读）</CardTitle>
        <CardAction>
          <Button variant="outline" size="sm" :disabled="loading" @click="load">
            <RefreshCw class="size-4" :class="loading && 'animate-spin'" />
            刷新
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div v-if="loading" class="space-y-4">
          <Skeleton v-for="n in 4" :key="n" class="h-9 w-full" />
        </div>
        <Alert v-else-if="error" variant="destructive">
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>
        <div v-else-if="status" class="space-y-4">
          <div
            v-for="service in status.services"
            :key="service.key"
            class="flex flex-col gap-0.5 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
          >
            <span class="shrink-0 text-sm font-medium">{{ service.name }}</span>
            <span class="text-sm text-muted-foreground">
              {{ service.configuration.summary }} · {{ service.health.summary }}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 基础设施 -->
    <Card>
      <CardHeader>
        <CardTitle>基础设施（.env，只读）</CardTitle>
        <CardDescription>
          修改 .env 后需要重启服务（weflowctl dev down &amp;&amp; dev up）才生效；
          运行时可调项（模型 / 开关 / 行为参数 / 群策略）在对应分区保存即时生效。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="space-y-4">
          <div
            v-for="env in ENV_KEYS"
            :key="env.key"
            class="flex flex-col gap-0.5 border-b pb-4 last:border-b-0 last:pb-0 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
          >
            <span class="shrink-0 text-sm font-medium">{{ env.label }}</span>
            <code class="font-mono text-xs text-muted-foreground">{{ env.key }}</code>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- 部署形态 -->
    <Card>
      <CardHeader>
        <CardTitle>部署形态</CardTitle>
        <CardDescription>
          Weflow 是单进程部署、配置集中、可高效热更新的 AI 客服产品：Core API、
          Agent Worker、Ingestion Worker 与 Channel Host 同机部署，配置以设置中心为准，
          .env 仅承担首次部署种子与基础设施连接。Windows 桌面端封装在后续阶段交付。
        </CardDescription>
      </CardHeader>
    </Card>
  </div>
</template>
