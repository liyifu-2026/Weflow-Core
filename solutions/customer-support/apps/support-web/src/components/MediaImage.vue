<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import SupportIcon from "./SupportIcon.vue";

const props = defineProps<{ mediaId: string; alt?: string }>();

const state = ref<"loading" | "ready" | "failed">("loading");
const objectUrl = ref("");
const fullscreen = ref(false);
const fullscreenUrl = ref("");
let blobUrl: string | null = null;
let fullscreenBlobUrl: string | null = null;

async function load() {
  state.value = "loading";
  try {
    const response = await fetch(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error(`media ${response.status}`);
    const blob = await response.blob();
    blobUrl = URL.createObjectURL(blob);
    objectUrl.value = blobUrl;
    state.value = "ready";
  } catch {
    state.value = "failed";
  }
}

async function openFullscreen() {
  fullscreen.value = true;
  if (fullscreenUrl.value) return;
  try {
    const response = await fetch(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}/content/original`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error(`original ${response.status}`);
    const blob = await response.blob();
    fullscreenBlobUrl = URL.createObjectURL(blob);
    fullscreenUrl.value = fullscreenBlobUrl;
  } catch {
    fullscreenUrl.value = objectUrl.value;
  }
}

onMounted(load);
onUnmounted(() => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  if (fullscreenBlobUrl && fullscreenBlobUrl !== blobUrl)
    URL.revokeObjectURL(fullscreenBlobUrl);
});
</script>

<template>
  <span class="media-message">
    <span v-if="state === 'loading'" class="media-placeholder">正在加载图片…</span>
    <span v-else-if="state === 'failed'" class="media-placeholder">图片暂时无法加载</span>
    <button v-else class="media-thumb" type="button" :aria-label="alt || '查看图片'" @click="openFullscreen">
      <img :src="objectUrl" :alt="alt || '客户发送的图片'" />
    </button>
  </span>
  <div v-if="fullscreen" class="media-fullscreen" role="dialog" aria-modal="true" @click="fullscreen = false">
    <img :src="fullscreenUrl || objectUrl" :alt="alt || '客户发送的图片'" @click.stop />
    <button class="media-close" aria-label="关闭" @click="fullscreen = false"><SupportIcon name="close" :size="18" /></button>
  </div>
</template>

<style scoped>
.media-message { display: inline-block; }
.media-placeholder { padding: 8px 12px; color: var(--text-muted); font-size: 12px; }
.media-thumb { padding: 0; border: 0; background: transparent; cursor: pointer; }
.media-thumb img { max-width: 280px; max-height: 280px; border-radius: 10px; display: block; }
.media-fullscreen { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; background: rgba(0, 0, 0, 0.72); }
.media-fullscreen img { max-width: 90vw; max-height: 90vh; border-radius: 8px; }
.media-close { position: fixed; top: 16px; right: 16px; width: 36px; height: 36px; display: grid; place-items: center; border: 0; border-radius: 50%; background: rgba(255, 255, 255, 0.2); color: #ffffff; cursor: pointer; }
</style>
