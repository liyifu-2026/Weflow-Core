import type { PluginDefinition } from "../runtime/kernel/index.js";
import type {
  KnowledgeEvidence,
  KnowledgeSearch,
  KnowledgeSearchQuery,
} from "../../modules/knowledge/contracts/knowledge-search.js";
import { KNOWLEDGE_SEARCH_CAPABILITY } from "../runtime/capabilities/knowledge-search.js";
import type {
  WeKnoraKnowledgeClient,
  KnowledgeSearchOptions,
} from "./weknora-knowledge-client.js";

export class WeKnoraKnowledgeProvider implements KnowledgeSearch {
  public constructor(private readonly client: WeKnoraKnowledgeClient) {}

  search(input: KnowledgeSearchQuery): Promise<KnowledgeEvidence[]> {
    const options: KnowledgeSearchOptions = {
      ...(input.knowledgeBaseIds
        ? { knowledgeBaseIds: input.knowledgeBaseIds }
        : {}),
      ...(input.knowledgeIds ? { knowledgeIds: input.knowledgeIds } : {}),
      ...(input.tagIds ? { tagIds: input.tagIds } : {}),
      ...(input.mentionedItems ? { mentionedItems: input.mentionedItems } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    };
    return this.client.search(input.query, options);
  }
}

export function weknoraKnowledgePlugin(
  client: WeKnoraKnowledgeClient,
): PluginDefinition {
  return {
    name: "weknora-knowledge",
    provides: [KNOWLEDGE_SEARCH_CAPABILITY],
    requires: [],
    setup(context) {
      context.provide(
        KNOWLEDGE_SEARCH_CAPABILITY,
        new WeKnoraKnowledgeProvider(client),
      );
    },
  };
}
