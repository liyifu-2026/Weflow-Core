<script setup lang="ts">
/**
 * 设置中心 · ⑤ 通道分区：Channel Host 探活只读展示。
 * 通道协议细节属于 Channel Host；这里只展示平台视角的连接健康。
 */
import { onMounted, ref } from "vue";
import { RefreshCw } from "lucide-vue-next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
  <div class="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle>Channel Host（微信通道）</CardTitle>
        <CardDescription>
          通道协议细节属于 Channel Host；这里展示平台视角的连接健康。
        </CardDescription>
        <CardAction>
          <Button
            variant="outline"
            size="sm"
            :disabled="loading"
            @click="load"
          >
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
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium">连接状态</span>
            <Badge :variant="status.channelOnline ? 'secondary' : 'destructive'">
              {{ status.channelOnline ? "在线（15 秒内有事件心跳）" : "离线 / 未运行" }}
            </Badge>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium">排队中的 Turn</span>
            <span class="text-sm text-muted-foreground">{{ status.queuedTurnCount }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium">执行中的 Turn</span>
            <span class="text-sm text-muted-foreground">{{ status.runningTurnCount }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium">待处理人工会话</span>
            <span class="text-sm text-muted-foreground">{{ status.pendingHandoffCount }}</span>
          </div>
          <div class="flex items-center justify-between gap-4">
            <span class="text-sm font-medium">最近完成的 Turn</span>
            <span class="text-sm text-muted-foreground">
              {{ status.lastCompletedTurnAt ? new Date(status.lastCompletedTurnAt).toLocaleString() : "—" }}
            </span>
          </div>
          <p class="border-t pt-4 text-sm text-muted-foreground">
            发送节流与通道自动化参数由 Channel Host 进程管理（本部署内建）；如需调整通道侧参数请编辑
            Channel Host 配置并重启该进程。
          </p>
        </div>
      </CardContent>
    </Card>
  </div>
</template>
