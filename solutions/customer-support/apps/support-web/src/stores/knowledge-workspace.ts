import { reactive } from "vue";
import { defineStore } from "pinia";

export type KnowledgeWorkspace = {
  question: string;
  selectedKnowledgeBaseId: string;
  selectedDocumentId: string;
  selectedChunkId: string;
  scrollTop: number;
};

export const useKnowledgeWorkspaceStore = defineStore(
  "weflow-knowledge-workspace",
  () => {
    const sessions = reactive<Record<string, KnowledgeWorkspace>>({});
    function open(key: string) {
      if (!sessions[key]) {
        sessions[key] = {
          question: "",
          selectedKnowledgeBaseId: "",
          selectedDocumentId: "",
          selectedChunkId: "",
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

