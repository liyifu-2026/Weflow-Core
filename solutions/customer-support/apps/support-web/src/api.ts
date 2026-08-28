/**
 * Solution API client.
 *
 * Embedded mode (Console ExtensionHost): every request is delegated to the
 * restricted bridge handed over by the host — the bundle never touches the
 * Console's internal stores or router.
 *
 * Standalone/dev mode: falls back to direct same-origin fetch so
 * `pnpm dev` works against a locally running Core via the Vite proxy.
 */
export type ApiError = Error & { status?: number; code?: string };

type BridgeFetch = (path: string, init?: RequestInit) => Promise<Response>;

let bridgeFetch: BridgeFetch | null = null;

export function setApiBridge(implementation: BridgeFetch | null): void {
  bridgeFetch = implementation;
}

export type { BridgeFetch };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has("content-type")
  ) {
    headers.set("content-type", "application/json");
  }
  const send = bridgeFetch ?? ((p, i) => fetch(p, i));
  const response = await send(path, {
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
    upload_too_large: "文件超出大小限制",
    operator_or_admin_required: "此操作需要运营或管理员权限",
    ai_employee_key_exists: "这个 AI Employee Key 已存在",
    ai_employee_not_found: "AI Employee 不存在",
    ai_employee_not_editable: "AI Employee 当前不可编辑",
    ai_employee_not_archivable: "AI Employee 当前不可归档",
    ai_employee_not_versionable: "当前不能建立新版本",
    ai_employee_version_not_editable: "已发布版本不可编辑",
    ai_employee_version_not_publishable: "当前版本不可发布",
    ai_employee_version_not_rollbackable: "当前版本不可回滚",
    ai_employee_default_invalid: "默认 AI Employee 无效或未发布",
    contact_agent_binding_invalid: "联系人或 AI Employee 无效",
    policy_not_found: "待验证的策略版本不存在",
    policy_not_publishable: "策略当前不可发布，请检查版本状态",
    case_not_promotable: "案例尚未完成脱敏审核，不能进入基准区",
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
    avatar_unsupported_type: "头像仅支持 JPG / PNG / WebP 图片",
    avatar_preset_unknown: "预设头像不存在，请刷新后重试",
    thread_not_found: "问答会话不存在，请重新发起",
    generation_in_progress: "已有一次生成进行中，请稍候",
    generation_failed: "内容生成失败，请重试",
    knowledge_thread_not_found: "问答会话不存在，请重新发起",
  };
  return (
    copy[code] ??
    (status >= 500 ? "服务暂时不可用，请稍后再试" : "请求未被接受")
  );
}
