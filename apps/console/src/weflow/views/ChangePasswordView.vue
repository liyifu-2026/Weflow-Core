<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WeFlowLogo from "../components/WeFlowLogo.vue";
const auth = useWeflowAuthStore();
const router = useRouter();
const currentPassword = ref("");
const newPassword = ref("");
const confirm = ref("");
const error = ref("");
const loading = ref(false);
async function submit() {
  error.value = "";
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
  <div class="wf-login-page">
    <form class="wf-login-box" @submit.prevent="submit">
      <WeFlowLogo :size="30" class="wf-login-logo" />
      <h2>设置新密码</h2>
      <p>密码长度为 12–128 个字符，设置完成后进入控制室。</p>
      <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
      <div class="wf-field">
        <label for="pw-current">当前初始密码</label>
        <input id="pw-current" v-model="currentPassword" type="password" class="wf-input" />
      </div>
      <div class="wf-field">
        <label for="pw-new">新密码</label>
        <input id="pw-new" v-model="newPassword" type="password" class="wf-input" />
      </div>
      <div class="wf-field">
        <label for="pw-confirm">再次输入</label>
        <input id="pw-confirm" v-model="confirm" type="password" class="wf-input" />
      </div>
      <button
        class="wf-button primary wf-button-block"
        :disabled="loading || newPassword.length < 12"
      >
        <span v-if="loading" class="wf-spinner"></span>
        <span>{{ loading ? "保存中" : "完成并进入控制室" }}</span>
      </button>
    </form>
  </div>
</template>

<style scoped>
.wf-login-page {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
  background: var(--wf-bg);
}
.wf-login-box {
  width: min(360px, 100%);
}
.wf-login-logo {
  margin-bottom: 28px;
  color: var(--wf-text);
}
.wf-login-box h2 {
  margin: 0 0 8px;
  font-size: 24px;
  letter-spacing: -0.02em;
}
.wf-login-box > p {
  margin: 0 0 24px;
  color: var(--wf-text-secondary);
  font-size: 13px;
}
.wf-login-box .wf-button {
  margin-top: 4px;
}
</style>
