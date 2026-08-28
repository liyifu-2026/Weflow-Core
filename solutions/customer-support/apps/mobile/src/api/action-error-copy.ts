/**
 * 操作错误提示文案模块
 * 将 Core 返回的错误码和 HTTP 状态码映射为用户可读的中文提示。
 */
export type ActionErrorCopy = { title: string; message?: string };

/**
 * 根据错误信息生成用户友好的提示文案
 * @param error - 包含错误码和 HTTP 状态码的对象，undefined 表示网络不可达
 */
export function actionErrorCopy(
  error?: { code: string; status: number },
): ActionErrorCopy {
  if (!error) return { title: "网络连接失败", message: "请稍后重试" };
  const byCode: Record<string, ActionErrorCopy> = {
    handoff_already_claimed: {
      title: "已由其他客服接手",
      message: "会话已切换为只读",
    },
    handoff_not_assignee: {
      title: "当前不可操作",
      message: "你已不是这次会话的负责人",
    },
    handoff_assignee_not_found: {
      title: "该同事当前不可接收会话",
      message: "请重新选择",
    },
    invalid_handoff_transition: {
      title: "会话状态已变化",
      message: "刷新后查看最新状态",
    },
    duplicate_active_request: {
      title: "已有协作请求",
      message: "无需重复提交",
    },
    queue_not_found: { title: "协作组不可用" },
    not_queue_member: { title: "你不在该协作组" },
    revision_conflict: {
      title: "会话已有新内容",
      message: "请先查看最新消息",
    },
  };
  if (byCode[error.code]) return byCode[error.code];
  if (error.status === 400) return { title: "提交内容不完整" };
  if (error.status === 403) return { title: "没有执行此操作的权限" };
  if (error.status === 404) return { title: "相关内容已不存在" };
  if (error.status === 409)
    return { title: "状态已变化", message: "刷新后重试" };
  if (error.status >= 500)
    return { title: "服务暂时不可用", message: "本次操作没有完成" };
  return { title: "操作没有完成" };
}
