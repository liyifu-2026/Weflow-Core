import { reactive } from "vue";
import { defineStore } from "pinia";

export type ConversationWorkspace = {
  search: string;
  filter: "attention" | "mine" | "all";
  replyDraft: string;
  scrollTop: number;
  evidenceExpanded: boolean;
};

export const useConversationWorkspaceStore = defineStore(
  "weflow-conversation-workspace",
  () => {
    const sessions = reactive<Record<string, ConversationWorkspace>>({});
    function open(key: string) {
      if (!sessions[key]) {
        sessions[key] = {
          search: "",
          filter: "attention",
          replyDraft: "",
          scrollTop: 0,
          evidenceExpanded: true,
        };
      }
      return sessions[key];
    }
    function clear() {
      Object.keys(sessions).forEach((key) => delete sessions[key]);
    }
    return { sessions, open, clear };
  },
);

