<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ArrowRight, Loader2 } from "lucide-vue-next";
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
    return { auto: undefined, username: usernameSaved, password: passwordSaved };
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
  <div class="login-stage relative min-h-screen overflow-hidden bg-background text-foreground">
    <!-- 氛围：极淡的角落光斑（zinc 语义色，非渐变横幅） -->
    <div class="pointer-events-none absolute inset-0" aria-hidden="true">
      <div class="absolute -top-40 left-[-10%] size-[34rem] rounded-full bg-muted/60 blur-3xl" />
      <div class="absolute bottom-[-12rem] right-[-6rem] size-[30rem] rounded-full bg-muted/40 blur-3xl" />
    </div>

    <div class="relative grid min-h-screen lg:grid-cols-[1.15fr_1fr]">
      <!-- 左：品牌面。巨型波浪 logo 自绘制 + 超大字标，低调炫技的核心。 -->
      <section class="relative flex flex-col justify-between overflow-hidden p-8 pb-10 sm:p-12">
        <div class="anim-rise flex items-center gap-2.5 text-sm font-semibold tracking-tight" style="--d: 0ms">
          <svg width="26" height="26" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
            <path d="M5 21c3-11 7 11 11 0s7 11 11 0" />
            <path d="M5 26h22" opacity=".35" />
          </svg>
          <span><b class="font-extrabold">We</b>Flow</span>
        </div>

        <div class="py-10">
          <!-- 签名时刻：品牌波浪线按笔顺自绘制 -->
          <svg
            class="hero-wave -ml-2 mb-2 h-40 w-auto max-w-full sm:h-52"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path class="wave-draw" d="M5 21c3-11 7 11 11 0s7 11 11 0" stroke-width="2.6" pathLength="1" />
            <path class="wave-draw underline-draw" d="M5 26h22" stroke-width="2.6" opacity=".3" pathLength="1" />
          </svg>

          <h1 class="wordmark select-none" aria-label="WeFlow">
            <span class="inline-block overflow-hidden align-bottom"><span class="anim-rise inline-block font-extrabold" style="--d: 180ms">We</span></span><span class="inline-block overflow-hidden align-bottom"><span class="anim-rise inline-block font-medium text-muted-foreground" style="--d: 240ms">Flow</span></span>
          </h1>

          <p class="anim-rise mt-5 max-w-md text-balance text-[15px] leading-7 text-muted-foreground" style="--d: 420ms">
            消息进来，答复出去；AI 在场，人工随时接管。
          </p>
        </div>

        <p class="anim-rise text-xs text-muted-foreground/70" style="--d: 560ms">
          Weflow 桌面工作台 · 内部系统 · 账号由管理员发放
        </p>
      </section>

      <!-- 右：登录表单。无卡片，直接浮在留白上。 -->
      <section class="relative flex items-center justify-center p-8 sm:p-12">
        <form class="w-full max-w-sm" @submit.prevent="submit">
          <Alert v-if="error" variant="destructive" role="alert" class="anim-rise">
            <AlertDescription>{{ error }}</AlertDescription>
          </Alert>

          <div class="space-y-5">
            <div class="anim-rise space-y-2" style="--d: 300ms">
              <Label for="login-username" class="text-xs uppercase tracking-widest text-muted-foreground">用户名</Label>
              <Input
                id="login-username"
                v-model="username"
                autocomplete="username"
                placeholder="请输入用户名"
                class="h-11 bg-background/60"
              />
            </div>
            <div class="anim-rise space-y-2" style="--d: 380ms">
              <Label for="login-password" class="text-xs uppercase tracking-widest text-muted-foreground">密码</Label>
              <Input
                id="login-password"
                v-model="password"
                type="password"
                autocomplete="current-password"
                placeholder="请输入密码"
                class="h-11 bg-background/60"
              />
            </div>
          </div>

          <div class="anim-rise mt-6 space-y-2.5 text-sm" style="--d: 460ms">
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
            class="anim-rise group mt-8 h-11 w-full justify-between px-5 text-[15px]"
            :disabled="submitting || !username || !password"
            style="--d: 540ms"
          >
            <span>{{ submitting ? "验证中" : "进入工作台" }}</span>
            <Loader2 v-if="submitting" class="size-4 animate-spin" />
            <ArrowRight v-else class="size-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1" />
          </Button>
        </form>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 字标：Geist 变量字体（项目本地化资产），大字号 + 负字距 = 招牌排印 */
.wordmark {
  font-size: clamp(3.5rem, 8vw, 7rem);
  line-height: 0.95;
  letter-spacing: -0.045em;
  text-wrap: balance;
}

/* 入场编队：单一自定义缓动（expo-out），仅 transform/opacity，GPU 友好；
   --d 为各元素编队延迟，prefers-reduced-motion 下整体退化为直出。 */
.anim-rise {
  animation: rise 0.7s cubic-bezier(0.16, 1, 0.3, 1) both;
  animation-delay: var(--d, 0ms);
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 签名时刻：波浪 logo 描边自绘制（stroke-dashoffset，合成器友好） */
.wave-draw {
  stroke-dasharray: 1;
  stroke-dashoffset: 1;
  animation: draw 1.1s cubic-bezier(0.16, 1, 0.3, 1) 0.15s forwards;
}
.underline-draw {
  animation-delay: 0.55s;
  animation-duration: 0.5s;
}
@keyframes draw {
  to {
    stroke-dashoffset: 0;
  }
}

/* 品牌化选区：低调的全局细节 */
.login-stage ::selection {
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
}

@media (prefers-reduced-motion: reduce) {
  .anim-rise,
  .wave-draw {
    animation: none;
  }
  .wave-draw {
    stroke-dashoffset: 0;
  }
}

@media (max-width: 1023px) {
  .hero-wave {
    height: 6.5rem;
  }
  .wordmark {
    font-size: clamp(2.75rem, 12vw, 4rem);
  }
}
</style>
