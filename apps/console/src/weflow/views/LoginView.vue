<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WeFlowLogo from "../components/WeFlowLogo.vue";

const auth = useWeflowAuthStore();
const router = useRouter();
const route = useRoute();
const username = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");

async function submit() {
  error.value = "";
  submitting.value = true;
  try {
    await auth.login(username.value, password.value);
    await router.replace(
      auth.user?.mustChangePassword
        ? "/change-password"
        : String(route.query.redirect ?? "/"),
    );
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="wf-login-page">
    <form class="wf-login-box" @submit.prevent="submit">
      <WeFlowLogo :size="30" class="wf-login-logo" />
      <h2>登录 Weflow</h2>
      <p>使用由管理员发放的 Weflow 账号</p>
      <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
      <div class="wf-field">
        <label for="login-username">用户名</label>
        <input
          id="login-username"
          v-model="username"
          class="wf-input"
          autocomplete="username"
          autofocus
          placeholder="请输入用户名"
        />
      </div>
      <div class="wf-field">
        <label for="login-password">密码</label>
        <input
          id="login-password"
          v-model="password"
          class="wf-input"
          type="password"
          autocomplete="current-password"
          placeholder="请输入密码"
        />
      </div>
      <button
        class="wf-button primary wf-button-block"
        :disabled="submitting || !username || !password"
      >
        <span v-if="submitting" class="wf-spinner"></span>
        <span>{{ submitting ? "验证中" : "登录 Weflow" }}</span>
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
