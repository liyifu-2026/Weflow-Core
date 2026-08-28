/**
 * 会话列表 React Hook
 * 将 sync-store 的外部状态同步到 React 组件，首次挂载时启动同步。
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  getConversationSyncSnapshot,
  refreshConversations,
  startConversationSync,
  subscribeConversationSync,
} from "./sync-store";

/** 获取会话列表的响应式 Hook，返回同步状态和刷新函数 */
export function useConversationList() {
  const snapshot = useSyncExternalStore(
    subscribeConversationSync,
    getConversationSyncSnapshot,
    getConversationSyncSnapshot,
  );
  useEffect(() => {
    startConversationSync();
  }, []);
  return { ...snapshot, refresh: refreshConversations };
}
