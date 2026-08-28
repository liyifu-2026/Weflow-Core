<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api";
import { statusTone } from "../components/status-tone";
import PageHeader from "../components/PageHeader.vue";
import WfIcon from "../components/WfIcon.vue";
import { useEscClose } from "../composables/use-esc-close";
import { useFocusTrap } from "../composables/use-focus-trap";
import { confirmDialog } from "../components/confirm-dialog";
import { useRoute, useRouter } from "vue-router";
import DefaultAvatar from "../components/DefaultAvatar.vue";
type User = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  status: string;
  mustChangePassword: boolean;
  avatarUrl?: string | null;
  createdAt: string;
};
const users = ref<User[]>([]);
const error = ref("");
const notice = ref("");
const open = ref(false);
const username = ref("");
const role = ref<"admin" | "operator">("operator");
const password = ref("");
const saving = ref(false);
const roleOpen = ref(false);
const roleTarget = ref<User | null>(null);
const createModal = ref<HTMLElement | null>(null);
const roleModal = ref<HTMLElement | null>(null);
useFocusTrap(createModal, open);
useFocusTrap(roleModal, roleOpen);
useEscClose(computed(() => open.value || roleOpen.value), () => {
  open.value = false;
  roleOpen.value = false;
});
async function load() {
  try {
    users.value = (await api<{ users: User[] }>("/api/v1/admin/users")).users;
  } catch (r) {
    error.value = r instanceof Error ? r.message : "加载失败";
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
    password.value = result.initialPassword;
    await load();
  } catch (r) {
    error.value = r instanceof Error ? r.message : "创建失败";
  } finally {
    saving.value = false;
  }
}
async function update(user: User, patch: Record<string, string>) {
  try {
    notice.value = "";
    await api(`/api/v1/admin/users/${user.userId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await load();
  } catch (r) {
    error.value = r instanceof Error ? r.message : "更新失败";
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
  } catch (r) {
    error.value = r instanceof Error ? r.message : "会话撤销失败";
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
    password.value = (
      await api<{ initialPassword: string }>(
        `/api/v1/admin/users/${user.userId}/reset-password`,
        { method: "POST" },
      )
    ).initialPassword;
    open.value = true;
  } catch (r) {
    error.value = r instanceof Error ? r.message : "重置失败";
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
  password.value = "";
  open.value = true;
}
const route = useRoute();
const router = useRouter();
const userSearch = ref(
  typeof route.query.q === "string" ? route.query.q : "",
);
const roleFilter = ref(
  typeof route.query.role === "string" ? route.query.role : "",
);
const statusFilter = ref(
  typeof route.query.status === "string" ? route.query.status : "",
);
const page = ref(
  Math.max(1, Number(typeof route.query.page === "string" ? route.query.page : "1") || 1),
);
const pageSize = 10;

const filteredUsers = computed(() => {
  const q = userSearch.value.trim().toLowerCase();
  return users.value.filter((user) => {
    const matchSearch =
      !q ||
      user.username.toLowerCase().includes(q) ||
      (user.role === "admin" ? "管理员" : "操作员").includes(q);
    const matchRole = !roleFilter.value || user.role === roleFilter.value;
    const matchStatus =
      !statusFilter.value || user.status === statusFilter.value;
    return matchSearch && matchRole && matchStatus;
  });
});

const totalPages = computed(() =>
  Math.max(1, Math.ceil(filteredUsers.value.length / pageSize)),
);
const pagedUsers = computed(() => {
  const start = (page.value - 1) * pageSize;
  return filteredUsers.value.slice(start, start + pageSize);
});

function syncQuery() {
  const query: Record<string, string> = {};
  if (userSearch.value) query.q = userSearch.value;
  if (roleFilter.value) query.role = roleFilter.value;
  if (statusFilter.value) query.status = statusFilter.value;
  if (page.value > 1) query.page = String(page.value);
  void router.replace({ query });
}

function setPage(next: number) {
  page.value = Math.min(totalPages.value, Math.max(1, next));
  syncQuery();
}

watch([userSearch, roleFilter, statusFilter], () => {
  page.value = 1;
  syncQuery();
});
async function copyPassword(password: string) {
  try {
    await navigator.clipboard.writeText(password);
    notice.value = "初始密码已复制";
  } catch {
    notice.value = "复制失败，请手动抄录";
  }
}
onMounted(load);
</script>
<template>
  <div class="wf-page">
    <PageHeader title="用户" />
    <div v-if="error" class="wf-error" role="alert">{{ error }}</div>
    <div v-if="notice" class="wf-notice" role="status">{{ notice }}</div>
    <section class="wf-panel wf-users-panel">
      <div class="wf-panel-head">
        <div>
          <h2>共享工作空间成员</h2>
          <span class="wf-panel-caption">共 {{ users.length }} 人</span>
        </div>
        <button class="wf-button primary" @click="startCreate">发放账号</button>
      </div>
      <div class="wf-users-body">
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
      <table class="wf-table" data-card>
        <thead>
          <tr>
            <th>头像</th>
            <th>账号</th>
            <th>角色</th>
            <th>状态</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in pagedUsers" :key="user.userId">
            <td data-label="头像">
              <img
                v-if="user.avatarUrl"
                :src="user.avatarUrl"
                :alt="user.username"
                class="wf-user-avatar-cell"
              />
              <DefaultAvatar v-else :name="user.username" :size="28" />
            </td>
            <td data-label="账号">
                <strong>{{ user.username }}</strong>
              <div v-if="user.mustChangePassword" class="wf-muted">
                等待首次设置密码
              </div>
            </td>
            <td data-label="角色">{{ user.role === "admin" ? "管理员" : "操作员" }}</td>
            <td data-label="状态">
                <span
                  v-if="user.status !== 'active'"
                  class="wf-status"
                :class="statusTone(user.status)"
                >已禁用</span
              ><span v-else class="wf-muted">正常</span>
            </td>
            <td data-label="创建时间" class="wf-muted">
                {{ new Date(user.createdAt).toLocaleDateString() }}
            </td>
            <td data-label="操作">
                <details class="wf-row-menu">
                <summary class="wf-icon-button" title="更多操作"><WfIcon name="more" :size="17" /></summary>
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
        </tbody>
      </table>
      <div class="wf-pagination">
        <span class="wf-muted">
          共 {{ filteredUsers.length }} 人 · 第 {{ page }} / {{ totalPages }} 页
        </span>
        <button
          class="wf-button compact"
          :disabled="page <= 1"
          @click="setPage(page - 1)"
        >
          上一页
        </button>
        <button
          class="wf-button compact"
          :disabled="page >= totalPages"
          @click="setPage(page + 1)"
        >
          下一页
        </button>
      </div>
      </div>
    </section>
    <div v-if="open" class="wf-modal-mask" @click.self="open = false">
      <div ref="createModal" class="wf-modal" role="dialog" aria-modal="true" aria-label="发放账号">
        <div class="wf-modal-head">
          <h3>{{ password ? "一次性初始密码" : "发放封闭账号" }}</h3>
          <button class="wf-button ghost" @click="open = false"><WfIcon name="close" :size="17" /></button>
        </div>
        <div class="wf-modal-body">
          <template v-if="password"
            ><p>请通过安全渠道交付。关闭后系统不会再次显示该密码。</p>
            <div class="wf-secret-output wf-mono">
              {{ password }}
            </div>
            <button
              class="wf-button compact"
              @click="copyPassword(password)"
            >
              复制密码
            </button></template
          ><template v-else
            ><div class="wf-field">
              <label>用户名</label
              ><input
                v-model="username"
                class="wf-input"
                placeholder="3–64 位小写字母、数字或 . _ -"
              />
            </div>
            <div class="wf-field">
              <label>角色</label
              ><select v-model="role" class="wf-select">
                <option value="operator">操作员</option>
                <option value="admin">管理员</option>
              </select>
            </div></template
          >
        </div>
        <div class="wf-modal-foot">
          <button
            v-if="!password"
            class="wf-button primary"
            :disabled="saving || username.length < 3"
            @click="create"
          >
            生成一次性密码</button
          ><button v-else class="wf-button primary" @click="open = false">
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
      <div ref="roleModal" class="wf-modal wf-modal-narrow" role="dialog" aria-modal="true" aria-label="修改角色">
        <div class="wf-modal-head">
          <h3>修改角色 · {{ roleTarget.username }}</h3>
          <button class="wf-icon-button" @click="roleOpen = false"><WfIcon name="close" :size="17" /></button>
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
          <button class="wf-button" @click="roleOpen = false">取消</button
          ><button class="wf-button primary" @click="confirmRoleChange">
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wf-user-avatar-cell {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  display: block;
}
.wf-users-body {
  padding: 0 16px 14px;
}
.wf-user-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 14px 0;
}
.wf-user-filters .wf-search {
  flex: 1;
  min-width: 220px;
  max-width: 340px;
}
.wf-user-filters .wf-select {
  min-width: 140px;
  width: auto;
}
.wf-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 0 0;
  border-top: 1px solid var(--wf-border);
}
</style>
