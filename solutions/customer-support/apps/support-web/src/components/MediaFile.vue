<script setup lang="ts">
/**
 * Authenticated file message card（微信式文件卡片 + 圆形下载进度）.
 *
 * mediaId → authenticated fetch（流式读取）→ Blob → 下载/打开。
 * 圆形进度环：content-length 可用时按字节推进，不可用时转圈不定进度。
 * 完成后触发浏览器下载（保留原始文件名）；PDF/图片等浏览器可渲染类型
 * 提供「打开预览」。
 */
import { computed, onMounted, ref } from "vue";

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
  <div class="wf-file-wrap">
    <button
      class="wf-file-card"
      type="button"
      :aria-label="alt || `下载文件 ${fileName || ''}`"
      :disabled="state === 'loading'"
      @click="download"
    >
      <span class="wf-file-icon-wrap">
        <span class="wf-file-icon" data-type>{{ iconGlyph }}</span>
        <!-- 圆形进度环（微信式）：下载中覆盖在图标上 -->
        <svg
          v-if="state === 'loading'"
          class="wf-file-progress"
          viewBox="0 0 36 36"
          aria-hidden="true"
        >
          <circle
            class="wf-file-progress-track"
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
          />
          <circle
            v-if="percent !== null"
            class="wf-file-progress-bar"
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            :stroke-dasharray="`${2 * Math.PI * 15.5}`"
            :stroke-dashoffset="`${2 * Math.PI * 15.5 * (1 - (progress ?? 0))}`"
          />
          <text
            v-if="percent !== null"
            class="wf-file-progress-text"
            x="18"
            y="22"
            text-anchor="middle"
          >{{ percent }}%</text>
        </svg>
      </span>
      <span class="wf-file-body">
        <span class="wf-file-name">{{ fileName || "附件" }}</span>
        <span class="wf-file-meta">
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
      <span v-if="state !== 'loading'" class="wf-file-arrow" aria-hidden="true">↓</span>
    </button>
    <button
      v-if="state === 'ready' && canPreview"
      class="wf-file-preview"
      type="button"
      @click="preview"
    >
      打开预览
    </button>
  </div>
</template>

<style scoped>
.wf-file-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.wf-file-card {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 240px;
  max-width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--wf-border, #e5e6eb);
  border-radius: 8px;
  background: var(--wf-surface, #fff);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease, border-color 0.15s ease;
}
.wf-file-card:hover {
  background: var(--wf-surface-hover, #f7f8fa);
}
.wf-file-card:disabled {
  cursor: default;
  opacity: 0.85;
}
.wf-file-icon-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  width: 38px;
  height: 38px;
}
.wf-file-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 6px;
  background: #4f7cff;
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.wf-file-progress {
  position: absolute;
  inset: -3px;
  width: 44px;
  height: 44px;
}
.wf-file-progress-track {
  stroke: rgba(79, 124, 255, 0.25);
  stroke-width: 2.5;
}
.wf-file-progress-bar {
  stroke: #4f7cff;
  stroke-width: 2.5;
  stroke-linecap: round;
  transform: rotate(-90deg);
  transform-origin: center;
  transition: stroke-dashoffset 0.2s ease;
}
.wf-file-progress-text {
  fill: #4f7cff;
  font-size: 9px;
  font-weight: 600;
}
.wf-file-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1 1 auto;
}
.wf-file-name {
  font-size: 13px;
  line-height: 1.35;
  color: var(--wf-text, #1f2329);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wf-file-meta {
  font-size: 11px;
  color: var(--wf-text-secondary, #8a8f99);
}
.wf-file-arrow {
  flex: 0 0 auto;
  color: var(--wf-text-secondary, #8a8f99);
  font-size: 14px;
}
.wf-file-preview {
  align-self: flex-start;
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 11px;
  color: #4f7cff;
  cursor: pointer;
}
.wf-file-preview:hover {
  text-decoration: underline;
}
</style>
