import { createApp } from "vue";
import { createPinia } from "pinia";
import "./styles/console-shared.css";
import App from "./App.vue";
import { createSupportRouter } from "./router";

// 产品本体入口：support-web 是唯一网页应用（自带登录 + 布局 + browser
// history），不再有 Console 壳与微前端挂载契约。
const pinia = createPinia();
const router = createSupportRouter(pinia);

createApp(App).use(pinia).use(router).mount("#app");
