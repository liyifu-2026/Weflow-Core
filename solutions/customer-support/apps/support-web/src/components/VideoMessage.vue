<script setup lang="ts">
/**
 * Authenticated video message bubble.
 *
 * mediaId → authenticated fetch (cookie) → Blob → object URL → <video>。
 * 拉取生命周期来自 useAuthenticatedBlob（含模块级 blob 缓存，重挂不重下）。
 */
import { useAuthenticatedBlob } from "../composables/use-authenticated-blob";

const props = defineProps<{ mediaId: string; alt?: string }>();

const {
  status,
  objectUrl,
  load: reload,
} = useAuthenticatedBlob({
  url: () => `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
});
</script>

<template>
  <span class="inline-flex max-w-[300px] flex-col">
    <span
      v-if="status === 'loading'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      正在加载视频…
    </span>
    <span
      v-else-if="status === 'failed'"
      class="inline-flex items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      视频暂时无法加载
      <button
        type="button"
        class="text-xs font-medium text-primary underline underline-offset-2"
        @click="reload()"
      >
        重试
      </button>
    </span>
    <video
      v-else
      :src="objectUrl"
      :aria-label="alt || '客户发送的视频'"
      class="block max-h-[300px] max-w-[300px] rounded-md border border-border bg-black"
      controls
      preload="metadata"
    />
  </span>
</template>
