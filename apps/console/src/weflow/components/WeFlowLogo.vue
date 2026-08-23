<script setup lang="ts">
withDefaults(
  defineProps<{
    size?: number;
    showText?: boolean;
  }>(),
  { size: 26, showText: true },
);
</script>

<template>
  <span class="weflow-logo" :style="{ '--logo-size': `${size}px` }">
    <svg
      :width="size"
      :height="size"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 21c3-11 7 11 11 0s7 11 11 0" />
      <path d="M5 26h22" opacity=".35" />
    </svg>
    <span v-if="showText" class="weflow-logo-wordmark"><b>We</b>Flow</span>
  </span>
</template>

<style scoped>
.weflow-logo {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: currentColor;
  white-space: nowrap;
}
.weflow-logo svg {
  flex: 0 0 auto;
}
.weflow-logo-wordmark {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.weflow-logo-wordmark b {
  font-weight: 800;
}
</style>
