<script setup lang="ts">
/**
 * 客服个人资料页：显示当前用户信息 + 头像（预设网格 / 上传）+ 显示名编辑。
 * 所有客服均可访问（非 admin-only），用于管理自己的会话形象。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { ArrowLeft, Check, Loader2, RotateCcw } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import StaffAvatar from "../components/StaffAvatar.vue";
import {
  loadUserAvatarPresets,
  type UserAvatarPreset,
} from "../user-avatar-presets";

const auth = useWeflowAuthStore();
const router = useRouter();
void auth.ensureSession();

const uploading = ref(false);
const error = ref("");
const notice = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

// 预设头像清单（进程内缓存；失败时网格隐藏，不影响上传）
const presets = ref<UserAvatarPreset[]>([]);
const presetsLoading = ref(false);
// 正在应用的预设 id（乐观高亮 + 防连点）
const applyingPreset = ref<string | null>(null);
// null = 用户主动点了「恢复默认」
const applyingReset = ref(false);

// 显示名编辑草稿（空串提交 = 清除显示名，回落为用户名）
const nameDraft = ref<string | null>(null);
const savingName = ref(false);

const displayName = computed(
  () => auth.user?.displayName || auth.user?.username || "未登录",
);
const roleLabel = computed(() =>
  auth.user?.role === "admin" ? "管理员" : "客服",
);
const nameDirty = computed(
  () =>
    nameDraft.value !== null &&
    nameDraft.value.trim() !== (auth.user?.displayName ?? ""),
);

onMounted(() => {
  presetsLoading.value = true;
  loadUserAvatarPresets()
    .then((list) => {
      presets.value = list;
    })
    .catch(() => {
      // 预设清单不可用：隐藏网格，保留上传路径
    })
    .finally(() => {
      presetsLoading.value = false;
    });
  nameDraft.value = auth.user?.displayName ?? "";
});

// 直接刷新 /profile 时 ensureSession 尚未返回，user 加载完成后补填草稿
watch(
  () => auth.user?.displayName,
  (value) => {
    if (nameDraft.value === null && value) nameDraft.value = value;
  },
);

function flashNotice(message: string) {
  notice.value = message;
  error.value = "";
}

function flashError(reason: unknown, fallback: string) {
  error.value = reason instanceof Error ? reason.message : fallback;
  notice.value = "";
}

function activePresetId(presetId: string): boolean {
  return auth.user?.avatarPreset === presetId;
}

async function applyPreset(presetId: string) {
  if (applyingPreset.value || applyingReset.value) return;
  if (activePresetId(presetId)) return;
  applyingPreset.value = presetId;
  try {
    await auth.selectAvatarPreset(presetId);
    flashNotice("头像已更新，新头像将在会话中即时显示");
  } catch (reason) {
    flashError(reason, "设置失败，请稍后重试");
  } finally {
    applyingPreset.value = null;
  }
}

async function resetAvatar() {
  if (applyingPreset.value || applyingReset.value) return;
  applyingReset.value = true;
  try {
    await auth.selectAvatarPreset(null);
    flashNotice("已恢复默认头像");
  } catch (reason) {
    flashError(reason, "恢复默认失败，请稍后重试");
  } finally {
    applyingReset.value = false;
  }
}

function triggerFileSelect() {
  fileInput.value?.click();
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  // 清空 input 以便下次选同一文件时仍触发 change
  input.value = "";

  if (!file.type.match(/^image\/(jpeg|png|webp)$/)) {
    flashError(new Error("仅支持 JPEG、PNG、WebP 格式"), "");
    return;
  }
  if (file.size > 1024 * 1024) {
    flashError(new Error("头像文件不能超过 1 MB"), "");
    return;
  }

  uploading.value = true;
  try {
    await auth.uploadAvatar(file);
    flashNotice("头像已更新，新头像将在会话中即时显示");
  } catch (reason) {
    flashError(reason, "上传失败，请稍后重试");
  } finally {
    uploading.value = false;
  }
}

async function saveDisplayName() {
  if (!nameDirty.value || savingName.value || nameDraft.value === null) return;
  savingName.value = true;
  try {
    // 空串 = 清除显示名（null），回落为登录账号
    const trimmed = nameDraft.value.trim();
    await auth.updateProfile({
      displayName: trimmed.length > 0 ? trimmed : null,
    });
    nameDraft.value = auth.user?.displayName ?? "";
    flashNotice("显示名已保存");
  } catch (reason) {
    flashError(reason, "保存失败，请稍后重试");
  } finally {
    savingName.value = false;
  }
}

function goBack() {
  void router.push("/conversations");
}
</script>

<template>
  <div class="mx-auto w-full max-w-2xl p-6">
    <Button
      variant="ghost"
      size="sm"
      class="-ml-2 mb-4 text-muted-foreground"
      @click="goBack"
    >
      <ArrowLeft class="size-4" />
      返回工作台
    </Button>

    <h1 class="text-2xl font-semibold tracking-tight">个人资料</h1>
    <p class="mt-1 text-sm text-muted-foreground">
      管理你的客服头像和显示名。
    </p>

    <div class="mt-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>头像</CardTitle>
          <CardDescription>
            更换后 Mobile 端和网页端会同步显示新头像。
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex items-center gap-6">
            <div class="relative">
              <StaffAvatar
                :user-id="auth.user?.userId"
                :avatar-url="auth.user?.avatarUrl"
                :fallback-text="displayName"
                :size="80"
              />
              <span
                v-if="uploading"
                class="absolute inset-0 inline-flex items-center justify-center rounded-full bg-black/40"
              >
                <Loader2 class="size-5 animate-spin text-white" />
              </span>
            </div>
            <div class="space-y-2">
              <Button variant="outline" :disabled="uploading" @click="triggerFileSelect">
                <Loader2 v-if="uploading" class="size-4 animate-spin" />
                {{ uploading ? "上传中…" : "上传自定义头像" }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                :disabled="applyingReset"
                @click="resetAvatar"
              >
                <RotateCcw v-if="!applyingReset" class="size-4" />
                <Loader2 v-else class="size-4 animate-spin" />
                恢复默认
              </Button>
              <p class="text-xs text-muted-foreground">
                支持 JPEG / PNG / WebP，最大 1 MB。
              </p>
            </div>
          </div>

          <div v-if="presets.length > 0">
            <p class="mb-2 text-sm font-medium">或快速选择一个默认头像</p>
            <div class="flex flex-wrap gap-3">
              <button
                v-for="preset in presets"
                :key="preset.id"
                type="button"
                class="relative rounded-full transition"
                :class="
                  activePresetId(preset.id)
                    ? 'ring-2 ring-primary ring-offset-2 ring-offset-background'
                    : 'opacity-80 hover:opacity-100'
                "
                :aria-label="`预设头像 ${preset.name}`"
                :aria-pressed="activePresetId(preset.id)"
                :disabled="applyingPreset !== null || applyingReset"
                @click="applyPreset(preset.id)"
              >
                <img
                  v-if="preset.svgUrl"
                  :src="preset.svgUrl"
                  :alt="preset.name"
                  class="size-12 rounded-full object-cover"
                  width="48"
                  height="48"
                />
                <span
                  v-else
                  class="inline-flex size-12 items-center justify-center rounded-full bg-muted text-sm font-semibold text-primary"
                >
                  {{ preset.name.slice(0, 1) }}
                </span>
                <span
                  v-if="activePresetId(preset.id)"
                  class="absolute -right-0.5 -top-0.5 inline-flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
                >
                  <Check class="size-3" />
                </span>
                <span
                  v-if="applyingPreset === preset.id"
                  class="absolute inset-0 inline-flex items-center justify-center rounded-full bg-black/40"
                >
                  <Loader2 class="size-4 animate-spin text-white" />
                </span>
              </button>
            </div>
          </div>

          <p v-if="error" class="text-sm text-destructive" role="alert">
            {{ error }}
          </p>
          <p v-if="notice" class="text-sm text-muted-foreground" role="status">
            {{ notice }}
          </p>

          <input
            ref="fileInput"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            class="hidden"
            @change="onFileSelected"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="space-y-2">
            <label class="text-sm font-medium" for="display-name">显示名</label>
            <div class="flex items-center gap-2">
              <Input
                id="display-name"
                :model-value="nameDraft ?? ''"
                :placeholder="auth.user?.username ?? '填写显示名'"
                :disabled="savingName"
                maxlength="24"
                class="max-w-xs"
                @update:model-value="nameDraft = String($event)"
                @keyup.enter="saveDisplayName"
              />
              <Button
                v-if="nameDirty"
                :disabled="savingName"
                @click="saveDisplayName"
              >
                <Loader2 v-if="savingName" class="size-4 animate-spin" />
                {{ savingName ? "保存中…" : "保存" }}
              </Button>
            </div>
            <p class="text-xs text-muted-foreground">
              会话与名片中对外展示的名称；清空保存则回落为登录账号
              {{ auth.user?.username ?? "" }}。
            </p>
          </div>

          <div class="divide-y divide-border">
            <div class="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
              <span class="text-muted-foreground">用户名</span>
              <span>{{ auth.user?.username ?? "—" }}</span>
            </div>
            <div class="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
              <span class="text-muted-foreground">角色</span>
              <span>{{ roleLabel }}</span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
