<script setup lang="ts">
/**
 * Authenticated voice message bubble.
 *
 * mediaId → authenticated fetch (cookie) → Blob → object URL → Audio.
 * Shows play/pause + duration (MP3 bitrate estimate first, calibrated by
 * loadedmetadata). Transcription text is fetched from the media metadata.
 * audio/silk (converter unavailable upstream) renders an unplayable
 * placeholder; the transcription still displays if available.
 */
import { computed, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{ mediaId: string; alt?: string }>();

const state = ref<"loading" | "ready" | "failed" | "silk">("loading");
const playing = ref(false);
const durationSeconds = ref<number | null>(null);
const transcription = ref("");
const objectUrl = ref("");
let blobUrl: string | null = null;
let audio: HTMLAudioElement | null = null;

/** MP3 时长估算：跳过 ID3v2 后找第一个 MPEG1 Layer III 帧头，按比特率估算 */
async function estimateMp3Seconds(blob: Blob): Promise<number | null> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const limit = Math.min(bytes.length, 256 * 1024);
    let offset = 0;
    if (
      bytes.length > 10 &&
      bytes[0] === 0x49 &&
      bytes[1] === 0x44 &&
      bytes[2] === 0x33
    ) {
      offset =
        10 +
        (((bytes[6] & 0x7f) << 21) |
          ((bytes[7] & 0x7f) << 14) |
          ((bytes[8] & 0x7f) << 7) |
          (bytes[9] & 0x7f));
    }
    const bitratesKbps = [
      0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
    ];
    for (let i = offset; i + 4 <= limit; i += 1) {
      if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
        const versionBits = (bytes[i + 1] >> 3) & 0x3; // 3 = MPEG1
        const layerBits = (bytes[i + 1] >> 1) & 0x3; // 1 = Layer III
        const bitrateIndex = (bytes[i + 2] >> 4) & 0xf;
        if (versionBits === 3 && layerBits === 1 && bitrateIndex < 15) {
          const kbps = bitratesKbps[bitrateIndex];
          if (kbps > 0) return (bytes.length * 8) / (kbps * 1000);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function load() {
  state.value = "loading";
  try {
    const response = await fetch(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
      { credentials: "include" },
    );
    if (!response.ok) throw new Error(`media ${response.status}`);
    if ((response.headers.get("content-type") ?? "").includes("audio/silk")) {
      state.value = "silk";
    } else {
      const blob = await response.blob();
      blobUrl = URL.createObjectURL(blob);
      objectUrl.value = blobUrl;
      audio = new Audio(blobUrl);
      audio.preload = "metadata";
      const syncDuration = () => {
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
          durationSeconds.value = audio.duration;
        }
      };
      audio.addEventListener("loadedmetadata", syncDuration);
      audio.addEventListener("durationchange", syncDuration);
      audio.addEventListener("play", () => {
        playing.value = true;
      });
      audio.addEventListener("pause", () => {
        playing.value = false;
      });
      audio.addEventListener("ended", () => {
        playing.value = false;
      });
      audio.load();
      durationSeconds.value = await estimateMp3Seconds(blob);
      state.value = "ready";
    }
  } catch {
    state.value = "failed";
  }
  // 转写文字（语音气泡下方展示；失败不影响播放）
  try {
    const meta = await fetch(
      `/api/v1/media/${encodeURIComponent(props.mediaId)}`,
      { credentials: "include" },
    );
    if (meta.ok) {
      const data = (await meta.json()) as { media?: { description?: string } };
      transcription.value = data.media?.description ?? "";
    }
  } catch {
    /* 转写文字缺失不阻塞气泡 */
  }
}

function togglePlay() {
  if (!audio) return;
  if (audio.paused) void audio.play().catch(() => undefined);
  else audio.pause();
}

const durationLabel = computed(() =>
  durationSeconds.value == null
    ? "--″"
    : `${Math.max(1, Math.round(durationSeconds.value))}″`,
);

onMounted(load);
onUnmounted(() => {
  audio?.pause();
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
</script>

<template>
  <span class="wf-voice-message">
    <span v-if="state === 'loading'" class="wf-media-placeholder">
      正在加载语音…
    </span>
    <span v-else-if="state === 'failed'" class="wf-media-placeholder">
      语音暂时无法加载
    </span>
    <span v-else-if="state === 'silk'" class="wf-media-placeholder"
      >〔语音消息〕无法播放</span
    >
    <button
      v-else
      class="wf-voice-bubble"
      type="button"
      :aria-label="playing ? '暂停语音' : '播放语音'"
      @click="togglePlay"
    >
      <span class="wf-voice-icon" aria-hidden="true">
        <svg
          v-if="!playing"
          viewBox="0 0 22 22"
          width="20"
          height="20"
          fill="currentColor"
        >
          <rect x="2" y="9" width="3" height="4" rx="1" />
          <rect x="7" y="6" width="3" height="10" rx="1" />
          <rect x="12" y="3" width="3" height="16" rx="1" />
          <rect x="17" y="8" width="3" height="6" rx="1" />
        </svg>
        <svg
          v-else
          class="wf-voice-wave-playing"
          viewBox="0 0 22 22"
          width="20"
          height="20"
          fill="currentColor"
        >
          <rect x="2" y="9" width="3" height="4" rx="1" class="wf-wave-bar b1" />
          <rect x="7" y="6" width="3" height="10" rx="1" class="wf-wave-bar b2" />
          <rect x="12" y="3" width="3" height="16" rx="1" class="wf-wave-bar b3" />
          <rect x="17" y="8" width="3" height="6" rx="1" class="wf-wave-bar b4" />
        </svg>
      </span>
      <span class="wf-voice-duration">{{ durationLabel }}</span>
    </button>
    <span v-if="transcription" class="wf-voice-transcription">{{
      transcription
    }}</span>
  </span>
</template>

<style scoped>
.wf-voice-message {
  display: inline-flex;
  flex-direction: column;
  gap: 4px;
  max-width: 260px;
}
.wf-voice-bubble {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 96px;
  max-width: 220px;
  padding: 8px 12px;
  border: 0;
  border-radius: 12px;
  background: var(--wf-surface-soft);
  color: var(--wf-text);
  cursor: pointer;
  font: inherit;
}
.wf-voice-bubble:hover {
  background: var(--wf-surface-hover);
}
/* 播放中波形动画（微信式） */
.wf-wave-bar {
  transform-origin: center;
  animation: wf-wave-bounce 0.9s ease-in-out infinite;
}
.wf-wave-bar.b1 {
  animation-delay: 0s;
}
.wf-wave-bar.b2 {
  animation-delay: 0.15s;
}
.wf-wave-bar.b3 {
  animation-delay: 0.3s;
}
.wf-wave-bar.b4 {
  animation-delay: 0.45s;
}
@keyframes wf-wave-bounce {
  0%,
  100% {
    transform: scaleY(0.55);
  }
  50% {
    transform: scaleY(1);
  }
}
.wf-voice-wave-playing {
  animation: wf-voice-pulse 0.9s ease-in-out infinite;
}
@keyframes wf-voice-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.wf-voice-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 11px;
}
.wf-voice-duration {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--wf-text-secondary);
}
.wf-voice-transcription {
  font-size: 12px;
  color: var(--wf-text-secondary);
  line-height: 1.4;
}
</style>

