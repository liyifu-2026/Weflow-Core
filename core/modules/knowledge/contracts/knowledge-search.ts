/** Provider-neutral knowledge retrieval capability. */

export type KnowledgeEvidence = {
  chunkId: string;
  knowledgeId: string;
  knowledgeBaseId: string;
  title: string;
  filename: string;
  source: string;
  chunkType: string;
  content: string;
  matchedContent: string;
  score: number;
  startAt: number | null;
  endAt: number | null;
};

export type KnowledgeSearchQuery = {
  query: string;
  knowledgeBaseIds?: string[];
  knowledgeIds?: string[];
  tagIds?: string[];
  mentionedItems?: Array<Record<string, string>>;
  limit?: number;
};

export interface KnowledgeSearch {
  search(input: KnowledgeSearchQuery): Promise<KnowledgeEvidence[]>;
}
