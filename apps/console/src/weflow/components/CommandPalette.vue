<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useWeflowAuthStore } from "../auth-store";
import { api } from "../api";
import WfIcon from "./WfIcon.vue";

type Command = {
  key: string;
  kind: string;
  title: string;
  detail: string;
  to?: { path: string; query?: Record<string, string> };
};

const auth = useWeflowAuthStore();
const router = useRouter();
const open = ref(false);
const query = ref("");
const input = ref<HTMLInputElement | null>(null);
const activeIndex = ref(0);
const loaded = ref(false);
const shortcutLabel = computed(() =>
  /Mac|iPhone|iPad/i.test(navigator.platform) ? "⌘K" : "Ctrl K",
);
const solutions = ref<
  Array<{
    solutionId: string;
    version: string;
    observedState: string;
    healthState: string;
  }>
>([]);
const users = ref<
  Array<{ userId: string; username: string; role: string; status: string }>
>([]);

const pages = computed<Command[]>(() => [
  {
    key: "page-overview",
    kind: "页面",
    title: "平台总览",
    detail: "查看业务方案生命周期与健康",
    to: { path: "/" },
  },
  ...(auth.isAdmin
    ? [
        {
          key: "page-solutions",
          kind: "页面",
          title: "业务方案",
          detail: "管理已接入方案的安装与状态",
          to: { path: "/platform/solutions" },
        },
      ]
    : []),
  {
    key: "page-status",
    kind: "页面",
    title: "系统状态",
    detail: "检查服务配置与健康",
    to: { path: "/system/status" },
  },
  ...(auth.isAdmin
    ? [
        {
          key: "page-users",
          kind: "页面",
          title: "用户与角色",
          detail: "管理平台账号",
          to: { path: "/system/users" },
        },
        {
          key: "page-audit",
          kind: "页面",
          title: "审计日志",
          detail: "查看关键操作记录",
          to: { path: "/system/audit" },
        },
      ]
    : []),
]);

function solutionStateLabel(value: string) {
  const map: Record<string, string> = {
    absent: "未安装",
    installing: "安装中",
    installed: "已安装",
    configured: "已配置",
    activating: "激活中",
    active: "已激活",
    degraded: "降级",
    rolling_back: "回滚中",
    uninstalling: "卸载中",
    removed: "已卸载",
    failed: "失败",
    disabled: "停用",
    unknown: "未知",
  };
  return map[value] ?? value;
}

const dynamicCommands = computed<Command[]>(() => {
  const list: Command[] = [];
  for (const solution of solutions.value) {
    list.push({
      key: `solution-${solution.solutionId}`,
      kind: "方案",
      title: solution.solutionId,
      detail: `v${solution.version} · ${solutionStateLabel(solution.observedState)}`,
      to: { path: "/platform/solutions" },
    });
  }
  for (const user of users.value) {
    list.push({
      key: `user-${user.userId}`,
      kind: "用户",
      title: user.username,
      detail: user.role === "admin" ? "管理员" : "操作员",
      to: { path: "/system/users" },
    });
  }
  return list;
});

const results = computed(() => {
  const term = query.value.trim().toLowerCase();
  const all = [...pages.value, ...dynamicCommands.value];
  if (!term) return all;
  return all.filter((item) =>
    `${item.title} ${item.detail} ${item.kind}`.toLowerCase().includes(term),
  );
});

watch(results, () => {
  if (activeIndex.value >= results.value.length) activeIndex.value = 0;
});

async function loadData() {
  if (loaded.value || !auth.isAdmin) return;
  loaded.value = true;
  try {
    const [solutionData, userData] = await Promise.all([
      api<{ solutions: typeof solutions.value }>("/api/v1/admin/solutions").catch(
        () => ({ solutions: [] }),
      ),
      api<{ users: typeof users.value }>("/api/v1/admin/users").catch(() => ({
        users: [],
      })),
    ]);
    solutions.value = solutionData.solutions ?? [];
    users.value = userData.users ?? [];
  } catch {
    // 数据加载失败时命令面板仍可搜索页面
  }
}

function close() {
  open.value = false;
}
function show() {
  open.value = true;
  query.value = "";
  activeIndex.value = 0;
  void loadData();
  requestAnimationFrame(() => input.value?.focus());
}
function move(delta: number) {
  if (!results.value.length) return;
  activeIndex.value =
    (activeIndex.value + delta + results.value.length) % results.value.length;
}
async function choose(command: Command) {
  close();
  if (command.to) await router.push(command.to);
}
function onKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    open.value ? close() : show();
  } else if (event.key === "Escape" && open.value) close();
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onUnmounted(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <button
    class="wf-command-trigger"
    title="搜索和快速前往（Ctrl / ⌘ K）"
    @click="show"
  >
    <WfIcon name="search" :size="15" /><span>搜索</span><kbd>{{ shortcutLabel }}</kbd>
  </button>
  <Teleport to="body">
    <div v-if="open" class="wf-command-mask" @click.self="close">
      <section
        class="wf-command-panel"
        role="dialog"
        aria-modal="true"
        aria-label="全局搜索"
      >
        <div class="wf-command-input">
          <WfIcon name="search" :size="18" /><input
            ref="input"
            v-model="query"
            placeholder="页面、方案、用户…"
            @keydown.enter="results[activeIndex] && choose(results[activeIndex])"
            @keydown.down.prevent="move(1)"
            @keydown.up.prevent="move(-1)"
          /><kbd>ESC</kbd>
        </div>
        <div class="wf-command-results">
          <button
            v-for="(item, index) in results"
            :key="item.key"
            :class="{ active: index === activeIndex }"
            @mouseenter="activeIndex = index"
            @click="choose(item)"
          >
            <span class="wf-command-kind">{{ item.kind }}</span>
            <div>
              <strong>{{ item.title }}</strong
              ><small>{{ item.detail }}</small>
            </div>
            <span>↵</span>
          </button>
          <div v-if="!results.length" class="wf-command-loading">
            没有匹配项，试试方案名或用户名。
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.wf-command-results button.active {
  background: var(--wf-surface-hover);
  border-color: var(--wf-primary);
}
</style>
