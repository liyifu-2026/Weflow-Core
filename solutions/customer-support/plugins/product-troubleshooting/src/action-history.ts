/**
 * 结构化动作历史模块(纯函数)
 *
 * 记录建议/进行中/完成/失败/被拒的动作,用于:
 * - 避免重复建议已被客户拒绝或执行失败的方案
 * - 记录 attempt history(结构化,不保存推理)
 *
 * 本模块只做状态建模,不写库、不调模型。
 */

import type { ActionRecord } from "@weflow-leaif/contracts";
import { DEFAULT_SUBJECT } from "./case-facts.js";

/** 动作历史保留:7 天内、最多 20 条 */
export const ACTION_HISTORY_KEEP_MS = 7 * 24 * 60 * 60_000;
export const ACTION_HISTORY_KEEP_MAX = 20;

export type ActionUpdate = {
  action: string;
  result: ActionRecord["result"];
  subject?: string | undefined;
};

/** 追加/更新动作记录;同动作同 subject 覆盖最近一条,超期与超量裁剪 */
export function applyActionUpdates(
  records: ActionRecord[],
  updates: ActionUpdate[],
  now: string,
): ActionRecord[] {
  const cutoff = Date.parse(now) - ACTION_HISTORY_KEEP_MS;
  let next = records.filter((record) => Date.parse(record.at) >= cutoff);
  for (const update of updates) {
    const subject = update.subject ?? DEFAULT_SUBJECT;
    const existingIndex = next.findIndex(
      (record) => record.action === update.action && record.subject === subject,
    );
    const entry: ActionRecord = {
      action: update.action,
      result: update.result,
      subject,
      at: now,
    };
    if (existingIndex >= 0) {
      next = [
        ...next.slice(0, existingIndex),
        entry,
        ...next.slice(existingIndex + 1),
      ];
    } else {
      next = [...next, entry];
    }
  }
  return next.slice(-ACTION_HISTORY_KEEP_MAX);
}

/** 返回被拒或失败的动作名(用于预防性提示,避免重复建议) */
export function rejectedOrFailedActions(
  records: ActionRecord[],
  subject?: string,
): string[] {
  return records
    .filter(
      (record) =>
        (record.result === "rejected" || record.result === "failed") &&
        (subject === undefined || record.subject === subject),
    )
    .map((record) => record.action);
}
