<script setup lang="ts">
import { ref, toRef } from "vue";
import { useEscClose } from "../composables/use-esc-close";
import { useFocusTrap } from "../composables/use-focus-trap";
import WfIcon from "./WfIcon.vue";

const props = defineProps<{
  open: boolean;
  title: string;
  ariaLabel?: string;
}>();

const emit = defineEmits<{ close: [] }>();

const root = ref<HTMLElement | null>(null);
useEscClose(toRef(props, "open"), () => emit("close"));
useFocusTrap(root, toRef(props, "open"));
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="wf-drawer-backdrop" @click="emit('close')"></div>
    <aside
      v-if="open"
      ref="root"
      class="wf-drawer open"
      role="dialog"
      aria-modal="true"
      :aria-label="ariaLabel || title"
    >
      <header class="wf-drawer-head">
        <strong>{{ title }}</strong>
        <button class="wf-icon-button" aria-label="关闭" @click="emit('close')">
          <WfIcon name="close" :size="17" />
        </button>
      </header>
      <div class="wf-drawer-body">
        <slot />
      </div>
    </aside>
  </Teleport>
</template>
