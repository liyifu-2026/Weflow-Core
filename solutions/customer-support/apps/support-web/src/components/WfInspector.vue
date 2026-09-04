<script setup lang="ts">
/**
 * Weflow 统一 Inspector（右侧上下文检查器）。
 *
 * 桌面（inline，三栏 Workspace 第三栏）：宽度 0 ↔ 320px 展开/收回，
 * 打开时平滑展开、关闭时收回（不遮挡 Workspace）。
 * overlay（单列页面）：固定右侧浮层 + backdrop。
 *
 * Inspector 支持层级导航：depth > 0 时显示「返回上一级」，用户可在
 * Inspector 内继续深入（如 联系人 → 历史对话），关闭后恢复原 Workspace。
 * Esc 关闭并把焦点还给触发元素。
 */
import { toRef } from "vue";
import { ArrowLeft, X } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { useEscClose } from "../composables/use-esc-close";

const props = defineProps<{
  open: boolean;
  title: string;
  subtitle?: string;
  /** 0 = 顶层上下文；>0 显示返回按钮 */
  depth?: number;
  /** inline：静态第三栏（三栏 Workspace 用）；overlay：始终为浮层（单列页面用） */
  variant?: "inline" | "overlay";
}>();
const emit = defineEmits<{ close: []; back: [] }>();

useEscClose(toRef(props, "open"), () => emit("close"));
</script>

<template>
  <Teleport to="body">
    <div
      v-show="open && variant === 'overlay'"
      class="fixed inset-x-0 top-10 bottom-0 z-89 bg-black/45"
      aria-hidden="true"
      @click="emit('close')"
    ></div>
  </Teleport>
  <aside
    class="flex min-w-0 flex-col overflow-hidden border-l border-border bg-background transition-[width,transform] duration-200 ease-in-out"
    :class="
      variant === 'overlay'
        ? [
            'fixed top-10 right-0 bottom-0 z-90 w-full max-w-[400px] shadow-lg',
            'translate-x-full',
            open && 'translate-x-0',
          ]
        : [
            'w-0',
            open && 'w-80',
          ]
    "
    aria-label="上下文检查器"
  >
    <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
      <Button
        v-if="(depth ?? 0) > 0"
        variant="ghost"
        size="icon"
        aria-label="返回上一级"
        @click="emit('back')"
      >
        <ArrowLeft :size="16" />
      </Button>
      <div class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-sm font-semibold">{{ title }}</span>
        <span v-if="subtitle" class="truncate text-xs text-muted-foreground">{{ subtitle }}</span>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <slot name="actions" />
        <Button variant="ghost" size="icon" aria-label="关闭" @click="emit('close')">
          <X :size="16" />
        </Button>
      </div>
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto">
      <slot />
    </div>
  </aside>
</template>
