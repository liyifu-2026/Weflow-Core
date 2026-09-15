/**
 * 工具目录模块
 *
 * 定义 Agent 可调用的所有工具及其参数校验规则。
 * 每个工具包含：参数 Schema、是否产生副作用、超时时间。
 */

import { z } from "zod";
import type { TextToolDefinition } from "../../model/contracts/text-generation-request.js";

/** 查询联系人档案的参数 Schema（无额外参数） */
const queryContactProfileArguments = z.object({}).strict();
/** 知识库检索的参数 Schema */
const retrieveKnowledgeArguments = z
  .object({ query: z.string().trim().min(1).max(1_000) })
  .strict();
/** 抓取网页链接内容的参数 Schema */
const fetchUrlArguments = z
  .object({ url: z.string().trim().min(1).max(2_000) })
  .strict();
/** 群历史消息检索的参数 Schema（仅群聊下发；speaker 为昵称或通道联系人 ID） */
const searchChatHistoryArguments = z
  .object({
    scope: z.enum(["speaker", "group"]),
    speaker: z.string().trim().min(1).max(80).optional(),
    keyword: z.string().trim().min(1).max(80).optional(),
    before_hours: z.coerce.number().int().min(1).max(720).optional(),
    limit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .strict()
  .refine((value) => value.scope === "group" || Boolean(value.speaker), {
    message: "speaker_required_for_scope_speaker",
  });

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
  fetch_url: {
    sideEffect: false,
    timeoutMs: 15_000,
    arguments: fetchUrlArguments,
  },
  search_chat_history: {
    sideEffect: false,
    timeoutMs: 5_000,
    arguments: searchChatHistoryArguments,
  },
} as const;

/** 工具名称类型 */
export type ToolName = keyof typeof catalog;

/** 判断工具名是否在平台工具目录中 */
export function isToolName(name: string): name is ToolName {
  return name in catalog;
}

/** 校验工具参数，不合法时抛出异常（数字参数经 coerce 归一） */
export function validateToolArguments(
  name: ToolName,
  argumentsInput: Record<string, string>,
): Record<string, unknown> {
  const parsed = catalog[name].arguments.safeParse(argumentsInput);
  if (!parsed.success) throw new Error("invalid tool arguments");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 原生工具定义（FC 协议）：按 availableTools 派生 OpenAI 兼容 tools 数组。
// 描述写给模型——说清"什么时候用"，参数 schema 与上方 zod 校验保持同义。
// ---------------------------------------------------------------------------

const NATIVE_TOOL_DEFINITIONS: Record<ToolName, TextToolDefinition> = {
  query_contact_profile: {
    type: "function",
    function: {
      name: "query_contact_profile",
      description:
        "查询当前客户/联系人的档案资料（联系方式、备注、标签等基础信息）。需要了解对方背景信息时调用。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  retrieve_knowledge: {
    type: "function",
    function: {
      name: "retrieve_knowledge",
      description:
        "检索产品知识库，返回相关文档片段。回答故障、报错、政策类问题前必须先调用；没有检索证据不得编造答案。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "检索关键词，如错误码、故障现象或政策主题",
          },
        },
        required: ["query"],
      },
    },
  },
  fetch_url: {
    type: "function",
    function: {
      name: "fetch_url",
      description:
        "抓取一个网页链接的正文内容。仅在客户提供链接且需要其内容时调用。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整的 http/https 链接" },
        },
        required: ["url"],
      },
    },
  },
  search_chat_history: {
    type: "function",
    function: {
      name: "search_chat_history",
      description:
        '检索本群的历史消息：可按发言人（昵称或联系人 ID）、关键词、时间段筛选。当对方提到"之前/上次说过"而上下文窗口中没有时，用它查证，不要凭模糊印象转述他人原话。',
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["speaker", "group"],
            description: "speaker=查某个人的消息；group=查全群消息",
          },
          speaker: {
            type: "string",
            description: "scope=speaker 时必填：发言人昵称或联系人 ID",
          },
          keyword: { type: "string", description: "可选：消息关键词筛选" },
          before_hours: {
            type: "integer",
            description: "可选：只查最近 N 小时内（默认 72，最大 720）",
          },
          limit: {
            type: "integer",
            description: "可选：返回条数上限（默认 10，最大 20）",
          },
        },
        required: ["scope"],
      },
    },
  },
};

/** 按 availableTools 派生原生工具定义（FC 协议下发用；目录外名称忽略）。 */
export function toNativeToolDefinitions(
  availableTools: readonly string[],
): TextToolDefinition[] {
  return availableTools
    .filter((name): name is ToolName => isToolName(name))
    .map((name) => NATIVE_TOOL_DEFINITIONS[name]);
}
