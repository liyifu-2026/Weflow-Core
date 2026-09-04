<script setup lang="ts">
/**
 * 产品应用布局：单一侧栏（会话 / 知识库 / 素材 / AI员工 / 管理 / 设置 /
 * 审计 / 用户 / 系统状态）+ 顶栏（主题切换）。登录 / 改密页不经过本布局。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import WfIcon from "../components/WfIcon.vue";
import StaffAvatar from "../components/StaffAvatar.vue";
import { resetSupportWorkspaceStores } from "../stores/reset";

const router = useRouter();
const route = useRoute();
const auth = useWeflowAuthStore();
const collapsed = ref(localStorage.getItem("wf-sidebar") === "collapsed");
const theme = ref<"light" | "dark">(
  localStorage.getItem("wf-theme") === "dark" ? "dark" : "light",
);

const navItems = computed(() => {
  const items: Array<{ to: string; icon: string; label: string }> = [
    { to: "/conversations", icon: "conversations", label: "会话" },
    { to: "/knowledge", icon: "knowledge", label: "知识库" },
    { to: "/assets", icon: "image", label: "素材" },
  ];
  if (auth.isAdmin) {
    items.push(
      { to: "/ai-employees", icon: "agent", label: "AI员工" },
      { to: "/admin", icon: "verify", label: "管理" },
      { to: "/settings", icon: "settings", label: "设置" },
      { to: "/system/status", icon: "runtime", label: "系统状态" },
      { to: "/system/users", icon: "users", label: "用户与角色" },
      { to: "/system/audit", icon: "audit", label: "审计日志" },
    );
  }
  return items;
});

watch(
  () => route.fullPath,
  () => {
    window.scrollTo(0, 0);
  },
);

function applyTheme() {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.style.colorScheme = theme.value;
}
function toggleTheme() {
  theme.value = theme.value === "light" ? "dark" : "light";
  localStorage.setItem("wf-theme", theme.value);
  applyTheme();
}
function toggleSidebar() {
  collapsed.value = !collapsed.value;
  localStorage.setItem("wf-sidebar", collapsed.value ? "collapsed" : "open");
}
async function signOut() {
  resetSupportWorkspaceStores();
  await auth.logout();
  await router.replace("/login");
}

onMounted(applyTheme);
</script>

<template>
  <div class="wf-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="wf-sidebar">
      <div class="wf-brand">
        <span class="wf-brand-wordmark"><b>We</b>Flow</span>
        <button
          class="wf-icon-button wf-collapse"
          :title="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          @click="toggleSidebar"
        >
          <WfIcon name="collapse" :class="{ rotated: collapsed }" />
        </button>
      </div>
      <nav class="wf-navigation" aria-label="主导航">
        <section class="wf-nav-section">
          <div class="wf-nav-label">工作台</div>
          <router-link
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="wf-nav-item"
            active-class=""
            exact-active-class="wf-route-active"
            :title="collapsed ? item.label : undefined"
          >
            <WfIcon :name="item.icon" />
            <span>{{ item.label }}</span>
          </router-link>
        </section>
      </nav>
      <div class="wf-user-area">
        <router-link to="/profile" class="wf-user-trigger" title="个人资料">
          <StaffAvatar
            :user-id="auth.user?.userId ?? null"
            :fallback-text="auth.user?.displayName || auth.user?.username || 'W'"
            :avatar-url="auth.user?.avatarUrl ?? null"
          />
          <span class="wf-user-name">
            <strong>{{ auth.user?.displayName || auth.user?.username }}</strong>
            <small>{{ auth.isAdmin ? "管理员" : "客服" }}</small>
          </span>
        </router-link>
        <button
          class="wf-icon-button wf-user-logout"
          title="退出登录"
          aria-label="退出登录"
          @click="signOut"
        >
          <WfIcon name="logout" />
        </button>
      </div>
    </aside>
    <main class="wf-main" tabindex="-1">
      <header class="wf-topbar">
        <div class="wf-topbar-actions">
          <button
            class="wf-icon-button"
            :title="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
            :aria-label="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
            @click="toggleTheme"
          >
            <WfIcon :name="theme === 'light' ? 'moon' : 'sun'" />
          </button>
        </div>
      </header>
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.wf-topbar {
  justify-content: flex-end;
}
.wf-user-trigger {
  text-decoration: none;
  color: inherit;
  min-width: 0;
}
.wf-user-logout {
  flex: 0 0 auto;
}
.is-collapsed .wf-user-logout {
  display: none;
}
</style>
