/**
 * 敏感数据存储核心模块
 * 提供跨平台的安全存储抽象：
 * - Web 平台：使用内存 Map（不持久化，避免泄露到浏览器存储）
 * - iOS/Android 平台：使用 expo-secure-store（数据加密存储在设备安全区域）
 * 所有会话令牌、草稿和离线缓存都通过此模块存储。
 */
/** 原生 SecureStore 适配器接口 */
export type SecureStoreAdapter = {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  isAvailableAsync(): Promise<boolean>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/** 统一的安全存储接口 */
export type SensitiveStorage = {
  deleteItemAsync(key: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
};

/** 创建平台适配的安全存储实例 */
export function createSensitiveStorage(
  platform: string,
  secureStore: SecureStoreAdapter,
): SensitiveStorage {
  // Web 平台使用内存存储，避免敏感数据泄露到浏览器 localStorage
  if (platform === "web") {
    const values = new Map<string, string>();
    return {
      deleteItemAsync(key) {
        values.delete(key);
        return Promise.resolve();
      },
      getItemAsync(key) {
        return Promise.resolve(values.get(key) ?? null);
      },
      setItemAsync(key, value) {
        values.set(key, value);
        return Promise.resolve();
      },
    };
  }

  async function requireSecureStore(): Promise<void> {
    if (!(await secureStore.isAvailableAsync())) {
      throw new Error("SecureStore is unavailable on this device");
    }
  }

  return {
    async deleteItemAsync(key) {
      await requireSecureStore();
      await secureStore.deleteItemAsync(key);
    },
    async getItemAsync(key) {
      await requireSecureStore();
      return secureStore.getItemAsync(key);
    },
    async setItemAsync(key, value) {
      await requireSecureStore();
      await secureStore.setItemAsync(key, value);
    },
  };
}
