import {
  createRouter,
  createMemoryHistory,
  type Router,
} from "vue-router";
import type { Pinia } from "pinia";
import { useWeflowAuthStore } from "./auth-store";
import OperationsConsoleView from "./views/OperationsConsoleView.vue";

export type OperationsRouter = Router;

/**
 * 运行控制台内部路由。
 *
 * ExtensionHost 按 manifest path（/support/operations）匹配，
 * 将 path 传入 ctx.path，本路由按 memory history 管理子页面。
 */
export function createOperationsRouter(pinia?: Pinia): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/support/operations" },
      {
        path: "/support/operations",
        name: "operations",
        component: OperationsConsoleView,
        meta: { admin: true },
      },
      { path: "/:pathMatch(.*)*", redirect: "/support/operations" },
    ],
  });
  router.beforeEach(async (to) => {
    if (!to.meta.admin) return true;
    const auth = pinia ? useWeflowAuthStore(pinia) : useWeflowAuthStore();
    if (!auth.initialized) await auth.ensureSession();
    return auth.isAdmin ? true : "/support/operations";
  });
  return router;
}
