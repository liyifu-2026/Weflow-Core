/**
 * 平台预设客服头像访问层（support-web 前端）。
 *
 * 预设清单来自 Core 的 GET /api/v1/users/avatar-presets（单一事实来源，
 * 模块级缓存，失败后允许重试）。预设不内嵌 SVG：清单返回平台代理 URL
 * （DiceBear Blobs 确定性生成），前端直接经该 URL 渲染。
 * 降级哈希算法必须与后端 identity/application/avatar-presets 的
 * presetIndexForSeed 完全一致，种子统一使用 username，保证前端降级
 * 与后端默认头像一致。
 *
 * 与 Console 的 user-avatar-presets.ts 保持同源副本；SDK 化前勿单独修改。
 */
import { api } from "./api";

export type UserAvatarPreset = {
  id: string;
  name: string;
  /** 预设对应的 DiceBear seed */
  seed?: string;
  /** 平台代理取图 URL（同源相对路径，直接渲染） */
  svgUrl?: string;
};

let presetsPromise: Promise<UserAvatarPreset[]> | null = null;

/** 拉取平台预设头像清单（进程内缓存；失败时清缓存允许下次重试） */
export function loadUserAvatarPresets(): Promise<UserAvatarPreset[]> {
  if (!presetsPromise) {
    presetsPromise = api<{ presets: UserAvatarPreset[] }>(
      "/api/v1/users/avatar-presets",
    )
      .then((result) => result.presets)
      .catch((reason) => {
        presetsPromise = null;
        throw reason;
      });
  }
  return presetsPromise;
}

/** 稳定字符串哈希 → 预设下标（与后端算法一致，勿单独修改） */
export function presetIndexForSeed(seed: string, count: number): number {
  let hash = 0;
  for (const ch of seed || "?") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % count;
}

/** 预设渲染 URL：平台代理 svgUrl（同源相对路径） */
export function presetImageUrl(preset: UserAvatarPreset): string | null {
  return preset.svgUrl ?? null;
}
