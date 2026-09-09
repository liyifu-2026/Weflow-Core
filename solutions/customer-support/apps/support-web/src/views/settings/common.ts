/**
 * 设置中心分区组件共享类型与端点常量（R2）。
 */
import { api } from "../../api";

export const PIPELINE_SETTINGS_URL =
  "/api/v1/admin/solutions/weflow.customer-support/extensions/support-pipeline/settings";

/** 扩展设置形状（support-pipeline 行） */
export type PipelineExtensionSettings = {
  pipeline?: Record<string, unknown>;
  groupChat?: Record<string, unknown>;
  behavior?: Record<string, unknown>;
  knowledgeConnector?: Record<string, unknown>;
  [key: string]: unknown;
};

/** 读扩展设置（整行 JSON） */
export async function readPipelineSettings(): Promise<PipelineExtensionSettings> {
  const result = await api<{ settings: PipelineExtensionSettings }>(
    PIPELINE_SETTINGS_URL,
  );
  return typeof result.settings === "object" && result.settings !== null
    ? result.settings
    : {};
}

/** 写扩展设置（整体替换，调用方负责 merge 后回写） */
export function writePipelineSettings(
  settings: PipelineExtensionSettings,
): Promise<void> {
  return api(PIPELINE_SETTINGS_URL, {
    method: "PUT",
    body: JSON.stringify({ settings }),
  });
}
