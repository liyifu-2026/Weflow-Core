<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Loader2 } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Checkbox } from "../components/ui/checkbox";

const auth = useWeflowAuthStore();
const router = useRouter();
const route = useRoute();
const username = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");

// —— 记住登录 / 自动登录（内部工具口径）——
// 凭据仅做 Base64 混淆存放于本机 localStorage（非加密）；与手机端
// SecureStore 的「记住密码」产品语义一致：封闭发放账号的内部设备可接受。
// 勾选「自动登录」必然同时记住密码；取消记住密码会联动取消自动登录。
const rememberUser = ref(false);
const rememberPassword = ref(false);
const autoLogin = ref(false);

const LS_USERNAME = "wf-login-username";
const LS_CRED = "wf-login-cred";
const LS_AUTO = "wf-login-auto";

function loadSaved(): { auto?: string; username?: string; password?: string } {
  try {
    const auto = localStorage.getItem(LS_AUTO) === "1";
    const rawCred = localStorage.getItem(LS_CRED);
    const usernameSaved = localStorage.getItem(LS_USERNAME) ?? "";
    let passwordSaved = "";
    if (rawCred) {
      const decoded = atob(rawCred);
      const idx = decoded.indexOf(":");
      if (idx > 0) {
        return {
          auto: auto && decoded.slice(idx + 1) ? "1" : undefined,
          username: decoded.slice(0, idx),
          password: decoded.slice(idx + 1),
        };
      }
    }
    return { auto: auto && passwordSaved ? "1" : undefined, username: usernameSaved, password: passwordSaved };
  } catch {
    return {};
  }
}

function persist() {
  if (rememberUser.value && username.value) {
    localStorage.setItem(LS_USERNAME, username.value);
  } else {
    localStorage.removeItem(LS_USERNAME);
  }
  if (rememberPassword.value && username.value && password.value) {
    localStorage.setItem(LS_CRED, btoa(`${username.value}:${password.value}`));
  } else {
    localStorage.removeItem(LS_CRED);
  }
  if (autoLogin.value && rememberPassword.value) {
    localStorage.setItem(LS_AUTO, "1");
  } else {
    localStorage.removeItem(LS_AUTO);
  }
}

async function doLogin(): Promise<boolean> {
  error.value = "";
  submitting.value = true;
  try {
    await auth.login(username.value, password.value);
    persist();
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "";
    await router.replace(
      auth.user?.mustChangePassword
        ? "/change-password"
        : redirect || "/conversations",
    );
    return true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "登录失败";
    return false;
  } finally {
    submitting.value = false;
  }
}

function submit() {
  void doLogin();
}

// 本页不经 AppShell；独立页需自行恢复主题偏好。
onMounted(async () => {
  const dark = localStorage.getItem("wf-theme") === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";

  const saved = loadSaved();
  if (saved.username) {
    username.value = saved.username;
    rememberUser.value = true;
  }
  if (saved.password) {
    password.value = saved.password;
    rememberPassword.value = true;
    autoLogin.value = saved.auto === "1";
  }
  if (autoLogin.value && !auth.user) {
    const ok = await doLogin();
    if (!ok) autoLogin.value = false; // 自动登录失败不再循环尝试
  }
});
</script>

<template>
  <div
    class="grid min-h-screen place-items-center bg-background p-6"
    style="
      background-image:
        radial-gradient(1100px 540px at 15% -10%, hsl(var(--muted)) 0%, transparent 60%),
        radial-gradient(900px 480px at 110% 110%, hsl(var(--primary) / 0.08) 0%, transparent 55%);
    "
  >
    <form
      class="fade-in w-full max-w-sm rounded-2xl border bg-card/90 p-8 shadow-lg backdrop-blur"
      style="--tw-shadow: 0 20px 50px -20px rgb(0 0 0 / 0.25)"
      @submit.prevent="submit"
    >
      <div class="mb-6 flex flex-col items-center gap-3 text-center">
        <div
          class="grid size-11 place-items-center rounded-xl text-lg font-bold text-primary-foreground"
          style="background: linear-gradient(135deg, #2563eb, #4f46e5)"
        >
          W
        </div>
        <div>
          <p class="text-xl font-semibold tracking-tight">WeFlow</p>
          <p class="mt-1 text-sm text-muted-foreground">使用由管理员发放的 Weflow 账号登录工作台</p>
        </div>
      </div>

      <Alert v-if="error" variant="destructive" role="alert">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div class="mt-4 space-y-4">
        <div class="space-y-2">
          <Label for="login-username">用户名</Label>
          <Input
            id="login-username"
            v-model="username"
            autocomplete="username"
            placeholder="请输入用户名"
          />
        </div>
        <div class="space-y-2">
          <Label for="login-password">密码</Label>
          <Input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
          />
        </div>
      </div>

      <div class="mt-4 space-y-2.5 text-sm">
        <label class="flex items-center gap-2 text-muted-foreground">
          <Checkbox
            :checked="rememberUser"
            @update:checked="(v: boolean | 'indeterminate') => (rememberUser = v === true)"
          />
          <span>记住用户名</span>
        </label>
        <label class="flex items-center gap-2 text-muted-foreground">
          <Checkbox
            :checked="rememberPassword"
            @update:checked="
              (v: boolean | 'indeterminate') => {
                rememberPassword = v === true;
                if (!rememberPassword) autoLogin = false;
              }
            "
          />
          <span>记住密码（仅本机）</span>
        </label>
        <label
          class="flex items-center gap-2"
          :class="rememberPassword ? 'text-muted-foreground' : 'text-muted-foreground/50'"
        >
          <Checkbox
            :checked="autoLogin"
            :disabled="!rememberPassword"
            @update:checked="(v: boolean | 'indeterminate') => (autoLogin = v === true)"
          />
          <span>自动登录（打开页面直接进入）</span>
        </label>
      </div>

      <Button
        type="submit"
        class="mt-6 w-full"
        :disabled="submitting || !username || !password"
      >
        <Loader2 v-if="submitting" class="size-4 animate-spin" />
        <span>{{ submitting ? "验证中" : "登录" }}</span>
      </Button>
    </form>
  </div>
</template>

<style scoped>
.fade-in {
  animation: fadein 0.35s ease;
}
@keyframes fadein {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
