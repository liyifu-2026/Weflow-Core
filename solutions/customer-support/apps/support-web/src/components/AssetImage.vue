<script setup lang="ts">
/**
 * Authenticated asset thumbnail.
 * assetId → authenticated fetch → Blob → object URL → <img>.
 * 失败时回落为文件图标占位（文件类素材不加载预览）。
 */
import { onMounted, onUnmounted, ref } from "vue";
import { assetContentUrl } from "@/assets/api";

const props = defineProps<{ assetId: string; name?: string }>();

const objectUrl = ref("");
const state = ref<"loading" | "ready" | "failed">("loading");
let blobUrl: string | null = null;

async function load() {
  state.value = "loading";
  try {
    const response = await fetch(assetContentUrl(props.assetId), {
      credentials: "include",
    });
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const blob = await response.blob();
    blobUrl = URL.createObjectURL(blob);
    objectUrl.value = blobUrl;
    state.value = "ready";
  } catch {
    state.value = "failed";
  }
}

onMounted(load);
onUnmounted(() => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
</script>

<template>
  <img
    v-if="state === 'ready'"
    class="wf-asset-thumb-img"
    :src="objectUrl"
    :alt="name || '素材预览'"
    loading="lazy"
  />
  <span v-else-if="state === 'loading'" class="wf-asset-thumb-fallback">…</span>
  <span v-else class="wf-asset-thumb-fallback">🖼</span>
</template>

<style scoped>
.wf-asset-thumb-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.wf-asset-thumb-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--wf-text-muted, #8a93a6);
  font-size: 13px;
}
</style>
