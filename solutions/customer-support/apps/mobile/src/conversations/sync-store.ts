/**
 * 会话同步状态管理模块
 * 使用发布-订阅模式管理会话列表的全局同步状态。
 * 应用活跃时每 30 秒自动刷新，支持手动下拉刷新。
 * 数据源为 scope=all（全部可见会话，含未触发人工接管的普通会话）。
 *
 * 通知职责边界：跨进程推送由 Core 的 Expo Push dispatcher 负责
 * （handoff_pending / handoff_assigned / assignee_inbound），本地不再
 * 为同步结果生成通知——同步只在 App 活跃时运行，此时弹横幅全是噪音，
 * 且重启后的首次同步会对存量会话轰炸。本模块只维护应用角标。
 */
import { AppState } from "react-native";
import * as Notifications from "expo-notifications";
import { ApiError } from "@/api/client";
import {
  getMobileCapabilities,
  legacyMobileCapabilities,
  type MobileCapabilities,
} from "@/api/capabilities";
import { loadSession } from "@/auth/session";
import { listAllConversations } from "./api";
import type { ConversationPreview } from "./model";
import { conversationsDiffer } from "./sync-order";

/** 会话同步状态快照 */
export type ConversationSyncSnapshot = {
  /** 全部可见会话（scope=all，含普通会话） */
  conversations: ConversationPreview[];
  /** 最近一次同步失败（网络不可达；登录失效除外）——用于离线提示 */
  offline: boolean;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  hasDeferredUpdates: boolean;
  capabilities: MobileCapabilities;
};

const listeners = new Set<() => void>();
let snapshot: ConversationSyncSnapshot = {
  conversations: [],
  offline: false,
  loading: true,
  refreshing: false,
  hasDeferredUpdates: false,
  capabilities: legacyMobileCapabilities,
};
let started = false;
let active = AppState.currentState === "active";
let inFlight = false;

/** 订阅会话同步状态变化 */
export function subscribeConversationSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 获取当前会话同步状态快照 */
export function getConversationSyncSnapshot(): ConversationSyncSnapshot {
  return snapshot;
}

/** 启动会话同步：监听应用状态变化，每 30 秒自动刷新 */
export function startConversationSync(): void {
  if (started) return;
  started = true;
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    active = state === "active";
    if (active) void refreshConversations();
  });
  setInterval(() => {
    if (active) void refreshConversations();
  }, 30_000);
  void refreshConversations();
  // The singleton lives for the app lifetime; this subscription must not be
  // removed by an individual screen unmounting.
  void appStateSubscription;
}

/** 刷新会话列表，防重复请求，根据是否有缓存数据决定错误提示策略 */
export async function refreshConversations(manual = false): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  update({
    loading: snapshot.conversations.length === 0 && !manual,
    refreshing: manual,
    error: undefined,
  });
  try {
    const session = await loadSession();
    if (!session) throw new ApiError("authentication_required", 401);
    const [result, capabilities] = await Promise.all([
      listAllConversations(session),
      getMobileCapabilities(session),
    ]);
    const incoming = result.conversations;
    const hasCurrentRows = snapshot.conversations.length > 0;
    const changed =
      hasCurrentRows && conversationsDiffer(snapshot.conversations, incoming);
    update({
      // 无感自动更新：直接替换列表（FlatList keyExtractor 稳定，滚动位置保留）
      conversations: incoming,
      offline: false,
      hasDeferredUpdates: changed,
      capabilities,
    });
    // 应用角标：需要立即处理的工作（待接手 + 转给我的）。
    // 「我处理中」不计入角标——正在处理的事不该让角标永远清不掉。
    const pendingCount = incoming.filter(
      (item) => item.state === "pending" || item.state === "transfer_target",
    ).length;
    void Notifications.setBadgeCountAsync(pendingCount).catch(() => undefined);
  } catch (reason) {
    update({
      // 登录失效不是离线；其余失败视为网络不可达（有缓存时仍显示上次记录）
      offline:
        reason instanceof ApiError && reason.code === "authentication_required"
          ? false
          : true,
      error:
        reason instanceof ApiError && reason.code === "authentication_required"
          ? "登录已失效，请重新登录。"
          : snapshot.conversations.length > 0
            ? "同步暂时失败，仍显示上次记录。"
            : "暂时无法刷新会话，请检查网络后重试。",
    });
  } finally {
    inFlight = false;
    update({ loading: false, refreshing: false });
  }
}

/** 外部通知需要刷新会话（如收到推送通知时调用） */
export function notifyConversationRefresh(): void {
  if (active) void refreshConversations();
}

/**
 * 重置同步状态（账号切换、退出或会话失效时调用）
 * 避免旧账号的会话列表快照残留到下一个账号的首次刷新。
 */
export function resetSyncStore(): void {
  inFlight = false;
  update({
    conversations: [],
    offline: false,
    loading: true,
    refreshing: false,
    error: undefined,
    hasDeferredUpdates: false,
    capabilities: legacyMobileCapabilities,
  });
}

function update(partial: Partial<ConversationSyncSnapshot>): void {
  snapshot = { ...snapshot, ...partial };
  listeners.forEach((listener) => listener());
}
