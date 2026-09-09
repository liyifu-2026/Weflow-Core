/**
 * 会话持久化模块
 * 管理移动端登录会话的安全存储，包括加载、保存、清除和失效操作。
 * 会话数据存储在设备安全区域（SecureStore），不进入未受保护的系统备份。
 */
import { Image } from "expo-image";
import { clearAccountDrafts } from "@/conversations/draft-store";
import { clearAccountTranscriptCache } from "@/conversations/transcript-cache";
import { resetSyncStore } from "@/conversations/sync-store";
import { sensitiveStorage } from "@/storage/sensitive-storage";

const SESSION_KEY = "weflow.mobile.session";

/** 移动端会话数据结构 */
export type MobileSession = {
  sessionToken: string;
  expiresAt: string;
  user: {
    userId: string;
    username: string;
    mustChangePassword: boolean;
    /** 客服头像相对路径（无头像为 null/undefined——兼容旧缓存） */
    avatarUrl?: string | null;
    /** 当前选中的平台预设头像 id（未选为 null；旧缓存无此字段） */
    avatarPreset?: string | null;
    /** 信息名片显示名（可空 = 展示 username；旧缓存无此字段） */
    displayName?: string | null;
    /** 客服自选专家标签（旧缓存无此字段） */
    tags?: string[];
  };
};

/** 从安全存储加载会话，数据校验失败或已过期时自动清除并返回 undefined */
export async function loadSession(): Promise<MobileSession | undefined> {
  const serialized = await sensitiveStorage.getItemAsync(SESSION_KEY);
  if (!serialized) return undefined;
  try {
    const session = JSON.parse(serialized) as MobileSession;
    if (!session.sessionToken || !session.user?.userId || !session.expiresAt) {
      await invalidateSession();
      return undefined;
    }
    // 本地过期校验：不能只靠服务端 401 被动失效——过期令牌在前台展示
    // 客户数据直到首次 401 才跳登录，主动判断避免隐私窗口。
    // NaN（畸形时间串）同样视为已过期，避免非法数据绕过校验。
    const expiresAt = new Date(session.expiresAt).getTime();
    if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
      await invalidateSession();
      return undefined;
    }
    return session;
  } catch {
    await invalidateSession();
    return undefined;
  }
}

/** 将会话数据保存到安全存储 */
export async function saveSession(session: MobileSession): Promise<void> {
  await sensitiveStorage.setItemAsync(SESSION_KEY, JSON.stringify(session));
}

/** 清除会话，可选同时清除该账号的本地草稿和离线缓存 */
export async function clearSession(options: { clearLocalData?: boolean } = {}): Promise<void> {
  const serialized = await sensitiveStorage.getItemAsync(SESSION_KEY);
  if (serialized) {
    try {
      const session = JSON.parse(serialized) as MobileSession;
      if (options.clearLocalData && session.user?.userId) {
        await clearAccountDrafts(session.user.userId);
        await clearAccountTranscriptCache(session.user.userId);
      }
    } catch {
      // The session is already invalid; continue clearing the token.
    }
  }
  await sensitiveStorage.deleteItemAsync(SESSION_KEY);
  // 清空会话列表快照，避免旧账号数据残留到下一个账号（跨账号隔离）
  resetSyncStore();
  // 图片内存缓存按 URL 键控，不按账号隔离——切号/退出时清空，避免跨账号缓存泄漏
  Image.clearMemoryCache();
}

/**
 * 使会话失效：仅清除 token 与账号快照，保留本地草稿和离线缓存。
 * 产品决策（2026-08-13）：token 失效（过期/服务端拒绝）不必然意味着设备易主，
 * 保留草稿避免用户重新登录后丢失正在编辑的内容；显式退出登录仍走
 * clearSession({ clearLocalData: true }) 全清。
 */
export async function invalidateSession(): Promise<void> {
  await clearSession();
}
