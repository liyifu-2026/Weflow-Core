import { createApp } from "vue";
import { createPinia } from "pinia";
import "./styles/tailwind.css";
import App from "./App.vue";
import { createSupportRouter } from "./router";
import { applyDesktopShellDefaults } from "./shell";

// 产品本体入口：support-web 是唯一网页应用（自带登录 + 布局 + browser
// history），不再有 Console 壳与微前端挂载契约。
// 桌面壳的默认值必须在启动这一刻定下来：?shell=desktop 会被登录重定向丢掉。
applyDesktopShellDefaults();

const pinia = createPinia();
const router = createSupportRouter(pinia);

createApp(App).use(pinia).use(router).mount("#app");
