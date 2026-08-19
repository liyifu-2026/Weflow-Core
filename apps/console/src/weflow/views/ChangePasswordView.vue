<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
const auth = useWeflowAuthStore();
const router = useRouter();
const currentPassword = ref("");
const newPassword = ref("");
const confirm = ref("");
const error = ref("");
const loading = ref(false);
async function submit() {
  error.value = "";
  // trim：杜绝尾随空格进入密码（服务端也会 trim，这里是第一道防线）
  const current = currentPassword.value.trim();
  const next = newPassword.value.trim();
  if (next !== confirm.value.trim()) {
    error.value = "两次输入的新密码不一致";
    return;
  }
  loading.value = true;
  try {
    await auth.changePassword(current, next);
    await router.replace("/");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "修改失败";
  } finally {
    loading.value = false;
  }
}
</script>
<template>
  <div class="wf-auth-page">
    <form class="wf-auth-box" @submit.prevent="submit">
      <div class="wf-auth-wordmark"><b>We</b>flow</div>
      <h2>设置新密码</h2>
      <p>密码长度为 12–128 个字符</p>
      <div v-if="error" class="wf-error">{{ error }}</div>
      <div class="wf-field">
        <label>当前初始密码</label
        ><input v-model="currentPassword" type="password" class="wf-input" />
      </div>
      <div class="wf-field">
        <label>新密码</label
        ><input v-model="newPassword" type="password" class="wf-input" />
      </div>
      <div class="wf-field">
        <label>再次输入</label
        ><input v-model="confirm" type="password" class="wf-input" />
      </div>
      <button
        class="wf-button primary wf-button-block wf-auth-submit" style="display:inline-flex;align-items:center;justify-content:center;gap:8px"
        :disabled="loading || newPassword.length < 12"
      >
        <span v-if="loading" class="wf-spinner" style="width:12px;height:12px;border-width:2px"></span><span>{{ loading ? "保存中" : "完成并进入控制室" }}</span>
      </button>
    </form>
  </div>
</template>
