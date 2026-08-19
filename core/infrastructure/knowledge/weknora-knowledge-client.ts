/**
 * WeKnora 知识库客户端
 * 封装与 WeKnora 知识库 API 的交互，包括：
 * - 知识库列表获取（支持缓存）
 * - 知识检索（语义搜索）
 * - 证据格式标准化
 */
export type { KnowledgeEvidence } from "../../modules/knowledge/contracts/knowledge-search.js";
import type { KnowledgeEvidence } from "../../modules/knowledge/contracts/knowledge-search.js";

export type KnowledgeBaseSummary = {
  id: string;
  name: string;
  type: string;
  description: string;
  /** 是否启用 WeKnora wiki 模式（wiki pages 独立于文档存储）。 */
  wikiEnabled: boolean;
};

/** 可安全返回给客户端的知识文档摘要。 */
export type KnowledgeDocument = {
  id: string;
  title: string;
  filename: string;
  fileType: string;
  fileSize: number | null;
  parseStatus: string;
  description: string;
};

/** 受保护的原文预览响应。 */
export type KnowledgePreview = {
  body: Uint8Array;
  contentType: string;
};

export type KnowledgeSessionMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  completed: boolean;
  references: Array<Record<string, unknown>>;
};

export type KnowledgeSuggestion = {
  id: string;
  text: string;
};

/** Weflow 白名单内的检索配置（dense / BM25 / rerank 阈值）。 */
export type RetrievalSettings = {
  embeddingTopK: number;
  vectorThreshold: number;
  keywordThreshold: number;
  rerankTopK: number;
  rerankThreshold: number;
  rerankModelId: string;
};

/** 允许客户端更新的检索配置子集。 */
export type RetrievalSettingsPatch = Partial<RetrievalSettings>;

export type KnowledgeSuggestionSet = {
  id: string;
  status: string;
  questions: KnowledgeSuggestion[];
};

/** 资料库目录中的标签。 */
export type KnowledgeLibraryTag = {
  id: string;
  name: string;
};

/** 资料库目录中的文档元数据（不含正文）。 */
export type KnowledgeLibraryDocument = {
  knowledgeId: string;
  title: string;
  filename: string;
  fileType: string;
  fileSize: number | null;
  parseStatus: string;
  source: string;
  tags: KnowledgeLibraryTag[];
  updatedAt: string | undefined;
};

/** 资料库目录中的 FAQ 条目。 */
export type KnowledgeLibraryFaq = {
  faqId: string;
  knowledgeId: string;
  standardQuestion: string;
  answers: string[];
  recommended: boolean;
  tagName: string | undefined;
};

/** 资料库目录中的 wiki 页面元数据（不含正文）。 */
export type KnowledgeLibraryWikiPage = {
  pageId: string;
  knowledgeBaseId: string;
  slug: string;
  title: string;
  pageType: string;
  summary: string;
  categoryPath: string[];
  updatedAt: string | undefined;
};

/** 文档全文（Core 聚合 WeKnora chunks 生成）。 */
export type KnowledgeDocumentContent = {
  content: string;
  charCount: number;
  truncated: boolean;
};

type WeKnoraClientOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  knowledgeBaseIds?: string[] | undefined;
  fetch?: typeof globalThis.fetch;
};

type KnowledgeBasePayload = {
  data?: unknown;
  success?: boolean;
};

export type KnowledgeSearchOptions = {
  knowledgeBaseIds?: string[] | undefined;
  knowledgeIds?: string[] | undefined;
  tagIds?: string[] | undefined;
  mentionedItems?: Array<Record<string, string>> | undefined;
  /** 返回证据条数上限；缺省 6，深度检索用更大值。 */
  limit?: number | undefined;
};

export type KnowledgeQAOptions = KnowledgeSearchOptions & {
  disableTitle?: boolean;
  channel?: string;
};

/** WeKnora 的 messages.request_id 列为 VARCHAR(36)；server2-<28位hex> 恰好 36 字符。 */
function weknoraRequestId(): string {
  return `server2-${crypto.randomUUID().replaceAll("-", "").slice(0, 28)}`;
}

/** chunk/wiki 正文中的内部图片句柄：![alt](resource://<22位handle>)。 */
const RESOURCE_IMAGE_PATTERN =
  /!\[([^\]]*)\]\(resource:\/\/([A-Za-z0-9_-]{22})\)/g;

/** WeKnora 知识库客户端类 */
export class WeKnoraKnowledgeClient {
  private readonly fetch: typeof globalThis.fetch;
  private cachedKnowledgeBaseIds: string[] | undefined;
  private cacheExpiresAt = 0;

  constructor(private readonly options: WeKnoraClientOptions) {
    this.fetch = options.fetch ?? globalThis.fetch;
  }

  /**
   * 执行知识检索
   * @param query - 检索查询文本
   * @returns 最多 limit 条相关证据（默认 6，深度检索可放宽）
   */
  async search(
    query: string,
    options: KnowledgeSearchOptions = {},
  ): Promise<KnowledgeEvidence[]> {
    const knowledgeBaseIds = options.knowledgeBaseIds?.length
      ? options.knowledgeBaseIds
      : await this.availableKnowledgeBaseIds();
    if (knowledgeBaseIds.length === 0) {
      throw new Error("weknora_no_accessible_knowledge_base");
    }
    const payload = await this.request("/knowledge-search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        knowledge_base_ids: knowledgeBaseIds,
        ...(options.knowledgeIds?.length
          ? { knowledge_ids: options.knowledgeIds }
          : {}),
        ...(options.tagIds?.length ? { tag_ids: options.tagIds } : {}),
        ...(options.mentionedItems?.length
          ? { mentioned_items: options.mentionedItems }
          : {}),
      }),
    });
    const rows =
      isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    return rows
      .map(toEvidence)
      .filter(
        (evidence): evidence is KnowledgeEvidence => evidence !== undefined,
      )
      .slice(0, options.limit ?? 6);
  }

  /** 获取当前账号可见的知识库范围，供 Core 转换为客服可读选项。 */
  async listKnowledgeBases(): Promise<KnowledgeBaseSummary[]> {
    const payload = (await this.request(
      "/knowledge-bases",
    )) as KnowledgeBasePayload;
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.id !== "string") return [];
      if (row.is_temporary === true) return [];
      return [
        {
          id: row.id,
          name: stringValue(row.name) || row.id,
          type: stringValue(row.type) || "document",
          description: stringValue(row.description),
          wikiEnabled:
            isRecord(row.capabilities) && row.capabilities.wiki === true,
        },
      ];
    });
  }

  /** 创建一个 WeKnora 知识会话。session 只由 Server2 持有。 */
  async createSession(title = "Mobile 知识辅助"): Promise<string> {
    const payload = await this.request("/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description: "Mobile 受控知识辅助会话" }),
    });
    const value =
      isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
    const sessionId = isRecord(value) ? stringValue(value.id) : "";
    if (!sessionId) throw new Error("weknora_session_invalid");
    return sessionId;
  }

  /** 启动知识问答 SSE；调用方负责消费 response.body。 */
  async streamKnowledgeQA(
    sessionId: string,
    query: string,
    options: KnowledgeQAOptions = {},
    signal?: AbortSignal,
  ): Promise<Response> {
    const response = await this.fetch(
      // WeKnora v0.7.1 将问答路由从 /sessions/:id/knowledge-qa 调整为 /knowledge-chat/:session_id
      `${this.options.baseUrl}/knowledge-chat/${encodeURIComponent(sessionId)}`,
      {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "x-request-id": weknoraRequestId(),
        },
        body: JSON.stringify({
          query,
          knowledge_base_ids: options.knowledgeBaseIds ?? [],
          knowledge_ids: options.knowledgeIds ?? [],
          tag_ids: options.tagIds ?? [],
          mentioned_items: options.mentionedItems ?? [],
          disable_title: options.disableTitle ?? true,
          channel: options.channel ?? "api",
          web_search_enabled: false,
          agent_enabled: false,
        }),
        ...(signal ? { signal } : {}),
      },
    );
    if (!response.ok || !response.body) {
      throw new Error(`weknora_qa_failed:${String(response.status)}`);
    }
    return response;
  }

  /** 停止一个正在生成的知识会话。 */
  async stopSession(sessionId: string, messageId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message_id: messageId }),
    });
  }

  /** 读取 Core 私有线程所对应的 WeKnora 历史消息。 */
  async loadMessages(
    sessionId: string,
    limit = 50,
    beforeTime?: string,
  ): Promise<KnowledgeSessionMessage[]> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (beforeTime) query.set("before_time", beforeTime);
    const payload = await this.request(
      `/messages/${encodeURIComponent(sessionId)}/load?${query.toString()}`,
    );
    const rows =
      isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
    return rows.flatMap(toSessionMessage);
  }

  /** 确保回答后的推荐问题生成，并返回可安全展示的提问文本。 */
  async ensureSuggestions(
    sessionId: string,
    messageId: string,
  ): Promise<KnowledgeSuggestionSet | undefined> {
    const payload = await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}/suggestions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    return toSuggestionSet(payload);
  }

  /** 记录推荐问题曝光或点击，不把上游会话标识暴露给 Mobile。 */
  async recordSuggestionEvent(
    sessionId: string,
    suggestionSetId: string,
    questionId: string,
    eventType: "impression" | "click" | "dismiss",
  ): Promise<void> {
    await this.request(
      `/sessions/${encodeURIComponent(sessionId)}/suggestion-events`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          suggestion_set_id: suggestionSetId,
          question_id: questionId,
          event_type: eventType,
        }),
      },
    );
  }

  /** 获取单个知识文档的安全摘要，不向调用方暴露存储路径。 */
  async getDocument(knowledgeId: string): Promise<KnowledgeDocument> {
    const payload = await this.request(
      `/knowledge/${encodeURIComponent(knowledgeId)}`,
    );
    return toDocument(payload, knowledgeId);
  }

  /** 通过 Core 受保护地读取 WeKnora 原文预览。 */
  async preview(knowledgeId: string): Promise<KnowledgePreview> {
    const response = await this.fetch(
      `${this.options.baseUrl}/knowledge/${encodeURIComponent(knowledgeId)}/preview`,
      {
        headers: {
          "x-api-key": this.options.apiKey,
          "x-request-id": weknoraRequestId(),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`weknora_preview_failed:${String(response.status)}`);
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** 通过知识库作用域文件代理读取 resource:// 句柄指向的图片字节。 */
  async fetchResourceFile(
    kbId: string,
    resourcePath: string,
  ): Promise<KnowledgePreview> {
    const query = `?file_path=${encodeURIComponent(resourcePath)}`;
    const response = await this.fetch(
      `${this.options.baseUrl}/knowledge-bases/${encodeURIComponent(kbId)}/files${query}`,
      {
        headers: {
          "x-api-key": this.options.apiKey,
          "x-request-id": weknoraRequestId(),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`weknora_resource_failed:${String(response.status)}`);
    }
    return {
      body: new Uint8Array(await response.arrayBuffer()),
      contentType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /** 拉取知识库内全部文档元数据（分页，单库上限 200 篇，不包含正文）。 */
  async listKnowledgeDocuments(
    kbId: string,
  ): Promise<KnowledgeLibraryDocument[]> {
    const documents: KnowledgeLibraryDocument[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 3; page += 1) {
      const payload = (await this.request(
        `/knowledge-bases/${encodeURIComponent(kbId)}/knowledge?page=${String(page)}&page_size=${String(pageSize)}`,
      )) as { data?: unknown; total?: number };
      const rows = Array.isArray(payload.data) ? payload.data : [];
      for (const row of rows) {
        const document = toLibraryDocument(row);
        if (document) documents.push(document);
      }
      const total =
        typeof payload.total === "number" ? payload.total : rows.length;
      if (documents.length >= total || rows.length < pageSize) break;
    }
    return documents.slice(0, 200);
  }

  /** 拉取知识库下的全部标签。 */
  async listKnowledgeTags(kbId: string): Promise<KnowledgeLibraryTag[]> {
    const payload = (await this.request(
      `/knowledge-bases/${encodeURIComponent(kbId)}/tags`,
    )) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    return rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.id !== "string") return [];
      return [{ id: row.id, name: stringValue(row.name) || row.id }];
    });
  }

  /** 拉取知识库下启用的 FAQ 条目。 */
  async listFaqEntries(kbId: string): Promise<KnowledgeLibraryFaq[]> {
    const payload = (await this.request(
      `/knowledge-bases/${encodeURIComponent(kbId)}/faq/entries?page=1&page_size=500`,
    )) as { data?: unknown; total?: number };
    const rows = Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload.data) && Array.isArray(payload.data.data)
        ? payload.data.data
        : [];
    return rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.id === "undefined") return [];
      if (row.is_enabled === false) return [];
      const faqId =
        typeof row.id === "number" || typeof row.id === "string"
          ? String(row.id)
          : "";
      if (!faqId) return [];
      const answers = Array.isArray(row.answers)
        ? row.answers.filter(
            (answer): answer is string => typeof answer === "string",
          )
        : [];
      const standardQuestion = stringValue(row.standard_question);
      if (!standardQuestion) return [];
      return [
        {
          faqId,
          knowledgeId: stringValue(row.knowledge_id),
          standardQuestion,
          answers,
          recommended: row.is_recommended === true,
          tagName: stringValue(row.tag_name) || undefined,
        },
      ];
    });
  }

  /** 拉取启用 wiki 的知识库的页面元数据（分页，单库上限 200 页，不含正文）。 */
  async listWikiPages(kbId: string): Promise<KnowledgeLibraryWikiPage[]> {
    const pages: KnowledgeLibraryWikiPage[] = [];
    const pageSize = 100;
    for (let page = 1; page <= 3; page += 1) {
      const payload = (await this.request(
        `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages?page=${String(page)}&page_size=${String(pageSize)}`,
      )) as { pages?: unknown; total?: number };
      const rows = Array.isArray(payload.pages) ? payload.pages : [];
      for (const row of rows) {
        const item = toWikiPage(row, kbId);
        if (item) pages.push(item);
      }
      const total =
        typeof payload.total === "number" ? payload.total : rows.length;
      if (pages.length >= total || rows.length < pageSize) break;
    }
    return pages.slice(0, 200);
  }

  /** 获取单个 wiki 页面全文（WeKnora 按 slug 提供页面内容）。 */
  async getWikiPageContent(
    kbId: string,
    slug: string,
  ): Promise<KnowledgeDocumentContent> {
    const payload = (await this.request(
      `/knowledgebase/${encodeURIComponent(kbId)}/wiki/pages/${encodeWikiSlug(slug)}`,
    )) as Record<string, unknown>;
    const content = isRecord(payload) ? stringValue(payload.content) : "";
    let truncated = false;
    let body = content.replace(
      RESOURCE_IMAGE_PATTERN,
      (_match, alt: string, handle: string) =>
        `![${alt}](/api/v1/knowledge/images?file=resource://${handle}&kb=${encodeURIComponent(kbId)})`,
    );
    if (body.length > 200_000) {
      body = body.slice(0, 200_000);
      truncated = true;
    }
    return { content: body, charCount: body.length, truncated };
  }

  /** 拉取文档全部文本 chunks，按原文位置排序拼接为全文。 */
  async loadDocumentContent(
    knowledgeId: string,
  ): Promise<KnowledgeDocumentContent> {
    const chunks: Array<{
      content: string;
      startAt: number;
      index: number;
      knowledgeBaseId: string;
    }> = [];
    const pageSize = 100;
    for (let page = 1; page <= 20; page += 1) {
      const payload = (await this.request(
        `/chunks/${encodeURIComponent(knowledgeId)}?page=${String(page)}&page_size=${String(pageSize)}`,
      )) as { data?: unknown; total?: number };
      const rows = Array.isArray(payload.data) ? payload.data : [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        const content = stringValue(row.content);
        if (!content) continue;
        chunks.push({
          content,
          startAt: numberValue(row.start_at) ?? Number.MAX_SAFE_INTEGER,
          index: numberValue(row.chunk_index) ?? 0,
          knowledgeBaseId: stringValue(row.knowledge_base_id),
        });
      }
      const total =
        typeof payload.total === "number" ? payload.total : rows.length;
      if (chunks.length >= total || rows.length < pageSize) break;
    }
    chunks.sort(
      (left, right) => left.startAt - right.startAt || left.index - right.index,
    );
    const knowledgeBaseId =
      chunks.find((chunk) => chunk.knowledgeBaseId)?.knowledgeBaseId ?? "";
    let content = chunks
      .map((chunk) => chunk.content)
      .join("\n\n")
      .replace(
        RESOURCE_IMAGE_PATTERN,
        (_match, alt: string, handle: string) =>
          `![${alt}](/api/v1/knowledge/images?file=resource://${handle}&kb=${encodeURIComponent(knowledgeBaseId)})`,
      );
    let truncated = false;
    if (content.length > 200_000) {
      content = content.slice(0, 200_000);
      truncated = true;
    }
    return { content, charCount: content.length, truncated };
  }

  /** 获取可用知识库 ID 列表（带60秒缓存） */
  private async availableKnowledgeBaseIds(): Promise<string[]> {
    if (this.options.knowledgeBaseIds) return this.options.knowledgeBaseIds;
    if (this.cachedKnowledgeBaseIds && Date.now() < this.cacheExpiresAt) {
      return this.cachedKnowledgeBaseIds;
    }
    const payload = (await this.request(
      "/knowledge-bases",
    )) as KnowledgeBasePayload;
    const rows = Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload.data) && Array.isArray(payload.data.list)
        ? payload.data.list
        : [];
    const ids = rows.flatMap((row) =>
      isRecord(row) && typeof row.id === "string" && row.id.length > 0
        ? [row.id]
        : [],
    );
    this.cachedKnowledgeBaseIds = ids;
    this.cacheExpiresAt = Date.now() + 60_000;
    return ids;
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("x-api-key", this.options.apiKey);
    headers.set("x-request-id", weknoraRequestId());
    const response = await this.fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`weknora_request_failed:${String(response.status)}`);
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("weknora_invalid_response");
    }
  }

  /**
   * 受控治理：模型 / 向量库 / 存储的创建与删除（经 Weflow 白名单 schema 校验，
   * 不暴露上游凭据）。上游契约实测：创建仅接受基础字段（带 parameters 会挂起），
   * PUT 为全量替换语义（危险，不做编辑）。
   */
  async createModel(input: {
    name: string;
    type: string;
    source: string;
    display_name?: string | undefined;
    description?: string | undefined;
  }): Promise<unknown> {
    return this.request("/models", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async deleteModel(modelId: string): Promise<void> {
    await this.request(`/models/${encodeURIComponent(modelId)}`, {
      method: "DELETE",
    });
  }

  async createVectorStore(input: {
    name: string;
    engine_type: string;
    connection_config?: Record<string, unknown> | undefined;
  }): Promise<unknown> {
    return this.request("/vector-stores", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async testVectorStore(input: {
    name: string;
    engine_type: string;
    connection_config?: Record<string, unknown> | undefined;
  }): Promise<unknown> {
    return this.request("/vector-stores/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  async createStorageBackend(input: {
    name: string;
    provider: string;
  }): Promise<unknown> {
    return this.request("/storage-backends", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  /**
   * 读取租户检索配置（dense / BM25 / rerank 阈值）。
   * 只把白名单字段映射回 Weflow 结构；上游未知字段不进入 Weflow 视野。
   */
  async getRetrievalSettings(): Promise<RetrievalSettings> {
    const payload = await this.request("/tenants/kv/retrieval-config");
    const data: Record<string, unknown> =
      isRecord(payload) && isRecord(payload.data) ? payload.data : {};
    return {
      embeddingTopK: numberValue(data.embedding_top_k) ?? 0,
      vectorThreshold: numberValue(data.vector_threshold) ?? 0,
      keywordThreshold: numberValue(data.keyword_threshold) ?? 0,
      rerankTopK: numberValue(data.rerank_top_k) ?? 0,
      rerankThreshold: numberValue(data.rerank_threshold) ?? 0,
      rerankModelId: stringValue(data.rerank_model_id),
    };
  }

  /**
   * 更新租户检索配置（read-modify-write）。
   * 只合并白名单字段；上游可能存在的未知字段原样保留，绝不因 PUT 被清空。
   */
  async updateRetrievalSettings(
    patch: RetrievalSettingsPatch,
  ): Promise<RetrievalSettings> {
    const payload = await this.request("/tenants/kv/retrieval-config");
    const upstream: Record<string, unknown> =
      isRecord(payload) && isRecord(payload.data) ? payload.data : {};
    const merged: Record<string, unknown> = { ...upstream };
    if (patch.embeddingTopK !== undefined)
      merged.embedding_top_k = patch.embeddingTopK;
    if (patch.vectorThreshold !== undefined)
      merged.vector_threshold = patch.vectorThreshold;
    if (patch.keywordThreshold !== undefined)
      merged.keyword_threshold = patch.keywordThreshold;
    if (patch.rerankTopK !== undefined) merged.rerank_top_k = patch.rerankTopK;
    if (patch.rerankThreshold !== undefined)
      merged.rerank_threshold = patch.rerankThreshold;
    if (patch.rerankModelId !== undefined)
      merged.rerank_model_id = patch.rerankModelId;
    const result = await this.request("/tenants/kv/retrieval-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(merged),
    });
    const data: Record<string, unknown> =
      isRecord(result) && isRecord(result.data) ? result.data : {};
    return {
      embeddingTopK:
        numberValue(data.embedding_top_k) ?? patch.embeddingTopK ?? 0,
      vectorThreshold:
        numberValue(data.vector_threshold) ?? patch.vectorThreshold ?? 0,
      keywordThreshold:
        numberValue(data.keyword_threshold) ?? patch.keywordThreshold ?? 0,
      rerankTopK: numberValue(data.rerank_top_k) ?? patch.rerankTopK ?? 0,
      rerankThreshold:
        numberValue(data.rerank_threshold) ?? patch.rerankThreshold ?? 0,
      rerankModelId:
        stringValue(data.rerank_model_id) || patch.rerankModelId || "",
    };
  }
}

function toEvidence(value: unknown): KnowledgeEvidence | undefined {
  if (
    !isRecord(value) ||
    typeof value.content !== "string" ||
    !value.content.trim()
  ) {
    return undefined;
  }
  return {
    chunkId: stringValue(value.id),
    knowledgeId: stringValue(value.knowledge_id),
    knowledgeBaseId: stringValue(value.knowledge_base_id),
    title: stringValue(value.knowledge_title),
    filename: stringValue(value.knowledge_filename),
    source: stringValue(value.knowledge_source),
    chunkType: stringValue(value.chunk_type),
    content: value.content.trim().slice(0, 4_000),
    matchedContent: stringValue(value.matched_content).slice(0, 1_000),
    score:
      typeof value.score === "number" && Number.isFinite(value.score)
        ? value.score
        : 0,
    startAt: numberValue(value.start_at),
    endAt: numberValue(value.end_at),
  };
}

function toLibraryDocument(
  value: unknown,
): KnowledgeLibraryDocument | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const tags = Array.isArray(value.tags)
    ? value.tags.flatMap((tag) => {
        if (!isRecord(tag) || typeof tag.id !== "string") return [];
        return [{ id: tag.id, name: stringValue(tag.name) || tag.id }];
      })
    : [];
  return {
    knowledgeId: value.id,
    title: stringValue(value.title) || stringValue(value.file_name),
    filename: stringValue(value.file_name),
    fileType: stringValue(value.file_type),
    fileSize: numberValue(value.file_size),
    parseStatus: stringValue(value.parse_status),
    source: stringValue(value.source),
    tags,
    updatedAt: stringValue(value.updated_at) || undefined,
  };
}

function toWikiPage(
  value: unknown,
  knowledgeBaseId: string,
): KnowledgeLibraryWikiPage | undefined {
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const title = stringValue(value.title);
  if (!title) return undefined;
  return {
    pageId: value.id,
    knowledgeBaseId,
    slug: stringValue(value.slug) || value.id,
    title,
    pageType: stringValue(value.page_type) || "page",
    summary: stringValue(value.summary),
    categoryPath: Array.isArray(value.category_path)
      ? value.category_path.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
    updatedAt: stringValue(value.updated_at) || undefined,
  };
}

/** wiki slug 含路径分隔符（如 entity/apx500），按段编码避免破坏路由。 */
function encodeWikiSlug(slug: string): string {
  return slug
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toDocument(payload: unknown, fallbackId: string): KnowledgeDocument {
  const value =
    isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  return {
    id: stringValue(isRecord(value) ? value.id : undefined) || fallbackId,
    title: stringValue(isRecord(value) ? value.title : undefined),
    filename: stringValue(isRecord(value) ? value.filename : undefined),
    fileType: stringValue(
      isRecord(value) ? (value.file_type ?? value.fileType) : undefined,
    ),
    fileSize: numberValue(
      isRecord(value) ? (value.file_size ?? value.fileSize) : undefined,
    ),
    parseStatus: stringValue(
      isRecord(value) ? (value.parse_status ?? value.parseStatus) : undefined,
    ),
    description: stringValue(isRecord(value) ? value.description : undefined),
  };
}

function toSessionMessage(value: unknown): KnowledgeSessionMessage[] {
  if (!isRecord(value) || typeof value.id !== "string") return [];
  const role = value.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return [];
  return [
    {
      id: value.id,
      role,
      content: stringValue(value.content),
      createdAt: stringValue(value.created_at ?? value.createdAt),
      completed: value.is_completed !== false,
      references: Array.isArray(value.knowledge_references)
        ? value.knowledge_references.filter(isRecord)
        : [],
    },
  ];
}

function toSuggestionSet(payload: unknown): KnowledgeSuggestionSet | undefined {
  const value =
    isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  if (!isRecord(value) || typeof value.id !== "string") return undefined;
  const questions = Array.isArray(value.questions)
    ? value.questions.flatMap((item) => {
        if (!isRecord(item) || typeof item.id !== "string") return [];
        const text = stringValue(item.text);
        return text ? [{ id: item.id, text }] : [];
      })
    : [];
  return {
    id: value.id,
    status: stringValue(value.status),
    questions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
