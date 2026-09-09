/**
 * Weflow Evidence — the only evidence shape the Knowledge UI understands.
 * WeKnora responses are normalized here; provider upgrades only touch this
 * file, never the UI.
 */
export type WeflowEvidence = {
  evidenceId: string;
  knowledgeBaseId?: string;
  documentId?: string;
  chunkId?: string;
  faqId?: string;
  wikiSlug?: string;
  title: string;
  excerpt: string;
  sourceType: string;
  score?: number;
};

type SearchHit = {
  id?: string;
  chunk_id?: string;
  knowledge_id?: string;
  knowledge_base_id?: string;
  faq_id?: string;
  wiki_slug?: string;
  knowledge_title?: string;
  knowledge_filename?: string;
  title?: string;
  content?: string;
  matched_content?: string;
  chunk_type?: string;
  knowledge_channel?: string;
  source?: string;
  source_type?: string;
  score?: number;
  similarity?: number;
};

function asArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const value = root.data ?? root.chunks ?? root.evidence ?? root.items ?? [];
  return Array.isArray(value) ? value : [];
}

function firstString(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

export function normalizeKnowledgeEvidence(payload: unknown): WeflowEvidence[] {
  return asArray(payload)
    .map((raw): WeflowEvidence | null => {
      if (!raw || typeof raw !== "object") return null;
      const hit = raw as SearchHit;
      const evidenceId = firstString(hit.id, hit.chunk_id);
      if (!evidenceId) return null;
      const excerpt = firstString(hit.matched_content, hit.content);
      return {
        evidenceId,
        knowledgeBaseId: hit.knowledge_base_id,
        documentId: hit.knowledge_id,
        chunkId: hit.chunk_id ?? hit.id,
        faqId: hit.faq_id,
        wikiSlug: hit.wiki_slug,
        title: firstString(
          hit.knowledge_title,
          hit.title,
          hit.knowledge_filename,
        ),
        excerpt:
          excerpt.length > 300 ? `${excerpt.slice(0, 300)}…` : excerpt,
        sourceType: firstString(
          hit.knowledge_channel,
          hit.source,
          hit.source_type,
          hit.chunk_type,
        ),
        score: typeof hit.score === "number" ? hit.score : hit.similarity,
      };
    })
    .filter((item): item is WeflowEvidence => item !== null)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

/**
 * 把 provider 评分归一为 0-100 的百分制展示值。
 * WeKnora 相似度通常落在 0-1；个别通道直接返回 0-100。
 */
export function evidenceScorePercent(evidence: WeflowEvidence): number | null {
  if (typeof evidence.score !== "number" || Number.isNaN(evidence.score)) {
    return null;
  }
  const percent = evidence.score <= 1 ? evidence.score * 100 : evidence.score;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

