import { reactive } from "vue";
import { defineStore } from "pinia";

export type ConversationWorkspace = {
  search: string;
  replyDraft: string;
  scrollTop: number;
};

export const useConversationWorkspaceStore = defineStore(
  "weflow-conversation-workspace",
  () => {
    const sessions = reactive<Record<string, ConversationWorkspace>>({});
    function open(key: string) {
      if (!sessions[key]) {
        sessions[key] = {
          search: "",
          replyDraft: "",
          scrollTop: 0,
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

