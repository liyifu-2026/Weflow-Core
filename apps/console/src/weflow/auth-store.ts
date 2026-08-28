import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api } from "./api";

export type WeflowUser = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
  /** 操作员头像相对路径（无头像为 null/undefined，兼容旧响应） */
  avatarUrl?: string | null;
  /** 当前选中的平台预设头像 id（未选为 null；选择器展示选中态） */
  avatarPreset?: string | null;
  /** 信息名片显示名（空 = 展示 username） */
  displayName?: string | null;
  /** 操作员自选专家标签（专家队列 key 列表） */
  tags?: string[];
};

/** 名片可选标签词表项（标签键与专家队列同源） */
export type AgentTag = { key: string; displayName: string };

export const useWeflowAuthStore = defineStore("weflow-auth", () => {
  const user = ref<WeflowUser | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const isAdmin = computed(() => user.value?.role === "admin");

  async function ensureSession() {
    if (initialized.value || loading.value) return;
    loading.value = true;
    try {
      const result = await api<{ user: WeflowUser }>("/api/v1/auth/me");
      user.value = result.user;
    } catch {
      user.value = null;
    } finally {
      initialized.value = true;
      loading.value = false;
    }
  }

  async function login(username: string, password: string) {
    const result = await api<{ user: WeflowUser }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    user.value = result.user;
    initialized.value = true;
  }

  async function changePassword(currentPassword: string, newPassword: string) {
    const result = await api<{ user: WeflowUser }>(
      "/api/v1/auth/change-password",
      {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword }),
      },
    );
    user.value = result.user;
  }

  async function logout() {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } finally {
      user.value = null;
      initialized.value = true;
    }
  }

  /** 获取信息名片可选标签词表 */
  async function fetchTagVocabulary(): Promise<AgentTag[]> {
    const result = await api<{ tags: AgentTag[] }>(
      "/api/v1/auth/tag-vocabulary",
    );
    return result.tags;
  }

  /** 更新信息名片资料（显示名 / 专家标签） */
  async function updateProfile(input: {
    displayName?: string | null;
    tags?: string[];
  }): Promise<WeflowUser> {
    const result = await api<{ user: WeflowUser }>("/api/v1/auth/me", {
      method: "PUT",
      body: JSON.stringify(input),
    });
    user.value = result.user;
    return result.user;
  }

  /** 上传/更换操作员头像（multipart；返回新的头像相对路径） */
  async function uploadAvatar(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file);
    const result = await api<{ avatarUrl: string }>("/api/v1/auth/avatar", {
      method: "POST",
      body: form,
    });
    if (user.value) {
      // 上传与预设二选一：上传生效后预设被服务端清除，本地同步
      user.value = { ...user.value, avatarUrl: result.avatarUrl, avatarPreset: null };
    }
    return result.avatarUrl;
  }

  /** 选择/清除平台预设头像（null = 恢复默认哈希预设） */
  async function selectAvatarPreset(preset: string | null): Promise<WeflowUser> {
    const result = await api<{ user: WeflowUser }>("/api/v1/auth/avatar", {
      method: "PATCH",
      body: JSON.stringify({ preset }),
    });
    user.value = result.user;
    return result.user;
  }

  return {
    user,
    initialized,
    loading,
    isAdmin,
    ensureSession,
    login,
    changePassword,
    logout,
    fetchTagVocabulary,
    updateProfile,
    uploadAvatar,
    selectAvatarPreset,
  };
});
