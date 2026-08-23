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
    password_change_required: "请先修改初始密码",
    admin_required: "此操作仅管理员可执行",
    knowledge_provider_unavailable: "知识服务尚未配置",
    knowledge_provider_failed: "知识服务暂时不可用",
    knowledge_provider_rejected: "知识服务拒绝了本次操作，请检查资料或配置",
    knowledge_route_not_allowed: "此知识端点不在迁移白名单中",
    upload_too_large: "文件不能超过 25 MB",
    last_admin_required: "必须保留至少一名有效管理员",
    username_exists: "用户名已存在",
    invalid_display_name: "显示名需为 1–24 个字符",
    unknown_tag: "包含不可用的标签，请刷新词表后重试",
    policy_not_publishable: "策略未通过对应的影子验证发布门禁",
    policy_not_found: "待验证的策略版本不存在",
    case_not_promotable: "案例尚未完成脱敏审核，不能进入基准区",
    // 知识/会话（白名单化：可读原因 → 可执行文案）
    invalid_request: "请求参数不合法，请检查填写内容",
    invalid_cursor: "分页游标无效，请刷新后重试",
    conversation_not_found: "会话不存在或已删除",
    handoff_not_found: "交接记录不存在",
    handoff_not_assignee: "当前会话不属于你，无法执行此操作",
    handoff_already_claimed: "会话已被其他操作员接管",
    invalid_handoff_transition: "当前状态不支持此操作，请刷新后重试",
    handoff_revision_conflict: "交接状态已变化，请刷新后重试",
    conversation_revision_conflict: "会话内容已更新，请刷新后重试",
    handoff_transfer_unavailable: "当前会话状态不支持转交",
    assignee_not_found: "目标操作员不存在或已停用",
    media_not_found: "文件不存在或未就绪",
    media_not_ready: "文件仍在处理中，请稍后查看",
    thread_not_found: "问答会话不存在，请重新发起",
    generation_in_progress: "已有一次生成进行中，请稍候",
    generation_failed: "内容生成失败，请重试",
    suggestion_unavailable: "建议回复生成失败，请重试",
    no_customer_question: "会话中还没有客户消息，无法生成建议回复",
    knowledge_thread_not_found: "问答会话不存在，请重新发起",
  };
  return (
    copy[code] ??
    (status >= 500 ? "服务暂时不可用，请稍后重试" : "请求未能完成")
  );
}
