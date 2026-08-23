export type ApiError = Error & { status?: number; code?: string };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "include",
  });
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const code =
      typeof payload === "object" && payload
        ? String((payload as { error?: string }).error ?? "")
        : "";
    const error = new Error(errorCopy(code, response.status)) as ApiError;
    error.status = response.status;
    error.code = code;
    throw error;
  }
  return payload as T;
}

function errorCopy(code: string, status: number): string {
  const copy: Record<string, string> = {
    authentication_required: "登录已失效，请重新登录",
    admin_required: "此操作仅管理员可执行",
    invalid_request: "请求参数不合法，请检查填写内容",
    invalid_cursor: "分页游标无效，请刷新后重试",
    conversation_not_found: "会话不存在或已删除",
    handoff_not_found: "交接记录不存在",
    handoff_not_assignee: "当前会话不属于你，无法执行此操作",
    handoff_already_claimed: "会话已被其他客服接管",
    invalid_handoff_transition: "当前状态不支持此操作，请刷新后重试",
    handoff_revision_conflict: "交接状态已变化，请刷新后重试",
    conversation_revision_conflict: "会话内容已更新，请刷新后重试",
    handoff_transfer_unavailable: "当前会话状态不支持转交",
    assignee_not_found: "目标客服不存在或已停用",
    media_not_found: "文件不存在或未就绪",
    media_not_ready: "文件仍在处理中，请稍后查看",
    memory_not_found: "记忆不存在",
    invalid_memory_transition: "当前记忆状态不支持此操作",
  };
  return (
    copy[code] ??
    (status >= 500 ? "服务暂时不可用，请稍后重试" : "请求未能完成")
  );
}
