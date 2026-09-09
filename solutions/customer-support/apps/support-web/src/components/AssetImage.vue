<script setup lang="ts">
/**
 * Authenticated asset thumbnail.
 * assetId → authenticated fetch → Blob → object URL → <img>.
 * 失败时回落为文件图标占位（文件类素材不加载预览）。
 * 根元素铺满父容器（父级负责裁切圆角）；加载中显示 Skeleton 式底色。
 */
import { onMounted, onUnmounted, ref } from "vue";
import { FileText } from "lucide-vue-next";
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
    class="block h-full w-full object-cover"
    :src="objectUrl"
    :alt="name || '素材预览'"
    loading="lazy"
  />
  <span
    v-else-if="state === 'loading'"
    class="flex h-full w-full items-center justify-center bg-muted/50 text-xs text-muted-foreground"
  >…</span>
  <span
    v-else
    class="flex h-full w-full items-center justify-center text-muted-foreground/60"
  >
    <FileText class="size-8" />
  </span>
</template>
