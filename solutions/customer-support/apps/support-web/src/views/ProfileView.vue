<script setup lang="ts">
/**
 * 客服个人资料页：显示当前用户信息 + 头像上传。
 * 所有客服均可访问（非 admin-only），用于更换自己的会话头像。
 */
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
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
  void router.push("/support/conversations");
}
</script>

<template>
  <div class="wf-page wf-profile-page">
    <header class="wf-page-head">
      <div>
        <button class="wf-link wf-profile-back" @click="goBack">
          ← 返回工作台
        </button>
        <h1>个人资料</h1>
        <p>管理你的客服头像和信息。</p>
      </div>
    </header>

    <div class="wf-profile-body">
      <div class="wf-profile-card">
        <div class="wf-profile-avatar-section">
          <StaffAvatar
            :user-id="auth.user?.userId"
            :avatar-url="auth.user?.avatarUrl"
            :fallback-text="displayName"
            :size="80"
          />
          <div class="wf-profile-avatar-actions">
            <button
              class="wf-button compact primary"
              :disabled="uploading"
              @click="triggerFileSelect"
            >
              {{ uploading ? "上传中…" : "更换头像" }}
            </button>
            <p class="wf-muted">
              支持 JPEG / PNG / WebP，最大 1 MB。<br />
              更换后 Mobile 端和 Console 端会同步显示新头像。
            </p>
          </div>
        </div>
        <input
          ref="fileInput"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style="display: none"
          @change="onFileSelected"
        />

        <div v-if="error" class="wf-error">{{ error }}</div>
        <div v-if="notice" class="wf-profile-notice">{{ notice }}</div>
      </div>

      <div class="wf-profile-card">
        <h3>基本信息</h3>
        <div class="wf-profile-field">
          <label>用户名</label>
          <span>{{ auth.user?.username ?? "—" }}</span>
        </div>
        <div class="wf-profile-field">
          <label>显示名</label>
          <span>{{ auth.user?.displayName || "未设置" }}</span>
        </div>
        <div class="wf-profile-field">
          <label>角色</label>
          <span>{{ roleLabel }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-profile-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
}
.wf-profile-back {
  background: none;
  border: none;
  color: #1a56c4;
  cursor: pointer;
  font-size: 13px;
  padding: 0;
  margin-bottom: 6px;
  display: inline-block;
}
.wf-profile-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 24px;
  max-width: 520px;
}
.wf-profile-card {
  border: 1px solid var(--wf-border, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  background: var(--wf-surface, #fff);
  padding: 20px;
}
.wf-profile-card h3 {
  font-size: 15px;
  margin: 0 0 12px;
}
.wf-profile-avatar-section {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 12px;
}
.wf-profile-avatar-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.wf-profile-notice {
  color: #137333;
  font-size: 13px;
  margin-top: 8px;
}
.wf-profile-field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--wf-border, rgba(0, 0, 0, 0.05));
  font-size: 13px;
}
.wf-profile-field:last-child {
  border-bottom: none;
}
.wf-profile-field label {
  color: var(--wf-text-secondary, #5f6368);
  font-weight: 500;
}
</style>
