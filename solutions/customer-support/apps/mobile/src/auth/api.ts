/**
 * 认证 API 模块
 * 封装登录、修改密码、登出等与 Core 认证相关的 HTTP 请求。
 */
import { request } from "@/api/client";
import type { MobileSession } from "./session";

/** 移动端登录，返回会话令牌和用户信息 */
export async function mobileLogin(
  username: string,
  password: string,
): Promise<MobileSession> {
  return request<MobileSession>("/api/v1/mobile/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

/** 修改密码，成功后返回更新后的用户信息 */
export async function changePassword(
  session: MobileSession,
  currentPassword: string,
  newPassword: string,
): Promise<MobileSession["user"]> {
  const result = await request<{ user: MobileSession["user"] }>(
    "/api/v1/auth/change-password",
    {
      method: "POST",
      token: session.sessionToken,
      body: JSON.stringify({ currentPassword, newPassword }),
    },
  );
  return result.user;
}

/** 移动端登出，通知 Core 使当前会话令牌失效 */
export async function mobileLogout(token: string): Promise<void> {
  await request<void>("/api/v1/mobile/auth/logout", { method: "POST", token });
}

/** 名片可选标签词表（标签键与专家队列同源） */
export type AgentTag = { key: string; displayName: string };

/** 获取信息名片可选标签词表 */
export async function fetchTagVocabulary(
  session: MobileSession,
): Promise<AgentTag[]> {
  const result = await request<{ tags: AgentTag[] }>(
    "/api/v1/auth/tag-vocabulary",
    { token: session.sessionToken },
  );
  return result.tags;
}

/** 获取当前登录用户信息（GET /api/v1/auth/me；Bearer 鉴权） */
export async function getMe(session: MobileSession): Promise<MobileSession["user"]> {
  const result = await request<{ user: MobileSession["user"] }>("/api/v1/auth/me", {
    token: session.sessionToken,
  });
  return result.user;
}

/** 更新信息名片资料（显示名 / 专家标签），成功后返回更新后的用户信息 */
export async function updateProfile(
  session: MobileSession,
  input: { displayName?: string | null; tags?: string[] },
): Promise<MobileSession["user"]> {
  const result = await request<{ user: MobileSession["user"] }>(
    "/api/v1/auth/me",
    {
      method: "PUT",
      token: session.sessionToken,
      body: JSON.stringify(input),
    },
  );
  return result.user;
}

/** 上传/更换客服头像（multipart；返回新的头像相对路径） */
export async function uploadAvatar(
  session: MobileSession,
  file: { uri: string; mimeType: string; fileName: string },
): Promise<{ avatarUrl: string }> {
  const form = new FormData();
  // React Native FormData 文件字段：{ uri, name, type }
  form.append("file", {
    uri: file.uri,
    name: file.fileName,
    type: file.mimeType,
  } as unknown as Blob);
  const { apiBaseUrl } = await import("@/api/config");
  const { ApiError } = await import("@/api/client");
  const { notifyAuthenticationRequired } = await import("@/auth/auth-events");
  const response = await fetch(`${apiBaseUrl}/api/v1/auth/avatar`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.sessionToken}` },
    body: form,
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    if (response.status === 401) notifyAuthenticationRequired();
    throw new ApiError(payload.error ?? "request_failed", response.status);
  }
  return (await response.json()) as { avatarUrl: string };
}

/** 平台预设头像项（与 Core identity/avatar-presets 同源；svgUrl 为平台代理取图地址） */
export type UserAvatarPreset = {
  id: string;
  name: string;
  seed?: string;
  svgUrl?: string;
};

/** 拉取平台预设头像清单（头像选择器渲染） */
export async function fetchAvatarPresets(
  session: MobileSession,
): Promise<UserAvatarPreset[]> {
  const result = await request<{ presets: UserAvatarPreset[] }>(
    "/api/v1/users/avatar-presets",
    { token: session.sessionToken },
  );
  return result.presets;
}

/** 选择/清除预设头像（null = 恢复默认哈希预设），返回更新后的用户信息 */
export async function selectAvatarPreset(
  session: MobileSession,
  preset: string | null,
): Promise<MobileSession["user"]> {
  const result = await request<{ user: MobileSession["user"] }>(
    "/api/v1/auth/avatar",
    {
      method: "PATCH",
      token: session.sessionToken,
      body: JSON.stringify({ preset }),
    },
  );
  return result.user;
}
