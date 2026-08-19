/**
 * 结构化 Case Fact 存储与更新模块(纯函数)
 *
 * Case Facts 记录"当前客户/当前设备/当前问题真实成立或有待确认的事实"。
 * 三种数据类型严格分离:
 * - Case Facts(本模块):客户身上发生了什么,来源仅 customer | tool | agent_inference
 * - Knowledge Evidence:关于这类问题我们知道什么(不写入本模块)
 * - Tool Observations:系统实际检查到了什么(tool 来源事实,仅 succeeded 可信)
 *
 * 本模块只做状态建模,不写库、不调模型。
 */

import type {
  CaseFact,
  CaseFactGranularity,
  CaseFacts,
  CaseFactSource,
  CaseFactStatus,
} from "@weflow/contracts";

export const DEFAULT_SUBJECT = "default";

export const GRANULARITY_RANK: Record<CaseFactGranularity, number> = {
  major: 1,
  minor: 2,
  patch: 3,
  full: 4,
};

/** Planner / 抽取器提交的事实更新 */
export type CaseFactUpdate = {
  field: string;
  subject?: string | undefined;
  value?: string | undefined;
  status: CaseFactStatus;
  source: CaseFactSource;
  granularity?: CaseFactGranularity | undefined;
};

/** 事实状态变化事件(供 turn 事件记录,不含推理) */
export type FactChangeEvent = {
  type: "confirmed" | "corrected" | "uncertain" | "conflicted" | "invalidated";
  field: string;
  subject: string;
  value?: string | undefined;
  /** 依赖失效级联触发时标记(供 case_plan_invalidated 事件) */
  reason?: "dependency_invalidated" | undefined;
};

/** 静态、有限的派生事实依赖映射(不构建通用规则引擎) */
export const DERIVED_FACT_DEPENDENCIES: Record<string, string[]> = {
  diagnosis: ["software_version", "error_code", "product", "device_model"],
  recommended_solution: ["diagnosis"],
};

/** 默认 subject 的键为裸 field,其余为 `${subject}.${field}` */
export function factKey(field: string, subject: string): string {
  return subject === DEFAULT_SUBJECT ? field : `${subject}.${field}`;
}

/** 从版本号字符串推断粒度;非版本值返回 undefined(视为粒度足够) */
export function inferGranularity(
  value: string,
): CaseFactGranularity | undefined {
  const match = value.match(
    /^\s*(?:v\d+(?:\.\d+){0,3}|\d+\.\d+(?:\.\d+){0,2})\s*$/i,
  );
  if (!match) return undefined;
  const segments = value.trim().replace(/^v/i, "").split(".").length;
  if (segments === 1) return "major";
  if (segments === 2) return "minor";
  if (segments === 3) return "patch";
  return "full";
}

/**
 * 归一化存储值:
 * - legacy 扁平字符串包成 confirmed/customer/default 事实
 * - 结构化事实补齐默认 subject 与缺失的粒度
 */
export function normalizeCaseFacts(
  raw: Record<string, string> | CaseFacts,
  now: string,
): CaseFacts {
  const result: CaseFacts = {};
  for (const [key, rawValue] of Object.entries(raw) as Array<
    [string, unknown]
  >) {
    const value = rawValue;
    if (typeof value === "string") {
      // 复合键 `subject.field` 中的 subject 一并解析(字段名不含点)
      const dot = key.lastIndexOf(".");
      const subject = dot > 0 ? key.slice(0, dot) : DEFAULT_SUBJECT;
      const granularity = inferGranularity(value);
      result[key] = {
        value,
        status: "confirmed",
        source: "customer",
        subject,
        confirmedAt: now,
        lastChangedAt: now,
        ...(granularity ? { granularity } : {}),
      };
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const structuredValue = value as CaseFact;
    const fact: CaseFact = {
      ...structuredValue,
      subject: structuredValue.subject,
    };
    if (fact.granularity === undefined) {
      const granularity = inferGranularity(fact.value);
      if (granularity) fact.granularity = granularity;
    }
    result[key] = fact;
  }
  return result;
}

export function getFact(
  facts: CaseFacts,
  field: string,
  subject: string = DEFAULT_SUBJECT,
): CaseFact | undefined {
  return facts[factKey(field, subject)];
}

function baseFact(
  update: CaseFactUpdate,
  subject: string,
  now: string,
  status: CaseFactStatus,
): CaseFact {
  const granularity =
    update.granularity ?? inferGranularity(update.value ?? "");
  return {
    value: update.value ?? "",
    status,
    source: update.source,
    subject,
    ...(status === "confirmed" ? { confirmedAt: now } : {}),
    lastChangedAt: now,
    ...(granularity ? { granularity } : {}),
  };
}

/**
 * 将更新应用到事实集:
 * - agent_inference 强制 uncertain,且不得覆盖已 confirmed 事实
 * - 同源新值 → 覆盖并保留旧值轨迹(纠正语义,provenance)
 * - 跨源不同值 → conflicted,不静默覆盖
 * - invalidated → 显式失效
 */
export function applyFactUpdates(
  facts: CaseFacts,
  updates: CaseFactUpdate[],
  now: string,
): { facts: CaseFacts; events: FactChangeEvent[] } {
  const next: CaseFacts = { ...facts };
  const events: FactChangeEvent[] = [];
  for (const update of updates) {
    const subject = update.subject ?? DEFAULT_SUBJECT;
    const key = factKey(update.field, subject);
    const existing = next[key];

    if (update.status === "invalidated") {
      if (!existing) continue;
      next[key] = {
        ...existing,
        status: "invalidated",
        lastChangedAt: now,
        invalidatedAt: now,
      };
      events.push({
        type: "invalidated",
        field: update.field,
        subject,
      });
      cascadeInvalidations(next, update.field, subject, now, events);
      continue;
    }

    if (update.source === "agent_inference") {
      // 推断不得进入 confirmed,也不得覆盖已确认事实
      if (
        existing?.status === "confirmed" ||
        existing?.status === "conflicted"
      ) {
        continue;
      }
      if (
        existing &&
        existing.value === update.value &&
        existing.status === "uncertain"
      ) {
        continue;
      }
      next[key] = baseFact(update, subject, now, "uncertain");
      events.push({
        type: "uncertain",
        field: update.field,
        subject,
        ...(update.value !== undefined ? { value: update.value } : {}),
      });
      continue;
    }

    if (!existing) {
      const status =
        update.status === "confirmed" ? "confirmed" : update.status;
      if (status === "conflicted" || update.value === undefined) {
        // 无既有事实无法构成冲突;缺 value 的更新忽略
        continue;
      }
      next[key] = baseFact(update, subject, now, status);
      events.push({
        type: status,
        field: update.field,
        subject,
        value: update.value,
      });
      continue;
    }

    // 既有事实
    if (existing.value === update.value) {
      // 同值:不确定事实可被可信来源升级为 confirmed
      // (此处 update.source 已排除 agent_inference:该分支在上方已 continue)
      if (existing.status === "uncertain") {
        next[key] = { ...existing, status: "confirmed", confirmedAt: now };
        events.push({
          type: "confirmed",
          field: update.field,
          subject,
          value: update.value,
        });
      }
      continue;
    }

    if (update.value === undefined) continue;

    // 跨源不同值 → conflicted(双方值均保留)
    if (existing.source !== update.source) {
      next[key] = {
        ...baseFact(update, subject, now, "conflicted"),
        history: [
          {
            value: existing.value,
            source: existing.source,
            status: existing.status,
            at: now,
          },
        ],
      };
      events.push({
        type: "conflicted",
        field: update.field,
        subject,
        value: update.value,
      });
      cascadeInvalidations(next, update.field, subject, now, events);
      continue;
    }

    // 同源新值 → 覆盖并保留旧值轨迹(confirmed 被替换视为纠正)
    const eventType =
      existing.status === "confirmed" ? "corrected" : "confirmed";
    next[key] = {
      ...baseFact(update, subject, now, "confirmed"),
      history: [
        {
          value: existing.value,
          source: existing.source,
          status: existing.status,
          at: now,
        },
      ],
    };
    events.push({
      type: eventType,
      field: update.field,
      subject,
      value: update.value,
    });
    cascadeInvalidations(next, update.field, subject, now, events);
  }
  return { facts: next, events };
}

/** 依赖失效级联:被依赖事实变化后,静态映射中的派生事实失效(可达传递) */
function cascadeInvalidations(
  next: CaseFacts,
  changedField: string,
  subject: string,
  now: string,
  events: FactChangeEvent[],
): void {
  const queue = [changedField];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const [key, fact] of Object.entries(next)) {
      if (fact.subject !== subject || fact.status === "invalidated") continue;
      const fieldName = key.startsWith(`${subject}.`)
        ? key.slice(subject.length + 1)
        : key;
      const deps = DERIVED_FACT_DEPENDENCIES[fieldName];
      if (!deps || !deps.includes(current)) continue;
      next[key] = {
        ...fact,
        status: "invalidated",
        lastChangedAt: now,
        invalidatedAt: now,
      };
      events.push({
        type: "invalidated",
        field: fieldName,
        subject,
        reason: "dependency_invalidated",
      });
      queue.push(fieldName);
    }
  }
}

/** 仅返回 status=confirmed 的事实(供读取端与交接简报使用) */
export function confirmedFactValues(facts: CaseFacts): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, fact] of Object.entries(facts)) {
    if (fact.status === "confirmed") result[key] = fact.value;
  }
  return result;
}
