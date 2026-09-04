<script setup lang="ts">
/**
 * Authenticated contact avatar.
 *
 * contactId → authenticated fetch (cookie) → Blob → object URL → <img>.
 * Missing contactId or any fetch failure renders the first character of
 * fallbackText as a muted letter block, keeping the same placeholder look.
 * The object URL is revoked on unmount.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    contactId?: string;
    fallbackText: string;
    size?: number;
  }>(),
  { size: 30 },
);

const state = ref<"loading" | "ready" | "failed">("loading");
const objectUrl = ref("");
let blobUrl: string | null = null;

const fallbackLetter = computed(() =>
  (props.fallbackText || "?").trim().slice(0, 1).toUpperCase(),
);

async function load() {
  if (!props.contactId) {
    state.value = "failed";
    return;
  }
  state.value = "loading";
  try {
    const response = await fetch(
      `/api/v1/contacts/${encodeURIComponent(props.contactId)}/avatar`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error(`avatar ${response.status}`);
    const blob = await response.blob();
    blobUrl = URL.createObjectURL(blob);
    objectUrl.value = blobUrl;
    state.value = "ready";
  } catch {
    state.value = "failed";
  }
}

onMounted(load);
watch(() => props.contactId, load);
onUnmounted(() => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="state === 'ready'"
      :src="objectUrl"
      :alt="fallbackText"
      class="block h-full w-full rounded-md object-cover"
    />
    <span
      v-else
      class="inline-flex h-full w-full items-center justify-center rounded-md bg-muted font-semibold text-muted-foreground"
      :style="{ fontSize: `${Math.max(10, Math.round(size * 0.42))}px` }"
      >{{ fallbackLetter }}</span
    >
  </span>
</template>
