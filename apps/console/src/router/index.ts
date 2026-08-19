import { createRouter, createWebHistory } from "vue-router";
import { useWeflowAuthStore } from "@/weflow/auth-store";

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
          component: () => import("@/weflow/views/OverviewV2.vue"),
        },
        {
          path: "account/profile",
          name: "profile",
          component: () => import("@/weflow/views/ProfileView.vue"),
        },
        {
          path: "help",
          name: "help",
          component: () => import("@/weflow/views/HelpView.vue"),
        },
        {
          path: "extensions/:solutionId/:extensionId",
          name: "extensionHost",
          component: () => import("@/weflow/views/ExtensionHost.vue"),
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
        {
          path: "system/operations",
          name: "operations",
          component: () => import("@/weflow/views/OperationsConsoleView.vue"),
          meta: { admin: true },
        },
        {
          path: "settings",
          name: "settings",
          component: () => import("@/weflow/views/SettingsCenter.vue"),
          meta: { admin: true },
        },
        {
          path: "platform/solutions",
          name: "solutions",
          component: () => import("@/weflow/views/SolutionsView.vue"),
          meta: { admin: true },
        },
      ],
    },
    { path: "/:pathMatch(.*)*", redirect: "/" },
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
