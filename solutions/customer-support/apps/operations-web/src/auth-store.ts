import { computed, ref } from "vue";
import { defineStore } from "pinia";
import { api } from "./api";

export type WeflowUser = {
  userId: string;
  username: string;
  role: "admin" | "operator";
  mustChangePassword: boolean;
  avatarUrl?: string | null;
  displayName?: string | null;
  tags?: string[];
};

type UserProvider = () => WeflowUser | null;

let bridgeUserProvider: UserProvider | null = null;

/** Embedded mode: the ExtensionHost injects a read-only user snapshot. */
export function setAuthBridge(provider: UserProvider | null): void {
  bridgeUserProvider = provider;
}

export const useWeflowAuthStore = defineStore("weflow-auth", () => {
  const user = ref<WeflowUser | null>(null);
  const initialized = ref(false);
  const loading = ref(false);
  const isAdmin = computed(() => user.value?.role === "admin");

  async function ensureSession() {
    if (bridgeUserProvider) {
      const bridged = bridgeUserProvider();
      if (bridged) {
        user.value = bridged;
        initialized.value = true;
        return;
      }
      initialized.value = false;
    }
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

  async function logout() {
    try {
      await api("/api/v1/auth/logout", { method: "POST" });
    } finally {
      user.value = null;
      initialized.value = true;
    }
  }

  return {
    user,
    initialized,
    loading,
    isAdmin,
    ensureSession,
    logout,
  };
});
