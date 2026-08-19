import type { TextGenerationRequest } from "../../modules/model/contracts/text-generation-request.js";
import type { TextGenerationResult } from "../../modules/model/contracts/text-generation-result.js";
import { TextModelError } from "../../modules/model/contracts/text-model-error.js";
import type { TextModel } from "../../modules/model/contracts/text-model.js";
import type { OpenAiCompatibleClient } from "../model_runtime/openai-compatible-client.js";
import type { PluginDefinition } from "../runtime/kernel/index.js";
import { TEXT_MODEL_CAPABILITY } from "../runtime/capabilities/text-model.js";

/** Provider adapter: protocol details remain behind the TextModel capability. */
export class OpenAiTextModelProvider implements TextModel {
  public constructor(private readonly client: OpenAiCompatibleClient) {}

  async generate(
    request: TextGenerationRequest,
  ): Promise<TextGenerationResult> {
    try {
      return await this.client.generate(request);
    } catch (error) {
      throw toTextModelError(error);
    }
  }
}

export function openAiTextModelPlugin(
  client: OpenAiCompatibleClient,
): PluginDefinition {
  return {
    name: "openai-text-model",
    provides: [TEXT_MODEL_CAPABILITY],
    requires: [],
    setup(context) {
      context.provide(
        TEXT_MODEL_CAPABILITY,
        new OpenAiTextModelProvider(client),
      );
    },
  };
}

function toTextModelError(error: unknown): TextModelError {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "model API returned an empty response") {
    return new TextModelError("invalid_response", message, {
      cause: error,
      reason: "empty_response",
      retryable: true,
    });
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new TextModelError("timeout", message, {
      cause: error,
      retryable: true,
    });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new TextModelError("cancelled", message, { cause: error });
  }
  const status = message.match(/model API returned (\d{3})/i)?.[1];
  if (status === "401" || status === "403")
    return new TextModelError("authentication", message, { cause: error });
  if (status === "429")
    return new TextModelError("rate_limited", message, {
      cause: error,
      retryable: true,
    });
  if (status && Number(status) >= 500)
    return new TextModelError("unavailable", message, {
      cause: error,
      retryable: true,
    });
  if (status && Number(status) >= 400)
    return new TextModelError("invalid_request", message, { cause: error });
  if (message.includes("Invalid input") || message.includes("expected"))
    return new TextModelError("invalid_response", message, { cause: error });
  return new TextModelError("unknown", message, { cause: error });
}
