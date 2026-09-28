import { createApp } from "vue";
import { createPinia } from "pinia";
import "./styles/tailwind.css";
import App from "./App.vue";
import { createSupportRouter } from "./router";
import { applyDesktopShellDefaults } from "./shell";
import { useWeflowAuthStore } from "./auth-store";

// 产品本体入口：support-web 是唯一网页应用（自带登录 + 布局 + browser
// history），不再有 Console 壳与微前端挂载契约。
// 桌面壳的默认值必须在启动这一刻定下来：?shell=desktop 会被登录重定向丢掉。
applyDesktopShellDefaults();

const pinia = createPinia();
const router = createSupportRouter(pinia);

// 会话过期统一处理（api() 收到 401 只广播 weflow:unauthorized）：这里清
// auth store 并跳登录页（带 redirect 回跳）。防抖：同一时刻并发多个 401
// 只处理一次；已在登录页则只清状态，不再跳转。
let unauthorizedHandling = false;
window.addEventListener("weflow:unauthorized", () => {
  if (unauthorizedHandling) return;
  unauthorizedHandling = true;
  queueMicrotask(() => (unauthorizedHandling = false));
  useWeflowAuthStore(pinia).expireSession();
  const current = router.currentRoute.value;
  if (current.path === "/login") return;
  void router.replace({ path: "/login", query: { redirect: current.fullPath } });
});

createApp(App).use(pinia).use(router).mount("#app");
