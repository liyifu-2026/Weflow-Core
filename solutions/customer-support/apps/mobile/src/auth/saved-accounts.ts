/**
 * 已保存账号模块（QQ 式快捷登录）
 * 在设备安全区域按账号保存登录卡片：用户名、可选的记住密码、头像与名片展示信息。
 * 「下次自动登录」勾选时保存密码（SecureStore 设备加密）；不勾选则只记住账号与头像。
 * 最多保存 5 个、最近优先；与敏感数据同一存储策略，不进入未受保护的系统备份。
 */
import { sensitiveStorage } from "@/storage/sensitive-storage";

const SAVED_ACCOUNTS_KEY = "weflow.mobile.saved-accounts";
const MAX_SAVED_ACCOUNTS = 5;

/** 已保存账号卡片（password 仅在勾选「下次自动登录」时存在） */
export type SavedAccount = {
  username: string;
  password?: string;
  avatarUrl?: string | null;
  /** 当前选中的平台预设头像 id（登录页据此渲染本地打包的预设 SVG） */
  avatarPreset?: string | null;
  displayName?: string | null;
  /** 最近一次登录时间（ISO；用于最近优先排序） */
  savedAt: string;
};

/** 读取已保存账号（最近优先，最多 5 个；数据损坏时返回空列表） */
export async function loadSavedAccounts(): Promise<SavedAccount[]> {
  const serialized = await sensitiveStorage.getItemAsync(SAVED_ACCOUNTS_KEY);
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (value): value is SavedAccount =>
          typeof value === "object" &&
          value !== null &&
          typeof (value as SavedAccount).username === "string",
      )
      .slice(0, MAX_SAVED_ACCOUNTS);
  } catch {
    return [];
  }
}

/**
 * 记住一个账号（登录成功时调用）。
 * password 传字符串 = 保存/更新记住的密码；传 undefined = 不记住密码并清除旧密码
 * （用户取消勾选「下次自动登录」的语义）。
 */
export async function rememberAccount(account: {
  username: string;
  password?: string;
  avatarUrl?: string | null;
  avatarPreset?: string | null;
  displayName?: string | null;
}): Promise<void> {
  const clean = account.username.trim();
  if (!clean) return;
  const accounts = await loadSavedAccounts();
  const existing = accounts.find((value) => value.username === clean);
  const next: SavedAccount = {
    username: clean,
    ...(account.password ? { password: account.password } : {}),
    avatarUrl: account.avatarUrl ?? existing?.avatarUrl ?? null,
    avatarPreset: account.avatarPreset ?? existing?.avatarPreset ?? null,
    displayName: account.displayName ?? existing?.displayName ?? null,
    savedAt: new Date().toISOString(),
  };
  const ordered = [
    next,
    ...accounts.filter((value) => value.username !== clean),
  ].slice(0, MAX_SAVED_ACCOUNTS);
  await sensitiveStorage.setItemAsync(
    SAVED_ACCOUNTS_KEY,
    JSON.stringify(ordered),
  );
}

/**
 * 刷新账号展示信息（切号/退出时调用）。
 * 只更新头像、名片名与时间戳；保留已记住的密码。
 */
export async function touchAccount(
  username: string,
  info: { avatarUrl?: string | null; avatarPreset?: string | null; displayName?: string | null },
): Promise<void> {
  const clean = username.trim();
  if (!clean) return;
  const accounts = await loadSavedAccounts();
  const existing = accounts.find((value) => value.username === clean);
  if (!existing) {
    await rememberAccount({ username: clean, ...info });
    return;
  }
  const next: SavedAccount = {
    ...existing,
    avatarUrl: info.avatarUrl ?? existing.avatarUrl ?? null,
    avatarPreset: info.avatarPreset ?? existing.avatarPreset ?? null,
    displayName: info.displayName ?? existing.displayName ?? null,
    savedAt: new Date().toISOString(),
  };
  const ordered = [
    next,
    ...accounts.filter((value) => value.username !== clean),
  ].slice(0, MAX_SAVED_ACCOUNTS);
  await sensitiveStorage.setItemAsync(
    SAVED_ACCOUNTS_KEY,
    JSON.stringify(ordered),
  );
}

/**
 * 从旧版「最近登录用户名」列表（recent-accounts）迁移账号卡片。
 * 旧数据只有用户名（无密码无头像）；迁移后旧键保留不动（me.tsx 最近登录列表仍在读），
 * 仅当已存卡片数为空时执行一次，保证老用户升级后头像条立即有内容可点。
 */
export async function seedFromRecentAccounts(
  loadRecentUsernames: () => Promise<string[]>,
): Promise<void> {
  const existing = await loadSavedAccounts();
  if (existing.length > 0) return;
  const usernames = (await loadRecentUsernames().catch(() => [])).filter(
    (name) => typeof name === "string" && name.trim(),
  );
  if (usernames.length === 0) return;
  const savedAt = new Date().toISOString();
  const seeded: SavedAccount[] = usernames
    .slice(0, MAX_SAVED_ACCOUNTS)
    .map((username) => ({
      username: username.trim(),
      avatarUrl: null,
      displayName: null,
      savedAt,
    }));
  await sensitiveStorage.setItemAsync(
    SAVED_ACCOUNTS_KEY,
    JSON.stringify(seeded),
  );
}

/** 移除一个已保存账号（「退出并清除本机数据」时调用） */
export async function removeSavedAccount(username: string): Promise<void> {
  const clean = username.trim();
  const accounts = await loadSavedAccounts();
  const ordered = accounts.filter((value) => value.username !== clean);
  await sensitiveStorage.setItemAsync(
    SAVED_ACCOUNTS_KEY,
    JSON.stringify(ordered),
  );
}
