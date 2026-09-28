import { reactive } from "vue";
import { defineStore } from "pinia";

/**
 * 会话工作区：一个登录用户一份（键 = userId）。
 * 草稿与滚动位置必须按 conversationId 键控——工作台在多个会话间切换，
 * 输入框若共享一条草稿，会把 A 会话的草稿发给 B 客户（G1 事故）。
 * search 是列表级状态（过滤整个队列），保持工作台一份。
 */
export type ConversationWorkspace = {
  search: string;
  replyDraftByConversation: Record<string, string>;
  scrollTopByConversation: Record<string, number>;
};

export const useConversationWorkspaceStore = defineStore(
  "weflow-conversation-workspace",
  () => {
    const sessions = reactive<Record<string, ConversationWorkspace>>({});
    function open(key: string) {
      if (!sessions[key]) {
        sessions[key] = {
          search: "",
          replyDraftByConversation: {},
          scrollTopByConversation: {},
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
