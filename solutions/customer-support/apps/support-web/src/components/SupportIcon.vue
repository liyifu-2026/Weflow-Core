<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ name: string; size?: number }>();

const paths: Record<string, string[]> = {
  close: ["M6 6l12 12M18 6 6 18"],
};

const selected = computed(() => paths[props.name] ?? paths.close);
</script>

<template>
  <svg
    :width="size || 17"
    :height="size || 17"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="path in selected" :key="path" :d="path" />
  </svg>
</template>
