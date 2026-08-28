<script setup lang="ts">
defineProps<{
  title: string;
  description?: string;
  eyebrow?: string;
}>();
</script>

<template>
  <header class="wf-page-head">
    <div>
      <p v-if="eyebrow" class="wf-eyebrow">{{ eyebrow }}</p>
      <h1>{{ title }}</h1>
      <p v-if="description" class="wf-page-subtitle">{{ description }}</p>
    </div>
    <div v-if="$slots.actions" class="wf-page-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.wf-page-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
