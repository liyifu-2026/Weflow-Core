<script setup lang="ts">
/**
 * 客服（坐席）头像组件。
 *
 * 优先级（与平台默认头像体系一致）：
 * 1. avatarUrl / GET /api/v1/users/:userId/avatar（cookie 鉴权）→ Blob → <img>
 * 2. 平台预设头像（DiceBear Blobs，GET /api/v1/users/avatar-presets），
 *    按显示名哈希稳定分配 —— 与 Console DefaultAvatar、Core
 *    identity/application/avatar-presets 同源同算法。
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
      // 预设清单不可用：保持首字母占位（与 Console DefaultAvatar 一致）
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
    class="wf-staff-avatar"
    :style="{ width: `${size}px`, height: `${size}px` }"
  >
    <img
      v-if="state === 'ready'"
      :src="objectUrl"
      :alt="fallbackText"
      class="wf-staff-avatar-img"
    />
    <img
      v-else-if="presetImage"
      :src="presetImage"
      :width="size"
      :height="size"
      alt=""
      class="wf-staff-avatar-img"
    />
    <span
      v-else
      class="wf-staff-avatar-fallback"
      :style="{ width: `${size}px`, height: `${size}px` }"
    >
      {{ fallbackLetter }}
    </span>
  </span>
</template>

<style scoped>
.wf-staff-avatar {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: 50%;
}
.wf-staff-avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.wf-staff-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: #e8f0fe;
  color: #1a56c4;
  font-weight: 700;
  font-size: 0.7em;
  line-height: 1;
}
</style>
