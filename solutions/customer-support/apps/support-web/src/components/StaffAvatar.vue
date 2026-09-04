<script setup lang="ts">
/**
 * 客服（坐席）头像组件。
 *
 * 优先级（与平台默认头像体系一致）：
 * 1. avatarUrl / GET /api/v1/users/:userId/avatar（cookie 鉴权）→ Blob → <img>
 * 2. 平台预设头像（DiceBear Blobs，GET /api/v1/users/avatar-presets），
 *    按显示名哈希稳定分配 —— 与 Core identity/application/avatar-presets 同源同算法。
 * 3. 预设清单不可用时降级为首字母占位。
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  loadUserAvatarPresets,
  presetImageUrl,
  presetIndexForSeed,
  type UserAvatarPreset,
} from "../user-avatar-presets";

const props = withDefaults(
  defineProps<{
    userId?: string | null;
    fallbackText: string;
    size?: number;
    /** 直接传入已知的头像相对路径（如 auth.me.avatarUrl），有值时优先用 <img src> 加载 */
    avatarUrl?: string | null;
  }>(),
  { size: 30, avatarUrl: null },
);

const state = ref<"loading" | "ready" | "failed">("loading");
const objectUrl = ref("");
let blobUrl: string | null = null;

const presets = ref<UserAvatarPreset[]>([]);

onMounted(() => {
  loadUserAvatarPresets()
    .then((list) => {
      presets.value = list;
    })
    .catch(() => {
      // 预设清单不可用：保持首字母占位
    });
});

const preset = computed(() => {
  if (!presets.value.length) return undefined;
  const seed = props.fallbackText || "W";
  return presets.value[presetIndexForSeed(seed, presets.value.length)];
});

const presetImage = computed(() => {
  if (!preset.value) return null;
  return presetImageUrl(preset.value);
});

const fallbackLetter = computed(() =>
  (props.fallbackText || "W").trim().slice(0, 1).toUpperCase(),
);

async function load() {
  // 如果有 avatarUrl 相对路径，直接用 <img> 加载（走 authenticated fetch 拿 blob）
  const target = props.avatarUrl || (props.userId ? `/api/v1/users/${encodeURIComponent(props.userId)}/avatar` : null);
  if (!target) {
    state.value = "failed";
    return;
  }
  state.value = "loading";
  try {
    const response = await fetch(target, { credentials: "include" });
    if (!response.ok) throw new Error(`avatar ${response.status}`);
    const blob = await response.blob();
    blobUrl = URL.createObjectURL(blob);
    objectUrl.value = blobUrl;
    state.value = "ready";
  } catch {
    state.value = "failed";
  }
}

onMounted(load);
watch(
  () => [props.userId, props.avatarUrl] as const,
  load,
);
onUnmounted(() => {
  if (blobUrl) URL.revokeObjectURL(blobUrl);
});
</script>

<template>
  <span
    class="inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="state === 'ready'"
      :src="objectUrl"
      :alt="fallbackText"
      class="block h-full w-full rounded-full object-cover"
    />
    <img
      v-else-if="presetImage"
      :src="presetImage"
      :width="size"
      :height="size"
      alt=""
      class="block h-full w-full rounded-full object-cover"
    />
    <span
      v-else
      class="inline-flex items-center justify-center rounded-full font-semibold text-primary"
      :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.max(10, Math.round(size * 0.42))}px` }"
    >
      {{ fallbackLetter }}
    </span>
  </span>
</template>
