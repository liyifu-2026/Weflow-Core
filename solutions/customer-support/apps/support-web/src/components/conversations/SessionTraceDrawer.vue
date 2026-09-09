<script setup lang="ts">
/**
 * 决策轨迹抽屉：右侧 Sheet，展示 turn 事件时间线（Phase 3/4）。
 */
import { X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { messageTime } from "./types";

defineProps<{
  open: boolean;
  loading: boolean;
  trace: {
    turn: { turnId: string; status: string; model?: string; traceId?: string; startedAt?: string; completedAt?: string } | null;
    events: { eventType: string; reasonCode?: string | null; payload?: Record<string, any>; createdAt: string }[];
  } | null;
  eventLabels: Record<string, string>;
}>();

const emit = defineEmits<{ close: [] }>();

function eventLabel(eventType: string): string {
  // 父级传入的 TRACE_EVENT_LABELS；未知类型原样展示
  return eventType;
}
</script>

<template>
  <Sheet :open="open" @update:open="(value) => !value && emit('close')">
    <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-[420px]">
      <SheetHeader class="text-left">
        <SheetTitle>决策轨迹</SheetTitle>
        <SheetDescription class="sr-only">Agent turn 的决策事件时间线</SheetDescription>
      </SheetHeader>
      <div class="space-y-4 px-4 pb-6">
        <Skeleton v-if="loading" class="h-4 w-2/3" />
        <template v-else>
          <p v-if="trace?.turn" class="break-all font-mono text-xs leading-relaxed text-muted-foreground">
            {{ trace.turn.turnId }}<br />
            模型 {{ trace.turn.model || "-" }} · 状态
            {{ trace.turn.status }} · traceId
            {{ trace.turn.traceId || "-" }}
          </p>
          <ol v-if="trace?.events?.length" class="space-y-0">
            <li
              v-for="(event, index) in trace.events"
              :key="index"
              class="flex flex-wrap items-baseline gap-2 border-b border-border py-2 text-sm last:border-b-0"
            >
              <span class="tabular-nums text-muted-foreground">{{ messageTime(event.createdAt) }}</span>
              <span class="font-semibold">{{ eventLabels[event.eventType] ?? event.eventType }}</span>
              <span v-if="event.payload?.action" class="text-primary">{{ event.payload.action }}</span>
              <span v-if="event.reasonCode" class="text-xs text-muted-foreground">{{ event.reasonCode }}</span>
            </li>
          </ol>
          <p v-else class="text-xs text-muted-foreground">暂无可展示的决策事件。</p>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>
