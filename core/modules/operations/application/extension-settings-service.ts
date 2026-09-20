/**
 * 设置中心分区读写（application 层）。
 *
 * 读取直通 infrastructure 读取器；写入补审计——设置变更是影响
 * 业务行为的平台操作，此前只在 interface 层写库、不留审计痕迹。
 */
import { randomUUID } from "node:crypto";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../../infrastructure/postgres/schema.js";
import {
  readSolutionExtensionSettings,
  writeSolutionExtensionSettings,
} from "../../../infrastructure/settings/extension-settings.js";

export async function getExtensionSettings(
  db: NodePgDatabase<typeof schema>,
  input: { solutionId: string; extensionId: string },
): Promise<unknown> {
  return (await readSolutionExtensionSettings(db, input)) ?? {};
}

export async function putExtensionSettings(
  db: NodePgDatabase<typeof schema>,
  input: {
    solutionId: string;
    extensionId: string;
    settingsJson: Record<string, unknown>;
    updatedBy: string;
    sourceIp: string;
  },
): Promise<void> {
  await writeSolutionExtensionSettings(db, {
    solutionId: input.solutionId,
    extensionId: input.extensionId,
    settingsJson: input.settingsJson,
    updatedBy: input.updatedBy,
  });
  await db.insert(schema.auditEvents).values({
    auditId: randomUUID(),
    actorUserId: input.updatedBy,
    eventType: "operations.extension_settings_updated",
    subjectType: "solution_extension",
    subjectId: `${input.solutionId}/${input.extensionId}`,
    sourceIp: input.sourceIp,
    metadata: {
      solutionId: input.solutionId,
      extensionId: input.extensionId,
    },
  });
}
