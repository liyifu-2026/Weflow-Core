<script setup lang="ts">
/**
 * Authenticated contact avatar.
 *
 * contactId → authenticated fetch (cookie) → Blob → object URL → <img>.
 * Missing contactId or any fetch failure renders the first character of
 * fallbackText in the standard .wf-avatar letter block, keeping the same
 * placeholder look as before. The object URL is revoked on unmount.
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
    class="wf-avatar-image"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="state === 'ready'"
      :src="objectUrl"
      :alt="fallbackText"
      class="wf-avatar-img"
    />
    <span
      v-else
      class="wf-avatar"
      :style="{ width: `${size}px`, height: `${size}px` }"
      >{{ fallbackLetter }}</span
    >
  </span>
</template>

<style scoped>
.wf-avatar-image {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.wf-avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 9px;
  object-fit: cover;
}
</style>
