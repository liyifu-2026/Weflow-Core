<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ name: string; size?: number }>();

const paths: Record<string, string[]> = {
  overview: ["M4 13h6V4H4v9Zm0 7h6v-4H4v4Zm10 0h6v-9h-6v9Zm0-16v4h6V4h-6Z"],
  conversations: [
    "M20 11a8 8 0 0 1-8 8 9 9 0 0 1-3.7-.8L4 20l1.4-4A8 8 0 1 1 20 11Z",
  ],
  knowledge: [
    "M5 4.5A2.5 2.5 0 0 1 7.5 2H12v18H7.5A2.5 2.5 0 0 0 5 22V4.5Zm14 0A2.5 2.5 0 0 0 16.5 2H12v18h4.5A2.5 2.5 0 0 1 19 22V4.5Z",
  ],
  verify: [
    "m4 13 4 4L20 5",
    "M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h10",
  ],
  policy: ["M6 3h12v18l-6-3-6 3V3Z", "M9 8h6M9 12h6"],
  agent: ["M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z", "M4 21a8 8 0 0 1 16 0", "M19 5h3M20.5 3.5v3"],
  users: [
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2",
    "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
    "M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8",
  ],
  runtime: ["M4 14a8 8 0 1 1 16 0", "M12 14l4-4", "M4 14v5h16v-5"],
  audit: ["M6 3h12v18H6z", "M9 8h6M9 12h6M9 16h4"],
  engine: ["M12 3 4 7v10l8 4 8-4V7l-8-4Z", "M8 9h8M8 13h8M8 17h5"],
  collapse: ["m14 18-6-6 6-6"],
  sun: [
    "M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
    "M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  ],
  moon: ["M20 15.5A8.5 8.5 0 0 1 8.5 4 8.5 8.5 0 1 0 20 15.5Z"],
  search: ["M20 20l-4-4", "M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"],
  refresh: ["M20 7v5h-5", "M19 12a7 7 0 1 0-2 5"],
  chevron: ["m9 18 6-6-6-6"],
  more: ["M5 12h.01M12 12h.01M19 12h.01"],
  send: ["m22 2-7 20-4-9-9-4 20-7Z", "M22 2 11 13"],
  alert: ["M12 3 2 21h20L12 3Z", "M12 9v5M12 18h.01"],
  check: ["m5 12 4 4L19 6"],
  upload: ["M12 16V4m0 0L7 9m5-5 5 5", "M4 16v4h16v-4"],
  plus: ["M12 5v14M5 12h14"],
  logout: [
    "M10 17l5-5-5-5M15 12H3",
    "M14 4h5a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-5",
  ],
};

const selected = computed(() => paths[props.name] ?? paths.more);
</script>

<template>
  <svg
    :width="size || 18"
    :height="size || 18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="path in selected" :key="path" :d="path" />
  </svg>
</template>

