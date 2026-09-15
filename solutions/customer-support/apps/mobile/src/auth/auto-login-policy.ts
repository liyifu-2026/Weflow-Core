/**
 * 登录页启动策略：决定是否允许静默自动登录。
 * 「切换账号 / 退出」等用户主动跳转（manual 参数）必须跳过自动登录——
 * 刚退出的账号往往仍记着密码（登录卡片故意保留），放行会把用户直接
 * 顶回工作台/改密页，表现为「点了切换账号进不了登录页」。
 * username 参数（最近登录卡片预填）同样只预填不自动登录。
 */
export type SignInEntryParams = {
  username?: string;
  manual?: string;
};

/** 判断登录页本次进入是否允许静默自动登录 */
export function shouldAttemptAutoLogin(params: SignInEntryParams): boolean {
  if (typeof params.username === "string" && params.username.trim()) {
    return false;
  }
  if (params.manual === "1") {
    return false;
  }
  return true;
}
