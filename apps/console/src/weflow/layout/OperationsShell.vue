<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import { agentDisplayName } from "../labels";
import WfIcon from "../components/WfIcon.vue";
import CommandPalette from "../components/CommandPalette.vue";
import WfConfirmDialog from "../components/WfConfirmDialog.vue";
import { resetWeflowWorkspaceStores } from "../stores/reset";
import { useExtensionStore } from "../stores/extensions";

const router = useRouter();
const route = useRoute();
const auth = useWeflowAuthStore();
const extensions = useExtensionStore();
const pageTitle = computed(() => {
  const titles: Record<string, string> = {
    overview: "平台总览",
    users: "用户与角色",
    solutions: "业务方案",
    systemStatus: "系统状态",
    operations: "运行",
    settings: "统一设置",
    audit: "审计日志",
    profile: "信息名片",
    help: "技术文档",
  };
  return titles[String(route.name ?? "")] ?? "Weflow";
});
const collapsed = ref(localStorage.getItem("wf-sidebar") === "collapsed");
const theme = ref<"light" | "dark">(
  localStorage.getItem("wf-theme") === "dark" ? "dark" : "light",
);
const groups = computed(() => [
  {
    label: "总览",
    items: [{ to: "/", icon: "overview", label: "平台总览" }],
  },
  ...(auth.isAdmin
    ? [
        {
          label: "方案",
          items: [
            {
              to: "/platform/solutions",
              icon: "engine",
              label: "业务方案",
            },
          ],
        },
      ]
    : []),
  ...(auth.isAdmin
    ? [
        {
          label: "设置",
          items: [
            {
              to: "/settings",
              icon: "engine",
              label: "统一设置",
            },
          ],
        },
      ]
    : []),
  {
    label: "系统",
    items: [
      { to: "/system/status", icon: "runtime", label: "系统状态" },
      ...(auth.isAdmin
        ? [{ to: "/system/users", icon: "users", label: "用户与角色" }]
        : []),
      ...(auth.isAdmin
        ? [{ to: "/system/operations", icon: "engine", label: "运行" }]
        : []),
      ...(auth.isAdmin
        ? [{ to: "/system/audit", icon: "audit", label: "审计日志" }]
        : []),
    ],
  },
]);

const dynamicGroups = computed(() => {
  const map = new Map<string, Array<{ to: string; icon: string; label: string }>>();
  for (const item of extensions.navItems) {
    const group = item.extension.nav?.group || "业务";
    const label = item.extension.nav?.label || item.extension.title;
    const icon = item.extension.nav?.icon || "engine";
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
function toggleSidebar() {
  collapsed.value = !collapsed.value;
  localStorage.setItem("wf-sidebar", collapsed.value ? "collapsed" : "open");
}
async function signOut() {
  resetWeflowWorkspaceStores();
  await auth.logout();
  await router.replace("/login");
}
onMounted(() => {
  applyTheme();
  void extensions.load();
});
</script>

<template>
  <div class="wf-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="wf-sidebar">
      <div class="wf-brand">
        <span class="wf-brand-wordmark"><b>We</b>flow</span>
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
      <div class="wf-user-area">
        <details class="wf-row-menu wf-user-menu">
          <summary class="wf-user-trigger" title="账号">
            <img
              v-if="auth.user?.avatarUrl"
              :src="auth.user.avatarUrl"
              :alt="agentDisplayName(auth.user)"
              class="wf-user-avatar-img"
            />
            <span v-else class="wf-avatar">
              {{ (auth.user?.username ?? "值").slice(0, 1).toUpperCase() }}
            </span>
            <span class="wf-user-name">
              <strong>{{ agentDisplayName(auth.user) }}</strong>
            </span>
          </summary>
          <div>
            <button @click="router.push('/account/profile')">信息名片</button>
            <button @click="signOut">退出登录</button>
          </div>
        </details>
        <button
          class="wf-user-help"
          title="技术文档"
          @click="router.push('/help')"
        >
          <span class="wf-user-help-full">技术文档</span>
          <span class="wf-user-help-short">?</span>
        </button>
      </div>
    </aside>
    <main class="wf-main">
      <header class="wf-topbar">
        <div class="wf-topbar-title">
          <span class="wf-topbar-crumb">共享工作空间</span>
          <span class="wf-topbar-sep">/</span>
          <strong>{{ pageTitle }}</strong>
        </div>
        <div class="wf-topbar-actions">
          <CommandPalette />
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
  <WfConfirmDialog />
</template>

<style scoped>
.wf-topbar {
  justify-content: space-between;
}
.wf-topbar-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 13px;
}
.wf-topbar-crumb {
  color: var(--wf-text-muted);
}
.wf-topbar-sep {
  color: var(--wf-border-strong);
}
.wf-topbar-title strong {
  font-weight: 650;
  letter-spacing: -0.01em;
}
.wf-user-avatar-img {
  width: 30px;
  height: 30px;
  flex: 0 0 30px;
  border-radius: 50%;
  object-fit: cover;
}
.wf-user-help {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  padding: 6px 7px;
  border: none;
  background: transparent;
  color: var(--wf-text);
  font-size: 12px;
  font-weight: 600;
  border-radius: var(--wf-radius-control);
  cursor: pointer;
  white-space: nowrap;
}
.wf-user-help:hover {
  background: var(--wf-surface-soft);
}
.wf-user-help-short {
  display: none;
}
.is-collapsed .wf-user-help-full {
  display: none;
}
.is-collapsed .wf-user-help-short {
  display: inline;
}
</style>
