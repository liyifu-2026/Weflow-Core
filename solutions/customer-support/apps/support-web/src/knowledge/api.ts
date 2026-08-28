/**
 * Weflow Knowledge adapter.
 *
 * THE ONLY module allowed to touch the legacy knowledge provider
 * (`legacy-knowledge/provider.ts`). Knowledge UI imports from here
 * (and from `evidence-normalizer` / `capability-registry`), never from
 * the compatibility layer directly.
 *
 * Request/response shapes follow the upstream WeKnora API contract;
 * `knowledge/api.ts` maps them into Weflow-friendly types where needed.
 */
import { legacyKnowledgeApi } from "../legacy-knowledge/provider";
import { api } from "../api";

// ---------- knowledge base ----------

export type KnowledgeBase = {
  id: string;
  name: string;
  description?: string;
  type?: "document" | "faq";
  knowledge_count?: number;
  wiki?: boolean;
  created_at?: string;
  updated_at?: string;
};

export function listKnowledgeBases(): Promise<KnowledgeBase[]> {
  return legacyKnowledgeApi("/knowledge-bases?page=1&page_size=100").then(
    unwrapList,
  );
}

export function getKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return legacyKnowledgeApi(`/knowledge-bases/${encodeURIComponent(id)}`).then(
    unwrapItem,
  );
}

export function createKnowledgeBase(data: {
  name: string;
  description?: string;
  type?: "document" | "faq";
}): Promise<KnowledgeBase> {
  return legacyKnowledgeApi("/knowledge-bases", {
    method: "POST",
    body: JSON.stringify({ ...data, type: data.type ?? "document" }),
  }).then(unwrapItem);
}

export function updateKnowledgeBase(
  id: string,
  data: { name?: string; description?: string },
): Promise<KnowledgeBase> {
  return legacyKnowledgeApi(`/knowledge-bases/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  }).then(unwrapItem);
}

export function deleteKnowledgeBase(id: string): Promise<void> {
  return legacyKnowledgeApi(`/knowledge-bases/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function duplicateKnowledgeBase(id: string): Promise<KnowledgeBase> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(id)}/duplicate`,
    { method: "POST" },
  ).then(unwrapItem);
}

export function togglePinKnowledgeBase(id: string): Promise<unknown> {
  return legacyKnowledgeApi(`/knowledge-bases/${encodeURIComponent(id)}/pin`, {
    method: "PUT",
  });
}

export function listKnowledgeBaseActivity(
  id: string,
): Promise<Array<Record<string, unknown>>> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(id)}/activity?page_size=50`,
  ).then(unwrapList);
}

// ---------- documents ----------

export type KnowledgeDocument = {
  id?: string;
  knowledge_id?: string;
  title?: string;
  name?: string;
  file_name?: string;
  filename?: string;
  url?: string;
  type?: string;
  source?: string;
  source_type?: string;
  parse_status?: string;
  status?: string;
  sync_status?: string;
  updated_at?: string;
  is_enabled?: boolean;
  tag_ids?: string[];
  tags?: Array<{ id: string; name: string; color?: string }>;
  chunk_count?: number;
  summary_status?: string;
};

export function listKnowledgeFiles(
  kbId: string,
  params: {
    keyword?: string;
    file_type?: string;
    parse_status?: string;
    page?: number;
    page_size?: number;
  } = {},
): Promise<KnowledgeDocument[]> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    page_size: String(params.page_size ?? 50),
  });
  if (params.keyword) query.set("keyword", params.keyword);
  if (params.file_type) query.set("file_type", params.file_type);
  if (params.parse_status) query.set("parse_status", params.parse_status);
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/knowledge?${query}`,
  ).then(unwrapList);
}

export function getKnowledgeDetails(id: string): Promise<KnowledgeDocument> {
  return legacyKnowledgeApi(`/knowledge/${encodeURIComponent(id)}`).then(
    unwrapItem,
  );
}

export function deleteKnowledge(id: string): Promise<void> {
  return legacyKnowledgeApi(`/knowledge/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function reparseKnowledge(
  id: string,
  processConfig?: Record<string, unknown>,
): Promise<void> {
  return legacyKnowledgeApi(`/knowledge/${encodeURIComponent(id)}/reparse`, {
    method: "POST",
    body: JSON.stringify(
      processConfig ? { process_config: processConfig } : {},
    ),
  });
}

export function cancelKnowledgeParse(id: string): Promise<void> {
  return legacyKnowledgeApi(
    `/knowledge/${encodeURIComponent(id)}/cancel-parse`,
    { method: "POST" },
  );
}

export function regenerateKnowledgeSummary(id: string): Promise<void> {
  return legacyKnowledgeApi(
    `/knowledge/${encodeURIComponent(id)}/regenerate-summary`,
    { method: "POST" },
  );
}

export function batchDeleteKnowledge(ids: string[]): Promise<void> {
  return legacyKnowledgeApi("/knowledge/batch-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
}

export function batchReparseKnowledge(
  kbId: string,
  ids: string[],
): Promise<void> {
  return legacyKnowledgeApi("/knowledge/batch-reparse", {
    method: "POST",
    body: JSON.stringify({ kb_id: kbId, ids }),
  });
}

export function batchQueryKnowledge(
  ids: string[],
): Promise<KnowledgeDocument[]> {
  return legacyKnowledgeApi(`/knowledge/batch?ids=${encodeURIComponent(ids.join(","))}`).then(
    unwrapList,
  );
}

export function previewKnowledgeFile(
  id: string,
): Promise<{ blob: Blob; contentType: string }> {
  // Direct fetch inside the adapter: previews need the raw blob, which the
  // shared text-only wrapper cannot carry.
  return fetch(
    `/api/v1/console/knowledge-provider/knowledge/${encodeURIComponent(id)}/preview`,
    { credentials: "include" },
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(`preview failed: ${response.status}`);
    }
    return {
      blob: await response.blob(),
      contentType: response.headers.get("content-type") ?? "",
    };
  });
}

export function listMoveTargets(kbId: string): Promise<KnowledgeBase[]> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/move-targets`,
  ).then(unwrapList);
}

export function moveKnowledge(data: {
  id: string;
  target_kb_id: string;
  reuse_vectors?: boolean;
}): Promise<unknown> {
  return legacyKnowledgeApi("/knowledge/move", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ---------- upload ----------

export function uploadKnowledgeFile(
  kbId: string,
  data: {
    file: File;
    tag_ids?: string[];
    fileName?: string;
    process_config?: Record<string, unknown> | string;
  },
): Promise<unknown> {
  const form = new FormData();
  form.append("file", data.file);
  if (data.tag_ids?.length)
    form.append("tag_ids", JSON.stringify(data.tag_ids));
  if (data.fileName) form.append("fileName", data.fileName);
  if (data.process_config)
    form.append(
      "process_config",
      typeof data.process_config === "string"
        ? data.process_config
        : JSON.stringify(data.process_config),
    );
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/file`,
    { method: "POST", body: form },
  );
}

export function createKnowledgeFromURL(
  kbId: string,
  data: { url: string; tag_ids?: string[] },
): Promise<unknown> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/url`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function createManualKnowledge(
  kbId: string,
  data: {
    title: string;
    content: string;
    tag_ids?: string[];
  },
): Promise<unknown> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/knowledge/manual`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

// ---------- chunks ----------

export type Chunk = {
  id?: string;
  chunk_id?: string;
  content?: string;
  is_enabled?: boolean;
  content_revision?: number;
  revision?: number;
  parent_chunk_id?: string | null;
  chunk_type?: string;
  generated_questions?: Array<{ question: string; id?: string }>;
};

export function listChunks(
  knowledgeId: string,
  page = 1,
  pageSize = 25,
): Promise<Chunk[]> {
  return legacyKnowledgeApi(
    `/chunks/${encodeURIComponent(knowledgeId)}?page=${page}&page_size=${pageSize}`,
  ).then(unwrapList);
}

export function updateChunk(
  knowledgeId: string,
  chunkId: string,
  data: { content: string; expected_revision?: number; is_enabled?: boolean },
): Promise<void> {
  return legacyKnowledgeApi(
    `/chunks/${encodeURIComponent(knowledgeId)}/${encodeURIComponent(chunkId)}`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

export function getChunkByIdOnly(chunkId: string): Promise<Chunk> {
  return legacyKnowledgeApi(
    `/chunks/by-id/${encodeURIComponent(chunkId)}`,
  ).then(unwrapItem);
}

export type ChunkRevision = {
  chunk_id?: string;
  content?: string;
  is_enabled?: boolean;
  content_revision?: number;
  created_at?: string;
};

export function listChunkRevisions(
  knowledgeId: string,
  chunkId: string,
): Promise<ChunkRevision[]> {
  return legacyKnowledgeApi(
    `/chunks/${encodeURIComponent(knowledgeId)}/${encodeURIComponent(chunkId)}/revisions`,
  ).then(unwrapList);
}

export function revertDocumentChunk(
  knowledgeId: string,
  chunkId: string,
  data: { revision: number },
): Promise<void> {
  return legacyKnowledgeApi(
    `/chunks/${encodeURIComponent(knowledgeId)}/${encodeURIComponent(chunkId)}/revert`,
    { method: "POST", body: JSON.stringify(data) },
  );
}

export function upsertGeneratedQuestion(
  chunkId: string,
  data: { question: string },
): Promise<void> {
  return legacyKnowledgeApi(
    `/chunks/by-id/${encodeURIComponent(chunkId)}/questions`,
    { method: "PUT", body: JSON.stringify(data) },
  );
}

export function regenerateGeneratedQuestions(chunkId: string): Promise<void> {
  return legacyKnowledgeApi(
    `/chunks/by-id/${encodeURIComponent(chunkId)}/questions/regenerate`,
    { method: "POST" },
  );
}

export function getKnowledgeSpans(
  knowledgeId: string,
): Promise<Array<Record<string, unknown>>> {
  return legacyKnowledgeApi(
    `/knowledge/${encodeURIComponent(knowledgeId)}/spans`,
  ).then(unwrapList);
}

// ---------- tags ----------

export type KnowledgeTag = {
  id: string;
  name: string;
  color?: string;
};

export function listKnowledgeTags(
  kbId: string,
  keyword = "",
): Promise<KnowledgeTag[]> {
  const query = new URLSearchParams({ page: "1", page_size: "100" });
  if (keyword) query.set("keyword", keyword);
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/tags?${query}`,
  ).then(unwrapList);
}

export function createKnowledgeBaseTag(
  kbId: string,
  data: { name: string; color?: string },
): Promise<KnowledgeTag> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/tags`,
    { method: "POST", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function updateKnowledgeBaseTag(
  kbId: string,
  tagId: string,
  data: { name?: string; color?: string },
): Promise<KnowledgeTag> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/tags/${encodeURIComponent(tagId)}`,
    { method: "PUT", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function deleteKnowledgeBaseTag(
  kbId: string,
  tagId: string,
): Promise<void> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/tags/${encodeURIComponent(tagId)}`,
    { method: "DELETE" },
  );
}

export function updateKnowledgeTagBatch(
  updates: Record<string, string[]>,
): Promise<void> {
  return legacyKnowledgeApi("/knowledge/tags", {
    method: "PUT",
    body: JSON.stringify({ updates }),
  });
}

// ---------- faq ----------

export type FAQEntry = {
  id?: string;
  faq_id?: string;
  question?: string;
  standard_question?: string;
  answer?: string;
  similar_questions?: string[];
  negative_questions?: string[];
  is_enabled?: boolean;
  is_recommended?: boolean;
  tag_ids?: string[];
  updated_at?: string;
};

export function listFAQEntries(
  kbId: string,
  params: { keyword?: string; page?: number; page_size?: number } = {},
): Promise<FAQEntry[]> {
  const query = new URLSearchParams({
    page: String(params.page ?? 1),
    page_size: String(params.page_size ?? 50),
  });
  if (params.keyword) query.set("keyword", params.keyword);
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/faq/entries?${query}`,
  ).then(unwrapList);
}

export function createFAQEntry(
  kbId: string,
  data: {
    question: string;
    answer: string;
    similar_questions?: string[];
    tag_ids?: string[];
  },
): Promise<FAQEntry> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/faq/entries`,
    { method: "POST", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function updateFAQEntry(
  kbId: string,
  entryId: string,
  data: {
    question?: string;
    answer?: string;
    similar_questions?: string[];
    is_enabled?: boolean;
    is_recommended?: boolean;
    tag_ids?: string[];
  },
): Promise<FAQEntry> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/faq/entries/${encodeURIComponent(entryId)}`,
    { method: "PUT", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function deleteFAQEntries(
  kbId: string,
  ids: string[],
): Promise<void> {
  return legacyKnowledgeApi(
    `/knowledge-bases/${encodeURIComponent(kbId)}/faq/entries`,
    { method: "DELETE", body: JSON.stringify({ ids }) },
  );
}

// ---------- wiki (baseline) ----------

export type WikiPage = {
  slug?: string;
  title?: string;
  content?: string;
  page_type?: string;
  status?: string;
  version?: number;
  updated_at?: string;
  folder_id?: string | null;
  /** 上游层级路径（"index/Install/…"），用于树形展示 */
  wiki_path?: string;
};

export function listWikiPages(kbId: string): Promise<WikiPage[]> {
  return legacyKnowledgeApi(
    `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages?page_size=100`,
  ).then(unwrapList);
}

export function getWikiPage(kbId: string, slug: string): Promise<WikiPage> {
  return legacyKnowledgeApi(
    `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages/${encodeURIComponent(slug)}`,
  ).then(unwrapItem);
}

export function createWikiPage(
  kbId: string,
  data: { title: string; content?: string; page_type?: string },
): Promise<WikiPage> {
  return legacyKnowledgeApi(
    `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages`,
    { method: "POST", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function updateWikiPage(
  kbId: string,
  slug: string,
  data: { title?: string; content?: string; version?: number },
): Promise<WikiPage> {
  return legacyKnowledgeApi(
    `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages/${encodeURIComponent(slug)}`,
    { method: "PUT", body: JSON.stringify(data) },
  ).then(unwrapItem);
}

export function deleteWikiPage(kbId: string, slug: string): Promise<void> {
  return legacyKnowledgeApi(
    `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages/${encodeURIComponent(slug)}`,
    { method: "DELETE" },
  );
}

// ---------- infrastructure (read-only, P4 first-read) ----------
// 只读清单：先展示真实状态与绑定关系，写入能力确认需要后再开放。

export type DataSourceBinding = {
  id: string;
  name?: string;
  type?: string;
  source_type?: string;
  status?: string;
  last_sync_at?: string;
  sync_status?: string;
  created_at?: string;
  updated_at?: string;
};

/** 数据源按知识库维度绑定（上游要求 kb_id）。 */
export function listDataSourceBindings(kbId: string): Promise<DataSourceBinding[]> {
  return legacyKnowledgeApi(
    `/datasource?page=1&page_size=50&kb_id=${encodeURIComponent(kbId)}`,
  ).then(unwrapList);
}

export type ModelInfo = {
  id: string;
  name: string;
  display_name?: string;
  type?: string;
  source?: string;
  status?: string;
  is_default?: boolean;
  is_builtin?: boolean;
  created_at?: string;
  credentials?: {
    api_key?: { configured?: boolean };
    app_secret?: { configured?: boolean };
  };
  parameters?: {
    embedding_parameters?: { dimension?: number };
    provider?: string;
    base_url?: string;
    [key: string]: unknown;
  };
};

export function listModels(): Promise<ModelInfo[]> {
  return legacyKnowledgeApi("/models?page=1&page_size=100").then(unwrapList);
}

export type VectorStoreInfo = {
  id: string;
  name: string;
  engine_type?: string;
  source?: string;
  readonly?: boolean;
  connection_config?: { use_default_connection?: boolean };
  created_at?: string;
};

export function listVectorStores(): Promise<VectorStoreInfo[]> {
  return legacyKnowledgeApi("/vector-stores?page=1&page_size=100").then(
    unwrapList,
  );
}

export type StorageBackendInfo = {
  id: string;
  name: string;
  provider?: string;
  source?: string;
  status?: string;
  legacy_alias?: boolean;
  created_at?: string;
  updated_at?: string;
};

export function listStorageBackends(): Promise<{
  items: StorageBackendInfo[];
  defaultId?: string;
}> {
  return legacyKnowledgeApi("/storage-backends?page=1&page_size=100").then(
    (payload) => {
      const root = (payload ?? {}) as Record<string, unknown>;
      return {
        items: unwrapList(payload),
        defaultId:
          typeof root.default_storage_backend_id === "string"
            ? root.default_storage_backend_id
            : undefined,
      };
    },
  );
}

// ---------- 受控治理（Core 原生端点，schema 校验，非透传代理） ----------

export function createManagedModel(data: {
  name: string;
  type: string;
  source: string;
  display_name?: string;
  description?: string;
}): Promise<unknown> {
  return api("/api/v1/admin/knowledge-models", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deleteManagedModel(modelId: string): Promise<void> {
  return api(`/api/v1/admin/knowledge-models/${encodeURIComponent(modelId)}`, {
    method: "DELETE",
  });
}

export function createManagedVectorStore(data: {
  name: string;
  engine_type: string;
  connection_config?: Record<string, unknown>;
}): Promise<unknown> {
  return api("/api/v1/admin/knowledge-vector-stores", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function testManagedVectorStore(data: {
  name: string;
  engine_type: string;
  connection_config?: Record<string, unknown>;
}): Promise<unknown> {
  return api("/api/v1/admin/knowledge-vector-stores/test", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function createManagedStorageBackend(data: {
  name: string;
  provider: string;
}): Promise<unknown> {
  return api("/api/v1/admin/knowledge-storage-backends", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

// ---------- search (validation mode) ----------

export function searchKnowledge(params: {
  query: string;
  knowledgeBaseIds?: string[];
}): Promise<unknown> {
  return legacyKnowledgeApi("/knowledge-search", {
    method: "POST",
    body: JSON.stringify({
      query: params.query,
      ...(params.knowledgeBaseIds?.length
        ? { knowledge_base_ids: params.knowledgeBaseIds }
        : {}),
    }),
  });
}

// ---------- helpers ----------

function unwrapList(payload: unknown): any[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const value = root.data ?? root.items ?? root.entries ?? [];
  if (Array.isArray(value)) {
    const inner = value[0];
    if (
      inner &&
      typeof inner === "object" &&
      Array.isArray((inner as Record<string, unknown>).data)
    ) {
      return (inner as Record<string, unknown>).data as any[];
    }
    return value as any[];
  }
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const inner = nested.data ?? nested.items ?? nested.entries;
    if (Array.isArray(inner)) return inner as any[];
  }
  return [];
}

function unwrapItem(payload: unknown): any {
  if (payload && typeof payload === "object") {
    const root = payload as Record<string, unknown>;
    if (root.data && typeof root.data === "object") return root.data;
  }
  return payload;
}

