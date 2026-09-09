/**
 * 最近登录账号模块
 * 本地只保存最近登录的用户名（最多 5 个、最近优先），用于快捷切换时预填登录表单。
 * 不保存 token、密码或任何会话数据；与敏感数据同一存储策略（SecureStore）。
 */
import { sensitiveStorage } from "@/storage/sensitive-storage";

const RECENT_ACCOUNTS_KEY = "weflow.mobile.recent-accounts";
const MAX_RECENT_ACCOUNTS = 5;

/** 读取最近登录的用户名列表（最近优先，最多 5 个） */
export async function loadRecentAccounts(): Promise<string[]> {
  const serialized = await sensitiveStorage.getItemAsync(RECENT_ACCOUNTS_KEY);
  if (!serialized) return [];
  try {
    const accounts = JSON.parse(serialized) as unknown;
    return Array.isArray(accounts)
      ? accounts
          .filter((value): value is string => typeof value === "string")
          .slice(0, MAX_RECENT_ACCOUNTS)
      : [];
  } catch {
    return [];
  }
}

/** 记录一次登录成功：去重、最近优先、最多保留 5 个 */
export async function recordRecentAccount(username: string): Promise<void> {
  const clean = username.trim();
  if (!clean) return;
  const accounts = await loadRecentAccounts();
  const next = [clean, ...accounts.filter((value) => value !== clean)].slice(
    0,
    MAX_RECENT_ACCOUNTS,
  );
  await sensitiveStorage.setItemAsync(
    RECENT_ACCOUNTS_KEY,
    JSON.stringify(next),
  );
}
