import { createApp, type App as VueApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createSupportRouter, type SupportRouter } from "./router";
import "./styles/console-shared.css";

export type SupportMountContext = {
  path?: string;
  navigate?: (fullPath: string) => void;
};

type MountHandle = {
  unmount: () => void;
  navigate: (fullPath: string) => void;
};

let activeApp: VueApp | null = null;
let activeRouter: SupportRouter | null = null;
let activeContainer: HTMLElement | null = null;

/**
 * Console ExtensionHost mount contract.
 * The host loads this ES bundle and calls mount(container, ctx); the bundle
 * owns everything inside the container (routing, stores, styles) and touches
 * nothing else from the platform shell.
 *
 * - ctx.path: 初始路由（宿主按 manifest 声明 path 匹配，如 /support/knowledge）。
 * - ctx.navigate: 宿主侧导航回调（可选的平台级跳转）。
 * - 返回 {unmount, navigate}（新契约）；无 ctx 时兼容旧式同步挂载。
 */
export function mount(
  container: HTMLElement,
  ctx?: SupportMountContext,
): MountHandle {
  if (!container) {
    return { unmount: () => undefined, navigate: () => undefined };
  }
  unmount();
  activeContainer = container;
  const pinia = createPinia();
  const router = createSupportRouter(pinia);
  activeRouter = router;
  const app = createApp(App);
  activeApp = app;
  app.use(pinia);
  app.use(router);
  app.mount(container);
  // 初始路由在应用挂载后导航（memory history 的 base 是前缀，不是初始位置；
  // 挂载前 push 会被未激活的 router 丢弃）。
  const startPath = normalizeStartPath(ctx?.path);
  if (startPath) {
    void router.push(startPath).catch(() => undefined);
  }

  return {
    unmount: () => {
      try {
        app.unmount();
      } catch {
        // already unmounted
      }
      if (container && container.parentNode) {
        container.innerHTML = "";
      }
      activeApp = null;
      activeRouter = null;
      activeContainer = null;
    },
    navigate: (fullPath: string) => {
      if (ctx?.navigate) {
        ctx.navigate(fullPath);
      } else if (activeRouter) {
        void activeRouter.push(fullPath).catch(() => undefined);
      }
    },
  };
}

/** 宿主 path → bundle 内部路由 path；空/根返回 null（保持默认跳工作台）。 */
function normalizeStartPath(path: string | undefined): string | null {
  if (!path) return null;
  if (path === "/" || path === "/support" || path === "/support/") return null;
  if (path.startsWith("/support/")) return path;
  return path;
}

/** 旧式模块级 unmount（宿主兼容路径）。 */
export function unmount(): void {
  if (activeApp) {
    try {
      activeApp.unmount();
    } catch {
      // already unmounted
    }
  }
  if (activeContainer && activeContainer.parentNode) {
    activeContainer.innerHTML = "";
  }
  activeApp = null;
  activeRouter = null;
  activeContainer = null;
}

export default App;
