/**
 * 平台预设头像的本地映射（登录页专用）。
 *
 * 登录页头像条在「无会话」上下文渲染：Core 的头像端点
 * （GET /users/:id/avatar 与 /avatars/dicebear 代理）都要求 Bearer 认证，
 * 而切换账号/退出后本地已无可用的未吊销 token，网络取图必然 401。
 * 预设是 5 个固定的 DiceBear Blobs 卡通（种子池与 Core
 * core/modules/identity/application/avatar-presets.ts 同源同版本），
 * 因此把 SVG 打包进 App 本地渲染，登录页零网络依赖。
 *
 * 维护约定：Core 种子池调整时同步本表与 assets/avatars/ 下的 SVG。
 */
import blobs1 from "@/assets/avatars/blobs-1.svg";
import blobs2 from "@/assets/avatars/blobs-2.svg";
import blobs3 from "@/assets/avatars/blobs-3.svg";
import blobs4 from "@/assets/avatars/blobs-4.svg";
import blobs5 from "@/assets/avatars/blobs-5.svg";

/** 预设 id → 本地 SVG 资源（与 Core USER_AVATAR_PRESET_SEEDS 一一对应） */
export const PRESET_AVATAR_SOURCES: Record<string, number> = {
  "blobs-1": blobs1,
  "blobs-2": blobs2,
  "blobs-3": blobs3,
  "blobs-4": blobs4,
  "blobs-5": blobs5,
};

/** 按预设 id 取本地 SVG；未知 id 返回 undefined（调用方降级首字母） */
export function presetAvatarSource(presetId?: string | null): number | undefined {
  return presetId ? PRESET_AVATAR_SOURCES[presetId] : undefined;
}
