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

type NavItem = { to: string; icon: LucideIcon; label: string };

const workbenchItems: NavItem[] = [
  { to: "/conversations", icon: MessageSquare, label: "会话" },
  { to: "/knowledge", icon: BookOpen, label: "知识库" },
  { to: "/assets", icon: Images, label: "素材" },
];

const adminItems: NavItem[] = [
  { to: "/ai-employees", icon: Bot, label: "AI员工" },
  { to: "/admin", icon: ListChecks, label: "管理" },
  { to: "/settings", icon: Settings, label: "设置" },
  { to: "/system/status", icon: ShieldCheck, label: "系统状态" },
  { to: "/system/users", icon: Users, label: "用户与角色" },
  { to: "/system/audit", icon: ScrollText, label: "审计日志" },
];

const navItems = computed<NavItem[]>(() =>
  auth.isAdmin ? [...workbenchItems, ...adminItems] : workbenchItems,
);

watch(
  () => route.fullPath,
  () => {
    window.scrollTo(0, 0);
  },
);

function applyTheme() {
  // 新样式走 .dark 类策略；data-theme 兼容尚未重写的旧 wf-* 页面，
  // 第 6 批删除 console-shared.css 后一并移除。
  document.documentElement.classList.toggle("dark", theme.value === "dark");
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
  <div class="flex h-screen overflow-hidden">
    <aside
      class="flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200"
      :class="collapsed ? 'w-16' : 'w-56'"
    >
      <div class="flex h-14 items-center justify-between px-4">
        <span
          v-if="!collapsed"
          class="text-lg font-semibold tracking-tight select-none"
        >WeFlow</span>
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
        class="flex-1 space-y-1 overflow-y-auto p-2"
        :class="collapsed && 'px-2'"
        aria-label="主导航"
      >
        <router-link
          v-for="item in navItems"
          :key="item.to"
          :to="item.to"
          class="flex h-9 items-center gap-2 rounded-md px-2 text-sm text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          :class="
            route.path === item.to
              ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
              : ''
          "
          active-class=""
          exact-active-class=""
          :title="collapsed ? item.label : undefined"
        >
          <component :is="item.icon" class="size-4 shrink-0" />
          <span v-if="!collapsed">{{ item.label }}</span>
        </router-link>
      </nav>

      <Separator class="bg-sidebar-border" />

      <div class="flex items-center gap-2 p-2">
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
          v-if="!collapsed"
          variant="ghost"
          size="icon"
          title="退出登录"
          aria-label="退出登录"
          @click="signOut"
        >
          <LogOut class="size-4" />
        </Button>
      </div>
    </aside>

    <div class="flex min-w-0 flex-1 flex-col">
      <header class="flex h-14 shrink-0 items-center justify-end border-b border-border px-4">
        <Button
          variant="ghost"
          size="icon"
          :title="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
          :aria-label="theme === 'light' ? '切换深色模式' : '切换浅色模式'"
          @click="toggleTheme"
        >
          <Moon v-if="theme === 'light'" class="size-4" />
          <Sun v-else class="size-4" />
        </Button>
      </header>
      <main class="min-h-0 flex-1 overflow-auto" tabindex="-1">
        <router-view />
      </main>
    </div>
  </div>
</template>
