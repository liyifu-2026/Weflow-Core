import { capability } from "../kernel/index.js";
import type { KnowledgeSearch } from "../../../modules/knowledge/contracts/knowledge-search.js";

export const KNOWLEDGE_SEARCH_CAPABILITY =
  capability<KnowledgeSearch>("knowledge.search");
