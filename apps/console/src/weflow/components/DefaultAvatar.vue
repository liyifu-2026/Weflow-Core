<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{ name?: string; size?: number }>(), {
  name: "",
  size: 30,
});

const variants = [
  "M24 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0ZM6 38c0-10 8-16 16-16s16 8 16 16",
  "M6 28c6-14 14 8 20-4s14 8 20-4M14 36h28",
  "M24 6l16 9v18l-16 9-16-9V15l16-9Z M14 24l10 6 10-6",
  "M6 30c5-16 9 8 13-2s8-16 13-2M6 38h36",
  "M24 18a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM24 12v24M8 30c6 8 24 8 30 0",
  "M5 32 14 18l6 8 7-12 6 9 9-11M5 38h38",
];

const seed = computed(() => {
  let h = 0;
  for (const ch of props.name || "W") h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % variants.length;
});
</script>

<template>
  <span
    class="default-avatar"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <svg :width="size" :height="size" viewBox="0 0 48 48">
      <rect width="48" height="48" rx="24" fill="currentColor" opacity="0.08" />
      <path
        :d="variants[seed]"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>
</template>

<style scoped>
.default-avatar {
  display: inline-grid;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  color: inherit;
}
</style>
