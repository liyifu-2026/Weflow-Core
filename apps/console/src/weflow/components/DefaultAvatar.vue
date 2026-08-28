<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  loadUserAvatarPresets,
  presetImageUrl,
  presetIndexForSeed,
} from "./user-avatar-presets";

const props = withDefaults(defineProps<{ name?: string; size?: number }>(), {
  name: "",
  size: 30,
});

/**
 * 默认客服头像：平台预设头像（DiceBear Blobs）。
 * 与后端 GET /api/v1/users/:userId/avatar 的默认分配同源同算法
 * （按用户名哈希稳定分配），保证任意位置显示同一客服的同一默认头像。
 * 预设清单尚未加载完成或加载失败时，短暂降级为首字母占位。
 */
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
  const seed = props.name || "?";
  return presetImageUrl(presets.value[presetIndexForSeed(seed, presets.value.length)]);
});

const fallbackLetter = computed(() =>
  (props.name || "?").trim().slice(0, 1).toUpperCase(),
);
</script>

<template>
  <span
    class="default-avatar"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-hidden="true"
  >
    <img
      v-if="preset"
      :src="preset"
      :width="size"
      :height="size"
      alt=""
    />
    <span v-else class="default-avatar-letter">{{ fallbackLetter }}</span>
  </span>
</template>

<style scoped>
.default-avatar {
  display: inline-grid;
  place-items: center;
  overflow: hidden;
  border-radius: 50%;
  flex-shrink: 0;
  background: #e8f0fe;
}
.default-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.default-avatar-letter {
  color: #1a56c4;
  font-weight: 700;
  font-size: 0.7em;
  line-height: 1;
}
</style>
