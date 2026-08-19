import type { AgentExecutionStrategy } from "@weflow/contracts";
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
export const strategy: AgentExecutionStrategy = {
  id: "weflow.customer-support/structured-v1",
  version: "1.0.0",
  buildModelRequest: (input) => ({
    system: customerSupportSystemPrompt(
      input.availableTools.includes("retrieve_knowledge"),
    ),
    messages: input.messages,
  }),
  parseModelResponse: (input) => parseCustomerSupportResponse(input.text),
  validateAction: () => ({ ok: true }),
};

