import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentExecutionStrategy,
  AgentStrategyContext,
} from "@weflow/contracts";
import { customerSupportSystemPrompt } from "./prompt.js";
import { parseCustomerSupportResponse } from "./parser.js";

/**
 * Customer Support structured execution strategy.
 *
 * The system prompt has been migrated from Core. Decision schema parsing will
 * follow in the next extraction step.
 *
 * Export contract: the platform Agent Worker loads strategies from
 * STRATEGY_PLUGIN_PATH and expects a named export `strategy`
 * (AgentExecutionStrategy). Keep this export name stable so the same build
 * artifact can be inserted into any Weflow platform instance.
 */

type PromptMap = {
  default?: string | null;
  contacts?: Record<string, string>;
  conversations?: Record<string, string>;
};

function readPromptMap(): PromptMap {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(currentDir, "..", "prompts.json");
    return JSON.parse(readFileSync(filePath, "utf8")) as PromptMap;
  } catch {
    return {};
  }
}

function resolveSystemPrompt(input: AgentStrategyContext): string {
  const promptMap = readPromptMap();
  const customPrompt =
    (input.contactId ? promptMap.contacts?.[input.contactId] : undefined) ??
    promptMap.conversations?.[input.conversationId] ??
    promptMap.default ??
    null;
  if (customPrompt) return customPrompt;
  return customerSupportSystemPrompt(
    input.availableTools.includes("retrieve_knowledge"),
  );
}

export const strategy: AgentExecutionStrategy = {
  id: "weflow.customer-support/structured-v1",
  version: "1.0.0",
  buildModelRequest: (input) => ({
    system: resolveSystemPrompt(input),
    messages: input.messages,
  }),
  parseModelResponse: (input) => parseCustomerSupportResponse(input.text),
  validateAction: () => ({ ok: true }),
};
