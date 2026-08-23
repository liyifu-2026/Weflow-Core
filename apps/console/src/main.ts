import { createApp } from "vue";
import { createPinia } from "pinia";
import "./assets/weflow-console.css";
import App from "./App.vue";
import router from "./router";

const preferredTheme =
  localStorage.getItem("wf-theme") === "dark" ? "dark" : "light";
document.documentElement.dataset.theme = preferredTheme;
document.documentElement.style.colorScheme = preferredTheme;

const app = createApp(App);
app.config.errorHandler = (error, instance, info) => {
  console.error("[Weflow] Unhandled Vue error", error, instance, info);
};
app.use(createPinia());
app.use(router);

router.isReady().finally(() => app.mount("#app"));
