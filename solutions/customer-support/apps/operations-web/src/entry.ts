import { createApp, type App as VueApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import { createOperationsRouter, type OperationsRouter } from "./router";
import { setApiBridge } from "./api";
import { setAuthBridge, type WeflowUser } from "./auth-store";
import "./styles/shared.css";

export type OperationsMountContext = {
  path?: string;
  user?: WeflowUser | null;
  navigate?: (fullPath: string) => void;
  bridge?: {
    fetch: (path: string, init?: RequestInit) => Promise<Response>;
  };
};

type MountHandle = {
  unmount: () => void;
  navigate: (fullPath: string) => void;
};

let activeApp: VueApp | null = null;
let activeRouter: OperationsRouter | null = null;
let activeContainer: HTMLElement | null = null;

/**
 * Console ExtensionHost mount contract.
 * The host loads this ES bundle and calls mount(container, ctx); the bundle
 * owns everything inside the container (routing, stores, styles) and touches
 * nothing else from the platform shell.
 */
export function mount(
  container: HTMLElement,
  ctx?: OperationsMountContext,
): MountHandle {
  if (!container) {
    return { unmount: () => undefined, navigate: () => undefined };
  }
  unmount();
  activeContainer = container;

  // Wire up bridges
  if (ctx?.bridge?.fetch) setApiBridge(ctx.bridge.fetch);
  if (ctx?.user) setAuthBridge(() => ctx.user ?? null);

  const pinia = createPinia();
  const router = createOperationsRouter(pinia);
  activeRouter = router;
  const app = createApp(App);
  activeApp = app;
  app.use(pinia);
  app.use(router);
  app.mount(container);

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
      setApiBridge(null);
      setAuthBridge(null);
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

function normalizeStartPath(path: string | undefined): string | null {
  if (!path) return null;
  if (path === "/" || path === "/support" || path === "/support/") return null;
  if (path.startsWith("/support/")) return path;
  return path;
}

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
  setApiBridge(null);
  setAuthBridge(null);
  activeApp = null;
  activeRouter = null;
  activeContainer = null;
}

export default App;
