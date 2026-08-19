<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";

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
  <div class="wf-auth-page wf-auth-split">
    <section class="wf-auth-hero">
      <div class="wf-auth-hero-brand"><b>We</b>flow</div>
      <div class="wf-auth-hero-copy">
        <h1>管理接入的业务方案，<br />掌握平台运行状态。</h1>
        <p>
          查看业务套装的生命状态与安装情况，<br />管理用户、运行与审计，保持平台简单可控。
        </p>
      </div>
      <div class="wf-auth-hero-foot">
        <span class="wf-auth-hero-pill">业务方案</span>
        <span class="wf-auth-hero-pill">生命周期</span>
        <span class="wf-auth-hero-pill">热插拔</span>
      </div>
    </section>
    <section class="wf-auth-panel">
      <form class="wf-auth-box" @submit.prevent="submit">
        <div class="wf-auth-wordmark"><b>We</b>flow</div>
        <h2>登录 Weflow</h2>
        <p>使用由管理员发放的 Weflow 账号</p>
        <div v-if="error" class="wf-error">{{ error }}</div>
        <div class="wf-field">
          <label>用户名</label
          ><input
            v-model="username"
            class="wf-input"
            autocomplete="username"
            autofocus
          />
        </div>
        <div class="wf-field">
          <label>密码</label
          ><input
            v-model="password"
            class="wf-input"
            type="password"
            autocomplete="current-password"
          />
        </div>
        <button
          class="wf-button primary wf-button-block wf-auth-submit" style="display:inline-flex;align-items:center;justify-content:center;gap:8px"
          :disabled="submitting || !username || !password"
        >
          <span v-if="submitting" class="wf-spinner" style="width:12px;height:12px;border-width:2px"></span><span>{{ submitting ? "验证中" : "登录 Weflow" }}</span>
        </button>
      </form>
    </section>
  </div>
</template>

<style scoped>
.wf-auth-split {
  grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr);
  place-items: stretch;
  padding: 0;
  background: var(--wf-bg);
}
.wf-auth-hero {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 40px 48px;
  color: #f2f7f4;
  background:
    radial-gradient(720px 360px at 12% 0%, rgba(72, 168, 137, 0.32), transparent 60%),
    linear-gradient(145deg, #10231c 0%, #0c1a15 55%, #0a1410 100%);
}
.wf-auth-hero-brand {
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.02em;
}
.wf-auth-hero-brand b {
  color: #6fd3ae;
}
.wf-auth-hero-copy h1 {
  margin: 0 0 16px;
  font-size: 34px;
  line-height: 1.25;
  letter-spacing: -0.03em;
}
.wf-auth-hero-copy p {
  max-width: 440px;
  margin: 0;
  color: rgba(242, 247, 244, 0.72);
  font-size: 14px;
  line-height: 1.7;
}
.wf-auth-hero-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.wf-auth-hero-pill {
  padding: 6px 12px;
  border: 1px solid rgba(242, 247, 244, 0.16);
  border-radius: 999px;
  color: rgba(242, 247, 244, 0.78);
  font-size: 12px;
  font-weight: 600;
}
.wf-auth-panel {
  display: grid;
  place-items: center;
  padding: 40px 32px;
}
.wf-auth-panel .wf-auth-box {
  width: min(360px, 100%);
}
@media (max-width: 900px) {
  .wf-auth-split {
    grid-template-columns: 1fr;
  }
  .wf-auth-hero {
    display: none;
  }
}
</style>
