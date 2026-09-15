<script setup lang="ts">
/**
 * Authenticated voice message bubble.
 *
 * mediaId → authenticated fetch (cookie) → Blob → object URL → Audio.
 * Shows play/pause + duration (MP3 bitrate estimate first, calibrated by
 * loadedmetadata). Transcription text is fetched from the media metadata.
 * audio/silk (converter unavailable upstream) renders an unplayable
 * placeholder; the transcription still displays if available.
 * 拉取生命周期来自 useAuthenticatedBlob：audio/silk 用 onResponse 门控
 * 自行处置；Audio 装配与 MP3 时长估算走 onBlob 回调。
 */
import { computed, onMounted, onUnmounted, ref } from "vue";
import { Pause, Play } from "lucide-vue-next";
import { useAuthenticatedBlob } from "../composables/use-authenticated-blob";

const props = defineProps<{ mediaId: string; alt?: string }>();

const playing = ref(false);
const durationSeconds = ref<number | null>(null);
const transcription = ref("");
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

const silk = ref(false);
const blobLifecycle = useAuthenticatedBlob({
  url: () => `/api/v1/media/${encodeURIComponent(props.mediaId)}/content`,
  onResponse: (response) => {
    if ((response.headers.get("content-type") ?? "").includes("audio/silk")) {
      silk.value = true;
      return true;
    }
    return false;
  },
  onBlob: (blob) => {
    audio = new Audio(blobLifecycle.objectUrl.value);
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
    void estimateMp3Seconds(blob).then((seconds) => {
      durationSeconds.value = seconds;
    });
  },
});
// 组件展示态在通用 loading/ready/failed 之上多一个 silk（不可播放占位）
const state = computed(() =>
  silk.value ? ("silk" as const) : blobLifecycle.status.value,
);
const objectUrl = blobLifecycle.objectUrl;

// 转写文字（语音气泡下方展示；失败不影响播放）
onMounted(() => {
  void (async () => {
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
  })();
});

function togglePlay() {
  if (!audio) return;
  if (audio.paused) void audio.play().catch(() => undefined);
  else audio.pause();
}

const durationLabel = computed(() =>
  durationSeconds.value == null
    ? '--″'
    : `${Math.max(1, Math.round(durationSeconds.value))}″`,
);

onUnmounted(() => {
  audio?.pause();
});
</script>

<template>
  <span class="inline-flex max-w-[260px] flex-col gap-1">
    <span
      v-if="state === 'loading'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      正在加载语音…
    </span>
    <span
      v-else-if="state === 'failed'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      语音暂时无法加载
    </span>
    <span
      v-else-if="state === 'silk'"
      class="inline-flex items-center rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground"
    >
      〔语音消息〕无法播放
    </span>
    <button
      v-else
      class="inline-flex min-w-24 max-w-55 items-center gap-2 rounded-md bg-muted px-3 py-2 text-foreground transition-colors hover:bg-accent"
      type="button"
      :aria-label="playing ? '暂停语音' : '播放语音'"
      @click="togglePlay"
    >
      <component
        :is="playing ? Pause : Play"
        :size="18"
        aria-hidden="true"
        class="shrink-0 text-foreground"
      />
      <span class="text-xs tabular-nums text-muted-foreground">{{ durationLabel }}</span>
    </button>
    <span v-if="transcription" class="text-xs leading-snug text-muted-foreground">{{
      transcription
    }}</span>
  </span>
</template>
