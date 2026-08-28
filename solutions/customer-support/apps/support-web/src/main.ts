import { createApp } from "vue";
import { createPinia } from "pinia";
import "./styles/console-shared.css";
import App from "./App.vue";
import { createSupportRouter } from "./router";
import { installDevStub } from "./dev-stub";

// Standalone development entry: `pnpm dev` serves this app directly against
// a locally running Core (Vite proxy forwards /api). Embedded mode uses
// src/entry.ts instead. In dev we install a deterministic stub bridge so the
// AI Employee page renders without a running Core.
installDevStub();

function initialPath(): string {
  const hash = window.location.hash.replace(/^#/, "");
  return hash.startsWith("/support") ? hash : "/support/conversations";
}

const pinia = createPinia();
const router = createSupportRouter(pinia);
const startPath = initialPath();
// Wait for the router to settle (including the implicit / redirect) before
// pushing the user-visible path, otherwise the catch-all redirect can win
// and the afterEach hook has already overwritten the hash, causing
// initialPath() to read the redirected path on the second pass.
router.isReady().then(() => {
  void router.replace(startPath).catch(() => undefined);
});
// React to manual hash edits (browser back/forward, address bar).
window.addEventListener("hashchange", () => {
  const target = initialPath();
  if (router.currentRoute.value.fullPath !== target) void router.push(target);
});
router.afterEach((to) => {
  const hash = `#${to.fullPath}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(null, "", hash);
  }
});

createApp(App).use(pinia).use(router).mount("#app");
