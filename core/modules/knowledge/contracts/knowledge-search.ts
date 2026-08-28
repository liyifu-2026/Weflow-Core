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

/** 检索调用选项：证据窗口与过滤条件。 */
export type KnowledgeSearchOptions = {
  knowledgeBaseIds?: string[] | undefined;
  knowledgeIds?: string[] | undefined;
  tagIds?: string[] | undefined;
  mentionedItems?: Array<Record<string, string>> | undefined;
  /** 返回证据条数上限；缺省 6，深度检索用更大值。 */
  limit?: number | undefined;
};

/** 知识库目录摘要。 */
export type KnowledgeBaseSummary = {
  id: string;
  name: string;
  type: string;
  description: string;
  /** 是否启用 wiki 模式（wiki pages 独立于文档存储）。 */
  wikiEnabled: boolean;
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

/** 文档/wiki 全文（Provider 聚合后提供）。 */
export type KnowledgeDocumentContent = {
  content: string;
  charCount: number;
  truncated: boolean;
};

/** 受保护的原文/图片字节预览响应。 */
export type KnowledgeResourcePreview = {
  body: Uint8Array;
  contentType: string;
};

/** 单个知识文档的安全摘要（不含存储路径等内部字段）。 */
export type KnowledgeDocumentSummary = {
  id: string;
  title: string;
  filename: string;
  fileType: string;
  fileSize: number | null;
  parseStatus: string;
  description: string;
};

/** 推荐问题集合。 */
export type KnowledgeSuggestionSet = {
  id: string;
  status: string;
  questions: Array<{ id: string; text: string }>;
};

/** 租户检索配置白名单契约（dense / BM25 / rerank 阈值）。 */
export type RetrievalSettings = {
  embeddingTopK: number;
  vectorThreshold: number;
  keywordThreshold: number;
  rerankTopK: number;
  rerankThreshold: number;
  rerankModelId: string;
};

/** 允许更新的检索配置子集。 */
export type RetrievalSettingsPatch = Partial<RetrievalSettings>;

/** 流式知识问答选项。 */
export type KnowledgeQAOptions = KnowledgeSearchOptions & {
  disableTitle?: boolean;
  channel?: string;
};

/**
 * 知识模块对底层知识库 Provider 的依赖端口：检索、目录、全文、受控会话、
 * 流式问答与租户治理操作。由基础设施的 Provider 客户端结构化实现；
 * 模块代码（应用服务与 HTTP 适配器）只依赖本端口，不感知具体 Provider。
 */
export interface KnowledgeProvider {
  search(
    query: string,
    options?: KnowledgeSearchOptions,
  ): Promise<KnowledgeEvidence[]>;
  listKnowledgeBases(): Promise<KnowledgeBaseSummary[]>;
  listKnowledgeDocuments(kbId: string): Promise<KnowledgeLibraryDocument[]>;
  listKnowledgeTags(kbId: string): Promise<KnowledgeLibraryTag[]>;
  listFaqEntries(kbId: string): Promise<KnowledgeLibraryFaq[]>;
  listWikiPages(kbId: string): Promise<KnowledgeLibraryWikiPage[]>;
  loadDocumentContent(documentId: string): Promise<KnowledgeDocumentContent>;
  getWikiPageContent(
    kbId: string,
    slug: string,
  ): Promise<KnowledgeDocumentContent>;
  fetchResourceFile(
    kbId: string,
    resourcePath: string,
  ): Promise<KnowledgeResourcePreview>;
  createSession(title?: string): Promise<string>;
  streamKnowledgeQA(
    sessionId: string,
    query: string,
    options?: KnowledgeQAOptions,
    signal?: AbortSignal,
  ): Promise<Response>;
  stopSession(sessionId: string, messageId: string): Promise<void>;
  ensureSuggestions(
    sessionId: string,
    messageId: string,
  ): Promise<KnowledgeSuggestionSet | undefined>;
  getDocument(documentId: string): Promise<KnowledgeDocumentSummary>;
  preview(documentId: string): Promise<KnowledgeResourcePreview>;
  createModel(input: {
    name: string;
    type: string;
    source: string;
    display_name?: string | undefined;
    description?: string | undefined;
  }): Promise<unknown>;
  deleteModel(modelId: string): Promise<void>;
  createVectorStore(input: {
    name: string;
    engine_type: string;
    connection_config?: Record<string, unknown> | undefined;
  }): Promise<unknown>;
  testVectorStore(input: {
    name: string;
    engine_type: string;
    connection_config?: Record<string, unknown> | undefined;
  }): Promise<unknown>;
  createStorageBackend(input: {
    name: string;
    provider: string;
  }): Promise<unknown>;
  getRetrievalSettings(): Promise<RetrievalSettings>;
  updateRetrievalSettings(
    patch: RetrievalSettingsPatch,
  ): Promise<RetrievalSettings>;
}

/** 草稿生成使用的聊天补全消息。 */
export type KnowledgeChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

/**
 * 知识草稿生成依赖的文本补全端口。
 * 由基础设施的 OpenAI 兼容模型客户端结构化实现；模块代码不感知具体 Provider。
 */
export interface KnowledgeChatCompletionModel {
  complete(
    messages: KnowledgeChatMessage[],
    options?: { jsonObject?: boolean },
  ): Promise<string>;
}
