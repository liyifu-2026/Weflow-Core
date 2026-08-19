import { useKnowledgeWorkspaceStore } from "./knowledge-workspace";
import { useNavigationContextStore } from "./navigation-context";

export function resetWeflowWorkspaceStores() {
  useNavigationContextStore().clear();
  useKnowledgeWorkspaceStore().clear();
}
