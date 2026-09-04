<script setup lang="ts">
/**
 * 接管条：Agent 处理中代替 Composer（能看≠能回复）。
 * 接管成功后由父级切到 Composer，entering 触发 180ms 状态转场。
 */
import { Button } from "@/components/ui/button";

defineProps<{ entering: boolean; actionBusy: boolean }>();
defineEmits<{ takeover: [] }>();
</script>

<template>
  <div
    class="flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-3"
    :class="{ 'animate-in fade-in slide-in-from-bottom-1 duration-200': entering }"
  >
    <div class="flex flex-col gap-0.5">
      <strong class="text-sm">Agent 正在处理此会话</strong>
      <span class="text-xs text-muted-foreground">接管后，Agent 将暂停回复，由你负责当前会话。</span>
    </div>
    <Button :disabled="actionBusy" @click="$emit('takeover')">
      {{ actionBusy ? "接管中…" : "接管处理" }}
    </Button>
  </div>
</template>
