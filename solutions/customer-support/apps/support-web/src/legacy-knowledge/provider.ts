import { api } from "../api";

/**
 * @deprecated ZhiNanKB migration adapter. Only knowledge-management views may
 * import this module. New Weflow product pages must use native Weflow APIs.
 */
export function legacyKnowledgeApi<T>(path: string, init: RequestInit = {}) {
  if (!path.startsWith("/")) throw new Error("legacy_knowledge_path_required");
  return api<T>(`/api/v1/console/knowledge-provider${path}`, init);
}

