<script setup lang="ts">
/**
 * 客服（坐席）头像组件。
 *
 * 优先级（与平台默认头像体系一致）：
 * 1. avatarUrl / GET /api/v1/users/:userId/avatar（cookie 鉴权）→ Blob → <img>
 * 2. 平台预设头像（DiceBear Blobs，GET /api/v1/users/avatar-presets），
 *    按显示名哈希稳定分配 —— 与 Core identity/application/avatar-presets 同源同算法。
 * 3. 预设清单不可用时降级为首字母占位。
 * 拉取生命周期来自 useAuthenticatedBlob（工作台媒体组件共用）。
 */
import { computed, onMounted, ref, watch } from "vue";
import {
  loadUserAvatarPresets,
  presetImageUrl,
  presetIndexForSeed,
  type UserAvatarPreset,
} from "../user-avatar-presets";
import { useAuthenticatedBlob } from "../composables/use-authenticated-blob";

const props = withDefaults(
  defineProps<{
    userId?: string | null;
    fallbackText: string;
    size?: number;
    /** 直接传入已知的头像相对路径（如 auth.me.avatarUrl），有值时优先用 <img src> 加载 */
    avatarUrl?: string | null;
    /** 预设占位头像的哈希种子；缺省用 fallbackText。展示其他客服时传其 userId，
     *  让加载期/取图失败时的占位预设也按人区分 */
    seed?: string | null;
  }>(),
  { size: 30, avatarUrl: null, seed: null },
);

const { status: state, objectUrl, load } = useAuthenticatedBlob({
  url: () =>
    props.avatarUrl ||
    (props.userId
      ? `/api/v1/users/${encodeURIComponent(props.userId)}/avatar`
      : null),
});

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
  const seed = props.seed || props.fallbackText || "W";
  return presets.value[presetIndexForSeed(seed, presets.value.length)];
});

const presetImage = computed(() => {
  if (!preset.value) return null;
  return presetImageUrl(preset.value);
});

const fallbackLetter = computed(() =>
  (props.fallbackText || "W").trim().slice(0, 1).toUpperCase(),
);

watch(
  () => [props.userId, props.avatarUrl] as const,
  () => void load(),
);
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
