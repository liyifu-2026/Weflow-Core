<script setup lang="ts">
/**
 * 客服头像选择器（上传头像）。
 *
 * 打开后可选择平台预设头像（来自 Core 预设清单），或自定义上传
 * （JPG / PNG / WebP，≤ 1MB），也可恢复默认（按用户名哈希分配的预设）。
 * 任一操作成功后发出 saved（父级刷新头像），并自动关闭。
 */
import { ref, watch } from "vue";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "./WfIcon.vue";
import {
  loadUserAvatarPresets,
  presetImageUrl,
  type UserAvatarPreset,
} from "./user-avatar-presets";

const props = defineProps<{
  open: boolean;
  /** 当前生效的预设 id（自定义上传/默认时为 null） */
  currentPresetId?: string | null;
}>();

const emit = defineEmits<{ close: []; saved: [] }>();

const auth = useWeflowAuthStore();
const presets = ref<UserAvatarPreset[]>([]);
const busy = ref<"" | "preset" | "upload" | "reset">("");
const error = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
const appliedPreset = ref<string | null>(props.currentPresetId ?? null);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    error.value = "";
    appliedPreset.value = props.currentPresetId ?? null;
    loadUserAvatarPresets()
      .then((list) => {
        presets.value = list;
      })
      .catch(() => {
        error.value = "预设头像加载失败，请重试";
      });
  },
);
watch(
  () => props.currentPresetId,
  (value) => {
    appliedPreset.value = value ?? null;
  },
);

function messageOf(reason: unknown): string {
  return reason instanceof Error && reason.message
    ? reason.message
    : "头像保存失败，请重试";
}

async function applyPreset(id: string) {
  if (busy.value) return;
  busy.value = "preset";
  error.value = "";
  try {
    await auth.selectAvatarPreset(id);
    appliedPreset.value = id;
    emit("saved");
    emit("close");
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = "";
  }
}

async function resetDefault() {
  if (busy.value) return;
  busy.value = "reset";
  error.value = "";
  try {
    await auth.selectAvatarPreset(null);
    appliedPreset.value = null;
    emit("saved");
    emit("close");
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = "";
  }
}

async function onFilePicked(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || busy.value) return;
  busy.value = "upload";
  error.value = "";
  try {
    await auth.uploadAvatar(file);
    appliedPreset.value = null;
    emit("saved");
    emit("close");
  } catch (reason) {
    error.value = messageOf(reason);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <!-- 抽屉带 transform 动画会把 fixed 定位变成相对包含块，必须挂到文档根部 -->
  <Teleport to="body">
    <div v-if="open" class="wf-modal-mask" @click.self="emit('close')">
    <div
      class="wf-modal wf-modal-narrow"
      role="dialog"
      aria-modal="true"
      aria-label="上传头像"
    >
      <div class="wf-modal-head">
        <h3>上传头像</h3>
        <button class="wf-button ghost" @click="emit('close')">
          <WfIcon name="close" :size="17" />
        </button>
      </div>
      <div class="wf-modal-body">
        <p class="wf-muted wf-avatar-picker-hint">
          选择平台预设头像，或上传自定义图片（JPG / PNG / WebP，不超过 1MB）。
        </p>
        <div class="wf-avatar-picker-grid">
          <button
            v-for="preset in presets"
            :key="preset.id"
            type="button"
            class="wf-avatar-picker-option"
            :class="{ active: appliedPreset === preset.id }"
            :disabled="busy !== ''"
            :title="preset.name"
            @click="applyPreset(preset.id)"
          >
            <img :src="presetImageUrl(preset) ?? ''" :alt="preset.name" />
          </button>
        </div>
        <div class="wf-avatar-picker-actions">
          <button
            class="wf-button primary"
            :disabled="busy !== ''"
            @click="fileInput?.click()"
          >
            <span v-if="busy === 'upload'" class="wf-spinner"></span>
            {{ busy === "upload" ? "上传中" : "自定义上传" }}
          </button>
          <button class="wf-button" :disabled="busy !== ''" @click="resetDefault">
            {{ busy === "reset" ? "恢复中" : "恢复默认" }}
          </button>
          <input
            ref="fileInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="wf-file-hidden"
            @change="onFilePicked"
          />
        </div>
        <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
      </div>
    </div>
    </div>
  </Teleport>
</template>

<style scoped>
.wf-avatar-picker-hint {
  margin: 0 0 12px;
  font-size: 12px;
}
.wf-avatar-picker-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
.wf-avatar-picker-option {
  padding: 0;
  border: 2px solid transparent;
  border-radius: 12px;
  background: none;
  cursor: pointer;
  overflow: hidden;
  aspect-ratio: 1;
}
.wf-avatar-picker-option img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 10px;
}
.wf-avatar-picker-option:hover {
  border-color: var(--wf-primary-soft);
}
.wf-avatar-picker-option.active {
  border-color: var(--wf-primary);
}
.wf-avatar-picker-option:disabled {
  cursor: default;
  opacity: 0.6;
}
.wf-avatar-picker-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.wf-file-hidden {
  display: none;
}
</style>
