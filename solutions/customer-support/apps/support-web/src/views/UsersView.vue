<script setup lang="ts">
/**
 * 用户与角色（admin only）。功能自平台壳迁移重实现，复用既有
 * `/api/v1/admin/users*` 接口：发放账号 / 修改角色 / 重置密码 /
 * 撤销 Session / 禁用启用 + 筛选与分页。
 */
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "../api";
import { statusTone } from "../components/status-tone";
import WfIcon from "../components/WfIcon.vue";
import StaffAvatar from "../components/StaffAvatar.vue";
import { useEscClose } from "../composables/use-esc-close";
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

useEscClose(computed(() => createOpen.value || roleOpen.value), () => {
  createOpen.value = false;
  roleOpen.value = false;
});

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
  <div class="wf-page">
    <header class="wf-page-head">
      <div>
        <h1>用户与角色</h1>
        <p>管理 Weflow 账号、角色与登录状态。</p>
      </div>
      <button class="wf-button primary" @click="startCreate">发放账号</button>
    </header>

    <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="wf-notice" role="status">{{ notice }}</div>

    <section class="wf-panel">
      <div class="wf-panel-head">
        <div>
          <h2>共享工作空间成员</h2>
          <span class="wf-muted">共 {{ users.length }} 人</span>
        </div>
        <div class="wf-user-filters">
          <select v-model="roleFilter" class="wf-select">
            <option value="">全部角色</option>
            <option value="admin">管理员</option>
            <option value="operator">操作员</option>
          </select>
          <select v-model="statusFilter" class="wf-select">
            <option value="">全部状态</option>
            <option value="active">正常</option>
            <option value="disabled">已禁用</option>
          </select>
        </div>
      </div>
      <div class="wf-table-wrap">
        <table class="wf-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>角色</th>
              <th>状态</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="user in pagedUsers" :key="user.userId">
              <td>
                <div class="wf-user-cell">
                  <StaffAvatar
                    :user-id="user.userId"
                    :fallback-text="user.username"
                    :avatar-url="user.avatarUrl ?? null"
                  />
                  <div>
                    <strong>{{ user.displayName || user.username }}</strong>
                    <div v-if="user.mustChangePassword" class="wf-muted">
                      等待首次设置密码
                    </div>
                  </div>
                </div>
              </td>
              <td>{{ user.role === "admin" ? "管理员" : "操作员" }}</td>
              <td>
                <span
                  v-if="user.status !== 'active'"
                  class="wf-status"
                  :class="statusTone(user.status)"
                >已禁用</span>
                <span v-else class="wf-muted">正常</span>
              </td>
              <td class="wf-muted">
                {{ new Date(user.createdAt).toLocaleDateString() }}
              </td>
              <td>
                <details class="wf-row-menu">
                  <summary class="wf-icon-button" title="更多操作">
                    <WfIcon name="more" :size="17" />
                  </summary>
                  <div>
                    <button @click="startRoleChange(user)">修改角色</button>
                    <button @click="reset(user)">重置密码</button>
                    <button @click="revokeSessions(user)">撤销 Session</button>
                    <button
                      :class="{ danger: user.status === 'active' }"
                      @click="toggleStatus(user)"
                    >
                      {{ user.status === "active" ? "禁用账号" : "启用账号" }}
                    </button>
                  </div>
                </details>
              </td>
            </tr>
            <tr v-if="!pagedUsers.length">
              <td colspan="5" class="wf-empty">暂无成员</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="wf-pagination">
        <span class="wf-muted">
          共 {{ filteredUsers.length }} 人 · 第 {{ page }} / {{ totalPages }} 页
        </span>
        <button
          class="wf-button compact"
          :disabled="page <= 1"
          @click="page = Math.max(1, page - 1); syncQuery()"
        >
          上一页
        </button>
        <button
          class="wf-button compact"
          :disabled="page >= totalPages"
          @click="page = Math.min(totalPages, page + 1); syncQuery()"
        >
          下一页
        </button>
      </div>
    </section>

    <div v-if="createOpen" class="wf-modal-mask" @click.self="createOpen = false">
      <div class="wf-modal" role="dialog" aria-modal="true" aria-label="发放账号">
        <div class="wf-modal-head">
          <h3>{{ initialPassword ? "一次性初始密码" : "发放封闭账号" }}</h3>
          <button class="wf-icon-button" @click="createOpen = false">
            <WfIcon name="close" :size="17" />
          </button>
        </div>
        <div class="wf-modal-body">
          <template v-if="initialPassword">
            <p>请通过安全渠道交付。关闭后系统不会再次显示该密码。</p>
            <div class="wf-secret-output wf-mono">{{ initialPassword }}</div>
            <button class="wf-button compact" @click="copyPassword(initialPassword)">
              复制密码
            </button>
          </template>
          <template v-else>
            <div class="wf-field">
              <label>用户名</label>
              <input
                v-model="username"
                class="wf-input"
                placeholder="3–64 位小写字母、数字或 . _ -"
              />
            </div>
            <div class="wf-field">
              <label>角色</label>
              <select v-model="role" class="wf-select">
                <option value="operator">操作员</option>
                <option value="admin">管理员</option>
              </select>
            </div>
          </template>
        </div>
        <div class="wf-modal-foot">
          <button
            v-if="!initialPassword"
            class="wf-button primary"
            :disabled="saving || username.length < 3"
            @click="create"
          >
            生成一次性密码
          </button>
          <button v-else class="wf-button primary" @click="createOpen = false">
            我已安全保存
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="roleOpen && roleTarget"
      class="wf-modal-mask"
      @click.self="roleOpen = false"
    >
      <div class="wf-modal wf-modal-narrow" role="dialog" aria-modal="true" aria-label="修改角色">
        <div class="wf-modal-head">
          <h3>修改角色 · {{ roleTarget.username }}</h3>
          <button class="wf-icon-button" @click="roleOpen = false">
            <WfIcon name="close" :size="17" />
          </button>
        </div>
        <div class="wf-modal-body">
          <div class="wf-assignee-list">
            <button
              class="wf-assignee-row"
              :class="{ active: roleTarget.role === 'operator' }"
              @click="roleTarget.role = 'operator'"
            >
              操作员
            </button>
            <button
              class="wf-assignee-row"
              :class="{ active: roleTarget.role === 'admin' }"
              @click="roleTarget.role = 'admin'"
            >
              管理员
            </button>
          </div>
        </div>
        <div class="wf-modal-foot">
          <button class="wf-button" @click="roleOpen = false">取消</button>
          <button class="wf-button primary" @click="confirmRoleChange">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wf-user-filters {
  display: flex;
  align-items: center;
  gap: 8px;
}
.wf-user-filters .wf-select {
  min-width: 120px;
  width: auto;
}
.wf-user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.wf-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 16px;
  border-top: 1px solid var(--wf-border);
}
</style>
