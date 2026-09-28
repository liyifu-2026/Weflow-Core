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

/**
 * 写单个设置分节：保存前重读整行，再对分节做浅合并——节内 UI 未暴露的键
 * （botNames / threadTtlMinutes / roundSummaryLabels 等）保留不动，避免被
 * 整节替换冲掉；同时也避免「页面加载快照」覆盖其他分区刚保存的内容
 * （丢失更新）。仍非服务端事务，但窗口缩到毫秒级。
 */
export async function writePipelineSettingsSection(
  section: string,
  value: Record<string, unknown>,
): Promise<void> {
  const latest = await readPipelineSettings();
  const currentSection =
    typeof latest[section] === "object" && latest[section] !== null
      ? (latest[section] as Record<string, unknown>)
      : {};
  await writePipelineSettings({
    ...latest,
    [section]: { ...currentSection, ...value },
  });
}
