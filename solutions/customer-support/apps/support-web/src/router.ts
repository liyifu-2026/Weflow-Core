import {
  createRouter,
  createWebHistory,
  type Router,
} from "vue-router";
import type { Pinia } from "pinia";
import { useWeflowAuthStore } from "./auth-store";
import ConversationsV2 from "./views/ConversationsV2.vue";
import KnowledgeV2 from "./views/KnowledgeV2.vue";
import AdminView from "./views/AdminView.vue";
import AiEmployeesView from "./views/AiEmployeesView.vue";
import WhitelistView from "./views/WhitelistView.vue";
import PipelineView from "./views/PipelineView.vue";
import ProfileView from "./views/ProfileView.vue";
import AssetsView from "./views/AssetsView.vue";
import LoginView from "./views/LoginView.vue";
import ChangePasswordView from "./views/ChangePasswordView.vue";
import AuditView from "./views/AuditView.vue";
import UsersView from "./views/UsersView.vue";
import SystemStatusView from "./views/SystemStatusView.vue";
import SettingsView from "./views/SettingsView.vue";

export type SupportRouter = Router;

/**
 * 产品本体路由：URL 即真实路径（browser history，无 /support 前缀、
 * 无宿主壳）。会话工作台是默认落点；审计 / 用户 / 系统状态 / 设置
 * 是管理页（admin only）。
 */
export function createSupportRouter(pinia?: Pinia): Router {
  const router = createRouter({
    history: createWebHistory(),
    routes: [
      {
        path: "/login",
        name: "login",
        component: LoginView,
        meta: { public: true },
      },
      {
        path: "/change-password",
        name: "changePassword",
        component: ChangePasswordView,
      },
      {
        path: "/",
        component: () => import("./layout/AppShell.vue"),
        children: [
          { path: "", redirect: "/conversations" },
          {
            path: "conversations",
            name: "conversations",
            component: ConversationsV2,
          },
          {
            path: "knowledge",
            name: "knowledge",
            component: KnowledgeV2,
          },
          {
            path: "assets",
            name: "assets",
            component: AssetsView,
          },
          {
            path: "knowledge/validate",
            redirect: (to) => ({
              path: "/knowledge",
              query: { ...to.query, mode: "validate" },
            }),
          },
          {
            path: "admin",
            name: "admin",
            component: AdminView,
            meta: { admin: true },
          },
          {
            path: "ai-employees",
            name: "aiEmployees",
            component: AiEmployeesView,
            meta: { admin: true },
          },
          {
            path: "ai-employees/:definitionId/prompt",
            name: "aiEmployeePrompt",
            component: AiEmployeesView,
            meta: { admin: true },
          },
          {
            path: "whitelist",
            name: "whitelist",
            component: WhitelistView,
            meta: { admin: true },
          },
          {
            path: "pipeline",
            name: "pipeline",
            component: PipelineView,
            meta: { admin: true },
          },
          {
            path: "system/audit",
            name: "systemAudit",
            component: AuditView,
            meta: { admin: true },
          },
          {
            path: "system/users",
            name: "systemUsers",
            component: UsersView,
            meta: { admin: true },
          },
          {
            path: "system/status",
            name: "systemStatus",
            component: SystemStatusView,
            meta: { admin: true },
          },
          {
            path: "settings",
            name: "settings",
            component: SettingsView,
            meta: { admin: true },
          },
          {
            path: "profile",
            name: "profile",
            component: ProfileView,
          },
        ],
      },
      { path: "/:pathMatch(.*)*", redirect: "/conversations" },
    ],
  });

  // 会话守卫：未登录去登录页（记录回跳）；首登强制改密；
  // admin 页非管理员回工作台。
  router.beforeEach(async (to) => {
    const auth = pinia ? useWeflowAuthStore(pinia) : useWeflowAuthStore();
    await auth.ensureSession();
    if (to.meta.public) {
      return auth.user ? { path: "/conversations" } : true;
    }
    if (!auth.user) {
      return { path: "/login", query: { redirect: to.fullPath } };
    }
    if (auth.user.mustChangePassword && to.name !== "changePassword") {
      return { path: "/change-password" };
    }
    if (!auth.user.mustChangePassword && to.name === "changePassword") {
      return { path: "/conversations" };
    }
    if (to.meta.admin && !auth.isAdmin) {
      return { path: "/conversations" };
    }
    return true;
  });

  return router;
}
