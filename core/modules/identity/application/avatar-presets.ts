/**
 * 平台预设客服头像（DiceBear "Blobs"，CC0 1.0）。
 *
 * 客服（用户）头像的默认兜底：用户既没有自定义上传、也没有选择预设时，
 * 按稳定种子（用户名）哈希分配一组预设，保证同一客服始终显示同一头像。
 * 预设清单同时作为 GET /api/v1/users/avatar-presets 的返回，供前端选择器渲染。
 *
 * 预设不再内嵌 SVG：每个预设是 DiceBear Blobs 样式的一个稳定 seed，
 * SVG 经平台代理 GET /api/v1/avatars/dicebear/blobs/:seed 动态生成
 * （确定性：同 seed 永远同一图形）。新增/调整预设只改这个种子池。
 */

import { diceBearAvatarUrl } from "./dicebear-avatars.js";

export type UserAvatarPreset = {
  id: string;
  name: string;
  /** 预设对应的 DiceBear seed（Blobs 样式） */
  seed: string;
};

/** 预设种子池：每个 seed 是一个固定的 Blobs 头像（颜色/形状各异） */
export const USER_AVATAR_PRESET_SEEDS: readonly UserAvatarPreset[] = [
  { id: "blobs-1", name: "青蓝", seed: "waaun9hx" },
  { id: "blobs-2", name: "琥珀", seed: "amber-02" },
  { id: "blobs-3", name: "紫红", seed: "violet-03" },
  { id: "blobs-4", name: "翠绿", seed: "emerald-04" },
  { id: "blobs-5", name: "靛蓝", seed: "indigo-05" },
];

/** 兼容别名（既有导入点沿用）：预设清单 */
export const USER_AVATAR_PRESETS = USER_AVATAR_PRESET_SEEDS;

/** 按 id 查找预设；未知 id 返回 undefined */
export function userAvatarPresetById(id: string): UserAvatarPreset | undefined {
  return USER_AVATAR_PRESETS.find((preset) => preset.id === id);
}

/**
 * 稳定字符串哈希 → 预设下标。
 * 前端（DefaultAvatar / StaffAvatar 降级）必须使用完全相同的算法与种子
 * （后端使用 username），才能保证降级时与后端默认头像一致。
 */
export function presetIndexForSeed(seed: string): number {
  let hash = 0;
  for (const ch of seed || "?") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % USER_AVATAR_PRESETS.length;
}

/** 客服默认头像：按稳定种子（用户名）哈希分配一组预设 */
export function defaultUserAvatarPreset(seed: string): UserAvatarPreset {
  const preset = USER_AVATAR_PRESETS[presetIndexForSeed(seed)];
  // 预设表是模块内常量且非空，索引必然命中
  return preset ?? USER_AVATAR_PRESETS[0]!;
}

/** 预设头像的平台代理 URL（两端统一经此取图） */
export function userAvatarPresetUrl(preset: UserAvatarPreset): string {
  return diceBearAvatarUrl("blobs", preset.seed);
}

/**
 * 预设头像的降级 SVG 文本（上游不可达时路由层回退用）：
 * 用 seed 哈希生成纯色圆 + 首字母的极简占位，保证端点始终有内容。
 */
export function fallbackPresetSvg(preset: UserAvatarPreset): string {
  const palette = [
    ["#0369a1", "#ffffff"],
    ["#b45309", "#ffffff"],
    ["#a21caf", "#ffffff"],
    ["#047857", "#ffffff"],
    ["#1d4ed8", "#ffffff"],
  ];
  const [bg, fg] = palette[presetIndexForSeed(preset.seed)] ?? palette[0]!;
  const letter = (preset.name || preset.id).trim().slice(0, 1);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="512" height="512">` +
    `<rect width="100" height="100" fill="${bg}"/>` +
    `<text x="50" y="50" dy=".35em" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="system-ui,sans-serif" font-size="52" font-weight="700" fill="${fg}">${letter}</text>` +
    `</svg>`
  );
}
