<script setup lang="ts">
/**
 * 产品应用布局：单一侧栏（工作台导航）+ 顶栏（主题切换）。
 * 登录 / 改密页不经过本布局。样式全部走 Tailwind 语义类 + shadcn 组件。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  Bot,
  BookOpen,
  Images,
  ListChecks,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  ScrollText,
  Settings,
  ShieldCheck,
  Sun,
  Users,
  LogOut,
  type LucideIcon,
  Clock,

} from "lucide-vue-next";
import { useWeflowAuthStore } from "../auth-store";
import { Button } from "../components/ui/button";
import { Separator } from "../components/ui/separator";
import StaffAvatar from "../components/StaffAvatar.vue";
import { resetSupportWorkspaceStores } from "../stores/reset";

const router = useRouter();
const route = useRoute();
const auth = useWeflowAuthStore();
const collapsed = ref(localStorage.getItem("wf-sidebar") === "collapsed");
const theme = ref<"light" | "dark">(
  localStorage.getItem("wf-theme") === "dark" ? "dark" : "light",
);

type NavItem = { to: string; icon: LucideIcon; label: string; group: "workbench" | "admin" };

const workbenchItems: NavItem[] = [
  { to: "/conversations", icon: MessageSquare, label: "会话", group: "workbench" },
  { to: "/knowledge", icon: BookOpen, label: "知识库", group: "workbench" },
  { to: "/assets", icon: Images, label: "素材", group: "workbench" },
  { to: "/scheduled-sends", icon: Clock, label: "定时任务", group: "workbench" },
];

const adminItems: NavItem[] = [
  { to: "/ai-employees", icon: Bot, label: "AI员工", group: "admin" },
  { to: "/admin", icon: ListChecks, label: "管理", group: "admin" },
  { to: "/settings", icon: Settings, label: "设置", group: "admin" },
  { to: "/system/status", icon: ShieldCheck, label: "系统状态", group: "admin" },
  { to: "/system/users", icon: Users, label: "用户与角色", group: "admin" },
  { to: "/system/audit", icon: ScrollText, label: "审计日志", group: "admin" },
];

const navItems = computed<NavItem[]>(() =>
  auth.isAdmin ? [...workbenchItems, ...adminItems] : workbenchItems,
);
const GROUP_LABELS: Record<NavItem["group"], string> = {
  workbench: "工作台",
  admin: "管理",
};
const navGroups = computed<Array<{ key: NavItem["group"]; items: NavItem[] }>>(() => {
  const groups: Array<{ key: NavItem["group"]; items: NavItem[] }> = [];
  for (const item of navItems.value) {
    const last = groups.at(-1);
    if (last && last.key === item.group) last.items.push(item);
    else groups.push({ key: item.group, items: [item] });
  }
  return groups;
});

watch(
  () => route.fullPath,
  () => {
    window.scrollTo(0, 0);
  },
);

function applyTheme() {
  document.documentElement.classList.toggle("dark", theme.value === "dark");
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
  <div class="flex h-screen overflow-hidden">
    <aside
      class="flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)]"
      :class="collapsed ? 'w-16' : 'w-56'"
    >
      <div class="flex h-14 items-center justify-between px-4">
        <router-link
          v-if="!collapsed"
          to="/conversations"
          class="flex select-none items-center gap-2 text-[15px] font-semibold tracking-tight"
          title="WeFlow"
        >
          <svg width="22" height="22" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
            <path d="M5 21c3-11 7 11 11 0s7 11 11 0" />
            <path d="M5 26h22" opacity=".35" />
          </svg>
          <span><b class="font-extrabold">We</b><span class="font-medium text-muted-foreground">Flow</span></span>
        </router-link>
        <svg
          v-else
          width="24" height="24" viewBox="0 0 32 32" fill="none" stroke="currentColor"
          stroke-width="3" stroke-linecap="round" aria-hidden="true" class="mx-auto"
        >
          <path d="M5 21c3-11 7 11 11 0s7 11 11 0" />
          <path d="M5 26h22" opacity=".35" />
        </svg>
        <Button
          variant="ghost"
          size="icon"
          :title="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          @click="toggleSidebar"
        >
          <PanelLeftClose v-if="!collapsed" class="size-4" />
          <PanelLeftOpen v-else class="size-4" />
        </Button>
      </div>

      <Separator class="bg-sidebar-border" />

      <nav
        class="flex-1 overflow-y-auto p-2"
        :class="collapsed && 'px-2'"
        aria-label="主导航"
      >
        <template v-for="(group, gi) in navGroups" :key="group.key">
          <p
            v-if="!collapsed"
            class="px-2 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/60 first:pt-1"
          >
            {{ GROUP_LABELS[group.key] }}
          </p>
          <div v-else-if="gi > 0" class="mx-2 my-2 border-t border-sidebar-border/60" />
          <router-link
            v-for="item in group.items"
            :key="item.to"
            :to="item.to"
            class="relative flex h-9 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/70 transition-all duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            :class="
              route.path === item.to
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : ''
            "
            active-class=""
            exact-active-class=""
            :title="collapsed ? item.label : undefined"
          >
            <span
              v-if="route.path === item.to"
              class="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary"
              aria-hidden="true"
            />
            <component :is="item.icon" class="size-4 shrink-0" />
            <span v-if="!collapsed">{{ item.label }}</span>
          </router-link>
        </template>
      </nav>

      <Separator class="bg-sidebar-border" />

      <div class="flex items-center gap-1 p-2" :class="collapsed && 'flex-col'">
        <router-link
          to="/profile"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 transition-colors hover:bg-sidebar-accent"
          title="个人资料"
        >
          <StaffAvatar
            :user-id="auth.user?.userId ?? null"
            :fallback-text="auth.user?.displayName || auth.user?.username || 'W'"
            :avatar-url="auth.user?.avatarUrl ?? null"
          />
          <span v-if="!collapsed" class="flex min-w-0 flex-col leading-tight">
            <span class="truncate text-sm font-medium">
              {{ auth.user?.displayName || auth.user?.username }}
            </span>
            <span class="text-xs text-muted-foreground">
              {{ auth.isAdmin ? "管理员" : "客服" }}
            </span>
          </span>
        </router-link>
        <Button
          variant="ghost"
          size="icon"
          class="shrink-0"
          :title="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
          :aria-label="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
          @click="toggleTheme"
        >
          <Moon v-if="theme === 'light'" class="size-4" />
          <Sun v-else class="size-4" />
        </Button>
        <Button
          v-if="!collapsed"
          variant="ghost"
          size="icon"
          class="shrink-0"
          title="退出登录"
          aria-label="退出登录"
          @click="signOut"
        >
          <LogOut class="size-4" />
        </Button>
      </div>
    </aside>

    <div class="min-w-0 flex-1">
      <main class="h-full overflow-auto" tabindex="-1">
        <router-view />
      </main>
    </div>
  </div>
</template>
