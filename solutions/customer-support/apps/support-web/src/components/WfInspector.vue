<script setup lang="ts">
/**
 * Weflow 统一 Inspector（右侧上下文检查器）。
 *
 * 桌面（>1240px）：静态第三栏，宽度 --wf-inspector-width（360px），
 * 打开时平滑展开、关闭时收回（不遮挡 Workspace）。
 * 窄屏（<=1240px）：切换为 drawer 浮层 + backdrop。
 *
 * Inspector 支持层级导航：depth > 0 时显示「返回上一级」，用户可在
 * Inspector 内继续深入（如 联系人 → 历史对话），关闭后恢复原 Workspace。
 * Esc 关闭并把焦点还给触发元素。
 */
import { toRef } from "vue";
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
      class="wf-inspector-backdrop"
      v-show="open"
      aria-hidden="true"
      @click="emit('close')"
    ></div>
  </Teleport>
  <aside
    class="wf-inspector"
    :class="{
      open: open,
      'has-back': (depth ?? 0) > 0,
      overlay: variant === 'overlay',
    }"
    aria-label="上下文检查器"
  >
    <header class="wf-inspector-head">
      <button
        v-if="(depth ?? 0) > 0"
        class="wf-icon-button"
        aria-label="返回上一级"
        @click="emit('back')"
      >
        ←
      </button>
      <div class="wf-inspector-title">
        <strong>{{ title }}</strong>
        <span v-if="subtitle" class="wf-muted">{{ subtitle }}</span>
      </div>
      <div class="wf-inspector-actions">
        <slot name="actions" />
        <button
          class="wf-icon-button"
          aria-label="关闭"
          @click="emit('close')"
        >
          ×
        </button>
      </div>
    </header>
    <div class="wf-inspector-body">
      <slot />
    </div>
  </aside>
</template>

