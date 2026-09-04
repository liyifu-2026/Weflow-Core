import { createRouter, createWebHistory } from "vue-router";
import { useWeflowAuthStore } from "@/weflow/auth-store";

/**
 * Console 平台壳路由（R1 收敛后）。
 *
 * 业务 UI 已全部收敛到 support-web 产品本体（weflow-solutions 仓库），
 * Console 不再承载 ExtensionHost / consoleExtensions。这里只保留平台级
 * 路由；业务扩展相关路由（/extensions/:solutionId/:extensionId 与
 * catch-all）已删除。
 */
const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/login",
      name: "login",
      component: () => import("@/weflow/views/LoginView.vue"),
      meta: { public: true },
    },
    {
      path: "/change-password",
      name: "changePassword",
      component: () => import("@/weflow/views/ChangePasswordView.vue"),
    },
    {
      path: "/",
      component: () => import("@/weflow/layout/OperationsShell.vue"),
      children: [
        {
          path: "",
          name: "overview",
          // 平台总览的业务卡片区已随微前端退役；此路由暂以系统状态页
          // 兜底（R2 由设置中心 / 新总览接管）。
          redirect: { path: "/system/status" },
        },
        {
          path: "account/profile",
          name: "profile",
          redirect: { path: "/", query: { profile: "1" } },
        },
        {
          path: "help",
          name: "help",
          component: () => import("@/weflow/views/HelpView.vue"),
        },
        {
          path: "system/users",
          name: "users",
          component: () => import("@/weflow/views/UsersView.vue"),
          meta: { admin: true },
        },
        {
          path: "system/runtime",
          name: "runtime",
          redirect: (to) => ({
            path: "/system/status",
            query: { ...to.query, service: "runtime" },
          }),
        },
        {
          path: "system/audit",
          name: "audit",
          component: () => import("@/weflow/views/AuditView.vue"),
          meta: { admin: true },
        },
        {
          path: "system/knowledge-engine",
          name: "knowledgeEngine",
          redirect: (to) => ({
            path: "/system/status",
            query: { ...to.query, service: "knowledge" },
          }),
        },
        {
          path: "system/status",
          name: "systemStatus",
          component: () => import("@/weflow/views/SystemStatusView.vue"),
        },
      ],
    },
  ],
});

router.beforeEach(async (to) => {
  const auth = useWeflowAuthStore();
  await auth.ensureSession();
  if (to.meta.public) return auth.user ? { name: "overview" } : true;
  if (!auth.user) return { name: "login", query: { redirect: to.fullPath } };
  if (auth.user.mustChangePassword && to.name !== "changePassword")
    return { name: "changePassword" };
  if (!auth.user.mustChangePassword && to.name === "changePassword")
    return { name: "overview" };
  if (to.meta.admin && auth.user.role !== "admin") return { name: "overview" };
  return true;
});

export default router;
