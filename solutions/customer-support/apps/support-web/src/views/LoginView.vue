<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Loader2 } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const auth = useWeflowAuthStore();
const router = useRouter();
const route = useRoute();
const username = ref("");
const password = ref("");
const submitting = ref(false);
const error = ref("");

// 本页不经 AppShell；过渡期旧 CSS 的 body 背景跟随 data-theme，
// 需自行同步（第 6 批删除 console-shared.css 后移除）。
onMounted(() => {
  const dark = localStorage.getItem("wf-theme") === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
});

async function submit() {
  error.value = "";
  submitting.value = true;
  try {
    await auth.login(username.value, password.value);
    const redirect =
      typeof route.query.redirect === "string" ? route.query.redirect : "";
    await router.replace(
      auth.user?.mustChangePassword
        ? "/change-password"
        : redirect || "/conversations",
    );
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "登录失败";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-background p-8">
    <form class="w-full max-w-sm space-y-6" @submit.prevent="submit">
      <div class="space-y-2 text-center">
        <p class="text-2xl font-semibold tracking-tight">WeFlow</p>
        <h1 class="text-lg font-medium">登录 Weflow</h1>
        <p class="text-sm text-muted-foreground">
          使用由管理员发放的 Weflow 账号
        </p>
      </div>

      <Alert v-if="error" variant="destructive" role="alert">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div class="space-y-4">
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

      <Button
        type="submit"
        class="w-full"
        :disabled="submitting || !username || !password"
      >
        <Loader2 v-if="submitting" class="size-4 animate-spin" />
        <span>{{ submitting ? "验证中" : "登录 Weflow" }}</span>
      </Button>
    </form>
  </div>
</template>
