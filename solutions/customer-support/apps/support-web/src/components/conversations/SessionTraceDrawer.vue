<script setup lang="ts">
/**
 * 决策轨迹抽屉：右侧 Sheet，展示 turn 事件时间线（Phase 3/4）。
 * 可观测性增强：思维链/模型原文折叠展示、逐步相对耗时、总耗时、
 * 失败/抑制横幅（status + errorCode/reasonCode 一眼可辨）。
 */
import { computed } from "vue";
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

const props = defineProps<{
  open: boolean;
  loading: boolean;
  trace: {
    turn: {
      turnId: string;
      status: string;
      model?: string;
      errorCode?: string | null;
      traceId?: string;
      startedAt?: string;
      completedAt?: string;
      /** 本回合落库的回复分段原文（BFF 已返回；用它复盘「到底发了几条」） */
      responseSegments?: string[] | null;
    } | null;
    events: {
      eventType: string;
      reasonCode?: string | null;
      payload?: Record<string, any>;
      createdAt: string;
    }[];
    /** 工具执行记录（BFF 联表 tool_executions）：参数/结果复盘用 */
    toolExecutions?: {
      executionId: string;
      toolName: string;
      status: string;
      errorCode?: string | null;
      arguments?: Record<string, string> | null;
      result?: Record<string, unknown> | null;
      createdAt: string;
      completedAt?: string | null;
    }[];
  } | null;
  eventLabels: Record<string, string>;
}>();

const emit = defineEmits<{ close: [] }>();

interface TimelineEvent {
  eventType: string;
  reasonCode?: string | null;
  payload?: Record<string, any>;
  createdAt: string;
}

interface ToolExecutionRow {
  executionId: string;
  toolName: string;
  status: string;
  errorCode?: string | null;
  arguments?: Record<string, string> | null;
  result?: Record<string, unknown> | null;
  createdAt: string;
  completedAt?: string | null;
}

/** 时间线统一行：决策事件 / 工具执行记录，按时间排序后统一计算步进耗时 */
type TimelineRow =
  | ({ kind: "event"; deltaMs: number } & TimelineEvent)
  | ({ kind: "tool"; deltaMs: number } & ToolExecutionRow);

const timeline = computed<TimelineRow[]>(() => {
  const eventRows = (props.trace?.events ?? []).map((event) => ({
    kind: "event" as const,
    ...event,
  }));
  const toolRows = (props.trace?.toolExecutions ?? []).map((tool) => ({
    kind: "tool" as const,
    ...tool,
  }));
  const merged = [...eventRows, ...toolRows].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
  return merged.map((row, index) => {
    const prev = index > 0 ? merged[index - 1] : undefined;
    const deltaMs = prev
      ? Math.max(0, new Date(row.createdAt).getTime() - new Date(prev.createdAt).getTime())
      : 0;
    return { ...row, deltaMs };
  });
});

const TOOL_STATUS: Record<string, { label: string; class: string }> = {
  planned: { label: "待执行", class: "text-muted-foreground" },
  running: { label: "执行中", class: "text-sky-600 dark:text-sky-400" },
  succeeded: { label: "成功", class: "text-emerald-600 dark:text-emerald-400" },
  failed: { label: "失败", class: "text-destructive" },
};

function toolStatusLabel(status: string): string {
  return TOOL_STATUS[status]?.label ?? status;
}
function toolStatusClass(status: string): string {
  return TOOL_STATUS[status]?.class ?? "text-muted-foreground";
}

/** 工具执行耗时（计划创建 → 完成） */
function toolDurationMs(row: ToolExecutionRow): number | null {
  if (!row.completedAt) return null;
  return Math.max(0, new Date(row.completedAt).getTime() - new Date(row.createdAt).getTime());
}

/** JSON 预览：格式化并截断，避免 fetch_url 大结果撑爆抽屉 */
function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) return "";
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 4_000 ? `${text.slice(0, 4_000)}\n…（已截断）` : text;
  } catch {
    return "";
  }
}

const totalDurationMs = computed(() => {
  const { startedAt, completedAt } = props.trace?.turn ?? {};
  if (!startedAt || !completedAt) return null;
  return Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());
});

const banner = computed(() => {
  const turn = props.trace?.turn;
  if (!turn) return null;
  if (turn.status === "failed") {
    return {
      tone: "border-destructive/40 bg-destructive/10 text-destructive",
      text: `本轮处理失败${turn.errorCode ? ` · ${turn.errorCode}` : ""}`,
    };
  }
  if (turn.status.startsWith("suppressed") || turn.status === "no_action") {
    return {
      tone: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
      text: `本轮未回复${turn.errorCode ? ` · ${turn.errorCode}` : ""}`,
    };
  }
  if (turn.status === "completed") {
    return {
      tone: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      text: "本轮已完成",
    };
  }
  return null;
});

const reasoningText = computed(() => {
  const event = (props.trace?.events ?? [])
    .filter((e) => e.eventType === "model_reasoning")
    .at(-1);
  const text = event?.payload?.reasoning;
  return typeof text === "string" && text.trim() ? text : null;
});

const modelOutput = computed(() => {
  const event = (props.trace?.events ?? [])
    .filter((e) => e.eventType === "model_call")
    .at(-1);
  const text = event?.payload?.modelOutput;
  return typeof text === "string" && text.trim() ? text : null;
});

/**
 * 本回合落库的回复分段：一条回复拆成多段时，客户看到的就是这几条。
 * 「同一句话发了两遍」这类投诉在这里能一眼对齐（逐条列出，不去重）。
 */
const replySegments = computed<string[]>(() => {
  const value = props.trace?.turn?.responseSegments;
  return Array.isArray(value)
    ? value.filter((segment): segment is string => typeof segment === "string")
    : [];
});

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m${seconds}s`;
}
</script>

<template>
  <Sheet :open="open" @update:open="(value) => !value && emit('close')">
    <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-[440px]">
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
            <template v-if="totalDurationMs !== null">
              <br />总耗时 {{ formatDuration(totalDurationMs) }}
            </template>
          </p>

          <div
            v-if="banner"
            class="rounded-md border px-3 py-2 text-sm font-medium"
            :class="banner.tone"
          >
            {{ banner.text }}
          </div>

          <details v-if="reasoningText" class="rounded-md border border-border bg-muted/30">
            <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              模型思维链
            </summary>
            <p class="whitespace-pre-wrap px-3 pb-3 text-xs leading-relaxed text-muted-foreground">{{ reasoningText }}</p>
          </details>

          <details v-if="modelOutput" class="rounded-md border border-border bg-muted/30">
            <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              模型原始输出
            </summary>
            <pre class="overflow-x-auto whitespace-pre-wrap px-3 pb-3 font-mono text-xs leading-relaxed text-muted-foreground">{{ modelOutput }}</pre>
          </details>

          <details v-if="replySegments.length" class="rounded-md border border-border bg-muted/30">
            <summary class="cursor-pointer select-none px-3 py-2 text-sm font-medium">
              本回合回复分段（{{ replySegments.length }} 段）
            </summary>
            <ol class="space-y-1 px-3 pb-3 text-xs leading-relaxed text-muted-foreground">
              <li
                v-for="(segment, index) in replySegments"
                :key="index"
                class="flex gap-2"
              >
                <span class="shrink-0 tabular-nums text-muted-foreground/60">{{ index + 1 }}.</span>
                <span class="whitespace-pre-wrap">{{ segment }}</span>
              </li>
            </ol>
          </details>

          <ol v-if="timeline.length" class="space-y-0">
            <li
              v-for="(row, index) in timeline"
              :key="`${row.kind}-${index}`"
              class="flex flex-wrap items-baseline gap-2 border-b border-border py-2 text-sm last:border-b-0"
            >
              <template v-if="row.kind === 'event'">
                <span class="tabular-nums text-muted-foreground">{{ messageTime(row.createdAt) }}</span>
                <span class="font-semibold">{{ eventLabels[row.eventType] ?? row.eventType }}</span>
                <span v-if="row.payload?.action" class="text-primary">{{ row.payload.action }}</span>
                <span v-if="row.reasonCode" class="text-xs text-muted-foreground">{{ row.reasonCode }}</span>
                <span
                  v-if="index > 0 && row.deltaMs > 0"
                  class="ml-auto tabular-nums text-xs text-muted-foreground/70"
                >+{{ formatDuration(row.deltaMs) }}</span>
                <span
                  v-if="row.eventType === 'model_call' && typeof row.payload?.latencyMs === 'number'"
                  class="w-full text-xs tabular-nums text-muted-foreground/70"
                >模型耗时 {{ formatDuration(row.payload.latencyMs) }} · tokens {{ row.payload?.usage?.totalTokens ?? "-" }}</span>
                <span
                  v-if="row.eventType === 'reply_held'"
                  class="w-full text-xs tabular-nums text-muted-foreground/70"
                >批次 {{ row.payload?.replyBatchId || "-" }}<template v-if="typeof row.payload?.heldFromSequence === 'number'"> · 从第 {{ row.payload.heldFromSequence }} 段起扣留</template> · 插话 {{ row.payload?.interjectionCount ?? "-" }} 条</span>
              </template>
              <template v-else>
                <span class="tabular-nums text-muted-foreground">{{ messageTime(row.createdAt) }}</span>
                <span class="font-semibold">工具执行 · {{ row.toolName }}</span>
                <span :class="toolStatusClass(row.status)">
                  {{ toolStatusLabel(row.status) }}<template v-if="row.status === 'failed' && row.errorCode"> · {{ row.errorCode }}</template>
                </span>
                <span
                  v-if="index > 0 && row.deltaMs > 0"
                  class="ml-auto tabular-nums text-xs text-muted-foreground/70"
                >+{{ formatDuration(row.deltaMs) }}</span>
                <span
                  v-if="toolDurationMs(row) !== null"
                  class="w-full text-xs tabular-nums text-muted-foreground/70"
                >工具耗时 {{ formatDuration(toolDurationMs(row)) }}</span>
                <details v-if="jsonPreview(row.arguments)" class="w-full rounded-md border border-border bg-muted/30">
                  <summary class="cursor-pointer select-none px-2 py-1.5 text-xs font-medium text-muted-foreground">参数</summary>
                  <pre class="max-h-40 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-xs leading-relaxed text-muted-foreground">{{ jsonPreview(row.arguments) }}</pre>
                </details>
                <details v-if="jsonPreview(row.result)" class="w-full rounded-md border border-border bg-muted/30">
                  <summary class="cursor-pointer select-none px-2 py-1.5 text-xs font-medium text-muted-foreground">执行结果</summary>
                  <pre class="max-h-40 overflow-auto whitespace-pre-wrap px-2 pb-2 font-mono text-xs leading-relaxed text-muted-foreground">{{ jsonPreview(row.result) }}</pre>
                </details>
              </template>
            </li>
          </ol>
          <p v-else class="text-xs text-muted-foreground">暂无可展示的决策事件。</p>
        </template>
      </div>
    </SheetContent>
  </Sheet>
</template>