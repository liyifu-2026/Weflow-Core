import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api } from "./api";

export type WeflowUser = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
  avatarUrl?: string | null;
  avatarPreset?: string | null;
  displayName?: string | null;
  tags?: string[];
};

export type AgentTag = { key: string; displayName: string };

export const useWeflowAuthStore = defineStore("weflow-auth", () => {
  const user = ref<WeflowUser | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const isAdmin = computed(() => user.value?.role === "admin");
  let inflight: Promise<void> | null = null;

  async function ensureSession() {
    if (initialized.value) return;
    // Concurrent callers (e.g. route guards racing the App.vue bootstrap
    // fetch) must await the same request instead of seeing isAdmin=false.
    if (inflight) return inflight;
    loading.value = true;
    inflight = (async () => {
      try {
        const result = await api<{ user: WeflowUser }>("/api/v1/auth/me");
        user.value = result.user;
      } catch {
        user.value = null;
      } finally {
        initialized.value = true;
        loading.value = false;
        inflight = null;
      }
    })();
    return inflight;
  }

  async function login(username: string, password: string) {
    const result = await api<{ user: WeflowUser }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    user.value = result.user;
    initialized.value = true;
  }

  async function logout() {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } finally {
      user.value = null;
      initialized.value = true;
    }
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

  async function fetchTagVocabulary(): Promise<AgentTag[]> {
    const result = await api<{ tags: AgentTag[] }>(
      "/api/v1/auth/tag-vocabulary",
    );
    return result.tags;
  }

  /** 上传客服头像（multipart），成功后更新本地用户缓存 */
  async function uploadAvatar(file: File): Promise<string> {
    const form = new FormData();
    form.append("file", file);
    const result = await api<{ avatarUrl: string }>("/api/v1/auth/avatar", {
      method: "POST",
      body: form,
    });
    if (user.value) {
      user.value = { ...user.value, avatarUrl: result.avatarUrl, avatarPreset: null };
    }
    return result.avatarUrl;
  }

  /** 更新个人资料（显示名；null = 清除回落为用户名），返回更新后的用户 */
  async function updateProfile(input: {
    displayName?: string | null;
  }): Promise<WeflowUser> {
    const result = await api<{ user: WeflowUser }>("/api/v1/auth/me", {
      method: "PUT",
      body: JSON.stringify(input),
    });
    user.value = result.user;
    return result.user;
  }

  /** 选择预设头像（null = 恢复默认），返回更新后的用户 */
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
    logout,
    changePassword,
    fetchTagVocabulary,
    uploadAvatar,
    updateProfile,
    selectAvatarPreset,
  };
});
