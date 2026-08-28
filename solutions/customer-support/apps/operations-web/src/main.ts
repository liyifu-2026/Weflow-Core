import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createOperationsRouter } from "./router";
import "./styles/shared.css";

const pinia = createPinia();
const router = createOperationsRouter(pinia);
const app = createApp(App);
app.use(pinia);
app.use(router);
app.mount("#app");
