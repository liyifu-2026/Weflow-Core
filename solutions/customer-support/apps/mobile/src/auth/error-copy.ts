/**
 * 认证错误提示文案模块
 * 将认证相关的错误码映射为用户可读的中文提示。
 */
/** 根据认证错误码返回对应的中文提示信息 */
export function authErrorCopy(code: string): string {
  if (code === "invalid_credentials") return "账号或密码不正确，请重新输入。";
  if (code === "authentication_required" || code === "token_expired")
    return "登录已失效，请重新登录。";
  if (code === "account_disabled") return "该账号已被停用，请联系管理员。";
  return "暂时无法登录，请检查网络后重试。";
}

/** 根据名片资料错误码返回对应的中文提示信息 */
export function profileErrorCopy(code: string): string {
  if (code === "invalid_display_name") return "显示名需为 1-24 个字符。";
  if (code === "unknown_tag") return "包含系统不支持的标签，请重新选择。";
  if (code === "invalid_request") return "资料格式不正确，请检查后重试。";
  if (code === "avatar_unsupported_type") return "头像仅支持 JPG / PNG / WebP 图片。";
  if (code === "avatar_preset_unknown") return "预设头像不存在，请重试。";
  if (code === "upload_too_large") return "头像文件超出大小限制。";
  return "保存失败，请稍后重试。";
}
