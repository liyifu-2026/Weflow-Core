import {
  createRouter,
  createMemoryHistory,
  type Router,
} from "vue-router";
import type { Pinia } from "pinia";
import { useWeflowAuthStore } from "./auth-store";
import ConversationsV2 from "./views/ConversationsV2.vue";
import KnowledgeV2 from "./views/KnowledgeV2.vue";
import AdminView from "./views/AdminView.vue";
import PoliciesV2 from "./views/PoliciesV2.vue";
import AiEmployeesView from "./views/AiEmployeesView.vue";
import WhitelistView from "./views/WhitelistView.vue";
import PipelineView from "./views/PipelineView.vue";
import ProfileView from "./views/ProfileView.vue";

export type SupportRouter = Router;

/**
 * Visible surface is the WeChat-style workbench (conversations) plus
 * knowledge retrieval. Strategy / AI employees / knowledge management
 * live on hidden admin routes: reachable by URL or the admin hub, never
 * shown in the default navigation.
 *
 * @param pinia 可选 Pinia 实例（admin 守卫需要 auth store）
 * @param initialPath 宿主传入的初始路径（ExtensionHost 按 manifest path 匹配）；
 *                    缺省落到工作台。
 */
export function createSupportRouter(pinia?: Pinia): Router {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/", redirect: "/support/conversations" },
      {
        path: "/support/conversations",
        name: "supportConversations",
        component: ConversationsV2,
      },
      {
        path: "/support/knowledge",
        name: "supportKnowledge",
        component: KnowledgeV2,
      },
      {
        path: "/support/knowledge/validate",
        redirect: (to) => ({
          path: "/support/knowledge",
          query: { ...to.query, mode: "validate" },
        }),
      },
      {
        path: "/support/admin",
        name: "supportAdmin",
        component: AdminView,
        meta: { admin: true },
      },
      {
        path: "/support/admin/policies",
        name: "supportPolicies",
        component: PoliciesV2,
        meta: { admin: true },
      },
      {
        path: "/support/ai-employees",
        name: "supportAiEmployees",
        component: AiEmployeesView,
        meta: { admin: true },
      },
      {
        path: "/support/ai-employees/:definitionId/prompt",
        name: "aiEmployeePrompt",
        component: AiEmployeesView,
        meta: { admin: true },
      },
      {
        path: "/support/whitelist",
        name: "supportWhitelist",
        component: WhitelistView,
        meta: { admin: true },
      },
      {
        path: "/support/pipeline",
        name: "supportPipeline",
        component: PipelineView,
        meta: { admin: true },
      },
      {
        path: "/support/profile",
        name: "supportProfile",
        component: ProfileView,
      },
      { path: "/:pathMatch(.*)*", redirect: "/support/conversations" },
    ],
  });
  // Hidden pages are operator-invisible: non-admins are bounced back to the
  // workbench even when typing the URL directly.
  router.beforeEach(async (to) => {
    if (!to.meta.admin) return true;
    const auth = pinia ? useWeflowAuthStore(pinia) : useWeflowAuthStore();
    if (!auth.initialized) await auth.ensureSession();
    return auth.isAdmin ? true : "/support/conversations";
  });
  return router;
}
