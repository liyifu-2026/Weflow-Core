/**
 * 工具目录模块
 *
 * 定义 Agent 可调用的所有工具及其参数校验规则。
 * 每个工具包含：参数 Schema、是否产生副作用、超时时间。
 */

import { z } from "zod";

/** 查询联系人档案的参数 Schema（无额外参数） */
const queryContactProfileArguments = z.object({}).strict();
/** 知识库检索的参数 Schema */
const retrieveKnowledgeArguments = z
  .object({ query: z.string().trim().min(1).max(1_000) })
  .strict();

/** 工具注册表 */
const catalog = {
  query_contact_profile: {
    sideEffect: false,
    timeoutMs: 2_000,
    arguments: queryContactProfileArguments,
  },
  retrieve_knowledge: {
    sideEffect: false,
    timeoutMs: 15_000,
    arguments: retrieveKnowledgeArguments,
  },
} as const;

/** 工具名称类型 */
export type ToolName = keyof typeof catalog;

/** 判断工具名是否在平台工具目录中 */
export function isToolName(name: string): name is ToolName {
  return name in catalog;
}

/** 校验工具参数，不合法时抛出异常 */
export function validateToolArguments(
  name: ToolName,
  argumentsInput: Record<string, string>,
): Record<string, string> {
  const parsed = catalog[name].arguments.safeParse(argumentsInput);
  if (!parsed.success) throw new Error("invalid tool arguments");
  return parsed.data;
}

/** 获取工具定义（参数 Schema、超时等） */
export function getToolDefinition(name: ToolName) {
  return catalog[name];
}
