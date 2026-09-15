<script setup lang="ts">
/**
 * 回合侧轨：消息区右缘的点列，每个点 = 一个回合
 * （AI 回复轮 / 人工处理轮 / 唤醒跟进），ChatGPT 式 minimap。
 * 交互：鼠标接近放大（dock 式）、悬停显示回合名、点击弹出
 * 回合摘要卡片（由父级同时跳转到对应消息）。数据由 ChatPane 组装。
 */
import { computed, ref } from "vue";
import { X, Route } from "lucide-vue-next";
import type { RailRound } from "./types";

const props = defineProps<{ rounds: RailRound[] }>();
const emit = defineEmits<{
  select: [round: RailRound];
  "open-trace": [turnId: string];
}>();

const railEl = ref<HTMLElement | null>(null);
const dotEls = ref<Array<HTMLElement | null>>([]);
const scales = ref<number[]>([]);
// 卡片按回合 key 追踪（index 会随新回合插入漂移）；切会话后 key 消失即自动关
const openKey = ref<string | null>(null);
const openIndex = computed(() =>
  props.rounds.findIndex((round) => round.key === openKey.value),
);
const openRound = computed(() =>
  openIndex.value >= 0 ? props.rounds[openIndex.value] : undefined,
);
const cardTop = ref(0);
// 悬停提示：挂在轨根节点上（点列 overflow 会裁剪按钮内的浮层）
const hovered = ref<{ text: string; top: number } | null>(null);

function setDotEl(index: number, el: unknown) {
  dotEls.value[index] = (el as HTMLElement) ?? null;
}

function onDotEnter(index: number, round: RailRound) {
  const root = railEl.value;
  const el = dotEls.value[index];
  if (!root || !el) return;
  const rootRect = root.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  hovered.value = {
    text: `${round.title} · ${round.timeText}`,
    top: rect.top - rootRect.top + rect.height / 2,
  };
}
function onDotLeave() {
  hovered.value = null;
}

/** dock 式接近放大：距指针越近点越大，80px 外回到原尺寸 */
const MAGNET_RADIUS = 80;
function onMouseMove(event: MouseEvent) {
  const next: number[] = [];
  for (const el of dotEls.value) {
    if (!el) {
      next.push(1);
      continue;
    }
    const rect = el.getBoundingClientRect();
    const distance = Math.abs(rect.top + rect.height / 2 - event.clientY);
    next.push(
      distance >= MAGNET_RADIUS
        ? 1
        : 1 + Math.cos((distance / MAGNET_RADIUS) * (Math.PI / 2)),
    );
  }
  scales.value = next;
}
function onMouseLeave() {
  scales.value = [];
}

function dotClass(round: RailRound): string {
  switch (round.tone) {
    case "ok":
      return "bg-emerald-500";
    case "warn":
      return "bg-amber-500";
    case "error":
      return "bg-destructive";
    case "running":
      return round.kind === "human"
        ? "animate-pulse bg-sky-600"
        : "animate-pulse bg-emerald-500";
    default:
      return round.kind === "wake"
        ? "border border-muted-foreground/60 bg-transparent"
        : "bg-sky-600";
  }
}

/** 点弹卡片：垂直居中于该点，越界时钳制在轨内 */
function toggleCard(index: number, round: RailRound) {
  if (openKey.value === round.key) {
    openKey.value = null;
    return;
  }
  openKey.value = round.key;
  const root = railEl.value;
  const el = dotEls.value[index];
  if (root && el) {
    const rootRect = root.getBoundingClientRect();
    const rect = el.getBoundingClientRect();
    const center = rect.top - rootRect.top + rect.height / 2;
    const half = Math.min(180, rootRect.height / 2 - 8);
    cardTop.value = Math.min(
      Math.max(center, half),
      Math.max(half, rootRect.height - half),
    );
  }
  emit("select", round);
}
</script>

<template>
  <div
    ref="railEl"
    class="relative flex w-7 shrink-0 flex-col items-center justify-center"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
  >
    <div
      v-if="rounds.length"
      class="relative z-20 flex max-h-full flex-col items-center gap-1.5 overflow-y-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <button
        v-for="(round, index) in rounds"
        :key="round.key"
        :ref="(el) => setDotEl(index, el)"
        class="group relative flex size-5 items-center justify-center rounded-full"
        @click="toggleCard(index, round)"
        @mouseenter="onDotEnter(index, round)"
        @mouseleave="onDotLeave()"
      >
        <span
          class="size-2 rounded-full transition-transform duration-100 ease-out"
          :class="[
            dotClass(round),
            openKey === round.key
              ? 'ring-2 ring-primary/40 ring-offset-1 ring-offset-background'
              : '',
          ]"
          :style="{ transform: `scale(${scales[index] ?? 1})` }"
        />
      </button>
    </div>

    <!-- 悬停提示：轨根节点层，避免被点列 overflow 裁剪 -->
    <div
      v-if="hovered"
      class="pointer-events-none absolute right-full z-40 mr-1.5 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
      :style="{ top: `${hovered.top}px` }"
    >
      {{ hovered.text }}
    </div>

    <!-- 回合摘要卡片：透明背板点击即关 -->
    <template v-if="openRound">
      <div class="fixed inset-0 z-10" @click="openKey = null" />
      <div
        class="absolute right-full z-30 mr-2 w-72 -translate-y-1/2 overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        :style="{ top: `${cardTop}px` }"
      >
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          <span class="size-2 shrink-0 rounded-full" :class="dotClass(openRound)" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ openRound.title }}</p>
            <p class="text-[11px] text-muted-foreground">{{ openRound.timeText }}</p>
          </div>
          <button
            class="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            @click="openKey = null"
          >
            <X class="size-3.5" />
          </button>
        </div>
        <div class="max-h-72 space-y-2 overflow-y-auto px-3 py-2 text-xs leading-relaxed">
          <p v-for="(line, i) in openRound.lines" :key="i" class="text-muted-foreground">
            {{ line }}
          </p>
          <div v-if="openRound.question" class="rounded-md bg-muted/60 px-2 py-1.5">
            <p class="mb-0.5 text-[11px] font-medium text-muted-foreground">客户</p>
            <p class="line-clamp-3">{{ openRound.question }}</p>
          </div>
          <div v-if="openRound.reply" class="rounded-md bg-secondary/70 px-2 py-1.5">
            <p class="mb-0.5 text-[11px] font-medium text-muted-foreground">AI 回复</p>
            <p class="line-clamp-3">{{ openRound.reply }}</p>
          </div>
          <div v-if="openRound.excerpt" class="rounded-md bg-muted/60 px-2 py-1.5">
            <p class="mb-0.5 text-[11px] font-medium text-muted-foreground">人工消息</p>
            <p class="line-clamp-3">{{ openRound.excerpt }}</p>
          </div>
          <details v-if="openRound.reasoning" class="rounded-md border border-border">
            <summary class="cursor-pointer select-none px-2 py-1.5 font-medium text-muted-foreground">
              思维链
            </summary>
            <p class="max-h-40 overflow-y-auto whitespace-pre-wrap px-2 pb-2 text-muted-foreground">
              {{ openRound.reasoning }}
            </p>
          </details>
        </div>
        <div v-if="openRound.turnId" class="border-t border-border px-3 py-2">
          <button
            class="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            @click="emit('open-trace', openRound.turnId)"
          >
            <Route class="size-3.5" />
            决策轨迹
          </button>
        </div>
      </div>
    </template>
  </div>
</template>
