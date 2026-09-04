<script setup lang="ts">
/**
 * Authenticated file message card（文件卡片 + 圆形下载进度）.
 *
 * mediaId → authenticated fetch（流式读取）→ Blob → 下载/打开。
 * 圆形进度环：content-length 可用时按字节推进，不可用时转圈不定进度。
 * 完成后触发浏览器下载（保留原始文件名）；PDF/图片等浏览器可渲染类型
 * 提供「打开预览」。
 */
import { computed, onMounted, ref } from "vue";
import { Download } from "lucide-vue-next";

const props = defineProps<{
  mediaId: string;
  /** 数据库中的原始文件名（stored_files.original_name） */
  fileName?: string | null;
  alt?: string;
}>();

const state = ref<"idle" | "loading" | "ready" | "failed">("idle");
/** 0-1；null = 不定进度（服务端未返回长度） */
const progress = ref<number | null>(null);
const sizeText = ref("");
const mimeType = ref("");
const downloadName = ref("");
const objectUrl = ref("");
const canPreview = ref(false);

const percent = computed(() =>
  progress.value === null ? null : Math.round(progress.value * 100),
);

const extension = computed(() => {
  const name = props.fileName || downloadName.value || "";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toUpperCase() : "文件";
});

const iconGlyph = computed(() => {
  switch (extension.value.toLowerCase()) {
    case "pdf":
      return "PDF";
    case "doc":
    case "docx":
      return "DOC";
    case "xls":
    case "xlsx":
      return "XLS";
    case "ppt":
    case "pptx":
      return "PPT";
    case "zip":
    case "rar":
    case "7z":
      return "ZIP";
    case "txt":
      return "TXT";
    case "mp4":
    case "mov":
      return "视频";
    default:
      return extension.value.slice(0, 4) || "文件";
  }
});

async function loadMetadata() {
  try {
    const response = await fetch(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error(`meta ${response.status}`);
    const payload = (await response.json()) as {
      media?: { mimeType?: string; size?: number };
    };
    mimeType.value = payload.media?.mimeType ?? "";
    const size = payload.media?.size;
    if (typeof size === "number" && size > 0) {
      sizeText.value =
        size >= 1024 * 1024
          ? `${(size / 1024 / 1024).toFixed(1)}MB`
          : `${Math.max(1, Math.round(size / 1024))}KB`;
    }
  } catch {
    // 元数据缺失不阻塞下载
  }
}

const PREVIEWABLE = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/plain",
];

function triggerDownload(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = downloadName.value || props.fileName || "attachment";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function openPreview(url: string) {
  window.open(url, "_blank", "noopener");
}

/** 流式拉取：按字节推进圆形进度；无长度时不定进度（转圈） */
async function fetchWithProgress(url: string): Promise<Blob> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error(`content ${response.status}`);
  const disposition = response.headers.get("content-disposition");
  if (disposition && !downloadName.value) {
    const utf8 = /filename\*=(?:UTF-8'')([^;]+)/i.exec(disposition);
    const ascii = /filename="([^"]+)"/i.exec(disposition);
    const raw = utf8?.[1] ?? ascii?.[1];
    if (raw) {
      try {
        downloadName.value = decodeURIComponent(raw.replace(/^"|"$/g, ""));
      } catch {
        downloadName.value = props.fileName || "attachment";
      }
    }
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : 0;
  if (!response.body || !total) {
    progress.value = null;
    return await response.blob();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    progress.value = Math.min(0.99, received / total);
  }
  progress.value = 1;
  return new Blob(chunks as BlobPart[], {
    type: response.headers.get("content-type") ?? "application/octet-stream",
  });
}

async function download() {
  if (state.value === "loading") return;
  state.value = "loading";
  progress.value = 0;
  try {
    const blob = await fetchWithProgress(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
    );
    if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
    objectUrl.value = URL.createObjectURL(blob);
    const effectiveMime =
      blob.type || mimeType.value || "application/octet-stream";
    canPreview.value = PREVIEWABLE.includes(effectiveMime.split(";")[0]);
    state.value = "ready";
    triggerDownload(objectUrl.value);
  } catch {
    state.value = "failed";
  }
}

function preview() {
  if (objectUrl.value) openPreview(objectUrl.value);
}

onMounted(loadMetadata);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-1">
    <button
      class="flex w-60 max-w-full items-center gap-2.5 rounded-md border border-border bg-background p-2.5 text-left transition-colors hover:bg-accent disabled:cursor-default disabled:opacity-85"
      type="button"
      :aria-label="alt || `下载文件 ${fileName || ''}`"
      :disabled="state === 'loading'"
      @click="download"
    >
      <span class="relative inline-flex h-9 w-9 shrink-0 items-center justify-center">
        <span
          class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground"
        >{{ iconGlyph }}</span>
        <!-- 圆形进度环：下载中覆盖在图标上 -->
        <svg
          v-if="state === 'loading'"
          class="absolute -inset-0.75 h-11 w-11"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <circle
            class="stroke-border"
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke-width="2.5"
          />
          <circle
            v-if="percent !== null"
            class="stroke-foreground"
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke-width="2.5"
            stroke-linecap="round"
            transform="rotate(-90 18 18)"
            :stroke-dasharray="`${2 * Math.PI * 15.5}`"
            :stroke-dashoffset="`${2 * Math.PI * 15.5 * (1 - (progress ?? 0))}`"
          />
          <text
            v-if="percent !== null"
            class="fill-foreground text-[9px] font-semibold"
            x="18"
            y="22"
            text-anchor="middle"
          >{{ percent }}%</text>
        </svg>
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-0.5">
        <span class="truncate text-[13px] leading-tight text-foreground">{{ fileName || "附件" }}</span>
        <span class="text-xs text-muted-foreground">
          {{
            state === "loading"
              ? percent === null
                ? "下载中…"
                : `下载中 ${percent}%`
              : state === "failed"
                ? "下载失败，点击重试"
                : sizeText || mimeType || "点击下载"
          }}
        </span>
      </span>
      <Download
        v-if="state !== 'loading'"
        :size="16"
        aria-hidden="true"
        class="shrink-0 text-muted-foreground"
      />
    </button>
    <button
      v-if="state === 'ready' && canPreview"
      class="self-start px-0.5 text-xs text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline"
      type="button"
      @click="preview"
    >
      打开预览
    </button>
  </div>
</template>
