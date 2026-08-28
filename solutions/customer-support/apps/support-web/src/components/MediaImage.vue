<script setup lang="ts">
/**
 * Authenticated image message.
 *
 * mediaId → authenticated fetch → Blob → object URL → thumbnail.
 * The object URL is revoked on unmount; the full-screen overlay is a single
 * layer (never nested inside drawers). A 404/403 renders a friendly fallback
 * instead of guessing from text.
 */
import { onMounted, onUnmounted, ref } from "vue";

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

/** 全屏打开时优先加载原图（高清），失败降级为已加载的缩略图 */
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
  <span class="wf-media-message">
    <span v-if="state === 'loading'" class="wf-media-placeholder">
      正在加载图片…
    </span>
    <span v-else-if="state === 'failed'" class="wf-media-placeholder">
      图片暂时无法加载
    </span>
    <button
      v-else
      class="wf-media-thumb"
      type="button"
      :aria-label="alt || '查看图片'"
      @click="openFullscreen"
    >
      <img :src="objectUrl" :alt="alt || '客户发送的图片'" />
    </button>
  </span>

  <button
    v-if="fullscreen"
    class="wf-drawer-backdrop"
    aria-label="关闭图片"
    @click="fullscreen = false"
  ></button>
  <div
    v-if="fullscreen"
    class="wf-media-fullscreen"
    role="dialog"
    aria-modal="true"
    @click="fullscreen = false"
  >
    <img
      :src="fullscreenUrl || objectUrl"
      :alt="alt || '客户发送的图片'"
      @click.stop
    />
    <button class="wf-icon-button wf-media-close" aria-label="关闭" @click="fullscreen = false">
      ×
    </button>
  </div>
</template>

