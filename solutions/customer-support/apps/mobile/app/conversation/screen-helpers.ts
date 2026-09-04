/**
 * 会话详情页纯工具：发送状态文案、失败分类与操作错误弹窗。
 */
import { Alert } from "react-native";
import { ApiError } from "@/api/client";
import { actionErrorCopy } from "@/api/action-error-copy";
import type { SendFailure } from "./types";

export function sendStateCopy(state: string) {
  return state === "pending"
    ? "等待发送"
    : state === "submitting"
      ? "发送中"
      : state === "confirmed" || state === "observed"
        ? "已发送"
        : state;
}
/** 发送失败文案映射 */
export function failureCopy(code?: string | null) {
  if (code === "outcome_unknown") return "结果未知 · 点击查询执行结果";
  if (code === "permission_lost") return "权限已变化 · 会话已切换为只读";
  if (code === "rejected") return "发送被拒绝";
  return "发送失败 · 点击重试";
}
/** 将 API 错误分类为发送失败类型 */
export function classifySendFailure(reason: unknown): SendFailure {
  if (reason instanceof ApiError) {
    if (reason.code === "handoff_not_assignee") return "permission_lost";
    if (reason.status >= 400 && reason.status < 500) return "rejected";
    return "outcome_unknown";
  }
  return "outcome_unknown";
}
/** 显示操作错误提示弹窗 */
export function showActionError(reason: unknown) {
  const copy = actionErrorCopy(
    reason instanceof ApiError
      ? { code: reason.code, status: reason.status }
      : undefined,
  );
  Alert.alert(copy.title, copy.message);
}
/** 协作请求摘要组件：展示当前活跃的协助请求及操作按钮 */
