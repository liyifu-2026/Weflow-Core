<script setup lang="ts">
/**
 * 客服个人资料页：显示当前用户信息 + 头像上传。
 * 所有客服均可访问（非 admin-only），用于更换自己的会话头像。
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { ArrowLeft, Loader2 } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import StaffAvatar from "../components/StaffAvatar.vue";

const auth = useWeflowAuthStore();
const router = useRouter();
void auth.ensureSession();

const uploading = ref(false);
const error = ref("");
const notice = ref("");
const fileInput = ref<HTMLInputElement | null>(null);

const displayName = computed(
  () => auth.user?.displayName || auth.user?.username || "未登录",
);
const roleLabel = computed(() =>
  auth.user?.role === "admin" ? "管理员" : "客服",
);

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
    error.value = "仅支持 JPEG、PNG、WebP 格式";
    return;
  }
  if (file.size > 1024 * 1024) {
    error.value = "头像文件不能超过 1 MB";
    return;
  }

  error.value = "";
  notice.value = "";
  uploading.value = true;
  try {
    await auth.uploadAvatar(file);
    notice.value = "头像已更新，新头像将在会话中即时显示";
  } catch (reason) {
    error.value =
      reason instanceof Error ? reason.message : "上传失败，请稍后重试";
  } finally {
    uploading.value = false;
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
    <p class="mt-1 text-sm text-muted-foreground">管理你的客服头像和信息。</p>

    <div class="mt-6 space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>头像</CardTitle>
          <CardDescription>更换后 Mobile 端和网页端会同步显示新头像。</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex items-center gap-6">
            <StaffAvatar
              :user-id="auth.user?.userId"
              :avatar-url="auth.user?.avatarUrl"
              :fallback-text="displayName"
              :size="80"
            />
            <div class="space-y-2">
              <Button :disabled="uploading" @click="triggerFileSelect">
                <Loader2 v-if="uploading" class="size-4 animate-spin" />
                {{ uploading ? "上传中…" : "更换头像" }}
              </Button>
              <p class="text-xs text-muted-foreground">
                支持 JPEG / PNG / WebP，最大 1 MB。
              </p>
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
        <CardContent class="divide-y divide-border">
          <div class="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
            <span class="text-muted-foreground">用户名</span>
            <span>{{ auth.user?.username ?? "—" }}</span>
          </div>
          <div class="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
            <span class="text-muted-foreground">显示名</span>
            <span>{{ auth.user?.displayName || "未设置" }}</span>
          </div>
          <div class="flex items-center justify-between py-3 text-sm first:pt-0 last:pb-0">
            <span class="text-muted-foreground">角色</span>
            <span>{{ roleLabel }}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
