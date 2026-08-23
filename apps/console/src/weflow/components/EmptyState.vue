<script setup lang="ts">
import WfIcon from "./WfIcon.vue";

withDefaults(
  defineProps<{
    title: string;
    description?: string;
    icon?: string;
  }>(),
  { icon: "search" },
);
</script>

<template>
  <div class="wf-empty">
    <div class="wf-empty-inner">
      <span class="wf-empty-icon" aria-hidden="true">
        <WfIcon :name="icon" :size="18" />
      </span>
      <strong>{{ title }}</strong>
      <p v-if="description">{{ description }}</p>
      <slot />
    </div>
  </div>
</template>

<style scoped>
.wf-empty-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  text-align: center;
}
.wf-empty-icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  margin-bottom: 6px;
  border: 1px dashed var(--wf-border-strong);
  border-radius: 12px;
  color: var(--wf-text-muted);
  background: var(--wf-surface-soft);
}
</style>
