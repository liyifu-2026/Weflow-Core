import { useConversationWorkspaceStore } from "./conversation-workspace";
import { useKnowledgeWorkspaceStore } from "./knowledge-workspace";
import { useNavigationContextStore } from "./navigation-context";

/** 登出时清理跨登录态的本地 workspace 缓存（草稿、滚动位置、导航上下文）。 */
export function resetSupportWorkspaceStores() {
  useConversationWorkspaceStore().clear();
  useKnowledgeWorkspaceStore().clear();
  useNavigationContextStore().clear();
}
