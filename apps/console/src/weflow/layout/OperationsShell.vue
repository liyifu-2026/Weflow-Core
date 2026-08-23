<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import { agentDisplayName } from "../labels";
import WfIcon from "../components/WfIcon.vue";
import WeFlowLogo from "../components/WeFlowLogo.vue";
import DefaultAvatar from "../components/DefaultAvatar.vue";
import ProfileView from "../views/ProfileView.vue";
import WfDrawer from "../components/WfDrawer.vue";
import { useEscClose } from "../composables/use-esc-close";
import WfConfirmDialog from "../components/WfConfirmDialog.vue";
import { resetWeflowWorkspaceStores } from "../stores/reset";
import { useExtensionStore } from "../stores/extensions";

const router = useRouter();
const route = useRoute();
const auth = useWeflowAuthStore();
const extensions = useExtensionStore();
const collapsed = ref(localStorage.getItem("wf-sidebar") === "collapsed");
const theme = ref<"light" | "dark">(
  localStorage.getItem("wf-theme") === "dark" ? "dark" : "light",
);
const profileOpen = ref(false);
const mobileNavOpen = ref(false);
const noticeOpen = ref(false);
watch(() => route.fullPath, () => { mobileNavOpen.value = false; noticeOpen.value = false; });
useEscClose(computed(() => profileOpen.value), () => closeProfile());
const groups = computed(() => [
  {
    label: "工作台",
    items: [{ to: "/", icon: "overview", label: "平台总览" }],
  },
  ...(auth.isAdmin
    ? [
        {
          label: "平台",
          items: [
            { to: "/system/status", icon: "runtime", label: "系统状态" },
            { to: "/system/operations", icon: "engine", label: "运行" },
            { to: "/platform/solutions", icon: "verify", label: "业务方案" },
            { to: "/system/users", icon: "users", label: "用户与角色" },
            { to: "/system/audit", icon: "audit", label: "审计日志" },
          ],
        },
      ]
    : []),
]);

const dynamicGroups = computed(() => {
  const map = new Map<string, Array<{ to: string; icon: string; label: string }>>();
  for (const item of extensions.navItems) {
    const group = item.extension.group || "业务";
    const label = item.extension.title;
    const icon = item.extension.icon || "engine";
    if (!map.has(group)) map.set(group, []);
    map.get(group)!.push({ to: item.to, icon, label });
  }
  return Array.from(map.entries()).map(([label, items]) => ({ label, items }));
});

const allGroups = computed(() => [...groups.value, ...dynamicGroups.value]);

function applyTheme() {
  document.documentElement.dataset.theme = theme.value;
  document.documentElement.style.colorScheme = theme.value;
}
function toggleTheme() {
  theme.value = theme.value === "light" ? "dark" : "light";
  localStorage.setItem("wf-theme", theme.value);
  applyTheme();
}
function toggleMobileNav() {
  mobileNavOpen.value = !mobileNavOpen.value;
}

function toggleSidebar() {
  collapsed.value = !collapsed.value;
  localStorage.setItem("wf-sidebar", collapsed.value ? "collapsed" : "open");
}
async function signOut() {
  resetWeflowWorkspaceStores();
  await auth.logout();
  await router.replace("/login");
}
function closeProfile() {
  profileOpen.value = false;
  if (route.query.profile === "1") {
    const query = { ...route.query };
    delete query.profile;
    void router.replace({ query });
  }
}

onMounted(() => {
  applyTheme();
  if (route.query.profile === "1") profileOpen.value = true;
  void extensions.load();
});
</script>

<template>
  <div v-if="mobileNavOpen" class="wf-mobile-nav-backdrop" @click="mobileNavOpen = false"></div>
<div class="wf-shell" :class="{ 'is-collapsed': collapsed, 'mobile-nav-open': mobileNavOpen }">
    <aside class="wf-sidebar">
      <div class="wf-brand">
        <WeFlowLogo v-if="!collapsed" :size="22" />
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
        <section
          v-for="group in allGroups"
          :key="group.label"
          class="wf-nav-section"
        >
          <div class="wf-nav-label">{{ group.label }}</div>
          <router-link
            v-for="item in group.items"
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
      <div class="wf-sidebar-foot">
        <router-link
          v-if="auth.isAdmin"
          to="/settings"
          class="wf-nav-item"
          active-class=""
          exact-active-class="wf-route-active"
        >
          <WfIcon name="settings" />
          <span>设置</span>
        </router-link>
        <router-link
          to="/help"
          class="wf-nav-item"
          active-class=""
          exact-active-class="wf-route-active"
        >
          <WfIcon name="knowledge" />
          <span>技术文档</span>
        </router-link>
      </div>
      <div class="wf-user-area">
        <button
          class="wf-user-trigger"
          :title="`打开 ${agentDisplayName(auth.user)} 的信息名片`"
          @click="profileOpen = true"
        >
          <img
            v-if="auth.user?.avatarUrl"
            :src="auth.user.avatarUrl"
            :alt="agentDisplayName(auth.user)"
            class="wf-user-avatar-img"
          />
          <DefaultAvatar
            v-else
            :name="auth.user?.username"
            :size="30"
            class="wf-user-default-avatar"
          />
          <span class="wf-user-name">
            <strong>{{ agentDisplayName(auth.user) }}</strong>
            <small>{{ auth.isAdmin ? "管理员" : "操作员" }}</small>
          </span>
        </button>
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
    <main id="wf-main-content" class="wf-main" tabindex="-1">
      <header class="wf-topbar">
        <div class="wf-topbar-actions">
          <div class="wf-notice-wrap">
            <button
              class="wf-icon-button"
              aria-label="通知"
              :aria-expanded="noticeOpen ? 'true' : 'false'"
              aria-haspopup="true"
              @click="noticeOpen = !noticeOpen"
            >
              <WfIcon name="bell" />
            </button>
            <div v-if="noticeOpen" class="wf-notice-popover" role="status">
              <strong>通知</strong>
              <p>暂无新通知</p>
            </div>
          </div>
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
  <WfDrawer :open="profileOpen" title="信息名片" @close="closeProfile()">
    <ProfileView />
  </WfDrawer>
  <WfConfirmDialog />
</template>

<style scoped>
.wf-topbar {
  justify-content: flex-end;
}
.wf-user-trigger {
  border: 0;
  background: transparent;
  text-align: left;
}
.wf-user-default-avatar {
  color: var(--wf-rail-active-text);
}
.wf-user-logout {
  flex: 0 0 auto;
  color: var(--wf-rail-text);
}
.wf-user-logout:hover {
  color: var(--wf-rail-text-strong);
  background: var(--wf-rail-hover);
}
.is-collapsed .wf-user-logout {
  display: none;
}
.wf-notice-wrap {
  position: relative;
}
.wf-notice-popover {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  z-index: 50;
  width: 240px;
  padding: 14px 16px;
  background: var(--wf-surface-elevated);
  border: 1px solid var(--wf-border-strong);
  border-radius: 10px;
  box-shadow: var(--wf-shadow-overlay);
}
.wf-notice-popover strong {
  display: block;
  margin-bottom: 4px;
  font-size: 13px;
}
.wf-notice-popover p {
  margin: 0;
  color: var(--wf-text-secondary);
  font-size: 12px;
}
.wf-user-avatar-img {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 50%;
  object-fit: cover;
}
.wf-sidebar-foot {
  padding: 8px 10px;
  border-top: 1px solid var(--wf-rail-border);
  display: grid;
  gap: 2px;
}
.wf-sidebar-foot .wf-nav-item {
  width: 100%;
}
</style>
