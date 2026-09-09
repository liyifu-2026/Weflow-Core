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
import { X } from "lucide-vue-next";

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
  <span class="inline-flex">
    <span
      v-if="state === 'loading'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      正在加载图片…
    </span>
    <span
      v-else-if="state === 'failed'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      图片暂时无法加载
    </span>
    <button
      v-else
      class="block cursor-pointer overflow-hidden rounded-md transition-colors"
      type="button"
      :aria-label="alt || '查看图片'"
      @click="openFullscreen"
    >
      <img
        :src="objectUrl"
        :alt="alt || '客户发送的图片'"
        class="block max-h-48 max-w-60 rounded-md border border-border bg-muted object-cover"
      />
    </button>
  </span>

  <Teleport to="body">
    <div
      v-if="fullscreen"
      class="fixed inset-0 z-100 flex items-center justify-center bg-black/70"
      role="dialog"
      aria-modal="true"
      @click="fullscreen = false"
    >
      <img
        :src="fullscreenUrl || objectUrl"
        :alt="alt || '客户发送的图片'"
        class="max-h-[86vh] max-w-[90vw] rounded-md object-contain"
        @click.stop
      />
      <button
        class="absolute top-4 right-4 inline-flex h-9 w-9 items-center justify-center rounded-full bg-background/80 text-foreground transition-colors hover:bg-background"
        aria-label="关闭"
        @click="fullscreen = false"
      >
        <X :size="18" />
      </button>
    </div>
  </Teleport>
</template>
