<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { Loader2 } from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";

const auth = useWeflowAuthStore();
const router = useRouter();
const currentPassword = ref("");
const newPassword = ref("");
const confirm = ref("");
const error = ref("");
const loading = ref(false);

// 本页不经 AppShell；独立页需自行恢复主题偏好。
onMounted(() => {
  const dark = localStorage.getItem("wf-theme") === "dark";
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
});

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
    await router.replace("/conversations");
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "修改失败";
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div class="grid min-h-screen place-items-center bg-background p-8">
    <form class="w-full max-w-sm space-y-6" @submit.prevent="submit">
      <div class="space-y-2 text-center">
        <p class="text-2xl font-semibold tracking-tight">WeFlow</p>
        <h1 class="text-lg font-medium">设置新密码</h1>
        <p class="text-sm text-muted-foreground">
          密码长度为 12–128 个字符，设置完成后进入工作台。
        </p>
      </div>

      <Alert v-if="error" variant="destructive" role="alert">
        <AlertDescription>{{ error }}</AlertDescription>
      </Alert>

      <div class="space-y-4">
        <div class="space-y-2">
          <Label for="pw-current">当前初始密码</Label>
          <Input id="pw-current" v-model="currentPassword" type="password" />
        </div>
        <div class="space-y-2">
          <Label for="pw-new">新密码</Label>
          <Input id="pw-new" v-model="newPassword" type="password" />
        </div>
        <div class="space-y-2">
          <Label for="pw-confirm">再次输入</Label>
          <Input id="pw-confirm" v-model="confirm" type="password" />
        </div>
      </div>

      <Button
        type="submit"
        class="w-full"
        :disabled="loading || newPassword.length < 12"
      >
        <Loader2 v-if="loading" class="size-4 animate-spin" />
        <span>{{ loading ? "保存中" : "完成并进入工作台" }}</span>
      </Button>
    </form>
  </div>
</template>
