<script setup lang="ts">
/**
 * 用户与角色（admin only）。功能自平台壳迁移重实现，复用既有
 * `/api/v1/admin/users*` 接口：发放账号 / 修改角色 / 重置密码 /
 * 撤销 Session / 禁用启用 + 筛选与分页。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { MoreHorizontal } from "lucide-vue-next";
import { api } from "../api";
import StaffAvatar from "../components/StaffAvatar.vue";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { confirmDialog } from "../components/confirm-dialog";

type User = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  status: string;
  mustChangePassword: boolean;
  avatarUrl?: string | null;
  displayName?: string | null;
  createdAt: string;
};

const users = ref<User[]>([]);
const error = ref("");
const notice = ref("");
const createOpen = ref(false);
const username = ref("");
const role = ref<"admin" | "operator">("operator");
const initialPassword = ref("");
const saving = ref(false);
const roleOpen = ref(false);
const roleTarget = ref<User | null>(null);

async function load() {
  try {
    users.value = (await api<{ users: User[] }>("/api/v1/admin/users")).users;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "加载失败";
  }
}

async function create() {
  saving.value = true;
  try {
    const result = await api<{ user: User; initialPassword: string }>(
      "/api/v1/admin/users",
      {
        method: "POST",
        body: JSON.stringify({ username: username.value, role: role.value }),
      },
    );
    initialPassword.value = result.initialPassword;
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "创建失败";
  } finally {
    saving.value = false;
  }
}

async function update(user: User, patch: Record<string, string>) {
  try {
    error.value = "";
    await api(`/api/v1/admin/users/${user.userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await load();
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "更新失败";
  }
}

function startRoleChange(user: User) {
  roleTarget.value = { ...user };
  roleOpen.value = true;
}

async function confirmRoleChange() {
  const user = roleTarget.value;
  if (!user) return;
  roleOpen.value = false;
  roleTarget.value = null;
  await update(user, { role: user.role });
}

async function revokeSessions(user: User) {
  if (
    !(await confirmDialog(
      `撤销 ${user.username} 的全部 Session？用户需要重新登录；账号和数据不会删除。`,
    ))
  )
    return;
  try {
    await api(`/api/v1/admin/users/${user.userId}/revoke-sessions`, {
      method: "POST",
    });
    notice.value = `${user.username} 的全部会话已撤销`;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "会话撤销失败";
  }
}

async function reset(user: User) {
  if (
    !(await confirmDialog(
      `重置 ${user.username} 的密码并撤销全部 Session？旧密码将立即失效。`,
    ))
  )
    return;
  try {
    initialPassword.value = (
      await api<{ initialPassword: string }>(
        `/api/v1/admin/users/${user.userId}/reset-password`,
        { method: "POST" },
      )
    ).initialPassword;
    createOpen.value = true;
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "重置失败";
  }
}

async function toggleStatus(user: User) {
  const disabling = user.status === "active";
  if (
    disabling &&
    !(await confirmDialog(
      `禁用 ${user.username}？该用户将无法登录，已有 Session 会按服务端规则处理。`,
    ))
  )
    return;
  await update(user, { status: disabling ? "disabled" : "active" });
}

function startCreate() {
  username.value = "";
  role.value = "operator";
  initialPassword.value = "";
  createOpen.value = true;
}

async function copyPassword(password: string) {
  try {
    await navigator.clipboard.writeText(password);
    notice.value = "初始密码已复制";
  } catch {
    notice.value = "复制失败，请手动抄录";
  }
}

const route = useRoute();
const router = useRouter();
const roleFilter = ref(typeof route.query.role === "string" ? route.query.role : "");
const statusFilter = ref(
  typeof route.query.status === "string" ? route.query.status : "",
);
const page = ref(1);
const pageSize = 10;

const filteredUsers = computed(() =>
  users.value.filter((user) => {
    const matchRole = !roleFilter.value || user.role === roleFilter.value;
    const matchStatus =
      !statusFilter.value || user.status === statusFilter.value;
    return matchRole && matchStatus;
  }),
);

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredUsers.value.length / pageSize)),
);
const pagedUsers = computed(() => {
  const start = (page.value - 1) * pageSize;
  return filteredUsers.value.slice(start, start + pageSize);
});

function syncQuery() {
  const query: Record<string, string> = {};
  if (roleFilter.value) query.role = roleFilter.value;
  if (statusFilter.value) query.status = statusFilter.value;
  void router.replace({ query });
}

watch([roleFilter, statusFilter], () => {
  page.value = 1;
  syncQuery();
});

onMounted(load);
</script>

<template>
  <div class="mx-auto w-full max-w-6xl p-6">
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">用户与角色</h1>
        <p class="mt-1 text-sm text-muted-foreground">
          管理 Weflow 账号、角色与登录状态。
        </p>
      </div>
      <Button @click="startCreate">发放账号</Button>
    </div>

    <p v-if="error" class="mt-4 text-sm text-destructive" role="alert">{{ error }}</p>
    <p v-if="notice" class="mt-4 text-sm text-muted-foreground" role="status">{{ notice }}</p>

    <div class="mt-6 overflow-hidden rounded-md border border-border">
      <div class="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 class="text-sm font-medium">共享工作空间成员</h2>
          <p class="text-xs text-muted-foreground">共 {{ users.length }} 人</p>
        </div>
        <div class="flex items-center gap-2">
          <select
            v-model="roleFilter"
            aria-label="按角色筛选"
            class="h-9 rounded-md border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <option value="">全部角色</option>
            <option value="admin">管理员</option>
            <option value="operator">操作员</option>
          </select>
          <select
            v-model="statusFilter"
            aria-label="按状态筛选"
            class="h-9 rounded-md border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已禁用</option>
          </select>
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>账号</TableHead>
            <TableHead>角色</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>创建时间</TableHead>
            <TableHead class="w-12"><span class="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="user in pagedUsers" :key="user.userId">
            <TableCell>
              <div class="flex items-center gap-3">
                <StaffAvatar
                  :user-id="user.userId"
                  :fallback-text="user.username"
                  :avatar-url="user.avatarUrl ?? null"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">
                    {{ user.displayName || user.username }}
                  </p>
                  <p v-if="user.mustChangePassword && user.status === 'active'" class="text-xs text-muted-foreground">
                    等待首次设置密码
                  </p>
                </div>
              </div>
            </TableCell>
            <TableCell>{{ user.role === "admin" ? "管理员" : "操作员" }}</TableCell>
            <TableCell>
              <Badge v-if="user.status !== 'active'" variant="destructive">已禁用</Badge>
              <span v-else class="text-sm text-muted-foreground">正常</span>
            </TableCell>
            <TableCell class="text-muted-foreground">
              {{ new Date(user.createdAt).toLocaleDateString() }}
            </TableCell>
            <TableCell>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon" title="更多操作">
                    <MoreHorizontal class="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem @click="startRoleChange(user)">
                    修改角色
                  </DropdownMenuItem>
                  <DropdownMenuItem @click="reset(user)">重置密码</DropdownMenuItem>
                  <DropdownMenuItem @click="revokeSessions(user)">
                    撤销 Session
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    :class="user.status === 'active' && 'text-destructive'"
                    @click="toggleStatus(user)"
                  >
                    {{ user.status === "active" ? "禁用账号" : "启用账号" }}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
          <TableRow v-if="!pagedUsers.length">
            <TableCell colspan="5" class="text-center text-muted-foreground">
              暂无成员
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>

      <div class="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
        <span class="text-sm text-muted-foreground">
          共 {{ filteredUsers.length }} 人 · 第 {{ page }} / {{ totalPages }} 页
        </span>
        <Button
          variant="outline"
          size="sm"
          :disabled="page <= 1"
          @click="page = Math.max(1, page - 1); syncQuery()"
        >
          上一页
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="page >= totalPages"
          @click="page = Math.min(totalPages, page + 1); syncQuery()"
        >
          下一页
        </Button>
      </div>
    </div>

    <Dialog
      :open="createOpen"
      @update:open="(open: boolean) => { createOpen = open; if (!open) initialPassword = ''; }"
    >
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle>{{ initialPassword ? "一次性初始密码" : "发放封闭账号" }}</DialogTitle>
          <DialogDescription v-if="initialPassword">
            请通过安全渠道交付。关闭后系统不会再次显示该密码。
          </DialogDescription>
        </DialogHeader>

        <template v-if="initialPassword">
          <p class="font-mono text-sm" role="status">{{ initialPassword }}</p>
          <DialogFooter class="gap-2">
            <Button variant="outline" @click="copyPassword(initialPassword)">
              复制密码
            </Button>
            <Button @click="createOpen = false">我已安全保存</Button>
          </DialogFooter>
        </template>
        <template v-else>
          <div class="space-y-4">
            <div class="space-y-2">
              <Label for="new-username">用户名</Label>
              <Input
                id="new-username"
                v-model="username"
                placeholder="3–64 位小写字母、数字或 . _ -"
              />
            </div>
            <div class="space-y-2">
              <Label for="new-role">角色</Label>
              <select
                id="new-role"
                v-model="role"
                class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <option value="operator">操作员</option>
                <option value="admin">管理员</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button :disabled="saving || username.length < 3" @click="create">
              生成一次性密码
            </Button>
          </DialogFooter>
        </template>
      </DialogContent>
    </Dialog>

    <Dialog :open="roleOpen && Boolean(roleTarget)" @update:open="(open: boolean) => !open && (roleOpen = false)">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle>修改角色 · {{ roleTarget?.username }}</DialogTitle>
        </DialogHeader>
        <div v-if="roleTarget" class="space-y-2">
          <label
            v-for="option in ['operator', 'admin'] as const"
            :key="option"
            class="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 text-sm transition-colors hover:bg-muted/50"
            :class="roleTarget.role === option && 'border-primary'"
          >
            <input
              v-model="roleTarget.role"
              type="radio"
              name="role-option"
              :value="option"
              class="accent-foreground"
            />
            {{ option === "operator" ? "操作员" : "管理员" }}
          </label>
        </div>
        <DialogFooter class="gap-2">
          <Button variant="outline" @click="roleOpen = false">取消</Button>
          <Button @click="confirmRoleChange">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
