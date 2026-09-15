<script setup lang="ts">
/**
 * Authenticated image message.
 *
 * mediaId → authenticated fetch → Blob → object URL → thumbnail.
 * The object URL is revoked on unmount; the full-screen overlay is a single
 * layer (never nested inside drawers). A 404/403 renders a friendly fallback
 * instead of guessing from text.
 * 缩略图拉取生命周期来自 useAuthenticatedBlob；全屏原图是惰性的第二路
 * 拉取（打开时才请求），失败降级为已加载的缩略图。
 */
import { onUnmounted, ref } from "vue";
import { X } from "lucide-vue-next";
import {
  cachedAuthenticatedBlob,
  useAuthenticatedBlob,
} from "../composables/use-authenticated-blob";

const props = defineProps<{ mediaId: string; alt?: string }>();

const {
  status: state,
  objectUrl,
  load: reload,
} = useAuthenticatedBlob({
  url: () => `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
});

const fullscreen = ref(false);
const fullscreenUrl = ref("");
let fullscreenBlobUrl: string | null = null;

/** 全屏打开时优先加载原图（高清），失败降级为已加载的缩略图 */
async function openFullscreen() {
  fullscreen.value = true;
  if (fullscreenUrl.value) return;
  try {
    const blob = await cachedAuthenticatedBlob(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}/content/original`,
    );
    fullscreenBlobUrl = URL.createObjectURL(blob);
    fullscreenUrl.value = fullscreenBlobUrl;
  } catch {
    fullscreenUrl.value = objectUrl.value;
  }
}

onUnmounted(() => {
  if (fullscreenBlobUrl && fullscreenBlobUrl !== objectUrl.value)
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
      class="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      图片暂时无法加载
      <button
        type="button"
        class="text-xs font-medium text-primary underline underline-offset-2"
        @click="reload()"
      >
        重试
      </button>
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
        loading="lazy"
        decoding="async"
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
